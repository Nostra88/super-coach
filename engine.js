// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH v9.2 — Moteur Quantitatif Multisports
// engine.js : buildPrompt() + callGemini() + computeKellyAndValueEdge()
// Sports : football | basketball | tennis | hockey | baseball
// ═══════════════════════════════════════════════════════════════════

const SPORTS = ['football', 'basketball', 'tennis', 'hockey', 'baseball'];

// ── Prompt système statique (injecté en system_instruction) ────────
const GEMINI_SYSTEM_PROMPT = [
  'Tu es un moteur de probabilites sportives. Ton seul role : calculer la probabilite reelle de chaque issue et detecter un Edge face aux cotes du marche.',
  '',
  'REGLES (ordre strict) :',
  '',
  '1. FORCE BRUTE',
  'Evalue la force des deux equipes sur la saison en cours uniquement.',
  'Classement actuel, forme recente, niveau de competition.',
  'INTERDIT : prestige historique, reputation, popularite passee.',
  '',
  '2. CONTEXTE MATCH (ajustements si donnees presentes)',
  'Domicile : +5%',
  'Fatigue (dernier match < 96h) : -4% | Back-to-Back NBA/MLB (< 24h) : -7%',
  'Absence titulaire cle : gardien/goalie -10% | buteur/franchise player -8% | capitaine -5%',
  'Doublure ayant joue >50% des minutes : diviser le malus par 2',
  'Crise interne documentee : -6% | Nouvel entraineur cette semaine : +3%',
  'Meteo extreme (sports exterieurs) : -3% a l equipe la plus forte',
  'Derby/Rivalite : reset 50/50 puis appliquer uniquement regles 2 et 3',
  '',
  '3. ENJEU',
  'Course au titre : +10% | Relegation : +15%',
  '',
  '4. METRIQUES AVANCEES (utiliser uniquement si fournies, jamais inventer)',
  'Football : xG | Basketball : Net Rating | Hockey : Fenwick%',
  'Baseball : FIP du lanceur | Tennis : % victoires sur la surface + H2H',
  '',
  '5. PROBABILITES FINALES',
  'Cap strict : min 0.05, max 0.95. Somme home_win + draw + away_win = 1.00.',
  'Draw football : E = ecart scores finaux. E<=5: 0.32 | E<=15: 0.26 | E>15: 0.20',
  'Draw hockey : 0.22 si E<=10, sinon 0.15',
  'Draw basketball/tennis/baseball : 0.00 obligatoire',
  'Ligue mineure ou donnees insuffisantes : confidence max 65',
  '',
  'REPONSE : JSON pur uniquement, aucun texte en dehors des accolades.',
  '{"home_win":0.00,"draw":0.00,"away_win":0.00,"confidence":0,"edge_factor":"home|draw|away","reasoning":"2-3 phrases dans la langue indiquee"}'
].join('\n');

