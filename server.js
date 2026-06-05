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
                    'Today is ' + dateStr + '. Find current sports matches on: ' + parsed.hostname + '\n' +
                    'Return ONLY matches from TODAY or FUTURE. Format: team1 vs team2 | competition | date | odds\n' +
                    'Source: ' + parsed.hostname + ' only. No other sources.'
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

    clearTimeout(timeout);
    res.json({
      result: text,
      db_ids,
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

app.listen(PORT, () => {
  console.log('SUPERCOACH API v9.0 — port '+PORT);
  setTimeout(()=>{
    fetchAllESPN(['foot','basket','baseball']).then(()=>console.log('[WARMUP] ESPN OK'));
  },3000);
});
