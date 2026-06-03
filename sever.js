// ═══════════════════════════════════════════════════════════
// SUPERCOACH API — v8.0 PRODUCTION
// Paradigme : La donnée externe valide. Gemini analyse. Jamais l'inverse.
// Pipeline : TheOddsAPI → API-Sports → ESPN (enrichissement) → Gemini
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');

// ── Neon PostgreSQL ──────────────────────────────────────────
let sql = null;
try {
  const { neon } = require('@neondatabase/serverless');
  const DATABASE_URL = process.env.DATABASE_URL || '';
  if (DATABASE_URL) { sql = neon(DATABASE_URL); console.log('[DB] Neon connecté'); }
  else { console.log('[DB] DATABASE_URL absent'); }
} catch(e) { console.log('[DB] Neon non installé'); }

const app  = express();
const PORT = process.env.PORT || 3001;

const GEMINI_KEY    = process.env.GEMINI_KEY    || '';
const ODDS_API_KEY  = process.env.ODDS_API_KEY  || '';
const APISPORTS_KEY = process.env.APISPORTS_KEY || '';

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
// Pour activer Gemini 3.1 Pro : remplacer par ['gemini-3.1-pro-preview', 'gemini-2.5-flash']

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Accept'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────────────────────
// BASE DE DONNÉES — Neon
// ─────────────────────────────────────────────────────────────
async function savePrediction(match) {
  if (!sql) return null;
  try {
    const rows = await sql(
      'INSERT INTO predictions (sport,home,away,competition,match_date,prediction,confidence,value_edge,units,odds_given) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [match.sport||null, match.home||null, match.away||null, match.competition||null,
       match.match_date||null, match.result||null, match.confidence||null,
       match.value_edge_pct||null, match.units||null, match.odds_given||null]
    );
    return rows[0]?.id || null;
  } catch(err) { console.error('[DB] savePrediction:', err.message); return null; }
}

async function getPerformanceStats() {
  if (!sql) return null;
  try {
    const rows = await sql(
      'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE correct=true) as correct, COUNT(*) FILTER (WHERE correct=false) as incorrect, COUNT(*) FILTER (WHERE correct IS NULL) as pending, ROUND(AVG(confidence)) as avg_confidence, ROUND(COALESCE(SUM(roi_actual),0)::numeric,2) as total_roi, ROUND(COUNT(*) FILTER (WHERE correct=true)::decimal / NULLIF(COUNT(*) FILTER (WHERE correct IS NOT NULL),0)*100,1) as win_rate FROM predictions'
    );
    return rows[0] || null;
  } catch(err) { console.error('[DB] getPerformanceStats:', err.message); return null; }
}

async function updateOutcome(predictionId, actualResult, correct) {
  if (!sql || !predictionId) return;
  try {
    await sql(
      'UPDATE predictions SET result=$1, correct=$2, roi_actual=CASE WHEN $2 THEN (odds_given-1)*units ELSE -units END WHERE id=$3',
      [actualResult, correct, predictionId]
    );
  } catch(err) { console.error('[DB] updateOutcome:', err.message); }
}