/**
 * buildPrompt(apiData)
 *
 * @param {Object} apiData
 *
 * -- Identité --
 * @param {string}  apiData.sport          football|basketball|tennis|hockey|baseball
 * @param {string}  apiData.home
 * @param {string}  apiData.away
 * @param {string}  apiData.competition
 * @param {string}  apiData.date           ISO8601
 * @param {boolean} apiData.isDerbyOrRivalry
 * @param {boolean} apiData.isMinorLeague
 *
 * -- Classement / Ranking --
 * @param {number|null} apiData.homeRank
 * @param {number|null} apiData.awayRank
 *
 * -- Environnement --
 * @param {Object} apiData.environment
 *   travelTimeHours: number
 *   weatherCondition: string  ("clear"|"heavy rain"|"snow"|"storm"|"extreme heat")
 *   temperatureCelsius: number
 *   baseballWindDirection: "none"|"out"|"in"
 *   homeLastMatchHoursAgo: number|null
 *   awayLastMatchHoursAgo: number|null
 *
 * -- Contexte club/équipe --
 * @param {Object} apiData.context
 *   homeCrisis: bool
 *   awayCrisis: bool
 *   homeNewCoachThisWeek: bool
 *   awayNewCoachThisWeek: bool
 *
 * -- Absences (football) --
 * @param {Object} apiData.homeAbsences     { goalkeeper, topScorer, captain }
 * @param {Object} apiData.awayAbsences
 * @param {Object} apiData.homeSubDepth     { goalkeeper, topScorer, captain } → doublure >50%min
 * @param {Object} apiData.awaySubDepth
 *
 * -- Absences spécifiques sport --
 * @param {Object} apiData.sportSpecific
 *   basketball : { homeFranchisePlayerOut: bool, awayFranchisePlayerOut: bool }
 *   hockey     : { homeStartingGoalieOut: bool,  awayStartingGoalieOut: bool }
 *   baseball   : { homePitcherIsAce: bool, awayPitcherIsAce: bool,
 *                  homePitcherIsBullpen: bool, awayPitcherIsBullpen: bool }
 *   tennis     : { playerAbsent: bool }
 *
 * -- Motivation --
 * @param {boolean} apiData.homeTitleRace
 * @param {boolean} apiData.homeRelegation
 * @param {boolean} apiData.awayTitleRace
 * @param {boolean} apiData.awayRelegation
 *
 * -- Métriques avancées --
 * @param {Object} apiData.advancedMetrics
 *   xG            : { homeFor, homeUnderperforming, awayFor, awayUnderperforming }
 *   netRating     : { home, away }     (basketball)
 *   corsi         : { homePct, awayPct }  (hockey)
 *   war_fip       : { homeWar, homeFip, awayWar, awayFip }  (baseball)
 *   tennisSurface : { surface, homeWinPct, awayWinPct, h2hHomeWins, h2hTotal }
 *
 * -- H2H (football/hockey/basketball) --
 * @param {boolean}     apiData.h2hSameVenue
 * @param {number|null} apiData.h2hHomeWinRate
 *
 * -- Forme --
 * @param {number} apiData.homeWinStreak
 * @param {number} apiData.awayWinStreak
 *
 * -- UI --
 * @param {string} apiData.userLang   fr|en|es|pt|it|de|ar
 *
 * @returns {string}
 */
