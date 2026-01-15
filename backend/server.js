import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Init Gemini
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

/**
 * ===== TEXT TO SPEECH ENDPOINT =====
 */
app.post("/generate-tts", async (req, res) => {
  try {
    const { text, voice } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    console.log("TTS Request:", text.substring(0, 40));

    // ✅ Correct Gemini 2.5 TTS call
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [
        {
          role: "user",
          parts: [{ text }]
        }
      ],
      // ✅ Voice goes here (Zephyr, Alloy, etc)
      voice: voice || "Zephyr"
    });

    // Extract base64 audio
    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      console.error("Raw Gemini response:", JSON.stringify(response, null, 2));
      return res.status(500).json({ error: "No audio returned" });
    }

    res.json({ base64Audio });

  } catch (err) {
    console.error("TTS Backend Error:", err);
    res.status(500).json({
      error: "Vocal synthesis encountered a server error",
      details: err.message
    });
  }
});

/**
 * ===== VOICE ARCHITECT ENDPOINT (unchanged) =====
 */
app.post("/architect-voice", async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: "Description required" });

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          role: "user",
          parts: [{ text: description }]
        }
      ]
    });

    res.json({ text: response.text });

  } catch (err) {
    res.status(500).json({ error: "Voice architecture failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
