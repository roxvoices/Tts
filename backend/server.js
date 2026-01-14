import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.post("/generate-tts", async (req, res) => {
  try {
    const { text, voice, settings } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }]
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: "Gemini API Error", details: err });
    }

    const data = await response.json();
    const base64Audio =
      data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return res.status(500).json({ error: "No audio returned" });
    }

    res.json({ base64Audio });
  } catch (err) {
    res.status(500).json({ error: "Server crash", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));