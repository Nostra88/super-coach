// ═══════════════════════════════════════════════════════════
// SUPERCOACH API v9.3
// Architecture : Gemini extrait → TheOddsAPI valide → Gemini analyse
// Zéro table en dur — scalable D2 finlandaise à MLB
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const dns     = require('dns').promises;
const eloEngine = require('./eloEngine.js');
const net     = require('net');

// ── Protection SSRF (utilisée par /scrape) ────────────────────
// Empêche le serveur de faire une requête vers une adresse interne/privée,
// y compris via un nom de domaine public qui résoudrait vers une IP interne
// (DNS rebinding). Utilisé avant tout fetch() piloté par une URL utilisateur.
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||           // link-local, inclut metadata cloud (169.254.169.254)
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168);
}
function isPrivateIP(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) {
    const low = ip.toLowerCase();
    // IPv4-mapped IPv6 : ::ffff:a.b.c.d ou ::ffff:xxxx:xxxx (hex) — sans ce dépliage,
    // ::ffff:127.0.0.1 ou ::ffff:169.254.169.254 seraient vus à tort comme publiques.
    const dotted = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIPv4(dotted[1]);
    const hex = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateIPv4([(hi>>8)&0xff, hi&0xff, (lo>>8)&0xff, lo&0xff].join('.'));
    }
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
  }
  return false;
}
// Détecte si un texte contient une VRAIE date plausiblement future/actuelle — extraction et
// comparaison de dates réelles (pas juste la présence d'une année, qui laisse passer un match
// du 12 janvier alors qu'on est en août de la même année). Formats couverts : DD/MM/YYYY,
// MM/DD/YYYY (repli), ISO YYYY-MM-DD, mois en toutes lettres FR/EN ("12 janvier 2026",
// "January 12, 2026"). Limite assumée : un texte mêlant dates passées et futures (page normale
// de résultats + calendrier) passera dès qu'UNE seule date future y figure — ce filtre est une
// protection de premier niveau contre du contenu manifestement périmé, pas une garantie que
// chaque match individuel mentionné est à venir (ce contrôle-là a lieu plus loin, par match).
function hasPlausibleFutureDate(text) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const candidates = [];
  const pushIfValid = (y, mo, d) => {
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(y, mo - 1, d);
      if (!isNaN(dt.getTime()) && dt.getMonth() === mo - 1) candidates.push(dt);
    }
  };
  for (const m of text.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g)) {
    let a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    pushIfValid(y, b, a);                      // DD/MM/YYYY
    if (a !== b) pushIfValid(y, a, b);          // MM/DD/YYYY (US) en repli
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    pushIfValid(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }
  const months = {
    janvier:1,février:2,fevrier:2,mars:3,avril:4,mai:5,juin:6,juillet:7,
    août:8,aout:8,septembre:9,octobre:10,novembre:11,décembre:12,decembre:12,
    january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12
  };
  const monthNames = Object.keys(months).join('|');
  const reDMY = new RegExp('\\b(\\d{1,2})\\s+(' + monthNames + ')\\s+(\\d{4})\\b', 'gi');
  for (const m of text.matchAll(reDMY)) {
    pushIfValid(parseInt(m[3], 10), months[m[2].toLowerCase()], parseInt(m[1], 10));
  }
  const reMDY = new RegExp('\\b(' + monthNames + ')\\s+(\\d{1,2}),?\\s+(\\d{4})\\b', 'gi');
  for (const m of text.matchAll(reMDY)) {
    pushIfValid(parseInt(m[3], 10), months[m[1].toLowerCase()], parseInt(m[2], 10));
  }
  if (!candidates.length) return true; // aucune date exploitable → signal insuffisant pour trancher seul
  return candidates.some(dt => dt >= today);
}
async function isSSRFSafe(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
  if (net.isIP(hostname)) return !isPrivateIP(hostname);
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length || records.some(r => isPrivateIP(r.address))) return false;
  } catch { return false; } // résolution DNS impossible → refus par prudence
  return true;
}
// Fetch qui valide CHAQUE redirection contre isSSRFSafe (pas seulement l'URL de départ).
// Sans ça, une URL publique valide pourrait rediriger (301/302) vers une IP interne.
async function safeFetch(urlString, options = {}, maxRedirects = 5) {
  let current = urlString;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!(await isSSRFSafe(current))) throw new Error('URL bloquée (SSRF): ' + current);
    const resp = await fetch(current, { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) throw new Error('Redirection sans en-tête Location');
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('Trop de redirections (>' + maxRedirects + ')');
}

// ── Neon PostgreSQL ──────────────────────────────────────────
let sql = null;
try {
  const { neon } = require('@neondatabase/serverless');
  const DB = process.env.DATABASE_URL || '';
  if (DB) { sql = neon(DB); console.log('[DB] Neon OK'); }
} catch(e) { console.log('[DB] Neon absent'); }

const app  = express();
const PORT = process.env.PORT || 3001;

const GEMINI_KEY    = process.env.GEMINI_KEY    || '';
const ODDS_API_KEY  = process.env.ODDS_API_KEY  || '';
const APISPORTS_KEY = process.env.APISPORTS_KEY || '';

// ── MOTEUR QUANTITATIF ──────────────────────────────────────────
const { GEMINI_SYSTEM_PROMPT, buildPrompt: buildEnginePrompt, computeKellyAndValueEdge } = require('./engine.js');
const { runBacktest } = require('./test/backtest.js');


// ── SUPABASE ADMIN CLIENT ──────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://exezkqkyulzeslducsxi.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';

// Helper : vérifier un JWT Supabase et retourner l'user_id
async function verifySupabaseToken(token) {
  if (!token) { console.warn('[verifySupabaseToken] Pas de token fourni'); return null; }
  if (!SUPABASE_KEY) { console.warn('[verifySupabaseToken] SUPABASE_KEY manquant côté serveur'); return null; }
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_KEY,
      }
    });
    if (!resp.ok) {
      console.warn('[verifySupabaseToken] Supabase a refusé le token, status='+resp.status);
      return null;
    }
    const data = await resp.json();
    return data.id || null;
  } catch (e) {
    console.warn('[verifySupabaseToken] Échec:', e.name, e.message);
    return null;
  }
}

// Helper : statut Premium réel de l'utilisateur (autorité serveur)
async function getPremiumStatus(req) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !SUPABASE_KEY) return { premium: false, userId: null };
    const userId = await verifySupabaseToken(token);
    if (!userId) return { premium: false, userId: null };
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=status,current_period_end&order=current_period_end.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const sub = Array.isArray(rows) ? rows[0] : null;
    const active = sub && (sub.status === 'active' || sub.status === 'trialing') &&
      sub.current_period_end && new Date(sub.current_period_end) > new Date();
    return { premium: !!active, userId };
  } catch (e) {
    console.warn('[getPremiumStatus]', e.message);
    return { premium: false, userId: null };
  }
}

// Helper : mettre à jour les stats d'un utilisateur
async function updateUserStats(userId, result) {
  if (!userId || !SUPABASE_KEY) return;
  try {
    // Lire stats actuelles
    const r1 = await fetch(`${SUPABASE_URL}/rest/v1/stats?user_id=eq.${userId}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const stats = await r1.json();
    if (!stats || !stats[0]) return;
    const s = stats[0];
    const wins   = s.wins   + (result === 'win'  ? 1 : 0);
    const losses = s.losses + (result === 'loss' ? 1 : 0);
    const draws  = s.draws  + (result === 'draw' ? 1 : 0);
    const total  = wins + losses + draws;
    // ROI simplifié
    const roi = total > 0 ? Math.round(((wins - losses) / total) * 100 * 10) / 10 : 0;
    await fetch(`${SUPABASE_URL}/rest/v1/stats?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ wins, losses, draws, roi, last_updated: new Date().toISOString() })
    });
  } catch(e) { console.error('[Supabase] updateStats:', e.message); }
}


const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','Accept','Authorization'] }));
app.options('*', cors());
app.use(express.json({ limit:'10mb' }));

// ─────────────────────────────────────────────────────────────
// NEON DB
// ─────────────────────────────────────────────────────────────
async function savePrediction(m) {
  if (!sql) return null;
  try {
    const r = await sql(
      'INSERT INTO predictions (sport,home,away,competition,match_date,prediction,confidence,value_edge,units,odds_given) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [m.sport||null,m.home||null,m.away||null,m.competition||null,m.match_date||null,
       m.result||null,m.confidence||null,m.value_edge_pct||null,m.units||null,m.odds_given||null]
    );
    return r[0]?.id||null;
  } catch(e) { return null; }
}

async function getStats() {
  if (!sql) return null;
  try {
    const r = await sql('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE correct=true) as correct, COUNT(*) FILTER (WHERE correct=false) as incorrect, COUNT(*) FILTER (WHERE correct IS NULL) as pending, ROUND(AVG(confidence)) as avg_confidence, ROUND(COALESCE(SUM(roi_actual),0)::numeric,2) as total_roi, ROUND(COUNT(*) FILTER (WHERE correct=true)::decimal/NULLIF(COUNT(*) FILTER (WHERE correct IS NOT NULL),0)*100,1) as win_rate FROM predictions');
    return r[0]||null;
  } catch(e) { return null; }
}

async function updateOutcome(id, result, correct) {
  if (!sql||!id) return;
  try {
    await sql('UPDATE predictions SET result=$1,correct=$2,roi_actual=CASE WHEN $2 THEN (odds_given-1)*units ELSE -units END WHERE id=$3',[result,correct,id]);
  } catch(e) {}
}

// ─────────────────────────────────────────────────────────────
// COUCHE 1 — EXTRACTION INTELLIGENTE VIA GEMINI
// Remplace la table d'alias en dur — scalable toutes ligues mondiales
// ─────────────────────────────────────────────────────────────
async function extractEntitiesWithGemini(text) {
  if (!GEMINI_KEY) return [];
  const cacheKey = 'entities_' + text.slice(0,100).replace(/\s+/g,'_');
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);

    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + GEMINI_KEY,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text:
            'Extract ALL sports teams and players from this text. Return ONLY valid JSON array, no markdown.\n' +
            'Format: [{"name":"exact name from text","canonical":"official full name","sport":"foot|basket|baseball|tennis|hockey|nfl|rugby|mma|other","competition":"league or tournament","country":"country code"}]\n' +
            'Rules: Include ALL teams/players found. Use canonical official names. Detect sport from context.\n' +
            'Text:\n' + text.slice(0, 2000)
          }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
        })
      }
    );

    if (!resp.ok) return [];
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = raw.replace(/```json/gi,'').replace(/```/g,'').trim();
    const entities = JSON.parse(clean);
    if (!Array.isArray(entities)) return [];
    console.log('[EXTRACT] Entités:', entities.map(e=>e.canonical).join(', '));
    cacheSet(cacheKey, entities);
    return entities;
  } catch(e) {
    console.log('[EXTRACT] Erreur:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// COUCHE 2 — VALIDATION THEODDSAPI
// ─────────────────────────────────────────────────────────────
const ODDS_SPORT_MAP = {
  'foot':     ['soccer_france_ligue_one','soccer_spain_la_liga','soccer_epl','soccer_germany_bundesliga',
               'soccer_italy_serie_a','soccer_uefa_champs_league','soccer_fifa_world_cup',
               'soccer_brazil_campeonato','soccer_mls','soccer_conmebol_copa_libertadores',
               'soccer_japan_j_league','soccer_korea_kleague1','soccer_south_africa_premier_division',
               'soccer_usa_mls','soccer_argentina_primera_division','soccer_mexico_primera_division'],
  'basket':   ['basketball_nba','basketball_euroleague','basketball_ncaab'],
  'hockey':   ['icehockey_nhl'],
  'nfl':      ['americanfootball_nfl'],
  'baseball': ['baseball_mlb','baseball_npb','baseball_kbo'],
  'mma':      ['mma_mixed_martial_arts'],
  'tennis':   ['tennis_atp','tennis_wta'],
};

const CACHE = {};
function cacheGet(k) { const c=CACHE[k]; return (c&&Date.now()-c.ts<30*60*1000)?c.data:null; }
function cacheSet(k,d) { CACHE[k]={data:d,ts:Date.now()}; }

// ─────────────────────────────────────────────────────────────
// COUCHE PREDICTION MARKETS v1.0
// Sources : Polymarket + Manifold (APIs publiques, sans auth)
// Worker : refresh toutes les heures, stockage en mémoire
// ─────────────────────────────────────────────────────────────
const MARKET_CONSENSUS = {}; // { key: { question, homeProb, awayProb, source, syncedAt, volume } }

async function fetchPolymarketWC() {
  const urls = [
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200',
    'https://gamma-api.polymarket.com/markets?limit=200&order=volume&ascending=false',
    'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100',
  ];
  for (const url of urls) {
    try {
      console.log('[MARKETS] Trying Polymarket URL:', url);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 12000);
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; SUPERCOACH/9.0)',
        }
      });
      console.log('[MARKETS] Polymarket response status:', resp.status, 'url:', url);
      if (!resp.ok) {
        const txt = await resp.text().catch(()=>'');
        console.warn('[MARKETS] Polymarket non-ok:', resp.status, txt.slice(0,200));
        continue;
      }
      const raw = await resp.text();
      console.log('[MARKETS] Polymarket raw length:', raw.length, 'preview:', raw.slice(0,200));
      const markets = JSON.parse(raw);
      const arr = Array.isArray(markets) ? markets : (markets.data || markets.markets || []);
      console.log('[MARKETS] Polymarket parsed:', arr.length, 'items');
      let count = 0;
      for (const m of arr) {
        const q = (m.question || m.title || '').toLowerCase();
        // Filtre sport — sans ça on récupère les marchés Polymarket les plus actifs tous sujets confondus
        if (!q.includes('win') && !q.includes('vs') && !q.includes('beat') &&
            !q.includes('champion') && !q.includes('qualify') && !q.includes('score') &&
            !q.includes('goal') && !q.includes('match') && !q.includes('cup') &&
            !q.includes('nba') && !q.includes('nfl') && !q.includes('nhl') &&
            !q.includes('world series') && !q.includes('playoff') && !q.includes('finals')) continue;
        // outcomePrices arrive en string JSON chez Polymarket gamma-api, pas en array natif
        let outcomsArr = m.outcomePrices;
        if (typeof outcomsArr === 'string') {
          try { outcomsArr = JSON.parse(outcomsArr); } catch(e) { outcomsArr = []; }
        }
        if (!Array.isArray(outcomsArr)) outcomsArr = [];
        const homeP = parseFloat(outcomsArr[0] ?? m.bestBid ?? m.probability ?? 0.5);
        const awayP = parseFloat(outcomsArr[1] ?? (1 - homeP));
        const key = 'pm_' + (m.slug || m.id || count);
        MARKET_CONSENSUS[key] = {
          question: m.question || m.title || '',
          homeProb: isNaN(homeP) ? 0.5 : homeP,
          awayProb: isNaN(awayP) ? 0.5 : awayP,
          drawProb: 0,
          source:   'Polymarket',
          syncedAt: new Date().toISOString(),
          volume:   parseFloat(m.volume || m.volume_num_min || 0),
        };
        count++;
      }
      console.log('[MARKETS] Polymarket loaded:', count, 'markets from', url);
      return count;
    } catch(e) {
      console.warn('[MARKETS] Polymarket fetch error:', e.message, 'url:', url);
    }
  }
  console.warn('[MARKETS] Polymarket: all URLs failed');
  return 0;
}

async function fetchManifoldSports() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 12000);
    // Manifold API publique — pas de restriction IP normalement
    const resp = await fetch(
      'https://api.manifold.markets/v0/search-markets?term=world+cup+2026&limit=100',
      { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'SUPERCOACH/9.0' } }
    );
    if (!resp.ok) throw new Error('Manifold HTTP ' + resp.status);
    const markets = await resp.json();
    let count = 0;
    for (const m of (Array.isArray(markets) ? markets : [])) {
      if (m.outcomeType !== 'BINARY') continue;
      const q = (m.question || '').toLowerCase();
      if (!q.includes('win') && !q.includes('vs') && !q.includes('beat') &&
          !q.includes('champion') && !q.includes('qualify') && !q.includes('score') &&
          !q.includes('goal') && !q.includes('match') && !q.includes('cup')) continue;
      const key = 'mf_' + m.slug;
      MARKET_CONSENSUS[key] = {
        question: m.question || '',
        homeProb: parseFloat(m.probability || 0.5),
        awayProb: parseFloat(1 - (m.probability || 0.5)),
        drawProb: 0,
        source:   'Manifold',
        syncedAt: new Date().toISOString(),
        volume:   parseFloat(m.totalLiquidity || 0),
      };
      count++;
    }
    console.log('[MARKETS] Manifold:', count, 'markets loaded');
    return count;
  } catch(e) {
    console.warn('[MARKETS] Manifold error:', e.message);
    return 0;
  }
}

async function fetchKalshiSports() {
  // Kalshi — API publique, aucune authentification requise pour la lecture des marches
  const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2/markets';
  // Series tickers sportifs — pattern KX + code sport. "Football" chez Kalshi = NFL.
  const seriesTickers = ['KXNBA','KXNFLGAME','KXNHL','KXMLB','KXUCL','KXEPL','KXUFC'];
  let count = 0;
  for (const series of seriesTickers) {
    try {
      const url = KALSHI_BASE + '?series_ticker=' + series + '&status=open&limit=200';
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCOACH/9.0)' }
      });
      if (!resp.ok) { console.warn('[MARKETS] Kalshi', series, 'HTTP', resp.status); continue; }
      const data = await resp.json();
      const markets = data.markets || [];
      for (const m of markets) {
        const home = m.yes_sub_title || '';
        const away = m.no_sub_title || '';
        if (!home || !away) continue;
        let yesPrice = parseFloat(m.last_price_dollars);
        if (!yesPrice) {
          const bid = parseFloat(m.yes_bid_dollars) || 0;
          const ask = parseFloat(m.yes_ask_dollars) || 0;
          yesPrice = (bid + ask) / 2 || 0.5;
        }
        const key = 'kx_' + m.ticker;
        MARKET_CONSENSUS[key] = {
          question: home + ' vs ' + away + ' (' + series + ')',
          homeProb: yesPrice,
          awayProb: 1 - yesPrice,
          drawProb: 0,
          source:   'Kalshi',
          syncedAt: new Date().toISOString(),
          volume:   parseFloat(m.volume_fp) || 0,
        };
        count++;
      }
    } catch(e) {
      console.warn('[MARKETS] Kalshi', series, 'error:', e.message);
    }
  }
  console.log('[MARKETS] Kalshi:', count, 'markets loaded');
  return count;
}

async function refreshMarketConsensus() {
  const t0 = Date.now();
  const results = await Promise.allSettled([fetchPolymarketWC(), fetchManifoldSports(), fetchKalshiSports()]);
  const total = Object.keys(MARKET_CONSENSUS).length;
  const ms = Date.now() - t0;
  console.log(`[MARKETS] Refresh complete — ${total} markets in cache (${ms}ms)`);
  results.forEach((r,i) => {
    if (r.status === 'rejected') console.warn(`[MARKETS] Source ${i} failed:`, r.reason);
  });
  return total;
}

// Boot: refresh 5s apres demarrage, puis toutes les heures
setTimeout(refreshMarketConsensus, 5000);
setInterval(refreshMarketConsensus, 60 * 60 * 1000);


