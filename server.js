const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = 'gemini-2.5-flash';

// CORS — autorise tout
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept']
}));

// Répondre aux preflight OPTIONS
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SUPERCOACH API OK', version: '1.0' });
});

// Analyze endpoint
app.post('/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Clé API non configurée' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err?.error?.message || 'Erreur Gemini ' + response.status
      });
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'Réponse vide Gemini' });

    res.json({ result: text });

  } catch (err) {
    console.error('Erreur server:', err);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SUPERCOACH API running on port ${PORT}`);
});
