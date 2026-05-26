const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODEL = 'gemini-2.5-flash';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════════
// SYSTÈME DE HAUTE DISPONIBILITÉ — SUPERCOACH DATA ENGINE
// Principe : chaque source a une priorité et un fallback
// Si source primaire échoue → source secondaire → cache → continue
// Aucune source ne bloque jamais l'analyse finale
// ═══════════════════════════════════════════════════════════

// Cache mémoire — garde les dernières données valides
// Si toutes les APIs tombent, on utilise les données récentes
const DATA_CACHE = {
  espn: { data: [], timestamp: 0, ttl: 5 * 60 * 1000 },    // 5 min
  nhl:  { data: [], timestamp: 0, ttl: 5 * 60 * 1000 },    // 5 min
  news: { data: [], timestamp: 0, ttl: 15 * 60 * 1000 },   // 15 min
};

function isCacheValid(key) {
  const c = DATA_CACHE[key];
  return c.data.length > 0 && (Date.now() - c.timestamp) < c.ttl;
}

function updateCache(key, data) {
  if (data && data.length > 0) {
    DATA_CACHE[key].data = data;
    DATA_CACHE[key].timestamp = Date.now();
  }
}

// Fetch avec timeout — ne jamais bloquer plus de N secondes
function fetchWithTimeout(url, timeoutMs = 4000) {
  return Promise.race([
    fetch(url).then(r => r.ok ? r.json() : null),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ]).catch(() => null);
}

