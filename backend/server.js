import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Modality } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// ======================
// GEMINI API KEY ROTATION
// ======================

const geminiKeys = [];
for (let i = 0; i <= 50; i++) {
  const keyName = i === 0 ? 'API_KEY' : `API_KEY${i}`;
  if (process.env[keyName]) geminiKeys.push(process.env[keyName]);
}

if (geminiKeys.length === 0) {
  console.error("No Gemini API keys found.");
  process.exit(1);
}

let currentKeyIndex = 0;

function getAIClient() {
  return new GoogleGenAI({ apiKey: geminiKeys[currentKeyIndex] });
}

function rotateKey() {
  currentKeyIndex++;
  if (currentKeyIndex >= geminiKeys.length) currentKeyIndex = 0;
  console.log("🔁 Switched Gemini API Key ->", currentKeyIndex);
}

// ======================

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// WAV HEADER
function createWavHeader(dataSize) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeString = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o+i, s.charCodeAt(i)); };
  writeString(0,'RIFF');
  view.setUint32(4,36+dataSize,true);
  writeString(8,'WAVE');
  writeString(12,'fmt ');
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,1,true);
  view.setUint32(24,24000,true);
  view.setUint32(28,48000,true);
  view.setUint16(32,2,true);
  view.setUint16(34,16,true);
  writeString(36,'data');
  view.setUint32(40,dataSize,true);
  return new Uint8Array(buffer);
}

// ======================
// MOCK DATABASE
// ======================

const database = {
  users: {},
  ttsProjects: {}
};

const PLAN_LIMITS = {
  free: 700,
  starter: 50000,
  vip: 200000,
  vvip: 1500000,
  exclusive: 5000000
};

function getUserData(userId, plan='free') {
  if (!database.users[userId]) {
    database.users[userId] = {
      dailyCharsUsed: 0,
      subscription: plan,
      history: [],
      charsUsed: 0
    };
  }
  database.users[userId].currentDailyLimit = PLAN_LIMITS[database.users[userId].subscription];
  return database.users[userId];
}

// ======================
// TTS GENERATION
// ======================

app.post('/generate-tts', async (req, res) => {
  const { text, voice, settings, userId, textLength } = req.body;

  if (!text || !voice || !settings || !userId) {
    return res.status(400).json({ error:'Missing parameters' });
  }

  const userData = getUserData(userId);

  if (userData.dailyCharsUsed + textLength > userData.currentDailyLimit) {
    return res.status(403).json({ error:'Daily limit reached' });
  }

  let response;

  while (true) {
    try {
      const ai = getAIClient();

      const finalPrompt = `Read the following transcript exactly: ${text}`;

      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts:[{ text: finalPrompt }] }],
        config:{
          responseModalities:[Modality.AUDIO],
          speechConfig:{
            voiceConfig:{ prebuiltVoiceConfig:{ voiceName: voice } }
          }
        }
      });

      break;

    } catch (error) {
      const msg = error.message || "";

      if (
        msg.includes("quota") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("429") ||
        msg.includes("rate")
      ) {
        rotateKey();
        continue;
      }

      return res.status(500).json({ error:"Gemini failure", details: msg });
    }
  }

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!base64Audio) {
    return res.status(500).json({ error:"No audio returned" });
  }

  const binary = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
  const header = createWavHeader(binary.length);
  const wav = new Uint8Array(header.length + binary.length);
  wav.set(header);
  wav.set(binary, header.length);
  const finalBase64 = btoa(String.fromCharCode(...wav));

  userData.dailyCharsUsed += textLength;
  userData.charsUsed += textLength;

  res.json({
    audioUrl:`data:audio/wav;base64,${finalBase64}`,
    dailyCharsUsed:userData.dailyCharsUsed,
    currentDailyLimit:userData.currentDailyLimit
  });
});

// ======================

app.listen(PORT, ()=>{
  console.log("Rox Backend running on port", PORT);
});
