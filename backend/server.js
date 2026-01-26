import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Modality } from '@google/genai'; // Import Modality
import { createClient } from '@supabase/supabase-js'; // Import Supabase client

// Add a global uncaught exception handler for Node.js
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  // Optionally, perform graceful shutdown or notify monitoring systems
  // For now, we'll just log and let Render restart the service if configured.
  // process.exit(1); // Exit with a failure code
});

// Add a global unhandled promise rejection handler for Node.js
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason, promise);
  // Optionally, perform graceful shutdown or notify monitoring systems
  // process.exit(1); // Exit with a failure code
});


const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase Client for backend access to Storage and Database
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role key for backend

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable is not set.");
  console.error("Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in your Render.com environment variables.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Global API Key Management
const API_KEYS_COUNT = 50; // As per user request: API_KEY, API_KEY1 ... API_KEY50
const apiKeys = [];
for (let i = 0; i <= API_KEYS_COUNT; i++) {
  const keyName = i === 0 ? 'API_KEY' : `API_KEY${i}`;
  const key = process.env[keyName];
  if (key) {
    apiKeys.push(key);
  }
}

if (apiKeys.length === 0) {
  console.error("[Rox Backend] No Gemini API keys found. Please set API_KEY, API_KEY1, etc. in environment variables.");
  process.exit(1);
}

let currentApiKeyIndex = 0; // Default, will be loaded from DB
let aiInstance = null; // Current GoogleGenAI instance

// Function to get the current AI instance
const getGenAIInstance = () => {
  // Only re-create the instance if it's null or the API key has changed
  if (!aiInstance || aiInstance.apiKey !== apiKeys[currentApiKeyIndex]) {
    console.log(`[Rox Backend] Initializing GoogleGenAI with key at index ${currentApiKeyIndex} (key ends with ${apiKeys[currentApiKeyIndex].slice(-5)})`);
    aiInstance = new GoogleGenAI({ apiKey: apiKeys[currentApiKeyIndex] });
  }
  return aiInstance;
};

// Function to rotate API key and persist to Supabase
const rotateApiKey = async () => {
  const oldIndex = currentApiKeyIndex;
  currentApiKeyIndex = (currentApiKeyIndex + 1) % apiKeys.length;
  // Set aiInstance to null to force re-creation with the new key on the next call to getGenAIInstance
  aiInstance = null; 
  
  console.warn(`[Rox Backend] Rotating API key from index ${oldIndex} to ${currentApiKeyIndex} (new key ends with ${apiKeys[currentApiKeyIndex].slice(-5)})`);

  // Persist to Supabase. Assuming a single row with ID 'api_key_rotator_status' to store the global index.
  // IMPORTANT: You MUST create an `api_key_status` table in Supabase if it doesn't exist.
  // Schema: `id` TEXT PRIMARY KEY (e.g., 'api_key_rotator_status'), `current_key_index` INTEGER, `updated_at` TIMESTAMP WITH TIME ZONE.
  const { error } = await supabase
    .from('api_key_status') 
    .update({ current_key_index: currentApiKeyIndex, updated_at: new Date().toISOString() })
    .eq('id', 'api_key_rotator_status'); 

  if (error) {
    console.error("[Rox Backend] Failed to update current_key_index in Supabase:", error.message);
  }
};


// Mock database for users and TTS projects (in-memory for this demo)
const database = {
  users: {}, // userId -> { dailyCharsUsed, dailyLimitResetTime, currentDailyLimit, subscription, history: [], charsUsed }
  ttsProjects: {}, // projectId -> { text, voice, settings, createdAt, base64Audio, userId }
};

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Helper to create WAV header (corrected for JavaScript)
function createWavHeader(dataSize) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  // CRITICAL FIX: Ensure 'fmt ' and 'data' chunks are written correctly
  // The original code had view.setUint32(12, 0x45564157, true); which is 'WAVE' again.
  // It should be 'fmt ' then 'data'.
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM Format
  view.setUint16(22, 1, true); // Channels (Mono)
  view.setUint32(24, 24000, true); // Sample Rate
  view.setUint32(28, 48000, true); // Byte Rate (SampleRate * Channels * BitsPerSample / 8)
  view.setUint16(32, 2, true); // Block Align
  view.setUint16(34, 16, true); // Bits per Sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  
  return new Uint8Array(buffer);
}