// ═══════════════════════════════════════════════════════════
// SOURCE 1 — ESPN (10 flux)
// Priorité : HAUTE — données live scores
// Fallback : cache si ESPN tombe
// ═══════════════════════════════════════════════════════════
const ESPN_SOURCES = [
  { name: 'Football CL|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' },
  { name: 'Football PL|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' },
  { name: 'Football Liga|sport_id:foot',   url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard' },
  { name: 'Football Ligue1|sport_id:foot', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard' },
  { name: 'Football SerieA|sport_id:foot', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard' },
  { name: 'Football Bundesliga|sport_id:foot', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard' },
  { name: 'NBA|sport_id:basket',           url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { name: 'Tennis ATP|sport_id:tennis',    url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' },
  { name: 'Tennis WTA|sport_id:tennis',    url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' },
  { name: 'NFL|sport_id:nfl',              url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
  { name: 'MMA|sport_id:mma',              url: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard' },
];

async function fetchESPN() {
  // Si cache valide, retour immédiat
  if (isCacheValid('espn')) {
    console.log('[ESPN] Cache hit');
    return DATA_CACHE['espn'].data;
  }

  const results = await Promise.allSettled(
    ESPN_SOURCES.map(src =>
      fetchWithTimeout(src.url, 4000)
        .then(data => ({ name: src.name, data }))
        .catch(() => null)
    )
  );

  const lines = [];
  for (const r of results) {
    if (!r.value?.data) continue;
    const { name, data } = r.value;
    try {
      if (data.events) {
        for (const event of (data.events || []).slice(0, 8)) {
          const comp = event.competitions?.[0];
          if (!comp) continue;
          const home = comp.competitors?.find(t => t.homeAway === 'home');
          const away = comp.competitors?.find(t => t.homeAway === 'away');
          if (!home || !away) continue;
          const status = comp.status?.type?.name || '';
          if (status === 'STATUS_FINAL') continue;
          const isLive = status === 'STATUS_IN_PROGRESS';
          const scoreStr = isLive ? ` [LIVE ${home.score}-${away.score}]` : '';
          const timeStr = event.date
            ? new Date(event.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
            : '';
          const hn = home.team?.displayName || home.team?.name || '?';
          const an = away.team?.displayName || away.team?.name || '?';
          lines.push(`[${name}] ${hn} vs ${an}${timeStr ? ' — ' + timeStr : ''}${scoreStr}`);
        }
      }
    } catch (e) { /* source partielle — on continue */ }
  }

  updateCache('espn', lines);
  return lines;
}

// ═══════════════════════════════════════════════════════════
// SOURCE 2 — NHL Official API
// Priorité : HAUTE — données officielles hockey
// Fallback : cache si NHL API tombe
// ═══════════════════════════════════════════════════════════
async function fetchNHL() {
  if (isCacheValid('nhl')) {
    console.log('[NHL] Cache hit');
    return DATA_CACHE['nhl'].data;
  }

  const data = await fetchWithTimeout('https://api-web.nhle.com/v1/score/now', 4000);
  const lines = [];

  if (data?.games) {
    for (const g of (data.games || []).slice(0, 8)) {
      if (g.gameState === 'FINAL' || g.gameState === 'OFF') continue;
      const isLive = g.gameState === 'LIVE' || g.gameState === 'CRIT';
      const scoreStr = isLive ? ` [LIVE ${g.awayTeam.score}-${g.homeTeam.score}]` : '';
      const timeStr = g.startTimeUTC
        ? new Date(g.startTimeUTC).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
        : '';
      const hn = g.awayTeam?.name?.default || g.awayTeam?.abbrev || '?';
      const hm = g.homeTeam?.name?.default || g.homeTeam?.abbrev || '?';
      lines.push(`[NHL|sport_id:hockey] ${hn} vs ${hm}${timeStr ? ' — ' + timeStr : ''}${scoreStr}`);
    }
  }

  updateCache('nhl', lines);
  return lines;
}

// ═══════════════════════════════════════════════════════════
// SOURCE 3 — RSS News (Guardian + BBC + L'Équipe + Sky)
// Priorité : MOYENNE — contexte éditorial
// Fallback : cache 15 min ou skip silencieux
// ═══════════════════════════════════════════════════════════
const RSS_SOURCES = [
  { name: 'The Guardian', url: 'https://www.theguardian.com/football/rss' },
  { name: 'BBC Sport',    url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { name: "L'Équipe",     url: 'https://www.lequipe.fr/rss/actu_rss_Football.xml' },
  { name: 'Sky Sports',   url: 'https://www.skysports.com/rss/12040' },
];

async function fetchNews() {
  if (isCacheValid('news')) {
    console.log('[NEWS] Cache hit');
    return DATA_CACHE['news'].data;
  }

  const headlines = [];
  const proxy = 'https://api.allorigins.win/get?url=';

  const results = await Promise.allSettled(
    RSS_SOURCES.map(src =>
      fetchWithTimeout(proxy + encodeURIComponent(src.url), 5000)
        .then(d => {
          if (!d?.contents) return [];
          const items = [];
          const matches = d.contents.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
          matches.slice(1, 5).forEach(m => {
            const title = m.replace(/<title><!\[CDATA\[|\]\]><\/title>|<title>|<\/title>/g, '').trim();
            if (title && title.length > 10) items.push(`[${src.name}] ${title}`);
          });
          return items;
        })
        .catch(() => [])
    )
  );

  for (const r of results) {
    if (r.value?.length) headlines.push(...r.value);
  }

  updateCache('news', headlines);
  return headlines;
}

// ═══════════════════════════════════════════════════════════
// ORCHESTRATEUR — collecte toutes les sources en parallèle
// Chaque source est indépendante — une panne n'en bloque pas d'autres
// ═══════════════════════════════════════════════════════════
async function fetchAllSources() {
  const [espnLines, nhlLines, newsLines] = await Promise.allSettled([
    fetchESPN(),
    fetchNHL(),
    fetchNews(),
  ]);

  return {
    espn:  espnLines.status  === 'fulfilled' ? espnLines.value  : DATA_CACHE['espn'].data,
    nhl:   nhlLines.status   === 'fulfilled' ? nhlLines.value   : DATA_CACHE['nhl'].data,
    news:  newsLines.status  === 'fulfilled' ? newsLines.value  : DATA_CACHE['news'].data,
  };
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR DU BLOC DATA — injecté dans le prompt Gemini
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// NORMALISEUR — Étape 2
// Transforme ESPN + NHL + News en format unique et cohérent
// Avant ce patch : Gemini recevait des formats hétérogènes
// Après : une seule structure lisible = analyse plus fiable
// ═══════════════════════════════════════════════════════════
function normalizeMatch(raw, sportId) {
  // Format attendu par Gemini : "SPORT | Équipe A vs Équipe B | Heure | Statut"
  // raw exemple : "[NBA|sport_id:basket] Lakers vs Celtics — 21:00 [LIVE 98-102]"
  
  const isLive   = raw.includes('[LIVE');
  const isFuture = !isLive;
  
  // Extraire le score si live
  const scoreMatch = raw.match(/\[LIVE ([^\]]+)\]/);
  const score = scoreMatch ? scoreMatch[1] : null;
  
  // Extraire l'heure
  const timeMatch = raw.match(/— (\d{2}:\d{2})/);
  const time = timeMatch ? timeMatch[1] : null;
  
  // Extraire les équipes
  const teamsMatch = raw.match(/\] (.+?) — |^\[.+?\] (.+)$/);
  const teams = teamsMatch ? (teamsMatch[1] || teamsMatch[2] || '').trim() : raw;
  
  // Format normalisé unique
  const status = isLive ? `LIVE ${score}` : (time ? `Upcoming ${time}` : 'Upcoming');
  return `${sportId.toUpperCase()} | ${teams.replace(/ — \d{2}:\d{2}/,'').trim()} | ${status}`;
}

function normalizeSources(sources) {
  const normalized = {
    matches: [],
    news: []
  };

  // Normaliser ESPN
  for (const line of (sources.espn || [])) {
    const sportMatch = line.match(/sport_id:(\w+)/);
    const sportId = sportMatch ? sportMatch[1] : 'sport';
    normalized.matches.push(normalizeMatch(line, sportId));
  }

  // Normaliser NHL (même format cible)
  for (const line of (sources.nhl || [])) {
    normalized.matches.push(normalizeMatch(line, 'hockey'));
  }

  // Normaliser News — format simple : SOURCE : Titre
  for (const line of (sources.news || [])) {
    const clean = line.replace(/^\[([^\]]+)\] /, '$1: ');
    normalized.news.push(clean);
  }

  return normalized;
}

function buildDataBlock(sources) {
  // Normaliser toutes les sources en format unique avant Gemini
  const norm = normalizeSources(sources);

  let block = '';

  if (norm.matches.length > 0) {
    block += '\n[Live sports data - use to enrich your analysis]\n';
    block += '// Format: SPORT | Team A vs Team B | Status\n';
    block += '// LIVE = in progress with score | Upcoming = scheduled\n\n';
    block += norm.matches.join('\n');
    block += '\n';
  }

  if (norm.news.length > 0) {
    block += '\n━━━ SPORTS NEWS ━━━\n';
    block += norm.news.slice(0, 8).join('\n');
    block += '\n';
  }

  if (block) {
    block += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    block += 'Cross-reference with user input. Use real scores if LIVE.\n';
  }

  return block;
}

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'SUPERCOACH API OK',
    version: '3.0',
    sources: {
      espn: isCacheValid('espn') ? 'cached' : 'live',
      nhl:  isCacheValid('nhl')  ? 'cached' : 'live',
      news: isCacheValid('news') ? 'cached' : 'live',
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT PRINCIPAL /analyze
// ═══════════════════════════════════════════════════════════
app.post('/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Clé API non configurée' });

    // Collecter toutes les sources en parallèle — sans jamais bloquer
    const sources = await fetchAllSources();
    const dataBlock = buildDataBlock(sources);

    // Injecter ESPN AVANT "USER INPUT" — ne jamais perturber l'instruction JSON finale
    const contentMarker = '━━━ USER INPUT BELOW ━━━';
    let enrichedPrompt;
    if (dataBlock && prompt.includes(contentMarker)) {
      enrichedPrompt = prompt.replace(contentMarker, dataBlock + contentMarker);
    } else {
      enrichedPrompt = dataBlock + prompt;
    }

    // Rappel JSON forcé — double sécurité
    enrichedPrompt += '\n\nRespond in valid JSON. Do not include markdown code blocks. Do not include backticks. The response must be parseable by JSON.parse().';

    // Appel Gemini
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
      return res.status(response.status).json({ error: err?.error?.message || 'Erreur Gemini ' + response.status });
    }

    const data = await response.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'Réponse vide Gemini' });

    // Nettoyeur backend — supprime les artefacts Gemini avant envoi au client
    // Évite que le parser frontend reçoive du markdown ou du texte parasite
    text = text
      .replace(/^```json\s*/gi, '')   // supprimer ```json au début
      .replace(/^```\s*/gi, '')        // supprimer ``` seul au début
      .replace(/```\s*$/g, '')         // supprimer ``` à la fin
      .trim();

    // Vérifier que la réponse commence bien par { ou [
    // Si non → chercher le premier { dans la réponse
    if (!text.startsWith('{') && !text.startsWith('[')) {
      const jsonStart = text.indexOf('{');
      if (jsonStart > -1) {
        text = text.slice(jsonStart);
        console.log('[CLEAN] Texte parasite supprimé avant le JSON');
      }
    }

    res.json({
      result: text,
      meta: {
        espn_matches: (sources.espn || []).length,
        nhl_matches:  (sources.nhl || []).length,
        news_items:   (sources.news || []).length,
      }
    });

  } catch (err) {
    console.error('Erreur server:', err);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SUPERCOACH API v3.0 — High Availability Engine — port ${PORT}`);
});
