const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY = process.env.GEMINI_KEY;

// Cascade modèles — vérifiés actifs au 29/05/2026
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════════
// SUPERCOACH DATA ENGINE v6.0 — FACT-FIRST ARCHITECTURE
// Pipeline : Extraction → Validation → Conteneur de vérité → Gemini
// Gemini ne reçoit QUE des faits validés — zéro invention possible
// ═══════════════════════════════════════════════════════════

// ── Helpers ─────────────────────────────────────────────────
function fetchWithTimeout(url, ms = 4000) {
  return Promise.race([
    fetch(url).then(r => r.ok ? r.json() : null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);
}

async function fetchTextWithTimeout(url, ms = 4000) {
  return Promise.race([
    fetch(url).then(r => r.ok ? r.text() : null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);
}

// Cache 5 minutes
const CACHE = {};
function fromCache(key) {
  const c = CACHE[key];
  return (c && Date.now() - c.ts < 5 * 60 * 1000) ? c.data : null;
}
function toCache(key, data) {
  if (data && (Array.isArray(data) ? data.length > 0 : true))
    CACHE[key] = { data, ts: Date.now() };
}

// ═══════════════════════════════════════════════════════════
// ANCRAGE TEMPOREL RÉEL — injecté côté serveur uniquement
// ═══════════════════════════════════════════════════════════
function getRealTimeBlock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day  = now.toLocaleDateString('en-US', { weekday: 'long' });

  const zones = [
    ['Paris/CET',   'Europe/Paris'],
    ['London/GMT',  'Europe/London'],
    ['New York/ET', 'America/New_York'],
    ['LA/PT',       'America/Los_Angeles'],
    ['Tokyo/JST',   'Asia/Tokyo'],
  ];
  const clocks = zones.map(([label, tz]) => {
    try {
      return `${label}:${now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`;
    } catch { return ''; }
  }).filter(Boolean).join(' | ');

  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const tomorrow  = new Date(now); tomorrow.setDate(tomorrow.getDate()+1);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  return [
    '━━━ REAL-TIME ANCHOR ━━━',
    `TODAY    : ${day} ${date} ${time}`,
    `CLOCKS   : ${clocks}`,
    `YESTERDAY: ${fmt(yesterday)} | TOMORROW: ${fmt(tomorrow)}`,
    '─────────────────────────────────────',
    'TEMPORAL RULES (ABSOLUTE — NEVER OVERRIDE):',
    `1. Today is ${date}. This is ABSOLUTE FACT.`,
    '2. NEVER analyze a match dated before today as if it is upcoming.',
    '3. NEVER invent a date, score, or match not present in JSON_VALIDATED_DATA.',
    '4. If match date is unclear → set match_date_uncertain:true.',
    '5. Past matches → refuse predictive analysis, signal as completed.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT FACT-FIRST
// Règles d'or anti-hallucination — injectées avant chaque analyse
// ═══════════════════════════════════════════════════════════
function getSystemPrompt() {
  return [
    '━━━ SUPERCOACH SYSTEM PROMPT — FACT-FIRST PROTOCOL ━━━',
    '',
    'ROLE: You are the expert AI of SUPERCOACH.',
    'Your role is to ANALYZE validated sports facts — NOT to search for events.',
    'Your reliability is the #1 product value. An incorrect result is a critical failure.',
    '',
    '━━━ GOLDEN RULES (MANDATORY — NEVER VIOLATE) ━━━',
    '',
    'RULE 1 — ZERO INVENTION:',
    'You have NO RIGHT to invent a match, date, time, score, or team.',
    'If information is not explicitly provided in JSON_VALIDATED_DATA → it does not exist.',
    'NEVER complete missing data. NEVER extrapolate. NEVER assume.',
    '',
    'RULE 2 — VALIDATE BEFORE ANALYZING:',
    'Before any reasoning, check the validation_status field.',
    '→ If "INVALID" or "NOT_FOUND" → respond ONLY with: {"matches":[],"summary":"Match not found or could not be validated. Please check your input.","roi_potential":""}',
    '→ If "PARTIAL" → analyze only confirmed data, flag uncertain fields.',
    '→ If "VERIFIED" → full analysis authorized.',
    '',
    'RULE 3 — AMBIGUITY HANDLING:',
    'Use your sports knowledge to detect the sport automatically from context:',
    '  Sinner/Alcaraz/Djokovic/Swiatek/Nadal/Federer/Gauff/Sabalenka → Tennis',
    '  PSG/Real Madrid/Liverpool/Bayern/Barcelona/Arsenal/Chelsea → Football',
    '  Lakers/Celtics/Warriors/Bulls/Heat/Bucks → Basketball',
    '  Oilers/Rangers/Bruins/Maple Leafs/Canadiens → Hockey',
    '  Chiefs/Eagles/Cowboys/Patriots/Ravens → NFL',
    'ONLY ask for clarification if sport is truly impossible to determine.',
    'Clarification: {"matches":[],"summary":"Please specify the sport for this query.","roi_potential":""}',
    '',
    'RULE 4 — TEMPORAL INTEGRITY:',
    'Check today\'s date from the REAL-TIME ANCHOR block above.',
    '→ Past match → refuse predictive analysis, return match_date_uncertain:true.',
    '→ Future match → analyze based only on provided data.',
    '→ Live match → prioritize LIVE score from JSON_VALIDATED_DATA.',
    '',
    'RULE 5 — DATA HIERARCHY:',
    'Official API data (JSON_VALIDATED_DATA) > User-provided text > Your training knowledge.',
    'If conflict → official API data wins ALWAYS.',
    '',
    'RULE 6 — OUTPUT FORMAT:',
    'ALWAYS return valid JSON object: {"matches":[...],"summary":"...","roi_potential":"..."}',
    'NEVER return a bare array. NEVER add markdown, backticks, or prose.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// DÉTECTEUR D'INTENTION UNIVERSEL
// ═══════════════════════════════════════════════════════════
function detectIntention(prompt) {
  const p = prompt.toLowerCase();
  const sports = new Set();

  if (/\b(foot|soccer|ligue|premier|liga|serie a|bundesliga|champions|europa|psg|real madrid|barcelona|liverpool|chelsea|arsenal|manchester|juventus|milan|monaco|marseille|lyon|atletico|dortmund|bayern|mbappe|haaland|salah|messi|ronaldo|bellingham|mls|brasileirao|j.league|k.league|csl|nwsl|wsl|eredivisie|primeira|goal|penalty|corner)\b/.test(p))
    sports.add('foot');

  if (/\b(tennis|atp|wta|roland|garros|wimbledon|us open|australian|grand slam|masters|sinner|alcaraz|djokovic|swiatek|sabalenka|gauff|rublev|tsitsipas|medvedev|zverev|set|ace|serve|break)\b/.test(p))
    sports.add('tennis');

  if (/\b(nba|wnba|ncaa|basket|basketball|euroleague|eurocup|pro a|lakers|celtics|warriors|bulls|heat|bucks|nuggets|suns|lebron|curry|durant|giannis|tatum|embiid|jokic|wembanyama|asvel|monaco basket)\b/.test(p))
    sports.add('basket');

  if (/\b(nhl|hockey|stanley|oilers|maple leafs|rangers|bruins|penguins|canadiens|avalanche|lightning|golden knights|flames|canucks|khl|mcdavid|ovechkin|crosby|matthews|goalie|puck)\b/.test(p))
    sports.add('hockey');

  if (/\b(nfl|super bowl|chiefs|eagles|cowboys|patriots|packers|ravens|49ers|mahomes|lamar|josh allen|touchdown|quarterback)\b/.test(p))
    sports.add('nfl');

  if (/\b(mlb|baseball|yankees|dodgers|red sox|mets|cubs|braves|astros|world series|pitcher|home run|npb|kbo)\b/.test(p))
    sports.add('baseball');

  if (/\b(ufc|mma|boxing|boxe|combat|fight|ko|knockout|mcgregor|ngannou|jones|canelo|fury|usyk|joshua)\b/.test(p))
    sports.add('mma');

  if (/\b(rugby|six nations|world cup rugby|top 14|premiership|super rugby|all blacks|springboks|try|scrum)\b/.test(p))
    sports.add('rugby');

  if (/\b(f1|formula|grand prix|motogp|verstappen|hamilton|leclerc|norris|alonso|ferrari|mercedes|red bull)\b/.test(p))
    sports.add('f1');

  if (/\b(handball|ehf|starligue|paris handball|montpellier hand|kiel|flensburg|veszprem)\b/.test(p))
    sports.add('handball');

  if (/\b(volleyball|volley|fivb|vnl|trentino|civitanova|perugia|modena|zaksa|tours)\b/.test(p))
    sports.add('volley');

  // Coupe du Monde 2026
  if (/\b(coupe du monde|world cup|mundial|cdm|coupe|wc2026|group stage|phase de poule|knockout|huitieme|quart|demi.finale|finale)\b/.test(p))
    sports.add('foot');

  if (sports.size === 0) { sports.add('foot'); sports.add('tennis'); }
  return Array.from(sports);
}

// ═══════════════════════════════════════════════════════════
// SOURCES ESPN + SOURCES OFFICIELLES
// ═══════════════════════════════════════════════════════════
const ESPN_SOURCES = {
  foot: [
    { name: 'Football CL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' },
    { name: 'Football EL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard' },
    { name: 'Football PL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' },
    { name: 'Football Liga|sport_id:foot',        url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard' },
    { name: 'Football Ligue1|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard' },
    { name: 'Football SerieA|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard' },
    { name: 'Football Bundesliga|sport_id:foot',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard' },
    { name: 'Football Eredivisie|sport_id:foot',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard' },
    { name: 'Football Primeira|sport_id:foot',    url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/scoreboard' },
    { name: 'Football MLS|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
    { name: 'Football Brasileirao|sport_id:foot', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard' },
    { name: 'Football Argentina|sport_id:foot',   url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard' },
    { name: 'Football LigaMX|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard' },
    { name: 'Football JLeague|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/scoreboard' },
    { name: 'Football KLeague|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/kor.1/scoreboard' },
    { name: 'Football CSL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/chn.1/scoreboard' },
    { name: 'Football NWSL|sport_id:foot',        url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard' },
    { name: 'Football WSL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.w.1/scoreboard' },
  ],
  tennis:   [
    { name: 'Tennis ATP|sport_id:tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' },
    { name: 'Tennis WTA|sport_id:tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' },
  ],
  basket:   [
    { name: 'NBA|sport_id:basket',           url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { name: 'WNBA|sport_id:basket',          url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard' },
    { name: 'NCAA|sport_id:basket',          url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard' },
    { name: 'Euroleague|sport_id:basket',    url: 'EUROLEAGUE_OFFICIAL' },
    { name: 'EuroCup|sport_id:basket',       url: 'EUROCUP_OFFICIAL' },
  ],
  hockey:   [
    { name: 'NHL|sport_id:hockey', url: 'NHL_OFFICIAL' },
    { name: 'AHL|sport_id:hockey', url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/ahl/scoreboard' },
  ],
  nfl:      [{ name: 'NFL|sport_id:nfl',      url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' }],
  baseball: [{ name: 'MLB|sport_id:baseball', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' }],
  mma:      [{ name: 'UFC|sport_id:mma',       url: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard' }],
  rugby:    [{ name: 'Rugby|sport_id:rugby',   url: 'https://site.api.espn.com/apis/site/v2/sports/rugby/scoreboard' }],
  f1:       [{ name: 'F1|sport_id:f1',         url: 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard' }],
  handball: [],
  volley:   [],
};

// ── Fetcher universel ───────────────────────────────────────
async function fetchESPNSource(src) {
  const cached = fromCache(src.name);
  if (cached) return cached;

  // NHL Official
  if (src.url === 'NHL_OFFICIAL') {
    const data = await fetchWithTimeout('https://api-web.nhle.com/v1/score/now');
    const lines = [];
    for (const g of (data?.games || []).slice(0, 10)) {
      if (g.gameState === 'FINAL' || g.gameState === 'OFF') continue;
      const live = g.gameState === 'LIVE' || g.gameState === 'CRIT';
      const score = live ? ` [LIVE ${g.awayTeam.score}-${g.homeTeam.score}]` : '';
      const t = g.startTimeUTC ? new Date(g.startTimeUTC).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
      lines.push(`[NHL|sport_id:hockey] ${g.awayTeam?.name?.default||'?'} vs ${g.homeTeam?.name?.default||'?'}${t?' — '+t:''}${score}`);
    }
    toCache(src.name, lines); return lines;
  }

  // Euroleague / EuroCup
  if (src.url === 'EUROLEAGUE_OFFICIAL' || src.url === 'EUROCUP_OFFICIAL') {
    const isCup = src.url === 'EUROCUP_OFFICIAL';
    const comp = isCup ? 'U' : 'E';
    const now = new Date();
    const seasonYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    const season = `${comp}${seasonYear}`;
    const url = `https://feeds.incrowdsports.com/provider/euroleague-feeds/v3/competitions/${comp}/seasons/${season}/games?phaseTypeCode=RS&limit=20`;
    const data = await fetchWithTimeout(url);
    const lines = [];
    for (const g of (data?.data || []).slice(0, 10)) {
      if (g.status === 'result') continue;
      const live = g.status === 'live';
      const score = live ? ` [LIVE ${g.homeScore||0}-${g.awayScore||0}]` : '';
      const t = g.utcDate ? new Date(g.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
      const label = isCup ? 'EuroCup' : 'Euroleague';
      lines.push(`[${label}|sport_id:basket] ${g.homeTeam?.name||'?'} vs ${g.awayTeam?.name||'?'}${t?' — '+t:''}${score}`);
    }
    toCache(src.name, lines); return lines;
  }

  // ESPN standard
  const data = await fetchWithTimeout(src.url);
  const lines = [];
  for (const event of (data?.events || []).slice(0, 10)) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find(t => t.homeAway === 'home');
    const away = comp.competitors?.find(t => t.homeAway === 'away');
    if (!home || !away) continue;
    const status = comp.status?.type?.name || '';
    if (status === 'STATUS_FINAL') continue;
    const live = status === 'STATUS_IN_PROGRESS';
    const score = live ? ` [LIVE ${home.score}-${away.score}]` : '';
    const t = event.date ? new Date(event.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
    lines.push(`[${src.name}] ${home.team?.displayName||'?'} vs ${away.team?.displayName||'?'}${t?' — '+t:''}${score}`);
  }
  toCache(src.name, lines); return lines;
}

// ── RSS News ────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'BBC Sport',    url: 'https://feeds.bbci.co.uk/sport/football/rss.xml',     sport: 'foot'   },
  { name: 'Sky Sports',   url: 'https://www.skysports.com/rss/12040',                  sport: 'foot'   },
  { name: 'The Guardian', url: 'https://www.theguardian.com/football/rss',             sport: 'foot'   },
  { name: "L'Equipe",     url: 'https://www.lequipe.fr/rss/actu_rss_Football.xml',    sport: 'foot'   },
  { name: 'Foot Mercato', url: 'https://www.footmercato.net/rss',                      sport: 'foot'   },
  { name: 'UEFA',         url: 'https://www.uefa.com/rssfeed/newslist/latest/',        sport: 'foot'   },
  { name: 'BBC Tennis',   url: 'https://feeds.bbci.co.uk/sport/tennis/rss.xml',       sport: 'tennis' },
  { name: 'BBC NBA',      url: 'https://feeds.bbci.co.uk/sport/basketball/rss.xml',   sport: 'basket' },
  { name: 'BBC Rugby',    url: 'https://feeds.bbci.co.uk/sport/rugby-union/rss.xml',  sport: 'rugby'  },
  { name: 'BBC F1',       url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml',     sport: 'f1'     },
];
const CORS_PROXY = 'https://api.allorigins.win/get?url=';

async function fetchRSSFeed(feed) {
  const cached = fromCache('rss_' + feed.name);
  if (cached) return cached;
  const data = await fetchTextWithTimeout(CORS_PROXY + encodeURIComponent(feed.url), 5000).catch(() => null);
  if (!data) return [];
  let xml = data;
  try { xml = JSON.parse(data).contents || data; } catch {}
  const items = [];
  const matches = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
  matches.slice(1, 5).forEach(m => {
    const title = m.replace(/<title><!\[CDATA\[|\]\]><\/title>|<title>|<\/title>/g, '').trim();
    if (title && title.length > 10) items.push(`[${feed.name}] ${title}`);
  });
  toCache('rss_' + feed.name, items);
  return items;
}

// Football-Data.org
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '';
async function fetchFootballData(sportIds) {
  if (!sportIds.includes('foot') || !FOOTBALL_DATA_KEY) return [];
  const cached = fromCache('football_data');
  if (cached) return cached;
  const url = 'https://api.football-data.org/v4/matches?status=SCHEDULED,LIVE,IN_PLAY';
  const data = await Promise.race([
    fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } }).then(r => r.ok ? r.json() : null),
    new Promise((_, rej) => setTimeout(() => rej(), 4000))
  ]).catch(() => null);
  const lines = [];
  for (const m of (data?.matches || []).slice(0, 15)) {
    if (m.status === 'FINISHED') continue;
    const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    const score = live ? ` [LIVE ${m.score?.fullTime?.home||0}-${m.score?.fullTime?.away||0}]` : '';
    const t = m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
    lines.push(`[Football-Data|${m.competition?.name||'Football'}|sport_id:foot] ${m.homeTeam?.name||'?'} vs ${m.awayTeam?.name||'?'}${t?' — '+t:''}${score}`);
  }
  toCache('football_data', lines);
  return lines;
}

// ═══════════════════════════════════════════════════════════
// FILTRE DE PERTINENCE — Score intelligent par intention
// ═══════════════════════════════════════════════════════════
function extractEntities(prompt) {
  const p = prompt.toLowerCase();
  const stopWords = new Set(['match','game','play','team','club','sport','score','win','loss',
    'draw','the','and','for','this','that','avec','pour','les','des','dans','contre','vs','versus']);
  const tokens = p.match(/[a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüý]{3,}/g) || [];
  const entities = new Set();
  tokens.forEach(t => { if (!stopWords.has(t)) entities.add(t); });
  return entities;
}

function scoreRelevance(line, entities, prompt) {
  const lineLower = line.toLowerCase();
  let score = 0;
  for (const entity of entities) {
    if (lineLower.includes(entity)) { score = Math.max(score, 3); break; }
  }
  if (lineLower.includes('[live')) score = Math.max(score, 2);
  if (score === 0) {
    const sportIds = detectIntention(prompt);
    for (const sid of sportIds) {
      if (lineLower.includes('sport_id:' + sid)) { score = Math.max(score, 1); break; }
    }
  }
  return score;
}

function filterAndPrioritize(lines, prompt) {
  if (!lines || lines.length === 0) return [];
  const entities = extractEntities(prompt);
  const scored = lines.map(line => ({ line, score: scoreRelevance(line, entities, prompt) }));
  scored.sort((a, b) => b.score - a.score);
  const relevant   = scored.filter(s => s.score >= 1).map(s => s.line);
  const contextual = scored.filter(s => s.score === 0).slice(0, 5).map(s => s.line);
  const result = [...relevant, ...contextual];
  console.log(`[FILTER] ${lines.length} → ${result.length} lignes après scoring`);
  return result;
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR JSON_VALIDATED_DATA — Conteneur de vérité
// C'est la pièce centrale de l'architecture Fact-First
// ═══════════════════════════════════════════════════════════
function buildValidatedDataContainer(liveLines, newsLines, fdLines, sportIds, prompt) {
  const filteredLive = filterAndPrioritize(liveLines, prompt);

  // Statut de validation global
  const hasVerifiedData = filteredLive.length > 0 || fdLines.length > 0;
  const validationStatus = hasVerifiedData ? 'PARTIAL' : 'UNVERIFIED';

  let block = `\n━━━ JSON_VALIDATED_DATA ━━━\n`;
  block += `validation_status: ${validationStatus}\n`;
  block += `data_sources: ESPN×18, NHL_Official, Euroleague, Football-Data\n`;
  block += `\n`;

  if (filteredLive.length > 0) {
    block += `[VERIFIED_LIVE_MATCHES]\n`;
    block += filteredLive.join('\n') + '\n\n';
  }

  if (fdLines.length > 0) {
    block += `[FOOTBALL_DATA_FIXTURES]\n`;
    block += fdLines.join('\n') + '\n\n';
  }

  if (newsLines.length > 0) {
    block += `[NEWS_CONTEXT — for injury/form enrichment only]\n`;
    block += newsLines.slice(0, 8).join('\n') + '\n\n';
  }

  if (filteredLive.length === 0 && fdLines.length === 0) {
    block += `[NO_LIVE_DATA_FOUND]\n`;
    block += `No matches found in live APIs for sports: ${sportIds.join(', ')}\n`;
    block += `→ Analyze based STRICTLY on user input. Do NOT invent matches.\n`;
    block += `→ If user input is ambiguous, return validation_status: NOT_FOUND\n\n`;
  }

  block += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  block += `CRITICAL: Only analyze events present above or explicitly stated by user.\n`;
  block += `If a match is NOT in the data above and NOT clearly stated → DO NOT INVENT IT.\n\n`;

  return block;
}

// ═══════════════════════════════════════════════════════════
// ORCHESTRATEUR
// ═══════════════════════════════════════════════════════════
async function fetchAllData(sportIds) {
  const espnPromises = sportIds.flatMap(id => (ESPN_SOURCES[id] || []).map(s => fetchESPNSource(s)));
  const rssPromise   = Promise.allSettled(
    RSS_FEEDS.filter(f => sportIds.includes(f.sport)).map(f => fetchRSSFeed(f))
  ).then(rs => rs.flatMap(r => r.status === 'fulfilled' && r.value ? r.value : []));
  const fdPromise    = fetchFootballData(sportIds);

  const [espnResults, newsLines, fdLines] = await Promise.all([
    Promise.allSettled(espnPromises).then(rs => rs.flatMap(r => r.status === 'fulfilled' && r.value ? r.value : [])),
    rssPromise.catch(() => []),
    fdPromise.catch(() => []),
  ]);

  return { live: espnResults, news: newsLines, fd: fdLines };
}

// ── Health check ────────────────────────────────────────────
async function checkModelsHealth() {
  console.log('[MODEL CHECK] Vérification des modèles Gemini...');
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say ok' }] }], generationConfig: { maxOutputTokens: 5, thinkingConfig: { thinkingBudget: 0 } } })
      });
      clearTimeout(tid);
      if (r.status === 404) console.error(`[MODEL CHECK] ❌ ${model} — DÉPRÉCIÉ`);
      else if (r.ok) console.log(`[MODEL CHECK] ✅ ${model} — OK`);
      else console.warn(`[MODEL CHECK] ⚠️ ${model} — HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[MODEL CHECK] ⚠️ ${model} — ${err.name === 'AbortError' ? 'Timeout' : err.message}`);
    }
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'SUPERCOACH API OK', version: '6.0-fact-first', cached: Object.keys(CACHE).length });
});

app.get('/health', async (req, res) => {
  const status = {};
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 6000);
      const r = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say ok' }] }], generationConfig: { maxOutputTokens: 5 } })
      });
      status[model] = r.ok ? '✅ OK' : `❌ HTTP ${r.status}`;
    } catch (e) { status[model] = e.name === 'AbortError' ? '⚠️ Timeout' : `❌ ${e.message}`; }
  }
  res.json({ time: new Date().toISOString(), models: status });
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT PRINCIPAL /analyze
// ═══════════════════════════════════════════════════════════
app.post('/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Clé API non configurée' });

    const T0 = Date.now();

    // 1. Temps réel + intention
    const timeBlock = getRealTimeBlock();
    const systemPrompt = getSystemPrompt();
    const sportIds = detectIntention(prompt);
    const T1 = Date.now();
    console.log(`[TIMER] Intention: ${T1-T0}ms — Sports: ${sportIds.join(', ')}`);

    // 2. Fetch ciblé
    const sources = await fetchAllData(sportIds);
    const T2 = Date.now();
    console.log(`[TIMER] Fetch: ${T2-T1}ms — Live:${sources.live.length} News:${sources.news.length} FD:${sources.fd.length}`);

    // 3. Construire le conteneur de vérité JSON_VALIDATED_DATA
    const validatedContainer = buildValidatedDataContainer(
      sources.live, sources.news, sources.fd, sportIds, prompt
    );
    const T3 = Date.now();

    // 4. Assembler le prompt enrichi
    // Ordre : SystemPrompt → AncrageTemporal → JSON_VALIDATED_DATA → User Input
    const marker = '━━━ USER INPUT BELOW ━━━';
    let enrichedPrompt;
    if (prompt.includes(marker)) {
      enrichedPrompt = systemPrompt + timeBlock + prompt.replace(marker, validatedContainer + marker);
    } else {
      enrichedPrompt = systemPrompt + timeBlock + validatedContainer + prompt;
    }

    const promptTokenEstimate = Math.round(enrichedPrompt.length / 4);
    console.log(`[TIMER] Prompt: ${T3-T2}ms — ${enrichedPrompt.length} chars (~${promptTokenEstimate} tokens)`);

    // 5. Rappel format final
    enrichedPrompt += '\n\nFORMAT RULES:\n1. Respond ONLY with valid JSON object: {"matches":[...],"summary":"...","roi_potential":"..."}\n2. NEVER bare array. NEVER markdown. NEVER backticks.\n3. Start with { end with }';

    // 6. Appel Gemini avec cascade fallback
    let text = null, usedModel = null, lastError = null;

    for (const model of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: enrichedPrompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 16384 }
          })
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const errMsg = err?.error?.message || '';
          if (response.status === 429 || response.status === 503 ||
              errMsg.includes('high demand') || errMsg.includes('quota') ||
              errMsg.includes('overloaded')) {
            console.log(`[FALLBACK] ${model} surchargé → suivant`);
            lastError = errMsg || `HTTP ${response.status}`;
            continue;
          }
          return res.status(response.status).json({ error: errMsg || 'Erreur Gemini' });
        }

        const data = await response.json();
        const candidate = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!candidate) { lastError = 'Réponse vide'; continue; }

        text = candidate;
        usedModel = model;
        const T4 = Date.now();
        console.log(`[TIMER] Gemini(${model}): ${T4-T3}ms | TOTAL: ${T4-T0}ms`);
        break;

      } catch (err) {
        if (err.name === 'AbortError') {
          console.log(`[FALLBACK] ${model} timeout 25s → suivant`);
          lastError = 'timeout';
        } else {
          lastError = err.message;
        }
        continue;
      }
    }

    if (!text) {
      return res.status(503).json({ error: `Gemini temporairement indisponible. Réessaie dans quelques minutes. (${lastError})` });
    }

    // 7. Nettoyage backend
    text = text.replace(/^```json\s*/gi, '').replace(/^```\s*/gi, '').replace(/```\s*$/g, '').trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      const idx = text.indexOf('{');
      if (idx > -1) text = text.slice(idx);
    }

    const TEND = Date.now();
    res.json({
      result: text,
      meta: {
        sports: sportIds,
        live: sources.live.length,
        news: sources.news.length,
        fd: sources.fd.length,
        model: usedModel,
        timing: {
          total_ms: TEND - T0,
          fetch_ms: T2 - T1,
          gemini_ms: TEND - T3,
          prompt_chars: enrichedPrompt.length,
          prompt_tokens_est: promptTokenEstimate
        }
      }
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// ENDPOINT /scrape — Proxy de scraping
// Le serveur visite l'URL à la place de l'iPhone
// Résout le problème CORS Safari + permet le collage d'URL directe
// ═══════════════════════════════════════════════════════════
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  // Valider le format URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'URL invalide — HTTP/HTTPS uniquement' });
    }
  } catch {
    return res.status(400).json({ error: 'URL invalide' });
  }

  console.log(`[SCRAPE] Tentative : ${parsedUrl.hostname}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Simuler un navigateur réel pour éviter les blocages basiques
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 403 || response.status === 503) {
        return res.json({
          success: false,
          blocked: true,
          message: `Site protégé (${parsedUrl.hostname}) — copiez le texte manuellement`,
          hostname: parsedUrl.hostname
        });
      }
      return res.json({ success: false, message: `Erreur HTTP ${response.status}` });
    }

    const html = await response.text();

    // Extraire le texte propre — supprimer scripts, styles, nav, pubs
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .trim();

    // Limiter à 8000 caractères pour ne pas surcharger Gemini
    const truncated = clean.length > 8000 ? clean.slice(0, 8000) + '\n[...contenu tronqué]' : clean;

    console.log(`[SCRAPE] ✅ ${parsedUrl.hostname} — ${truncated.length} chars extraits`);

    res.json({
      success: true,
      hostname: parsedUrl.hostname,
      content: truncated,
      chars: truncated.length
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.json({
        success: false,
        blocked: true,
        message: `Timeout — ${parsedUrl.hostname} trop lent ou bloqué`,
        hostname: parsedUrl.hostname
      });
    }
    console.error('[SCRAPE] Erreur:', err.message);
    res.json({ success: false, message: 'Erreur réseau : ' + err.message });
  }
});

// Warmup + health check au démarrage
app.listen(PORT, () => {
  console.log(`SUPERCOACH API v6.0-fact-first — port ${PORT}`);
  setTimeout(() => {
    const warmup = [
      ...(ESPN_SOURCES.foot || []).slice(0, 4),
      ...(ESPN_SOURCES.tennis || []),
    ];
    Promise.allSettled(warmup.map(s => fetchESPNSource(s)))
      .then(() => console.log('[WARMUP] Cache foot + tennis prêt'));
    if (GEMINI_KEY) checkModelsHealth();
  }, 3000);
});
