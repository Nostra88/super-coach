'use strict';

/**
 * goalMarkets.js — marchés football BTTS / Over-Under / Buteurs
 * Calcul déterministe uniquement. Aucune invention de stats.
 * Niveau A = lambdas xG ou GF/GA + minutes/titulaire pour buteurs
 * Niveau B = GF/GA seuls
 * Niveau C = marché indisponible
 */

function kellyFromProb(prob, userOdds, confidence) {
  if (!userOdds || userOdds <= 1.01) return null;
  const targetProb = clamp01(prob);
  if (targetProb == null) return null;
  const impliedProb = 1 / userOdds;
  const valueEdgePct = Math.round((targetProb - impliedProb) * 100 * 10) / 10;
  const kellyFull = (targetProb * userOdds - 1) / (userOdds - 1);
  const kellyUnits = Math.max(0, Math.min(5, Math.round(kellyFull * 0.25 * 10 * 10) / 10));
  const recommendation =
    valueEdgePct > 0 && (confidence || 0) >= 70 ? 'VALUE BET DÉTECTÉ' :
    valueEdgePct > 0 ? 'EDGE POSITIF — CONFIANCE INSUFFISANTE' :
    'PAS DE VALUE — NE PAS MISER';
  return { valueEdgePct, kellyUnits, recommendation, outcomeUsed: 'selection' };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function poissonCdfLe(k, lambda) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += poissonPmf(i, lambda);
  return s;
}

function complementary(p) {
  const a = clamp01(p);
  if (a == null) return null;
  return { yes: round4(a), no: round4(1 - a) };
}

function pairLine(overProb) {
  const p = clamp01(overProb);
  if (p == null) return { available: false, reason: 'Données insuffisantes pour une estimation fiable.' };
  return {
    available: true,
    level: null,
    over: round4(p),
    under: round4(1 - p),
  };
}

function readLambdas(apiData) {
  if (!apiData || typeof apiData !== 'object') return { ok: false, level: 'C', reason: 'apiData absent' };
  const sport = String(apiData.sport || '').toLowerCase();
  if (sport && sport !== 'football' && sport !== 'foot' && sport !== 'soccer') {
    return { ok: false, level: 'C', reason: 'Marchés buts réservés au football.' };
  }

  const xg = (apiData.advancedMetrics && apiData.advancedMetrics.xG) || {};
  const ts = apiData.teamStats || {};
  const homeXg = Number(xg.homeFor);
  const awayXg = Number(xg.awayFor);
  const homeXga = Number(xg.homeAgainst);
  const awayXga = Number(xg.awayAgainst);

  if (Number.isFinite(homeXg) && Number.isFinite(awayXg) && homeXg >= 0 && awayXg >= 0) {
    let lh = homeXg;
    let la = awayXg;
    if (Number.isFinite(awayXga) && awayXga >= 0) lh = (homeXg + awayXga) / 2;
    if (Number.isFinite(homeXga) && homeXga >= 0) la = (awayXg + homeXga) / 2;
    return { ok: true, level: 'A', lambdaHome: lh, lambdaAway: la };
  }

  const hg = Number(ts.homeGf);
  const ag = Number(ts.awayGf);
  const hga = Number(ts.homeGa);
  const aga = Number(ts.awayGa);
  if ([hg, ag, hga, aga].every(n => Number.isFinite(n) && n >= 0)) {
    return {
      ok: true,
      level: 'B',
      lambdaHome: (hg + aga) / 2,
      lambdaAway: (ag + hga) / 2,
    };
  }

  if (Number.isFinite(hg) && Number.isFinite(ag) && hg >= 0 && ag >= 0) {
    return { ok: true, level: 'B', lambdaHome: hg, lambdaAway: ag };
  }

  return { ok: false, level: 'C', reason: 'Données insuffisantes pour une estimation fiable.' };
}

function pBttsYes(lh, la) {
  const pHome0 = poissonPmf(0, lh);
  const pAway0 = poissonPmf(0, la);
  return (1 - pHome0) * (1 - pAway0);
}

function pOver(line, lh, la) {
  const max = Math.max(12, Math.ceil(line) + 8);
  let p = 0;
  for (let h = 0; h <= max; h++) {
    for (let a = 0; a <= max; a++) {
      if (h + a > line) p += poissonPmf(h, lh) * poissonPmf(a, la);
    }
  }
  return p;
}

function withValue(prob, odds, confidence) {
  const p = clamp01(prob);
  if (p == null) return { probability: null };
  const out = { probability: round4(p) };
  const o = Number(odds);
  if (Number.isFinite(o) && o > 1.01) {
    const kelly = kellyFromProb(p, o, confidence);
    if (kelly) {
      out.odds = o;
      out.implied = round4(1 / o);
      out.valueEdgePct = kelly.valueEdgePct;
      out.kellyUnits = kelly.kellyUnits;
    }
  }
  return out;
}

