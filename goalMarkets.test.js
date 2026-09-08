'use strict';
const { computeFootballMarkets, readLambdas, pBttsYes } = require('../goalMarkets');

function assert(name, ok, extra) {
  if (!ok) throw new Error('FAIL ' + name + ' ' + (extra || ''));
  console.log('PASS', name);
}

const tennis = computeFootballMarkets({ sport: 'tennis' }, {});
assert('tennis btts off', tennis.btts.available === false);

const done = computeFootballMarkets({ sport: 'football', isFinished: true }, {});
assert('finished off', done.btts.available === false);

const none = computeFootballMarkets({ sport: 'football' }, { final_probability: { home_win: 0.4, draw: 0.3, away_win: 0.3 } });
assert('no stats = C', none.btts.available === false);
assert('1x2 still present', none.result && Math.abs(none.result.home + none.result.draw + none.result.away - 1) < 0.02);

const rich = computeFootballMarkets({
  sport: 'football',
  advancedMetrics: { xG: { homeFor: 1.6, awayFor: 1.1, homeAgainst: 1.0, awayAgainst: 1.4 } },
}, { final_probability: { home_win: 0.45, draw: 0.28, away_win: 0.27 } });
assert('btts available', rich.btts.available);
assert('btts sum 1', Math.abs(rich.btts.yes + rich.btts.no - 1) < 0.02);
assert('ou 2.5 complementary', Math.abs(rich.totals.lines['2.5'].over + rich.totals.lines['2.5'].under - 1) < 0.02);
assert('bounds', rich.btts.yes >= 0 && rich.btts.yes <= 1);
assert('no nan', Number.isFinite(rich.totals.lines['1.5'].over));

const lam = readLambdas({ sport: 'football', teamStats: { homeGf: 1.8, homeGa: 1.1, awayGf: 1.2, awayGa: 1.5 } });
assert('level B', lam.ok && lam.level === 'B');

const noPlayers = computeFootballMarkets({ sport: 'football', advancedMetrics: { xG: { homeFor: 1, awayFor: 1 } } }, {});
assert('scorers C without players', noPlayers.scorers.available === false);

const uncertain = computeFootballMarkets({
  sport: 'football',
  players: [{ name: 'X', goalsPer90: 0.6, starterConfirmed: false }],
}, {});
assert('uncertain starter', uncertain.scorers.players[0].available === false);

const okP = computeFootballMarkets({
  sport: 'football',
  players: [{ name: 'A', xgPer90: 0.55, starterConfirmed: true, expectedMinutes: 90, oddsAnytime: 2.2 }],
}, {});
assert('scorer A', okP.scorers.available && okP.scorers.players[0].available);
assert('scorer bounds', okP.scorers.players[0].probability > 0 && okP.scorers.players[0].probability < 1);
assert('first scorer off', okP.scorers.players[0].firstScorer.available === false);

const noxg = computeFootballMarkets({
  sport: 'football',
  players: [{ name: 'B', starterConfirmed: true }],
}, {});
assert('no stats player', noxg.scorers.players[0].available === false);

assert('pBtts finite', Number.isFinite(pBttsYes(1.4, 1.1)));
console.log('ALL_OK');