// ═══════════════════════════════════════════════════════════
// COUCHE 1 — TABLE D'ALIAS (315+ entrées)
// Certitude 100% pour les équipes/joueurs les plus courants
// ═══════════════════════════════════════════════════════════
const ALIAS_TABLE = {
  // Football Europe
  'psg':{'c':'Paris Saint-Germain','s':'foot'}, 'paris sg':{'c':'Paris Saint-Germain','s':'foot'},
  'paris saint germain':{'c':'Paris Saint-Germain','s':'foot'}, 'paris':{'c':'Paris Saint-Germain','s':'foot'},
  'om':{'c':'Marseille','s':'foot'}, 'marseille':{'c':'Marseille','s':'foot'},
  'olympique marseille':{'c':'Marseille','s':'foot'},
  'ol':{'c':'Olympique Lyonnais','s':'foot'}, 'lyon':{'c':'Olympique Lyonnais','s':'foot'},
  'asm':{'c':'Monaco','s':'foot'}, 'monaco':{'c':'Monaco','s':'foot'},
  'losc':{'c':'Lille','s':'foot'}, 'lille':{'c':'Lille','s':'foot'},
  'rennes':{'c':'Rennes','s':'foot'}, 'lens':{'c':'Lens','s':'foot'},
  'nice':{'c':'Nice','s':'foot'}, 'strasbourg':{'c':'Strasbourg','s':'foot'},
  'nantes':{'c':'Nantes','s':'foot'}, 'asse':{'c':'Saint-Étienne','s':'foot'},
  'arsenal':{'c':'Arsenal','s':'foot'}, 'chelsea':{'c':'Chelsea','s':'foot'},
  'liverpool':{'c':'Liverpool','s':'foot'}, 'man utd':{'c':'Manchester United','s':'foot'},
  'manchester united':{'c':'Manchester United','s':'foot'}, 'mufc':{'c':'Manchester United','s':'foot'},
  'man city':{'c':'Manchester City','s':'foot'}, 'manchester city':{'c':'Manchester City','s':'foot'},
  'spurs':{'c':'Tottenham','s':'foot'}, 'tottenham':{'c':'Tottenham','s':'foot'},
  'newcastle':{'c':'Newcastle','s':'foot'}, 'aston villa':{'c':'Aston Villa','s':'foot'},
  'west ham':{'c':'West Ham','s':'foot'}, 'everton':{'c':'Everton','s':'foot'},
  'brighton':{'c':'Brighton','s':'foot'}, 'wolves':{'c':'Wolverhampton','s':'foot'},
  'leicester':{'c':'Leicester','s':'foot'}, 'nottingham forest':{'c':'Nottingham Forest','s':'foot'},
  'real madrid':{'c':'Real Madrid','s':'foot'}, 'real':{'c':'Real Madrid','s':'foot'},
  'barca':{'c':'Barcelona','s':'foot'}, 'barcelona':{'c':'Barcelona','s':'foot'},
  'atletico':{'c':'Atlético Madrid','s':'foot'}, 'atletico madrid':{'c':'Atlético Madrid','s':'foot'},
  'sevilla':{'c':'Sevilla','s':'foot'}, 'villarreal':{'c':'Villarreal','s':'foot'},
  'real sociedad':{'c':'Real Sociedad','s':'foot'}, 'athletic':{'c':'Athletic Club','s':'foot'},
  'valencia':{'c':'Valencia','s':'foot'}, 'betis':{'c':'Real Betis','s':'foot'},
  'osasuna':{'c':'Osasuna','s':'foot'}, 'girona':{'c':'Girona','s':'foot'},
  'bayern':{'c':'Bayern Munich','s':'foot'}, 'bayern munich':{'c':'Bayern Munich','s':'foot'},
  'dortmund':{'c':'Borussia Dortmund','s':'foot'}, 'bvb':{'c':'Borussia Dortmund','s':'foot'},
  'leverkusen':{'c':'Bayer Leverkusen','s':'foot'}, 'rb leipzig':{'c':'RB Leipzig','s':'foot'},
  'frankfurt':{'c':'Eintracht Frankfurt','s':'foot'}, 'wolfsburg':{'c':'Wolfsburg','s':'foot'},
  'stuttgart':{'c':'Stuttgart','s':'foot'},
  'juventus':{'c':'Juventus','s':'foot'}, 'juve':{'c':'Juventus','s':'foot'},
  'inter':{'c':'Inter Milan','s':'foot'}, 'inter milan':{'c':'Inter Milan','s':'foot'},
  'ac milan':{'c':'AC Milan','s':'foot'}, 'milan':{'c':'AC Milan','s':'foot'},
  'napoli':{'c':'Napoli','s':'foot'}, 'roma':{'c':'AS Roma','s':'foot'},
  'lazio':{'c':'Lazio','s':'foot'}, 'atalanta':{'c':'Atalanta','s':'foot'},
  'fiorentina':{'c':'Fiorentina','s':'foot'},
  'benfica':{'c':'Benfica','s':'foot'}, 'porto':{'c':'Porto','s':'foot'},
  'sporting':{'c':'Sporting CP','s':'foot'}, 'sporting cp':{'c':'Sporting CP','s':'foot'},
  'ajax':{'c':'Ajax','s':'foot'}, 'psv':{'c':'PSV','s':'foot'},
  'feyenoord':{'c':'Feyenoord','s':'foot'},
  // Équipes nationales
  'france':{'c':'France','s':'foot'}, 'les bleus':{'c':'France','s':'foot'},
  'brazil':{'c':'Brazil','s':'foot'}, 'bresil':{'c':'Brazil','s':'foot'},
  'england':{'c':'England','s':'foot'}, 'angleterre':{'c':'England','s':'foot'},
  'spain':{'c':'Spain','s':'foot'}, 'espagne':{'c':'Spain','s':'foot'},
  'germany':{'c':'Germany','s':'foot'}, 'allemagne':{'c':'Germany','s':'foot'},
  'portugal':{'c':'Portugal','s':'foot'}, 'argentina':{'c':'Argentina','s':'foot'},
  'argentine':{'c':'Argentina','s':'foot'}, 'morocco':{'c':'Morocco','s':'foot'},
  'maroc':{'c':'Morocco','s':'foot'}, 'netherlands':{'c':'Netherlands','s':'foot'},
  'pays bas':{'c':'Netherlands','s':'foot'}, 'hollande':{'c':'Netherlands','s':'foot'},
  'belgium':{'c':'Belgium','s':'foot'}, 'belgique':{'c':'Belgium','s':'foot'},
  'italy':{'c':'Italy','s':'foot'}, 'italie':{'c':'Italy','s':'foot'},
  'usa':{'c':'USA','s':'foot'}, 'japan':{'c':'Japan','s':'foot'},
  'south korea':{'c':'South Korea','s':'foot'}, 'mexico':{'c':'Mexico','s':'foot'},
  'senegal':{'c':'Senegal','s':'foot'}, 'nigeria':{'c':'Nigeria','s':'foot'},
  'ghana':{'c':'Ghana','s':'foot'}, 'cameroon':{'c':'Cameroon','s':'foot'},
  'egypt':{'c':'Egypt','s':'foot'}, 'australia':{'c':'Australia','s':'foot'},
  'canada':{'c':'Canada','s':'foot'}, 'saudi arabia':{'c':'Saudi Arabia','s':'foot'},
  'iran':{'c':'Iran','s':'foot'}, 'switzerland':{'c':'Switzerland','s':'foot'},
  'croatia':{'c':'Croatia','s':'foot'}, 'serbia':{'c':'Serbia','s':'foot'},
  // NBA
  'lakers':{'c':'Los Angeles Lakers','s':'basket'}, 'celtics':{'c':'Boston Celtics','s':'basket'},
  'warriors':{'c':'Golden State Warriors','s':'basket'}, 'bulls':{'c':'Chicago Bulls','s':'basket'},
  'heat':{'c':'Miami Heat','s':'basket'}, 'bucks':{'c':'Milwaukee Bucks','s':'basket'},
  'nuggets':{'c':'Denver Nuggets','s':'basket'}, 'suns':{'c':'Phoenix Suns','s':'basket'},
  'nets':{'c':'Brooklyn Nets','s':'basket'}, 'clippers':{'c':'LA Clippers','s':'basket'},
  'knicks':{'c':'New York Knicks','s':'basket'}, 'raptors':{'c':'Toronto Raptors','s':'basket'},
  'sixers':{'c':'Philadelphia 76ers','s':'basket'}, 'hawks':{'c':'Atlanta Hawks','s':'basket'},
  'cavs':{'c':'Cleveland Cavaliers','s':'basket'}, 'mavs':{'c':'Dallas Mavericks','s':'basket'},
  'grizzlies':{'c':'Memphis Grizzlies','s':'basket'}, 'thunder':{'c':'Oklahoma City Thunder','s':'basket'},
  'okc':{'c':'Oklahoma City Thunder','s':'basket'}, 'spurs':{'c':'San Antonio Spurs','s':'basket'},
  'blazers':{'c':'Portland Trail Blazers','s':'basket'}, 'kings':{'c':'Sacramento Kings','s':'basket'},
  'jazz':{'c':'Utah Jazz','s':'basket'}, 'wizards':{'c':'Washington Wizards','s':'basket'},
  'pacers':{'c':'Indiana Pacers','s':'basket'}, 'magic':{'c':'Orlando Magic','s':'basket'},
  'hornets':{'c':'Charlotte Hornets','s':'basket'}, 'pistons':{'c':'Detroit Pistons','s':'basket'},
  'rockets':{'c':'Houston Rockets','s':'basket'}, 'timberwolves':{'c':'Minnesota Timberwolves','s':'basket'},
  // NHL
  'oilers':{'c':'Edmonton Oilers','s':'hockey'}, 'maple leafs':{'c':'Toronto Maple Leafs','s':'hockey'},
  'leafs':{'c':'Toronto Maple Leafs','s':'hockey'}, 'rangers':{'c':'New York Rangers','s':'hockey'},
  'bruins':{'c':'Boston Bruins','s':'hockey'}, 'penguins':{'c':'Pittsburgh Penguins','s':'hockey'},
  'canadiens':{'c':'Montreal Canadiens','s':'hockey'}, 'habs':{'c':'Montreal Canadiens','s':'hockey'},
  'avalanche':{'c':'Colorado Avalanche','s':'hockey'}, 'lightning':{'c':'Tampa Bay Lightning','s':'hockey'},
  'golden knights':{'c':'Vegas Golden Knights','s':'hockey'}, 'flames':{'c':'Calgary Flames','s':'hockey'},
  'canucks':{'c':'Vancouver Canucks','s':'hockey'}, 'capitals':{'c':'Washington Capitals','s':'hockey'},
  'blackhawks':{'c':'Chicago Blackhawks','s':'hockey'}, 'red wings':{'c':'Detroit Red Wings','s':'hockey'},
  'flyers':{'c':'Philadelphia Flyers','s':'hockey'}, 'stars':{'c':'Dallas Stars','s':'hockey'},
  'jets':{'c':'Winnipeg Jets','s':'hockey'}, 'sharks':{'c':'San Jose Sharks','s':'hockey'},
  'ducks':{'c':'Anaheim Ducks','s':'hockey'}, 'kraken':{'c':'Seattle Kraken','s':'hockey'},
  'panthers':{'c':'Florida Panthers','s':'hockey'}, 'hurricanes':{'c':'Carolina Hurricanes','s':'hockey'},
  'blues':{'c':'St. Louis Blues','s':'hockey'}, 'predators':{'c':'Nashville Predators','s':'hockey'},
  'devils':{'c':'New Jersey Devils','s':'hockey'}, 'islanders':{'c':'New York Islanders','s':'hockey'},
  'senators':{'c':'Ottawa Senators','s':'hockey'},
  // Tennis ATP
  'sinner':{'c':'Jannik Sinner','s':'tennis'}, 'jannik sinner':{'c':'Jannik Sinner','s':'tennis'},
  'alcaraz':{'c':'Carlos Alcaraz','s':'tennis'}, 'carlos alcaraz':{'c':'Carlos Alcaraz','s':'tennis'},
  'djokovic':{'c':'Novak Djokovic','s':'tennis'}, 'nole':{'c':'Novak Djokovic','s':'tennis'},
  'zverev':{'c':'Alexander Zverev','s':'tennis'}, 'medvedev':{'c':'Daniil Medvedev','s':'tennis'},
  'rublev':{'c':'Andrey Rublev','s':'tennis'}, 'tsitsipas':{'c':'Stefanos Tsitsipas','s':'tennis'},
  'fritz':{'c':'Taylor Fritz','s':'tennis'}, 'de minaur':{'c':'Alex de Minaur','s':'tennis'},
  'draper':{'c':'Jack Draper','s':'tennis'}, 'hurkacz':{'c':'Hubert Hurkacz','s':'tennis'},
  'ruud':{'c':'Casper Ruud','s':'tennis'}, 'dimitrov':{'c':'Grigor Dimitrov','s':'tennis'},
  'tiafoe':{'c':'Frances Tiafoe','s':'tennis'}, 'musetti':{'c':'Lorenzo Musetti','s':'tennis'},
  'nadal':{'c':'Rafael Nadal','s':'tennis'}, 'rafa':{'c':'Rafael Nadal','s':'tennis'},
  // Tennis WTA
  'swiatek':{'c':'Iga Swiatek','s':'tennis'}, 'iga swiatek':{'c':'Iga Swiatek','s':'tennis'},
  'sabalenka':{'c':'Aryna Sabalenka','s':'tennis'}, 'gauff':{'c':'Coco Gauff','s':'tennis'},
  'rybakina':{'c':'Elena Rybakina','s':'tennis'}, 'jabeur':{'c':'Ons Jabeur','s':'tennis'},
  'osaka':{'c':'Naomi Osaka','s':'tennis'}, 'svitolina':{'c':'Elina Svitolina','s':'tennis'},
  'bencic':{'c':'Belinda Bencic','s':'tennis'}, 'badosa':{'c':'Paula Badosa','s':'tennis'},
  'pegula':{'c':'Jessica Pegula','s':'tennis'}, 'fernandez':{'c':'Leylah Fernandez','s':'tennis'},
  'paolini':{'c':'Jasmine Paolini','s':'tennis'}, 'keys':{'c':'Madison Keys','s':'tennis'},
  'halep':{'c':'Simona Halep','s':'tennis'}, 'kvitova':{'c':'Petra Kvitova','s':'tennis'},
  // MLB
  'yankees':{'c':'New York Yankees','s':'baseball'}, 'new york yankees':{'c':'New York Yankees','s':'baseball'},
  'red sox':{'c':'Boston Red Sox','s':'baseball'}, 'boston red sox':{'c':'Boston Red Sox','s':'baseball'},
  'dodgers':{'c':'Los Angeles Dodgers','s':'baseball'}, 'cubs':{'c':'Chicago Cubs','s':'baseball'},
  'mets':{'c':'New York Mets','s':'baseball'}, 'braves':{'c':'Atlanta Braves','s':'baseball'},
  'astros':{'c':'Houston Astros','s':'baseball'}, 'giants':{'c':'San Francisco Giants','s':'baseball'},
  'phillies':{'c':'Philadelphia Phillies','s':'baseball'}, 'cardinals':{'c':'St. Louis Cardinals','s':'baseball'},
  'padres':{'c':'San Diego Padres','s':'baseball'}, 'mariners':{'c':'Seattle Mariners','s':'baseball'},
  'blue jays':{'c':'Toronto Blue Jays','s':'baseball'}, 'orioles':{'c':'Baltimore Orioles','s':'baseball'},
  'guardians':{'c':'Cleveland Guardians','s':'baseball'}, 'tigers':{'c':'Detroit Tigers','s':'baseball'},
  'rays':{'c':'Tampa Bay Rays','s':'baseball'}, 'twins':{'c':'Minnesota Twins','s':'baseball'},
  'royals':{'c':'Kansas City Royals','s':'baseball'}, 'white sox':{'c':'Chicago White Sox','s':'baseball'},
  'athletics':{'c':'Oakland Athletics','s':'baseball'}, 'angels':{'c':'Los Angeles Angels','s':'baseball'},
  'rangers':{'c':'Texas Rangers','s':'baseball'}, 'rockies':{'c':'Colorado Rockies','s':'baseball'},
  'diamondbacks':{'c':'Arizona Diamondbacks','s':'baseball'}, 'nationals':{'c':'Washington Nationals','s':'baseball'},
  'pirates':{'c':'Pittsburgh Pirates','s':'baseball'}, 'reds':{'c':'Cincinnati Reds','s':'baseball'},
  'brewers':{'c':'Milwaukee Brewers','s':'baseball'}, 'marlins':{'c':'Miami Marlins','s':'baseball'},
  // NFL
  'chiefs':{'c':'Kansas City Chiefs','s':'nfl'}, 'eagles':{'c':'Philadelphia Eagles','s':'nfl'},
  'cowboys':{'c':'Dallas Cowboys','s':'nfl'}, 'patriots':{'c':'New England Patriots','s':'nfl'},
  '49ers':{'c':'San Francisco 49ers','s':'nfl'}, 'ravens':{'c':'Baltimore Ravens','s':'nfl'},
  'packers':{'c':'Green Bay Packers','s':'nfl'}, 'bills':{'c':'Buffalo Bills','s':'nfl'},
  'dolphins':{'c':'Miami Dolphins','s':'nfl'}, 'bengals':{'c':'Cincinnati Bengals','s':'nfl'},
};

