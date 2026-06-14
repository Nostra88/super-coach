// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH — Backtesting Engine (module exportable)
// Appelé par server.js via POST /run-backtest
// ou en CLI : node test/backtest.js [--sport football] [--limit 20]
// ═══════════════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const { buildPrompt, GEMINI_SYSTEM_PROMPT, computeKellyAndValueEdge } = require('../engine.js');

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const SLEEP_MS = 6000; // 10 req/min → respecte quota Gemini Free Tier

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Appel Gemini avec cascade flash → flash-lite ──────────────────
async function callGeminiSingle(apiData, geminiKey) {
  const userPrompt = buildPrompt(apiData);
  for (const model of MODELS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 22000);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
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
      if (!res.ok) { console.warn(`[BT] ${model} HTTP ${res.status}`); continue; }
      const data = await res.json();
      const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;
      const result = JSON.parse(raw.trim());
      return { model, result };
    } catch(e) {
      console.warn(`[BT] ${model} error: ${e.message}`);
    }
  }
  throw new Error('Gemini indisponible');
}

// ── Issue prédite depuis final_probability ────────────────────────
function predictedOutcome(fp) {
  const { home_win, draw = 0, away_win } = fp;
  if (home_win >= away_win && home_win >= draw) return 'HOME_WIN';
  if (away_win > home_win && away_win >= draw)  return 'AWAY_WIN';
  return 'DRAW';
}

// ── Issue prédite par le favori des cotes (baseline bookmaker) ────
function bookmakerFavorite(odds) {
  if (!odds) return null;
  return Object.entries(odds).reduce((a, b) => a[1] < b[1] ? a : b)[0];
}

// ── Normaliser les probabilités (cap 0.05/0.95, somme=1) ─────────
function normalizeFP(fp, sport) {
  const twoWay = ['basketball', 'tennis', 'baseball'].includes(sport);
  if (twoWay) fp.draw = 0;
  ['home_win', 'draw', 'away_win'].forEach(k => {
    fp[k] = Math.min(0.95, Math.max(0, Number(fp[k]) || 0));
  });
  if (twoWay) fp.draw = 0;
  const total = fp.home_win + fp.draw + fp.away_win;
  if (total > 0) { fp.home_win /= total; fp.draw /= total; fp.away_win /= total; }
  return fp;
}

// ── Simulation Kelly théorique ────────────────────────────────────
function kellyTheo(fp, actual, odds) {
  if (!odds || !odds[actual]) return null;
  const probMap = { HOME_WIN: fp.home_win, AWAY_WIN: fp.away_win, DRAW: fp.draw || 0 };
  const prob = probMap[actual] || 0;
  const o    = odds[actual];
  if (o <= 1.01) return null;
  const edge = prob - (1 / o);
  const kellyFull = (prob * o - 1) / (o - 1);
  const units = Math.max(0, Math.min(5, Math.round(kellyFull * 0.25 * 100) / 100));
  return { edge: Math.round(edge * 1000) / 10, units };
}

