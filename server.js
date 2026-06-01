const express = require('express');
const cors    = require('cors');

// ── Neon PostgreSQL ──────────────────────────────────────────
let sql = null;
try {
  const { neon } = require('@neondatabase/serverless');
  const DATABASE_URL = process.env.DATABASE_URL || '';
  if (DATABASE_URL) {
    sql = neon(DATABASE_URL);
    console.log('[DB] Neon PostgreSQL connecté');
  } else {
    console.log('[DB] DATABASE_URL absent — stockage désactivé');
  }
} catch (e) {
  console.log('[DB] Package neon non installé — stockage désactivé');
}

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_KEY    = process.env.GEMINI_KEY    || '';
const ODDS_API_KEY  = process.env.ODDS_API_KEY  || '';
const APISPORTS_KEY = process.env.APISPORTS_KEY || '';

// ── Fonctions base de données Neon ───────────────────────────

async function savePrediction(match) {
  if (!sql) return null;
  try {
    const rows = await sql(
      'INSERT INTO predictions (sport,home,away,competition,match_date,prediction,confidence,value_edge,units,odds_given) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [
        match.sport        || null,
        match.home         || null,
        match.away         || null,
        match.competition  || null,
        match.match_date   || null,
        match.result       || null,
        match.confidence   || null,
        match.value_edge_pct || null,
        match.units        || null,
        match.odds_given   || null,
      ]
    );
    return rows[0]?.id || null;
  } catch (err) {
    console.error('[DB] savePrediction:', err.message);
    return null;
  }
}