// ═══════════════════════════════════════════════════════════
// COUCHE 2 — NORMALISATION & FUZZY MATCHING
// ═══════════════════════════════════════════════════════════
function normalizeToken(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b[a-z]\./g, ' ')
    .replace(/['\-]/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({length:m+1}, (_,i) => [i,...Array(n).fill(0)]);
  for (let j=1;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function extractEntitiesV2(prompt) {
  const normalized = normalizeToken(prompt);
  const stopWords = new Set([
    'vs','versus','contre','match','game','the','and','or','un','une','le','la','les',
    'du','de','des','ce','soir','matin','demain','pour','avec','et','en','ce','tonight',
    'today','tomorrow','odds','bet','cote','analyse','pari','paris','betting','score',
    'result','live','saint','germain'
  ]);
  const words = normalized.split(/\s+/).filter(w => !stopWords.has(w) && w.length >= 2);
  const entities = [];
  const found = new Set();

  // Trigrammes
  for (let i=0; i<=words.length-3; i++) {
    const t = words.slice(i,i+3).join(' ');
    if (ALIAS_TABLE[t] && !found.has(t)) {
      entities.push({...ALIAS_TABLE[t], matched:t, method:'exact', confidence:1.0});
      found.add(t);
    }
  }
  // Bigrammes
  for (let i=0; i<=words.length-2; i++) {
    const b = words.slice(i,i+2).join(' ');
    if (ALIAS_TABLE[b] && !found.has(b) && !entities.some(e => e.matched.includes(b)||b.includes(e.matched))) {
      entities.push({...ALIAS_TABLE[b], matched:b, method:'exact', confidence:1.0});
      found.add(b);
    }
  }
  // Unigrammes
  for (const w of words) {
    if (found.has(w) || stopWords.has(w)) continue;
    const already = entities.some(e => e.matched===w||e.matched.includes(w)||w.includes(e.matched));
    if (!already && ALIAS_TABLE[w]) {
      entities.push({...ALIAS_TABLE[w], matched:w, method:'exact', confidence:1.0});
      found.add(w);
    }
  }
  // Fuzzy fallback
  for (const w of words) {
    if (w.length < 4 || stopWords.has(w)) continue;
    const already = entities.some(e => e.c.toLowerCase().includes(w)||w.includes(e.matched));
    if (!already) {
      const maxDist = w.length<=5?1:w.length<=10?2:3;
      let best=null, bestDist=Infinity;
      for (const [alias, entry] of Object.entries(ALIAS_TABLE)) {
        const d = levenshtein(w, alias);
        if (d < bestDist && d <= maxDist) { bestDist=d; best={...entry,alias,distance:d}; }
      }
      if (best) {
        entities.push({...best, matched:w, method:'fuzzy', confidence:1-best.distance/w.length});
        found.add(w);
      }
    }
  }
  return entities;
}

// ═══════════════════════════════════════════════════════════
// COUCHE 3 — VALIDATION EXTERNE
// TheOddsAPI → API-Sports → ESPN
// La donnée externe valide. Gemini analyse. Jamais l'inverse.
// ═══════════════════════════════════════════════════════════

const DATA_CACHE = {};
function cacheGet(key) {
  const c = DATA_CACHE[key];
  return (c && Date.now()-c.ts < 30*60*1000) ? c.data : null;
}
function cacheSet(key, data) { DATA_CACHE[key] = {data, ts:Date.now()}; }

// Map sport → TheOddsAPI key
const ODDS_SPORT_MAP = {
  'foot':     ['soccer_france_ligue_one','soccer_spain_la_liga','soccer_epl',
               'soccer_germany_bundesliga','soccer_italy_serie_a',
               'soccer_uefa_champs_league','soccer_fifa_world_cup',
               'soccer_brazil_campeonato','soccer_mls','soccer_conmebol_copa_libertadores',
               'soccer_japan_j_league','soccer_korea_kleague1','soccer_south_africa_premier_division'],
  'basket':   ['basketball_nba','basketball_euroleague'],
  'hockey':   ['icehockey_nhl'],
  'nfl':      ['americanfootball_nfl'],
  'baseball': ['baseball_mlb'],
  'mma':      ['mma_mixed_martial_arts'],
  'tennis':   [],
};

async function validateViaOddsAPI(entities, webPageMode) {
  if (!ODDS_API_KEY || !entities.length) return null;
  const sport = entities[0]?.s || 'foot';
  const sportKeys = ODDS_SPORT_MAP[sport] || ODDS_SPORT_MAP['foot'];
  const teamNames = entities.map(e => e.c.toLowerCase());
  const cacheKey = 'odds_' + sport + '_' + (webPageMode ? 'all' : teamNames.slice(0,2).join('_'));
  const cached = cacheGet(cacheKey);
  if (cached) {
    // En mode WEB PAGE, retourner tous les events du cache
    if (webPageMode && cached.allEvents) {
      return { status:'VERIFIED', events: cached.allEvents, source:'TheOddsAPI' };
    }
    return cached;
  }

  const allEvents = [];
  for (const sk of sportKeys.slice(0, 5)) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(
        'https://api.the-odds-api.com/v4/sports/' + sk + '/odds/?apiKey=' + ODDS_API_KEY +
        '&regions=eu,uk,us&markets=h2h&oddsFormat=decimal&bookmakers=bet365,winamax,unibet,draftkings,fanduel',
        { signal: ctrl.signal }
      );
      const remaining = resp.headers.get('x-requests-remaining');
      if (remaining) console.log('[ODDS] Crédits restants: ' + remaining);
      if (resp.status === 422) { console.log('[ODDS] Quota épuisé'); break; }
      if (!resp.ok) continue;
      const events = await resp.json();
      allEvents.push(...(events || []));
    } catch(e) { console.log('[ODDS] Erreur:', e.message); }
  }

  if (allEvents.length === 0) return null;

  // Mode WEB PAGE → retourner TOUS les matchs disponibles
  if (webPageMode) {
    const result = { status:'VERIFIED', events: allEvents, allEvents, source:'TheOddsAPI' };
    cacheSet(cacheKey, result);
    return result;
  }

  // Mode LIST → filtrer par équipes saisies
  const matched = allEvents.filter(ev => {
    const h = ev.home_team.toLowerCase(), a = ev.away_team.toLowerCase();
    return teamNames.some(t =>
      h.includes(t) || a.includes(t) ||
      t.includes(h.split(' ')[0]) || t.includes(a.split(' ')[0])
    );
  });

  if (matched.length > 0) {
    const result = { status:'VERIFIED', events: matched, source:'TheOddsAPI' };
    cacheSet(cacheKey, result);
    return result;
  }
  return null;
}

async function validateViaApiSports(entities) {
  if (!APISPORTS_KEY || !entities.length) return null;
  const sport = entities[0]?.s || 'foot';
  if (sport !== 'foot') return null;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const teamName = entities[0].c;
    const resp = await fetch(
      `https://v3.football.api-sports.io/fixtures?team=${encodeURIComponent(teamName)}&next=5`,
      { signal: ctrl.signal, headers: {'x-rapidapi-key': APISPORTS_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io'} }
    );
    const remaining = resp.headers.get('x-ratelimit-requests-remaining');
    if (remaining) console.log(`[APISPORTS] Requêtes restantes: ${remaining}`);
    if (resp.status === 429) { console.log('[APISPORTS] Quota épuisé'); return null; }
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.response && data.response.length > 0) {
      return { status:'VERIFIED', events: data.response, source:'API-Sports' };
    }
  } catch(e) { console.log('[APISPORTS] Erreur:', e.message); }
  return null;
}

// Orchestrateur de validation — juge unique
async function validateMatch(entities) {
  if (!entities || entities.length === 0) {
    return { status:'NOT_FOUND', reason:'no_entities_recognized' };
  }
  console.log('[VALIDATE] Entités:', entities.map(e=>e.c).join(', '));

  // Si beaucoup d'entités (mode WEB PAGE) → chercher tous les matchs disponibles
  // sans filtrer par équipe spécifique
  const isWebPageMode = entities.length > 3;

  // Étape 1 — TheOddsAPI (juge principal)
  const oddsResult = await validateViaOddsAPI(entities, isWebPageMode).catch(() => null);
  if (oddsResult?.status === 'VERIFIED') {
    console.log('[VALIDATE] ✅ TheOddsAPI confirme', oddsResult.events.length, 'match(es)');
    return oddsResult;
  }

  // Étape 2 — API-Sports (juge secondaire)
  const apiResult = await validateViaApiSports(entities).catch(() => null);
  if (apiResult?.status === 'VERIFIED') {
    console.log('[VALIDATE] ✅ API-Sports confirme le match');
    return apiResult;
  }

  // Étape 3 — Enrichissement ESPN sans blocage
  console.log('[VALIDATE] ⚪ APIs externes sans résultat → ESPN enrichit sans bloquer');
  return { status:'ENRICHMENT_ONLY', reason:'not_in_external_apis', entities };
}

// ═══════════════════════════════════════════════════════════
// SUPERCOACH DATA ENGINE v8.0
// ESPN = enrichissement uniquement (scores, contexte, news)
// ═══════════════════════════════════════════════════════════

const ESPN_SOURCES = {
  foot: [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/kor.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/scoreboard',
  ],
  basket: [
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
  ],
  hockey: ['https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'],
  baseball: ['https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],
  nfl: ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'],
  tennis: ['https://site.api.espn.com/apis/site/v2/sports/tennis/scoreboard'],
  mma: ['https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard'],
};

const CACHE = {};
function fromCache(key) {
  const c = CACHE[key];
  return (c && Date.now()-c.ts < 5*60*1000) ? c.data : null;
}
function toCache(key, data) { CACHE[key] = {data, ts:Date.now()}; }

async function fetchESPNSource(url) {
  const cached = fromCache(url);
  if (cached) return cached;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const events = j.events || [];
    const lines = events.map(e => {
      const c = e.competitions?.[0];
      const t = c?.competitors || [];
      const names = t.map(x => x.team?.displayName||'').filter(Boolean);
      const scores = t.map(x => x.score||'').filter(Boolean);
      const date = e.date ? new Date(e.date).toLocaleString() : '';
      const status = c?.status?.type?.description || '';
      return `${names.join(' vs ')} | ${scores.join('-')} | ${status} | ${date}`;
    }).filter(l => l.trim() !== ' |  |  | ');
    toCache(url, lines);
    return lines;
  } catch(e) { return []; }
}

async function fetchAllESPN(sportIds) {
  const urls = [];
  sportIds.forEach(s => { (ESPN_SOURCES[s]||[]).forEach(u => urls.push(u)); });
  if (!urls.length) Object.values(ESPN_SOURCES).forEach(arr => arr.slice(0,2).forEach(u => urls.push(u)));
  const results = await Promise.allSettled(urls.map(u => fetchESPNSource(u)));
  return results.flatMap(r => r.status==='fulfilled' ? r.value : []);
}

function detectSportIds(prompt) {
  const p = prompt.toLowerCase();
  const ids = [];
  if (/\b(football|foot|soccer|liga|premier|bundesliga|ligue|serie|champions|world cup|copa|mls|j-league|k-league)\b/.test(p)) ids.push('foot');
  if (/\b(basket|basketball|nba|euroleague|wnba|ncaa)\b/.test(p)) ids.push('basket');
  if (/\b(hockey|nhl|ice hockey|stanley)\b/.test(p)) ids.push('hockey');
  if (/\b(baseball|mlb|run line|nrfi)\b/.test(p)) ids.push('baseball');
  if (/\b(tennis|atp|wta|roland|wimbledon|open)\b/.test(p)) ids.push('tennis');
  if (/\b(nfl|football americain|american football|super bowl)\b/.test(p)) ids.push('nfl');
  if (/\b(mma|ufc|cage)\b/.test(p)) ids.push('mma');
  if (/\b(rugby|six nations|top 14)\b/.test(p)) ids.push('rugby');
  return ids.length > 0 ? ids : ['foot','basket','baseball','hockey'];
}

function filterAndPrioritize(lines, prompt) {
  if (!lines.length) return [];
  const p = normalizeToken(prompt);
  const words = p.split(/\s+/).filter(w => w.length >= 3);
  return lines.filter(l => words.some(w => normalizeToken(l).includes(w)));
}

function getRealTimeBlock() {
  const now = new Date();
  return '\n\u2501\u2501\u2501 REAL-TIME ANCHOR \u2501\u2501\u2501\n' +
    'TODAY : ' + now.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) + '\n' +
    'TIME  : ' + now.toLocaleTimeString('en-US') + '\n' +
    'RULE  : Only analyze UPCOMING or LIVE events. Refuse analysis of past events.\n\n';
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR JSON_VALIDATED_DATA v4
// Source externe = vérité. ESPN = enrichissement. Gemini = analyse.
// ═══════════════════════════════════════════════════════════
function buildValidatedDataV4(entities, validation, espnLines, prompt) {
  let block = '\n\u2501\u2501\u2501 JSON_VALIDATED_DATA v4 \u2501\u2501\u2501\n';
  block += 'paradigm: External API validates. Gemini analyzes. Never the reverse.\n';
  block += 'validation_status: ' + validation.status + '\n';

  // Entités reconnues
  if (entities.length > 0) {
    block += '\n[RECOGNIZED_ENTITIES]\n';
    entities.forEach(e => { block += '  ' + e.c + ' (sport:' + e.s + ', method:' + e.method + ')\n'; });
  }

  // Données validées par TheOddsAPI ou API-Sports
  if (validation.status === 'VERIFIED' && validation.events) {
    block += '\n[VERIFIED_MATCH_DATA — ' + validation.source + ']\n';
    if (validation.source === 'TheOddsAPI') {
      validation.events.slice(0,3).forEach(ev => {
        block += '  Match: ' + ev.home_team + ' vs ' + ev.away_team + '\n';
        block += '  Date: ' + new Date(ev.commence_time).toLocaleString() + '\n';
        block += '  Competition: ' + ev.sport_title + '\n';
        (ev.bookmakers||[]).slice(0,3).forEach(bk => {
          const h2h = bk.markets?.find(m=>m.key==='h2h');
          if (h2h) {
            const o = h2h.outcomes;
            block += '  ' + bk.title + ': ' + (o[0]?.name||'') + ' ' + (o[0]?.price||'') +
                     ' / ' + (o[1]?.name||'') + ' ' + (o[1]?.price||'') +
                     (o[2] ? ' / Draw ' + o[2].price : '') + '\n';
          }
        });
      });
      block += 'INSTRUCTION: Match confirmed by TheOddsAPI. Use above odds for value_edge calculation ONLY.\n';
    } else {
      block += '  Match confirmed by API-Sports.\n';
    }
  } else if (validation.status === 'ENRICHMENT_ONLY') {
    block += '\n[EXTERNAL_VALIDATION]\n';
    block += 'Match not found in TheOddsAPI or API-Sports.\n';
    block += 'Analyze using your knowledge IF the match is plausible (sport in season, teams exist).\n';
    block += 'If match is genuinely impossible (season ended, teams wrong) → return NOT_FOUND.\n';
    block += 'Set match_date_uncertain:true if date cannot be confirmed.\n';
  }

  // ESPN — enrichissement contextuel
  const espnFiltered = filterAndPrioritize(espnLines, prompt);
  if (espnFiltered.length > 0) {
    block += '\n[ESPN_CONTEXT — enrichissement]\n';
    block += espnFiltered.slice(0,8).join('\n') + '\n';
  }

  block += '\n---\n';
  block += 'GOLDEN RULES:\n';
  block += '1. Cotes ci-dessus = INPUT pour value_edge UNIQUEMENT. Jamais guide de prediction.\n';
  block += '2. Zero invention. Si match inexistant → {"matches":[],"summary":"Match not found."}\n';
  block += '3. Ta prediction vient de H2H + Forme + Contexte + Blessés. Pas des cotes.\n\n';

  return block;
}

// ═══════════════════════════════════════════════════════════
// SYSTEM PROMPT — EXPERT ANALYSE SPORTIVE
// ═══════════════════════════════════════════════════════════
function getSystemPrompt() {
  return [
    '\u2501\u2501\u2501 SUPERCOACH ELITE ANALYST \u2501\u2501\u2501',
    '',
    'You are SUPERCOACH, an elite sports analyst. Your predictions come from YOUR analysis, not from odds.',
    '',
    'ANALYSIS HIERARCHY (mandatory order):',
    '1. H2H — 2+ recent meetings = strongest signal. Same surface/competition preferred.',
    '2. RECENT FORM — last 5 matches each side. 3+ wins in a row = momentum +10%.',
    '3. MATCH CONTEXT — derby (reduce form weight 50%), relegation (+15% motivation),',
    '   title race, cup final, rotation risk (3 games in 7 days).',
    '4. INJURIES — GK absent: -10%. Top scorer absent: -8%. Captain: -5%.',
    '5. HOME/AWAY — home wins ~47% EU leagues. Travel >4h = fatigue -5%.',
    '6. ODDS — INPUT ONLY. value_edge = (confidence% - 1/decimal_odds*100).',
    '',
    'SPORTS EXPERTISE:',
    'Football: Form L5, H2H, motivation, referee. Formats: Pronosoft, Parions Sport, bet365, Winamax.',
    'Basketball: Back-to-back fatigue (-15%), star player impact, pace. FanDuel/DraftKings formats.',
    'Baseball MLB: Starting pitcher ERA/WHIP, bullpen load, park factor, batting average vs pitcher.',
    '  Sub-bets: NRFI, Run Line -1.5, Over/Under runs, First 5 innings.',
    'Tennis: Surface H2H mandatory, tournament fatigue, serve%, break points. Format: E.Sinner -> Sinner.',
    'Hockey NHL: Goalie form, PP%, PK%, back-to-back. Puck line -1.5.',
    'All other sports: apply same data-driven logic.',
    '',
    'MANDATORY OUTPUT FORMAT — JSON ONLY:',
    '{"matches":[{"rank":1,"sport":"Football","sport_id":"foot","home":"Team A","away":"Team B",',
    '"competition":"League","match_date":"DD/MM/YYYY","match_time":"HH:MM",',
    '"match_date_uncertain":false,"result":"WIN_HOME","confidence":75,',
    '"odds_given":1.85,"value_edge_pct":2.5,"value":"light",',
    '"value_text":"Conf 75% vs prob 72.5% -> edge +2.5%",',
    '"units":2,"rotation_alert":false,"rotation_text":"",',
    '"justification":"2 sentences. Each factor with +X%/-X% impact.",',
    '"sub_bets":["Over 2.5 goals","Both teams score"]}],',
    '"summary":"One key insight.","roi_potential":"Est. ROI: +X%"}',
    '',
    'result: WIN_HOME | WIN_AWAY | DRAW',
    'sport_id: foot|basket|tennis|rugby|mma|boxing|hockey|handball|volley|f1|baseball|nfl|other',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── /analyze ────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  const analyzeTimeout = setTimeout(() => {
    if (!res.headersSent) res.status(503).json({ error: 'Timeout — réessaie.' });
  }, 120000);

  try {
    const { prompt } = req.body;
    if (!prompt) { clearTimeout(analyzeTimeout); return res.status(400).json({ error: 'Prompt manquant' }); }
    if (!GEMINI_KEY) { clearTimeout(analyzeTimeout); return res.status(500).json({ error: 'GEMINI_KEY manquante' }); }

    const T0 = Date.now();

    // 1. Extraction des entités
    const entities = extractEntitiesV2(prompt);
    console.log('[ANALYZE] Entités:', entities.map(e=>e.c).join(', ')||'aucune');

    // 2. Détection sport
    const sportIds = detectSportIds(prompt);
    if (entities.length > 0 && entities[0].s) {
      if (!sportIds.includes(entities[0].s)) sportIds.unshift(entities[0].s);
    }

    // 3. Validation externe + ESPN en parallèle
    const [validation, espnLines] = await Promise.all([
      validateMatch(entities).catch(() => ({status:'ENRICHMENT_ONLY',entities})),
      fetchAllESPN(sportIds).catch(() => []),
    ]);
    const T1 = Date.now();

    // 4. Conteneur de vérité v4
    const container = buildValidatedDataV4(entities, validation, espnLines, prompt);

    // 5. Appel Gemini
    const systemPrompt = getSystemPrompt();
    const timeBlock = getRealTimeBlock();
    const enrichedPrompt = timeBlock + container + prompt;

    let text = '';
    let usedModel = '';

    for (const model of MODELS) {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 90000);
        const gResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            signal: ctrl.signal,
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: enrichedPrompt }] }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 16384,
                thinkingConfig: { thinkingBudget: 1024 }
              }
            })
          }
        );
        if (!gResp.ok) {
          const err = await gResp.json().catch(()=>({}));
          if (gResp.status === 429) throw new Error('QUOTA_EXCEEDED');
          throw new Error(err.error?.message || 'Gemini error ' + gResp.status);
        }
        const gData = await gResp.json();
        text = gData.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('') || '';
        usedModel = model;
        break;
      } catch(e) {
        console.log(`[GEMINI] ${model} échoué:`, e.message);
        if (e.message === 'QUOTA_EXCEEDED' && model === MODELS[MODELS.length-1]) {
          clearTimeout(analyzeTimeout);
          return res.status(429).json({ error: 'Quota Gemini dépassé. Réessaie dans 1 minute.' });
        }
      }
    }

    if (!text) { clearTimeout(analyzeTimeout); return res.status(500).json({ error: 'Gemini sans réponse' }); }

    const T2 = Date.now();
    const tokens = Math.round(enrichedPrompt.length / 4);

    // 6. Sauvegarder dans Neon
    const db_ids = [];
    if (sql) {
      try {
        const parsed = JSON.parse(text.replace(/```json/gi,'').replace(/```/g,'').trim());
        if (parsed.matches?.length > 0) {
          for (const m of parsed.matches) {
            const id = await savePrediction(m).catch(()=>null);
            db_ids.push(id||null);
          }
        }
      } catch(e) {}
    }

    clearTimeout(analyzeTimeout);
    res.json({
      result: text,
      db_ids,
      meta: {
        timing: {
          total_ms:          T2-T0,
          fetch_ms:          T1-T0,
          gemini_ms:         T2-T1,
          prompt_tokens_est: tokens,
        },
        model:             usedModel,
        validation_status: validation.status,
        validation_source: validation.source || 'none',
        entities:          entities.map(e=>e.c),
      }
    });

  } catch(err) {
    console.error('[ANALYZE] Erreur:', err.message);
    clearTimeout(analyzeTimeout);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── /scrape — Pipeline A+D ────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:','https:'].includes(parsedUrl.protocol)) return res.status(400).json({ error: 'URL invalide' });
  } catch { return res.status(400).json({ error: 'URL invalide' }); }

  console.log('[SCRAPE] Pipeline A+D →', parsedUrl.hostname);
  let fetchedContent = null;

  // Étape A — fetch direct
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.fr/',
        'Upgrade-Insecure-Requests': '1',
      }
    });
    if (resp.ok) {
      const html = await resp.text();
      const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
        .replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<footer[\s\S]*?<\/footer>/gi,'')
        .replace(/<header[\s\S]*?<\/header>/gi,'').replace(/<[^>]+>/g,' ')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
        .replace(/\s{3,}/g,'\n').trim();
      if (clean.length > 200) {
        fetchedContent = clean.length > 10000 ? clean.slice(0,10000)+'\n[truncated]' : clean;
        console.log('[SCRAPE] ✅ Étape A —', fetchedContent.length, 'chars');
      }
    }
  } catch(e) { console.log('[SCRAPE] Étape A:', e.name==='AbortError'?'timeout':e.message); }

  // Étape B — Gemini grounding
  if (!fetchedContent && GEMINI_KEY) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 20000);
      const gResp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY,
        {
          method: 'POST', signal: ctrl.signal,
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            contents: [{ role:'user', parts:[{ text:
              'Visit this URL and extract ALL sports matches, odds, teams, dates found: ' + url +
              '\nReturn a structured list. If inaccessible, return: BLOCKED\nRespond in the page language.'
            }]}],
            tools: [{ google_search: {} }],
            generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
          })
        }
      );
      if (gResp.ok) {
        const d = await gResp.json();
        const t = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (t && t !== 'BLOCKED' && t.length > 50) {
          fetchedContent = '[SOURCE: ' + parsedUrl.hostname + ' via Gemini]\n' + t;
          console.log('[SCRAPE] ✅ Étape B —', fetchedContent.length, 'chars');
        }
      }
    } catch(e) { console.log('[SCRAPE] Étape B:', e.message); }
  }

  if (fetchedContent) {
    return res.json({ success:true, hostname:parsedUrl.hostname, content:fetchedContent, chars:fetchedContent.length });
  }
  res.json({ success:false, blocked:true, hostname:parsedUrl.hostname, message:'Site inaccessible — colle le texte manuellement' });
});