function buildPrompt(apiData) {
  const {
    sport = 'football',
    home = 'Équipe A',
    away = 'Équipe B',
    competition = 'Compétition inconnue',
    date = new Date().toISOString(),
    isDerbyOrRivalry = false,
    isMinorLeague = false,
    homeRank = null,
    awayRank = null,
    environment = {},
    context = {},
    homeAbsences = {},
    awayAbsences = {},
    homeSubDepth = {},
    awaySubDepth = {},
    sportSpecific = {},
    homeTitleRace = false,
    homeRelegation = false,
    awayTitleRace = false,
    awayRelegation = false,
    homeWinStreak = 0,
    awayWinStreak = 0,
    advancedMetrics = {},
    h2hSameVenue = false,
    h2hHomeWinRate = null,
    userLang = 'fr',
  } = apiData;

  const {
    travelTimeHours = 0,
    weatherCondition = 'clear',
    temperatureCelsius = 20,
    baseballWindDirection = 'none',
    homeLastMatchHoursAgo = null,
    awayLastMatchHoursAgo = null,
  } = environment;

  // ── Helpers ────────────────────────────────────────────────────

  const OUTDOOR_SPORTS = ['football', 'tennis', 'baseball'];
  const isOutdoor = OUTDOOR_SPORTS.includes(sport);

  const rank = (team, r) =>
    r !== null ? `${team} : ${r}e` : `${team} : classement non disponible`;

  const fatigueBlock = (team, hoursAgo) => {
    if (hoursAgo === null) return `${team} : repos inconnu`;
    const isBackToBack = ['basketball', 'baseball'].includes(sport) && hoursAgo < 24;
    if (isBackToBack) return `⚠️ ${team} BACK-TO-BACK (${hoursAgo}h) → malus -7%`;
    if (hoursAgo < 96) return `⚠️ ${team} a joué il y a ${hoursAgo}h (<96h) → malus -4%`;
    return `${team} : repos suffisant`;
  };

  const weatherBlock = () => {
    if (!isOutdoor) return 'Sport en salle → météo non applicable';
    const cond = weatherCondition.toLowerCase();
    const extreme = ['heavy rain', 'snow', 'storm'].some(c => cond.includes(c))
      || temperatureCelsius > 35;
    if (!extreme) return `Météo : ${weatherCondition} ${temperatureCelsius}°C → conditions normales`;
    let block = `⚠️ Météo extrême : "${weatherCondition}" ${temperatureCelsius}°C → -4% à l'équipe avec le Base Score le plus élevé`;
    if (sport === 'baseball' && baseballWindDirection === 'out') {
      block += '\n⚠️ Vent vers l\'extérieur (Wind Blowing Out) → variance accrue, noter dans analysis_summary';
    }
    return block;
  };

  const vestiaireBlock = (team, crisis, newCoach) => {
    if (!crisis && !newCoach) return `${team} : stable`;
    const parts = [];
    if (crisis)   parts.push('crise documentée → -6%');
    if (newCoach) parts.push('nouveau coach cette semaine → +3%');
    return `⚠️ ${team} : ${parts.join(' + ')} (net: ${(crisis ? -6 : 0) + (newCoach ? 3 : 0)}%)`;
  };

  const homAdvBlock = () => {
    if (sport === 'tennis') return 'Tennis : avantage domicile = 0% (sauf data public partisan spécifié)';
    let block = `Avantage domicile : +5% pour ${home}`;
    if (travelTimeHours > 4) block += `\nTrajet adverse ${travelTimeHours}h (>4h) : +2% supplémentaires pour ${home}`;
    return block;
  };

  // Absences football
  const footAbsences = (team, abs, depth) => {
    if (sport !== 'football') return '';
    const lines = [];
    if (abs.goalkeeper) lines.push(`Gardien (-10%${depth.goalkeeper ? ', doublure >50%min → -5%' : ''})`);
    if (abs.topScorer)  lines.push(`Buteur (-8%${depth.topScorer   ? ', doublure >50%min → -4%' : ''})`);
    if (abs.captain)    lines.push(`Capitaine (-5%${depth.captain  ? ', doublure >50%min → -2.5%' : ''})`);
    return lines.length ? `${team} : ${lines.join(' | ')}` : `${team} : aucune absence`;
  };

  // Absences spécifiques
  const sportAbsences = () => {
    const ss = sportSpecific;
    switch (sport) {
      case 'basketball':
        return [
          ss.homeFranchisePlayerOut ? `⚠️ ${home} : Franchise Player absent → -15%` : `${home} : Franchise Player disponible`,
          ss.awayFranchisePlayerOut ? `⚠️ ${away} : Franchise Player absent → -15%` : `${away} : Franchise Player disponible`,
        ].join('\n');
      case 'hockey':
        return [
          ss.homeStartingGoalieOut ? `⚠️ ${home} : Starting Goalie absent → -12%` : `${home} : Starting Goalie confirmé`,
          ss.awayStartingGoalieOut ? `⚠️ ${away} : Starting Goalie absent → -12%` : `${away} : Starting Goalie confirmé`,
        ].join('\n');
      case 'baseball':
        return [
          ss.homePitcherIsAce    ? `✅ ${home} : Pitcher Ace aligné → +15% Base Score` : '',
          ss.homePitcherIsBullpen ? `⚠️ ${home} : Bullpen faible aligné → -15%` : '',
          ss.awayPitcherIsAce    ? `✅ ${away} : Pitcher Ace aligné → +15% Base Score` : '',
          ss.awayPitcherIsBullpen ? `⚠️ ${away} : Bullpen faible aligné → -15%` : '',
        ].filter(Boolean).join('\n') || `${home} vs ${away} : données Pitcher non spécifiées`;
      case 'tennis':
        if (ss.playerAbsent) return '🚫 JOUEUR ABSENT → Retourner {"error": "match_cancelled", "reason": "Player injury/absence"}';
        return 'Joueurs disponibles';
      default:
        return '';
    }
  };

  const motivBlock = (team, title, relg) => {
    const parts = [];
    if (title) parts.push('course au titre (+10%)');
    if (relg)  parts.push('zone de relégation (+15%)');
    return parts.length ? `${team} : ${parts.join(' + ')}` : `${team} : enjeu standard`;
  };

  // Métriques avancées par sport
  const metricsBlock = () => {
    const m = advancedMetrics;
    switch (sport) {
      case 'football': {
        const xg = m.xG || {};
        return [
          homeWinStreak >= 3 ? `${home} : ${homeWinStreak} victoires consécutives (+5%${xg.homeUnderperforming ? ' → ANNULÉ sous-performance xG' : ''})` : `${home} : pas de série`,
          awayWinStreak >= 3 ? `${away} : ${awayWinStreak} victoires consécutives (+5%${xg.awayUnderperforming ? ' → ANNULÉ sous-performance xG' : ''})` : `${away} : pas de série`,
          xg.homeFor != null ? `xG ${home} : ${xg.homeFor}` : '',
          xg.awayFor != null ? `xG ${away} : ${xg.awayFor}` : '',
        ].filter(Boolean).join('\n');
      }
      case 'basketball': {
        const nr = m.netRating || {};
        return [
          homeWinStreak >= 3 ? `${home} : ${homeWinStreak} victoires (+5%${nr.home != null && nr.home < 0 ? ' → ANNULÉ Net Rating négatif' : ''})` : `${home} : pas de série`,
          awayWinStreak >= 3 ? `${away} : ${awayWinStreak} victoires (+5%${nr.away != null && nr.away < 0 ? ' → ANNULÉ Net Rating négatif' : ''})` : `${away} : pas de série`,
          nr.home != null ? `Net Rating ${home} : ${nr.home}` : '',
          nr.away != null ? `Net Rating ${away} : ${nr.away}` : '',
        ].filter(Boolean).join('\n');
      }
      case 'hockey': {
        const c = m.corsi || {};
        return [
          homeWinStreak >= 3 ? `${home} : ${homeWinStreak} victoires (+5%${c.homePct != null && c.homePct < 48 ? ' → ANNULÉ Fenwick% <48%' : ''})` : `${home} : pas de série`,
          awayWinStreak >= 3 ? `${away} : ${awayWinStreak} victoires (+5%${c.awayPct != null && c.awayPct < 48 ? ' → ANNULÉ Fenwick% <48%' : ''})` : `${away} : pas de série`,
          c.homePct != null ? `Fenwick% ${home} : ${c.homePct}%` : '',
          c.awayPct != null ? `Fenwick% ${away} : ${c.awayPct}%` : '',
        ].filter(Boolean).join('\n');
      }
      case 'baseball': {
        const wf = m.war_fip || {};
        return [
          homeWinStreak >= 3 ? `${home} : ${homeWinStreak} victoires (+5%${wf.homeFip != null && wf.homeFip > 4.5 ? ' → ANNULÉ FIP >4.50' : ''})` : `${home} : pas de série`,
          awayWinStreak >= 3 ? `${away} : ${awayWinStreak} victoires (+5%${wf.awayFip != null && wf.awayFip > 4.5 ? ' → ANNULÉ FIP >4.50' : ''})` : `${away} : pas de série`,
          wf.homeWar != null ? `WAR ${home} : ${wf.homeWar}` : '',
          wf.homeFip != null ? `FIP ${home} : ${wf.homeFip}` : '',
          wf.awayWar != null ? `WAR ${away} : ${wf.awayWar}` : '',
          wf.awayFip != null ? `FIP ${away} : ${wf.awayFip}` : '',
        ].filter(Boolean).join('\n');
      }
      case 'tennis': {
        const ts = m.tennisSurface || {};
        return [
          `Surface : ${ts.surface || 'non spécifiée'}`,
          ts.homeWinPct != null ? `% victoires ${home} sur cette surface : ${ts.homeWinPct}%` : '',
          ts.awayWinPct != null ? `% victoires ${away} sur cette surface : ${ts.awayWinPct}%` : '',
          ts.h2hTotal   ? `H2H direct : ${ts.h2hHomeWins}/${ts.h2hTotal} pour ${home}` : 'H2H direct : données insuffisantes',
        ].filter(Boolean).join('\n');
      }
      default: return '';
    }
  };

  const h2hBlock = () => {
    if (['tennis', 'baseball'].includes(sport)) return ''; // géré dans metrics
    if (!h2hSameVenue || h2hHomeWinRate === null) return 'H2H : données insuffisantes → H2H = 0%';
    const pct = Math.round(h2hHomeWinRate * 100);
    const delta = pct > 55 ? '+3%' : pct < 45 ? '-3%' : '0% (équilibré)';
    return `H2H même stade : ${pct}% domicile → ${delta}`;
  };

  const langMap = { fr:'français', en:'anglais', es:'espagnol', pt:'portugais', it:'italien', de:'allemand', ar:'arabe' };

  // ── User Prompt ────────────────────────────────────────────────
  return `
MATCH À ANALYSER
════════════════════════════════════════
Sport       : ${sport.toUpperCase()}
Match       : ${home} vs ${away}
Compétition : ${competition}
Date        : ${date}
Type        : ${isDerbyOrRivalry ? '⚠️ DERBY/RIVALITÉ → Reset 50/50 étape 4' : 'Standard'}
Ligue       : ${isMinorLeague ? 'Mineure → H2H neutralisé, confidence max 65' : 'Normale'}

─── ÉTAPE 1 — BASE SCORE ───
${rank(home, homeRank)}
${rank(away, awayRank)}

─── ÉTAPE 2 — ENVIRONNEMENT, CLIMAT & VESTIAIRE ───
${homAdvBlock()}
${fatigueBlock(home, homeLastMatchHoursAgo)}
${fatigueBlock(away, awayLastMatchHoursAgo)}
${weatherBlock()}
${vestiaireBlock(home, !!context.homeCrisis, !!context.homeNewCoachThisWeek)}
${vestiaireBlock(away, !!context.awayCrisis, !!context.awayNewCoachThisWeek)}

─── ÉTAPE 3 — ABSENCES & FACTEURS CRITIQUES ───
${sport === 'football' ? [footAbsences(home, homeAbsences, homeSubDepth), footAbsences(away, awayAbsences, awaySubDepth)].join('\n') : sportAbsences()}

─── ÉTAPE 4 — MOTIVATION & DERBY ───
${motivBlock(home, homeTitleRace, homeRelegation)}
${motivBlock(away, awayTitleRace, awayRelegation)}

─── ÉTAPE 5 — FORME & MÉTRIQUES AVANCÉES ───
${metricsBlock()}
${h2hBlock()}

─── CONFIGURATION SORTIE ───
draw = ${['basketball', 'tennis', 'baseball'].includes(sport) ? '0.00 OBLIGATOIRE (format 2-way)' : sport === 'hockey' ? '0.22 si E<=10, 0.15 sinon (3-way)' : 'calculé selon écart E (football)'}
Langue analysis_summary : ${langMap[userLang] || 'français'}

Applique le pipeline dans l'ordre strict et retourne uniquement le JSON.
`.trim();
}

