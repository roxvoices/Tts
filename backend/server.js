‎it express from 'express';
‎import cors from 'cors';
‎iort { GoogleGenAI, Modality } from '@google/genai'; // Import Modality
‎import { createClient } from '@supabase/supabase-js'; // Import Supabase client
‎const app = express();
‎const PORT = process.env.PORT || 3001;
‎// Initialize Supabase Client for backend access to Storage and Database
‎const supabaseUrl = process.env.SUPABASE_URL;
‎const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role key for backend
‎if (!supabaseUrl || !supabaseServiceRoleKey) {
‎  console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable is not set.");
‎  console.error("Please ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in your Render.com environment variables.");
‎  process.exit(1);
‎}
‎const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
‎// Mock database for users and TTS projects (in-memory for this demo)
‎const database = {
‎  users: {}, // userId -> { dailyCharsUsed, dailyLimitResetTime, currentDailyLimit, subscription, history: [] }
‎  ttsProjects: {}, // projectId -> { text, voice, settings, createdAt, base64Audio, userId }
‎};
‎// ===== GEMINI API KEY ROTATION SYSTEM =====
‎// Collect API_KEY1 ... API_KEY50 automatically
‎const geminiKeys = [];
‎for (let i = 1; i <= 50; i++) {
‎  const key = process.env[`API_KEY${i}`];
‎  if (key) geminiKeys.push(key);
‎}
‎if (geminiKeys.length === 0) {
‎  console.error("No Gemini API keys found in environment variables!");
‎  process.exit(1);
‎}
‎let currentKeyIndex = 0;
‎// Function to get a Gemini client using current key
‎function getGeminiClient() {
‎  return new GoogleGenAI({ apiKey: geminiKeys[currentKeyIndex] });
‎}
‎// Rotate key when quota / error happens
‎function rotateKey() {
‎  currentKeyIndex = (currentKeyIndex + 1) % geminiKeys.length;
‎  console.log("🔁 Switched to Gemini API KEY index:", currentKeyIndex + 1);
‎}
‎// Wrapper that safely calls Gemini with auto-rotation
‎async function generateWithRotation(requestFn) {
‎  let attempts = 0;
‎  while (attempts < geminiKeys.length) {
‎    try {
‎      const ai = getGeminiClient();
‎      return await requestFn(ai); // success → return result
‎    } catch (err) {
‎      const msg = err.message || "";
‎      // If quota / rate / key error → rotate
‎      if ( msg.includes("RESOURCE_EXHAUSTED") ||
‎        msg.includes("quota") ||
‎        msg.includes("429") ||
‎        msg.includes("API key")
‎      ) {
‎        console.warn("⚠️ Gemini key quota hit. Rotating key...");
‎        rotateKey();
‎        attempts++;
‎        continue;
‎      }
‎      // Other errors → throw normally
‎      throw err;
‎    }
‎  }
‎  throw new Error("All Gemini API keys exhausted.");
‎}
‎app.use(cors());
‎app.use(express.json({ limit: '50mb' }));
‎// Helper to create WAV header (corrected for JavaScript)
‎function createWavHeader(dataSize) {
‎  const buffer = new ArrayBuffer(44);
‎  const view = new DataView(buffer);
‎  const writeString = (offset, string) => {
‎    for (let i = 0; i < string.length; i++) {
‎      view.setUint8(offset + i, string.charCodeAt(i));
‎    }
‎  };
‎  writeString(0, 'RIFF');
‎  view.setUint32(4, 36 + dataSize, true);
‎  writeString(8, 'WAVE');
‎  writeString(12, 'fmt ');
‎  view.setUint32(16, 16, true);
‎  view.setUint16(20, 1, true); // PCM Format
‎  view.setUint16(22, 1, true); // Channels (Mono)
‎  view.setUint32(24, 24000, true); // Sample Rate
‎  view.setUint32(28, 48000, true); // Byte Rate (SampleRate * Channels * BitsPerSample / 8)
‎  view.setUint16(32, 2, true); // Block Align
‎  view.setUint16(34, 16, true); // Bits per Sample
‎  writeString(36, 'data');
‎  view.setUint32(40, dataSize, true);
‎  
‎  return new Uint8Array(buffer);
‎}
‎
‎// Character limits (match constants.ts for simplicity)
‎const PLAN_LIMITS = {
‎  'free': 700,
‎  'starter': 50000,
‎  'vip': 200000,
‎  'vvip': 1500000,
‎  'exclusive': 5000000
‎};
‎
‎// Helper to get or initialize user data
‎const getUserData = (userId, initialSubscription = 'free') => {
‎  if (!database.users[userId]) {
‎    const now = new Date();
‎    const nowInCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
‎    nowInCAT.setHours(0, 0, 0, 0);
‎    database.users[userId] = {
‎      dailyCharsUsed: 0,
‎      dailyLimitResetTime: nowInCAT.toISOString(),
‎      currentDailyLimit: PLAN_LIMITS[initialSubscription],
‎      subscription: initialSubscription,
‎      history: [],
‎      charsUsed: 0, // Initialize total characters used
‎    };
‎  }
‎
‎  const userData = database.users[userId];
‎  const now = new Date();
‎  const nowInCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
‎  const resetDateCAT = new Date(userData.dailyLimitResetTime);
‎
‎  if (nowInCAT.toDateString() !== resetDateCAT.toDateString()) {
‎    userData.dailyCharsUsed = 0;
‎    const newResetTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
‎    newResetTime.setHours(0, 0, 0, 0);
‎    userData.dailyLimitResetTime = newResetTime.toISOString();
‎  }
‎  
‎  userData.currentDailyLimit = PLAN_LIMITS[userData.subscription];
‎
‎  return userData;
‎};
‎
‎// NEW: Admin Update User Subscription Endpoint
‎app.post('/admin-update-user-plan', (req, res) => {
‎  const { userId, plan } = req.body;
‎
‎  if (!userId || !PLAN_LIMITS[plan]) {
‎    return res.status(400).json({ error: 'Invalid user ID or plan.' });
‎  }
‎
‎  // This endpoint should ideally be protected by an admin check
‎  // For this mock backend, we'll assume the caller is authorized.
‎
‎  const userData = getUserData(userId, plan); // This will create if not exists
‎  userData.subscription = plan;
‎  userData.currentDailyLimit = PLAN_LIMITS[plan];
‎  userData.dailyCharsUsed = 0; // Reset daily usage on plan change
‎  
‎  const now = new Date();
‎  const nowInCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
‎  nowInCAT.setHours(0, 0, 0, 0);
‎  userData.dailyLimitResetTime = nowInCAT.toISOString(); // Reset daily timer
‎
‎  console.log(`Admin: User ${userId} plan updated to ${plan}. Usage reset.`);
‎  res.status(200).json({ 
‎    message: `User ${userId} plan updated to ${plan}`,
‎    dailyCharsUsed: userData.dailyCharsUsed,
‎    dailyLimitResetTime: userData.dailyLimitResetTime,
‎    currentDailyLimit: userData.currentDailyLimit,
‎    subscription: userData.subscription,
‎  });
‎});
‎
‎// GET User Profile Endpoint (for frontend to fetch current usage and plan)
‎app.get('/user-profile', (req, res) => {
‎  const { userId } = req.query;
‎
‎  if (!userId) {
‎    return res.status(400).json({ error: 'User ID is required.' });
‎  }
‎
‎  const userData = getUserData(userId); 
‎  res.json({
‎    dailyCharsUsed: userData.dailyCharsUsed,
‎    dailyLimitResetTime: userData.dailyLimitResetTime,
‎    currentDailyLimit: userData.currentDailyLimit,
‎    subscription: userData.subscription,
‎    charsUsed: userData.charsUsed, // Include total chars used
‎  });
‎});
‎
‎// NEW: Endpoint to submit payment proof, generate signed URL, and store in DB
‎app.post('/submit-payment-proof', async (req, res) => {
‎  const { userId, userEmail, plan, filePath } = req.body; // filePath is the storage path
‎
‎  if (!userId || !userEmail || !plan || !filePath) {
‎      return res.status(400).json({ error: 'Missing required parameters.' });
‎  }
‎
‎  try {
‎      // Generate a signed URL for the uploaded file, valid for 1 hour
‎      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
‎          .from('payment_screenshots')
‎          .createSignedUrl(filePath, 3600); 
‎
‎      if (signedUrlError) throw signedUrlError;
‎
‎      const signedUrl = signedUrlData.signedUrl;
‎
‎      // Insert the record into payment_requests table, storing the file path
‎      const { error: dbError } = await supabase
‎          .from('payment_requests')
‎          .insert({
‎              user_id: userId,
‎              user_email: userEmail,
‎              plan: plan,
‎              screenshot_path: filePath, // Store the actual file path, not the signed URL
‎              status: 'pending'
‎          });
‎
‎      if (dbError) throw dbError;
‎
‎      res.status(200).json({ message: 'Payment proof submitted successfully!', signedUrl: signedUrl });
‎
‎  } catch (error) {
‎      console.error("Error submitting payment proof:", error.message || error);
‎      res.status(500).json({ error: error.message || 'Failed to submit payment proof.' });
‎  }
‎});
‎
‎// NEW: Admin endpoint to fetch payment requests and generate fresh signed URLs
‎app.get('/admin-payment-requests', async (req, res) => {
‎  try {
‎    const { data, error } = await supabase
‎      .from('payment_requests')
‎      .select('*')
‎      .order('created_at', { ascending: false });
‎
‎    if (error) throw error;
‎
‎    const requestsWithSignedUrls = await Promise.all(data.map(async (request) => {
‎      if (request.screenshot_path) {
‎        // Generate a new signed URL for each screenshot path, valid for 1 hour
‎        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
‎          .from('payment_screenshots')
‎          .createSignedUrl(request.screenshot_path, 3600); // 1 hour validity
‎
‎        if (signedUrlError) {
‎          console.warn(`Failed to generate signed URL for ${request.screenshot_path}:`, signedUrlError.message);
‎          return { ...request, screenshot_url: null }; // Return null or a placeholder if signing fails
‎        }
‎        return { ...request, screenshot_url: signedUrlData.signedUrl };
‎      }
‎      return request;
‎    }));
‎
‎    res.status(200).json(requestsWithSignedUrls);
‎  } catch (error) {
‎    console.error("Error fetching admin payment requests:", error.message || error);
‎    res.status(500).json({ error: error.message || 'Failed to fetch payment requests for admin.' });
‎  }
‎});
‎
‎
‎// TTS Generation Endpoint
‎app.post('/generate-tts', async (req, res) => {
‎  const { text, voice, settings, userId, textLength } = req.body;
‎
‎  if (!text || !voice || !settings || !userId || textLength === undefined) {
‎    return res.status(400).json({ error: 'Missing required parameters.' });
‎  }
‎
‎  const isPreview = userId === "preview_user_id";
‎  let userData;
‎
‎  if (!isPreview) {
‎    userData = getUserData(userId);
‎
‎    if (userData.dailyCharsUsed + textLength > userData.currentDailyLimit) {
‎      return res.status(403).json({ error: 'Daily character limit reached. Upgrade for unlimited generation.' });
‎    }
‎  }
‎
‎  try {
‎    // CRITICAL FIX: Changed model to gemini-2.5-flash-preview-tts for standard TTS tasks
‎    const modelName = 'gemini-2.5-flash-preview-tts'; 
‎    
‎    // CRITICAL FIX: Add explicit instruction for TTS
‎    const expressionStr = settings?.expression && settings.expression !== 'Natural' 
‎      ? ` in a ${settings.expression.toLowerCase()} tone` 
‎      : '';
‎    const finalPrompt = `Read the following transcript exactly${expressionStr}: ${text}`;
‎
‎    const response = await ai.models.generateContent({
‎      model: modelName,
‎      // CRITICAL FIX: Revert contents to structured array with parts
‎      contents: [{ parts: [{ text: finalPrompt }] }], 
‎      config: {
‎        // CRITICAL FIX: `responseModalities` must be an array with a single `Modality.AUDIO` element.
‎        responseModalities: [Modality.AUDIO], 
‎        speechConfig: {
‎          voiceConfig: {
‎            prebuiltVoiceConfig: { voiceName: voice },
‎          },
‎        },
‎      },
‎    });
‎
‎    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
‎    if (!base64Audio) {
‎      // Added more descriptive error based on the user's working example
‎      throw new Error('Neural engine attempted to generate text instead of audio. Check prompt clarity or model configuration.');
‎    }
‎
‎    const binaryString = atob(base64Audio);
‎    const binaryAudio = new Uint8Array(binaryString.length);
‎    for (let i = 0; i < binaryString.length; i++) {
‎      binaryAudio[i] = binaryString.charCodeAt(i);
‎    }
‎    const wavHeader = createWavHeader(binaryAudio.length);
‎    const wavFile = new Uint8Array(wavHeader.length + binaryAudio.length);
‎    wavFile.set(wavHeader);
‎    wavFile.set(binaryAudio, wavHeader.length);
‎    const fullBase64Wav = btoa(String.fromCharCode(...wavFile));
‎    const audioUrl = `data:audio/wav;base64,${fullBase64Wav}`;
‎
‎    if (!isPreview) {
‎      const projectId = `tts-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
‎      const newProject = {
‎        id: projectId,
‎        userId: userId,
‎        text: text,
‎        voiceName: voice,
‎        createdAt: new Date().toISOString(),
‎        settings: settings,
‎        base64Audio: fullBase64Wav,
‎      };
‎      database.ttsProjects[projectId] = newProject;
‎      userData.history.push(projectId);
‎      userData.dailyCharsUsed += textLength;
‎      userData.charsUsed += textLength; // Update total chars used
‎    }
‎
‎    res.json({
‎      audioUrl: audioUrl,
‎      base64Audio: fullBase64Wav,
‎      dailyCharsUsed: isPreview ? 0 : userData.dailyCharsUsed,
‎      dailyLimitResetTime: isPreview ? new Date().toISOString() : userData.dailyLimitResetTime,
‎      currentDailyLimit: isPreview ? PLAN_LIMITS['free'] : userData.currentDailyLimit,
‎      charsUsed: isPreview ? 0 : userData.charsUsed, // Return total chars used
‎    });
‎
‎  } catch (error) {
‎    console.error("Gemini TTS API error:", error.message || error);
‎    res.status(500).json({ error: 'Failed to generate speech', details: error.message });
‎  }
‎});
‎
‎// Fetch User TTS History Endpoint
‎app.get('/user-history', (req, res) => {
‎  const { userId } = req.query;
‎
‎  if (!userId) {
‎    return res.status(400).json({ error: 'User ID is required.' });
‎  }
‎
‎  getUserData(userId); 
‎
‎  const userHistory = database.users[userId].history
‎    .map(projectId => database.ttsProjects[projectId])
‎    .filter(project => project !== undefined)
‎    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
‎    .map(project => ({
‎      ...project,
‎      audioUrl: `data:audio/wav;base64,${project.base64Audio}`,
‎    }));
‎
‎  res.json(userHistory);
‎});
‎
‎// Delete TTS Project Endpoint
‎app.delete('/delete-tts/:projectId', (req, res) => {
‎  const { projectId } = req.params;
‎  const { userId } = req.body;
‎
‎  if (!userId) {
‎    return res.status(400).json({ error: 'User ID is required.' });
‎  }
‎
‎  const projectToDelete = database.ttsProjects[projectId];
‎
‎  if (!projectToDelete || projectToDelete.userId !== userId) {
‎    return res.status(404).json({ error: 'Project not found or unauthorized.' });
‎  }
‎
‎  const userData = getUserData(userId);
‎  const textLength = projectToDelete.text.length;
‎
‎  delete database.ttsProjects[projectId];
‎  userData.history = userData.history.filter(id => id !== projectId);
‎  userData.dailyCharsUsed = Math.max(0, userData.dailyCharsUsed - textLength);
‎  userData.charsUsed = Math.max(0, userData.charsUsed - textLength); // Update total chars used
‎
‎  res.status(200).json({ 
‎    message: 'Project deleted successfully.', 
‎    dailyCharsUsed: userData.dailyCharsUsed,
‎    charsUsed: userData.charsUsed,
‎  });
‎});
‎
‎// Architect Voice Endpoint (re-using existing frontend logic, but calling backend)
‎app.post('/architect-voice', async (req, res) => {
‎  const { description } = req.body;
‎
‎  if (!description) {
‎    return res.status(400).json({ error: 'Description is required.' });
‎  }
‎
‎  try {
‎    const response = await ai.models.generateContent({
‎      model: "gemini-3-flash-preview",
‎      contents: `Based on the following description, suggest a base voice ('Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'), a pitch (number between 0.5 and 1.5, default 1.0), a speed (number between 0.5 and 2.0, default 1.0), and an expression ('Natural', 'Professional', 'Cheerful', 'Somber', 'Whispering', 'Authoritative', 'Excited'). Provide the output as a JSON object.`,
‎      config: {
‎        systemInstruction: "You are the Rox Voices AI Architect. Interpret the user's personality/mood description and map it to our engine's base voices (Zephyr, Kore, Puck, Charon, Fenrir) and settings (pitch 0.5-1.5, speed 0.5-2.0, expressions: Natural, Cheerful, Somber, Whispering, Authoritative, Excited, Professional). Return only a JSON object.",
‎        responseMimeType: "application/json",
‎        responseSchema: {
‎          type: "OBJECT",
‎          properties: {
‎            baseVoice: {
‎              type: "STRING",
‎              enum: ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'],
‎            },
‎            settings: {
‎              type: "OBJECT",
‎              properties: {
‎                pitch: { type: "NUMBER" },
‎                speed: { type: "NUMBER" },
‎                expression: { type: "STRING", enum: ['Natural', 'Professional', 'Cheerful', 'Somber', 'Whispering', 'Authoritative', 'Excited'] },
‎              },
‎              required: ["pitch", "speed", "expression"]
‎            }
‎          },
‎          required: ["baseVoice", "settings"],
‎        },
‎      },
‎    });
‎
‎    const jsonStr = response.text?.trim();
‎    if (!jsonStr) {
‎      throw new Error("No valid JSON response from AI.");
‎    }
‎
‎    const parsedResponse = JSON.parse(jsonStr);
‎    res.json(parsedResponse);
‎
‎  } catch (error) {
‎    console.error("Architect voice API error:", error.message || error);
‎    res.status(500).json({ error: 'Failed to architect voice profile', details: error.message });
‎  }
‎});
‎
‎app.listen(PORT, () => {
‎  console.log(`[Rox Backend] Server initialized and listening on port ${PORT}`);
‎});
‎
