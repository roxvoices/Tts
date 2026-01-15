import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Gemini AI
// API Key is obtained exclusively from process.env.GEMINI_API_KEY as per system requirements
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Professional TTS Synthesis Endpoint
 * Model: gemini-2.5-flash-preview-tts
 */
app.post('/generate-tts', async (req, res) => {
  try {
    const { text, voice, settings } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text input is required.' });
    }

    // Critical: For the TTS model, the prompt MUST be an instruction to speak.
    // We prefix the text to ensure the model doesn't attempt to "respond" textually.
    const expressionStr = settings?.expression && settings.expression !== 'Natural' 
      ? ` in a ${settings.expression.toLowerCase()} tone` 
      : '';
    
    const finalPrompt = `Read the following transcript exactly${expressionStr}: ${text}`;

    console.log(`[Neural Engine] Synthesis started for: "${text.substring(0, 30)}..."`);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text: finalPrompt }] }],
      config: {
        // MUST be exactly ['AUDIO']. gemini-2.5-flash-preview-tts does not support TEXT.
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

    // Extract the raw PCM audio bytes from the inlineData part
    const audioPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    const base64Audio = audioPart?.inlineData?.data;

    if (!base64Audio) {
      // If the model tried to generate text despite our config, it will fail here.
      throw new Error('Neural engine attempted to generate text instead of audio. Check prompt clarity.');
    }

    res.json({ base64Audio });
  } catch (error) {
    console.error('[Engine Failure]:', error.message);
    res.status(500).json({ 
      error: 'Vocal synthesis encountered a server error', 
      details: error.message 
    });
  }
});

/**
 * AI Voice Lab Architecture Endpoint
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
  console.log(`[Rox Backend] Server initialized and listening on port ${PORT}`);
});