/**
 * callGemini(apiData, geminiKey)
 * Cascade : gemini-2.5-flash → gemini-2.5-flash-lite
 */
async function callGemini(apiData, geminiKey) {
  const userPrompt = buildPrompt(apiData);
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

  for (const model of models) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 25000);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0.0,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      clearTimeout(timeout);
      if (!res.ok) { console.warn(`[Gemini] ${model} HTTP ${res.status}`); continue; }

      const data = await res.json();
      const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;

      const result = JSON.parse(raw);

      // Cas tennis joueur absent
      if (result.error === 'match_cancelled') {
        console.log(`[Gemini] Match annulé : ${result.reason}`);
        return result;
      }

      // Support nouveau format (probabilites a la racine) et ancien (final_probability)
      let fp;
      if (result.home_win !== undefined) {
        fp = { home_win: result.home_win, draw: result.draw || 0, away_win: result.away_win };
        result.final_probability = fp;
      } else {
        fp = result.final_probability;
      }
      if (!fp || fp.home_win === undefined) throw new Error('JSON invalide');

      // Forcer draw=0 pour sports 2-way
      const sport = (apiData.sport || 'football').toLowerCase();
      if (['basketball', 'tennis', 'baseball'].includes(sport)) {
        fp.draw = 0;
      }

      // Cap 0.05 / 0.95
      ['home_win', 'away_win'].forEach(k => {
        fp[k] = Math.min(0.95, Math.max(0.05, Number(fp[k]) || 0.05));
      });
      if (fp.draw > 0) fp.draw = Math.min(0.90, Math.max(0.05, Number(fp.draw)));

      // Normalisation somme = 1.00
      const total = fp.home_win + fp.draw + fp.away_win;
      if (Math.abs(total - 1.0) > 0.005) {
        fp.home_win /= total;
        fp.draw     /= total;
        fp.away_win /= total;
      }

      // Arrondi 4 décimales
      ['home_win', 'draw', 'away_win'].forEach(k => {
        fp[k] = Math.round(fp[k] * 10000) / 10000;
      });

      // Confidence
      result.confidence = Math.min(95, Math.round(
        Math.max(fp.home_win, fp.draw, fp.away_win) * 100
      ));
      if (apiData.isMinorLeague) result.confidence = Math.min(65, result.confidence);

      console.log(`[Gemini] ${model} ✅ ${sport} conf=${result.confidence}%`);
      return result;

    } catch (err) {
      console.warn(`[Gemini] ${model} error: ${err.message}`);
    }
  }
  throw new Error('Tous les modèles Gemini ont échoué');
}