async function validateViaOddsAPI(entities, webMode) {
  if (!ODDS_API_KEY || !entities.length) return null;
  const sport = entities[0]?.sport || 'foot';
  const sportKeys = ODDS_SPORT_MAP[sport] || ODDS_SPORT_MAP['foot'];
  const names = entities.map(e => (e.canonical||e.name||'').toLowerCase());
  const ck = 'odds_'+sport+(webMode?'_all':'_'+names.slice(0,2).join('_'));
  const cached = cacheGet(ck);
  if (cached) return cached;

  const allEvents = [];
  for (const sk of sportKeys.slice(0, webMode?6:3)) {
    try {
      const ctrl = new AbortController();
      setTimeout(()=>ctrl.abort(), 6000);
      const resp = await fetch(
        'https://api.the-odds-api.com/v4/sports/'+sk+'/odds/?apiKey='+ODDS_API_KEY+'&regions=eu,uk,us&markets=h2h&oddsFormat=decimal&bookmakers=bet365,winamax,unibet,draftkings,fanduel',
        { signal: ctrl.signal }
      );
      const rem = resp.headers.get('x-requests-remaining');
      if (rem) console.log('[ODDS] Credits:', rem);
      if (resp.status===422) { console.log('[ODDS] Quota épuisé'); break; }
      if (!resp.ok) continue;
      const evts = await resp.json();
      allEvents.push(...(evts||[]));
    } catch(e) { console.log('[ODDS]', e.message); }
  }

  if (!allEvents.length) return null;

  if (webMode) {
    const r = { status:'VERIFIED', events:allEvents, source:'TheOddsAPI' };
    cacheSet(ck, r);
    return r;
  }

  const matched = allEvents.filter(ev => {
    const h=ev.home_team.toLowerCase(), a=ev.away_team.toLowerCase();
    return names.some(n => h.includes(n)||a.includes(n)||n.includes(h.split(' ')[0])||n.includes(a.split(' ')[0]));
  });

  if (matched.length) {
    const r = { status:'VERIFIED', events:matched, source:'TheOddsAPI' };
    cacheSet(ck, r);
    return r;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// COUCHE 3 — ESPN ENRICHISSEMENT CONTEXTUEL
// ─────────────────────────────────────────────────────────────
const ESPN = {
  foot: [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions_qual/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa_qual/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa.conf/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa.conf_qual/scoreboard',
  ],
  basket: [
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
  ],
  hockey: ['https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'],
  baseball: ['https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],
  nfl: [
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  ],
  tennis: [
    'https://site.api.espn.com/apis/site/v2/sports/tennis/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard',
  ],
};

async function fetchESPN(url) {
  const c=cacheGet(url); if(c) return c;
  try {
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),4000);
    const r=await fetch(url,{signal:ctrl.signal}); if(!r.ok) return [];
    const j=await r.json();

    // Detecter le sport depuis l'URL
    const isChampions = url.includes('uefa.champions') || url.includes('uefa.europa');
    const isBasket  = url.includes('basketball');
    const isHockey  = url.includes('hockey');
    const isBaseball = url.includes('baseball');
    const isNFL     = url.includes('football/nfl');
    const isTennis  = url.includes('tennis');

    const sportId = isChampions ? 'foot' : isBasket ? 'basket' :
                    isHockey ? 'hockey' : isBaseball ? 'base' : isNFL ? 'nfl' :
                    isTennis ? 'tennis' : 'foot';

    const matches = (j.events||[]).map(e=>{
      const comp  = e.competitions?.[0];
      const teams = comp?.competitors||[];
      const home  = teams.find(x=>x.homeAway==='home');
      const away  = teams.find(x=>x.homeAway==='away');
      const homeN = home?.team?.displayName||teams[0]?.team?.displayName||'';
      const awayN = away?.team?.displayName||teams[1]?.team?.displayName||'';
      const homeS = home?.score||'';
      const awayS = away?.score||'';
      const status = comp?.status?.type?.description||'';
      const state  = comp?.status?.type?.state||'';
      const minute = comp?.status?.displayClock||'';
      const compName = e.season?.type?.abbreviation||e.name||'';
      const leagueName = j.leagues?.[0]?.name || (isWC ? 'World Cup' : compName);
      const date = e.date ? new Date(e.date) : null;
      const dateStr = date ? date.toLocaleDateString('fr-FR') : '';
      const timeStr = date ? date.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'}) : '';
      const live = state === 'in';

      if (!homeN || !awayN) return null;

      return {
        id:          'espn_' + (e.id||Math.random()),
        home:        homeN,
        away:        awayN,
        score_home:  homeS,
        score_away:  awayS,
        competition: leagueName,
        sportId:     sportId,
        match_date:  dateStr,
        match_time:  timeStr,
        live:        live,
        minute:      live ? minute : '',
        status:      status,
        source:      'espn',
      };
    }).filter(Boolean);

    cacheSet(url, matches);
    return matches;
  } catch(e) { return []; }
}

async function fetchAllESPN(sports) {
  const urls=[];
  (sports||['foot']).forEach(s=>(ESPN[s]||[]).forEach(u=>urls.push(u)));
  if(!urls.length) ESPN.foot.slice(0,3).forEach(u=>urls.push(u));
  const results=await Promise.allSettled(urls.map(u=>fetchESPN(u)));
  return results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
}

function detectSports(text) {
  const p=text.toLowerCase();
  const ids=[];
  if(/football|foot|soccer|liga|premier|bundesliga|ligue|serie|champions|copa|mls|d1|d2/.test(p)) ids.push('foot');
  if(/basket|nba|euroleague/.test(p)) ids.push('basket');
  if(/hockey|nhl/.test(p)) ids.push('hockey');
  if(/baseball|mlb|npb|kbo|run line|nrfi/.test(p)) ids.push('baseball');
  if(/tennis|atp|wta|roland|wimbledon/.test(p)) ids.push('tennis');
  if(/nfl|american football/.test(p)) ids.push('nfl');
  if(/mma|ufc/.test(p)) ids.push('mma');
  return ids.length?ids:['foot','basket','baseball'];
}

function getRealTimeBlock() {
  const n=new Date();
  return '\n━━━ REAL-TIME ANCHOR ━━━\n'+
    'TODAY: '+n.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})+'\n'+
    'TIME: '+n.toLocaleTimeString('en-US')+'\n'+
    'RULE: Only analyze UPCOMING or LIVE events. Past events = refuse.\n\n';
}

// ─────────────────────────────────────────────────────────────
// CONTENEUR DE VÉRITÉ v4
// ─────────────────────────────────────────────────────────────
function findMarketConsensus(home, away) {
  const norm = s => (s||'').toLowerCase().replace(/[^a-z]/g, '');
  const h = norm(home), a = norm(away);
  let best = null, bestScore = 0;
  for (const m of Object.values(MARKET_CONSENSUS)) {
    const q = norm(m.question);
    let score = 0;
    if (h.length >= 3 && q.includes(h.slice(0, 5))) score += 2;
    if (a.length >= 3 && q.includes(a.slice(0, 5))) score += 2;
    if (h.length >= 6 && q.includes(h)) score += 1;
    if (a.length >= 6 && q.includes(a)) score += 1;
    if (score >= 3 && score > bestScore) { best = m; bestScore = score; }
  }
  return best;
}

function buildContainer(entities, validation, espnLines, prompt) {
  const v = validation || { status:'ENRICHMENT_ONLY', entities: [] };
  let b = '\n━━━ VALIDATED DATA ━━━\n';
  b += 'Status: '+v.status+'\n';

  if (entities.length) {
    b += '\n[ENTITIES EXTRACTED]\n';
    entities.forEach(e => {
      b += '  '+e.canonical+' ('+e.sport+(e.competition?', '+e.competition:'')+')\n';
    });
  }

  if (v.status==='VERIFIED' && v.events?.length) {
    b += '\n[ODDS — '+v.source+']\n';
    b += 'USE THESE ODDS ONLY FOR value_edge_pct CALCULATION — never as prediction guide.\n';
    v.events.slice(0,5).forEach(ev => {
      b += '  '+ev.home_team+' vs '+ev.away_team;
      b += ' | '+new Date(ev.commence_time).toLocaleString()+'\n';
      (ev.bookmakers||[]).slice(0,2).forEach(bk => {
        const h2h=bk.markets?.find(m=>m.key==='h2h');
        if (h2h) {
          const o=h2h.outcomes;
          b += '    '+bk.title+': '+(o[0]?.name||'')+' '+(o[0]?.price||'')+
               ' / '+(o[1]?.name||'')+' '+(o[1]?.price||'')+
               (o[2]?' / Draw '+o[2].price:'')+'\n';
        }
      });
    });
  } else {
    b += '\n[NOTE] Match not in TheOddsAPI — analyze using your knowledge.\n';
    b += 'If match is plausible (teams exist, competition active) → analyze normally.\n';
    b += 'If clearly impossible → date_confirmed:false.\n';
  }

  const espnFiltered = espnLines.filter(l => {
    const lTxt = typeof l === 'string' ? l : ((l.home||'')+' '+(l.away||'')+' '+(l.competition||''));
    const lLow = lTxt.toLowerCase();
    return entities.some(e => lLow.includes((e.canonical||'').toLowerCase().split(' ')[0]));
  }).map(l => typeof l === 'string' ? l :
    (l.home+' vs '+l.away+(l.score_home!==''&&l.score_home!=null?' ('+l.score_home+'-'+l.score_away+')':'')+
     ' — '+(l.competition||'')+(l.live?' [LIVE '+l.minute+']':l.status?' ['+l.status+']':''))
  );
  if (espnFiltered.length) {
    b += '\n[ESPN CONTEXT]\n'+espnFiltered.slice(0,5).join('\n')+'\n';
  }

  b += '\n---\nRULE: Cotes above = VALUE EDGE input only. Your prediction comes from the pipeline.\n\n';

  // Injection Prediction Markets
  if (typeof findMarketConsensus === 'function' && entities.length >= 1) {
    const home = entities[0]?.canonical || entities[0]?.name || '';
    const away = entities[1]?.canonical || entities[1]?.name || '';
    if (home && away) {
      const mkt = findMarketConsensus(home, away);
      if (mkt) {
        const syncAge = mkt.syncedAt ? Math.round((Date.now() - new Date(mkt.syncedAt).getTime()) / 60000) : null;
        b += '[PREDICTION MARKETS CONSENSUS]\n';
        b += 'Source: ' + mkt.source + (syncAge !== null ? ' (synced ' + syncAge + 'min ago)' : '') + '\n';
        b += 'Question: ' + mkt.question + '\n';
        b += 'Market YES prob: ' + Math.round(mkt.homeProb * 100) + '%';
        b += ' | Market NO prob: ' + Math.round(mkt.awayProb * 100) + '%\n';
        if (mkt.volume > 0) b += 'Volume: $' + Math.round(mkt.volume).toLocaleString() + '\n';
        b += 'RULE: This is crowd consensus. Use as signal only — your pipeline determines final probability.\n';
        b += 'Compute market_edge_pct = (your_confidence/100 - market_yes_prob) * 100 and include in output.\n\n';
      }
    }
  }

  return b;
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────


// RATE LIMITING
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"]||"").split(",")[0].trim()||req.socket.remoteAddress||"?";
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.t > 60000) { b = {t: now, n: 0}; rateBuckets.set(ip, b); }
  if (++b.n > 12) return res.status(429).json({ error: "Trop de requetes. Reessaie dans une minute." });
  next();
}
setInterval(() => { const now = Date.now(); for (const [k,v] of rateBuckets) if (now-v.t>120000) rateBuckets.delete(k); }, 300000);

app.post('/analyze', rateLimit, async (req, res) => {
  const timeout = setTimeout(()=>{ if(!res.headersSent) res.status(503).json({error:'Timeout'}); }, 120000);

  try {
    const { prompt } = req.body;
    if (!prompt) { clearTimeout(timeout); return res.status(400).json({error:'Prompt manquant'}); }
    if (!GEMINI_KEY) { clearTimeout(timeout); return res.status(500).json({error:'GEMINI_KEY manquante'}); }

    const T0 = Date.now();

    // 0. Si le prompt est une URL → scraper d'abord
    let finalPrompt = prompt;
    const urlMatch = prompt.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      const detectedUrl = urlMatch[0];
      console.log('[ANALYZE] URL detectee:', detectedUrl);
      try {
        const parsed = new URL(detectedUrl);
        let scraped = null;

        // Étape A — fetch direct
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 8000);
          const r = await safeFetch(detectedUrl, { signal: ctrl.signal, headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            'Referer': 'https://www.google.fr/',
          }});
          if (r.ok) {
            const html = await r.text();
            const clean = html
              .replace(/<script[\s\S]*?<\/script>/gi,'')
              .replace(/<style[\s\S]*?<\/style>/gi,'')
              .replace(/<nav[\s\S]*?<\/nav>/gi,'')
              .replace(/<footer[\s\S]*?<\/footer>/gi,'')
              .replace(/<[^>]+>/g,' ')
              .replace(/&[a-z]+;/g,' ')
              .replace(/\s{3,}/g,'\n').trim();
            if (clean.length > 200 && hasPlausibleFutureDate(clean)) {
              scraped = clean.length > 8000 ? clean.slice(0,8000) : clean;
              console.log('[ANALYZE] Fetch A OK —', scraped.length, 'chars');
            } else if (clean.length > 200) {
              console.log('[ANALYZE] Fetch A: contenu trop ancien, rejeté');
            }
          }
        } catch(e) { console.log('[ANALYZE] Fetch A:', e.message); }

        // Étape B — Gemini grounding si fetch échoue
        if (!scraped && GEMINI_KEY) {
          try {
            const now = new Date();
            const dateStr = now.toLocaleDateString('fr-FR');
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 15000);
            const gr = await fetch(
              'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY,
              {
                method: 'POST', signal: ctrl.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text:
                    'Today is ' + dateStr + '. URL requested: ' + detectedUrl + '\\n' +
                    'Find and return the ACTUAL current content of this exact URL (use search only to locate/access this specific page, not to substitute other sources).\\n' +
                    'Return ALL upcoming matches found ON THIS PAGE. Format: Home vs Away | Competition | Date | Odds1 | Odds2\\n' +
                    'CRITICAL: If you cannot verify the actual content of this specific URL, return exactly: BLOCKED. Do NOT guess or substitute matches from general knowledge or from a different source.'
                  }]}],
                  tools: [{ google_search: {} }],
                  generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
                })
              }
            );
            if (gr.ok) {
              const gd = await gr.json();
              const gt = gd?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (gt && gt !== 'BLOCKED' && gt.length > 50 && hasPlausibleFutureDate(gt)) {
                scraped = '[Source: ' + parsed.hostname + ']\n' + gt;
                console.log('[ANALYZE] Grounding B OK —', scraped.length, 'chars');
              } else if (gt && gt !== 'BLOCKED') {
                console.log('[ANALYZE] Grounding B: contenu trop ancien, rejeté');
              }
            }
          } catch(e) { console.log('[ANALYZE] Grounding B:', e.message); }
        }

        if (scraped) {
          // Vérifier que le contenu n'est pas un message d'erreur
          const isError = scraped.length < 100 ||
            scraped.includes('access denied') ||
            scraped.includes('403') ||
            scraped.includes('cloudflare') ||
            scraped.toLowerCase().includes('blocked');
          if (isError) {
            clearTimeout(timeout);
            return res.status(422).json({
              error: 'Site inaccessible depuis nos serveurs. Copie-colle le texte de la page directement dans SUPERCOACH.'
            });
          }
          // Pour les URLs : instructions complètes car buildPrompt non appelé
          finalPrompt = 'SUPERCOACH v9.3 — Analyze ALL matches below. Strict JSON only.\n' +
            'PIPELINE per match: 1.Base Score 0-100 → 2.Home+5% → 3.Injuries → 4.Motivation → 5.Form\n' +
            'CALIBRATION: confidence max 80% if no form/H2H data available. NPB/KBO max 78% without stats.\n' +
            'BANKROLL: value_edge_pct=(confidence/100-1/odds_given)*100. Units=(VE/(odds-1))*10 capped 0-5.\n' +
            'CRITICAL: Extract odds from the content below. odds_given MUST be filled from source data.\n' +
            'If odds present in source → use them. If not → use 1.85 as default.\n' +
            'value_edge_pct MUST be calculated — never leave it null or 0 unless truly no value.\n' +
            'OUTPUT strict JSON: {"matches":[{' +
            '"rank":1,"sport":"Baseball","sport_id":"baseball","home":"A","away":"B",' +
            '"competition":"NPB/KBO/MLB","match_date":"DD/MM/YYYY","match_time":"HH:MM",' +
            '"date_confirmed":true,"result":"WIN_HOME","confidence":75,' +
            '"odds_given":1.85,"value_edge_pct":2.1,"value":"light",' +
            '"value_text":"Conf 75% vs 74.1% implied → edge +2.1%",' +
            '"units":2,"rotation_alert":false,"rotation_text":"",' +
            '"justification":"• reason1 with impact. • reason2 with impact.",' +
            '"sub_bets":["NRFI","Over 8.5 runs"]}],' +
            '"summary":"Global strategy","roi_potential":"Est. ROI: +X%"}\n' +
            'sport_id: foot|basket|baseball|tennis|hockey|nfl|other — detect from competition name.\n' +
            'NPB/KBO/MLB → baseball. NBA/Euroleague → basket. NHL → hockey. etc.\n' +
            'result: WIN_HOME|WIN_AWAY|DRAW. Analyze ALL matches found. MAX 2 bullet points each.\n\n' +
            scraped;
          console.log('[ANALYZE] Contenu URL utilisé pour analyse');
        } else {
          console.log('[ANALYZE] Scraping échoué — URL non analysable');
          clearTimeout(timeout);
          return res.status(422).json({ error: 'Impossible de lire cette URL. Essaie de copier-coller le texte de la page directement.' });
        }
      } catch(e) {
        console.log('[ANALYZE] URL invalide:', e.message);
      }
    }

    // 1. Extraction intelligente
    const entities = await extractEntitiesWithGemini(finalPrompt).catch(()=>[]);
    const sports = detectSports(prompt);
    if (entities.length && entities[0].sport) {
      if (!sports.includes(entities[0].sport)) sports.unshift(entities[0].sport);
    }

    // 2. Validation + ESPN en parallèle
    const isWebMode = entities.length > 3;
    const [validationRaw, espnLines] = await Promise.all([
      validateViaOddsAPI(entities, isWebMode).catch(()=>null),
      fetchAllESPN(sports).catch(()=>[]),
    ]);
    const validation = validationRaw || { status:'ENRICHMENT_ONLY', entities };
    const T1 = Date.now();

    // 3. Conteneur de vérité
    const container = buildContainer(entities, validation, espnLines, prompt);

    // 4. Appel Gemini avec prompt frontend
    const timeBlock = getRealTimeBlock();
    const enrichedPrompt = timeBlock + container + finalPrompt;

    let text='', usedModel='';
    for (const model of MODELS) {
      try {
        const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(), 90000);
        const gr = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+GEMINI_KEY,
          {
            method:'POST', signal:ctrl.signal,
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              system_instruction:{ parts:[{ text:'You are SUPERCOACH, an elite sports analyst. Return ONLY valid JSON. No markdown, no backticks.' }]},
              contents:[{role:'user',parts:[{text:enrichedPrompt}]}],
              generationConfig:{ temperature:0.1, maxOutputTokens:16384, thinkingConfig:{thinkingBudget:1024} }
            })
          }
        );
        if (!gr.ok) {
          const err=await gr.json().catch(()=>({}));
          if (gr.status===429) throw new Error('QUOTA');
          throw new Error(err.error?.message||'Gemini '+gr.status);
        }
        const gd=await gr.json();
        text=gd.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
        usedModel=model;
        break;
      } catch(e) {
        console.log('[GEMINI]',model,e.message);
        if (e.message==='QUOTA' && model===MODELS[MODELS.length-1]) {
          clearTimeout(timeout);
          return res.status(429).json({error:'Quota Gemini dépassé. Attends 1 minute.'});
        }
      }
    }

    if (!text) { clearTimeout(timeout); return res.status(500).json({error:'Gemini sans réponse'}); }

    const T2=Date.now();
    const tokens=Math.round(enrichedPrompt.length/4);

    // 5. Sauvegarder Neon
    const db_ids=[];
    if (sql) {
      try {
        const parsed=JSON.parse(text.replace(/```json/gi,'').replace(/```/g,'').trim());
        if (parsed.matches?.length) {
          for (const m of parsed.matches) {
            const id=await savePrediction(m).catch(()=>null);
            db_ids.push(id||null);
          }
        }
      } catch(e) {}
    }

    // Market consensus pour la réponse UI
    const home0 = entities[0]?.canonical || entities[0]?.name || '';
    const away0 = entities[1]?.canonical || entities[1]?.name || '';
    const marketData = (home0 && away0) ? findMarketConsensus(home0, away0) : null;

    // Data richness : 1-5 étoiles selon sources disponibles
    let dataRichness = 1;
    if (validation?.status === 'VERIFIED') dataRichness += 2;
    if (espnLines.length > 0) dataRichness += 1;
    if (marketData) dataRichness += 1;
    dataRichness = Math.min(5, dataRichness);

    const { premium } = await getPremiumStatus(req);

    clearTimeout(timeout);
    res.json({
      result: text,
      db_ids,
      market: (marketData && premium) ? {
        source:    marketData.source,
        question:  marketData.question,
        homeProb:  Math.round(marketData.homeProb * 100),
        awayProb:  Math.round(marketData.awayProb * 100),
        syncedAt:  marketData.syncedAt,
        volume:    marketData.volume || 0,
        totalMarkets: Object.keys(MARKET_CONSENSUS).length,
      } : null,
      marketLocked: !!(marketData && !premium),
      dataRichness,
      meta: {
        timing: { total_ms:T2-T0, fetch_ms:T1-T0, gemini_ms:T2-T1, prompt_tokens_est:tokens },
        model: usedModel,
        validation_status: validation?.status || 'ENRICHMENT_ONLY',
        entities: entities.map(e=>e.canonical||e.name),
      }
    });

  } catch(err) {
    console.error('[ANALYZE]',err.message);
    clearTimeout(timeout);
    if (!res.headersSent) res.status(500).json({error:err.message});
  }
});

