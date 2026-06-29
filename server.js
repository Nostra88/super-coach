// ═══════════════════════════════════════════════════════════
// SUPERCOACH API v9.0
// Architecture : Gemini extrait → TheOddsAPI valide → Gemini analyse
// Zéro table en dur — scalable D2 finlandaise à MLB
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');

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
  if (!token || !SUPABASE_KEY) return null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_KEY,
      }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.id || null;
  } catch { return null; }
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

app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','Accept'] }));
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
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(
      'https://clob.polymarket.com/markets?active=true&closed=false&tag_slug=fifa-world-cup-2026&limit=100',
      { signal: ctrl.signal, headers: { 'Accept': 'application/json' } }
    );
    if (!resp.ok) throw new Error('Polymarket HTTP ' + resp.status);
    const data = await resp.json();
    const markets = data.data || data.markets || (Array.isArray(data) ? data : []);
    let count = 0;
    for (const m of markets) {
      const q = (m.question || m.title || '').toLowerCase();
      const tokens = m.tokens || m.outcomes || [];
      const yes = tokens.find(t => (t.outcome||t.name||'').toLowerCase() === 'yes');
      const no  = tokens.find(t => (t.outcome||t.name||'').toLowerCase() === 'no');
      if (!yes) continue;
      const key = 'pm_' + (m.market_slug || m.slug || m.id || count);
      MARKET_CONSENSUS[key] = {
        question:  m.question || m.title || '',
        homeProb:  parseFloat(yes.price || yes.probability || 0),
        awayProb:  parseFloat(no ? (no.price || no.probability || 0) : 0),
        drawProb:  0,
        source:    'Polymarket',
        syncedAt:  new Date().toISOString(),
        volume:    parseFloat(m.volume || m.volume_num_min || 0),
      };
      count++;
    }
    console.log('[MARKETS] Polymarket WC:', count, 'markets');
    return count;
  } catch(e) { console.warn('[MARKETS] Polymarket:', e.message); return 0; }
}

async function fetchManifoldSports() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(
      'https://api.manifold.markets/v0/markets?limit=100&topic=sports&sort=liquidity',
      { signal: ctrl.signal, headers: { 'Accept': 'application/json' } }
    );
    if (!resp.ok) throw new Error('Manifold HTTP ' + resp.status);
    const markets = await resp.json();
    let count = 0;
    for (const m of markets) {
      if (m.outcomeType !== 'BINARY') continue;
      const q = (m.question || '').toLowerCase();
      if (!q.includes('win') && !q.includes('vs') && !q.includes('beat')) continue;
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
    console.log('[MARKETS] Manifold sports:', count, 'markets');
    return count;
  } catch(e) { console.warn('[MARKETS] Manifold:', e.message); return 0; }
}

async function refreshMarketConsensus() {
  const t0 = Date.now();
  await Promise.allSettled([fetchPolymarketWC(), fetchManifoldSports()]);
  const total = Object.keys(MARKET_CONSENSUS).length;
  console.log('[MARKETS] Synced — ' + total + ' markets (' + (Date.now()-t0) + 'ms)');
  return total;
}

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
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
  ],
  basket: ['https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'],
  hockey: ['https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'],
  baseball: ['https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],
  nfl: ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'],
  tennis: ['https://site.api.espn.com/apis/site/v2/sports/tennis/scoreboard'],
};

async function fetchESPN(url) {
  const c=cacheGet(url); if(c) return c;
  try {
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),4000);
    const r=await fetch(url,{signal:ctrl.signal}); if(!r.ok) return [];
    const j=await r.json();
    const lines=(j.events||[]).map(e=>{
      const comp=e.competitions?.[0]; const t=comp?.competitors||[];
      const names=t.map(x=>x.team?.displayName||'').filter(Boolean);
      const scores=t.map(x=>x.score||'').filter(Boolean);
      const status=comp?.status?.type?.description||'';
      const date=e.date?new Date(e.date).toLocaleString():'';
      return names.join(' vs ')+' | '+scores.join('-')+' | '+status+' | '+date;
    }).filter(l=>l.length>10);
    cacheSet(url,lines); return lines;
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
    const lLow = l.toLowerCase();
    return entities.some(e => lLow.includes((e.canonical||'').toLowerCase().split(' ')[0]));
  });
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