// ── /stats ────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  const stats = await getPerformanceStats();
  if (!stats) return res.json({ error: 'DB non connectée' });
  res.json({
    total:          parseInt(stats.total),
    correct:        parseInt(stats.correct),
    incorrect:      parseInt(stats.incorrect),
    pending:        parseInt(stats.pending),
    win_rate:       parseFloat(stats.win_rate) || 0,
    avg_confidence: parseInt(stats.avg_confidence) || 0,
    total_roi:      parseFloat(stats.total_roi) || 0,
  });
});

// ── /outcome ──────────────────────────────────────────────────
app.post('/outcome', async (req, res) => {
  const { id, result, correct } = req.body;
  if (!id || result === undefined || correct === undefined) return res.status(400).json({ error: 'id, result, correct requis' });
  await updateOutcome(id, result, correct);
  res.json({ success: true });
});

// ── /health ───────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const results = {};
  for (const model of MODELS) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        { method:'POST', signal:ctrl.signal, headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ contents:[{role:'user',parts:[{text:'ok'}]}], generationConfig:{maxOutputTokens:5,thinkingConfig:{thinkingBudget:0}} }) }
      );
      results[model] = r.ok ? '✅ OK' : '❌ ' + r.status;
    } catch(e) { results[model] = '❌ ' + e.message; }
  }
  res.json({
    status: 'SUPERCOACH API v8.0',
    paradigm: 'External API validates. Gemini analyzes.',
    gemini: results,
    odds_api: ODDS_API_KEY ? '✅ configurée' : '❌ manquante',
    apisports: APISPORTS_KEY ? '✅ configurée' : '❌ manquante',
    neon: sql ? '✅ connectée' : '❌ non connectée',
  });
});

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('SUPERCOACH API v8.0 — port ' + PORT);
  console.log('Paradigm: External API validates. Gemini analyzes.');
  setTimeout(() => {
    fetchAllESPN(['foot','basket','baseball']).then(() => console.log('[WARMUP] Cache ESPN prêt'));
    if (GEMINI_KEY) {
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({contents:[{role:'user',parts:[{text:'ok'}]}], generationConfig:{maxOutputTokens:5,thinkingConfig:{thinkingBudget:0}}}) }
      ).then(r => console.log('[WARMUP] Gemini:', r.ok?'✅ OK':'❌ '+r.status)).catch(()=>{});
    }
  }, 3000);
});
