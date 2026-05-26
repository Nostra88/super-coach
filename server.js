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
// SUPERCOACH DATA ENGINE v6.0
// Sources complètes : ESPN + NHL + Euroleague + RSS (BBC, Sky,
// Guardian, L'Équipe, Foot Mercato, UEFA) + Football-Data.org
// + Ancrage temporel réel injecté dans chaque analyse
// ═══════════════════════════════════════════════════════════

// ── Helpers ─────────────────────────────────────────────────
function fetchWithTimeout(url, ms = 4000) {
  return Promise.race([
    fetch(url).then(r => r.ok ? r.json() : null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]).catch(() => null);
}

async function fetchText(url, ms = 4000) {
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
// ANCRAGE TEMPOREL RÉEL
// Injecté dans chaque prompt côté serveur
// Garantit que Gemini sait EXACTEMENT quel jour/heure il est
// ═══════════════════════════════════════════════════════════
function getRealTimeBlock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day  = now.toLocaleDateString('en-US', { weekday: 'long' });
  const tzOffset = -now.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzOffset)/60));
  const tzM = pad(Math.abs(tzOffset)%60);

  // Heure dans les fuseaux sportifs majeurs
  const zones = [
    ['Paris/CET',    'Europe/Paris'],
    ['London/GMT',   'Europe/London'],
    ['New York/ET',  'America/New_York'],
    ['Los Angeles',  'America/Los_Angeles'],
    ['Tokyo/JST',    'Asia/Tokyo'],
    ['Sydney/AEST',  'Australia/Sydney'],
  ];
  const clockLine = zones.map(([label, tz]) => {
    try {
      const t = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      return `${label}: ${t}`;
    } catch { return ''; }
  }).filter(Boolean).join(' | ');

  return [
    '━━━ REAL-TIME ANCHOR (server-injected) ━━━',
    `Today       : ${day} ${date}`,
    `Server time : ${time} UTC${tzSign}${tzH}:${tzM}`,
    `World clocks: ${clockLine}`,
    '─────────────────────────────────────────',
    'MANDATORY TEMPORAL RULES:',
    `1. Today is ${date}. This is ABSOLUTE FACT — never override.`,
    '2. Any match dated BEFORE today → EXCLUDE from analysis.',
    '3. Any match with uncertain date → flag as match_date_uncertain:true.',
    '4. NEVER invent a date. NEVER assume a fixture without confirmation.',
    `5. "Yesterday" = ${pad(now.getDate()-1)}/${pad(now.getMonth()+1)}/${now.getFullYear()}. "Tomorrow" = ${pad(now.getDate()+1)}/${pad(now.getMonth()+1)}/${now.getFullYear()}.`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// DÉTECTEUR D'INTENTION UNIVERSEL
// ═══════════════════════════════════════════════════════════
function detectIntention(prompt) {
  const p = prompt.toLowerCase();
  const sports = new Set();

  if (/\b(foot|soccer|ligue|premier|liga|serie a|bundesliga|champions|europa|psg|real madrid|barcelona|liverpool|chelsea|arsenal|manchester|juventus|milan|monaco|marseille|lyon|atletico|dortmund|bayern|mbappe|haaland|salah|benzema|messi|ronaldo|bellingham|bundesliga|mls|brasileirao|j.league|k.league|csl china|women|feminine|nwsl|wsl|fifa women|eredivisie|primera liga|jupiler|coupe de france|fa cup|copa del rey|goal|penalty|corner|carton)\b/.test(p))
    sports.add('foot');

  if (/\b(tennis|atp|wta|roland garros|wimbledon|us open|australian|grand slam|masters|sinner|alcaraz|djokovic|swiatek|sabalenka|gauff|rublev|tsitsipas|medvedev|zverev|set|ace|serve|backhand|forehand|break point|deuce)\b/.test(p))
    sports.add('tennis');

  if (/\b(nba|wnba|ncaa|basket|basketball|euroleague|eurocup|pro a|betclic elite|liga acb|lega basket|bbl|lakers|celtics|warriors|bulls|heat|knicks|bucks|nuggets|suns|lebron|curry|durant|giannis|tatum|embiid|jokic|wembanyama|doncic|asvel|monaco basket|barcelona basket|real madrid basket|zalgiris|maccabi|fenerbahce basket|olympiacos basket|virtus bologna|olimpia milano|alba berlin)\b/.test(p))
    sports.add('basket');

  if (/\b(nhl|hockey|stanley cup|oilers|maple leafs|rangers|bruins|penguins|canadiens|avalanche|lightning|golden knights|flames|canucks|khl|shl|liiga|del hockey|mcdavid|ovechkin|crosby|matthews|makar|goalie|puck|power play|icing|face.?off)\b/.test(p))
    sports.add('hockey');

  if (/\b(nfl|super bowl|chiefs|eagles|cowboys|patriots|packers|ravens|49ers|mahomes|lamar jackson|josh allen|hurts|dak|touchdown|field goal|quarterback|running back|wide receiver|linebacker)\b/.test(p))
    sports.add('nfl');

  if (/\b(mlb|baseball|yankees|dodgers|red sox|mets|cubs|braves|astros|world series|pitcher|home run|strikeout|batting|npb|kbo|japanese baseball|korean baseball|softbank|yomiuri|ohtani|samsung lions|lotte giants)\b/.test(p))
    sports.add('baseball');

  if (/\b(ufc|mma|boxing|boxe|combat|fight|ko|knockout|submission|mcgregor|ngannou|jones|adesanya|canelo|fury|usyk|joshua|crawford|davis gervonta|inoue)\b/.test(p))
    sports.add('mma');

  if (/\b(rugby|six nations|world cup rugby|premiership|top 14|super rugby|all blacks|springboks|wallabies|england rugby|france rugby|ireland|leinster|toulouse|try|scrum|lineout|conversion|drop goal)\b/.test(p))
    sports.add('rugby');

  if (/\b(f1|formula 1|grand prix|motogp|moto2|verstappen|hamilton|leclerc|norris|alonso|ferrari|mercedes|red bull|mclaren|monaco gp|silverstone|monza|spa|suzuka)\b/.test(p))
    sports.add('f1');

  if (/\b(handball|hand|ehf|starligue|paris handball|montpellier hand|nantes hand|kiel|flensburg|veszprem|barcelona hand|porto hand|kielce)\b/.test(p))
    sports.add('handball');

  if (/\b(volleyball|volley|fivb|vnl|nations league volley|superliga volley|ligue a volley|brazil volley|poland volley|italy volley|trentino|civitanova|perugia|modena|zaksa|tours vb|paris volley)\b/.test(p))
    sports.add('volley');

  if (sports.size === 0) { sports.add('foot'); sports.add('tennis'); }
  return Array.from(sports);
}

// ═══════════════════════════════════════════════════════════
// SOURCE 1 — ESPN (scores live, toutes ligues)
// ═══════════════════════════════════════════════════════════
const ESPN_SOURCES = {
  foot: [
    { name: 'Football CL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard' },
    { name: 'Football EL|sport_id:foot',           url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard' },
    { name: 'Football PL|sport_id:foot',           url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard' },
    { name: 'Football Liga|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard' },
    { name: 'Football Ligue1|sport_id:foot',       url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard' },
    { name: 'Football SerieA|sport_id:foot',       url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard' },
    { name: 'Football Bundesliga|sport_id:foot',   url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard' },
    { name: 'Football Eredivisie|sport_id:foot',   url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard' },
    { name: 'Football Primeira|sport_id:foot',     url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/scoreboard' },
    { name: 'Football MLS|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
    { name: 'Football Brasileirao|sport_id:foot',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard' },
    { name: 'Football Argentina|sport_id:foot',    url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard' },
    { name: 'Football LigaMX|sport_id:foot',       url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard' },
    { name: 'Football JLeague|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/scoreboard' },
    { name: 'Football KLeague|sport_id:foot',      url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/kor.1/scoreboard' },
    { name: 'Football CSL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/chn.1/scoreboard' },
    { name: 'Football NWSL|sport_id:foot',         url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard' },
    { name: 'Football WSL|sport_id:foot',          url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.w.1/scoreboard' },
  ],
  tennis:   [
    { name: 'Tennis ATP|sport_id:tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard' },
    { name: 'Tennis WTA|sport_id:tennis', url: 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard' },
  ],
  basket:   [
    { name: 'NBA|sport_id:basket',  url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { name: 'WNBA|sport_id:basket', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard' },
    { name: 'NCAA|sport_id:basket', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard' },
    { name: 'Euroleague|sport_id:basket', url: 'EUROLEAGUE_OFFICIAL' },
    { name: 'EuroCup|sport_id:basket',    url: 'EUROCUP_OFFICIAL' },
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
  handball: [], volley: [],
};

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
    // Saison dynamique : Euroleague commence en octobre, finit en juin
    // Si on est entre juillet et décembre → saison N, sinon saison N-1
    const now = new Date();
    const seasonYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    const season = isCup ? `U${seasonYear}` : `E${seasonYear}`;
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

// ═══════════════════════════════════════════════════════════
// SOURCE 2 — RSS NEWS (BBC, Sky, Guardian, L'Équipe, Foot Mercato, UEFA)
// Contexte éditorial : blessés, formes, actualités
// ═══════════════════════════════════════════════════════════
const RSS_FEEDS = [
  { name: 'BBC Sport',     url: 'https://feeds.bbci.co.uk/sport/football/rss.xml',        sport: 'foot' },
  { name: 'Sky Sports',    url: 'https://www.skysports.com/rss/12040',                     sport: 'foot' },
  { name: 'The Guardian',  url: 'https://www.theguardian.com/football/rss',                sport: 'foot' },
  { name: "L'Equipe",      url: 'https://www.lequipe.fr/rss/actu_rss_Football.xml',        sport: 'foot' },
  { name: 'Foot Mercato',  url: 'https://www.footmercato.net/rss',                         sport: 'foot' },
  { name: 'UEFA',          url: 'https://www.uefa.com/rssfeed/newslist/latest/',            sport: 'foot' },
  { name: 'BBC Tennis',    url: 'https://feeds.bbci.co.uk/sport/tennis/rss.xml',           sport: 'tennis' },
  { name: 'BBC NBA',       url: 'https://feeds.bbci.co.uk/sport/basketball/rss.xml',       sport: 'basket' },
  { name: 'BBC Rugby',     url: 'https://feeds.bbci.co.uk/sport/rugby-union/rss.xml',      sport: 'rugby' },
  { name: 'BBC F1',        url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml',         sport: 'f1' },
  { name: 'BBC Boxing',    url: 'https://feeds.bbci.co.uk/sport/boxing/rss.xml',           sport: 'mma' },
];

const CORS_PROXY = 'https://api.allorigins.win/get?url=';

async function fetchRSSFeed(feed) {
  const cached = fromCache('rss_' + feed.name);
  if (cached) return cached;

  const data = await fetchText(CORS_PROXY + encodeURIComponent(feed.url), 5000).catch(() => null);
  if (!data) return [];

  let xml = data;
  try { xml = JSON.parse(data).contents || data; } catch {}

  const items = [];
  const matches = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
  matches.slice(1, 6).forEach(m => {
    const title = m.replace(/<title><!\[CDATA\[|\]\]><\/title>|<title>|<\/title>/g, '').trim();
    if (title && title.length > 10) items.push(`[${feed.name}] ${title}`);
  });

  toCache('rss_' + feed.name, items);
  return items;
}

async function fetchTargetedRSS(sportIds) {
  const relevantFeeds = RSS_FEEDS.filter(f => sportIds.includes(f.sport));
  if (relevantFeeds.length === 0) return [];

  const results = await Promise.allSettled(relevantFeeds.map(f => fetchRSSFeed(f)));
  const lines = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) lines.push(...r.value);
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════
// SOURCE 3 — Football-Data.org (résultats, classements, fixtures)
// Gratuit · Clé "trial" → X-Auth-Token header
// ═══════════════════════════════════════════════════════════
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
    const status = m.status;
    if (status === 'FINISHED') continue;
    const live = status === 'IN_PLAY' || status === 'PAUSED';
    const score = live ? ` [LIVE ${m.score?.fullTime?.home||0}-${m.score?.fullTime?.away||0}]` : '';
    const t = m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
    const comp = m.competition?.name || 'Football';
    lines.push(`[Football-Data|${comp}|sport_id:foot] ${m.homeTeam?.name||'?'} vs ${m.awayTeam?.name||'?'}${t?' — '+t:''}${score}`);
  }

  toCache('football_data', lines);
  return lines;
}


// ═══════════════════════════════════════════════════════════
// P2 — FILTRE DE PERTINENCE INTELLIGENT
// Principe : scorer chaque ligne de données selon son
// adéquation avec l'intention utilisateur
//
// Score 3 : Match explicitement demandé (équipe/joueur trouvé)
// Score 2 : Match LIVE dans la compétition concernée
// Score 1 : Même compétition / même sport
// Score 0 : Non lié → bruit potentiel
//
// Les données score 0 sont conservées mais en dernier
// Aucune suppression brutale — logique de priorisation
// ═══════════════════════════════════════════════════════════
function extractEntities(prompt) {
  // Extraire les noms d'équipes, joueurs, compétitions mentionnés
  const p = prompt.toLowerCase();
  const entities = new Set();

  // Extraire les mots significatifs (longueur > 3, pas des mots communs)
  const stopWords = new Set(['match','game','play','team','club','sport','score',
    'win','loss','draw','the','and','for','this','that','avec','pour','les','des',
    'dans','contre','vs','versus']);

  // Extraire tokens significatifs du prompt utilisateur
  const tokens = p.match(/[a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüý]{3,}/g) || [];
  tokens.forEach(t => { if (!stopWords.has(t)) entities.add(t); });

  return entities;
}

function scoreRelevance(line, entities, prompt) {
  const lineLower = line.toLowerCase();
  const p = prompt.toLowerCase();
  let score = 0;

  // Score 3 — Entité explicitement mentionnée dans le prompt
  for (const entity of entities) {
    if (lineLower.includes(entity)) {
      score = Math.max(score, 3);
      break;
    }
  }

  // Score 2 — Match LIVE (toujours pertinent pour le contexte)
  if (lineLower.includes('[live')) {
    score = Math.max(score, 2);
  }

  // Score 1 — Même sport détecté
  if (score === 0) {
    const sportIds = detectIntention(prompt);
    for (const sid of sportIds) {
      if (lineLower.includes('sport_id:' + sid)) {
        score = Math.max(score, 1);
        break;
      }
    }
  }

  return score;
}

function filterAndPrioritize(lines, prompt) {
  if (!lines || lines.length === 0) return [];

  const entities = extractEntities(prompt);

  // Scorer chaque ligne
  const scored = lines.map(line => ({
    line,
    score: scoreRelevance(line, entities, prompt)
  }));

  // Trier par score décroissant
  scored.sort((a, b) => b.score - a.score);

  // Retourner toutes les lignes scorées ≥ 1 en priorité,
  // plus max 5 lignes score 0 pour conserver le contexte global
  const relevant   = scored.filter(s => s.score >= 1).map(s => s.line);
  const contextual = scored.filter(s => s.score === 0).slice(0, 5).map(s => s.line);

  const result = [...relevant, ...contextual];

  console.log(`[FILTER] ${lines.length} lines → ${result.length} after relevance scoring`);
  return result;
}

// ═══════════════════════════════════════════════════════════
// ORCHESTRATEUR — Fetch ciblé multi-sources
// ═══════════════════════════════════════════════════════════
async function fetchAllData(sportIds) {
  // Lancer toutes les sources en parallèle
  const espnPromises = sportIds.flatMap(id => (ESPN_SOURCES[id] || []).map(s => fetchESPNSource(s)));
  const rssPromise = fetchTargetedRSS(sportIds);
  const fdPromise  = fetchFootballData(sportIds);

  const [espnResults, newsLines, fdLines] = await Promise.all([
    Promise.allSettled(espnPromises).then(rs => rs.flatMap(r => r.status === 'fulfilled' && r.value ? r.value : [])),
    rssPromise.catch(() => []),
    fdPromise.catch(() => []),
  ]);

  return { live: espnResults, news: newsLines, fd: fdLines };
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR DU BLOC DATA
// ═══════════════════════════════════════════════════════════
function buildDataBlock(sources, sportIds, prompt) {
  let block = '';

  // Appliquer le filtre de pertinence sur les données live
  const filteredLive = prompt ? filterAndPrioritize(sources.live, prompt) : sources.live;

  if (filteredLive.length > 0) {
    block += '[Live data — ESPN + NHL + Euroleague]\n';
    block += filteredLive.join('\n') + '\n\n';
  }

  if (sources.fd.length > 0) {
    block += '[Football-Data.org — fixtures & live]\n';
    block += sources.fd.join('\n') + '\n\n';
  }

  if (sources.news.length > 0) {
    block += '[News context — BBC · Sky · Guardian · L\'Équipe · Foot Mercato · UEFA]\n';
    block += sources.news.slice(0, 10).join('\n') + '\n\n';
  }

  if (!block) return '';

  return '\n[Sports data — auto-fetched for: ' + sportIds.join(', ') + ']\n' +
         block +
         'Cross-reference with user input. LIVE score = priority over knowledge.\n';
}

// ── Health check ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'SUPERCOACH API OK', version: '6.0',
    sources: ['ESPN x18', 'NHL Official', 'Euroleague', 'EuroCup', 'Football-Data.org', 'BBC Sport', 'Sky Sports', 'The Guardian', "L'Équipe", 'Foot Mercato', 'UEFA RSS'],
    cached_keys: Object.keys(CACHE).length,
    time: new Date().toISOString(),
  });
});

// ── Endpoint principal ──────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt manquant' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Clé API non configurée' });

    // 1. Temps réel + intention
    const timeBlock  = getRealTimeBlock();
    const sportIds   = detectIntention(prompt);
    console.log(`[${new Date().toISOString()}] Sports: ${sportIds.join(', ')}`);

    // 2. Fetch ciblé multi-sources
    const sources  = await fetchAllData(sportIds);
    const dataBlock = buildDataBlock(sources, sportIds, prompt);

    // 3. Injection : temps réel AVANT tout, données AVANT user input
    const marker = '━━━ USER INPUT BELOW ━━━';
    let enrichedPrompt;
    if (prompt.includes(marker)) {
      enrichedPrompt = timeBlock + prompt.replace(marker, dataBlock + marker);
    } else {
      enrichedPrompt = timeBlock + dataBlock + prompt;
    }

    // 4. Rappel format JSON — doux mais clair
    enrichedPrompt += '\n\nRespond in valid JSON. Do not include markdown code blocks or backticks.';

    // 5. Appel Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: enrichedPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 16384 }
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || 'Erreur Gemini' });
    }

    const data = await response.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'Réponse vide Gemini' });

    // 6. Nettoyage markdown si présent
    text = text.replace(/^```json\s*/gi, '').replace(/^```\s*/gi, '').replace(/```\s*$/g, '').trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      const idx = text.indexOf('{');
      if (idx > -1) text = text.slice(idx);
    }

    res.json({
      result: text,
      meta: { sports: sportIds, live: sources.live.length, news: sources.news.length, fd: sources.fd.length }
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

// Warmup au démarrage
app.listen(PORT, () => {
  console.log(`SUPERCOACH API v6.0 — Universal Sports Engine — port ${PORT}`);
  setTimeout(() => {
    const warmup = [
      ...(ESPN_SOURCES.foot || []).slice(0, 4),
      ...(ESPN_SOURCES.tennis || []),
    ];
    Promise.allSettled(warmup.map(s => fetchESPNSource(s)))
      .then(() => console.log('[WARMUP] Cache foot + tennis prêt'));
  }, 2000);
});
