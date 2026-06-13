// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH — MODULE 1 : Framework de Backtesting
// backtest.js : Valide le taux de précision du moteur sur matchs passés
// Usage : node backtest.js [--sport foot] [--limit 20] [--dry-run]
// ═══════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');
const { buildPrompt, GEMINI_SYSTEM_PROMPT, computeKellyAndValueEdge } = require('./engine.js');

// ── Config ──────────────────────────────────────────────────────────
const GEMINI_KEY  = process.env.GEMINI_KEY  || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const MOCKS_DIR   = path.join(__dirname, 'test', 'mocks');
const MODELS      = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// ── Args CLI ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CLI  = {
  sport:  args[includes('--sport')]  ? args[args.indexOf('--sport')  + 1] : null,
  limit:  args.includes('--limit')   ? parseInt(args[args.indexOf('--limit') + 1]) : 50,
  dryRun: args.includes('--dry-run'),
};
function includes(flag) { return args.includes(flag); }

// ── Couleurs console ─────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan:  '\x1b[36m', grey: '\x1b[90m', blue: '\x1b[34m',
};
const log = {
  ok:   (s) => console.log(`${C.green}✅${C.reset} ${s}`),
  err:  (s) => console.log(`${C.red}❌${C.reset} ${s}`),
  warn: (s) => console.log(`${C.yellow}⚠️${C.reset}  ${s}`),
  info: (s) => console.log(`${C.cyan}ℹ️${C.reset}  ${s}`),
  head: (s) => console.log(`\n${C.bold}${C.blue}${s}${C.reset}`),
};

// ── Appel Gemini ─────────────────────────────────────────────────────
async function callGeminiForTest(apiData) {
  const userPrompt = buildPrompt(apiData);

  for (const model of MODELS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.0, responseMimeType: 'application/json' },
          }),
        }
      );
      clearTimeout(timer);
      if (!res.ok) continue;

      const data = await res.json();
      const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;

      const result = JSON.parse(raw.trim());
      return { model, result };
    } catch (e) {
      // fallback au prochain modèle
    }
  }
  throw new Error('Gemini indisponible');
}

// ── Déterminer l'issue prédite ────────────────────────────────────────
function predictedOutcome(fp) {
  const { home_win, draw, away_win } = fp;
  const d = draw || 0;
  if (home_win >= away_win && home_win >= d) return 'HOME_WIN';
  if (away_win > home_win && away_win >= d)  return 'AWAY_WIN';
  return 'DRAW';
}

// ── Kelly théorique ───────────────────────────────────────────────────
function theoreticalKelly(fp, outcome, historicalOdds) {
  if (!historicalOdds) return null;
  const probMap = { HOME_WIN: fp.home_win, AWAY_WIN: fp.away_win, DRAW: fp.draw || 0 };
  const prob = probMap[outcome] || 0;
  const odds = historicalOdds[outcome] || 0;
  if (!odds || odds <= 1) return null;
  return computeKellyAndValueEdge({ final_probability: fp, confidence: Math.round(prob * 100) }, odds);
}

// ── Chargement des mocks ──────────────────────────────────────────────
function loadMocks() {
  if (!fs.existsSync(MOCKS_DIR)) {
    log.warn(`Dossier mocks absent : ${MOCKS_DIR}`);
    log.info('Création du dossier avec exemples...');
    fs.mkdirSync(MOCKS_DIR, { recursive: true });
    generateSampleMocks();
  }

  let files = fs.readdirSync(MOCKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(MOCKS_DIR, f), 'utf8'));
      } catch(e) {
        log.warn(`Mock invalide ignoré : ${f}`);
        return null;
      }
    })
    .filter(Boolean);

  if (CLI.sport) files = files.filter(m => m.apiData?.sport === CLI.sport);
  if (CLI.limit)  files = files.slice(0, CLI.limit);

  return files;
}