app.post('/analyze', async (req, res) => {
  const timeout = setTimeout(()=>{ if(!res.headersSent) res.status(503).json({error:'Timeout'}); }, 120000);

  try {
    const { prompt } = req.body;
    if (!prompt) { clearTimeout(timeout); return res.status(400).json({error:'Prompt manquant'}); }
    if (!GEMINI_KEY) { clearTimeout(timeout); return res.status(500).json({error:'GEMINI_KEY manquante'}); }

    const T0 = Date.now();

    // 0. Si le prompt est une URL → scraper d'abord
    let finalPrompt = prompt;
    const urlPattern = /^https?:\/\//i;
    if (urlPattern.test(prompt.trim())) {
      console.log('[ANALYZE] URL détectée — scraping intégré');
      try {
        const parsed = new URL(prompt.trim());
        let scraped = null;

        // Étape A — fetch direct
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 8000);
          const r = await fetch(prompt.trim(), { signal: ctrl.signal, headers: {
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
            if (clean.length > 200) {
              scraped = clean.length > 8000 ? clean.slice(0,8000) : clean;
              console.log('[ANALYZE] Fetch A OK —', scraped.length, 'chars');
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
                    'Today is ' + dateStr + '. URL requested: ' + url + '\\n' +
                    'Step 1: Search for current content of this URL or site.\\n' +
                    'Step 2: If unavailable, use the URL path to detect sport and find today\'s matches with odds.\\n' +
                    'Return ALL upcoming matches. Format: Home vs Away | Competition | Date | Odds1 | Odds2\\n' +
                    'Include as many real upcoming matches as possible.'
                  }]}],
                  tools: [{ google_search: {} }],
                  generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
                })
              }
            );
            if (gr.ok) {
              const gd = await gr.json();
              const gt = gd?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (gt && gt !== 'BLOCKED' && gt.length > 50) {
                scraped = '[Source: ' + parsed.hostname + ']\n' + gt;
                console.log('[ANALYZE] Grounding B OK —', scraped.length, 'chars');
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
          finalPrompt = 'SUPERCOACH v9.0 — Analyze ALL matches below. Strict JSON only.\n' +
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

    clearTimeout(timeout);
    res.json({
      result: text,
      db_ids,
      market: marketData ? {
        source:    marketData.source,
        question:  marketData.question,
        homeProb:  Math.round(marketData.homeProb * 100),
        awayProb:  Math.round(marketData.awayProb * 100),
        syncedAt:  marketData.syncedAt,
        volume:    marketData.volume || 0,
        totalMarkets: Object.keys(MARKET_CONSENSUS).length,
      } : null,
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

app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({error:'URL manquante'});
  let parsed;
  try { parsed=new URL(url); if(!['http:','https:'].includes(parsed.protocol)) throw new Error(); }
  catch { return res.status(400).json({error:'URL invalide'}); }

  console.log('[SCRAPE]', parsed.hostname);
  let content=null;

  // Étape A — fetch direct
  try {
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),8000);
    const r=await fetch(url,{signal:ctrl.signal,headers:{
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
      if (clean.length>200) {
        content=clean.length>10000?clean.slice(0,10000)+'\n[truncated]':clean;
        console.log('[SCRAPE] A OK —',content.length,'chars');
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
              'Today is 04/06/2026. Extract ONLY upcoming or live sports matches from this page.\n'+
              'Website: '+parsed.hostname+'\n'+
              'URL: '+url+'\n'+
              'CRITICAL: Return ONLY matches scheduled TODAY or in the FUTURE. Ignore past matches.\n'+
              'Do NOT use ESPN, Google, or any other source. Only this exact URL.\n'+
              'Format: team1 vs team2 | competition | date | odds\n'+
              'If no upcoming matches found or page inaccessible: return BLOCKED'
            }]}],
            tools:[{google_search:{}}],
            generationConfig:{maxOutputTokens:2048,temperature:0.1}
          })
        }
      );
      if (gr.ok) {
        const d=await gr.json();
        const t=d?.candidates?.[0]?.content?.parts?.[0]?.text||'';
        if (t&&t!=='BLOCKED'&&t.length>50) {
          // Rejeter si Gemini retourne uniquement des vieux matchs
          const hasFutureContent = t.includes('2026') || t.includes('odds') ||
            t.includes('cote') || t.includes('vs') || t.includes(' - ');
          if (hasFutureContent) {
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
    status:'SUPERCOACH API v9.0',
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
        competition: league.name || '',
        country:     league.country || '',
        dateUTC:     dateUTC,
        isLive:      isLive,
        isFinished:  false,
        score:       isLive ? `${goals.home ?? 0}-${goals.away ?? 0}` : '',
        statusShort: st,
        leagueId:    league.id || 0,
      };
    }

    // Autres sports (Basketball, Tennis, Hockey, Baseball, Rugby)
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
app.post('/analyze-match', async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.status(503).json({ error: 'Timeout' });
  }, 120000);

  try {
    const { apiData, odds } = req.body;
    if (!apiData || !apiData.home || !apiData.away) {
      clearTimeout(timeout);
      return res.status(400).json({ error: 'apiData manquant (home, away requis)' });
    }

    // ── Enrichissement automatique API-Football ──
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
          // Injecter classement
          if (match.league?.standings) {
            apiData.homeRank = match.league.standings?.[0]?.rank || null;
            apiData.awayRank = match.league.standings?.[1]?.rank || null;
          }
          // Injecter xG si disponibles
          if (match.statistics) {
            apiData.advancedMetrics = apiData.advancedMetrics || {};
            apiData.advancedMetrics.xG = {
              homeFor: match.statistics?.[0]?.statistics?.find(s => s.type === 'expected_goals')?.value || null,
              awayFor: match.statistics?.[1]?.statistics?.find(s => s.type === 'expected_goals')?.value || null,
            };
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
    const kelly = odds ? computeKellyAndValueEdge(geminiResult, parseFloat(odds)) : null;

    clearTimeout(timeout);
    res.json({ success: true, result: geminiResult, kelly });

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
  const secret = process.env.BACKTEST_SECRET || 'supercoach-backtest-2026';
  if (req.body?.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized. Provide correct secret.' });
  }

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

// ── /test-tennis — Diagnostic APIs tennis ────────────────────────
app.get('/test-tennis', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const R = {};
  const BH = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    'Accept': 'application/json',
    'Referer': 'https://www.sofascore.com/',
    'Origin': 'https://www.sofascore.com',
  };
  try {
    const r1 = await fetch('https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/'+today, { headers: BH });
    const d1 = await r1.json();
    const ev = d1.events || [];
    R.sofascore = { status: r1.status, total: ev.length,
      sample: ev.slice(0,5).map(function(e){ return { home: (e.homeTeam||{}).name||'', away: (e.awayTeam||{}).name||'', tour: ((e.tournament||{}).name||'') }; })
    };
  } catch(e) { R.sofascore = { error: e.message }; }
  res.json({ date: today, R });
});

