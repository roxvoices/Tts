// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { GoogleGenAI, Modality } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3001;

// ==================
// Middleware
// ==================
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// ==================
// Gemini AI Init
// ==================
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY is missing in environment variables");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// ==================
// Helper: Expression → Style
// ==================
function mapExpressionToSystemInstruction(expression) {
  switch (expression) {
    case 'Professional': return 'Speak in a clear, formal, professional tone.';
    case 'Cheerful': return 'Speak in a happy and upbeat tone.';
    case 'Somber': return 'Speak in a serious and calm tone.';
    case 'Whispering': return 'Speak softly as if whispering.';
    case 'Authoritative': return 'Speak in a confident commanding tone.';
    case 'Excited': return 'Speak with energetic enthusiasm.';
    default: return 'Speak naturally.';
  }
}

// ==================
// TTS Endpoint
// ==================
app.post('/generate-tts', async (req, res) => {
  try {
    const { text, voice, settings } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const systemInstruction = mapExpressionToSystemInstruction(
      settings?.expression || "Natural"
    );

    // ---- Call Gemini TTS ----
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-native-audio-preview",
      contents: [{ parts: [{ text }] }],
      config: {
        systemInstruction,
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice || "Zephyr"
            }
          }
        }
      }
    });

    // ---- Extract Audio ----
    const base64Audio =
      response.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64Audio) {
      return res.status(500).json({ error: "No audio returned from Gemini" });
    }

    // ---- Send to Frontend ----
    res.json({ base64Audio });

  } catch (err) {
    console.error("❌ TTS Error:", err.message);
    res.status(500).json({
      error: "Vocal synthesis failed",
      details: err.message
    });
  }
});

// ==================
app.listen(PORT, () => {
  console.log("🚀 Rox TTS Backend running on port:", PORT);
});