// Character limits (match constants.ts for simplicity)
const PLAN_LIMITS = {
  'free': 700,
  'starter': 50000,
  'vip': 200000,
  'vvip': 1500000,
  'exclusive': 5000000
};

// Helper to get or initialize user data
// Now accepts persistent subscription and charsUsed from Supabase.
// It initializes the in-memory 'database.users' and handles daily resets.
const getUserData = (userId, persistentSubscription = 'free', persistentCharsUsed = 0) => {
  if (!database.users[userId]) {
    const now = new Date();
    const nowInCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
    nowInCAT.setHours(0, 0, 0, 0); // Set to start of day in CAT
    database.users[userId] = {
      dailyCharsUsed: 0, // Will be reset or loaded from a persistent daily counter if available
      dailyLimitResetTime: nowInCAT.toISOString(),
      currentDailyLimit: PLAN_LIMITS[persistentSubscription],
      subscription: persistentSubscription,
      history: [], // History is dynamically fetched, not stored here
      charsUsed: persistentCharsUsed, // Initialized from persistent data
    };
  }

  const userData = database.users[userId];
  
  // Always update subscription and total chars from the persistent values if provided
  userData.subscription = persistentSubscription;
  userData.charsUsed = persistentCharsUsed; // Ensure total chars are up-to-date

  const now = new Date();
  const nowInCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
  const resetDateCAT = new Date(userData.dailyLimitResetTime);

  // Check if a new day has started since the last reset
  if (nowInCAT.toDateString() !== resetDateCAT.toDateString()) {
    userData.dailyCharsUsed = 0; // Reset daily usage
    const newResetTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
    newResetTime.setHours(0, 0, 0, 0); // Set to start of current day in CAT
    userData.dailyLimitResetTime = newResetTime.toISOString();
  }
  
  userData.currentDailyLimit = PLAN_LIMITS[userData.subscription];

  return userData;
};

// NEW: Admin Update User Subscription Endpoint
app.post('/admin-update-user-plan', async (req, res) => {
  const { userId, plan } = req.body;

  if (!userId || !PLAN_LIMITS[plan]) {
    return res.status(400).json({ error: 'Invalid user ID or plan.' });
  }

  try {
    // 1. Update the persistent subscription in Supabase profiles table
    // IMPORTANT: Ensure your 'profiles' table has a 'subscription' TEXT column and 'chars_used' INTEGER column.
    const { error: updateProfileError } = await supabase
      .from('profiles')
      .update({ subscription: plan })
      .eq('id', userId);

    if (updateProfileError) throw updateProfileError;

    // 2. Update in-memory data for immediate consistency (especially for daily limits)
    // Fetch current persistent charsUsed to properly initialize getUserData
    const { data: profileData, error: fetchProfileError } = await supabase
      .from('profiles')
      .select('chars_used')
      .eq('id', userId)
      .single();

    if (fetchProfileError && fetchProfileError.code !== 'PGRST116') throw fetchProfileError; // PGRST116: no rows found
    const persistentCharsUsed = profileData?.chars_used || 0;

    const userData = getUserData(userId, plan, persistentCharsUsed); // Use the new plan
    userData.dailyCharsUsed = 0; // Reset daily usage on plan change
    
    const now = new Date();
    const nowInCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
    nowInCAT.setHours(0, 0, 0, 0);
    userData.dailyLimitResetTime = nowInCAT.toISOString(); // Reset daily timer

    console.log(`[Rox Backend] Admin: User ${userId} plan updated to ${plan} in DB and in-memory. Usage reset.`);
    res.status(200).json({ 
      message: `User ${userId} plan updated to ${plan}`,
      dailyCharsUsed: userData.dailyCharsUsed,
      dailyLimitResetTime: userData.dailyLimitResetTime,
      currentDailyLimit: userData.currentDailyLimit,
      subscription: userData.subscription,
      charsUsed: userData.charsUsed,
    });

  } catch (error) {
    console.error("[Rox Backend] Error updating user plan:", error.message || error);
    res.status(500).json({ error: error.message || 'Failed to update user plan.' });
  }
});