// ── MOTEUR PRINCIPAL DE BACKTESTING ──────────────────────────────
async function runBacktest({ mocks, geminiKey, onProgress }) {
  const results      = [];
  const bySport      = {};
  let geminiOK       = 0;   // matchs bien prédits
  let geminiAnswered = 0;   // matchs où Gemini a répondu (bon ou mauvais)
  let bookOK         = 0;
  let kellyProfit    = 0;
  let kellyBets      = 0;

  for (let i = 0; i < mocks.length; i++) {
    const mock = mocks[i];
    const { apiData, actual_outcome, historical_odds } = mock;
    const id     = mock.id || `match_${i+1}`;
    const sport  = apiData.sport || 'unknown';

    if (!bySport[sport]) bySport[sport] = {
      total:0, geminiOK:0, bookOK:0, details:[]
    };

    // Baseline bookmaker
    const bookPredicted = bookmakerFavorite(historical_odds);
    const bookCorrect   = bookPredicted === actual_outcome;
    if (bookCorrect) bookOK++;
    bySport[sport].total++;
    if (bookCorrect) bySport[sport].bookOK++;

    // Si dry-run (pas de clé), skip Gemini
    if (!geminiKey) {
      bySport[sport].details.push({ id, actual: actual_outcome, gemini: null, bookPred: bookPredicted, bookOK: bookCorrect });
      results.push({ id, sport, actual: actual_outcome, gemini: null, geminiOK: false, bookPred: bookPredicted, bookOK: bookCorrect });
      if (onProgress) onProgress({ i: i+1, total: mocks.length, id });
      continue;
    }

    // Appel Gemini (avec pause rate-limit)
    if (i > 0) await sleep(SLEEP_MS);

    let geminiPred = null, confidence = 0, model = 'none', fp = null, error = null;
    try {
      const { model: m, result } = await callGeminiSingle(apiData, geminiKey);
      model      = m;
      fp         = normalizeFP(result.final_probability, sport);
      geminiPred = predictedOutcome(fp);
      confidence = result.confidence || Math.round(Math.max(fp.home_win, fp.draw||0, fp.away_win) * 100);
    } catch(e) {
      error = e.message;
    }

    const geminiCorrect = geminiPred === actual_outcome;
    if (geminiPred) {
      geminiAnswered++;
      if (geminiCorrect) { geminiOK++; bySport[sport].geminiOK++; }
    }

    // Kelly théorique
    if (fp && confidence >= 60 && !error) {
      const kelly = kellyTheo(fp, actual_outcome, historical_odds);
      if (kelly && kelly.edge > 0 && kelly.units > 0) {
        kellyBets++;
        const o = (historical_odds || {})[actual_outcome] || 0;
        if (geminiCorrect && o > 1) kellyProfit += kelly.units * (o - 1);
        else if (!geminiCorrect)    kellyProfit -= kelly.units;
      }
    }

    const row = { id, sport, actual: actual_outcome,
      geminiPred, geminiOK: geminiCorrect, confidence, model,
      bookPred: bookPredicted, bookOK: bookCorrect,
      fp, error: error || null };

    results.push(row);
    bySport[sport].details.push(row);
    if (onProgress) onProgress({ i: i+1, total: mocks.length, id, geminiPred, actual_outcome, geminiCorrect });
  }

  // ── Calcul des taux finaux ─────────────────────────────────────
  const total   = mocks.length;
  // geminiAcc : basé sur matchs répondus (geminiAnswered), pas seulement corrects
  // Permet de distinguer "0% de précision" de "n'a pas répondu"
  const geminiAcc = geminiAnswered > 0 ? Math.round(geminiOK / geminiAnswered * 1000) / 10 : null;
  const geminiCoverage = total > 0 ? Math.round(geminiAnswered / total * 1000) / 10 : 0;
  const bookAcc   = Math.round(bookOK / total * 1000) / 10;
  const edge      = geminiAcc !== null ? Math.round((geminiAcc - bookAcc) * 10) / 10 : null;

  const sportSummary = {};
  Object.entries(bySport).forEach(([s, v]) => {
    sportSummary[s] = {
      total:     v.total,
      geminiAcc: geminiKey && v.geminiOK > 0 ? Math.round(v.geminiOK / v.total * 1000) / 10 : null,
      bookAcc:   Math.round(v.bookOK / v.total * 1000) / 10,
      edge:      geminiKey && v.geminiOK >= 0 ? Math.round((v.geminiOK / v.total - v.bookOK / v.total) * 1000) / 10 : null,
    };
  });

  return {
    timestamp:    new Date().toISOString(),
    total,
    gemini:  { correct: geminiOK, answered: geminiAnswered, coverage: geminiCoverage, accuracy: geminiAcc },
    bookmaker: { correct: bookOK, accuracy: bookAcc },
    edge,
    kelly:   { bets: kellyBets, profit: Math.round(kellyProfit * 100) / 100 },
    bySport: sportSummary,
    results,
  };
}

// ── Export pour server.js ─────────────────────────────────────────
module.exports = { runBacktest };

// ── CLI direct (node test/backtest.js) ───────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sportFilter = args.includes('--sport') ? args[args.indexOf('--sport') + 1] : null;
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 999;
  const geminiKey = dryRun ? null : (process.env.GEMINI_KEY || '');

  // Charger mocks depuis le dossier local
  const fs   = require('fs');
  const dir  = path.join(__dirname, 'mocks');
  if (!fs.existsSync(dir)) { console.error('Dossier test/mocks introuvable'); process.exit(1); }

  let mocks = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch(e) { return null; } })
    .filter(Boolean);

  if (sportFilter) mocks = mocks.filter(m => m.apiData?.sport === sportFilter);
  mocks = mocks.slice(0, limit);

  console.log(`\n🔄 Backtesting ${mocks.length} matchs${dryRun ? ' [DRY-RUN]' : ''}...\n`);

  runBacktest({ mocks, geminiKey, onProgress: ({ i, total, id, geminiPred, actual_outcome, geminiCorrect }) => {
    if (geminiPred) {
      const icon = geminiCorrect ? '✅' : '❌';
      console.log(`  [${i}/${total}] ${icon} ${id} → ${geminiPred} (réel: ${actual_outcome})`);
    } else {
      console.log(`  [${i}/${total}] ⏭ ${id} (dry-run)`);
    }
  }}).then(report => {
    console.log('\n════════════════════════════════════');
    console.log('  RÉSULTATS BACKTESTING SUPERCOACH');
    console.log('════════════════════════════════════');
    console.log(`  Total matchs    : ${report.total}`);
    if (report.gemini.accuracy !== null)
      console.log(`  Gemini accuracy : ${report.gemini.accuracy}%`);
    console.log(`  Baseline cotes  : ${report.bookmaker.accuracy}%`);
    if (report.edge !== null)
      console.log(`  Edge vs baseline: ${report.edge > 0 ? '+' : ''}${report.edge}%`);
    console.log(`  Kelly profit    : ${report.kelly.profit >= 0 ? '+' : ''}${report.kelly.profit} unités (${report.kelly.bets} mises)`);
    console.log('\n  Par sport:');
    Object.entries(report.bySport).forEach(([s, v]) => {
      const g = v.geminiAcc !== null ? `Gemini ${v.geminiAcc}% | ` : '';
      console.log(`    ${s.padEnd(12)}: ${g}Baseline ${v.bookAcc}%  (${v.total} matchs)`);
    });
    console.log('\n════════════════════════════════════');
    // Sauvegarder rapport
    const rp = path.join(__dirname, `report_${Date.now()}.json`);
    fs.writeFileSync(rp, JSON.stringify(report, null, 2));
    console.log(`  Rapport: ${rp}`);
  }).catch(e => { console.error('Erreur:', e.message); process.exit(1); });
}