// ── Génère 10 mocks d'exemple si dossier vide ─────────────────────────
function generateSampleMocks() {
  const samples = [
    {
      id: 'mock_foot_001',
      apiData: {
        sport: 'football', home: 'PSG', away: 'Marseille',
        competition: 'Ligue 1', date: '2025-11-03T20:00:00Z',
        isDerbyOrRivalry: true, isMinorLeague: false,
        homeRank: 1, awayRank: 3,
        environment: { travelTimeHours: 0, weatherCondition: 'clear', temperatureCelsius: 14,
                       baseballWindDirection: 'none', homeLastMatchHoursAgo: 120, awayLastMatchHoursAgo: 120 },
        context: { homeCrisis: false, awayCrisis: false, homeNewCoachThisWeek: false, awayNewCoachThisWeek: false },
        homeAbsences: { goalkeeper: false, topScorer: false, captain: true },
        awayAbsences: { goalkeeper: false, topScorer: true,  captain: false },
        homeSubDepth: {}, awaySubDepth: {},
        sportSpecific: {},
        homeTitleRace: true, homeRelegation: false,
        awayTitleRace: false, awayRelegation: false,
        homeWinStreak: 4, awayWinStreak: 1,
        advancedMetrics: { xG: { homeFor: 2.1, homeUnderperforming: false, awayFor: 0.9, awayUnderperforming: true } },
        h2hSameVenue: true, h2hHomeWinRate: 0.6,
        userLang: 'fr',
      },
      actual_outcome: 'HOME_WIN',
      historical_odds: { HOME_WIN: 1.65, DRAW: 3.80, AWAY_WIN: 5.20 },
    },
    {
      id: 'mock_basket_001',
      apiData: {
        sport: 'basketball', home: 'Boston Celtics', away: 'Miami Heat',
        competition: 'NBA', date: '2025-11-10T01:30:00Z',
        isDerbyOrRivalry: false, isMinorLeague: false,
        homeRank: 2, awayRank: 8,
        environment: { travelTimeHours: 3, weatherCondition: 'clear', temperatureCelsius: 18,
                       baseballWindDirection: 'none', homeLastMatchHoursAgo: 20, awayLastMatchHoursAgo: 48 },
        context: { homeCrisis: false, awayCrisis: false, homeNewCoachThisWeek: false, awayNewCoachThisWeek: false },
        homeAbsences: {}, awayAbsences: {},
        homeSubDepth: {}, awaySubDepth: {},
        sportSpecific: { homeFranchisePlayerOut: false, awayFranchisePlayerOut: true },
        homeTitleRace: true, homeRelegation: false,
        awayTitleRace: false, awayRelegation: false,
        homeWinStreak: 5, awayWinStreak: 0,
        advancedMetrics: { netRating: { home: 7.2, away: -2.1 } },
        h2hSameVenue: false, h2hHomeWinRate: null,
        userLang: 'en',
      },
      actual_outcome: 'HOME_WIN',
      historical_odds: { HOME_WIN: 1.45, AWAY_WIN: 2.75 },
    },
    {
      id: 'mock_tennis_001',
      apiData: {
        sport: 'tennis', home: 'Jannik Sinner', away: 'Carlos Alcaraz',
        competition: 'Roland Garros', date: '2025-06-05T14:00:00Z',
        isDerbyOrRivalry: false, isMinorLeague: false,
        homeRank: 1, awayRank: 2,
        environment: { travelTimeHours: 0, weatherCondition: 'clear', temperatureCelsius: 22,
                       baseballWindDirection: 'none', homeLastMatchHoursAgo: 48, awayLastMatchHoursAgo: 48 },
        context: { homeCrisis: false, awayCrisis: false, homeNewCoachThisWeek: false, awayNewCoachThisWeek: false },
        homeAbsences: {}, awayAbsences: {},
        homeSubDepth: {}, awaySubDepth: {},
        sportSpecific: { playerAbsent: false },
        homeTitleRace: false, homeRelegation: false,
        awayTitleRace: false, awayRelegation: false,
        homeWinStreak: 3, awayWinStreak: 3,
        advancedMetrics: { tennisSurface: { surface: 'clay', homeWinPct: 68, awayWinPct: 78, h2hHomeWins: 3, h2hTotal: 7 } },
        h2hSameVenue: false, h2hHomeWinRate: null,
        userLang: 'en',
      },
      actual_outcome: 'AWAY_WIN',
      historical_odds: { HOME_WIN: 2.10, AWAY_WIN: 1.72 },
    },
  ];

  samples.forEach(s => {
    fs.writeFileSync(path.join(MOCKS_DIR, `${s.id}.json`), JSON.stringify(s, null, 2));
  });
  log.ok(`${samples.length} mocks d'exemple générés dans ${MOCKS_DIR}`);
}

