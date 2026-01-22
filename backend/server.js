import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Modality } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ===== ENV CHECK =====
const API_KEY = process.env.API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!API_KEY || !supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Missing environment variables");
  process.exit(1);
}

// ===== INIT CLIENTS =====
const ai = new GoogleGenAI({ apiKey: API_KEY });
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ===== MEMORY DB =====
const database = {
  users: {},
  ttsProjects: {}
};

// ===== PLAN LIMITS =====
const PLAN_LIMITS = {
  free: 700,
  starter: 50000,
  vip: 200000,
  vvip: 1500000,
  exclusive: 5000000
};

// ===== HELPERS =====
function getUserData(userId, subscription = 'free', charsUsed = 0) {
  if (!database.users[userId]) {
    const now = new Date();
    const reset = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
    reset.setHours(0,0,0,0);

    database.users[userId] = {
      dailyCharsUsed: 0,
      dailyLimitResetTime: reset.toISOString(),
      subscription,
      currentDailyLimit: PLAN_LIMITS[subscription],
      charsUsed,
      history: []
    };
  }

  const user = database.users[userId];
  user.subscription = subscription;
  user.currentDailyLimit = PLAN_LIMITS[subscription];
  user.charsUsed = charsUsed;

  const now = new Date();
  const nowCAT = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Lusaka' }));
  const resetCAT = new Date(user.dailyLimitResetTime);

  if (nowCAT.toDateString() !== resetCAT.toDateString()) {
    const newReset = new Date(nowCAT);
    newReset.setHours(0,0,0,0);
    user.dailyCharsUsed = 0;
    user.dailyLimitResetTime = newReset.toISOString();
  }

  return user;
}

// ===== USER PROFILE =====
app.get('/user-profile', async (req,res)=>{
  const { userId } = req.query;
  if(!userId) return res.status(400).json({error:"UserId required"});

  const { data } = await supabase
    .from('profiles')
    .select('subscription, chars_used')
    .eq('id', userId)
    .single();

  const subscription = data?.subscription || 'free';
  const charsUsed = data?.chars_used || 0;

  const user = getUserData(userId, subscription, charsUsed);

  res.json({
    subscription: user.subscription,
    dailyCharsUsed: user.dailyCharsUsed,
    dailyLimitResetTime: user.dailyLimitResetTime,
    currentDailyLimit: user.currentDailyLimit,
    charsUsed: user.charsUsed
  });
});

// ===== ADMIN UPDATE PLAN =====
app.post('/admin-update-user-plan', async (req,res)=>{
  const { userId, plan } = req.body;
  if(!userId || !PLAN_LIMITS[plan]) return res.status(400).json({error:"Invalid input"});

  await supabase.from('profiles').update({ subscription: plan }).eq('id', userId);

  res.json({ message: "Plan updated" });
});

// ===== PAYMENT PROOF =====
app.post('/submit-payment-proof', async (req,res)=>{
  const { userId, userEmail, plan, filePath } = req.body;

  if(!userId || !userEmail || !plan || !filePath){
    return res.status(400).json({error:"Missing fields"});
  }

  await supabase.from('payment_requests').insert({
    user_id: userId,
    user_email: userEmail,
    plan,
    screenshot_path: filePath,
    status: 'pending'
  });

  res.json({ message: "Payment proof submitted" });
});

// ===== ADMIN FETCH PAYMENTS =====
app.get('/admin-payment-requests', async (req,res)=>{
  const { data } = await supabase
    .from('payment_requests')
    .select('*')
    .order('created_at',{ascending:false});

  const signed = await Promise.all(data.map(async row=>{
    if(!row.screenshot_path) return row;

    const { data: signedUrl } = await supabase
      .storage.from('payment_screenshots')
      .createSignedUrl(row.screenshot_path, 3600);

    return { ...row, screenshot_url: signedUrl?.signedUrl };
  }));

  res.json(signed);
});

// ===== TTS =====
app.post('/generate-tts', async (req,res)=>{
  const { text, voice, settings, userId, textLength } = req.body;

  if(!text || !voice || !userId) return res.status(400).json({error:"Missing fields"});

  const { data } = await supabase
    .from('profiles')
    .select('subscription, chars_used')
    .eq('id', userId)
    .single();

  const subscription = data?.subscription || 'free';
  const charsUsed = data?.chars_used || 0;

  const user = getUserData(userId, subscription, charsUsed);

  if(user.dailyCharsUsed + textLength > user.currentDailyLimit){
    return res.status(403).json({error:"Daily limit reached"});
  }

  try{
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config:{
        responseModalities:[Modality.AUDIO],
        speechConfig:{
          voiceConfig:{ prebuiltVoiceConfig:{ voiceName: voice } }
        }
      }
    });

    const base64Audio = response.candidates[0].content.parts[0].inlineData.data;

    user.dailyCharsUsed += textLength;
    user.charsUsed += textLength;

    await supabase.from('profiles')
      .update({ chars_used: user.charsUsed })
      .eq('id', userId);

    res.json({ base64Audio });

  }catch(e){
    console.error(e);
    res.status(500).json({error:"TTS failed"});
  }
});

// ===== ARCHITECT VOICE =====
app.post('/architect-voice', async (req,res)=>{
  const { description } = req.body;
  if(!description) return res.status(400).json({error:"Description required"});

  try{
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Suggest voice settings for: ${description}`,
      config:{
        responseMimeType:"application/json"
      }
    });

    const text = response.candidates[0].content.parts[0].text;
    res.json(JSON.parse(text));

  }catch(e){
    console.error(e);
    res.status(500).json({error:"Architect failed"});
  }
});

// ===== SERVER START =====
app.listen(PORT, ()=>{
  console.log("Backend running on port " + PORT);
});