// GET User Profile Endpoint (for frontend to fetch current usage and plan)
app.get('/user-profile', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    // Fetch persistent user data from Supabase profiles table
    // IMPORTANT: Ensure your 'profiles' table has 'subscription' TEXT, 'chars_used' INTEGER, 'role' TEXT, and 'language' TEXT columns.
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('subscription, chars_used')
      .eq('id', userId)
      .single();

    if (profileError && profileData === null) { // If user profile not found, create a default one
      console.warn(`[Rox Backend] Profile for user ${userId} not found. Creating default.`);
      const { data: newProfile, error: createProfileError } = await supabase
        .from('profiles')
        .insert({ id: userId, subscription: 'free', chars_used: 0, role: 'user', language: 'en' })
        .select()
        .single();
      if (createProfileError) throw createProfileError;
      // Initialize in-memory data for the newly created profile
      const userData = getUserData(userId, newProfile.subscription, newProfile.chars_used);
      return res.json({
        dailyCharsUsed: userData.dailyCharsUsed,
        dailyLimitResetTime: userData.dailyLimitResetTime,
        currentDailyLimit: userData.currentDailyLimit,
        subscription: userData.subscription,
        charsUsed: userData.charsUsed,
      });
    } else if (profileError) {
      throw profileError;
    }

    const persistentSubscription = profileData?.subscription || 'free';
    const persistentCharsUsed = profileData?.chars_used || 0;
    
    // Initialize/update in-memory user data using persistent data
    const userData = getUserData(userId, persistentSubscription, persistentCharsUsed); 
    
    res.json({
      dailyCharsUsed: userData.dailyCharsUsed,
      dailyLimitResetTime: userData.dailyLimitResetTime,
      currentDailyLimit: userData.currentDailyLimit,
      subscription: userData.subscription,
      charsUsed: userData.charsUsed, // Include total chars used
    });
  } catch (error) {
    console.error("[Rox Backend] Error fetching user profile:", error.message || error);
    res.status(500).json({ error: error.message || 'Failed to fetch user profile.' });
  }
});

// NEW: Endpoint to submit payment proof, generate signed URL, and store in DB
app.post('/submit-payment-proof', async (req, res) => {
  const { userId, userEmail, plan, filePath } = req.body; // filePath is the storage path

  if (!userId || !userEmail || !plan || !filePath) {
      return res.status(400).json({ error: 'Missing required parameters.' });
  }

  try {
      // Generate a signed URL for the uploaded file, valid for 1 hour
      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from('payment_screenshots')
          .createSignedUrl(filePath, 3600); 

      if (signedUrlError) throw signedUrlError;

      const signedUrl = signedUrlData.signedUrl;

      // Insert the record into payment_requests table, storing the file path
      // IMPORTANT: Ensure your 'payment_requests' table has 'user_id' TEXT, 'user_email' TEXT, 'plan' TEXT, 'screenshot_path' TEXT, 'status' TEXT, and 'created_at' TIMESTAMP WITH TIME ZONE columns.
      const { error: dbError } = await supabase
          .from('payment_requests')
          .insert({
              user_id: userId,
              user_email: userEmail,
              plan: plan,
              screenshot_path: filePath, // Store the actual file path, not the signed URL
              status: 'pending'
          });

      if (dbError) throw dbError;

      res.status(200).json({ message: 'Payment proof submitted successfully!', signedUrl: signedUrl });

  } catch (error) {
      console.error("[Rox Backend] Error submitting payment proof:", error.message || error);
      res.status(500).json({ error: error.message || 'Failed to submit payment proof.' });
  }
});

// NEW: Admin endpoint to fetch payment requests and generate fresh signed URLs
app.get('/admin-payment-requests', async (req, res) => {
  try {
    // IMPORTANT: Ensure your 'payment_requests' table exists as described in /submit-payment-proof.
    const { data, error } = await supabase
      .from('payment_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const requestsWithSignedUrls = await Promise.all(data.map(async (request) => {
      if (request.screenshot_path) {
        // Generate a new signed URL for each screenshot path, valid for 1 hour
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from('payment_screenshots')
          .createSignedUrl(request.screenshot_path, 3600); // 1 hour validity

        if (signedUrlError) {
          console.warn(`[Rox Backend] Failed to generate signed URL for ${request.screenshot_path}:`, signedUrlError.message);
          return { ...request, screenshot_url: null }; // Return null or a placeholder if signing fails
        }
        return { ...request, screenshot_url: signedUrlData.signedUrl };
      }
      return request;
    }));

    res.status(200).json(requestsWithSignedUrls);
  } catch (error) {
    console.error("[Rox Backend] Error fetching admin payment requests:", error.message || error);
    res.status(500).json({ error: 'Failed to fetch payment requests for admin.' });
  }
});

