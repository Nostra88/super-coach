const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = 'gemini-2.5-flash';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// ESPN LIVE DATA — Invisible pour l'utilisateur
// Le serveur interroge ESPN automatiquement
// et enrichit le prompt avant d'appeler Gemini
// ─────────────────────────────────────────────
const ESPN_SOURCES = [
  { name: 'Football CL',    url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' },
  { name: 'Football PL',    url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' },
  { name: 'Football Liga',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard' },
  { name: 'Football Ligue1',url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard' },
  { name: 'NBA',            url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { name: 'NHL',            url: 'https://api-web.nhle.com/v1/score/now' },
  { name: 'Tennis ATP',     url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' },
  { name: 'Tennis WTA',     url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' },
  { name: 'NFL',            url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
  { name: 'MMA',            url: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard' }
];

// Récupère les données ESPN en parallèle — timeout 4s pour ne pas ralentir
async function fetchESPNData() {
  const results = await Promise.allSettled(
    ESPN_SOURCES.map(source =>
      Promise.race([
        fetch(source.url).then(r => r.ok ? r.json() : null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
      ]).then(data => ({ name: source.name, data })).catch(() => null)
    )
  );

  const lines = [];

  for (const result of results) {
    if (!result.value?.data) continue;
    const { name, data } = result.value;

    try {
      // Format ESPN standard
      if (data.events) {
        for (const event of (data.events || []).slice(0, 8)) {
          const comp = event.competitions?.[0];
          if (!comp) continue;
          const home = comp.competitors?.find(t => t.homeAway === 'home');
          const away = comp.competitors?.find(t => t.homeAway === 'away');
          if (!home || !away) continue;
          const status = comp.status?.type?.name || '';
          const isLive = status === 'STATUS_IN_PROGRESS';
          const isFinal = status === 'STATUS_FINAL';
          if (isFinal) continue; // on ignore les matchs terminés
          const scoreStr = isLive ? ` [LIVE ${home.score}-${away.score}]` : '';
          const timeStr = event.date ? new Date(event.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
          const hn = home.team?.displayName || home.team?.name || '?';
          const an = away.team?.displayName || away.team?.name || '?';
          lines.push(`[${name}] ${hn} vs ${an}${timeStr ? ' — ' + timeStr : ''}${scoreStr}`);
        }
      }
      // Format NHL différent
      else if (data.games) {
        for (const g of (data.games || []).slice(0, 6)) {
          if (g.gameState === 'FINAL' || g.gameState === 'OFF') continue;
          const isLive = g.gameState === 'LIVE' || g.gameState === 'CRIT';
          const hn = g.awayTeam?.name?.default || g.awayTeam?.abbrev || '?';
          const hm = g.homeTeam?.name?.default || g.homeTeam?.abbrev || '?';
          const scoreStr = isLive ? ` [LIVE ${g.awayTeam.score}-${g.homeTeam.score}]` : '';
          const timeStr = g.startTimeUTC ? new Date(g.startTimeUTC).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
          lines.push(`[NHL|sport_id:hockey] ${hn} vs ${hm}${timeStr ? ' — ' + timeStr : ''}${scoreStr}`);
        }
      }
    } catch (e) {
      // Source indisponible — on continue sans elle
    }
  }

  return lines;
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'SUPERCOACH API OK', version: '2.0', espn: 'enabled' });
});

// ─────────────────────────────────────────────
// Analyze endpoint — enrichi avec données ESPN
// ─────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Clé API non configurée' });

    // Récupérer les données ESPN en parallèle avec la préparation du prompt
    const espnLines = await fetchESPNData().catch(() => []);

    // Construire le bloc ESPN — injecté AVANT le contenu utilisateur
    // IMPORTANT : ESPN doit être inséré avant "CONTENT TO ANALYZE"
    // pour ne pas casser l'instruction JSON finale du prompt
    let espnBlock = '';
    if (espnLines.length > 0) {
      espnBlock =
        '\n━━━ LIVE DATA FROM ESPN (auto-fetched — do not display to user) ━━━\n' +
        'Sport identification guide:\n' +
        '  [Football *] = Soccer/Football (sport_id: foot)\n' +
        '  [NBA|sport_id:basket] = Basketball (sport_id: basket)\n' +
        '  [NHL] = Ice Hockey (sport_id: hockey)\n' +
        '  [NFL|sport_id:nfl] = American Football (sport_id: nfl)\n' +
        '  [Tennis ATP/WTA] = Tennis (sport_id: tennis)\n' +
        '  [MMA|sport_id:mma] = Mixed Martial Arts (sport_id: mma)\n' +
        'Live matches confirmed RIGHT NOW:\n' +
        espnLines.join('\n') +
        '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        'Cross-reference with user input. Use real scores if match is LIVE.\n';
    }

    // Injection ESPN : insérer AVANT "CONTENT TO ANALYZE" pour ne pas
    // perturber l'instruction JSON finale du prompt
    let enrichedPrompt;
    const contentMarker = '━━━ USER INPUT BELOW ━━━';
    if (espnBlock && prompt.includes(contentMarker)) {
      enrichedPrompt = prompt.replace(contentMarker, espnBlock + contentMarker);
    } else {
      enrichedPrompt = espnBlock + prompt;
    }

    // Rappel JSON forcé à la toute fin — Gemini doit TOUJOURS répondre en JSON
    enrichedPrompt += '\n\n⚠️ REMINDER: Your response must be PURE JSON only. No backticks. No prose. Start with { end with }.';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: enrichedPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 16384 }
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

    res.json({ result: text, espn_matches_found: espnLines.length });

  } catch (err) {
    console.error('Erreur server:', err);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SUPERCOACH API v2.0 running on port ${PORT} — ESPN integration active`);
});