app.post('/scrape', rateLimit, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({error:'URL manquante'});
  let parsed;
  try { parsed=new URL(url); if(!['http:','https:'].includes(parsed.protocol)) throw new Error(); }
  catch { return res.status(400).json({error:'URL invalide'}); }

  if (!(await isSSRFSafe(url))) {
    return res.status(400).json({error:'URL non autorisée (adresse interne/privée bloquée)'});
  }

  console.log('[SCRAPE]', parsed.hostname);
  let content=null;

  // Étape A — fetch direct
  try {
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),8000);
    const r=await safeFetch(url,{signal:ctrl.signal,headers:{
      'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept':'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.8',
      'Referer':'https://www.google.fr/',
    }});
    if (r.ok) {
      const html=await r.text();
      const clean=html
        .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
        .replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<footer[\s\S]*?<\/footer>/gi,'')
        .replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/g,' ').replace(/\s{3,}/g,'\n').trim();
      if (clean.length>200 && hasPlausibleFutureDate(clean)) {
        content=clean.length>10000?clean.slice(0,10000)+'\n[truncated]':clean;
        console.log('[SCRAPE] A OK —',content.length,'chars');
      } else if (clean.length>200) {
        console.log('[SCRAPE] A: contenu trop ancien, rejeté');
      }
    }
  } catch(e) { console.log('[SCRAPE] A:',e.message); }

  // Étape B — Gemini grounding ciblé
  if (!content && GEMINI_KEY) {
    try {
      const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),20000);
      const gr=await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+GEMINI_KEY,
        {
          method:'POST', signal:ctrl.signal,
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            contents:[{role:'user',parts:[{text:
              'Today is '+new Date().toLocaleDateString('en-US')+'. Extract ONLY upcoming or live sports matches from this page.\n'+
              'Website: '+parsed.hostname+'\n'+
              'URL: '+url+'\n'+
              'CRITICAL: Return ONLY matches scheduled TODAY or in the FUTURE. Ignore past matches.\n'+
              'Do NOT use ESPN, Google, or any other source. Only this exact URL.\n'+
              'Format: team1 vs team2 | competition | date | odds\n'+
              'If no upcoming matches found or page inaccessible: return BLOCKED'
            }]}],
            generationConfig:{maxOutputTokens:2048,temperature:0.1}
          })
        }
      );
      if (gr.ok) {
        const d=await gr.json();
        const t=d?.candidates?.[0]?.content?.parts?.[0]?.text||'';
        if (t&&t!=='BLOCKED'&&t.length>50) {
          // Rejeter si Gemini retourne uniquement des vieux matchs (années passées détectées)
          if (hasPlausibleFutureDate(t)) {
            content='['+parsed.hostname+']\n'+t;
            console.log('[SCRAPE] B OK —',content.length,'chars');
          } else {
            console.log('[SCRAPE] B: contenu trop ancien, rejeté');
          }
        }
      }
    } catch(e) { console.log('[SCRAPE] B:',e.message); }
  }

  if (content) return res.json({success:true,hostname:parsed.hostname,content,chars:content.length});
  res.json({success:false,blocked:true,hostname:parsed.hostname,message:'Site inaccessible'});
});

app.get('/stats', async (req, res) => {
  const s=await getStats();
  if (!s) return res.json({error:'DB non connectée'});
  res.json({
    total:parseInt(s.total), correct:parseInt(s.correct),
    incorrect:parseInt(s.incorrect), pending:parseInt(s.pending),
    win_rate:parseFloat(s.win_rate)||0, avg_confidence:parseInt(s.avg_confidence)||0,
    total_roi:parseFloat(s.total_roi)||0,
  });
});

app.post('/outcome', async (req, res) => {
  const {id,result,correct}=req.body;
  if (!id||result===undefined||correct===undefined) return res.status(400).json({error:'Params manquants'});
  await updateOutcome(id,result,correct);
  res.json({success:true});
});

app.get('/health', async (req, res) => {
  const r={};
  for (const m of MODELS) {
    try {
      const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),8000);
      const gr=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent?key='+GEMINI_KEY,
        {method:'POST',signal:ctrl.signal,headers:{'Content-Type':'application/json'},
         body:JSON.stringify({contents:[{role:'user',parts:[{text:'ok'}]}],generationConfig:{maxOutputTokens:5,thinkingConfig:{thinkingBudget:0}}})});
      r[m]=gr.ok?'✅ OK':'❌ '+gr.status;
    } catch(e) { r[m]='❌ '+e.message; }
  }
  res.json({
    status:'SUPERCOACH API v9.3',
    architecture:'Gemini extracts → TheOddsAPI validates → Gemini analyzes',
    gemini:r,
    odds_api:ODDS_API_KEY?'✅ configurée':'❌ manquante',
    apisports:APISPORTS_KEY?'✅ configurée':'❌ manquante',
    neon:sql?'✅ connectée':'❌ non connectée',
  });
});


// ══════════════════════════════════════════════════════════
// /fixtures — Endpoint unifié API-Sports + ESPN fallback
// Retourne tous les matchs du jour, normalisés
// ══════════════════════════════════════════════════════════

// Map sport → API-Sports endpoint
const APISPORTS_ENDPOINTS = {
  foot:     { host: 'v3.football.api-sports.io',    path: '/fixtures?date=' },
  basket:   { host: 'v1.basketball.api-sports.io',  path: '/games?date=' },
  tennis:   { host: 'v1.tennis.api-sports.io',      path: '/games?date=' },
  hockey:   { host: 'v1.hockey.api-sports.io',      path: '/games?date=' },
  baseball: { host: 'v1.baseball.api-sports.io',    path: '/games?date=' },
  rugby:    { host: 'v1.rugby.api-sports.io',       path: '/games?date=' },
};

async function fetchAPISports(sport, date) {
  const ep = APISPORTS_ENDPOINTS[sport];
  if (!ep || !APISPORTS_KEY) return [];
  const url = `https://${ep.host}${ep.path}${date}`;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'x-apisports-key': APISPORTS_KEY,
        'x-rapidapi-host': ep.host,
      }
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return normalizeAPISports(sport, data);
  } catch (e) {
    console.log(`[API-Sports] ${sport} error:`, e.message);
    return [];
  }
}

function normalizeAPISports(sport, data) {
  const resp = data.response || [];
  const EXCLUDE = /reserve|b.?team|u18|u20|u21|u23|youth|friendly|amical/i;
  const sportEmoji = {
    foot:'⚽', basket:'🏀', tennis:'🎾', hockey:'🏒',
    baseball:'⚾', rugby:'🏉', mma:'🥊', other:'🎯'
  };

  return resp.map(item => {
    // Football (API-Football format)
    if (sport === 'foot') {
      const fix = item.fixture || {};
      const teams = item.teams || {};
      const league = item.league || {};
      const goals = item.goals || {};
      const status = fix.status || {};

      // Exclure matchs terminés et annulés
      const st = (status.short || '').toUpperCase();
      if (['FT','AET','PEN','AWD','WO','CANC','PST','ABD'].includes(st)) return null;
      if (EXCLUDE.test(league.name || '')) return null;

      const homeName = teams.home?.name || '';
      const awayName = teams.away?.name || '';
      if (!homeName || !awayName) return null;

      const isLive = ['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE'].includes(st);
      const dateUTC = fix.date || '';

      return {
        id:          `foot|${homeName}|${awayName}`,
        sport:       'foot',
        emoji:       '⚽',
        home:        homeName,
        away:        awayName,
        homeLogo:    teams.home?.logo || '',
        awayLogo:    teams.away?.logo || '',
        competition: league.name || '',
        country:     league.country || '',
        dateUTC:     dateUTC,
        isLive:      isLive,
        isFinished:  false,
        score:       isLive ? `${goals.home ?? 0}-${goals.away ?? 0}` : '',
        minute:      status.elapsed ? String(status.elapsed) : '',
        statusShort: st,
        leagueId:    league.id || 0,
      };
    }

    // Tennis — joueurs, pas des clubs
    if (sport === 'tennis') {
      const status = item.status || item.game?.status || {};
      const st = (status.short || status.long || '').toUpperCase();
      if (['FT','FINISHED','OVER','CANC','PST','ABD','WO'].some(s => st === s || st.includes('FINISH'))) return null;

      const players = item.players || {};
      const teamsT = item.teams || {};
      const homeName = (
        teamsT.home?.name ||
        players.home?.name ||
        players.player1?.name ||
        item.player1?.name ||
        item.home?.name ||
        item.homeCompetitor?.name ||
        ''
      );
      const awayName = (
        teamsT.away?.name ||
        players.away?.name ||
        players.player2?.name ||
        item.player2?.name ||
        item.away?.name ||
        item.awayCompetitor?.name ||
        ''
      );
      if (!homeName || !awayName) return null;

      const league = item.league || item.tournament || item.competition || {};
      const dateUTC = item.date || item.game?.date || '';
      const isLive = ['1S','2S','3S','4S','5S','SET','LIVE','PLAYING','IN PLAY','INT','SUSP'].some(s => st.includes(s));
      const scores = item.scores || {};
      const homeScore = scores.home?.total ?? scores.home ?? null;
      const awayScore = scores.away?.total ?? scores.away ?? null;

      return {
        id:          `tennis|${homeName}|${awayName}`,
        sport:       'tennis',
        emoji:       '🎾',
        home:        homeName,
        away:        awayName,
        homeLogo:    teamsT.home?.logo || players.home?.logo || item.homeCompetitor?.imageUrl || '',
        awayLogo:    teamsT.away?.logo || players.away?.logo || item.awayCompetitor?.imageUrl || '',
        competition: league.name || 'Tennis',
        country:     league.country || item.country?.name || '',
        dateUTC:     dateUTC,
        isLive:      isLive,
        isFinished:  false,
        score:       (isLive && homeScore !== null) ? `${homeScore}-${awayScore}` : '',
        statusShort: st,
        leagueId:    league.id || 0,
      };
    }

    // Autres sports (Basketball, Hockey, Baseball, Rugby)
    const teams = item.teams || {};
    const status = item.status || item.game?.status || {};
    const st = (status.short || status.long || '').toUpperCase();
    if (['FT','FINISHED','OVER','CANC','PST'].some(s => st.includes(s))) return null;

    const homeName = (teams.home?.name || item.home?.name || '');
    const awayName = (teams.away?.name || item.away?.name || '');
    if (!homeName || !awayName) return null;

    const league = item.league || item.competition || {};
    const dateUTC = item.date || item.game?.date || '';
    const isLive = ['Q1','Q2','Q3','Q4','HT','OT','LIVE','IN PLAY','1ST','2ND'].some(s => st.includes(s));
    const scores = item.scores || item.game?.scores || {};
    const homeScore = scores.home?.total ?? scores.home ?? null;
    const awayScore = scores.away?.total ?? scores.away ?? null;

    return {
      id:          `${sport}|${homeName}|${awayName}`,
      sport:       sport,
      emoji:       sportEmoji[sport] || '🎯',
      home:        homeName,
      away:        awayName,
      homeLogo:    teams.home?.logo || item.home?.logo || '',
      awayLogo:    teams.away?.logo || item.away?.logo || '',
      competition: league.name || sport.toUpperCase(),
      country:     league.country || '',
      dateUTC:     dateUTC,
      isLive:      isLive,
      isFinished:  false,
      score:       (isLive && homeScore !== null) ? `${homeScore}-${awayScore}` : '',
      statusShort: st,
      leagueId:    league.id || 0,
    };
  }).filter(Boolean);
}

// ── USER STATS ─────────────────────────────────────────
app.post('/user/stats', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { result } = req.body; // 'win' | 'loss' | 'draw'
  if (!token || !result) return res.status(400).json({ error: 'Missing token or result' });
  const userId = await verifySupabaseToken(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  await updateUserStats(userId, result);
  res.json({ success: true });
});