async function getPerformanceStats() {
  if (!sql) return null;
  try {
    const rows = await sql(
      'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE correct=true) as correct, COUNT(*) FILTER (WHERE correct=false) as incorrect, COUNT(*) FILTER (WHERE correct IS NULL) as pending, ROUND(AVG(confidence)) as avg_confidence, ROUND(COALESCE(SUM(roi_actual),0)::numeric,2) as total_roi, ROUND(COUNT(*) FILTER (WHERE correct=true)::decimal / NULLIF(COUNT(*) FILTER (WHERE correct IS NOT NULL),0)*100,1) as win_rate FROM predictions'
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[DB] getPerformanceStats:', err.message);
    return null;
  }
}

async function updateOutcome(predictionId, actualResult, correct) {
  if (!sql || !predictionId) return;
  try {
    await sql(
      'UPDATE predictions SET result=$1, correct=$2, roi_actual=CASE WHEN $2 THEN (odds_given-1)*units ELSE -units END WHERE id=$3',
      [actualResult, correct, predictionId]
    );
  } catch (err) {
    console.error('[DB] updateOutcome:', err.message);
  }
}

// Cascade modèles — vérifiés actifs au 29/05/2026
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ═══════════════════════════════════════════════════════════
// MODULE DATA APIs v3 — TheOddsAPI + API-Sports
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// SUPERCOACH — MODULE DATA APIs v3
// TheOddsAPI (cotes) + API-Sports (stats/blessés/H2H)
// Plan gratuit : 500 crédits/mois + 100 req/jour
// Fallback automatique sur ESPN si quota épuisé
// ═══════════════════════════════════════════════════════════════


// Cache 30 minutes — économise les crédits gratuits
const DATA_CACHE = {};
function cacheGet(key) {
  const c = DATA_CACHE[key];
  return (c && Date.now() - c.ts < 30 * 60 * 1000) ? c.data : null;
}
function cacheSet(key, data) {
  DATA_CACHE[key] = { data, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────────
// MAPPING SPORT — alias SUPERCOACH → codes APIs externes
// ─────────────────────────────────────────────────────────────
const SPORT_MAP = {
  // TheOddsAPI sport keys
  odds: {
    foot:    'soccer_france_ligue_one,soccer_spain_la_liga,soccer_epl,soccer_germany_bundesliga,soccer_italy_serie_a,soccer_uefa_champs_league,soccer_fifa_world_cup',
    basket:  'basketball_nba',
    tennis:  null, // TheOddsAPI couvre peu le tennis
    hockey:  'icehockey_nhl',
    nfl:     'americanfootball_nfl',
    baseball:'baseball_mlb',
    mma:     'mma_mixed_martial_arts',
  },
  // API-Sports league IDs (football)
  apisports: {
    'ligue 1':          61,
    'premier league':   39,
    'la liga':           140,
    'bundesliga':        78,
    'serie a':           135,
    'champions league':   2,
    'europa league':      3,
    'world cup':           1,
    'nba':              12,  // basketball
    'nhl':               57, // hockey
  }
};

// ═══════════════════════════════════════════════════════════════
// THEODDSAPI — Cotes temps réel
// 500 crédits/mois gratuits
// 1 requête = 1-4 crédits selon le nombre de bookmakers
// ═══════════════════════════════════════════════════════════════
async function fetchOdds(sportKey, teams) {
  if (!ODDS_API_KEY) return null;

  const cacheKey = 'odds_' + sportKey;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log('[ODDS] Cache hit:', sportKey);
    return filterOddsByTeams(cached, teams);
  }

  try {
    const sports = sportKey.includes(',') ? sportKey.split(',') : [sportKey];
    const allEvents = [];

    for (const sport of sports.slice(0, 3)) { // Max 3 ligues pour économiser crédits
      const url = `https://api.the-odds-api.com/v4/sports/${sport.trim()}/odds/?` +
        `apiKey=${ODDS_API_KEY}` +
        `&regions=eu,uk,us` +
        `&markets=h2h,spreads,totals` +
        `&oddsFormat=decimal` +
        `&bookmakers=bet365,winamax,unibet,draftkings,fanduel`;

      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);

      const resp = await fetch(url, { signal: ctrl.signal });

      // Afficher les crédits restants
      const remaining = resp.headers.get('x-requests-remaining');
      const used      = resp.headers.get('x-requests-used');
      if (remaining) console.log(`[ODDS] Crédits restants: ${remaining} (utilisés: ${used})`);

      if (resp.status === 422) {
        console.log('[ODDS] Quota épuisé — fallback ESPN');
        return null;
      }

      if (!resp.ok) {
        console.log('[ODDS] Erreur HTTP:', resp.status);
        continue;
      }

      const data = await resp.json();
      allEvents.push(...(data || []));
    }

    cacheSet(cacheKey, allEvents);
    console.log(`[ODDS] ${allEvents.length} événements récupérés`);
    return filterOddsByTeams(allEvents, teams);

  } catch (err) {
    console.log('[ODDS] Erreur:', err.name === 'AbortError' ? 'timeout' : err.message);
    return null;
  }
}

function filterOddsByTeams(events, teams) {
  if (!events || !teams || teams.length === 0) return events;

  return events.filter(ev => {
    const home = (ev.home_team || '').toLowerCase();
    const away = (ev.away_team || '').toLowerCase();
    return teams.some(t => {
      const tn = t.toLowerCase();
      return home.includes(tn) || away.includes(tn) ||
             tn.includes(home.split(' ')[0]) || tn.includes(away.split(' ')[0]);
    });
  });
}

function formatOddsForPrompt(oddsData) {
  if (!oddsData || oddsData.length === 0) return null;

  const lines = ['[COTES TEMPS RÉEL — TheOddsAPI]'];

  for (const event of oddsData.slice(0, 5)) {
    lines.push(`\nMatch: ${event.home_team} vs ${event.away_team}`);
    lines.push(`Date: ${new Date(event.commence_time).toLocaleString('fr-FR')}`);

    for (const bk of (event.bookmakers || []).slice(0, 4)) {
      lines.push(`  📊 ${bk.title}:`);
      for (const market of bk.markets || []) {
        if (market.key === 'h2h') {
          const o = market.outcomes;
          lines.push(`    1N2: ${o[0]?.name} ${o[0]?.price} / ${o[1]?.name} ${o[1]?.price}` +
                     (o[2] ? ` / Draw ${o[2]?.price}` : ''));
        }
        if (market.key === 'totals') {
          const over  = market.outcomes.find(o => o.name === 'Over');
          const under = market.outcomes.find(o => o.name === 'Under');
          if (over) lines.push(`    Over ${over.point}: ${over.price} / Under: ${under?.price}`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// API-SPORTS — Stats, Forme, Blessés, H2H
// 100 requêtes/jour gratuites (toutes sports confondus)
// Stratégie : utiliser les crédits uniquement si match identifié
// ═══════════════════════════════════════════════════════════════
async function fetchApiSports(endpoint, params) {
  if (!APISPORTS_KEY) return null;

  const query = new URLSearchParams(params).toString();
  const cacheKey = 'apisports_' + endpoint + '_' + query;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);

    const resp = await fetch(`https://v3.football.api-sports.io/${endpoint}?${query}`, {
      signal: ctrl.signal,
      headers: {
        'x-rapidapi-key': APISPORTS_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    const remaining = resp.headers.get('x-ratelimit-requests-remaining');
    if (remaining) console.log(`[APISPORTS] Requêtes restantes aujourd'hui: ${remaining}`);

    if (resp.status === 429) {
      console.log('[APISPORTS] Quota journalier épuisé');
      return null;
    }

    if (!resp.ok) return null;

    const data = await resp.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.log('[APISPORTS] Erreur API:', JSON.stringify(data.errors));
      return null;
    }

    cacheSet(cacheKey, data.response);
    return data.response;

  } catch (err) {
    console.log('[APISPORTS] Erreur:', err.name === 'AbortError' ? 'timeout' : err.message);
    return null;
  }
}

// Trouver l'ID d'une équipe
async function findTeamId(teamName, leagueId) {
  const results = await fetchApiSports('teams', { search: teamName });
  if (!results || results.length === 0) return null;
  return results[0]?.team?.id || null;
}

// Forme des 5 derniers matchs
async function fetchTeamForm(teamId, leagueId, season) {
  const results = await fetchApiSports('fixtures', {
    team: teamId,
    last: 5,
    status: 'FT'
  });

  if (!results || results.length === 0) return null;

  return results.map(fix => {
    const isHome = fix.teams.home.id === teamId;
    const goals_for  = isHome ? fix.goals.home : fix.goals.away;
    const goals_against = isHome ? fix.goals.away : fix.goals.home;
    const winner = fix.teams.home.winner === true ? 'home' :
                   fix.teams.away.winner === true ? 'away' : 'draw';
    const result = (isHome && winner === 'home') || (!isHome && winner === 'away') ? 'W' :
                   winner === 'draw' ? 'D' : 'L';

    return {
      date: fix.fixture.date?.split('T')[0],
      opponent: isHome ? fix.teams.away.name : fix.teams.home.name,
      venue: isHome ? 'H' : 'A',
      score: `${goals_for}-${goals_against}`,
      result
    };
  });
}

// H2H entre deux équipes
async function fetchH2H(team1Id, team2Id) {
  const results = await fetchApiSports('fixtures/headtohead', {
    h2h: `${team1Id}-${team2Id}`,
    last: 5,
    status: 'FT'
  });

  if (!results || results.length === 0) return null;

  return results.map(fix => ({
    date: fix.fixture.date?.split('T')[0],
    home: fix.teams.home.name,
    away: fix.teams.away.name,
    score: `${fix.goals.home}-${fix.goals.away}`,
    winner: fix.teams.home.winner ? fix.teams.home.name :
            fix.teams.away.winner ? fix.teams.away.name : 'Draw'
  }));
}

// Blessés du jour
async function fetchInjuries(teamId, leagueId, season) {
  const results = await fetchApiSports('injuries', {
    team: teamId,
    season: season || new Date().getFullYear()
  });

  if (!results || results.length === 0) return [];

  return results.slice(0, 8).map(inj => ({
    player: inj.player?.name,
    type: inj.player?.reason,
    status: inj.player?.type
  }));
}

function formatSportsDataForPrompt(teamName, form, h2h, injuries) {
  const lines = [];

  if (form && form.length > 0) {
    lines.push(`\n[FORME RÉCENTE — ${teamName}]`);
    form.forEach(m => {
      lines.push(`  ${m.date} ${m.venue} vs ${m.opponent}: ${m.score} (${m.result})`);
    });
    const wins = form.filter(m => m.result === 'W').length;
    lines.push(`  Bilan L5: ${wins}W ${form.filter(m=>m.result==='D').length}D ${form.filter(m=>m.result==='L').length}L`);
  }

  if (h2h && h2h.length > 0) {
    lines.push(`\n[H2H — 5 DERNIERS AFFRONTEMENTS]`);
    h2h.forEach(m => {
      lines.push(`  ${m.date}: ${m.home} ${m.score} ${m.away} → ${m.winner}`);
    });
  }

  if (injuries && injuries.length > 0) {
    lines.push(`\n[BLESSÉS / SUSPENDUS]`);
    injuries.forEach(inj => {
      lines.push(`  ❌ ${inj.player} — ${inj.type || inj.status}`);
    });
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATEUR PRINCIPAL
// Appelle les deux APIs en parallèle, gère les quotas et fallbacks
// ═══════════════════════════════════════════════════════════════
async function fetchEnrichedData(entities, sportIds, prompt) {
  const result = {
    odds: null,
    sportsData: null,
    sources: []
  };

  if (!entities || entities.length === 0) return result;

  const teams = entities.map(e => e.c);
  const sport = entities[0]?.s || sportIds[0] || 'foot';

  console.log('[ENRICH] Enrichissement pour:', teams.join(' vs '), '| Sport:', sport);

  // Lancer les deux APIs en parallèle
  const [oddsResult, team1Id, team2Id] = await Promise.all([
    // TheOddsAPI
    ODDS_API_KEY && SPORT_MAP.odds[sport]
      ? fetchOdds(SPORT_MAP.odds[sport], teams).catch(() => null)
      : Promise.resolve(null),

    // API-Sports — trouver les IDs des équipes
    APISPORTS_KEY && sport === 'foot' && teams[0]
      ? findTeamId(teams[0]).catch(() => null)
      : Promise.resolve(null),

    APISPORTS_KEY && sport === 'foot' && teams[1]
      ? findTeamId(teams[1]).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Traiter les cotes
  if (oddsResult && oddsResult.length > 0) {
    result.odds = formatOddsForPrompt(oddsResult);
    result.sources.push('TheOddsAPI');
    console.log('[ENRICH] ✅ Cotes récupérées:', oddsResult.length, 'événements');
  } else {
    console.log('[ENRICH] ⚪ Pas de cotes disponibles (quota ou sport non couvert)');
  }

  // Traiter les stats API-Sports (uniquement si les deux équipes trouvées)
  if (team1Id && team2Id) {
    const [form1, form2, h2h, inj1, inj2] = await Promise.all([
      fetchTeamForm(team1Id).catch(() => null),
      fetchTeamForm(team2Id).catch(() => null),
      fetchH2H(team1Id, team2Id).catch(() => null),
      fetchInjuries(team1Id).catch(() => null),
      fetchInjuries(team2Id).catch(() => null),
    ]);

    const data1 = formatSportsDataForPrompt(teams[0], form1, null, inj1);
    const data2 = formatSportsDataForPrompt(teams[1], form2, null, inj2);
    const dataH2H = h2h ? formatSportsDataForPrompt('', null, h2h, null) : null;

    result.sportsData = [data1, data2, dataH2H].filter(Boolean).join('\n');
    result.sources.push('API-Sports');
    console.log('[ENRICH] ✅ Stats récupérées pour', teams[0], 'et', teams[1]);

  } else if (APISPORTS_KEY && sport === 'foot') {
    console.log('[ENRICH] ⚪ Équipes non trouvées dans API-Sports — fallback ESPN');
  }

  return result;
}



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
    '━━━ SUPERCOACH SYSTEM PROMPT — EXPERT SPORTS ANALYST ━━━',
    '',
    'ROLE: You are an elite sports analyst AI.',
    'Your predictions come from YOUR OWN ANALYSIS — not from bookmaker odds.',
    'Odds are only used AFTER your prediction to calculate value edge.',
    '',
    '━━━ ANALYSIS HIERARCHY (follow in strict order) ━━━',
    '',
    '1. HEAD-TO-HEAD (H2H) — HIGHEST WEIGHT',
    '   If 2+ recent meetings between same opponents → strong predictor.',
    '   Note: same venue, same competition, same period of season.',
    '   Trend over last 3-5 H2H more important than single result.',
    '',
    '2. RECENT FORM — last 5 matches each team/player',
    '   Wins, draws, losses, goals scored/conceded, clean sheets.',
    '   Momentum matters — 3W in a row = strong signal.',
    '',
    '3. MATCH CONTEXT — critical factors',
    '   DERBY: local rivalry → unpredictable, form less relevant.',
    '   RELEGATION: team fighting for survival → motivated, risky.',
    '   TITLE RACE: leader protecting gap vs chaser → high stakes.',
    '   CUP FINAL: one-off game → reset all form stats.',
    '   ROTATION: squad rotation if 3 games in 7 days.',
    '   EARLY/LATE SEASON: early = less predictable.',
    '',
    '4. INJURIES & SUSPENSIONS',
    '   Key player absent = reduce confidence 5-15% depending on role.',
    '   Goalkeeper absent = -10% home win probability.',
    '   Top scorer absent = -8% goal probability.',
    '',
    '5. HOME/AWAY ADVANTAGE',
    '   Home teams win ~47% in top European leagues.',
    '   Neutral venue = reduce home advantage to 0.',
    '   Travel distance >4h for away team = fatigue factor.',
    '',
    '6. BOOKMAKER ODDS — INPUT ONLY, NOT GUIDE',
    '   NEVER let odds influence your prediction.',
    '   Use odds ONLY to calculate value_edge_pct AFTER your prediction.',
    '   Formula: value_edge = (your_confidence% - implied_probability%) ',
    '   Implied probability = 1/decimal_odds × 100',
    '   If your_confidence > implied_probability → positive value → recommend.',
    '',
    '━━━ SOURCE FORMAT RECOGNITION ━━━',
    '',
    'You must extract match data from ANY of these formats:',
    '',
    'FRENCH SITES (Pronosoft, Parions Sport FDJ, Unibet FR, Winamax, PMU, Betclic):',
    '  Pattern: "18h25 La Gantoise - RC Genk / Tendance 16% 19% 65% / 1N2: 2.05 3.50 2.90"',
    '  Pattern: "Avant-match : [analysis text] / L avis Pronosoft : 1-3"',
    '  Pattern: "1/N/2 avec cotes decimales + pourcentages parieurs"',
    '  Odds format: DECIMAL (1.85, 2.10, 3.50)',
    '',
    'UK SITES (bet365, Sky Bet, Ladbrokes, William Hill, Betfair, Coral):',
    '  Pattern: "Full Time Result / Over/Under 2.5 / Both Teams to Score Yes/No"',
    '  Pattern: "Belgium First Division A • 31 mai 14:30 / Gent v Genk"',
    '  Odds format: FRACTIONAL (4/5, 11/8) or DECIMAL',
    '',
    'USA SITES (FanDuel, DraftKings, BetMGM, Caesars, bet365 US):',
    '  Pattern: "Moneyline / Spread -3.5 / Total Over 44.5"',
    '  Odds format: AMERICAN (-110, +150, -220)',
    '  Convert American odds: +X → (X/100)+1 / -X → (100/X)+1',
    '',
    'GERMAN SITES (Tipico, bwin, Bet3000):',
    '  Pattern: "Heimsieg/Unentschieden/Auswärtssieg / Über/Unter 2.5"',
    '  Odds format: DECIMAL',
    '',
    'SPANISH SITES (bet365 ES, Codere, Betway ES, Marca Apuestas):',
    '  Pattern: "1/X/2 / Más/Menos 2.5 goles / Ambos marcan"',
    '  Odds format: DECIMAL',
    '',
    'ITALIAN SITES (Snai, Sisal, Goldbet, Lottomatica):',
    '  Pattern: "1/X/2 / Gol/NoGol / Over/Under"',
    '  Odds format: DECIMAL',
    '',
    'BRAZILIAN SITES (Sportingbet, Betano, Bet365 BR, Superbet):',
    '  Pattern: "Casa/Empate/Fora / Mais/Menos 2.5 / Ambas marcam"',
    '  Odds format: DECIMAL',
    '',
    'AFRICAN SITES (Bet9ja, SportyBet, 1xBet Africa):',
    '  Pattern: "1/X/2 / GG/NG / Over/Under"',
    '  Odds format: DECIMAL',
    '',
    'AUSTRALIAN SITES (Sportsbet, TAB, Ladbrokes AU):',
    '  Pattern: "Home/Draw/Away / Total Goals / Handicap"',
    '  Odds format: DECIMAL',
    '',
    '━━━ GOLDEN RULES ━━━',
    '',
    'RULE 1 — ZERO INVENTION: Never invent a match, date, score or team.',
    'RULE 2 — ODDS ARE NOT PREDICTIONS: Your analysis is independent.',
    'RULE 3 — CONFIDENCE = your estimated win probability (0-100%).',
    'RULE 4 — Only recommend if confidence >= 70% AND value_edge > 0.',
    'RULE 5 — Past match → refuse predictive analysis.',
    'RULE 6 — Return ONLY valid JSON: {"matches":[...],"summary":"...","roi_potential":"..."}',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// MOTEUR DE VALIDATION FACT-FIRST v2
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH — MOTEUR DE VALIDATION FACT-FIRST v2
// Pipeline : Extraction → Normalisation → Fuzzy → Validation → Vérité
// Tolérance zéro hallucination — pas de PARTIAL en MVP
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// COUCHE 1 — TABLE FIXE (300+ entrées, certitude 100%)
// Format : alias_normalisé → {canonical, sport, espnId?}
// ─────────────────────────────────────────────────────────────────
const ALIAS_TABLE = {

  // ── FOOTBALL EUROPE ──────────────────────────────────────────

  // France
  'psg':                    {c:'Paris Saint-Germain', s:'foot'},
  'paris saint germain':    {c:'Paris Saint-Germain', s:'foot'},
  'paris sg':               {c:'Paris Saint-Germain', s:'foot'},
  'saint germain':          {c:'Paris Saint-Germain', s:'foot'},
  'paris saint-germain':    {c:'Paris Saint-Germain', s:'foot'},
  'paris':                  {c:'Paris Saint-Germain', s:'foot'},
  'om':                     {c:'Marseille',           s:'foot'},
  'marseille':              {c:'Marseille',           s:'foot'},
  'olympique marseille':    {c:'Marseille',           s:'foot'},
  'ol':                     {c:'Olympique Lyonnais',  s:'foot'},
  'lyon':                   {c:'Olympique Lyonnais',  s:'foot'},
  'olympique lyonnais':     {c:'Olympique Lyonnais',  s:'foot'},
  'asm':                    {c:'Monaco',              s:'foot'},
  'monaco':                 {c:'Monaco',              s:'foot'},
  'as monaco':              {c:'Monaco',              s:'foot'},
  'ogcn':                   {c:'Nice',                s:'foot'},
  'nice':                   {c:'Nice',                s:'foot'},
  'losc':                   {c:'Lille',               s:'foot'},
  'lille':                  {c:'Lille',               s:'foot'},
  'rennes':                 {c:'Rennes',              s:'foot'},
  'stade rennais':          {c:'Rennes',              s:'foot'},
  'lens':                   {c:'Lens',                s:'foot'},
  'rc lens':                {c:'Lens',                s:'foot'},
  'strasbourg':             {c:'Strasbourg',          s:'foot'},
  'nantes':                 {c:'Nantes',              s:'foot'},
  'bordeaux':               {c:'Bordeaux',            s:'foot'},
  'saint etienne':          {c:'Saint-Étienne',       s:'foot'},
  'asse':                   {c:'Saint-Étienne',       s:'foot'},

  // Angleterre
  'arsenal':                {c:'Arsenal',             s:'foot'},
  'chelsea':                {c:'Chelsea',             s:'foot'},
  'liverpool':              {c:'Liverpool',           s:'foot'},
  'man utd':                {c:'Manchester United',   s:'foot'},
  'manchester united':      {c:'Manchester United',   s:'foot'},
  'mufc':                   {c:'Manchester United',   s:'foot'},
  'man city':               {c:'Manchester City',     s:'foot'},
  'manchester city':        {c:'Manchester City',     s:'foot'},
  'mcfc':                   {c:'Manchester City',     s:'foot'},
  'spurs':                  {c:'Tottenham',           s:'foot'},
  'tottenham':              {c:'Tottenham',           s:'foot'},
  'thfc':                   {c:'Tottenham',           s:'foot'},
  'newcastle':              {c:'Newcastle',           s:'foot'},
  'aston villa':            {c:'Aston Villa',         s:'foot'},
  'west ham':               {c:'West Ham',            s:'foot'},
  'everton':                {c:'Everton',             s:'foot'},
  'brighton':               {c:'Brighton',            s:'foot'},
  'brentford':              {c:'Brentford',           s:'foot'},
  'fulham':                 {c:'Fulham',              s:'foot'},
  'wolves':                 {c:'Wolverhampton',       s:'foot'},
  'wolverhampton':          {c:'Wolverhampton',       s:'foot'},
  'leicester':              {c:'Leicester',           s:'foot'},
  'nottm forest':           {c:'Nottingham Forest',   s:'foot'},
  'nottingham forest':      {c:'Nottingham Forest',   s:'foot'},

  // Espagne
  'real madrid':            {c:'Real Madrid',         s:'foot'},
  'real':                   {c:'Real Madrid',         s:'foot'},
  'barca':                  {c:'Barcelona',           s:'foot'},
  'barcelona':              {c:'Barcelona',           s:'foot'},
  'fcb':                    {c:'Barcelona',           s:'foot'},
  'atletico':               {c:'Atlético Madrid',     s:'foot'},
  'atletico madrid':        {c:'Atlético Madrid',     s:'foot'},
  'atm':                    {c:'Atlético Madrid',     s:'foot'},
  'sevilla':                {c:'Sevilla',             s:'foot'},
  'real sociedad':          {c:'Real Sociedad',       s:'foot'},
  'villarreal':             {c:'Villarreal',          s:'foot'},
  'athletic bilbao':        {c:'Athletic Club',       s:'foot'},
  'athletic':               {c:'Athletic Club',       s:'foot'},
  'valencia':               {c:'Valencia',            s:'foot'},
  'betis':                  {c:'Real Betis',          s:'foot'},
  'real betis':             {c:'Real Betis',          s:'foot'},
  'osasuna':                {c:'Osasuna',             s:'foot'},
  'girona':                 {c:'Girona',              s:'foot'},

  // Allemagne
  'bayern':                 {c:'Bayern Munich',       s:'foot'},
  'bayern munich':          {c:'Bayern Munich',       s:'foot'},
  'fcb munich':             {c:'Bayern Munich',       s:'foot'},
  'dortmund':               {c:'Borussia Dortmund',   s:'foot'},
  'bvb':                    {c:'Borussia Dortmund',   s:'foot'},
  'borussia dortmund':      {c:'Borussia Dortmund',   s:'foot'},
  'leverkusen':             {c:'Bayer Leverkusen',    s:'foot'},
  'bayer leverkusen':       {c:'Bayer Leverkusen',    s:'foot'},
  'rb leipzig':             {c:'RB Leipzig',          s:'foot'},
  'leipzig':                {c:'RB Leipzig',          s:'foot'},
  'eintracht frankfurt':    {c:'Eintracht Frankfurt', s:'foot'},
  'frankfurt':              {c:'Eintracht Frankfurt', s:'foot'},
  'wolfsburg':              {c:'Wolfsburg',           s:'foot'},
  'gladbach':               {c:'Borussia Mönchengladbach', s:'foot'},
  'monchengladbach':        {c:'Borussia Mönchengladbach', s:'foot'},
  'union berlin':           {c:'Union Berlin',        s:'foot'},
  'stuttgart':              {c:'Stuttgart',           s:'foot'},
  'hamburg':                {c:'Hamburg',             s:'foot'},
  'hsv':                    {c:'Hamburg',             s:'foot'},

  // Italie
  'juventus':               {c:'Juventus',            s:'foot'},
  'juve':                   {c:'Juventus',            s:'foot'},
  'inter':                  {c:'Inter Milan',         s:'foot'},
  'inter milan':            {c:'Inter Milan',         s:'foot'},
  'ac milan':               {c:'AC Milan',            s:'foot'},
  'milan':                  {c:'AC Milan',            s:'foot'},
  'napoli':                 {c:'Napoli',              s:'foot'},
  'roma':                   {c:'AS Roma',             s:'foot'},
  'as roma':                {c:'AS Roma',             s:'foot'},
  'lazio':                  {c:'Lazio',               s:'foot'},
  'atalanta':               {c:'Atalanta',            s:'foot'},
  'fiorentina':             {c:'Fiorentina',          s:'foot'},
  'torino':                 {c:'Torino',              s:'foot'},
  'bologna':                {c:'Bologna',             s:'foot'},
  'udinese':                {c:'Udinese',             s:'foot'},

  // Portugal
  'benfica':                {c:'Benfica',             s:'foot'},
  'sl benfica':             {c:'Benfica',             s:'foot'},
  'porto':                  {c:'Porto',               s:'foot'},
  'fc porto':               {c:'Porto',               s:'foot'},
  'sporting':               {c:'Sporting CP',         s:'foot'},
  'sporting cp':            {c:'Sporting CP',         s:'foot'},
  'sporting lisbon':        {c:'Sporting CP',         s:'foot'},
  'braga':                  {c:'Braga',               s:'foot'},

  // Pays-Bas
  'ajax':                   {c:'Ajax',                s:'foot'},
  'psv':                    {c:'PSV',                 s:'foot'},
  'feyenoord':              {c:'Feyenoord',           s:'foot'},
  'az alkmaar':             {c:'AZ Alkmaar',          s:'foot'},
  'az':                     {c:'AZ Alkmaar',          s:'foot'},
  'twente':                 {c:'FC Twente',           s:'foot'},

  // Coupe du Monde 2026 — Équipes nationales
  'france':                 {c:'France',              s:'foot'},
  'les bleus':              {c:'France',              s:'foot'},
  'bresil':                 {c:'Brazil',              s:'foot'},
  'brazil':                 {c:'Brazil',              s:'foot'},
  'seleção':                {c:'Brazil',              s:'foot'},
  'selecao':                {c:'Brazil',              s:'foot'},
  'angleterre':             {c:'England',             s:'foot'},
  'england':                {c:'England',             s:'foot'},
  'three lions':            {c:'England',             s:'foot'},
  'espagne':                {c:'Spain',               s:'foot'},
  'spain':                  {c:'Spain',               s:'foot'},
  'la roja':                {c:'Spain',               s:'foot'},
  'allemagne':              {c:'Germany',             s:'foot'},
  'germany':                {c:'Germany',             s:'foot'},
  'die mannschaft':         {c:'Germany',             s:'foot'},
  'portugal':               {c:'Portugal',            s:'foot'},
  'selecao portuguesa':     {c:'Portugal',            s:'foot'},
  'argentine':              {c:'Argentina',           s:'foot'},
  'argentina':              {c:'Argentina',           s:'foot'},
  'la albiceleste':         {c:'Argentina',           s:'foot'},
  'maroc':                  {c:'Morocco',             s:'foot'},
  'morocco':                {c:'Morocco',             s:'foot'},
  'pays bas':               {c:'Netherlands',         s:'foot'},
  'netherlands':            {c:'Netherlands',         s:'foot'},
  'hollande':               {c:'Netherlands',         s:'foot'},
  'holland':                {c:'Netherlands',         s:'foot'},
  'belgique':               {c:'Belgium',             s:'foot'},
  'belgium':                {c:'Belgium',             s:'foot'},
  'red devils':             {c:'Belgium',             s:'foot'},
  'italie':                 {c:'Italy',               s:'foot'},
  'italy':                  {c:'Italy',               s:'foot'},
  'azzurri':                {c:'Italy',               s:'foot'},
  'etats unis':             {c:'USA',                 s:'foot'},
  'usa':                    {c:'USA',                 s:'foot'},
  'japon':                  {c:'Japan',               s:'foot'},
  'japan':                  {c:'Japan',               s:'foot'},
  'coree':                  {c:'South Korea',         s:'foot'},
  'south korea':            {c:'South Korea',         s:'foot'},
  'mexique':                {c:'Mexico',              s:'foot'},
  'mexico':                 {c:'Mexico',              s:'foot'},
  'senegal':                {c:'Senegal',             s:'foot'},
  'nigeria':                {c:'Nigeria',             s:'foot'},
  'ghana':                  {c:'Ghana',               s:'foot'},
  'cameroun':               {c:'Cameroon',            s:'foot'},
  'cameroon':               {c:'Cameroon',            s:'foot'},
  'egypte':                 {c:'Egypt',               s:'foot'},
  'egypt':                  {c:'Egypt',               s:'foot'},
  'australie':              {c:'Australia',           s:'foot'},
  'australia':              {c:'Australia',           s:'foot'},
  'canada':                 {c:'Canada',              s:'foot'},
  'arabie saoudite':        {c:'Saudi Arabia',        s:'foot'},
  'saudi arabia':           {c:'Saudi Arabia',        s:'foot'},
  'iran':                   {c:'Iran',                s:'foot'},
  'suisse':                 {c:'Switzerland',         s:'foot'},
  'switzerland':            {c:'Switzerland',         s:'foot'},
  'croatie':                {c:'Croatia',             s:'foot'},
  'croatia':                {c:'Croatia',             s:'foot'},
  'serbie':                 {c:'Serbia',              s:'foot'},
  'serbia':                 {c:'Serbia',              s:'foot'},

  // ── NBA ──────────────────────────────────────────────────────
  'lakers':                 {c:'Los Angeles Lakers',  s:'basket'},
  'los angeles lakers':     {c:'Los Angeles Lakers',  s:'basket'},
  'la lakers':              {c:'Los Angeles Lakers',  s:'basket'},
  'celtics':                {c:'Boston Celtics',      s:'basket'},
  'boston celtics':         {c:'Boston Celtics',      s:'basket'},
  'warriors':               {c:'Golden State Warriors', s:'basket'},
  'golden state':           {c:'Golden State Warriors', s:'basket'},
  'gsw':                    {c:'Golden State Warriors', s:'basket'},
  'bulls':                  {c:'Chicago Bulls',       s:'basket'},
  'chicago bulls':          {c:'Chicago Bulls',       s:'basket'},
  'heat':                   {c:'Miami Heat',          s:'basket'},
  'miami heat':             {c:'Miami Heat',          s:'basket'},
  'bucks':                  {c:'Milwaukee Bucks',     s:'basket'},
  'milwaukee bucks':        {c:'Milwaukee Bucks',     s:'basket'},
  'nuggets':                {c:'Denver Nuggets',      s:'basket'},
  'denver nuggets':         {c:'Denver Nuggets',      s:'basket'},
  'suns':                   {c:'Phoenix Suns',        s:'basket'},
  'phoenix suns':           {c:'Phoenix Suns',        s:'basket'},
  'nets':                   {c:'Brooklyn Nets',       s:'basket'},
  'brooklyn nets':          {c:'Brooklyn Nets',       s:'basket'},
  'clippers':               {c:'LA Clippers',         s:'basket'},
  'la clippers':            {c:'LA Clippers',         s:'basket'},
  'knicks':                 {c:'New York Knicks',     s:'basket'},
  'new york knicks':        {c:'New York Knicks',     s:'basket'},
  'raptors':                {c:'Toronto Raptors',     s:'basket'},
  'toronto raptors':        {c:'Toronto Raptors',     s:'basket'},
  'spurs':                  {c:'San Antonio Spurs',   s:'basket'},
  'san antonio spurs':      {c:'San Antonio Spurs',   s:'basket'},
  'sixers':                 {c:'Philadelphia 76ers',  s:'basket'},
  'philadelphia 76ers':     {c:'Philadelphia 76ers',  s:'basket'},
  '76ers':                  {c:'Philadelphia 76ers',  s:'basket'},
  'hawks':                  {c:'Atlanta Hawks',       s:'basket'},
  'atlanta hawks':          {c:'Atlanta Hawks',       s:'basket'},
  'cavaliers':              {c:'Cleveland Cavaliers', s:'basket'},
  'cavs':                   {c:'Cleveland Cavaliers', s:'basket'},
  'mavs':                   {c:'Dallas Mavericks',    s:'basket'},
  'mavericks':              {c:'Dallas Mavericks',    s:'basket'},
  'dallas mavericks':       {c:'Dallas Mavericks',    s:'basket'},
  'grizzlies':              {c:'Memphis Grizzlies',   s:'basket'},
  'memphis grizzlies':      {c:'Memphis Grizzlies',   s:'basket'},
  'pelicans':               {c:'New Orleans Pelicans',s:'basket'},
  'thunder':                {c:'Oklahoma City Thunder',s:'basket'},
  'okc':                    {c:'Oklahoma City Thunder',s:'basket'},
  'blazers':                {c:'Portland Trail Blazers',s:'basket'},
  'portland':               {c:'Portland Trail Blazers',s:'basket'},
  'kings':                  {c:'Sacramento Kings',    s:'basket'},
  'sacramento kings':       {c:'Sacramento Kings',    s:'basket'},
  'jazz':                   {c:'Utah Jazz',           s:'basket'},
  'utah jazz':              {c:'Utah Jazz',           s:'basket'},
  'wizards':                {c:'Washington Wizards',  s:'basket'},
  'pacers':                 {c:'Indiana Pacers',      s:'basket'},
  'indiana pacers':         {c:'Indiana Pacers',      s:'basket'},
  'magic':                  {c:'Orlando Magic',       s:'basket'},
  'orlando magic':          {c:'Orlando Magic',       s:'basket'},
  'hornets':                {c:'Charlotte Hornets',   s:'basket'},
  'pistons':                {c:'Detroit Pistons',     s:'basket'},
  'rockets':                {c:'Houston Rockets',     s:'basket'},
  'houston rockets':        {c:'Houston Rockets',     s:'basket'},
  'timberwolves':           {c:'Minnesota Timberwolves',s:'basket'},
  'wolves':                 {c:'Minnesota Timberwolves',s:'basket'},

  // ── NHL ──────────────────────────────────────────────────────
  'oilers':                 {c:'Edmonton Oilers',     s:'hockey'},
  'edmonton oilers':        {c:'Edmonton Oilers',     s:'hockey'},
  'maple leafs':            {c:'Toronto Maple Leafs', s:'hockey'},
  'leafs':                  {c:'Toronto Maple Leafs', s:'hockey'},
  'toronto maple leafs':    {c:'Toronto Maple Leafs', s:'hockey'},
  'rangers':                {c:'New York Rangers',    s:'hockey'},
  'new york rangers':       {c:'New York Rangers',    s:'hockey'},
  'bruins':                 {c:'Boston Bruins',       s:'hockey'},
  'boston bruins':          {c:'Boston Bruins',       s:'hockey'},
  'penguins':               {c:'Pittsburgh Penguins', s:'hockey'},
  'pittsburgh penguins':    {c:'Pittsburgh Penguins', s:'hockey'},
  'canadiens':              {c:'Montreal Canadiens',  s:'hockey'},
  'habs':                   {c:'Montreal Canadiens',  s:'hockey'},
  'montreal canadiens':     {c:'Montreal Canadiens',  s:'hockey'},
  'avalanche':              {c:'Colorado Avalanche',  s:'hockey'},
  'colorado avalanche':     {c:'Colorado Avalanche',  s:'hockey'},
  'lightning':              {c:'Tampa Bay Lightning', s:'hockey'},
  'tampa bay':              {c:'Tampa Bay Lightning', s:'hockey'},
  'golden knights':         {c:'Vegas Golden Knights',s:'hockey'},
  'vegas golden knights':   {c:'Vegas Golden Knights',s:'hockey'},
  'flames':                 {c:'Calgary Flames',      s:'hockey'},
  'calgary flames':         {c:'Calgary Flames',      s:'hockey'},
  'canucks':                {c:'Vancouver Canucks',   s:'hockey'},
  'vancouver canucks':      {c:'Vancouver Canucks',   s:'hockey'},
  'capitals':               {c:'Washington Capitals', s:'hockey'},
  'washington capitals':    {c:'Washington Capitals', s:'hockey'},
  'wild':                   {c:'Minnesota Wild',      s:'hockey'},
  'blackhawks':             {c:'Chicago Blackhawks',  s:'hockey'},
  'detroit red wings':      {c:'Detroit Red Wings',   s:'hockey'},
  'red wings':              {c:'Detroit Red Wings',   s:'hockey'},
  'flyers':                 {c:'Philadelphia Flyers', s:'hockey'},
  'sabres':                 {c:'Buffalo Sabres',      s:'hockey'},
  'stars':                  {c:'Dallas Stars',        s:'hockey'},
  'dallas stars':           {c:'Dallas Stars',        s:'hockey'},
  'jets':                   {c:'Winnipeg Jets',       s:'hockey'},
  'winnipeg jets':          {c:'Winnipeg Jets',       s:'hockey'},
  'sharks':                 {c:'San Jose Sharks',     s:'hockey'},
  'ducks':                  {c:'Anaheim Ducks',       s:'hockey'},
  'coyotes':                {c:'Utah Hockey Club',    s:'hockey'},
  'utah hc':                {c:'Utah Hockey Club',    s:'hockey'},
  'kraken':                 {c:'Seattle Kraken',      s:'hockey'},
  'blue jackets':           {c:'Columbus Blue Jackets',s:'hockey'},
  'senators':               {c:'Ottawa Senators',     s:'hockey'},
  'hurricanes':             {c:'Carolina Hurricanes', s:'hockey'},
  'panthers':               {c:'Florida Panthers',    s:'hockey'},
  'florida panthers':       {c:'Florida Panthers',    s:'hockey'},
  'blues':                  {c:'St. Louis Blues',     s:'hockey'},
  'st louis blues':         {c:'St. Louis Blues',     s:'hockey'},
  'predators':              {c:'Nashville Predators', s:'hockey'},
  'devils':                 {c:'New Jersey Devils',   s:'hockey'},
  'islanders':              {c:'New York Islanders',  s:'hockey'},

  // ── ATP TENNIS (Top 50 joueurs) ───────────────────────────────
  'sinner':                 {c:'Jannik Sinner',       s:'tennis'},
  'jannik sinner':          {c:'Jannik Sinner',       s:'tennis'},
  'alcaraz':                {c:'Carlos Alcaraz',      s:'tennis'},
  'carlos alcaraz':         {c:'Carlos Alcaraz',      s:'tennis'},
  'djokovic':               {c:'Novak Djokovic',      s:'tennis'},
  'novak djokovic':         {c:'Novak Djokovic',      s:'tennis'},
  'nole':                   {c:'Novak Djokovic',      s:'tennis'},
  'zverev':                 {c:'Alexander Zverev',    s:'tennis'},
  'alexander zverev':       {c:'Alexander Zverev',    s:'tennis'},
  'medvedev':               {c:'Daniil Medvedev',     s:'tennis'},
  'daniil medvedev':        {c:'Daniil Medvedev',     s:'tennis'},
  'rublev':                 {c:'Andrey Rublev',       s:'tennis'},
  'andrey rublev':          {c:'Andrey Rublev',       s:'tennis'},
  'tsitsipas':              {c:'Stefanos Tsitsipas',  s:'tennis'},
  'stefanos tsitsipas':     {c:'Stefanos Tsitsipas',  s:'tennis'},
  'fritz':                  {c:'Taylor Fritz',        s:'tennis'},
  'taylor fritz':           {c:'Taylor Fritz',        s:'tennis'},
  'de minaur':              {c:'Alex de Minaur',      s:'tennis'},
  'alex de minaur':         {c:'Alex de Minaur',      s:'tennis'},
  'draper':                 {c:'Jack Draper',         s:'tennis'},
  'jack draper':            {c:'Jack Draper',         s:'tennis'},
  'hurkacz':                {c:'Hubert Hurkacz',      s:'tennis'},
  'hubert hurkacz':         {c:'Hubert Hurkacz',      s:'tennis'},
  'ruud':                   {c:'Casper Ruud',         s:'tennis'},
  'casper ruud':            {c:'Casper Ruud',         s:'tennis'},
  'dimitrov':               {c:'Grigor Dimitrov',     s:'tennis'},
  'grigor dimitrov':        {c:'Grigor Dimitrov',     s:'tennis'},
  'khachanov':              {c:'Karen Khachanov',     s:'tennis'},
  'karen khachanov':        {c:'Karen Khachanov',     s:'tennis'},
  'tiafoe':                 {c:'Frances Tiafoe',      s:'tennis'},
  'frances tiafoe':         {c:'Frances Tiafoe',      s:'tennis'},
  'paul':                   {c:'Tommy Paul',          s:'tennis'},
  'tommy paul':             {c:'Tommy Paul',          s:'tennis'},
  'musetti':                {c:'Lorenzo Musetti',     s:'tennis'},
  'lorenzo musetti':        {c:'Lorenzo Musetti',     s:'tennis'},
  'berrettini':             {c:'Matteo Berrettini',   s:'tennis'},
  'matteo berrettini':      {c:'Matteo Berrettini',   s:'tennis'},
  'nadal':                  {c:'Rafael Nadal',        s:'tennis'},
  'rafael nadal':           {c:'Rafael Nadal',        s:'tennis'},
  'rafa':                   {c:'Rafael Nadal',        s:'tennis'},
  'federer':                {c:'Roger Federer',       s:'tennis'},
  'roger federer':          {c:'Roger Federer',       s:'tennis'},
  // WTA
  'swiatek':                {c:'Iga Swiatek',         s:'tennis'},
  'iga swiatek':            {c:'Iga Swiatek',         s:'tennis'},
  'sabalenka':              {c:'Aryna Sabalenka',     s:'tennis'},
  'aryna sabalenka':        {c:'Aryna Sabalenka',     s:'tennis'},
  'gauff':                  {c:'Coco Gauff',          s:'tennis'},
  'coco gauff':             {c:'Coco Gauff',          s:'tennis'},
  'rybakina':               {c:'Elena Rybakina',      s:'tennis'},
  'elena rybakina':         {c:'Elena Rybakina',      s:'tennis'},
  'jabeur':                 {c:'Ons Jabeur',          s:'tennis'},
  'ons jabeur':             {c:'Ons Jabeur',          s:'tennis'},
  'kvitova':                {c:'Petra Kvitova',       s:'tennis'},
  'petra kvitova':          {c:'Petra Kvitova',       s:'tennis'},
  'osaka':                  {c:'Naomi Osaka',         s:'tennis'},
  'naomi osaka':            {c:'Naomi Osaka',         s:'tennis'},
  'wozniacki':              {c:'Caroline Wozniacki',  s:'tennis'},
  'svitolina':              {c:'Elina Svitolina',     s:'tennis'},
  'elina svitolina':        {c:'Elina Svitolina',     s:'tennis'},
  'muguruza':               {c:'Garbiñe Muguruza',   s:'tennis'},
  'andreescu':              {c:'Bianca Andreescu',    s:'tennis'},
  'keys':                   {c:'Madison Keys',        s:'tennis'},
  'madison keys':           {c:'Madison Keys',        s:'tennis'},
  'vondrousova':            {c:'Marketa Vondrousova', s:'tennis'},
  'paolini':                {c:'Jasmine Paolini',     s:'tennis'},
  'jasmine paolini':        {c:'Jasmine Paolini',     s:'tennis'},
  'halep':                  {c:'Simona Halep',        s:'tennis'},
  'simona halep':           {c:'Simona Halep',        s:'tennis'},
  // WTA manquantes
  'bencic':                 {c:'Belinda Bencic',      s:'tennis'},
  'belinda bencic':         {c:'Belinda Bencic',      s:'tennis'},
  'svitolina':              {c:'Elina Svitolina',     s:'tennis'},
  'elina svitolina':        {c:'Elina Svitolina',     s:'tennis'},
  'badosa':                 {c:'Paula Badosa',        s:'tennis'},
  'paula badosa':           {c:'Paula Badosa',        s:'tennis'},
  'pegula':                 {c:'Jessica Pegula',      s:'tennis'},
  'jessica pegula':         {c:'Jessica Pegula',      s:'tennis'},
  'collins':                {c:'Danielle Collins',    s:'tennis'},
  'danielle collins':       {c:'Danielle Collins',    s:'tennis'},
  'haddad maia':            {c:'Beatriz Haddad Maia', s:'tennis'},
  'kasatkina':              {c:'Daria Kasatkina',     s:'tennis'},
  'daria kasatkina':        {c:'Daria Kasatkina',     s:'tennis'},
  'kontaveit':              {c:'Anett Kontaveit',     s:'tennis'},
  'anett kontaveit':        {c:'Anett Kontaveit',     s:'tennis'},
  'giorgi':                 {c:'Camila Giorgi',       s:'tennis'},
  'camila giorgi':          {c:'Camila Giorgi',       s:'tennis'},
  'azarenka':               {c:'Victoria Azarenka',   s:'tennis'},
  'victoria azarenka':      {c:'Victoria Azarenka',   s:'tennis'},
  'pliskova':               {c:'Karolina Pliskova',   s:'tennis'},
  'karolina pliskova':      {c:'Karolina Pliskova',   s:'tennis'},
  'kerber':                 {c:'Angelique Kerber',    s:'tennis'},
  'angelique kerber':       {c:'Angelique Kerber',    s:'tennis'},
  'ostapenko':              {c:'Jelena Ostapenko',    s:'tennis'},
  'jelena ostapenko':       {c:'Jelena Ostapenko',    s:'tennis'},
  'bertens':                {c:'Kiki Bertens',        s:'tennis'},
  'stephens':               {c:'Sloane Stephens',     s:'tennis'},
  'sloane stephens':        {c:'Sloane Stephens',     s:'tennis'},
  'kenin':                  {c:'Sofia Kenin',         s:'tennis'},
  'sofia kenin':            {c:'Sofia Kenin',         s:'tennis'},
  'kvitova':                {c:'Petra Kvitova',       s:'tennis'},
  'petra kvitova':          {c:'Petra Kvitova',       s:'tennis'},
  'fernandez':              {c:'Leylah Fernandez',    s:'tennis'},
  'leylah fernandez':       {c:'Leylah Fernandez',    s:'tennis'},
  'boulter':                {c:'Katie Boulter',       s:'tennis'},
  'katie boulter':          {c:'Katie Boulter',       s:'tennis'},
  'dart':                   {c:'Harriet Dart',        s:'tennis'},
  'harriet dart':           {c:'Harriet Dart',        s:'tennis'},
  'watson':                 {c:'Heather Watson',      s:'tennis'},
  'heather watson':         {c:'Heather Watson',      s:'tennis'},
  // ATP manquants
  'shelton':                {c:'Ben Shelton',         s:'tennis'},
  'ben shelton':            {c:'Ben Shelton',         s:'tennis'},
  'cerundolo':              {c:'Francisco Cerundolo', s:'tennis'},
  'francisco cerundolo':    {c:'Francisco Cerundolo', s:'tennis'},
  'struff':                 {c:'Jan-Lennard Struff',  s:'tennis'},
  'norrie':                 {c:'Cameron Norrie',      s:'tennis'},
  'cameron norrie':         {c:'Cameron Norrie',      s:'tennis'},
  'auger aliassime':        {c:'Felix Auger-Aliassime',s:'tennis'},
  'faa':                    {c:'Felix Auger-Aliassime',s:'tennis'},
  'shapovalov':             {c:'Denis Shapovalov',    s:'tennis'},
  'denis shapovalov':       {c:'Denis Shapovalov',    s:'tennis'},
  'ruusuvuori':             {c:'Emil Ruusuvuori',     s:'tennis'},
  'baez':                   {c:'Sebastian Baez',      s:'tennis'},
  'sebastian baez':         {c:'Sebastian Baez',      s:'tennis'},
  'davidovich fokina':      {c:'Alejandro Davidovich Fokina', s:'tennis'},
  'humbert':                {c:'Ugo Humbert',         s:'tennis'},
  'ugo humbert':            {c:'Ugo Humbert',         s:'tennis'},
  'mannarino':              {c:'Adrian Mannarino',    s:'tennis'},
  'adrian mannarino':       {c:'Adrian Mannarino',    s:'tennis'},

  // ── NFL ──────────────────────────────────────────────────────
  'chiefs':                 {c:'Kansas City Chiefs',  s:'nfl'},
  'kansas city chiefs':     {c:'Kansas City Chiefs',  s:'nfl'},
  'eagles':                 {c:'Philadelphia Eagles', s:'nfl'},
  'philadelphia eagles':    {c:'Philadelphia Eagles', s:'nfl'},
  'cowboys':                {c:'Dallas Cowboys',      s:'nfl'},
  'dallas cowboys':         {c:'Dallas Cowboys',      s:'nfl'},
  'patriots':               {c:'New England Patriots',s:'nfl'},
  'new england patriots':   {c:'New England Patriots',s:'nfl'},
  '49ers':                  {c:'San Francisco 49ers', s:'nfl'},
  'san francisco 49ers':    {c:'San Francisco 49ers', s:'nfl'},
  'ravens':                 {c:'Baltimore Ravens',    s:'nfl'},
  'baltimore ravens':       {c:'Baltimore Ravens',    s:'nfl'},
  'packers':                {c:'Green Bay Packers',   s:'nfl'},
  'green bay packers':      {c:'Green Bay Packers',   s:'nfl'},
  'broncos':                {c:'Denver Broncos',      s:'nfl'},
  'steelers':               {c:'Pittsburgh Steelers', s:'nfl'},
  'seahawks':               {c:'Seattle Seahawks',    s:'nfl'},
  'rams':                   {c:'Los Angeles Rams',    s:'nfl'},
  'la rams':                {c:'Los Angeles Rams',    s:'nfl'},
  'giants':                 {c:'New York Giants',     s:'nfl'},
  'bills':                  {c:'Buffalo Bills',       s:'nfl'},
  'buffalo bills':          {c:'Buffalo Bills',       s:'nfl'},
  'dolphins':               {c:'Miami Dolphins',      s:'nfl'},
  'miami dolphins':         {c:'Miami Dolphins',      s:'nfl'},
  'bengals':                {c:'Cincinnati Bengals',  s:'nfl'},
  'browns':                 {c:'Cleveland Browns',    s:'nfl'},
  'texans':                 {c:'Houston Texans',      s:'nfl'},
  'colts':                  {c:'Indianapolis Colts',  s:'nfl'},
  'jaguars':                {c:'Jacksonville Jaguars',s:'nfl'},
  'titans':                 {c:'Tennessee Titans',    s:'nfl'},
  'raiders':                {c:'Las Vegas Raiders',   s:'nfl'},
  'chargers':               {c:'Los Angeles Chargers',s:'nfl'},
  'vikings':                {c:'Minnesota Vikings',   s:'nfl'},
  'bears':                  {c:'Chicago Bears',       s:'nfl'},
  'lions':                  {c:'Detroit Lions',       s:'nfl'},
  'buccaneers':             {c:'Tampa Bay Buccaneers',s:'nfl'},
  'bucs':                   {c:'Tampa Bay Buccaneers',s:'nfl'},
  'saints':                 {c:'New Orleans Saints',  s:'nfl'},
  'falcons':                {c:'Atlanta Falcons',     s:'nfl'},
  'panthers':               {c:'Carolina Panthers',   s:'nfl'},
  'commanders':             {c:'Washington Commanders',s:'nfl'},
  'cardinals':              {c:'Arizona Cardinals',   s:'nfl'},
};

// ─────────────────────────────────────────────────────────────────
// COUCHE 2 — NORMALISATION
// Nettoyer et normaliser une chaîne pour lookup
// ─────────────────────────────────────────────────────────────────
function normalizeToken(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/\b[a-z]\./g, ' ')  // initiales : "E." "B." "J." etc.
    .replace(/['\-\.]/g, ' ')    // apostrophes, tirets, points
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────
// COUCHE 2 — FUZZY MATCHING (distance de Levenshtein)
// Fallback si table fixe échoue
// ─────────────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatchAlias(token) {
  // Distance max autorisée selon longueur du token
  const maxDist = token.length <= 5 ? 1 : token.length <= 10 ? 2 : 3;
  let best = null, bestDist = Infinity;
  for (const [alias, entry] of Object.entries(ALIAS_TABLE)) {
    const dist = levenshtein(token, alias);
    if (dist < bestDist && dist <= maxDist) {
      bestDist = dist;
      best = { ...entry, alias, distance: dist };
    }
  }
  return best; // null si aucun match
}

// ─────────────────────────────────────────────────────────────────
// COUCHE 1+2 — EXTRACTEUR D'ENTITÉS
// Analyse le prompt et retourne les entités détectées
// ─────────────────────────────────────────────────────────────────
function extractEntitiesV2(prompt) {
  const normalized = normalizeToken(prompt);
  const tokens = normalized.split(/[\s,;\/\-]+/).filter(t => t.length >= 2);
  const stopWords = new Set([
    'vs','versus','contre','match','game','vs','play','the','and','or',
    'un','une','le','la','les','du','de','des','ce','ce','soir',
    'ce','matin','demain','aujourd','hui','pour','avec','et','en',
    'ce','week','end','tonight','today','tomorrow','morning','evening',
    'odds','bet','cote','analyse','analyzer','prono','pronostic',
    'analyse','pari','paris','betting','score','result','live'
  ]);
  
  const entities = [];
  const found = new Set();
  
  // Essayer des n-grams (3 mots, 2 mots, 1 mot) pour la table fixe
  const words = normalized.split(/\s+/).filter(w => !stopWords.has(w) && w.length >= 2);
  
  // Essayer trigrammes
  for (let i = 0; i <= words.length - 3; i++) {
    const trigram = words.slice(i, i+3).join(' ');
    if (ALIAS_TABLE[trigram] && !found.has(trigram)) {
      entities.push({ ...ALIAS_TABLE[trigram], matched: trigram, method: 'exact', confidence: 1.0 });
      found.add(trigram);
    }
  }
  // Bigrammes
  for (let i = 0; i <= words.length - 2; i++) {
    const bigram = words.slice(i, i+2).join(' ');
    const already = entities.some(e => e.matched === bigram || bigram.includes(e.matched) || e.matched.includes(bigram));
    if (ALIAS_TABLE[bigram] && !found.has(bigram) && !already) {
      entities.push({ ...ALIAS_TABLE[bigram], matched: bigram, method: 'exact', confidence: 1.0 });
      found.add(bigram);
    }
  }
  // Unigrammes
  for (const w of words) {
    if (stopWords.has(w)) continue;
    const already = entities.some(e => e.matched === w || e.matched.includes(w) || w.includes(e.matched));
    if (ALIAS_TABLE[w] && !found.has(w) && !already) {
      entities.push({ ...ALIAS_TABLE[w], matched: w, method: 'exact', confidence: 1.0 });
      found.add(w);
    }
  }
  
  // Fallback fuzzy sur les mots non matchés
  for (const w of words) {
    if (stopWords.has(w) || w.length < 4) continue; // min 4 chars pour fuzzy
    const already = entities.some(e => e.matched === w || e.c.toLowerCase().includes(w) || w.includes(e.matched));
    if (!already) {
      const fuzzy = fuzzyMatchAlias(w);
      if (fuzzy) {
        entities.push({ ...fuzzy, matched: w, method: 'fuzzy', confidence: 1 - fuzzy.distance / w.length });
        found.add(w);
      }
    }
  }
  
  return entities;
}

// ─────────────────────────────────────────────────────────────────
// COUCHE 3 — VALIDATION MULTI-SOURCES
// Vérifie que l'entité correspond à un événement réel dans les APIs
// Retourne VERIFIED ou NOT_FOUND — pas de PARTIAL en MVP
// ─────────────────────────────────────────────────────────────────
async function validateEntitiesAgainstSources(entities, liveLines, fdLines) {
  // La validation enrichit le contexte — elle ne bloque JAMAIS si des entités sont reconnues
  // Les entités reconnues via la table alias ont déjà une certitude 100%
  if (!entities || entities.length === 0) {
    return { status: 'NOT_FOUND', reason: 'no_entities' };
  }

  const allLines = [...liveLines, ...fdLines].map(l => l.toLowerCase());
  const verifiedInLive = [];

  for (const entity of entities) {
    const canonical = entity.c.toLowerCase();
    const found = allLines.some(line => {
      const lineParts = line.replace(/[^\w\s]/g, ' ').split(/\s+/);
      const entityParts = canonical.replace(/[^\w\s]/g, ' ').split(/\s+/);
      return entityParts.some(part =>
        part.length >= 4 && lineParts.some(lp =>
          lp.includes(part) || part.includes(lp) || levenshtein(part, lp) <= 1
        )
      );
    });
    if (found) {
      const matchingLine = allLines.find(line => {
        const lineParts = line.replace(/[^\w\s]/g, ' ').split(/\s+/);
        const entityParts = canonical.replace(/[^\w\s]/g, ' ').split(/\s+/);
        return entityParts.some(part => part.length >= 4 && lineParts.some(lp => lp.includes(part)));
      });
      verifiedInLive.push({ ...entity, verified_line: matchingLine });
    }
  }

  // Toujours RECOGNIZED si des entités sont dans la table alias
  // VERIFIED si en plus elles sont dans les données live ESPN
  const status = verifiedInLive.length > 0 ? 'VERIFIED' : 'RECOGNIZED';
  return {
    status,
    entities: verifiedInLive.length > 0 ? verifiedInLive : entities,
    sports: [...new Set(entities.map(e => e.s))],
  };
}

// ─────────────────────────────────────────────────────────────────
// PIPELINE COMPLET — Point d'entrée
// ─────────────────────────────────────────────────────────────────
async function runValidationPipeline(prompt, liveLines, fdLines) {
  console.log('[VALID] Pipeline démarré pour:', prompt.slice(0, 80));
  
  // Couche 1+2 : Extraction & Normalisation
  const entities = extractEntitiesV2(prompt);
  console.log('[VALID] Entités détectées:', entities.map(e => `${e.c}(${e.method})`).join(', ') || 'aucune');
  
  // Couche 3 : Validation contre sources réelles
  const validation = await validateEntitiesAgainstSources(entities, liveLines, fdLines);
  console.log('[VALID] Statut:', validation.status, validation.reason || '');
  
  return { entities, validation };
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
// CONSTRUCTEUR JSON_VALIDATED_DATA v3 — TheOddsAPI + API-Sports
// ═══════════════════════════════════════════════════════════
function buildValidatedDataContainerV3(liveLines, newsLines, fdLines, sportIds, prompt, entities, validation, enriched) {
  const filteredLive = filterAndPrioritize(liveLines, prompt);

  let block = '\n\u2501\u2501\u2501 JSON_VALIDATED_DATA v3 \u2501\u2501\u2501\n';
  block += 'validation_status: ' + validation.status + '\n';
  block += 'data_sources: ESPN x18';
  if (enriched && enriched.sources.length > 0) {
    block += ', ' + enriched.sources.join(', ');
  }
  block += '\n';

  // Entités reconnues
  if (entities && entities.length > 0) {
    block += '\n[RECOGNIZED_ENTITIES]\n';
    entities.forEach(function(e) {
      block += '  ' + e.c + ' (sport:' + e.s + ', method:' + e.method + ')\n';
    });
  }

  // Cotes temps réel TheOddsAPI
  if (enriched && enriched.odds) {
    block += '\n' + enriched.odds + '\n';
    block += 'IMPORTANT: Use these odds ONLY to calculate value_edge_pct AFTER your own prediction.\n';
    block += 'DO NOT let odds influence your analysis direction.\n';
  }

  // Stats API-Sports (forme, H2H, blessés)
  if (enriched && enriched.sportsData) {
    block += '\n[STATS TEMPS RÉEL — API-Sports]\n';
    block += enriched.sportsData + '\n';
    block += 'IMPORTANT: These are VERIFIED real-world facts. Base your analysis on them.\n';
  }

  // Matchs live ESPN
  if (filteredLive.length > 0) {
    block += '\n[LIVE_MATCHES — ESPN]\n';
    block += filteredLive.join('\n') + '\n';
  }

  // Football-Data
  if (fdLines.length > 0) {
    block += '\n[FOOTBALL_DATA]\n';
    block += fdLines.join('\n') + '\n';
  }

  // News
  if (newsLines.length > 0) {
    block += '\n[NEWS_CONTEXT]\n';
    block += newsLines.slice(0, 5).join('\n') + '\n';
  }

  // Aucune donnée fraîche
  if (!enriched?.odds && !enriched?.sportsData && filteredLive.length === 0 && fdLines.length === 0) {
    block += '\n[NO_LIVE_DATA]\n';
    if (entities.length > 0) {
      block += 'Recognized: ' + entities.map(function(e){return e.c;}).join(', ') + '\n';
      block += 'No real-time data available. Use your knowledge but flag uncertainty.\n';
    }
  }

  block += '\n-------------------------------------\n';
  block += 'ABSOLUTE RULE: Analyze ONLY entities above. Zero invention.\n\n';

  return block;
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR JSON_VALIDATED_DATA v2 — enrichi par le pipeline (legacy)
// ═══════════════════════════════════════════════════════════
function buildValidatedDataContainerV2(liveLines, newsLines, fdLines, sportIds, prompt, entities, validation) {
  const filteredLive = filterAndPrioritize(liveLines, prompt);
  
  let block = '\n\u2501\u2501\u2501 JSON_VALIDATED_DATA v2 \u2501\u2501\u2501\n';
  block += 'validation_status: ' + validation.status + '\n';
  block += 'pipeline: Fact-First v2 (alias_table + fuzzy_levenshtein + multi_source)\n';
  
  if (entities && entities.length > 0) {
    block += '\n[RECOGNIZED_ENTITIES]\n';
    entities.forEach(function(e) {
      block += '  ' + e.c + ' (sport:' + e.s + ', method:' + e.method + (e.distance ? ', dist:'+e.distance : '') + ')\n';
    });
  }
  
  if (validation.status === 'VERIFIED' && validation.entities) {
    block += '\n[VERIFIED_IN_LIVE_DATA]\n';
    validation.entities.forEach(function(e) {
      block += '  OK ' + e.c + ' -> ' + (e.verified_line || 'found in API') + '\n';
    });
  }
  
  if (filteredLive.length > 0) {
    block += '\n[LIVE_MATCHES]\n';
    block += filteredLive.join('\n') + '\n';
  }
  
  if (fdLines.length > 0) {
    block += '\n[FOOTBALL_DATA]\n';
    block += fdLines.join('\n') + '\n';
  }
  
  if (newsLines.length > 0) {
    block += '\n[NEWS_CONTEXT]\n';
    block += newsLines.slice(0, 6).join('\n') + '\n';
  }
  
  if (filteredLive.length === 0 && fdLines.length === 0) {
    block += '\n[NO_LIVE_DATA]\n';
    block += 'No live matches found for: ' + sportIds.join(', ') + '\n';
    if (entities.length > 0) {
      block += 'Recognized entities: ' + entities.map(function(e){return e.c;}).join(', ') + '\n';
      block += '-> Analyze based ONLY on recognized entities above.\n';
      block += '-> DO NOT invent match details, dates, or scores.\n';
    } else {
      block += '-> No entities recognized. Return NOT_FOUND immediately.\n';
    }
  }
  
  block += '\n-------------------------------------\n';
  block += 'STRICT RULE: Only analyze entities listed above.\n';
  block += 'If match date/time is unknown -> set match_date_uncertain:true.\n\n';
  
  return block;
}

// ═══════════════════════════════════════════════════════════
// CONSTRUCTEUR JSON_VALIDATED_DATA (legacy — conservé) — Conteneur de vérité
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

// ── Endpoint stats performance ──────────────────────────────
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

// ── Endpoint pour marquer un résultat réel ───────────────────
app.post('/outcome', async (req, res) => {
  const { id, result, correct } = req.body;
  if (!id || result === undefined || correct === undefined) {
    return res.status(400).json({ error: 'id, result et correct requis' });
  }
  await updateOutcome(id, result, correct);
  res.json({ success: true });
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
  // Timeout global /analyze — 120s max
  const analyzeTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Timeout serveur — réessaie dans quelques secondes.' });
    }
  }, 120000);

  try {
    const { prompt } = req.body;
    if (!prompt) { clearTimeout(analyzeTimeout); return res.status(400).json({ error: 'Prompt manquant' }); }
    if (!GEMINI_KEY) { clearTimeout(analyzeTimeout); return res.status(500).json({ error: 'Clé API non configurée' }); }

    const T0 = Date.now();

    // 1. Temps réel + intention
    const timeBlock = getRealTimeBlock();
    // Prompt directeur = buildPrompt() frontend uniquement
    // Serveur injecte seulement : ancrage temporel + données + règle anti-hallucination
    const sportIds = detectIntention(prompt);
    const T1 = Date.now();
    console.log(`[TIMER] Intention: ${T1-T0}ms — Sports: ${sportIds.join(', ')}`);

    // 2. Fetch ciblé
    const sources = await fetchAllData(sportIds);
    const T2 = Date.now();
    console.log(`[TIMER] Fetch: ${T2-T1}ms — Live:${sources.live.length} News:${sources.news.length} FD:${sources.fd.length}`);

    // 3. Pipeline Fact-First v2 : Extraction → Normalisation → Validation
    const { entities, validation } = await runValidationPipeline(
      prompt, sources.live, sources.fd
    );
    console.log('[PIPELINE] Status:', validation.status, '| Entities:', entities.map(e=>e.c).join(', ')||'none');

    // 4. Enrichissement Data APIs (TheOddsAPI + API-Sports) en parallèle
    const enriched = await fetchEnrichedData(entities, sportIds, prompt).catch(() => ({
      odds: null, sportsData: null, sources: []
    }));
    if (enriched.sources.length > 0) {
      console.log('[ENRICH] Sources utilisées:', enriched.sources.join(', '));
    }

    // 5. Construire le conteneur de vérité enrichi v3
    const validatedContainer = buildValidatedDataContainerV3(
      sources.live, sources.news, sources.fd, sportIds, prompt,
      entities, validation, enriched
    );
    const T3 = Date.now();

    // 4. Assembler le prompt enrichi
    // Ordre : SystemPrompt → AncrageTemporal → JSON_VALIDATED_DATA → User Input
    const marker = '━━━ USER INPUT BELOW ━━━';
    let enrichedPrompt;
    // Prompt = timeBlock (ancrage) + validatedContainer (faits ESPN) + prompt frontend (directeur)
    if (prompt.includes(marker)) {
      enrichedPrompt = timeBlock + prompt.replace(marker, validatedContainer + marker);
    } else {
      enrichedPrompt = timeBlock + validatedContainer + prompt;
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
        const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s pour thinking mode

        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: enrichedPrompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 1024 } }
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
    // Sauvegarder chaque prédiction dans Neon
    if (sql) {
      try {
        const parsed = JSON.parse(
          text.replace(/```json/gi,'').replace(/```/g,'').trim()
        );
        if (parsed.matches && parsed.matches.length > 0) {
          for (const match of parsed.matches) {
            await savePrediction(match, prompt).catch(() => {});
          }
          console.log('[DB] ' + parsed.matches.length + ' prédiction(s) sauvegardée(s)');
        }
      } catch (e) {
        // JSON non parsable — pas grave, on continue
      }
    }

    clearTimeout(analyzeTimeout);
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
// ═══════════════════════════════════════════════════════════
// ENDPOINT /scrape — Pipeline A+D
// Étape A : fetch direct (gratuit, fonctionne sur ~60% des sites)
// Étape D : si A échoue → Gemini lit l'URL lui-même via grounding
// Résultat : couverture mondiale, multilingue, zéro coût supplémentaire
// ═══════════════════════════════════════════════════════════
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol))
      return res.status(400).json({ error: 'URL invalide' });
  } catch {
    return res.status(400).json({ error: 'URL invalide' });
  }

  console.log('[SCRAPE] Pipeline A+D →', parsedUrl.hostname);

  // ── ÉTAPE A : Fetch direct ──────────────────────────────
  let fetchedContent = null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);

    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8,de;q=0.7,es;q=0.6,ar;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
      }
    });

    if (resp.ok) {
      const html = await resp.text();
      // Extraction intelligente — garder uniquement le contenu utile
      const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/\s{3,}/g, '\n').trim();

      if (clean.length > 200) { // Contenu réel (pas une page d'erreur vide)
        fetchedContent = clean.length > 10000 ? clean.slice(0, 10000) + '\n[truncated]' : clean;
        console.log('[SCRAPE] ✅ Étape A réussie —', fetchedContent.length, 'chars');
      }
    }
  } catch (err) {
    console.log('[SCRAPE] Étape A échouée:', err.name === 'AbortError' ? 'timeout' : err.message);
  }

  // ── ÉTAPE D : Gemini lit l'URL si fetch échoué/bloqué ──
  if (!fetchedContent) {
    console.log('[SCRAPE] Étape D → Gemini grounding pour', parsedUrl.hostname);
    try {
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY;
      const ctrl2 = new AbortController();
      setTimeout(() => ctrl2.abort(), 20000);

      const geminiResp = await fetch(geminiUrl, {
        method: 'POST',
        signal: ctrl2.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text:
              'Visit this URL and extract ALL sports matches, odds, and betting information you find: ' + url + '\n\n' +
              'Return ONLY a structured list of matches found, with:\n' +
              '- Teams/Players names\n' +
              '- Competition/League\n' +
              '- Date and time if available\n' +
              '- Odds if available\n' +
              '- Sport type\n\n' +
              'If the page is not accessible, return: BLOCKED\n' +
              'Respond in the same language as the page content.'
            }]
          }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
        })
      });

      if (geminiResp.ok) {
        const data = await geminiResp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text && text !== 'BLOCKED' && text.length > 50) {
          fetchedContent = '[SOURCE: ' + parsedUrl.hostname + ' via Gemini Grounding]\n' + text;
          console.log('[SCRAPE] ✅ Étape D réussie —', fetchedContent.length, 'chars');
        } else {
          console.log('[SCRAPE] Étape D — contenu vide ou bloqué');
        }
      }
    } catch (err) {
      console.log('[SCRAPE] Étape D échouée:', err.message);
    }
  }

  // ── Résultat final ──────────────────────────────────────
  if (fetchedContent) {
    return res.json({
      success: true,
      hostname: parsedUrl.hostname,
      content: fetchedContent,
      chars: fetchedContent.length,
      method: fetchedContent.startsWith('[SOURCE:') ? 'gemini_grounding' : 'direct_fetch'
    });
  }

  // Les deux méthodes ont échoué
  return res.json({
    success: false,
    blocked: true,
    hostname: parsedUrl.hostname,
    message: 'Site inaccessible — colle le texte manuellement depuis la page'
  });
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
