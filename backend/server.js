import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Modality } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Gemini AI
// API Key is obtained exclusively from process.env.GEMINI_API_KEY
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Endpoint to generate TTS audio using Gemini
 */
app.post('/generate-tts', async (req, res) => {
  try {
    const { text, voice, settings } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text input is required.' });
    }

    console.log(`[TTS] Synthesizing: "${text.substring(0, 30)}..." with voice: ${voice || 'Zephyr'}`);

    // Generate content using the dedicated TTS model
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: `Please speak the following text: ${text}` }] }],
      config: {
        systemInstruction: "You are a professional text-to-speech engine. Your ONLY task is to convert the provided text into audio. NEVER generate any text output or response. ONLY output the audio modality.",
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice || 'Zephyr',
            },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64Audio) {
      throw new Error('The neural engine failed to produce audio data. Ensure the input text is appropriate for speech.');
    }

    // Return the raw base64 data to the client
    res.json({ base64Audio });
  } catch (error) {
    console.error('[Backend Error]:', error.message);
    res.status(500).json({ 
      error: 'Vocal synthesis encountered a server error.', 
      details: error.message 
    });
  }
});

/**
 * Endpoint for Voice Architecting (AI-driven parameter mapping)
 */
app.post('/architect-voice', async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required.' });

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Generate a TTS configuration profile for the following description: "${description}"`,
      config: {
        systemInstruction: "You are the Rox Voices AI Architect. Map descriptions to engine parameters. Return JSON only.",
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            baseVoice: { type: "STRING" },
            settings: {
              type: "OBJECT",
              properties: {
                pitch: { type: "NUMBER" },
                speed: { type: "NUMBER" },
                expression: { type: "STRING" }
              },
              required: ["pitch", "speed", "expression"]
            }
          },
          required: ["baseVoice", "settings"]
        }
      }
    });

    res.json(JSON.parse(response.text));
  } catch (error) {
    res.status(500).json({ error: 'Voice architecture failed.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Rox Backend] Server running on http://localhost:${PORT}`);
});