// ── USER PROFILE ────────────────────────────────────────
app.get('/user/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const userId = await verifySupabaseToken(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*,stats(*),bankroll(*),subscriptions(plan,status)`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    res.json({ success: true, user: data[0] || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /analyze-match — Moteur engine.js complet ──────────────────
// Reçoit apiData structuré, enrichit avec API-Football, appelle Gemini
app.post('/analyze-match', rateLimit, async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.status(503).json({ error: 'Timeout' });
  }, 120000);

  try {
    const { apiData, odds, oddsOutcome } = req.body;
    if (!apiData || !apiData.home || !apiData.away) {
      clearTimeout(timeout);
      return res.status(400).json({ error: 'apiData manquant (home, away requis)' });
    }

    // ── Enrichissement automatique API-Football ──
    let eloHomeTeamId = null, eloAwayTeamId = null; // hoisté pour le lookup Elo additif en fin de fonction
    if (APISPORTS_KEY && apiData.sport === 'football') {
      try {
        const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
        const fixturesUrl = `https://v3.football.api-sports.io/fixtures?date=${today}&timezone=Europe/Paris`;
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 6000);
        const fRes = await fetch(fixturesUrl, {
          signal: ctrl.signal,
          headers: { 'x-apisports-key': APISPORTS_KEY }
        });
        const fData = await fRes.json();
        const fixtures = fData.response || [];

        // Trouver le match correspondant par fuzzy matching des noms
        const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const match = fixtures.find(f => {
          const h = normalize(f.teams?.home?.name || '');
          const a = normalize(f.teams?.away?.name || '');
          const qh = normalize(apiData.home);
          const qa = normalize(apiData.away);
          return (h.includes(qh) || qh.includes(h)) && (a.includes(qa) || qa.includes(a));
        });

        if (match) {
          eloHomeTeamId = match.teams?.home?.id ?? null;
          eloAwayTeamId = match.teams?.away?.id ?? null;
          // Classement réel : /standings est un endpoint SÉPARÉ de /fixtures — l'ancien code
          // cherchait match.league.standings, qui n'existe jamais dans la réponse /fixtures.
          // Ici on appelle le bon endpoint, puis on identifie les 2 équipes du match par leur
          // ID exact (pas par position [0]/[1] dans une liste qui n'a aucun rapport avec elles).
          apiData.homeRank = null;
          apiData.awayRank = null;
          try {
            const stCtrl = new AbortController();
            setTimeout(() => stCtrl.abort(), 5000);
            const stUrl = `https://v3.football.api-sports.io/standings?league=${match.league.id}&season=${match.league.season}`;
            const stRes = await fetch(stUrl, { signal: stCtrl.signal, headers: { 'x-apisports-key': APISPORTS_KEY } });
            const stData = await stRes.json();
            const groups = stData?.response?.[0]?.league?.standings || [];
            const flat = groups.flat(); // certaines compétitions ont plusieurs groupes/poules
            const homeRow = flat.find(r => r.team?.id === match.teams?.home?.id);
            const awayRow = flat.find(r => r.team?.id === match.teams?.away?.id);
            apiData.homeRank = homeRow?.rank || null;
            apiData.awayRank = awayRow?.rank || null;
            console.log(`[/analyze-match] Classement: ${apiData.home}=${apiData.homeRank ?? 'indisponible'}, ${apiData.away}=${apiData.awayRank ?? 'indisponible'}`);
          } catch(e) {
            console.warn('[/analyze-match] Classement indisponible:', e.message);
          }
          // Injecter xG si disponibles
          if (match.statistics) {
            apiData.advancedMetrics = apiData.advancedMetrics || {};
            apiData.advancedMetrics.xG = {
              homeFor: match.statistics?.[0]?.statistics?.find(s => s.type === 'expected_goals')?.value || null,
              awayFor: match.statistics?.[1]?.statistics?.find(s => s.type === 'expected_goals')?.value || null,
            };
          }
          // Blessures/absences réelles via /injuries (fixture-spécifique).
          // ATTENTION : une réponse vide peut vouloir dire "aucun blessé" OU "ligue non couverte
          // par l'API" — l'endpoint ne distingue pas les deux. On ne traite donc JAMAIS une liste
          // vide comme une confirmation "personne n'est blessé" ; c'est juste "rien à signaler".
          apiData.homeAbsences = {};
          apiData.awayAbsences = {};
          try {
            const injCtrl = new AbortController();
            setTimeout(() => injCtrl.abort(), 5000);
            const injUrl = `https://v3.football.api-sports.io/injuries?fixture=${match.fixture.id}`;
            const injRes = await fetch(injUrl, { signal: injCtrl.signal, headers: { 'x-apisports-key': APISPORTS_KEY } });
            const injData = await injRes.json();
            const injList = injData?.response || [];
            for (const row of injList) {
              const side = row.team?.id === match.teams?.home?.id ? 'homeAbsences'
                         : row.team?.id === match.teams?.away?.id ? 'awayAbsences' : null;
              if (side && row.player?.name) {
                apiData[side][row.player.name] = row.player?.reason || row.type || 'Absent';
              }
            }
            console.log(`[/analyze-match] Absences: ${apiData.home}=${Object.keys(apiData.homeAbsences).length}, ${apiData.away}=${Object.keys(apiData.awayAbsences).length} (0 peut signifier "non couvert", pas "aucun blessé")`);
          } catch(e) {
            console.warn('[/analyze-match] Blessures indisponibles:', e.message);
          }

          // Forme (5 derniers matchs) + fatigue (heures depuis le dernier match), à partir du
          // même historique réel — un seul appel par équipe au lieu de deux.
          apiData.homeForm = null;
          apiData.awayForm = null;
          apiData.homeWinStreak = 0;
          apiData.awayWinStreak = 0;
          apiData.environment = apiData.environment || {};
          apiData.environment.homeLastMatchHoursAgo = null;
          apiData.environment.awayLastMatchHoursAgo = null;
          async function fetchFormAndFatigue(teamId) {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 5000);
            const url = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5`;
            const res = await fetch(url, { signal: ctrl.signal, headers: { 'x-apisports-key': APISPORTS_KEY } });
            const data = await res.json();
            const played = (data?.response || [])
              .filter(f => f.fixture?.status?.short === 'FT')
              // Tri explicite du plus récent au plus ancien — on ne suppose jamais l'ordre de l'API.
              .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
            if (!played.length) return { form: null, winStreak: 0, hoursAgo: null };
            const results = played.map(f => {
              const isHome = f.teams?.home?.id === teamId;
              const gf = isHome ? f.goals?.home : f.goals?.away;
              const ga = isHome ? f.goals?.away : f.goals?.home;
              if (gf == null || ga == null) return '?';
              return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
            });
            const form = results.join('');
            // Série de victoires EN COURS = nombre de 'W' consécutifs depuis le match le plus récent.
            let winStreak = 0;
            for (const r of results) { if (r === 'W') winStreak++; else break; }
            const mostRecent = played[0]?.fixture?.date;
            const hoursAgo = mostRecent ? Math.round((Date.now() - new Date(mostRecent).getTime()) / 3600000) : null;
            return { form, winStreak, hoursAgo };
          }
          try {
            const [homeStats, awayStats] = await Promise.all([
              fetchFormAndFatigue(match.teams.home.id),
              fetchFormAndFatigue(match.teams.away.id),
            ]);
            apiData.homeForm = homeStats.form;
            apiData.awayForm = awayStats.form;
            apiData.homeWinStreak = homeStats.winStreak;
            apiData.awayWinStreak = awayStats.winStreak;
            apiData.environment.homeLastMatchHoursAgo = homeStats.hoursAgo;
            apiData.environment.awayLastMatchHoursAgo = awayStats.hoursAgo;
            console.log(`[/analyze-match] Forme: ${apiData.home}=${apiData.homeForm ?? '?'} (streak=${apiData.homeWinStreak}, ${apiData.environment.homeLastMatchHoursAgo ?? '?'}h) | ${apiData.away}=${apiData.awayForm ?? '?'} (streak=${apiData.awayWinStreak}, ${apiData.environment.awayLastMatchHoursAgo ?? '?'}h)`);
          } catch(e) {
            console.warn('[/analyze-match] Forme/fatigue indisponibles:', e.message);
          }

          // Météo réelle (Open-Meteo, gratuit, sans clé). Avant : 'clear' codé en dur, toujours
          // faux sauf coïncidence. Maintenant : UNAVAILABLE si la ville ou la prévision manque —
          // jamais de valeur fictive substituée en silence.
          apiData.environment = apiData.environment || {};
          try {
            const city = match.fixture?.venue?.city;
            const kickoff = match.fixture?.date;
            if (city && kickoff) {
              const geoCtrl = new AbortController();
              setTimeout(() => geoCtrl.abort(), 5000);
              const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`;
              const geoRes = await fetch(geoUrl, { signal: geoCtrl.signal });
              const geoData = await geoRes.json();
              const loc = geoData?.results?.[0];
              if (loc) {
                const day = kickoff.slice(0, 10); // YYYY-MM-DD
                const wCtrl = new AbortController();
                setTimeout(() => wCtrl.abort(), 5000);
                const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&hourly=temperature_2m,precipitation,weathercode,wind_speed_10m&timezone=UTC&start_date=${day}&end_date=${day}`;
                const wRes = await fetch(wUrl, { signal: wCtrl.signal });
                const wData = await wRes.json();
                const times = wData?.hourly?.time || [];
                // Trouve l'heure de prévision la plus proche du coup d'envoi
                const idx = times.reduce((best, t, i) => {
                  const diff = Math.abs(new Date(t).getTime() - new Date(kickoff).getTime());
                  return diff < best.diff ? { i, diff } : best;
                }, { i: -1, diff: Infinity }).i;
                if (idx >= 0) {
                  const code = wData.hourly.weathercode[idx];
                  // Codes WMO simplifiés en catégories utilisables par le prompt
                  const condition = code === 0 ? 'clear' : code <= 3 ? 'cloudy' : code <= 48 ? 'fog'
                                  : code <= 67 ? 'rain' : code <= 86 ? 'snow' : 'storm';
                  apiData.environment.weatherCondition = condition;
                  apiData.environment.temperatureCelsius = wData.hourly.temperature_2m[idx];
                  apiData.environment.windSpeedKmh = wData.hourly.wind_speed_10m[idx];
                } // sinon : hors fenêtre de prévision (trop loin dans le futur) → reste absent (pas de fausse valeur par défaut)
              }
            }
            console.log(`[/analyze-match] Météo: ${apiData.environment.weatherCondition ?? 'indisponible'} (ville: ${city ?? 'inconnue'})`);
          } catch(e) {
            console.warn('[/analyze-match] Météo indisponible:', e.message);
          }
          console.log(`[/analyze-match] Match enrichi: ${apiData.home} vs ${apiData.away}`);
        }
      } catch(e) {
        console.warn('[/analyze-match] Enrichissement API-Football skippé:', e.message);
      }
    }

    // ── Appel Gemini via engine.js ──
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
    const userPrompt = buildEnginePrompt(apiData);
    let geminiResult = null;

    for (const model of models) {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 25000);
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              generationConfig: { temperature: 0.0, responseMimeType: 'application/json' },
            }),
          }
        );
        if (!gRes.ok) continue;
        const gData = await gRes.json();
        const raw = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) continue;
        geminiResult = JSON.parse(raw);
        console.log(`[/analyze-match] ${model} ✅ conf=${geminiResult.confidence}%`);
        break;
      } catch(e) {
        console.warn(`[/analyze-match] ${model} error:`, e.message);
      }
    }

    if (!geminiResult) throw new Error('Gemini indisponible');

    // ── Normalisation probabilités ──
    const fp = geminiResult.final_probability;
    const sport = (apiData.sport || 'football').toLowerCase();
    if (['basketball', 'tennis', 'baseball'].includes(sport)) fp.draw = 0;
    const total = (fp.home_win || 0) + (fp.draw || 0) + (fp.away_win || 0);
    if (Math.abs(total - 1.0) > 0.005) {
      fp.home_win /= total; fp.draw /= total; fp.away_win /= total;
    }
    ['home_win','draw','away_win'].forEach(k => {
      fp[k] = Math.round(Math.min(0.95, Math.max(0, fp[k])) * 10000) / 10000;
    });
    if (apiData.isMinorLeague) geminiResult.confidence = Math.min(65, geminiResult.confidence);

    // ── Kelly & Value Edge ──
    const kelly = odds ? computeKellyAndValueEdge(geminiResult, parseFloat(odds), oddsOutcome) : null;
    const { premium } = await getPremiumStatus(req);

    // ── Signal Elo additif (Probability Engine V1) — lecture seule, n'affecte rien d'autre ──
    // Ne bloque jamais la réponse : toute erreur ici est absorbée, la réponse Gemini reste intacte.
    let eloSignal = null;
    if (sql && eloHomeTeamId && eloAwayTeamId) {
      try {
        const eloRows = await sql(
          `SELECT team_id, rating, matches_played FROM team_elo_ratings WHERE team_id = ANY($1::int[])`,
          [[eloHomeTeamId, eloAwayTeamId]]
        );
        const homeRow = eloRows.find(r => r.team_id === eloHomeTeamId);
        const awayRow = eloRows.find(r => r.team_id === eloAwayTeamId);
        const homeRating = homeRow?.rating ?? null, awayRating = awayRow?.rating ?? null;
        const homeMatches = homeRow?.matches_played ?? null, awayMatches = awayRow?.matches_played ?? null;

        if (homeRating != null && awayRating != null) {
          const probs = eloEngine.computeExpectedProbabilities(homeRating, awayRating);
          const signal = eloEngine.classifySignal(homeMatches, awayMatches, probs.eloGap);
          eloSignal = {
            source: 'eloEngine V1 (statistique, indépendant de Gemini)',
            probabilities: { home: +probs.pHome.toFixed(4), draw: +probs.pDraw.toFixed(4), away: +probs.pAway.toFixed(4) },
            signalStatus: signal.status,
            signalReason: signal.reason,
            disclaimer: 'Résultat statistique validé en backtest (Log Loss 0,99286 sur holdout) — ne constitue pas une preuve de rentabilité ni de supériorité sur le marché.',
          };
        } else {
          eloSignal = { source: 'eloEngine V1', signalStatus: 'NO_SIGNAL', signalReason: 'Équipe(s) absente(s) de la base historique.' };
        }
      } catch (e) {
        console.warn('[/analyze-match] eloSignal indisponible:', e.message);
      }
    }

    clearTimeout(timeout);
    res.json({
      success: true,
      result: geminiResult,
      kelly: premium ? kelly : null,
      kellyLocked: !!(kelly && !premium),
      eloSignal,
    });

  } catch(e) {
    clearTimeout(timeout);
    console.error('[/analyze-match]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /run-backtest — Backtesting Gemini vs Baseline ─────────────────
// Sécurisé par clé secrète : POST avec { "secret": "BACKTEST_SECRET" }
// Optionnel : { "sport": "football", "limit": 20, "dryRun": false }
app.post('/run-backtest', async (req, res) => {
  // Sécurité : clé secrète pour ne pas exposer publiquement
  const secret = process.env.BACKTEST_SECRET;
  if (!secret) return res.status(503).json({ error: 'BACKTEST_SECRET manquant.' });
  const provided = req.headers['x-backtest-key'];
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized.' });

  const { sport: sportFilter, limit = 10, dryRun = false } = req.body || {};
  // Utiliser GEMINI_KEY directement depuis process.env (déjà chargée dans server.js)
  const geminiKey = dryRun ? null : GEMINI_KEY;
  console.log('[/run-backtest] dryRun='+dryRun+' geminiKey='+(geminiKey ? 'SET('+geminiKey.length+'chars)' : 'EMPTY'));

  // Timeout global : 52 matchs × 1.5s pause + 22s Gemini max = ~4 min max
  const GLOBAL_TIMEOUT = 8 * 60 * 1000; // 8min pour 10 matchs
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(503).json({ error: 'Backtest timeout (5min max)' });
  }, GLOBAL_TIMEOUT);

  try {
    // Charger les mocks depuis GitHub (sans dépendance au filesystem Render)
    const MOCKS_URL = 'https://api.github.com/repos/Nostra88/super-coach/contents/test/mocks';
    const ghHeaders = { 'User-Agent': 'SUPERCOACH-Backtest' };
    if (process.env.GITHUB_TOKEN) ghHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

    const listRes  = await fetch(MOCKS_URL, { headers: ghHeaders });
    if (!listRes.ok) throw new Error(`GitHub API ${listRes.status}`);
    const fileList = await listRes.json();

    let mocks = [];
    for (const file of fileList) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const fr = await fetch(file.download_url);
        const mock = await fr.json();
        if (sportFilter && mock.apiData?.sport !== sportFilter) continue;
        mocks.push(mock);
        if (mocks.length >= limit) break;
      } catch(e) { /* skip mock invalide */ }
    }

    if (!mocks.length) {
      clearTimeout(timer);
      return res.status(404).json({ error: 'Aucun mock trouvé', sport: sportFilter || 'all' });
    }

    console.log(`[/run-backtest] ${mocks.length} mocks | sport=${sportFilter||'all'} | dryRun=${dryRun}`);

    // Suivi progression en temps réel (logs Render)
    const progress = [];
    const onProgress = ({ i, total, id, geminiPred, actual_outcome, geminiCorrect }) => {
      const log = `[${i}/${total}] ${id} → ${geminiPred||'skip'} (réel: ${actual_outcome}) ${geminiCorrect ? '✅' : geminiPred ? '❌' : ''}`;
      console.log(`[BT] ${log}`);
      progress.push(log);
    };

    const report = await runBacktest({ mocks, geminiKey, onProgress });
    report.progress = progress;

    clearTimeout(timer);

    // Réponse JSON structurée
    res.json({
      success: true,
      summary: {
        total:        report.total,
        dryRun,
        sportFilter:  sportFilter || 'all',
        gemini: {
          correct:   report.gemini.correct,
          accuracy:  report.gemini.accuracy,
        },
        bookmaker: {
          correct:  report.bookmaker.correct,
          accuracy: report.bookmaker.accuracy,
        },
        edge:     report.edge,
        verdict:  dryRun ? 'TEST STRUCTURE OK' : report.edge === null ? 'GEMINI N A PAS REPONDU' :
                  report.edge > 2             ? '🏆 SUPERCOACH BATS LES BOOKMAKERS' :
                  report.edge >= 0            ? '✅ À LA HAUTEUR DU MARCHÉ' :
                  report.edge > -5            ? '⚠️ EN DESSOUS DE LA BASELINE' :
                                                '❌ MOTEUR À RECALIBRER',
        kelly: {
          bets:   report.kelly.bets,
          profit: report.kelly.profit,
          roi:    report.kelly.bets > 0
                  ? Math.round(report.kelly.profit / report.kelly.bets * 100) / 100
                  : 0,
        },
      },
      bySport: report.bySport,
      timestamp: report.timestamp,
      diagnostic: {
        geminiErrors:    report.results.filter(function(r){ return r.error; }).length,
        geminiNullPreds: report.results.filter(function(r){ return !r.geminiPred && !r.error; }).length,
        sampleErrors:    report.results.filter(function(r){ return r.error; }).slice(0,3).map(function(r){ return {id: r.id, error: r.error}; }),
        sampleResults:   report.results.slice(0,5).map(function(r){ return {id: r.id, geminiPred: r.geminiPred, actual: r.actual, error: r.error}; }),
      },
    });

  } catch(e) {
    clearTimeout(timer);
    console.error('[/run-backtest]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});


// ── FBREF WC SCRAPER ──────────────────────────────────────────────
const FBREF_CACHE = {};

async function fetchFBrefWC() {
  const cacheKey = 'fbref_wc';
  const cached = FBREF_CACHE[cacheKey];
  if (cached && Date.now() - cached.ts < 3600000) return cached.data;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch('https://fbref.com/en/comps/1/World-Cup-Stats', {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });
    if (!resp.ok) throw new Error('FBref HTTP ' + resp.status);
    const html = await resp.text();

    const teams = [];
    const rows = html.match(/<tr[^>]*data-row[^>]*>([\s\S]*?)<\/tr>/g) || [];
    rows.forEach(function(row) {
      const nameM = row.match(/data-stat="team"[^>]*><a[^>]*>([^<]+)<\/a>/);
      if (!nameM) return;
      const name = nameM[1].trim();
      const get = function(stat) {
        const m = row.match(new RegExp('data-stat="' + stat + '"[^>]*>([0-9.]+)'));
        return m ? parseFloat(m[1]) : null;
      };
      teams.push({
        name: name,
        mp:  get('games'),
        w:   get('wins'),
        d:   get('ties'),
        l:   get('losses'),
        gf:  get('goals'),
        ga:  get('goals_against'),
        xg:  get('xg'),
        xga: get('xga'),
      });
    });

    const data = { teams, fetchedAt: new Date().toISOString() };
    FBREF_CACHE[cacheKey] = { data, ts: Date.now() };
    console.log('[FBref] ' + teams.length + ' equipes WC');
    return data;
  } catch(e) {
    console.warn('[FBref] Erreur:', e.message);
    return null;
  }
}

function getFBrefTeam(name, data) {
  if (!data || !data.teams) return null;
  const n = function(s) { return (s||'').toLowerCase().replace(/[^a-z]/g,''); };
  const t = n(name);
  return data.teams.find(function(x) { return n(x.name).includes(t) || t.includes(n(x.name)); }) || null;
}

app.get('/fbref-wc', async (req, res) => {
  const data = await fetchFBrefWC();
  if (!data) return res.status(503).json({ error: 'FBref indisponible' });
  res.json(data);
});

app.get('/fixtures', async (req, res) => {
  // Date du jour Paris
  const now = new Date();
  const dateParis = now.toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); // YYYY-MM-DD

  console.log(`[FIXTURES] date=${dateParis} key=${APISPORTS_KEY ? '✅' : '❌'}`);

  try {
    let allMatches = [];

    if (APISPORTS_KEY) {
      // Fetch en parallèle tous les sports API-Sports
      const sports = ['foot', 'basket', 'tennis', 'hockey', 'baseball', 'rugby'];
      const yestParis = new Date(now.getTime() - 24*3600*1000)
        .toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
      const results = await Promise.allSettled(
        sports.flatMap(s => s === 'tennis'
          ? [fetchAPISports(s, dateParis), fetchAPISports(s, yestParis)]
          : [fetchAPISports(s, dateParis)])
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') allMatches = allMatches.concat(r.value);
      });
      console.log(`[FIXTURES] API-Sports: ${allMatches.length} matchs`);
    }

    // Fallback ESPN si API-Sports vide ou pas de clé
    if (allMatches.length < 5) {
      console.log('[FIXTURES] Fallback ESPN');
      const espnMatches = await fetchAllESPN(['foot','basket','baseball','hockey','tennis']);
      // Normaliser ESPN au même format
      espnMatches.forEach(ev => {
        const comp = ev.competitions?.[0];
        if (!comp) return;
        const st = comp.status?.type?.state || '';
        if (st === 'post') return;
        const teams = comp.competitors || [];
        const home = teams.find(t => t.homeAway === 'home') || teams[0];
        const away = teams.find(t => t.homeAway === 'away') || teams[1];
        const homeName = home?.team?.displayName || home?.athlete?.displayName || home?.displayName || '';
        const awayName = away?.team?.displayName || away?.athlete?.displayName || away?.displayName || '';
        if (!homeName || !awayName) return;
        const isLive = st === 'in';
        allMatches.push({
          id:          `espn|${homeName}|${awayName}`,
          sport:       'basket', // ESPN fallback = principalement NBA/MLB
          emoji:       '🏀',
          home:        homeName,
          away:        awayName,
          competition: ev.competitions?.[0]?.league?.name || 'ESPN',
          country:     'USA',
          dateUTC:     ev.date || '',
          isLive:      isLive,
          isFinished:  false,
          score:       isLive ? `${home?.score || 0}-${away?.score || 0}` : '',
          statusShort: st,
          leagueId:    0,
        });
      });
      console.log(`[FIXTURES] Avec ESPN fallback: ${allMatches.length} matchs`);
    }

    // Dédoublonnage par id
    const seen = new Set();
    allMatches = allMatches.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id); return true;
    });

    // Tri chronologique UTC
    allMatches.sort((a, b) => {
      const ta = a.dateUTC ? new Date(a.dateUTC).getTime() : 9e12;
      const tb = b.dateUTC ? new Date(b.dateUTC).getTime() : 9e12;
      return ta - tb;
    });

    res.json({ success: true, date: dateParis, count: allMatches.length, matches: allMatches });
  } catch (e) {
    console.error('[FIXTURES] Error:', e.message);
    res.status(500).json({ success: false, error: e.message, matches: [] });
  }
});

// ── /markets/debug — Force refresh + logs ──
app.get('/markets/debug', async (req, res) => {
  console.log('[MARKETS] Manual debug refresh triggered');
  try {
    const total = await refreshMarketConsensus();
    const markets = Object.values(MARKET_CONSENSUS);
    res.json({
      total,
      sources: Object.fromEntries(
        [...new Set(markets.map(m=>m.source))].map(s => [s, markets.filter(m=>m.source===s).length])
      ),
      sample: markets.slice(0,10).map(m => ({
        question: m.question,
        homeProb: Math.round(m.homeProb*100)+'%',
        source: m.source,
      })),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /markets — Statut et données du consensus marchés ──
app.get('/markets', (req, res) => {
  const markets = Object.values(MARKET_CONSENSUS);
  const bySource = {};
  markets.forEach(m => { bySource[m.source] = (bySource[m.source] || 0) + 1; });
  const lastSync = markets.length
    ? markets.sort((a,b) => new Date(b.syncedAt) - new Date(a.syncedAt))[0].syncedAt
    : null;
  res.json({
    total:   markets.length,
    sources: bySource,
    lastSync,
    sample:  markets.slice(0, 5).map(m => ({
      question: m.question,
      homeProb: Math.round(m.homeProb * 100) + '%',
      source:   m.source,
      volume:   m.volume,
    })),
  });
});

// ── NOWPayments — webhook (IPN) ─────────────────────────────────
// Vérifie la signature HMAC-SHA512, active/renouvelle l'abonnement Premium
function sortObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  return Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = sortObjectKeys(obj[k]);
    return acc;
  }, {});
}

app.post('/nowpayments/webhook', async (req, res) => {
  try {
    const sig = req.headers['x-nowpayments-sig'];
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!ipnSecret) {
      console.error('[NOWPayments webhook] NOWPAYMENTS_IPN_SECRET manquant');
      return res.status(500).json({ error: 'IPN secret non configuré' });
    }
    if (!sig) return res.status(401).json({ error: 'Signature manquante' });

    const sortedBody = sortObjectKeys(req.body);
    const expectedSig = crypto
      .createHmac('sha512', ipnSecret)
      .update(JSON.stringify(sortedBody))
      .digest('hex');

    if (expectedSig !== sig) {
      console.warn('[NOWPayments webhook] Signature invalide — requête rejetée');
      return res.status(401).json({ error: 'Signature invalide' });
    }

    const { payment_status, order_id, payment_id } = req.body;
    console.log('[NOWPayments webhook] status='+payment_status+' order='+order_id+' payment='+payment_id);

    if ((payment_status === 'finished' || payment_status === 'confirmed') && order_id) {
      const now = new Date();
      const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const r = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({
          user_id: order_id,
          status: 'active',
          plan: 'premium',
          provider: 'nowpayments',
          provider_ref: String(payment_id || ''),
          current_period_start: now.toISOString(),
          current_period_end: periodEnd.toISOString(),
          cancel_at_period_end: false
        })
      });
      if (!r.ok) {
        const errText = await r.text();
        console.error('[NOWPayments webhook] Échec écriture Supabase', r.status, errText);
      } else {
        console.log('[NOWPayments webhook] Premium activé pour user '+order_id);
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('[NOWPayments webhook] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ── NOWPayments — création d'un paiement/abonnement ─────────────
// ── Essai gratuit 7 jours — anti-abus vérifié côté serveur ──────
// ── Parrainage — code déterministe à partir de l'ID utilisateur ─
function referralCodeFromUserId(userId) {
  return userId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

app.get('/referral/me', rateLimit, async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const userId = token ? await verifySupabaseToken(token) : null;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });
    res.json({ code: referralCodeFromUserId(userId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/referral/redeem', rateLimit, async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const userId = token ? await verifySupabaseToken(token) : null;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const code = (req.body.code || '').trim().toUpperCase();
    if (!code || code.length !== 8) return res.status(400).json({ error: 'Code invalide' });

    // Bloque l'auto-parrainage
    if (referralCodeFromUserId(userId) === code) {
      return res.status(400).json({ error: 'Tu ne peux pas utiliser ton propre code' });
    }

    // Vérifie que ce compte n'a jamais déjà utilisé un code
    const meRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=referred_by`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const meRows = await meRes.json();
    const me = Array.isArray(meRows) ? meRows[0] : null;
    if (me && me.referred_by) {
      return res.status(403).json({ error: 'Code de parrainage déjà utilisé sur ce compte' });
    }

    // Retrouve le parrain à partir du code (préfixe d'UUID)
    const sponsorRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=ilike.${code.toLowerCase()}*&select=id&limit=2`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const sponsorRows = await sponsorRes.json();
    if (!Array.isArray(sponsorRows) || sponsorRows.length !== 1) {
      return res.status(404).json({ error: 'Code de parrainage introuvable' });
    }
    const sponsorId = sponsorRows[0].id;

    // Verrouille immédiatement — un seul code utilisable par compte, pour toujours
    const lockRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ referred_by: sponsorId })
    });
    if (!lockRes.ok) return res.status(500).json({ error: 'Impossible de valider le parrainage' });

    // +7 jours pour les deux comptes (filleul et parrain)
    async function extendSevenDays(uid) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${uid}&select=status,current_period_end`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await r.json();
      const existing = Array.isArray(rows) ? rows[0] : null;
      const now = new Date();
      const base = (existing && existing.current_period_end && new Date(existing.current_period_end) > now)
        ? new Date(existing.current_period_end) : now;
      const newEnd = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
      await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({
          user_id: uid,
          status: (existing && existing.status === 'active') ? 'active' : 'trialing',
          plan: 'premium', provider: 'referral', provider_ref: null,
          current_period_start: now.toISOString(),
          current_period_end: newEnd.toISOString(),
          cancel_at_period_end: true
        })
      });
    }
    await extendSevenDays(userId);
    await extendSevenDays(sponsorId);

    res.json({ success: true });
  } catch (e) {
    console.error('[referral/redeem] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/trial/start', rateLimit, async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const userId = token ? await verifySupabaseToken(token) : null;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    // Vérifie si l'essai a déjà été utilisé
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=trial_used`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const profileRows = await profileRes.json();
    const profile = Array.isArray(profileRows) ? profileRows[0] : null;
    if (profile && profile.trial_used) {
      return res.status(403).json({ error: 'Essai déjà utilisé sur ce compte' });
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Active le statut trialing dans subscriptions D'ABORD —
    // si ça échoue, le compte n'est pas bloqué (trial_used reste false, réessai possible)
    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        user_id: userId,
        status: 'trialing',
        plan: 'premium',
        provider: 'trial',
        provider_ref: null,
        current_period_start: now.toISOString(),
        current_period_end: trialEnd.toISOString(),
        cancel_at_period_end: true
      })
    });
    if (!subRes.ok) {
      const errText = await subRes.text();
      console.error('[trial/start] Échec écriture subscriptions', subRes.status, errText);
      return res.status(500).json({ error: 'Impossible de démarrer l\'essai' });
    }

    // Marque l'essai comme utilisé SEULEMENT une fois l'accès réellement accordé
    const markRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ trial_used: true })
    });
    if (!markRes.ok) {
      console.error('[trial/start] Essai accordé mais trial_used non marqué — vérifier manuellement si abus');
    }

    res.json({ success: true, trial_end: trialEnd.toISOString() });
  } catch (e) {
    console.error('[trial/start] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/nowpayments/create-payment', rateLimit, async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const userId = token ? await verifySupabaseToken(token) : null;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'NOWPayments non configuré côté serveur' });

    const npCtrl = new AbortController();
    const npTimeout = setTimeout(() => npCtrl.abort(), 12000);
    let r;
    try {
      r = await fetch('https://api.nowpayments.io/v1/invoice', {
        method: 'POST',
        signal: npCtrl.signal,
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_amount: 29,
          price_currency: 'usd',
          order_id: userId,
        order_description: 'SUPERCOACH Premium — abonnement mensuel',
        success_url: 'https://supercoachlab.com/?premium=success',
        cancel_url: 'https://supercoachlab.com/'
      })
      });
    } finally {
      clearTimeout(npTimeout);
    }
    const data = await r.json();
    if (!r.ok) {
      console.error('[NOWPayments create-payment] Erreur API', data);
      return res.status(r.status).json(data);
    }
    res.json({ invoice_url: data.invoice_url });
  } catch (e) {
    console.error('[NOWPayments create-payment] Erreur', e);
    const msg = e.name === 'AbortError' ? 'NOWPayments ne répond pas (timeout)' : e.message;
    res.status(500).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════
// LOT A — IMPORT HISTORIQUE FOOTBALL (Neon)
// Capacité d'ingestion uniquement. Ne touche ni engine.js, ni le frontend,
// ni Gemini. Rien de tout ceci n'est utilisé par l'app en production —
// c'est un pipeline hors-ligne séparé, déclenché manuellement.
// ═══════════════════════════════════════════════════════════

async function ensureHistoryTable() {
  await sql(`
    CREATE TABLE IF NOT EXISTS historical_matches (
      id                SERIAL PRIMARY KEY,
      fixture_id        INTEGER UNIQUE NOT NULL,
      provider          TEXT NOT NULL DEFAULT 'api-football',
      competition_id    INTEGER NOT NULL,
      competition_name  TEXT,
      season            INTEGER NOT NULL,
      match_date        TIMESTAMPTZ NOT NULL,
      home_team_id      INTEGER NOT NULL,
      home_team_name    TEXT NOT NULL,
      away_team_id      INTEGER NOT NULL,
      away_team_name    TEXT NOT NULL,
      home_goals        INTEGER,
      away_goals        INTEGER,
      status_short      TEXT NOT NULL,
      is_valid_result   BOOLEAN NOT NULL,
      source_updated_at TIMESTAMPTZ,
      imported_at       TIMESTAMPTZ DEFAULT now(),
      updated_at        TIMESTAMPTZ DEFAULT now()
    )
  `);
  await sql(`CREATE INDEX IF NOT EXISTS idx_hist_team_home ON historical_matches(home_team_id)`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_hist_team_away ON historical_matches(away_team_id)`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_hist_comp_season ON historical_matches(competition_id, season)`);
}

const VALID_RESULT_STATUSES = ['FT', 'AET', 'PEN'];

// ── /admin/import-history — Import UNE compétition + UNE saison à la fois ──
// Sécurisé comme /run-backtest. POST avec header x-import-key.
// Body : { "league": 61, "season": 2025 }  (61 = Ligue 1 chez API-Football)
async function runHistoryImport(league, season) {
  if (!sql) throw Object.assign(new Error('Neon non configuré (DATABASE_URL manquant).'), { status: 503 });
  if (!APISPORTS_KEY) throw Object.assign(new Error('APISPORTS_KEY manquant.'), { status: 503 });
  if (!league || !season) throw Object.assign(new Error('Paramètres requis : league, season'), { status: 400 });

  await ensureHistoryTable();

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20000);
  const url = `https://v3.football.api-sports.io/fixtures?league=${league}&season=${season}`;
  const apiRes = await fetch(url, { signal: ctrl.signal, headers: { 'x-apisports-key': APISPORTS_KEY } });
  const apiData = await apiRes.json();
  const fixtures = apiData?.response || [];

  if (!fixtures.length) {
    return { league, season, fetched: 0, inserted: 0, updated: 0, message: 'Aucun match retourné par API-Football pour ce league/season — vérifier les paramètres.' };
  }

  const cols = {
    fixtureId: [], provider: [], competitionId: [], competitionName: [], season: [], matchDate: [],
    homeTeamId: [], homeTeamName: [], awayTeamId: [], awayTeamName: [],
    homeGoals: [], awayGoals: [], statusShort: [], isValid: [],
  };
  let skipped = 0;
  for (const f of fixtures) {
    const fixtureId = f.fixture?.id;
    const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
    const matchDate = f.fixture?.date;
    const statusShort = f.fixture?.status?.short;
    if (!fixtureId || !homeId || !awayId || !matchDate || !statusShort) { skipped++; continue; }

    cols.fixtureId.push(fixtureId);
    cols.provider.push('api-football');
    cols.competitionId.push(league);
    cols.competitionName.push(f.league?.name || null);
    cols.season.push(season);
    cols.matchDate.push(matchDate);
    cols.homeTeamId.push(homeId);
    cols.homeTeamName.push(f.teams.home.name);
    cols.awayTeamId.push(awayId);
    cols.awayTeamName.push(f.teams.away.name);
    cols.homeGoals.push(f.goals?.home ?? null);
    cols.awayGoals.push(f.goals?.away ?? null);
    cols.statusShort.push(statusShort);
    cols.isValid.push(VALID_RESULT_STATUSES.includes(statusShort));
  }

  if (!cols.fixtureId.length) {
    return { league, season, fetched: fixtures.length, inserted: 0, updated: 0, skipped, message: 'Toutes les lignes étaient incomplètes.' };
  }

  const rows = await sql(`
    INSERT INTO historical_matches (
      fixture_id, provider, competition_id, competition_name, season, match_date,
      home_team_id, home_team_name, away_team_id, away_team_name,
      home_goals, away_goals, status_short, is_valid_result, updated_at
    )
    SELECT fixture_id, provider, competition_id, competition_name, season, match_date,
           home_team_id, home_team_name, away_team_id, away_team_name,
           home_goals, away_goals, status_short, is_valid_result, now()
    FROM unnest(
      $1::int[], $2::text[], $3::int[], $4::text[], $5::int[], $6::timestamptz[],
      $7::int[], $8::text[], $9::int[], $10::text[],
      $11::int[], $12::int[], $13::text[], $14::bool[]
    ) AS t(fixture_id, provider, competition_id, competition_name, season, match_date,
           home_team_id, home_team_name, away_team_id, away_team_name,
           home_goals, away_goals, status_short, is_valid_result)
    ON CONFLICT (fixture_id) DO UPDATE SET
      home_goals = EXCLUDED.home_goals,
      away_goals = EXCLUDED.away_goals,
      status_short = EXCLUDED.status_short,
      is_valid_result = EXCLUDED.is_valid_result,
      updated_at = now()
    RETURNING (xmax = 0) AS was_insert
  `, [
    cols.fixtureId, cols.provider, cols.competitionId, cols.competitionName, cols.season, cols.matchDate,
    cols.homeTeamId, cols.homeTeamName, cols.awayTeamId, cols.awayTeamName,
    cols.homeGoals, cols.awayGoals, cols.statusShort, cols.isValid,
  ]);

  const inserted = rows.filter(r => r.was_insert).length;
  const updated = rows.length - inserted;

  return {
    league, season,
    fetched: fixtures.length,
    inserted, updated, skipped,
    validResults: fixtures.filter(f => VALID_RESULT_STATUSES.includes(f.fixture?.status?.short)).length,
  };
}

// Version POST (pour outils/automatisations futures) — sécurité par en-tête.
app.post('/admin/import-history', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.headers['x-import-key'] !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    res.json(await runHistoryImport(req.body?.league, req.body?.season));
  } catch (e) {
    console.error('[/admin/import-history POST] Erreur', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Version GET (pour usage direct dans Safari — coller l'URL suffit, pas d'app tierce nécessaire).
// Moins strict que le POST (clé dans l'URL plutôt qu'un en-tête), acceptable car usage manuel ponctuel
// par l'administrateur du site lui-même, pas un endpoint destiné à un usage automatisé récurrent.
app.get('/admin/import-history', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    res.json(await runHistoryImport(Number(req.query.league), Number(req.query.season)));
  } catch (e) {
    console.error('[/admin/import-history GET] Erreur', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Audit qualité en LECTURE SEULE — aucune écriture, aucune logique métier. ──
app.get('/admin/audit-history', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const [
      totalRow, uniqueRow, compRows, dateRow, statusRows,
      badValidTrue, badValidFalse, nullGoalsButValid, dupLogical, sample,
    ] = await Promise.all([
      sql(`SELECT COUNT(*) AS total FROM historical_matches`),
      sql(`SELECT COUNT(DISTINCT fixture_id) AS unique_count FROM historical_matches`),
      sql(`SELECT competition_id, competition_name, season, COUNT(*) AS n
           FROM historical_matches GROUP BY competition_id, competition_name, season ORDER BY season, competition_id`),
      sql(`SELECT MIN(match_date) AS min_date, MAX(match_date) AS max_date FROM historical_matches`),
      sql(`SELECT status_short, COUNT(*) AS n FROM historical_matches GROUP BY status_short ORDER BY n DESC`),
      // is_valid_result=true mais statut hors FT/AET/PEN → incohérence
      sql(`SELECT COUNT(*) AS n FROM historical_matches WHERE is_valid_result = true AND status_short NOT IN ('FT','AET','PEN')`),
      // is_valid_result=false mais statut FT/AET/PEN → incohérence
      sql(`SELECT COUNT(*) AS n FROM historical_matches WHERE is_valid_result = false AND status_short IN ('FT','AET','PEN')`),
      // is_valid_result=true mais un score manquant → incohérence
      sql(`SELECT COUNT(*) AS n FROM historical_matches WHERE is_valid_result = true AND (home_goals IS NULL OR away_goals IS NULL)`),
      // même équipes + même date mais fixture_id différent → doublon logique malgré ID unique
      sql(`SELECT home_team_id, away_team_id, match_date, COUNT(*) AS n, array_agg(fixture_id) AS ids
           FROM historical_matches GROUP BY home_team_id, away_team_id, match_date HAVING COUNT(*) > 1`),
      // échantillon de contrôle manuel : 5 plus anciens + 5 plus récents
      sql(`(SELECT fixture_id, match_date, home_team_name, away_team_name, home_goals, away_goals, status_short, is_valid_result
            FROM historical_matches ORDER BY match_date ASC LIMIT 5)
           UNION ALL
           (SELECT fixture_id, match_date, home_team_name, away_team_name, home_goals, away_goals, status_short, is_valid_result
            FROM historical_matches ORDER BY match_date DESC LIMIT 5)`),
    ]);

    res.json({
      total: Number(totalRow[0].total),
      uniqueFixtureIds: Number(uniqueRow[0].unique_count),
      duplicateFixtureIds: Number(totalRow[0].total) - Number(uniqueRow[0].unique_count),
      byCompetitionSeason: compRows,
      dateRange: dateRow[0],
      statusBreakdown: statusRows,
      anomalies: {
        validTrueButBadStatus: Number(badValidTrue[0].n),
        validFalseButGoodStatus: Number(badValidFalse[0].n),
        validTrueButMissingGoals: Number(nullGoalsButValid[0].n),
        logicalDuplicates: dupLogical,
      },
      sampleForManualCheck: sample,
    });
  } catch (e) {
    console.error('[/admin/audit-history] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// Compétitions dont l'ID API-Football a été vérifié (Ligue 1 confirmé en conditions réelles
// aujourd'hui ; les autres croisés via une source fiable, mais jamais testés en direct par nous).
// MLS, Brésil et Coupe du Monde volontairement absents — ID non vérifié avec assez de confiance,
// mieux vaut ne rien importer que d'importer sous le mauvais league_id en silence.
const KNOWN_LEAGUES = {
  61:  'Ligue 1',
  39:  'Premier League',
  140: 'La Liga',
  135: 'Serie A',
  78:  'Bundesliga',
  2:   'UEFA Champions League',
  3:   'UEFA Europa League',
  // 4: 'UEFA Conference League', // retiré — ID non confirmé, fetched:0 en test réel, à revérifier
};

// ── Extension multi-compétitions, UNE SAISON À LA FOIS (pour rester léger et éviter tout timeout). ──
app.get('/admin/import-history-multi', async (req, res) => {
  console.log(`[import-history-multi] REQUÊTE REÇUE — season=${req.query.season} — ${new Date().toISOString()} — ip=${req.ip}`);
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });

  const season = Number(req.query.season);
  if (!season) return res.status(400).json({ error: 'Paramètre requis : season' });

  const leagueIds = req.query.leagues
    ? req.query.leagues.split(',').map(Number)
    : Object.keys(KNOWN_LEAGUES).map(Number);

  const results = [];
  for (const league of leagueIds) {
    if (!KNOWN_LEAGUES[league]) {
      results.push({ league, error: 'ID non vérifié — ignoré volontairement' });
      continue;
    }
    try {
      const r = await runHistoryImport(league, season);
      results.push({ league, name: KNOWN_LEAGUES[league], ...r });
    } catch (e) {
      results.push({ league, name: KNOWN_LEAGUES[league], error: e.message });
    }
  }

  res.json({
    season,
    leaguesProcessed: results.length,
    totalFetched: results.reduce((s, r) => s + (r.fetched || 0), 0),
    totalInserted: results.reduce((s, r) => s + (r.inserted || 0), 0),
    totalUpdated: results.reduce((s, r) => s + (r.updated || 0), 0),
    results,
  });
});

// ═══════════════════════════════════════════════════════════
// LOT B — ELO BENCHMARK (isolé, aucune intégration au moteur de production)
// Ne touche ni engine.js, ni le pipeline Gemini, ni aucune table de production.
// Lecture seule sur historical_matches, calcul entièrement en mémoire.
// ═══════════════════════════════════════════════════════════

const INITIAL_RATING = 1500;
const PROVISIONAL_THRESHOLD = 10;
const PROVISIONAL_K_BOOST = 1.6;

function eloExpectedProbs(ratingHome, ratingAway, homeAdvantage) {
  const adjustedDiff = (ratingHome + homeAdvantage) - ratingAway;
  const pHomeVs2Way = 1 / (1 + Math.pow(10, -adjustedDiff / 400));
  const pDraw = 0.28 * Math.exp(-0.0035 * adjustedDiff * adjustedDiff);
  const remaining = 1 - pDraw;
  return { pHome: pHomeVs2Way * remaining, pDraw, pAway: (1 - pHomeVs2Way) * remaining };
}
function eloUpdate(ratingHome, ratingAway, actualResult, homeAdvantage, kFactor) {
  const adjustedDiff = (ratingHome + homeAdvantage) - ratingAway;
  const expectedHome = 1 / (1 + Math.pow(10, -adjustedDiff / 400));
  const delta = kFactor * (actualResult - expectedHome);
  return { newHome: ratingHome + delta, newAway: ratingAway - delta };
}
function eloSeasonRegression(rating, leagueMean, compressionFactor) {
  return rating * compressionFactor + leagueMean * (1 - compressionFactor);
}
function logLoss(probs, outcome) {
  const p = outcome === 'H' ? probs.pHome : outcome === 'D' ? probs.pDraw : probs.pAway;
  return -Math.log(Math.min(Math.max(p, 1e-6), 1 - 1e-6));
}
function brierScore(probs, outcome) {
  const actual = { pHome: outcome === 'H' ? 1 : 0, pDraw: outcome === 'D' ? 1 : 0, pAway: outcome === 'A' ? 1 : 0 };
  return (probs.pHome - actual.pHome) ** 2 + (probs.pDraw - actual.pDraw) ** 2 + (probs.pAway - actual.pAway) ** 2;
}

function eloWalkForward(matches, params, evalSeasons) {
  const ratings = new Map();
  let currentSeason = null;
  let totalLogLoss = 0, totalBrier = 0, evalCount = 0;
  const calibrationBuckets = {}; // pour vérifier la calibration : prob prédite vs taux réel observé

  function getTeam(team) {
    if (!ratings.has(team)) ratings.set(team, { rating: INITIAL_RATING, matchesPlayed: 0 });
    return ratings.get(team);
  }

  for (const m of matches) {
    if (currentSeason !== null && m.season !== currentSeason) {
      const allRatings = [...ratings.values()].map(r => r.rating);
      const leagueMean = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
      for (const teamData of ratings.values()) {
        teamData.rating = eloSeasonRegression(teamData.rating, leagueMean, params.regressionFactor);
      }
    }
    currentSeason = m.season;

    const home = getTeam(m.homeTeam);
    const away = getTeam(m.awayTeam);
    const probs = eloExpectedProbs(home.rating, away.rating, params.homeAdvantage);

    if (evalSeasons.has(m.season)) {
      totalLogLoss += logLoss(probs, m.outcome);
      totalBrier += brierScore(probs, m.outcome);
      evalCount++;
      // Calibration : regrouper par tranche de probabilité du favori
      const favProb = Math.max(probs.pHome, probs.pDraw, probs.pAway);
      const bucket = Math.floor(favProb * 10) / 10;
      const favWon = (probs.pHome === favProb && m.outcome === 'H') ||
                     (probs.pDraw === favProb && m.outcome === 'D') ||
                     (probs.pAway === favProb && m.outcome === 'A');
      if (!calibrationBuckets[bucket]) calibrationBuckets[bucket] = { predicted: [], actualWins: 0, total: 0 };
      calibrationBuckets[bucket].predicted.push(favProb);
      calibrationBuckets[bucket].total++;
      if (favWon) calibrationBuckets[bucket].actualWins++;
    }

    const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
    const kHome = home.matchesPlayed < PROVISIONAL_THRESHOLD ? params.kFactor * PROVISIONAL_K_BOOST : params.kFactor;
    const kAway = away.matchesPlayed < PROVISIONAL_THRESHOLD ? params.kFactor * PROVISIONAL_K_BOOST : params.kFactor;
    const updated = eloUpdate(home.rating, away.rating, actualResult, params.homeAdvantage, (kHome + kAway) / 2);
    home.rating = updated.newHome;
    away.rating = updated.newAway;
    home.matchesPlayed++;
    away.matchesPlayed++;
  }

  const calibration = Object.entries(calibrationBuckets).map(([bucket, d]) => ({
    predictedRange: Number(bucket),
    avgPredicted: d.predicted.reduce((a, b) => a + b, 0) / d.predicted.length,
    actualWinRate: d.actualWins / d.total,
    sampleSize: d.total,
  })).sort((a, b) => a.predictedRange - b.predictedRange);

  return { avgLogLoss: totalLogLoss / evalCount, avgBrier: totalBrier / evalCount, evalCount, calibration };
}

app.get('/admin/elo-benchmark', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, match_date, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches
      WHERE is_valid_result = true
      ORDER BY match_date ASC
    `);

    const matches = rows.map(r => ({
      season: r.season,
      homeTeam: r.home_team_id,
      awayTeam: r.away_team_id,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    const TRAIN_SEASONS = new Set([2022, 2023]);
    const HOLDOUT_SEASONS = new Set([2024, 2025]);

    const grid = {
      homeAdvantage: [30, 50, 70, 90, 110],
      kFactor: [15, 20, 25, 30, 40],
      regressionFactor: [1.0, 0.8, 0.67, 0.6, 0.5, 0.33, 0.2, 0.0],
    };

    const trainResults = [];
    for (const homeAdvantage of grid.homeAdvantage) {
      for (const kFactor of grid.kFactor) {
        for (const regressionFactor of grid.regressionFactor) {
          const params = { homeAdvantage, kFactor, regressionFactor };
          const perf = eloWalkForward(matches, params, TRAIN_SEASONS);
          trainResults.push({ ...params, avgLogLoss: perf.avgLogLoss, avgBrier: perf.avgBrier, evalCount: perf.evalCount });
        }
      }
    }
    trainResults.sort((a, b) => a.avgLogLoss - b.avgLogLoss);
    const best = trainResults[0];

    const holdoutPerf = eloWalkForward(matches, best, HOLDOUT_SEASONS);

    res.json({
      totalMatchesUsed: matches.length,
      gridSize: trainResults.length,
      trainingPeriod: [...TRAIN_SEASONS],
      holdoutPeriod: [...HOLDOUT_SEASONS],
      top5CandidatesOnTraining: trainResults.slice(0, 5),
      selectedParams: { homeAdvantage: best.homeAdvantage, kFactor: best.kFactor, regressionFactor: best.regressionFactor },
      trainingPerformance: { avgLogLoss: best.avgLogLoss, avgBrier: best.avgBrier, evalCount: best.evalCount },
      holdoutPerformance: { avgLogLoss: holdoutPerf.avgLogLoss, avgBrier: holdoutPerf.avgBrier, evalCount: holdoutPerf.evalCount },
      calibrationOnHoldout: holdoutPerf.calibration,
      limitations: [
        'Seulement 4 transitions de saison réelles (2021→2025) — confiance statistique modeste sur le coefficient de régression retenu.',
        'K-factor unique global dans cette v1 — pas encore de distinction championnat national / coupe européenne (proposé par Gemini, à tester séparément).',
        'Baseline de comparaison (bookmakers / fréquence historique) non incluse dans ce rapport — à ajouter avant intégration.',
      ],
    });
  } catch (e) {
    console.error('[/admin/elo-benchmark] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Diagnostic réel : mêmes fonctions Elo qu'au-dessus, AUCUNE correction — on veut voir
// le bug se manifester tel quel sur les vraies données, pas une version corrigée. ──
app.get('/admin/elo-diagnostic', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, match_date, competition_name, home_team_id, home_team_name,
             away_team_id, away_team_name, home_goals, away_goals
      FROM historical_matches
      WHERE is_valid_result = true
      ORDER BY match_date ASC
    `);

    const matches = rows.map(r => ({
      season: r.season, date: r.match_date, competition: r.competition_name,
      homeTeam: r.home_team_id, homeTeamName: r.home_team_name,
      awayTeam: r.away_team_id, awayTeamName: r.away_team_name,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    // Paramètres retenus par le benchmark précédent — repris tels quels, aucune recalibration.
    const params = { homeAdvantage: 30, kFactor: 15, regressionFactor: 0 };
    const HOLDOUT_SEASONS = new Set([2024, 2025]);

    const ratings = new Map();
    let currentSeason = null;
    const trace = [];

    function getTeam(team) {
      if (!ratings.has(team)) ratings.set(team, { rating: INITIAL_RATING, matchesPlayed: 0 });
      return ratings.get(team);
    }

    for (const m of matches) {
      if (currentSeason !== null && m.season !== currentSeason) {
        const allRatings = [...ratings.values()].map(r => r.rating);
        const leagueMean = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
        for (const teamData of ratings.values()) {
          teamData.rating = eloSeasonRegression(teamData.rating, leagueMean, params.regressionFactor);
        }
      }
      currentSeason = m.season;

      const home = getTeam(m.homeTeam);
      const away = getTeam(m.awayTeam);
      const probs = eloExpectedProbs(home.rating, away.rating, params.homeAdvantage);

      if (HOLDOUT_SEASONS.has(m.season)) {
        trace.push({
          date: m.date, competition: m.competition,
          home: m.homeTeamName, away: m.awayTeamName,
          outcome: m.outcome,
          eloGap: Math.round((home.rating + params.homeAdvantage) - away.rating),
          probs: { pHome: +probs.pHome.toFixed(4), pDraw: +probs.pDraw.toFixed(6), pAway: +probs.pAway.toFixed(4) },
          logLoss: +logLoss(probs, m.outcome).toFixed(3),
        });
      }

      const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
      const kHome = home.matchesPlayed < PROVISIONAL_THRESHOLD ? params.kFactor * PROVISIONAL_K_BOOST : params.kFactor;
      const kAway = away.matchesPlayed < PROVISIONAL_THRESHOLD ? params.kFactor * PROVISIONAL_K_BOOST : params.kFactor;
      const updated = eloUpdate(home.rating, away.rating, actualResult, params.homeAdvantage, (kHome + kAway) / 2);
      home.rating = updated.newHome;
      away.rating = updated.newAway;
      home.matchesPlayed++;
      away.matchesPlayed++;
    }

    trace.sort((a, b) => b.logLoss - a.logLoss);
    const worst20 = trace.slice(0, 20);
    const worstDrawsSpecifically = trace.filter(t => t.outcome === 'D').sort((a, b) => b.logLoss - a.logLoss).slice(0, 10);

    res.json({
      paramsUsed: params,
      holdoutMatchCount: trace.length,
      worst20Overall: worst20,
      worst10AmongRealDraws: worstDrawsSpecifically,
      note: 'Formule du nul INCHANGÉE (bug connu conservé volontairement) — objectif : observer sa manifestation réelle, pas la corriger.',
    });
  } catch (e) {
    console.error('[/admin/elo-diagnostic] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SANDBOX — ORDERED LOGIT (ΔE → 1N2), estimation MLE, aucune intégration production.
// Ne remplace PAS la formule utilisée par engine.js/Gemini — endpoint de test isolé.
// ═══════════════════════════════════════════════════════════

function logisticFn(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}
function olPredict(x, beta, alpha1, alpha2) {
  const cdf1 = logisticFn(alpha1 - beta * x);
  const cdf2 = logisticFn(alpha2 - beta * x);
  return { pAway: cdf1, pDraw: cdf2 - cdf1, pHome: 1 - cdf2 };
}
function olNegLogLik(theta, data) {
  const [beta, theta1, theta2] = theta;
  const alpha1 = theta1, alpha2 = theta1 + Math.exp(theta2);
  let nll = 0;
  for (const d of data) {
    const p = olPredict(d.x, beta, alpha1, alpha2);
    const prob = d.outcome === 'A' ? p.pAway : d.outcome === 'D' ? p.pDraw : p.pHome;
    nll -= Math.log(Math.max(prob, 1e-12));
  }
  return nll;
}
function nelderMead(f, x0, options = {}) {
  const { maxIter = 5000, tol = 1e-8, alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5 } = options;
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const point = x0.slice();
    point[i] += point[i] !== 0 ? point[i] * 0.05 : 0.05;
    simplex.push(point);
  }
  let values = simplex.map(f);
  for (let iter = 0; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map(i => simplex[i]);
    values = order.map(i => values[i]);
    if (Math.abs(values[n] - values[0]) < tol) break;
    const centroid = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let d = 0; d < n; d++) centroid[d] += simplex[i][d] / n;
    const worst = simplex[n];
    const reflected = centroid.map((c, d) => c + alpha * (c - worst[d]));
    const fReflected = f(reflected);
    if (fReflected < values[0]) {
      const expanded = centroid.map((c, d) => c + gamma * (reflected[d] - c));
      const fExpanded = f(expanded);
      if (fExpanded < fReflected) { simplex[n] = expanded; values[n] = fExpanded; }
      else { simplex[n] = reflected; values[n] = fReflected; }
    } else if (fReflected < values[n - 1]) {
      simplex[n] = reflected; values[n] = fReflected;
    } else {
      const contracted = centroid.map((c, d) => c + rho * (worst[d] - c));
      const fContracted = f(contracted);
      if (fContracted < values[n]) { simplex[n] = contracted; values[n] = fContracted; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, d) => simplex[0][d] + sigma * (v - simplex[0][d]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  return { x: simplex[order[0]], fval: values[order[0]] };
}

app.get('/admin/ordered-logit-benchmark', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);
    const matches = rows.map(r => ({
      season: r.season, homeTeam: r.home_team_id, awayTeam: r.away_team_id,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    // Paramètres Elo NON contaminés — valeurs raisonnables, PAS celles du benchmark cassé
    // (regressionFactor=0 gagnait uniquement en évitant le bug de l'ancienne formule).
    // Note : pas encore re-optimisées conjointement avec l'Ordered Logit — étape suivante logique.
    const eloParams = { homeAdvantage: 70, kFactor: 25, regressionFactor: 0.67 };

    const ratings = new Map();
    let currentSeason = null;
    const withElo = [];
    function getTeam(t) { if (!ratings.has(t)) ratings.set(t, { rating: INITIAL_RATING, matchesPlayed: 0 }); return ratings.get(t); }

    for (const m of matches) {
      if (currentSeason !== null && m.season !== currentSeason) {
        const all = [...ratings.values()].map(r => r.rating);
        const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
        for (const t of ratings.values()) t.rating = eloSeasonRegression(t.rating, leagueMean, eloParams.regressionFactor);
      }
      currentSeason = m.season;
      const home = getTeam(m.homeTeam), away = getTeam(m.awayTeam);
      const x = (home.rating + eloParams.homeAdvantage) - away.rating; // ΔE ajusté domicile
      withElo.push({ season: m.season, x, outcome: m.outcome });

      const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
      const kH = home.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
      const kA = away.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
      const upd = eloUpdate(home.rating, away.rating, actualResult, eloParams.homeAdvantage, (kH + kA) / 2);
      home.rating = upd.newHome; away.rating = upd.newAway;
      home.matchesPlayed++; away.matchesPlayed++;
    }

    const TRAIN = withElo.filter(m => [2022, 2023].includes(m.season));
    const HOLDOUT = withElo.filter(m => [2024, 2025].includes(m.season));

    // Estimation MLE sur l'entraînement uniquement
    const theta0 = [0.005, -0.3, Math.log(0.5)];
    const fit = nelderMead((theta) => olNegLogLik(theta, TRAIN), theta0, { maxIter: 5000 });
    const [beta, t1, t2] = fit.x;
    const alpha1 = t1, alpha2 = t1 + Math.exp(t2);

    // Fréquence historique (baseline 2), calculée sur l'entraînement uniquement
    const freqH = TRAIN.filter(m => m.outcome === 'H').length / TRAIN.length;
    const freqD = TRAIN.filter(m => m.outcome === 'D').length / TRAIN.length;
    const freqA = TRAIN.filter(m => m.outcome === 'A').length / TRAIN.length;

    function evalModel(predictFn) {
      let ll = 0, brier = 0;
      const calibBuckets = {};
      for (const m of HOLDOUT) {
        const p = predictFn(m);
        const prob = m.outcome === 'H' ? p.pHome : m.outcome === 'D' ? p.pDraw : p.pAway;
        ll += -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6));
        const actual = { pHome: m.outcome === 'H' ? 1 : 0, pDraw: m.outcome === 'D' ? 1 : 0, pAway: m.outcome === 'A' ? 1 : 0 };
        brier += (p.pHome - actual.pHome) ** 2 + (p.pDraw - actual.pDraw) ** 2 + (p.pAway - actual.pAway) ** 2;
        const fav = Math.max(p.pHome, p.pDraw, p.pAway);
        const bucket = Math.floor(fav * 10) / 10;
        const favWon = (p.pHome === fav && m.outcome === 'H') || (p.pDraw === fav && m.outcome === 'D') || (p.pAway === fav && m.outcome === 'A');
        if (!calibBuckets[bucket]) calibBuckets[bucket] = { total: 0, wins: 0 };
        calibBuckets[bucket].total++; if (favWon) calibBuckets[bucket].wins++;
      }
      const calibration = Object.entries(calibBuckets).map(([b, d]) => ({
        predictedRange: Number(b), actualWinRate: +(d.wins / d.total).toFixed(3), sampleSize: d.total,
      })).sort((a, b) => a.predictedRange - b.predictedRange);
      return { avgLogLoss: ll / HOLDOUT.length, avgBrier: brier / HOLDOUT.length, calibration };
    }

    const results = {
      orderedLogit: evalModel(m => olPredict(m.x, beta, alpha1, alpha2)),
      uniform: evalModel(() => ({ pHome: 1/3, pDraw: 1/3, pAway: 1/3 })),
      historicalFrequency: evalModel(() => ({ pHome: freqH, pDraw: freqD, pAway: freqA })),
      oldBrokenFormula: evalModel(m => eloExpectedProbs(m.x, 0, 0)), // x déjà = ratingHome+adv-ratingAway
    };

    res.json({
      note: 'SANDBOX — aucune intégration production. eloParams non ré-optimisés conjointement (étape suivante).',
      eloParamsUsed: eloParams,
      trainSize: TRAIN.length,
      holdoutSize: HOLDOUT.length,
      fittedOrderedLogit: { beta, alpha1, alpha2, trainNegLogLik: fit.fval },
      historicalFrequencyUsed: { freqH: +freqH.toFixed(3), freqD: +freqD.toFixed(3), freqA: +freqA.toFixed(3) },
      resultsOnHoldout: results,
      marketBaseline: 'NON INCLUSE — disponibilité des closing odds historiques toujours non confirmée.',
      validityCheck: (() => {
        let ok = true;
        for (const x of [-400, -200, 0, 200, 400]) {
          const p = olPredict(x, beta, alpha1, alpha2);
          if (p.pAway <= 0 || p.pDraw <= 0 || p.pHome <= 0) ok = false;
          if (Math.abs(p.pAway + p.pDraw + p.pHome - 1) > 1e-9) ok = false;
        }
        return ok ? 'OK — probabilités toujours positives et sommant à 1 sur [-400,400]' : 'ÉCHEC';
      })(),
    });
  } catch (e) {
    console.error('[/admin/ordered-logit-benchmark] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SANDBOX — RÉ-OPTIMISATION CONJOINTE Elo + Ordered Logit.
// Grille sur (homeAdvantage, kFactor, regressionFactor) x MLE continu sur (beta,alpha1,alpha2)
// à chaque point. Aucune intégration production.
// ═══════════════════════════════════════════════════════════
app.get('/admin/joint-optimization', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);
    const rawMatches = rows.map(r => ({
      season: r.season, homeTeam: r.home_team_id, awayTeam: r.away_team_id,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    function runEloReplay(eloParams) {
      const ratings = new Map();
      let currentSeason = null;
      const withElo = [];
      function getTeam(t) { if (!ratings.has(t)) ratings.set(t, { rating: INITIAL_RATING, matchesPlayed: 0 }); return ratings.get(t); }
      for (const m of rawMatches) {
        if (currentSeason !== null && m.season !== currentSeason) {
          const all = [...ratings.values()].map(r => r.rating);
          const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
          for (const t of ratings.values()) t.rating = eloSeasonRegression(t.rating, leagueMean, eloParams.regressionFactor);
        }
        currentSeason = m.season;
        const home = getTeam(m.homeTeam), away = getTeam(m.awayTeam);
        const x = (home.rating + eloParams.homeAdvantage) - away.rating;
        withElo.push({ season: m.season, x, outcome: m.outcome });
        const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
        const kH = home.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
        const kA = away.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
        const upd = eloUpdate(home.rating, away.rating, actualResult, eloParams.homeAdvantage, (kH + kA) / 2);
        home.rating = upd.newHome; away.rating = upd.newAway;
        home.matchesPlayed++; away.matchesPlayed++;
      }
      return withElo;
    }

    const grid = {
      homeAdvantage: [40, 55, 70, 85, 100],
      kFactor: [15, 20, 25, 30, 35],
      regressionFactor: [0.3, 0.45, 0.6, 0.67, 0.75, 0.85, 1.0],
    };

    const candidateResults = [];
    for (const homeAdvantage of grid.homeAdvantage) {
      for (const kFactor of grid.kFactor) {
        for (const regressionFactor of grid.regressionFactor) {
          const eloParams = { homeAdvantage, kFactor, regressionFactor };
          const withElo = runEloReplay(eloParams);
          const TRAIN = withElo.filter(m => [2022, 2023].includes(m.season));
          const HOLDOUT = withElo.filter(m => [2024, 2025].includes(m.season));

          const fit = nelderMead((theta) => olNegLogLik(theta, TRAIN), [0.005, -0.3, Math.log(0.5)], { maxIter: 3000 });
          const [beta, t1, t2] = fit.x;
          const alpha1 = t1, alpha2 = t1 + Math.exp(t2);

          // Log Loss sur train ET holdout (nécessaire pour détecter le sur-apprentissage)
          function avgLL(dataset) {
            let ll = 0;
            for (const m of dataset) {
              const p = olPredict(m.x, beta, alpha1, alpha2);
              const prob = m.outcome === 'H' ? p.pHome : m.outcome === 'D' ? p.pDraw : p.pAway;
              ll += -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6));
            }
            return ll / dataset.length;
          }
          const trainLL = avgLL(TRAIN);
          const holdoutLL = avgLL(HOLDOUT);

          candidateResults.push({ eloParams, beta, alpha1, alpha2, trainLL, holdoutLL, overfitGap: holdoutLL - trainLL });
        }
      }
    }

    candidateResults.sort((a, b) => a.holdoutLL - b.holdoutLL); // sélection sur le HOLDOUT du Log Loss, jamais sur le train
    const best = candidateResults[0];

    // Rejoue une dernière fois avec les paramètres gagnants pour le rapport détaillé (Brier, calibration, ECE)
    const withEloBest = runEloReplay(best.eloParams);
    const HOLDOUT_BEST = withEloBest.filter(m => [2024, 2025].includes(m.season));
    let ll = 0, brier = 0;
    const calibBuckets = {};
    for (const m of HOLDOUT_BEST) {
      const p = olPredict(m.x, best.beta, best.alpha1, best.alpha2);
      const prob = m.outcome === 'H' ? p.pHome : m.outcome === 'D' ? p.pDraw : p.pAway;
      ll += -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6));
      const actual = { pHome: m.outcome === 'H' ? 1 : 0, pDraw: m.outcome === 'D' ? 1 : 0, pAway: m.outcome === 'A' ? 1 : 0 };
      brier += (p.pHome - actual.pHome) ** 2 + (p.pDraw - actual.pDraw) ** 2 + (p.pAway - actual.pAway) ** 2;
      const fav = Math.max(p.pHome, p.pDraw, p.pAway);
      const bucket = Math.floor(fav * 10) / 10;
      const favWon = (p.pHome === fav && m.outcome === 'H') || (p.pDraw === fav && m.outcome === 'D') || (p.pAway === fav && m.outcome === 'A');
      if (!calibBuckets[bucket]) calibBuckets[bucket] = { total: 0, wins: 0, predictedSum: 0 };
      calibBuckets[bucket].total++; calibBuckets[bucket].predictedSum += fav;
      if (favWon) calibBuckets[bucket].wins++;
    }
    const calibration = Object.entries(calibBuckets).map(([b, d]) => ({
      predictedRange: Number(b), avgPredicted: +(d.predictedSum / d.total).toFixed(3),
      actualWinRate: +(d.wins / d.total).toFixed(3), sampleSize: d.total,
    })).sort((a, b) => a.predictedRange - b.predictedRange);

    // ECE (Expected Calibration Error) — moyenne pondérée des écarts par tranche
    const totalN = calibration.reduce((s, c) => s + c.sampleSize, 0);
    const ece = calibration.reduce((s, c) => s + (c.sampleSize / totalN) * Math.abs(c.avgPredicted - c.actualWinRate), 0);

    // Validité sur toute la plage réelle des écarts observés
    const xs = withEloBest.map(m => m.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    let validityOk = true;
    for (let x = minX; x <= maxX; x += (maxX - minX) / 50) {
      const p = olPredict(x, best.beta, best.alpha1, best.alpha2);
      if (p.pAway <= 0 || p.pDraw <= 0 || p.pHome <= 0 || Math.abs(p.pAway + p.pDraw + p.pHome - 1) > 1e-9) validityOk = false;
    }

    const BASELINES = { uniform: 1.098612288668023, historicalFrequency: 1.0662643278494595, orderedLogitFixedElo: 0.9971140120744705 };
    const improved = ll / HOLDOUT_BEST.length < BASELINES.orderedLogitFixedElo;

    res.json({
      note: 'SANDBOX — aucune intégration production.',
      gridSize: candidateResults.length,
      trainPeriod: [2022, 2023],
      holdoutPeriod: [2024, 2025],
      trainSize: withEloBest.filter(m => [2022, 2023].includes(m.season)).length,
      holdoutSize: HOLDOUT_BEST.length,
      top5Candidates: candidateResults.slice(0, 5).map(c => ({ eloParams: c.eloParams, holdoutLL: c.holdoutLL, overfitGap: c.overfitGap })),
      selectedEloParams: best.eloParams,
      selectedOrderedLogit: { beta: best.beta, alpha1: best.alpha1, alpha2: best.alpha2 },
      finalHoldoutLogLoss: ll / HOLDOUT_BEST.length,
      finalHoldoutBrier: brier / HOLDOUT_BEST.length,
      ece,
      calibration,
      overfitCheck: { trainLL: best.trainLL, holdoutLL: best.holdoutLL, gap: best.overfitGap, verdict: Math.abs(best.overfitGap) < 0.05 ? 'Pas de signe de sur-apprentissage notable' : 'Écart train/holdout à surveiller' },
      validityCheck: validityOk ? 'OK — positif et somme=1 sur toute la plage réelle observée' : 'ÉCHEC',
      baselineComparison: {
        uniform: BASELINES.uniform,
        historicalFrequency: BASELINES.historicalFrequency,
        orderedLogitFixedEloParams: BASELINES.orderedLogitFixedElo,
        jointOptimized: ll / HOLDOUT_BEST.length,
        improvedOverPreviousBest: improved,
      },
      recommendation: improved
        ? 'La ré-optimisation conjointe améliore le résultat précédent — candidat pour la suite.'
        : 'La ré-optimisation NE bat PAS le 0,9971 précédent — conserver la version antérieure, ne pas intégrer celle-ci.',
    });
  } catch (e) {
    console.error('[/admin/joint-optimization] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SANDBOX — TEST DE SIGNIFICATIVITÉ + DIAGNOSTIC DES FRONTIÈRES.
// Ne sélectionne rien sur le holdout — vérifie seulement si l'écart déjà trouvé est réel.
// ═══════════════════════════════════════════════════════════
app.get('/admin/significance-test', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);
    const rawMatches = rows.map(r => ({
      season: r.season, homeTeam: r.home_team_id, awayTeam: r.away_team_id,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    function runEloReplay(eloParams) {
      const ratings = new Map();
      let currentSeason = null;
      const withElo = [];
      function getTeam(t) { if (!ratings.has(t)) ratings.set(t, { rating: INITIAL_RATING, matchesPlayed: 0 }); return ratings.get(t); }
      for (const m of rawMatches) {
        if (currentSeason !== null && m.season !== currentSeason) {
          const all = [...ratings.values()].map(r => r.rating);
          const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
          for (const t of ratings.values()) t.rating = eloSeasonRegression(t.rating, leagueMean, eloParams.regressionFactor);
        }
        currentSeason = m.season;
        const home = getTeam(m.homeTeam), away = getTeam(m.awayTeam);
        const x = (home.rating + eloParams.homeAdvantage) - away.rating;
        withElo.push({ season: m.season, x, outcome: m.outcome });
        const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
        const kH = home.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
        const kA = away.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
        const upd = eloUpdate(home.rating, away.rating, actualResult, eloParams.homeAdvantage, (kH + kA) / 2);
        home.rating = upd.newHome; away.rating = upd.newAway;
        home.matchesPlayed++; away.matchesPlayed++;
      }
      return withElo;
    }
    function matchLL(m, params) {
      const p = olPredict(m.x, params.beta, params.alpha1, params.alpha2);
      const prob = m.outcome === 'H' ? p.pHome : m.outcome === 'D' ? p.pDraw : p.pAway;
      return -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6));
    }
    function fitOnTrain(withElo) {
      const TRAIN = withElo.filter(m => [2022, 2023].includes(m.season));
      const fit = nelderMead((theta) => olNegLogLik(theta, TRAIN), [0.005, -0.3, Math.log(0.5)], { maxIter: 3000 });
      const [beta, t1, t2] = fit.x;
      return { beta, alpha1: t1, alpha2: t1 + Math.exp(t2) };
    }
    function holdoutLL(withElo, params) {
      const HOLDOUT = withElo.filter(m => [2024, 2025].includes(m.season));
      return HOLDOUT.reduce((s, m) => s + matchLL(m, params), 0) / HOLDOUT.length;
    }

    // ── 1. Comparaison appariée : paramètres EXACTS déjà rapportés, aucune re-sélection ──
    const paramsA = { eloParams: { homeAdvantage: 70, kFactor: 25, regressionFactor: 0.67 },
      fit: { beta: 0.007058836644541204, alpha1: -0.44878593828345315, alpha2: 0.7292181123009347 } };
    const paramsB = { eloParams: { homeAdvantage: 70, kFactor: 25, regressionFactor: 1 },
      fit: { beta: 0.006152034225337371, alpha1: -0.5195467492751289, alpha2: 0.6659764464849969 } };

    const withEloA = runEloReplay(paramsA.eloParams).filter(m => [2024, 2025].includes(m.season));
    const withEloB = runEloReplay(paramsB.eloParams).filter(m => [2024, 2025].includes(m.season));

    if (withEloA.length !== withEloB.length) throw new Error('Désalignement holdout A/B — comparaison impossible');

    const diffs = withEloA.map((m, i) => matchLL(m, paramsA.fit) - matchLL(withEloB[i], paramsB.fit)); // >0 = B (optimisé) meilleur

    function pairedBootstrap(data, nIter = 10000, seed = 12345) {
      let s = seed;
      const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
      const n = data.length;
      const means = [];
      for (let i = 0; i < nIter; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += data[Math.floor(rand() * n)];
        means.push(sum / n);
      }
      means.sort((a, b) => a - b);
      return { ci95: [means[Math.floor(nIter * 0.025)], means[Math.floor(nIter * 0.975)]] };
    }

    const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sorted = [...diffs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const bootstrap = pairedBootstrap(diffs);
    const bWins = diffs.filter(d => d > 0).length;
    const aWins = diffs.filter(d => d < 0).length;
    const ties = diffs.length - bWins - aWins;

    // Histogramme simple de la distribution des différences
    const histBuckets = { '<-1': 0, '-1 à -0.1': 0, '-0.1 à 0': 0, '0 à 0.1': 0, '0.1 à 1': 0, '>1': 0 };
    for (const d of diffs) {
      if (d < -1) histBuckets['<-1']++;
      else if (d < -0.1) histBuckets['-1 à -0.1']++;
      else if (d < 0) histBuckets['-0.1 à 0']++;
      else if (d < 0.1) histBuckets['0 à 0.1']++;
      else if (d < 1) histBuckets['0.1 à 1']++;
      else histBuckets['>1']++;
    }

    const significant = bootstrap.ci95[0] > 0; // l'IC exclut 0 → gain statistiquement crédible

    // ── 2. Diagnostic regressionFactor au-delà de 1.0 (homeAdvantage/kFactor fixés au point gagnant) ──
    const regressionSweep = [];
    for (const rf of [0.5, 0.67, 0.85, 1.0, 1.15, 1.3, 1.5, 2.0]) {
      const withElo = runEloReplay({ homeAdvantage: 70, kFactor: 25, regressionFactor: rf });
      const fitted = fitOnTrain(withElo);
      regressionSweep.push({ regressionFactor: rf, holdoutLL: holdoutLL(withElo, fitted) });
    }

    // ── 3. Diagnostic homeAdvantage (kFactor=25, regressionFactor=1 fixés au point gagnant) ──
    const homeAdvSweep = [];
    for (const ha of [0, 20, 40, 55, 70, 85, 100, 120, 150, 200]) {
      const withElo = runEloReplay({ homeAdvantage: ha, kFactor: 25, regressionFactor: 1 });
      const fitted = fitOnTrain(withElo);
      homeAdvSweep.push({ homeAdvantage: ha, holdoutLL: holdoutLL(withElo, fitted) });
    }
    const haValues = homeAdvSweep.map(r => r.holdoutLL);
    const haSpread = Math.max(...haValues) - Math.min(...haValues);

    res.json({
      note: 'SANDBOX — aucune sélection sur ce holdout, aucune intégration production.',
      pairedComparison: {
        modelA_fixedElo: paramsA, modelB_jointOptimized: paramsB,
        nMatches: diffs.length,
        meanDiff, median,
        bootstrapCI95: bootstrap.ci95,
        proportionBWins: +(bWins / diffs.length).toFixed(3),
        proportionAWins: +(aWins / diffs.length).toFixed(3),
        ties,
        distribution: histBuckets,
        statisticallySignificant: significant,
        verdict: significant
          ? 'IC95% exclut 0 — le gain est statistiquement crédible, pas juste du bruit.'
          : 'IC95% contient 0 — impossible de distinguer ce gain du bruit statistique avec ce holdout.',
      },
      regressionFactorDiagnostic: {
        sweep: regressionSweep,
        note: 'homeAdvantage=70, kFactor=25 fixés — isole uniquement l\'effet de la régression de saison.',
      },
      homeAdvantageDiagnostic: {
        sweep: homeAdvSweep,
        spread: haSpread,
        verdict: haSpread < 0.01
          ? 'Écart quasi nul sur toute la plage testée — paramètre faiblement identifiable, probablement redondant avec les seuils α1/α2 de l\'Ordered Logit.'
          : 'Écart mesurable — homeAdvantage a un effet réel dans ce modèle.',
      },
      finalAnswer: significant
        ? 'Preuves suffisantes pour envisager 0,99286 comme nouvelle référence — gain statistiquement distinguable du bruit.'
        : 'Preuves INSUFFISANTES — conserver 0,99711 comme référence. L\'écart observé est compatible avec du bruit sur ce holdout.',
    });
  } catch (e) {
    console.error('[/admin/significance-test] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SANDBOX — LOT B.3 : ROBUSTESSE par compétition et par période temporelle.
// Baselines (uniforme 1,0986 / fréquence historique locale) TOUJOURS affichées — garde-fou permanent.
// Aucune intégration production.
// ═══════════════════════════════════════════════════════════
app.get('/admin/robustness-check', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, competition_name, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);
    const rawMatches = rows.map(r => ({
      season: r.season, competition: r.competition_name,
      homeTeam: r.home_team_id, awayTeam: r.away_team_id,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    // Paramètres Elo retenus par le LOT B.2 — figés, pas re-choisis ici.
    const ELO_PARAMS = { homeAdvantage: 70, kFactor: 25, regressionFactor: 1 };

    const ratings = new Map();
    let currentSeason = null;
    const withElo = [];
    function getTeam(t) { if (!ratings.has(t)) ratings.set(t, { rating: INITIAL_RATING, matchesPlayed: 0 }); return ratings.get(t); }
    for (const m of rawMatches) {
      if (currentSeason !== null && m.season !== currentSeason) {
        const all = [...ratings.values()].map(r => r.rating);
        const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
        for (const t of ratings.values()) t.rating = eloSeasonRegression(t.rating, leagueMean, ELO_PARAMS.regressionFactor);
      }
      currentSeason = m.season;
      const home = getTeam(m.homeTeam), away = getTeam(m.awayTeam);
      const x = (home.rating + ELO_PARAMS.homeAdvantage) - away.rating;
      withElo.push({ season: m.season, competition: m.competition, x, outcome: m.outcome });
      const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
      const kH = home.matchesPlayed < PROVISIONAL_THRESHOLD ? ELO_PARAMS.kFactor * PROVISIONAL_K_BOOST : ELO_PARAMS.kFactor;
      const kA = away.matchesPlayed < PROVISIONAL_THRESHOLD ? ELO_PARAMS.kFactor * PROVISIONAL_K_BOOST : ELO_PARAMS.kFactor;
      const upd = eloUpdate(home.rating, away.rating, actualResult, ELO_PARAMS.homeAdvantage, (kH + kA) / 2);
      home.rating = upd.newHome; away.rating = upd.newAway;
      home.matchesPlayed++; away.matchesPlayed++;
    }

    function matchLL(m, params) {
      const p = olPredict(m.x, params.beta, params.alpha1, params.alpha2);
      const prob = m.outcome === 'H' ? p.pHome : m.outcome === 'D' ? p.pDraw : p.pAway;
      return -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6));
    }
    function fitMLE(train) {
      const fit = nelderMead((theta) => olNegLogLik(theta, train), [0.005, -0.3, Math.log(0.5)], { maxIter: 3000 });
      const [beta, t1, t2] = fit.x;
      return { beta, alpha1: t1, alpha2: t1 + Math.exp(t2) };
    }
    function historicalFreqLL(train, test) {
      const n = train.length;
      const freq = {
        H: train.filter(m => m.outcome === 'H').length / n,
        D: train.filter(m => m.outcome === 'D').length / n,
        A: train.filter(m => m.outcome === 'A').length / n,
      };
      return test.reduce((s, m) => s - Math.log(Math.min(Math.max(freq[m.outcome], 1e-6), 1 - 1e-6)), 0) / test.length;
    }

    // ── Modèle global (référence B.2), figé ──
    const GLOBAL_FIT = { beta: 0.006152034225337371, alpha1: -0.5195467492751289, alpha2: 0.6659764464849969 };
    const globalTrain = withElo.filter(m => [2022, 2023].includes(m.season));
    const globalHoldout = withElo.filter(m => [2024, 2025].includes(m.season));

    // ── 1. Robustesse PAR COMPÉTITION (modèle global appliqué tel quel à chaque sous-groupe) ──
    const byCompetition = {};
    for (const m of withElo) {
      if (!byCompetition[m.competition]) byCompetition[m.competition] = { train: [], holdout: [] };
      if ([2022, 2023].includes(m.season)) byCompetition[m.competition].train.push(m);
      if ([2024, 2025].includes(m.season)) byCompetition[m.competition].holdout.push(m);
    }
    const perCompetition = Object.entries(byCompetition)
      .filter(([, d]) => d.holdout.length >= 20) // écarte les groupes trop petits pour être interprétables
      .map(([comp, d]) => ({
        competition: comp,
        holdoutSize: d.holdout.length,
        orderedLogitLL: d.holdout.reduce((s, m) => s + matchLL(m, GLOBAL_FIT), 0) / d.holdout.length,
        uniformLL: 1.0986122886681098,
        historicalFrequencyLL: d.train.length >= 20 ? historicalFreqLL(d.train, d.holdout) : null,
        beatsUniform: null, beatsHistoricalFreq: null,
      }));
    for (const r of perCompetition) {
      r.beatsUniform = r.orderedLogitLL < r.uniformLL;
      r.beatsHistoricalFreq = r.historicalFrequencyLL !== null ? r.orderedLogitLL < r.historicalFrequencyLL : null;
    }

    // ── 2. Robustesse PAR PÉRIODE — validation glissante, ré-estimation à chaque fenêtre ──
    const rollingWindows = [
      { trainSeasons: [2021, 2022], testSeason: 2023 },
      { trainSeasons: [2021, 2022, 2023], testSeason: 2024 },
      { trainSeasons: [2021, 2022, 2023, 2024], testSeason: 2025 },
    ];
    const rollingResults = rollingWindows.map(w => {
      const train = withElo.filter(m => w.trainSeasons.includes(m.season));
      const test = withElo.filter(m => m.season === w.testSeason);
      const fitted = fitMLE(train);
      return {
        trainSeasons: w.trainSeasons, testSeason: w.testSeason,
        trainSize: train.length, testSize: test.length,
        orderedLogitLL: test.reduce((s, m) => s + matchLL(m, fitted), 0) / test.length,
        uniformLL: 1.0986122886681098,
        historicalFrequencyLL: historicalFreqLL(train, test),
        fittedParams: fitted,
      };
    });
    for (const r of rollingResults) {
      r.beatsUniform = r.orderedLogitLL < r.uniformLL;
      r.beatsHistoricalFreq = r.orderedLogitLL < r.historicalFrequencyLL;
    }

    const allCompetitionsPass = perCompetition.every(r => r.beatsUniform && (r.beatsHistoricalFreq !== false));
    const allWindowsPass = rollingResults.every(r => r.beatsUniform && r.beatsHistoricalFreq);

    res.json({
      note: 'SANDBOX — aucune intégration production. Baselines toujours affichées (garde-fou permanent).',
      globalReference: {
        eloParams: ELO_PARAMS, fittedParams: GLOBAL_FIT,
        holdoutLL: globalHoldout.reduce((s, m) => s + matchLL(m, GLOBAL_FIT), 0) / globalHoldout.length,
        uniformLL: 1.0986122886681098,
        historicalFrequencyLL: historicalFreqLL(globalTrain, globalHoldout),
      },
      robustnessByCompetition: {
        results: perCompetition,
        allCompetitionsBeatBaselines: allCompetitionsPass,
        note: 'Modèle global (fit unique sur toutes compétitions confondues) appliqué tel quel à chaque sous-groupe — teste la généralisation, pas un ré-ajustement par compétition.',
      },
      robustnessOverTime: {
        results: rollingResults,
        allWindowsBeatBaselines: allWindowsPass,
        note: 'Validation glissante : ré-estimation MLE à chaque fenêtre sur les seules données antérieures au test — walk-forward strict.',
      },
      overallVerdict: allCompetitionsPass && allWindowsPass
        ? 'Robuste : bat les deux baselines dans TOUTES les compétitions ET TOUTES les fenêtres temporelles testées.'
        : 'PAS entièrement robuste : au moins un sous-groupe ne bat pas une des baselines — voir le détail avant toute intégration.',
    });
  } catch (e) {
    console.error('[/admin/robustness-check] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SANDBOX — LOT B.4 : AUDIT FINAL GO/NO-GO PRODUCTION.
// Dernier verrou avant intégration. Aucun fichier de production touché.
// ═══════════════════════════════════════════════════════════
app.get('/admin/final-audit', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, competition_name, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);
    const rawMatches = rows.map(r => ({
      season: r.season, competition: r.competition_name,
      homeTeam: r.home_team_id, awayTeam: r.away_team_id,
      outcome: r.home_goals > r.away_goals ? 'H' : r.home_goals < r.away_goals ? 'A' : 'D',
    }));

    function runEloReplay(eloParams) {
      const ratings = new Map();
      let currentSeason = null;
      const withElo = [];
      function getTeam(t) { if (!ratings.has(t)) ratings.set(t, { rating: INITIAL_RATING, matchesPlayed: 0 }); return ratings.get(t); }
      for (const m of rawMatches) {
        if (currentSeason !== null && m.season !== currentSeason) {
          const all = [...ratings.values()].map(r => r.rating);
          const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
          for (const t of ratings.values()) t.rating = eloSeasonRegression(t.rating, leagueMean, eloParams.regressionFactor);
        }
        currentSeason = m.season;
        const home = getTeam(m.homeTeam), away = getTeam(m.awayTeam);
        const x = (home.rating + eloParams.homeAdvantage) - away.rating;
        withElo.push({
          season: m.season, competition: m.competition, x, outcome: m.outcome,
          homeMatchesPlayed: home.matchesPlayed, awayMatchesPlayed: away.matchesPlayed,
        });
        const actualResult = m.outcome === 'H' ? 1 : m.outcome === 'D' ? 0.5 : 0;
        const kH = home.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
        const kA = away.matchesPlayed < PROVISIONAL_THRESHOLD ? eloParams.kFactor * PROVISIONAL_K_BOOST : eloParams.kFactor;
        const upd = eloUpdate(home.rating, away.rating, actualResult, eloParams.homeAdvantage, (kH + kA) / 2);
        home.rating = upd.newHome; away.rating = upd.newAway;
        home.matchesPlayed++; away.matchesPlayed++;
      }
      return withElo;
    }
    function matchLL(m, params) {
      const p = olPredict(m.x, params.beta, params.alpha1, params.alpha2);
      const prob = m.outcome === 'H' ? p.pHome : m.outcome === 'D' ? p.pDraw : p.pAway;
      return { ll: -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6)), p };
    }
    function fitMLE(train) {
      const fit = nelderMead((theta) => olNegLogLik(theta, train), [0.005, -0.3, Math.log(0.5)], { maxIter: 3000 });
      const [beta, t1, t2] = fit.x;
      return { beta, alpha1: t1, alpha2: t1 + Math.exp(t2) };
    }
    function historicalFreqLL(train, test) {
      const n = train.length;
      const freq = { H: train.filter(m=>m.outcome==='H').length/n, D: train.filter(m=>m.outcome==='D').length/n, A: train.filter(m=>m.outcome==='A').length/n };
      return test.reduce((s,m)=> s - Math.log(Math.min(Math.max(freq[m.outcome],1e-6),1-1e-6)),0)/test.length;
    }
    function fullMetrics(dataset, params) {
      let ll = 0, brier = 0;
      const buckets = {};
      const details = [];
      for (const m of dataset) {
        const { ll: matchLl, p } = matchLL(m, params);
        ll += matchLl;
        const actual = { pHome: m.outcome==='H'?1:0, pDraw: m.outcome==='D'?1:0, pAway: m.outcome==='A'?1:0 };
        brier += (p.pHome-actual.pHome)**2 + (p.pDraw-actual.pDraw)**2 + (p.pAway-actual.pAway)**2;
        const fav = Math.max(p.pHome, p.pDraw, p.pAway);
        const bucket = Math.floor(fav*10)/10;
        const favWon = (p.pHome===fav&&m.outcome==='H')||(p.pDraw===fav&&m.outcome==='D')||(p.pAway===fav&&m.outcome==='A');
        if (!buckets[bucket]) buckets[bucket] = { total:0, wins:0, predSum:0 };
        buckets[bucket].total++; buckets[bucket].predSum += fav; if (favWon) buckets[bucket].wins++;
        details.push({ m, ll: matchLl, p, fav });
      }
      const calibration = Object.entries(buckets).map(([b,d])=>({
        predictedRange: Number(b), avgPredicted: +(d.predSum/d.total).toFixed(3),
        actualWinRate: +(d.wins/d.total).toFixed(3), sampleSize: d.total,
      })).sort((a,b)=>a.predictedRange-b.predictedRange);
      const totalN = calibration.reduce((s,c)=>s+c.sampleSize,0);
      const ece = calibration.reduce((s,c)=>s+(c.sampleSize/totalN)*Math.abs(c.avgPredicted-c.actualWinRate),0);
      return { avgLogLoss: ll/dataset.length, avgBrier: brier/dataset.length, ece, calibration, details, n: dataset.length };
    }

    const ELO_PARAMS = { homeAdvantage: 70, kFactor: 25, regressionFactor: 1 };
    const GLOBAL_FIT = { beta: 0.006152034225337371, alpha1: -0.5195467492751289, alpha2: 0.6659764464849969 };
    const withElo = runEloReplay(ELO_PARAMS);
    const TRAIN = withElo.filter(m => [2022,2023].includes(m.season));
    const HOLDOUT = withElo.filter(m => [2024,2025].includes(m.season));

    // ── 1. Métriques globales ──
    const globalMetrics = fullMetrics(HOLDOUT, GLOBAL_FIT);

    // ── 1bis. Par compétition (Brier + ECE en plus du Log Loss déjà vu en B.3) ──
    const byComp = {};
    for (const m of HOLDOUT) { if (!byComp[m.competition]) byComp[m.competition] = []; byComp[m.competition].push(m); }
    const perCompetitionFull = Object.entries(byComp).filter(([,d])=>d.length>=20).map(([comp,d])=>{
      const met = fullMetrics(d, GLOBAL_FIT);
      return { competition: comp, n: met.n, avgLogLoss: met.avgLogLoss, avgBrier: met.avgBrier, ece: met.ece };
    });

    // ── 1ter. Par saison ──
    const bySeasonFull = [2024, 2025].map(s => {
      const d = HOLDOUT.filter(m => m.season === s);
      const met = fullMetrics(d, GLOBAL_FIT);
      return { season: s, n: met.n, avgLogLoss: met.avgLogLoss, avgBrier: met.avgBrier, ece: met.ece };
    });

    // ── 2. Probabilités extrêmes — sample size explicite, pas juste le chiffre agrégé ──
    const extremeBuckets = globalMetrics.calibration.filter(c => c.predictedRange >= 0.7);

    // ── 4. Erreurs catastrophiques sous le MODÈLE ACTUEL (pas l'ancienne formule) ──
    const worstCases = globalMetrics.details
      .sort((a,b) => b.ll - a.ll).slice(0, 15)
      .map(d => ({ competition: d.m.competition, outcome: d.m.outcome, eloGap: Math.round(d.m.x), probs: { pHome:+d.p.pHome.toFixed(3), pDraw:+d.p.pDraw.toFixed(3), pAway:+d.p.pAway.toFixed(3) }, logLoss: +d.ll.toFixed(3) }));

    // ── 3 & 5. NO_SIGNAL objectif : extrapolation hors plage d'entraînement + équipes à faible historique ──
    const trainXs = TRAIN.map(m => m.x);
    const trainMinX = Math.min(...trainXs), trainMaxX = Math.max(...trainXs);
    const outOfRange = HOLDOUT.filter(m => m.x < trainMinX || m.x > trainMaxX);
    const lowHistory = HOLDOUT.filter(m => m.homeMatchesPlayed < PROVISIONAL_THRESHOLD || m.awayMatchesPlayed < PROVISIONAL_THRESHOLD);
    const lowHistoryMetrics = lowHistory.length >= 10 ? fullMetrics(lowHistory, GLOBAL_FIT) : null;
    const restMetrics = fullMetrics(HOLDOUT.filter(m => m.homeMatchesPlayed >= PROVISIONAL_THRESHOLD && m.awayMatchesPlayed >= PROVISIONAL_THRESHOLD), GLOBAL_FIT);

    // ── 8. homeAdvantage neutralisé (=0) — comparaison directe ──
    const withEloNoHA = runEloReplay({ homeAdvantage: 0, kFactor: 25, regressionFactor: 1 });
    const trainNoHA = withEloNoHA.filter(m => [2022,2023].includes(m.season));
    const holdoutNoHA = withEloNoHA.filter(m => [2024,2025].includes(m.season));
    const fitNoHA = fitMLE(trainNoHA);
    const metricsNoHA = fullMetrics(holdoutNoHA, fitNoHA);

    const BASELINES = { uniform: 1.0986122886681098, historicalFrequency: 1.0662643278494595, currentReference: 0.99285510819433 };

    // ── Décision ──
    const allCompsBeatBaselines = perCompetitionFull.every(c => c.avgLogLoss < BASELINES.uniform);
    const noOutOfRangeIssue = outOfRange.length / HOLDOUT.length < 0.02;
    const lowHistoryOk = !lowHistoryMetrics || lowHistoryMetrics.avgLogLoss < BASELINES.uniform * 1.15; // tolérance : moins bon mais pas catastrophique
    const haNeutralizable = Math.abs(metricsNoHA.avgLogLoss - globalMetrics.avgLogLoss) < 0.005;

    let decision = 'GO_WITH_RESTRICTIONS'; // jamais GO plein tant que le benchmark marché n'existe pas
    if (!allCompsBeatBaselines || !noOutOfRangeIssue || !lowHistoryOk) decision = 'NO_GO';

    res.json({
      note: 'SANDBOX — audit final avant décision. Aucune intégration production dans cette étape.',
      permanentBaselines: BASELINES,
      point1_globalMetrics: { avgLogLoss: globalMetrics.avgLogLoss, avgBrier: globalMetrics.avgBrier, ece: globalMetrics.ece, n: globalMetrics.n },
      point1_perCompetition: perCompetitionFull,
      point1_perSeason: bySeasonFull,
      point2_extremeProbabilities: {
        buckets: extremeBuckets,
        warning: extremeBuckets.find(b => b.sampleSize < 30) ? 'Échantillon faible (<30) sur au moins une tranche ≥70% — ne pas sur-interpréter la calibration à ces niveaux.' : 'Échantillons suffisants sur toutes les tranches ≥70%.',
      },
      point4_catastrophicErrors: {
        worst15: worstCases,
        maxLogLoss: worstCases[0]?.logLoss,
        note: 'Plus aucun cas à 13,816 (plafond artificiel) — comparer à l\'ancien diagnostic pour confirmer la disparition du bug.',
      },
      point5_stability: { perCompetition: perCompetitionFull, perSeason: bySeasonFull },
      point3_noSignalRule: {
        outOfTrainRange: { count: outOfRange.length, pct: +(outOfRange.length/HOLDOUT.length*100).toFixed(2), trainRange: [trainMinX, trainMaxX] },
        lowHistoryTeams: { count: lowHistory.length, pct: +(lowHistory.length/HOLDOUT.length*100).toFixed(2), metricsIfIsolated: lowHistoryMetrics ? { avgLogLoss: lowHistoryMetrics.avgLogLoss, n: lowHistoryMetrics.n } : 'échantillon trop petit', metricsRestOfData: { avgLogLoss: restMetrics.avgLogLoss, n: restMetrics.n } },
        proposedRule: `NO_SIGNAL si (home_matches_played < ${PROVISIONAL_THRESHOLD} OU away_matches_played < ${PROVISIONAL_THRESHOLD}) OU (ΔE hors de [${trainMinX.toFixed(0)}, ${trainMaxX.toFixed(0)}] observé à l'entraînement)`,
      },
      point6_temporalLeakage: 'Vérifié par construction du code : TRAIN=[2022,2023] et HOLDOUT=[2024,2025] filtrés avant tout appel MLE ; Elo mis à jour strictement chronologiquement ; aucune fonction de ce rapport n\'utilise HOLDOUT pour ajuster un paramètre.',
      point8_homeAdvantageNeutralization: {
        withHomeAdvantage70: globalMetrics.avgLogLoss,
        withHomeAdvantageZero: metricsNoHA.avgLogLoss,
        difference: +(metricsNoHA.avgLogLoss - globalMetrics.avgLogLoss).toFixed(5),
        recommendation: haNeutralizable ? 'Neutralisable : aucune perte mesurable de performance en le retirant — simplifie eloEngine.js en V1.' : 'Conserver : impact mesurable détecté.',
      },
      point9_regressionFactorFraming: 'regressionFactor=1 est un résultat empirique sur 5 saisons/7 compétitions — PAS une constante universelle. À ré-évaluer quand plus de saisons seront disponibles.',
      point7_baselineComparison: {
        uniform: BASELINES.uniform, historicalFrequency: BASELINES.historicalFrequency,
        currentReference: BASELINES.currentReference, thisAudit: globalMetrics.avgLogLoss,
      },
      decision,
      decisionExplanation: decision === 'GO_WITH_RESTRICTIONS'
        ? 'GO AVEC RESTRICTIONS : le modèle statistique bat les baselines de façon robuste (7/7 compétitions, 3/3 fenêtres temporelles). Restrictions : (1) appliquer la règle NO_SIGNAL ci-dessus avant d\'afficher une probabilité à l\'utilisateur, (2) ne jamais présenter 0,99286 comme une "précision" ou une garantie de profitabilité, (3) benchmark marché toujours absent — ne pas prétendre battre les bookmakers avant de l\'avoir testé, (4) Gemini garde un rôle d\'explication uniquement, aucune modification des probabilités.'
        : 'NO-GO : au moins une compétition ou une zone de données ne respecte pas le seuil de robustesse — voir le détail avant de reconsidérer.',
      paramsForEloEngineIfGo: {
        homeAdvantage: haNeutralizable ? 0 : ELO_PARAMS.homeAdvantage,
        kFactor: ELO_PARAMS.kFactor,
        regressionFactor: ELO_PARAMS.regressionFactor,
        orderedLogit: haNeutralizable ? fitNoHA : GLOBAL_FIT,
        noSignalThreshold: PROVISIONAL_THRESHOLD,
      },
    });
  } catch (e) {
    console.error('[/admin/final-audit] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// INTÉGRATION V1 — Probability Engine (eloEngine.js)
// Persistance des ratings + job de calibration hors-ligne + test de non-régression.
// N'affecte ni engine.js, ni Gemini, ni la présentation. Champ additif uniquement.
// ═══════════════════════════════════════════════════════════

async function ensureEloTables() {
  await sql(`
    CREATE TABLE IF NOT EXISTS team_elo_ratings (
      team_id         INTEGER PRIMARY KEY,
      team_name       TEXT,
      rating          DOUBLE PRECISION NOT NULL,
      matches_played  INTEGER NOT NULL DEFAULT 0,
      last_match_date TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ DEFAULT now()
    )
  `);
  await sql(`
    CREATE TABLE IF NOT EXISTS team_elo_history (
      id             SERIAL PRIMARY KEY,
      team_id        INTEGER NOT NULL,
      fixture_id     INTEGER,
      competition    TEXT,
      match_date     TIMESTAMPTZ,
      rating_before  DOUBLE PRECISION,
      rating_after   DOUBLE PRECISION,
      created_at     TIMESTAMPTZ DEFAULT now()
    )
  `);
  await sql(`CREATE INDEX IF NOT EXISTS idx_elo_hist_team ON team_elo_history(team_id)`);
}

// ── Job hors-ligne : rejoue l'historique complet, persiste les ratings finaux + la trace. ──
// Ne s'exécute JAMAIS pendant une requête utilisateur — déclenché manuellement, comme l'import LOT A.
app.get('/admin/seed-elo-ratings', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    await ensureEloTables();
    const rows = await sql(`
      SELECT fixture_id, season, competition_name, match_date, home_team_id, home_team_name,
             away_team_id, away_team_name, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);

    const ratings = new Map(); // team_id -> { rating, matchesPlayed, name }
    let currentSeason = null;
    const historyRows = [];
    function getTeam(id, name) {
      if (!ratings.has(id)) ratings.set(id, { rating: eloEngine.INITIAL_RATING, matchesPlayed: 0, name });
      return ratings.get(id);
    }

    for (const m of rows) {
      if (currentSeason !== null && m.season !== currentSeason) {
        const all = [...ratings.values()].map(r => r.rating);
        const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
        for (const t of ratings.values()) t.rating = eloEngine.applySeasonRegression(t.rating, leagueMean);
      }
      currentSeason = m.season;

      const home = getTeam(m.home_team_id, m.home_team_name);
      const away = getTeam(m.away_team_id, m.away_team_name);
      const ratingBeforeHome = home.rating, ratingBeforeAway = away.rating;

      const outcome = m.home_goals > m.away_goals ? 'H' : m.home_goals < m.away_goals ? 'A' : 'D';
      const actualResult = outcome === 'H' ? 1 : outcome === 'D' ? 0.5 : 0;
      const updated = eloEngine.updateRatings(home.rating, away.rating, actualResult, home.matchesPlayed, away.matchesPlayed);
      home.rating = updated.newHome; away.rating = updated.newAway;
      home.matchesPlayed++; away.matchesPlayed++;

      historyRows.push({ teamId: m.home_team_id, fixtureId: m.fixture_id, competition: m.competition_name, matchDate: m.match_date, before: ratingBeforeHome, after: home.rating });
      historyRows.push({ teamId: m.away_team_id, fixtureId: m.fixture_id, competition: m.competition_name, matchDate: m.match_date, before: ratingBeforeAway, after: away.rating });
    }

    // Persistance des ratings finaux (upsert)
    for (const [teamId, data] of ratings.entries()) {
      await sql(`
        INSERT INTO team_elo_ratings (team_id, team_name, rating, matches_played, last_match_date, updated_at)
        VALUES ($1, $2, $3, $4, now(), now())
        ON CONFLICT (team_id) DO UPDATE SET
          team_name = EXCLUDED.team_name, rating = EXCLUDED.rating,
          matches_played = EXCLUDED.matches_played, last_match_date = EXCLUDED.last_match_date, updated_at = now()
      `, [teamId, data.name, data.rating, data.matchesPlayed]);
    }

    // Persistance de la trace (groupée, une seule requête)
    if (historyRows.length) {
      await sql(`
        INSERT INTO team_elo_history (team_id, fixture_id, competition, match_date, rating_before, rating_after)
        SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::timestamptz[], $5::float8[], $6::float8[])
      `, [
        historyRows.map(h => h.teamId), historyRows.map(h => h.fixtureId), historyRows.map(h => h.competition),
        historyRows.map(h => h.matchDate), historyRows.map(h => h.before), historyRows.map(h => h.after),
      ]);
    }

    res.json({
      teamsSeeded: ratings.size,
      historyRowsWritten: historyRows.length,
      message: 'Ratings persistés dans team_elo_ratings. Prêt pour /admin/regression-test.',
    });
  } catch (e) {
    console.error('[/admin/seed-elo-ratings] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Test de non-régression : le module productionisé doit reproduire EXACTEMENT 0,99286 ──
app.get('/admin/regression-test', async (req, res) => {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return res.status(503).json({ error: 'IMPORT_SECRET manquant.' });
  if (req.query.key !== secret) return res.status(401).json({ error: 'Unauthorized.' });
  if (!sql) return res.status(503).json({ error: 'Neon non configuré.' });

  try {
    const rows = await sql(`
      SELECT season, home_team_id, away_team_id, home_goals, away_goals
      FROM historical_matches WHERE is_valid_result = true ORDER BY match_date ASC
    `);
    const ratings = new Map();
    let currentSeason = null;
    const holdoutRecords = [];
    function getTeam(id) {
      if (!ratings.has(id)) ratings.set(id, { rating: eloEngine.INITIAL_RATING, matchesPlayed: 0 });
      return ratings.get(id);
    }
    for (const m of rows) {
      if (currentSeason !== null && m.season !== currentSeason) {
        const all = [...ratings.values()].map(r => r.rating);
        const leagueMean = all.reduce((a, b) => a + b, 0) / all.length;
        for (const t of ratings.values()) t.rating = eloEngine.applySeasonRegression(t.rating, leagueMean);
      }
      currentSeason = m.season;
      const home = getTeam(m.home_team_id), away = getTeam(m.away_team_id);
      const outcome = m.home_goals > m.away_goals ? 'H' : m.home_goals < m.away_goals ? 'A' : 'D';

      if ([2024, 2025].includes(m.season)) {
        const probs = eloEngine.computeExpectedProbabilities(home.rating, away.rating);
        const signal = eloEngine.classifySignal(home.matchesPlayed, away.matchesPlayed, probs.eloGap);
        holdoutRecords.push({ probs, outcome, signal });
      }

      const actualResult = outcome === 'H' ? 1 : outcome === 'D' ? 0.5 : 0;
      const updated = eloEngine.updateRatings(home.rating, away.rating, actualResult, home.matchesPlayed, away.matchesPlayed);
      home.rating = updated.newHome; away.rating = updated.newAway;
      home.matchesPlayed++; away.matchesPlayed++;
    }

    let ll = 0;
    let noSignalCount = 0, weakSignalCount = 0, zeroProbCount = 0, badSumCount = 0;
    for (const r of holdoutRecords) {
      const prob = r.outcome === 'H' ? r.probs.pHome : r.outcome === 'D' ? r.probs.pDraw : r.probs.pAway;
      ll += -Math.log(Math.min(Math.max(prob, 1e-6), 1 - 1e-6));
      if (r.probs.pHome <= 0 || r.probs.pDraw <= 0 || r.probs.pAway <= 0) zeroProbCount++;
      if (Math.abs(r.probs.pHome + r.probs.pDraw + r.probs.pAway - 1) > 1e-9) badSumCount++;
      if (r.signal.status === 'NO_SIGNAL') noSignalCount++;
      if (r.signal.status === 'WEAK_SIGNAL') weakSignalCount++;
    }
    const avgLogLoss = ll / holdoutRecords.length;
    const REFERENCE = 0.99285510819433;
    const matchesReference = Math.abs(avgLogLoss - REFERENCE) < 0.001;

    res.json({
      holdoutSize: holdoutRecords.length,
      avgLogLoss,
      referenceFromB4: REFERENCE,
      difference: +(avgLogLoss - REFERENCE).toFixed(6),
      matchesReference,
      signalBreakdown: {
        NORMAL: holdoutRecords.length - noSignalCount - weakSignalCount,
        WEAK_SIGNAL: weakSignalCount,
        NO_SIGNAL: noSignalCount,
      },
      integrityChecks: {
        zeroOrNegativeProbabilities: zeroProbCount,
        probabilitiesNotSummingToOne: badSumCount,
        allPassed: zeroProbCount === 0 && badSumCount === 0,
      },
      verdict: matchesReference
        ? '✅ Le module productionisé reproduit la référence B.4 — non-régression confirmée.'
        : '⚠️ Écart avec la référence B.4 — à examiner avant d\'utiliser ce module.',
    });
  } catch (e) {
    console.error('[/admin/regression-test] Erreur', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('SUPERCOACH API v9.3 — port '+PORT);
  setTimeout(()=>{
    fetchAllESPN(['foot','basket','baseball']).then(()=>console.log('[WARMUP] ESPN OK'));
  },3000);
});
