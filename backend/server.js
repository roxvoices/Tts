import express from 'express';
import cors from 'cors';
import { GoogleGenAI, Modality, Type } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Gemini AI
// The API key is obtained exclusively from the environment variable process.env.GEMINI_API_KEY
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

    console.log(`[Rox Engine] Synthesizing: "${text.substring(0, 30)}..." with voice: ${voice || 'Zephyr'}`);

    // Generate content using the dedicated TTS model
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text }] }],
      config: {
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

    // Extract the base64 encoded PCM audio data
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      throw new Error('The neural engine failed to produce audio data.');
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
        systemInstruction: "You are the Rox Voices AI Architect. Interpret user descriptions of personas and map them to our internal base voices (Zephyr, Kore, Puck, Charon, Fenrir) and vocal parameters. Output only valid JSON.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            baseVoice: { 
              type: Type.STRING,
              description: "The name of the base voice model to use."
            },
            settings: {
              type: Type.OBJECT,
              properties: {
                pitch: { type: Type.NUMBER, description: "Pitch multiplier from 0.5 to 1.5" },
                speed: { type: Type.NUMBER, description: "Speed multiplier from 0.5 to 2.0" },
                expression: { type: Type.STRING, description: "The emotional mood of the voice." }
              },
              required: ["pitch", "speed", "expression"]
            }
          },
          required: ["baseVoice", "settings"]
        }
      }
    });

    // Per guidelines: access .text property directly
    const result = response.text;
    if (!result) throw new Error("AI Architect failed to generate profile.");

    res.json(JSON.parse(result));
  } catch (error) {
    console.error('[Architect Error]:', error.message);
    res.status(500).json({ error: 'Voice architecture failed.', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Rox Backend] Server running on port ${PORT}`);
});
                            