// NEW: Admin endpoint to fetch all users and their profiles
app.get('/admin-users', async (req, res) => {
  try {
    // Fetch all users from Supabase auth.users
    const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
    if (authError) throw authError;

    // Extract user IDs to fetch their profiles
    const userIds = authUsers.users.map(u => u.id);

    // Fetch profiles for these users
    // IMPORTANT: Ensure your 'profiles' table has 'id' TEXT PRIMARY KEY, 'subscription' TEXT, 'chars_used' INTEGER, 'role' TEXT, and 'language' TEXT columns.
    const { data: profiles, error: profileError } = await supabase
      .from('profiles')
      .select('id, subscription, chars_used, role')
      .in('id', userIds);

    if (profileError) throw profileError;

    // Map profiles to a dictionary for easy lookup
    const profileMap = new Map(profiles.map(p => [p.id, p]));

    // Combine data from authUsers and profiles
    const combinedUsers = authUsers.users.map(authUser => {
      const profile = profileMap.get(authUser.id);
      return {
        id: authUser.id,
        email: authUser.email,
        createdAt: authUser.created_at,
        subscription: profile?.subscription || 'free', // Default to free if no profile found
        charsUsed: profile?.chars_used || 0, // Default to 0
        role: profile?.role || 'user', // Default to user
      };
    });

    res.status(200).json(combinedUsers);
  } catch (error) {
    console.error("[Rox Backend] Error fetching all users for admin:", error.message || error);
    res.status(500).json({ error: error.message || 'Failed to fetch user list for admin.' });
  }
});

// TTS Generation Endpoint
/*
 * IMPORTANT: To fix errors like "Could not find the table 'public.tts_projects' in the schema cache"
 * and "Failed to save generated audio project.", you MUST create the 'tts_projects' table
 * in your Supabase project with the following schema:
 *
 * Table Name: tts_projects
 * Enable Row Level Security (RLS): Unchecked (for service role key access)
 * Columns:
 *   - id: TEXT (Primary Key, e.g., 'tts-12345-abcde')
 *   - user_id: TEXT (Foreign Key to 'profiles' table 'id' column)
 *   - text: TEXT
 *   - voice_name: TEXT
 *   - settings: JSONB (stores TTSSettings object: { pitch, speed, expression })
 *   - audio_data_base64: TEXT (stores the full base64 WAV string)
 *   - created_at: TIMESTAMP WITH TIME ZONE (Default value: now())
 */