function computeScorers(apiData) {
  const sport = String((apiData && apiData.sport) || '').toLowerCase();
  if (sport && sport !== 'football' && sport !== 'foot' && sport !== 'soccer') {
    return { available: false, reason: 'Buteurs réservés au football.', players: [] };
  }
  const list = (apiData && apiData.players) || [];
  if (!Array.isArray(list) || !list.length) {
    return { available: false, reason: 'Données insuffisantes pour une estimation fiable.', players: [] };
  }

  const players = [];
  for (const raw of list) {
    if (!raw || !raw.name) continue;
    const starter = raw.starterConfirmed === true || raw.starting === true;
    const minutes = Number(raw.expectedMinutes);
    const uncertain = raw.starterConfirmed === false || raw.starting === false ||
      (Number.isFinite(minutes) && minutes < 45) ||
      (raw.starterConfirmed == null && raw.starting == null);

    if (uncertain || !starter) {
      players.push({
        name: String(raw.name),
        market: 'anytime',
        available: false,
        reason: 'Titularisation non confirmée',
        firstScorer: { available: false, reason: 'Marché indisponible.' },
        twoPlus: { available: false, reason: 'Marché indisponible.' },
      });
      continue;
    }

    const g90 = Number(raw.goalsPer90 != null ? raw.goalsPer90 : raw.goals90);
    const xg90 = Number(raw.xgPer90 != null ? raw.xgPer90 : raw.xg90);
    const rate = Number.isFinite(xg90) && xg90 >= 0 ? xg90 : (Number.isFinite(g90) && g90 >= 0 ? g90 : null);
    if (rate == null) {
      players.push({
        name: String(raw.name),
        market: 'anytime',
        available: false,
        reason: 'Statistiques absentes',
        firstScorer: { available: false, reason: 'Marché indisponible.' },
        twoPlus: { available: false, reason: 'Marché indisponible.' },
      });
      continue;
    }

    const mins = Number.isFinite(minutes) ? Math.min(90, Math.max(45, minutes)) : 90;
    const lambda = rate * (mins / 90);
    const pAnytime = 1 - Math.exp(-lambda);
    const pTwoPlus = 1 - poissonPmf(0, lambda) - poissonPmf(1, lambda);
    const conf = Number.isFinite(xg90) ? 72 : 64;
    const anytime = withValue(pAnytime, raw.oddsAnytime || raw.odds, conf);
    anytime.available = true;
    anytime.level = Number.isFinite(xg90) ? 'A' : 'B';
    anytime.name = String(raw.name);
    anytime.market = 'anytime';
    anytime.firstScorer = { available: false, reason: 'Données insuffisantes pour une estimation fiable.' };
    anytime.twoPlus = pTwoPlus >= 0.02 && Number.isFinite(xg90)
      ? Object.assign({ available: true, level: 'A' }, withValue(pTwoPlus, raw.oddsTwoPlus, conf))
      : { available: false, reason: 'Données insuffisantes pour une estimation fiable.' };
    players.push(anytime);
  }

  const any = players.some(p => p.available);
  return {
    available: any,
    reason: any ? null : 'Données insuffisantes pour une estimation fiable.',
    players,
  };
}

function computeFootballMarkets(apiData, geminiResult) {
  const empty = {
    sport: 'football',
    result: null,
    btts: { available: false, reason: 'Données insuffisantes pour une estimation fiable.' },
    totals: { available: false, reason: 'Données insuffisantes pour une estimation fiable.', lines: {} },
    scorers: { available: false, reason: 'Données insuffisantes pour une estimation fiable.', players: [] },
  };

  const sport = String((apiData && apiData.sport) || 'football').toLowerCase();
  if (sport && !['football', 'foot', 'soccer'].includes(sport)) {
    return {
      sport,
      result: null,
      btts: { available: false, reason: 'Marchés buts réservés au football.' },
      totals: { available: false, reason: 'Marchés buts réservés au football.', lines: {} },
      scorers: { available: false, reason: 'Buteurs réservés au football.', players: [] },
    };
  }

  if (apiData && (apiData.isFinished || apiData.status === 'FT')) {
    empty.btts.reason = 'Match terminé — marché non calculé.';
    empty.totals.reason = 'Match terminé — marché non calculé.';
    empty.scorers.reason = 'Match terminé — marché non calculé.';
    return empty;
  }

  const fp = geminiResult && geminiResult.final_probability;
  if (fp && Number.isFinite(Number(fp.home_win))) {
    empty.result = {
      available: true,
      home: round4(clamp01(fp.home_win) || 0),
      draw: round4(clamp01(fp.draw) || 0),
      away: round4(clamp01(fp.away_win) || 0),
    };
  }

  const lam = readLambdas(apiData);
  if (lam.ok) {
    const yes = pBttsYes(lam.lambdaHome, lam.lambdaAway);
    const b = complementary(yes);
    empty.btts = {
      available: true,
      level: lam.level,
      yes: b.yes,
      no: b.no,
    };
    const lines = {};
    [0.5, 1.5, 2.5, 3.5].forEach((line) => {
      const row = pairLine(pOver(line, lam.lambdaHome, lam.lambdaAway));
      row.level = lam.level;
      lines[String(line)] = row;
    });
    empty.totals = { available: true, level: lam.level, lines };
  }

  empty.scorers = computeScorers(apiData);
  return empty;
}

module.exports = {
  computeFootballMarkets,
  computeScorers,
  readLambdas,
  pBttsYes,
  pOver,
  clamp01,
};