// ── Pause entre requêtes (rate limit Gemini) ──────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── MAIN ──────────────────────────────────────────────────────────────
async function runBacktest() {
  log.head('════════════════════════════════════════');
  log.head('  SUPERCOACH — BACKTESTING ENGINE v1.0  ');
  log.head('════════════════════════════════════════');

  const mocks = loadMocks();
  if (!mocks.length) { log.err('Aucun mock trouvé. Arrêt.'); process.exit(1); }

  log.info(`${mocks.length} matchs chargés${CLI.sport ? ` [sport: ${CLI.sport}]` : ''}`);
  if (CLI.dryRun) log.warn('Mode DRY-RUN : aucun appel Gemini réel');

  const results = [];
  let correct = 0;
  let kellyProfit = 0;
  let kellyBets   = 0;
  const byPsort   = {};

  for (let i = 0; i < mocks.length; i++) {
    const mock = mocks[i];
    const { apiData, actual_outcome, historical_odds } = mock;
    const id = mock.id || `match_${i+1}`;

    process.stdout.write(`\r${C.grey}[${i+1}/${mocks.length}] ${id}...${C.reset}`);

    let predicted, confidence, fp, modelUsed, error;

    if (CLI.dryRun) {
      // Mode dry-run : simuler une réponse aléatoire
      fp = { home_win: 0.55, draw: 0.25, away_win: 0.20 };
      predicted = predictedOutcome(fp);
      confidence = 55;
      modelUsed = 'dry-run';
    } else {
      try {
        await sleep(1200); // 50 req/min max Gemini
        const { model, result } = await callGeminiForTest(apiData);
        fp        = result.final_probability;
        predicted = predictedOutcome(fp);
        confidence = result.confidence;
        modelUsed = model;
      } catch(e) {
        error = e.message;
        results.push({ id, sport: apiData.sport, predicted: 'ERROR', actual: actual_outcome,
                       correct: false, confidence: 0, error, model: 'none' });
        continue;
      }
    }

    const isCorrect = predicted === actual_outcome;
    if (isCorrect) correct++;

    // Kelly théorique
    const kelly = theoreticalKelly(fp, actual_outcome, historical_odds);
    if (kelly && kelly.valueEdgePct > 0 && kelly.kellyUnits > 0 && confidence >= 65) {
      kellyBets++;
      const odds = historical_odds[actual_outcome] || 0;
      if (isCorrect && odds > 1) {
        kellyProfit += kelly.kellyUnits * (odds - 1);
      } else {
        kellyProfit -= kelly.kellyUnits;
      }
    }

    // Stats par sport
    const sp = apiData.sport || 'unknown';
    if (!byPsort[sp]) byPsort[sp] = { total: 0, correct: 0 };
    byPsort[sp].total++;
    if (isCorrect) byPsort[sp].correct++;

    results.push({ id, sport: sp, predicted, actual: actual_outcome, correct: isCorrect,
                   confidence, model: modelUsed, fp });
  }

  // ── Affichage des résultats ─────────────────────────────────────────
  console.log('\n');
  log.head('══════════ RÉSULTATS ══════════');

  const total    = results.filter(r => r.predicted !== 'ERROR').length;
  const errors   = results.filter(r => r.predicted === 'ERROR').length;
  const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';

  console.log(`\n  Matchs analysés : ${C.bold}${total}${C.reset} (${errors} erreurs)`);
  console.log(`  Prédictions correctes : ${C.bold}${correct}${C.reset}`);
  console.log(`  ${C.bold}Accuracy globale : ${accuracy >= 70 ? C.green : accuracy >= 60 ? C.yellow : C.red}${accuracy}%${C.reset}`);

  // Breakdown par sport
  console.log('\n  ── Par sport :');
  Object.entries(byPsort).forEach(([sport, s]) => {
    const pct = (s.correct / s.total * 100).toFixed(1);
    const col = pct >= 70 ? C.green : pct >= 55 ? C.yellow : C.red;
    console.log(`     ${sport.padEnd(12)} ${col}${pct}%${C.reset} (${s.correct}/${s.total})`);
  });

  // Kelly
  console.log('\n  ── Simulation Kelly (25% fractionné) :');
  console.log(`     Mises générées : ${kellyBets}`);
  const profitColor = kellyProfit >= 0 ? C.green : C.red;
  console.log(`     ROI théorique : ${profitColor}${kellyProfit >= 0 ? '+' : ''}${kellyProfit.toFixed(2)} unités${C.reset}`);

  // Détail des erreurs
  if (errors > 0) {
    console.log('\n  ── Erreurs :');
    results.filter(r => r.predicted === 'ERROR').forEach(r => {
      console.log(`     ${r.id} : ${C.red}${r.error}${C.reset}`);
    });
  }

  // Sauvegarder rapport JSON
  const report = {
    timestamp: new Date().toISOString(),
    total, correct, errors,
    accuracy: parseFloat(accuracy),
    kellyBets, kellyProfit: parseFloat(kellyProfit.toFixed(2)),
    byPsort, results,
  };
  const reportPath = path.join(__dirname, 'test', `backtest_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log.info(`Rapport sauvegardé : ${reportPath}`);

  log.head('═══════════════════════════════');
  process.exit(0);
}

runBacktest().catch(e => { log.err(e.message); process.exit(1); });