app.get('/test-tennis', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const results = {};

  // Test 1 : API-Sports tennis (clé existante)
  try {
    const r1 = await fetch(`https://v1.tennis.api-sports.io/games?date=${today}`, {
      headers: { 'x-apisports-key': APISPORTS_KEY }
    });
    const d1 = await r1.json();
    results.apiSports = {
      status: r1.status,
      results: d1.results || 0,
      sample: (d1.response || []).slice(0,3).map(g => ({
        home: g.players?.home?.name || '',
        away: g.players?.away?.name || '',
        tournament: g.tournament?.name || '',
        date: g.date || ''
      }))
    };
  } catch(e) { results.apiSports = { error: e.message }; }

  // Test 2 : ESPN tennis
  try {
    const r2 = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/scoreboard');
    const d2 = await r2.json();
    results.espn = {
      status: r2.status,
      events: (d2.events || []).length,
      sample: (d2.events || []).slice(0,3).map(e => ({
        name: e.name || '',
        date: e.date || ''
      }))
    };
  } catch(e) { results.espn = { error: e.message }; }

  // Test 3 : SofaScore (non authentifié)
  try {
    const r3 = await fetch(`https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/${today}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d3 = await r3.json();
    const events = d3.events || [];
    results.sofascore = {
      status: r3.status,
      events: events.length,
      sample: events.slice(0,3).map(e => ({
        home: e.homeTeam?.name || '',
        away: e.awayTeam?.name || '',
        tournament: e.tournament?.name || ''
      }))
    };
  } catch(e) { results.sofascore = { error: e.message }; }

  res.json({ date: today, results });
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
      const results = await Promise.allSettled(
        sports.map(s => fetchAPISports(s, dateParis))
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') allMatches = allMatches.concat(r.value);
      });
      console.log(`[FIXTURES] API-Sports: ${allMatches.length} matchs`);
    }

    // Fallback ESPN si API-Sports vide ou pas de clé
    if (allMatches.length < 5) {
      console.log('[FIXTURES] Fallback ESPN');
      const espnMatches = await fetchAllESPN(['foot','basket','baseball','hockey']);
      // Normaliser ESPN au même format
      espnMatches.forEach(ev => {
        const comp = ev.competitions?.[0];
        if (!comp) return;
        const st = comp.status?.type?.state || '';
        if (st === 'post') return;
        const teams = comp.competitors || [];
        const home = teams.find(t => t.homeAway === 'home') || teams[0];
        const away = teams.find(t => t.homeAway === 'away') || teams[1];
        const homeName = home?.team?.displayName || '';
        const awayName = away?.team?.displayName || '';
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

app.listen(PORT, () => {
  console.log('SUPERCOACH API v9.0 — port '+PORT);
  setTimeout(()=>{
    fetchAllESPN(['foot','basket','baseball']).then(()=>console.log('[WARMUP] ESPN OK'));
  },3000);
});