/**
 * computeKellyAndValueEdge(geminiResult, userOdds)
 * Exécuté côté backend APRÈS réception du JSON. Jamais dans Gemini.
 */
function computeKellyAndValueEdge(geminiResult, userOdds) {
  if (!userOdds || userOdds <= 1.01) return null;
  if (geminiResult.error) return null;

  const fp = geminiResult.final_probability;
  const maxProb     = Math.max(fp.home_win, fp.draw || 0, fp.away_win);
  const impliedProb = 1 / userOdds;
  const valueEdgePct = Math.round((maxProb - impliedProb) * 100 * 10) / 10;

  // Kelly fractionné 25%
  const kellyFull  = (maxProb * userOdds - 1) / (userOdds - 1);
  const kellyUnits = Math.max(0, Math.min(5, Math.round(kellyFull * 0.25 * 10 * 10) / 10));

  const recommendation =
    valueEdgePct > 0 && geminiResult.confidence >= 70 ? 'VALUE BET DÉTECTÉ' :
    valueEdgePct > 0 ? 'EDGE POSITIF — CONFIANCE INSUFFISANTE' :
    'PAS DE VALUE — NE PAS MISER';

  return { valueEdgePct, kellyUnits, recommendation };
}

module.exports = {
  GEMINI_SYSTEM_PROMPT,
  buildPrompt,
  callGemini,
  computeKellyAndValueEdge,
  SPORTS,
};