app.post('/generate-tts', async (req, res) => {
  const { text, voice, settings, userId, textLength } = req.body;

  if (!text || !voice || !settings || !userId || textLength === undefined) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  const isPreview = userId === "preview_user_id";
  let userData;

  if (!isPreview) {
    // Fetch persistent data to correctly initialize in-memory userData for quota check
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('subscription, chars_used')
      .eq('id', userId)
      .single();

    if (profileError && profileData === null) { // If user profile not found, create a default one
      console.warn(`[Rox Backend] Profile for user ${userId} not found during TTS. Creating default.`);
      const { data: newProfile, error: createProfileError } = await supabase
        .from('profiles')
        .insert({ id: userId, subscription: 'free', chars_used: 0, role: 'user', language: 'en' })
        .select()
        .single();
      if (createProfileError) throw createProfileError;
      userData = getUserData(userId, newProfile.subscription, newProfile.chars_used);
    } else if (profileError) {
      throw profileError;
    } else {
      userData = getUserData(userId, profileData.subscription, profileData.chars_used);
    }
    

    if (userData.dailyCharsUsed + textLength > userData.currentDailyLimit) {
      return res.status(403).json({ error: 'Daily character limit reached. Upgrade for unlimited generation.' });
    }
  }

  const MAX_API_RETRIES = apiKeys.length;
  let retries = 0;
  let response;

  while (retries < MAX_API_RETRIES) {
    try {
      const currentAI = getGenAIInstance(); // Get current AI instance

      // Reverted model name to the one that works for standard TTS generation
      const modelName = 'gemini-2.5-flash-preview-tts'; 
      
      // CRITICAL FIX: Add explicit instruction for TTS
      const expressionStr = settings?.expression && settings.expression !== 'Natural' 
        ? ` in a ${settings.expression.toLowerCase()} tone` 
        : '';
      const finalPrompt = `Read the following transcript exactly${expressionStr}: ${text}`;

      response = await currentAI.models.generateContent({
        model: modelName,
        // CRITICAL FIX: Revert contents to structured array with parts
        contents: [{ parts: [{ text: finalPrompt }] }], 
        config: {
          // CRITICAL FIX: `responseModalities` must be an array with a single `Modality.AUDIO` element.
          responseModalities: [Modality.AUDIO], 
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      });
      break; // Success, break out of retry loop

    } catch (error) {
      console.error(`[Rox Backend] Gemini TTS API error (Key Index ${currentApiKeyIndex}):`, error.message || error);

      // Check for quota/rate limit errors (these are common for free tier limits)
      const errorMessage = error.message?.toLowerCase();
      const isQuotaError = (
        error.status === 429 || // HTTP 429 Too Many Requests
        errorMessage?.includes('quota exceeded') ||
        errorMessage?.includes('rate limit exceeded') ||
        errorMessage?.includes('resource exhausted') // Another common message for rate limits
      );

      if (isQuotaError && retries < apiKeys.length - 1) { // Only rotate if not the last key and there are more keys to try
        retries++;
        await rotateApiKey(); // Rotate to next key and update Supabase
        console.warn(`[Rox Backend] Attempting TTS retry ${retries}/${MAX_API_RETRIES} with new API key (index ${currentApiKeyIndex}).`);
        // Continue the loop to retry with the new key
      } else {
        // No more keys to try, or it's a different type of error, or last key exhausted
        console.error(`[Rox Backend] All API keys exhausted or non-quota error for TTS: ${error.message}`);
        return res.status(500).json({ error: 'Failed to generate speech', details: error.message });
      }
    }
  }

  if (!response) {
     return res.status(500).json({ error: 'Failed to generate speech after multiple API key retries.', details: 'All available API keys might be exhausted or facing issues.' });
  }


  try {
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      // Added more descriptive error based on the user's working example
      throw new Error('Neural engine attempted to generate text instead of audio. Check prompt clarity or model configuration. Raw response logged above.');
    }

    const binaryString = atob(base64Audio);
    const binaryAudio = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      binaryAudio[i] = binaryString.charCodeAt(i);
    }
    const wavHeader = createWavHeader(binaryAudio.length);
    const wavFile = new Uint8Array(wavHeader.length + binaryAudio.length);
    wavFile.set(wavHeader);
    wavFile.set(binaryAudio, wavHeader.length);
    const fullBase64Wav = btoa(String.fromCharCode(...wavFile));
    const audioUrl = `data:audio/wav;base64,${fullBase64Wav}`;

    if (!isPreview) {
      const projectId = `tts-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const newProject = {
        id: projectId,
        user_id: userId, // Ensure user_id matches DB schema
        text: text,
        voice_name: voice,
        created_at: new Date().toISOString(), // Use created_at
        settings: settings,
        audio_data_base64: fullBase64Wav,
      };
      
      const { error: insertProjectError } = await supabase
        .from('tts_projects')
        .insert(newProject);
      
      if (insertProjectError) {
        console.error("[Rox Backend] Error inserting TTS project into Supabase:", insertProjectError.message);
        throw new Error("Failed to save generated audio project.");
      }

      userData.dailyCharsUsed += textLength;
      userData.charsUsed += textLength; // Update total chars used in-memory

      // Persist total characters used to Supabase profiles table
      const { error: updateCharsError } = await supabase
        .from('profiles')
        .update({ chars_used: userData.charsUsed })
        .eq('id', userId);

      if (updateCharsError) {
        console.error("[Rox Backend] Error updating chars_used in Supabase:", updateCharsError.message);
        // Do not block response, but log the error
      }
    }

    res.json({
      audioUrl: audioUrl,
      base64Audio: fullBase64Wav,
      dailyCharsUsed: isPreview ? 0 : userData.dailyCharsUsed,
      dailyLimitResetTime: isPreview ? new Date().toISOString() : userData.dailyLimitResetTime,
      currentDailyLimit: isPreview ? PLAN_LIMITS['free'] : userData.currentDailyLimit,
      charsUsed: isPreview ? 0 : userData.charsUsed, // Return total chars used
    });

  } catch (error) {
    console.error("[Rox Backend] Error processing TTS response or saving data:", error.message || error);
    res.status(500).json({ error: 'Failed to generate speech', details: error.message });
  }
});

// Fetch User TTS History Endpoint
/*
 * IMPORTANT: To fix errors like "Could not find the table 'public.tts_projects' in the schema cache",
 * you MUST create the 'tts_projects' table in your Supabase project (see /generate-tts endpoint for schema).
 */
app.get('/user-history', async (req, res) => { // Made async
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    const { data: projects, error } = await supabase
      .from('tts_projects')
      .select('*')
      .eq('user_id', userId) // Filter by user_id
      .order('created_at', { ascending: false });

    if (error) throw error;

    const formattedProjects = projects.map(project => ({
      id: project.id,
      text: project.text,
      voiceName: project.voice_name,
      createdAt: project.created_at,
      audioUrl: `data:audio/wav;base64,${project.audio_data_base64}`,
      settings: project.settings,
    }));

    res.json(formattedProjects);
  } catch (error) {
    console.error("[Rox Backend] Fetch User History Error:", error.message || error);
    res.status(500).json({ error: 'Failed to retrieve user history.', details: error.message });
  }
});

// Delete TTS Project Endpoint
/*
 * IMPORTANT: To fix errors like "Could not find the table 'public.tts_projects' in the schema cache",
 * you MUST create the 'tts_projects' table in your Supabase project (see /generate-tts endpoint for schema).
 */
app.delete('/delete-tts/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    // Fetch project to get its text length before deletion
    const { data: projectData, error: fetchError } = await supabase
      .from('tts_projects')
      .select('text')
      .eq('id', projectId)
      .eq('user_id', userId) // Ensure authorized deletion
      .single();

    if (fetchError || !projectData) {
      return res.status(404).json({ error: 'Project not found or unauthorized.' });
    }

    const textLength = projectData.text.length;

    // Delete from Supabase
    const { error: deleteError } = await supabase
      .from('tts_projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    // Update user's char usage
    const { data: profileData, error: profileFetchError } = await supabase
      .from('profiles')
      .select('subscription, chars_used')
      .eq('id', userId)
      .single();

    if (profileFetchError) throw profileFetchError;

    const updatedCharsUsed = Math.max(0, profileData.chars_used - textLength);

    const { error: updateCharsError } = await supabase
      .from('profiles')
      .update({ chars_used: updatedCharsUsed })
      .eq('id', userId);

    if (updateCharsError) {
      console.error("[Rox Backend] Error updating chars_used after deletion:", updateCharsError.message);
      // Continue, as project is deleted, but usage might be slightly off until next refresh
    }

    // Update in-memory user data (if it exists)
    if (database.users[userId]) {
      database.users[userId].dailyCharsUsed = Math.max(0, database.users[userId].dailyCharsUsed - textLength);
      database.users[userId].charsUsed = updatedCharsUsed; // Sync with persistent total
    }

    res.status(200).json({ 
      message: 'Project deleted successfully.', 
      dailyCharsUsed: database.users[userId]?.dailyCharsUsed || 0, // Return updated in-memory daily usage
      charsUsed: updatedCharsUsed, // Return updated persistent total usage
    });
  } catch (error) {
    console.error("[Rox Backend] Delete TTS Project Error:", error.message || error);
    res.status(500).json({ error: 'Failed to delete project.', details: error.message });
  }
});

// Architect Voice Endpoint (re-using existing frontend logic, but calling backend)
app.post('/architect-voice', async (req, res) => {
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({ error: 'Description is required.' });
  }

  const MAX_API_RETRIES = apiKeys.length;
  let retries = 0;
  let response;

  while (retries < MAX_API_RETRIES) {
    try {
      const currentAI = getGenAIInstance(); // Get current AI instance

      response = await currentAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Based on the following description, suggest a base voice ('Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'), a pitch (number between 0.5 and 1.5, default 1.0), a speed (number between 0.5 and 2.0, default 1.0), and an expression ('Natural', 'Professional', 'Cheerful', 'Somber', 'Whispering', 'Authoritative', 'Excited'). Provide the output as a JSON object.`,
        config: {
          systemInstruction: "You are the Rox Voices AI Architect. Interpret the user's personality/mood description and map it to our engine's base voices (Zephyr, Kore, Puck, Charon, Fenrir) and settings (pitch 0.5-1.5, speed 0.5-2.0, expressions: Natural, Cheerful, Somber, Whispering, Authoritative, Excited, Professional). Return only a JSON object.",
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              baseVoice: {
                type: "STRING",
                enum: ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'],
              },
              settings: {
                type: "OBJECT",
                properties: {
                  pitch: { type: "NUMBER" },
                  speed: { type: "NUMBER" },
                  expression: { type: "STRING", enum: ['Natural', 'Professional', 'Cheerful', 'Somber', 'Whispering', 'Authoritative', 'Excited'] },
                },
                required: ["pitch", "speed", "expression"]
              }
            },
            required: ["baseVoice", "settings"],
          },
        },
      });
      break; // Success, break out of retry loop

    } catch (error) {
      console.error(`[Rox Backend] Architect voice API error (Key Index ${currentApiKeyIndex}):`, error.message || error);

      const errorMessage = error.message?.toLowerCase();
      const isQuotaError = (
        error.status === 429 || 
        errorMessage?.includes('quota exceeded') ||
        errorMessage?.includes('rate limit exceeded') ||
        errorMessage?.includes('resource exhausted')
      );

      if (isQuotaError && retries < apiKeys.length - 1) { // Only rotate if not the last key and there are more keys to try
        retries++;
        await rotateApiKey(); // Rotate to next key and update Supabase
        console.warn(`[Rox Backend] Attempting Architect retry ${retries}/${MAX_API_RETRIES} with new API key (index ${currentApiKeyIndex}).`);
        // Continue the loop to retry with the new key
      } else {
        // No more keys to try, or it's a different type of error, or last key exhausted
        console.error(`[Rox Backend] All API keys exhausted or non-quota error for Architect: ${error.message}`);
        return res.status(500).json({ error: 'Failed to architect voice profile', details: error.message });
      }
    }
  }

  if (!response) {
      return res.status(500).json({ error: 'Failed to architect voice profile after multiple API key retries.', details: 'All available API keys might be exhausted or facing issues.' });
  }

  try {
    const jsonStr = response.text?.trim();
    if (!jsonStr) {
      throw new Error("No valid JSON response from AI.");
    }

    const parsedResponse = JSON.parse(jsonStr);
    res.json(parsedResponse);

  } catch (error) {
    console.error("[Rox Backend] Error processing Architect response:", error.message || error);
    res.status(500).json({ error: 'Failed to architect voice profile', details: error.message });
  }
});

