import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API Key must be obtained exclusively from process.env.GEMINI_API_KEY
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Professional TTS Synthesis Endpoint
 * Targets: gemini-2.5-flash-preview-tts
 */
app.post('/generate-tts', async (req, res) => {
  try {
    const { text, voice, settings } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text input is required.' });
    }

    // Incorporate expression into the text prompt for natural prosody
    const expressionPrefix = settings?.expression && settings.expression !== 'Natural' 
      ? `Say ${settings.expression}: ` 
      : '';
    const promptText = `${expressionPrefix}${text}`;

    console.log(`[Neural Engine] Synthesizing: "${promptText.substring(0, 40)}..." [Voice: ${voice}]`);

    // CRITICAL: gemini-2.5-flash-preview-tts DOES NOT support systemInstruction.
    // It requires responseModalities to be exactly ['AUDIO'].
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: promptText }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice || 'Zephyr',
            },
          },
        },
      },
    });

    const audioPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    const base64Audio = audioPart?.inlineData?.data;

    if (!base64Audio) {
      throw new Error('The neural engine failed to produce audio data. The requested modality may have been rejected.');
    }

    res.json({ base64Audio });
  } catch (error) {
    console.error('[Backend Failure]:', error.message);
    res.status(500).json({ 
      error: 'Vocal synthesis encountered a server error', 
      details: error.message 
    });
  }
});

/**
 * AI Voice Lab Architecture Endpoint
 * Targets: gemini-3-flash-preview
 */
app.post('/architect-voice', async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required.' });

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Generate a TTS configuration profile for the following description: "${description}"`,
      config: {
        systemInstruction: "You are the Rox Voices AI Architect. Map descriptions to engine parameters (Voices: Zephyr, Kore, Puck, Charon, Fenrir). Return JSON only.",
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
  console.log(`[Rox Backend] Synchronized and running on port ${PORT}`);
});