// Initialize currentApiKeyIndex from Supabase on server start
async function initializeServer() {
  try {
    // Fetch the single row from 'api_key_status'
    // IMPORTANT: Create this table in Supabase if it doesn't exist (id TEXT PRIMARY KEY, current_key_index INTEGER, updated_at TIMESTAMP WITH TIME ZONE).
    const { data, error } = await supabase
      .from('api_key_status')
      .select('current_key_index')
      .eq('id', 'api_key_rotator_status') // Assuming a fixed ID for the single row
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows found"
      console.error("[Rox Backend] Error fetching initial API key index from Supabase:", error.message);
      // Proceed with default 0 if error, but log it
    } else if (data) {
      currentApiKeyIndex = data.current_key_index % apiKeys.length; // Ensure index is within bounds
      console.log(`[Rox Backend] Loaded initial API key index from Supabase: ${currentApiKeyIndex}`);
    } else {
        // If no row exists, create it with default 0
        console.warn("[Rox Backend] No api_key_status row found with ID 'api_key_rotator_status'. Creating a default entry with index 0.");
        const { error: insertError } = await supabase
            .from('api_key_status')
            .insert({ id: 'api_key_rotator_status', current_key_index: 0 });
        if (insertError) {
            console.error("[Rox Backend] Failed to insert default api_key_status:", insertError.message);
        }
    }
  } catch (err) {
    console.error("[Rox Backend] Critical error during API key index initialization:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`[Rox Backend] Server initialized and listening on port ${PORT}`);
  });
}

// Call the initialization function
initializeServer();
