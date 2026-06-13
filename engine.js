// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH v9.1 — Moteur Quantitatif IA
// engine.js : buildPrompt() + callGemini() + computeKellyAndValueEdge()
// Pipeline 5 étapes : Base → Environnement → Absences → Motivation → Forme
// ═══════════════════════════════════════════════════════════════════

/**
 * PROMPT SYSTÈME GEMINI
 * Injecté comme system_instruction (statique, économise les tokens)
 * temperature: 0.0 | responseMimeType: "application/json"
 */
const GEMINI_SYSTEM_PROMPT = `
Tu es le moteur de calcul déterministe de SUPERCOACH.
Tu te comportes comme un script mathématique froid.
Tu n'écris JAMAIS de texte en dehors du JSON demandé.
Tu n'inventes JAMAIS de statistiques.
Tu n'utilises JAMAIS le prestige historique — seuls les faits de la saison en cours comptent.

══════════════════════════════════════════════
PIPELINE — 5 ÉTAPES IMMUABLES (ordre strict)
══════════════════════════════════════════════

ÉTAPE 1 — BASE SCORE (0-100)
Force brute saison actuelle : classement, effectif, niveau de ligue.
ANTI-BIAIS ABSOLU : Interdit de surévaluer sur prestige historique (Real, PSG, Man City, Bayern...).
Seuls le classement actuel et la dynamique de la saison en cours sont valides.

ÉTAPE 2 — ENVIRONNEMENT, CLIMAT & VESTIAIRE
Appliquer dans l'ordre suivant :

A) Avantage domicile : +5% à l'équipe domicile.
B) Voyage adverse : +2% domicile si déplacement adverse > 4h.
C) Fatigue calendrier : Si une équipe a joué un match officiel il y a moins de 96h → -4% à cette équipe.
D) Météo extrême : Si conditions extrêmes (pluie torrentielle, neige, tempête, ou température > 35°C)
   → -3% à l'équipe ayant le Base Score le plus élevé après l'étape 1.
   Justification : la météo dégrades le jeu technique et égalise les niveaux.
E) Contexte vestiaire :
   → Crise majeure documentée (conflit interne public, dirigeants en crise, salaires impayés) : -6% à l'équipe concernée.
   → Nouvel entraîneur nommé cette semaine (effet choc psychologique positif) : +3% à l'équipe concernée.
   → Si les deux s'appliquent à la même équipe : cumuler (-6% + 3% = -3% net).

ÉTAPE 3 — ABSENCES & DOUBLURES (malus cumulables)
Gardien titulaire absent : -10%
Meilleur buteur absent : -8%
Capitaine absent : -5%
RÈGLE DOUBLURE : Si la doublure a disputé >50% des minutes saison avec performances stables → diviser le malus par 2.

ÉTAPE 4 — MOTIVATION & DERBY
Course au titre : +10%
Lutte contre la relégation : +15%
RÈGLE DERBY OPÉRATEUR :
  → Si match = derby : EFFACER scores étapes 1+2+3. Réinitialiser à 50/50.
  → Appliquer PAR-DESSUS ce reset uniquement : malus étape 3 + bonus étape 4.
  → Les facteurs météo/vestiaire (étape 2 D et E) sont ré-appliqués après le reset.

ÉTAPE 5 — FORME, xG & H2H
Série 3+ victoires consécutives : +5%
CORRECTION xG : Si l'équipe sur-performe ses points mais sous-performe ses xG (victoires par chance) → annuler le +5%.
H2H : +/-3% UNIQUEMENT si même stade ET même surface. Sinon 0%.
LIGUE MINEURE : Si historique H2H insuffisant → H2H = 0%, confidence bridée à 65 max.

══════════════════════════════════════════════
MODÉLISATION DU MATCH NUL
══════════════════════════════════════════════
E = |score_final_home - score_final_away| après étape 5.
Si E <= 5  : draw = 0.32
Si 5 < E <= 15 : draw = 0.26
Si E > 15 : draw = 0.20
Redistribuer (1 - draw) proportionnellement entre home_win et away_win.
Somme home_win + draw + away_win = 1.00 strictement.

══════════════════════════════════════════════
SÉCURITÉ ANTI-CRASH
══════════════════════════════════════════════
Cap max : 0.95. Cap min : 0.05. Jamais >= 1.00 ou <= 0.00.
confidence = entier(max(home_win, draw, away_win) × 100). Max 95.
Ligue mineure sans H2H → confidence = min(confidence, 65).

══════════════════════════════════════════════
FORMAT DE SORTIE — JSON PUR UNIQUEMENT
══════════════════════════════════════════════
Aucun texte hors accolades. Aucun markdown. Aucune phrase introductive.
{
  "home_team": "string",
  "away_team": "string",
  "steps_log": {
    "step_1_base": {"home": 0, "away": 0},
    "step_2_environment_and_fatigue": {"home": 0, "away": 0},
    "step_3_absences": {"home": 0, "away": 0},
    "step_4_motivation_or_derby": {"home": 0, "away": 0},
    "step_5_form_h2h_xg": {"home": 0, "away": 0}
  },
  "final_probability": {
    "home_win": 0.00,
    "draw": 0.00,
    "away_win": 0.00
  },
  "confidence": 0,
  "analysis_summary": "Explicabilité concise de l'arbre de décision dans la langue de l'utilisateur"
}
`;

/**
 * buildPrompt(apiData)
 *
 * @param {Object} apiData
 *
 * -- Identité match --
 * @param {string}  apiData.home
 * @param {string}  apiData.away
 * @param {string}  apiData.competition
 * @param {string}  apiData.date                  ISO8601
 * @param {boolean} apiData.isDerby
 * @param {boolean} apiData.isMinorLeague
 *
 * -- Classement --
 * @param {number|null} apiData.homeRank
 * @param {number|null} apiData.awayRank
 *
 * -- Fatigue --
 * @param {number|null} apiData.homeLastMatchHoursAgo
 * @param {number|null} apiData.awayLastMatchHoursAgo
 *
 * -- Météo & Logistique --
 * @param {Object} apiData.logistics              { travelTimeHours: number }
 * @param {Object} apiData.weather                { condition: string, temperatureCelsius: number }
 *   conditions reconnues : "heavy rain", "snow", "storm", "extreme heat"
 *
 * -- Contexte vestiaire --
 * @param {Object} apiData.clubContext
 *   { homeCrisis: bool, awayCrisis: bool, homeNewCoachThisWeek: bool, awayNewCoachThisWeek: bool }
 *
 * -- Absences --
 * @param {Object} apiData.homeAbsences           { goalkeeper, topScorer, captain }
 * @param {Object} apiData.awayAbsences
 * @param {Object} apiData.homeSubDepth           { goalkeeper, topScorer, captain } → doublure >50% min
 * @param {Object} apiData.awaySubDepth
 *
 * -- Motivation --
 * @param {boolean} apiData.homeTitleRace
 * @param {boolean} apiData.homeRelegation
 * @param {boolean} apiData.awayTitleRace
 * @param {boolean} apiData.awayRelegation
 *
 * -- Forme & xG --
 * @param {number}  apiData.homeWinStreak
 * @param {number}  apiData.awayWinStreak
 * @param {boolean} apiData.homeXgUnderperforming  victoires par chance
 * @param {boolean} apiData.awayXgUnderperforming
 * @param {number|null} apiData.homeXgFor
 * @param {number|null} apiData.awayXgFor
 *
 * -- H2H --
 * @param {boolean}     apiData.h2hSameVenue
 * @param {number|null} apiData.h2hHomeWinRate     0-1
 *
 * -- UI --
 * @param {string} apiData.userLang               fr | en | es | pt | it | de | ar
 *
 * @returns {string} user prompt prêt pour Gemini
 */
function buildPrompt(apiData) {
  const {
    home = 'Équipe A',
    away = 'Équipe B',
    competition = 'Compétition inconnue',
    date = new Date().toISOString(),
    isDerby = false,
    isMinorLeague = false,
    homeRank = null,
    awayRank = null,
    homeLastMatchHoursAgo = null,
    awayLastMatchHoursAgo = null,
    logistics = {},
    weather = {},
    clubContext = {},
    homeAbsences = {},
    awayAbsences = {},
    homeSubDepth = {},
    awaySubDepth = {},
    homeTitleRace = false,
    homeRelegation = false,
    awayTitleRace = false,
    awayRelegation = false,
    homeWinStreak = 0,
    awayWinStreak = 0,
    homeXgUnderperforming = false,
    awayXgUnderperforming = false,
    homeXgFor = null,
    awayXgFor = null,
    h2hSameVenue = false,
    h2hHomeWinRate = null,
    userLang = 'fr',
  } = apiData;

  // ── Helpers ──────────────────────────────────────────────────────

  const rank = (team, r) =>
    r !== null ? `${team} : ${r}e au classement` : `${team} : classement non disponible`;

  const fatigue = (team, h) =>
    h !== null && h < 96
      ? `⚠️ ${team} a joué il y a ${h}h (< 96h) → APPLIQUER malus -4%`
      : `${team} : repos suffisant`;

  const weatherBlock = () => {
    const cond = (weather.condition || '').toLowerCase();
    const temp = weather.temperatureCelsius;
    const extreme = ['heavy rain', 'snow', 'storm', 'extreme heat'].some(c => cond.includes(c))
      || (temp !== undefined && temp > 35);
    if (!extreme) return 'Météo : conditions normales → pas de malus';
    return `⚠️ Météo extrême détectée : "${weather.condition || 'N/A'}" ${temp !== undefined ? temp + '°C' : ''}`
      + '\n→ Appliquer -3% à l\'équipe avec le Base Score le plus élevé après étape 1.';
  };

  const travelBlock = () => {
    const h = logistics.travelTimeHours;
    if (!h || h <= 4) return 'Trajet adverse : < 4h → pas de bonus supplémentaire';
    return `Trajet adverse : ${h}h (> 4h) → +2% supplémentaires pour ${home}`;
  };

  const vestiaire = (team, isCrisis, isNewCoach) => {
    if (!isCrisis && !isNewCoach) return `${team} : contexte vestiaire stable`;
    const parts = [];
    if (isCrisis)   parts.push('crise majeure documentée → -6%');
    if (isNewCoach) parts.push('nouvel entraîneur cette semaine → +3%');
    return `⚠️ ${team} : ${parts.join(' + ')} (net : ${(isCrisis ? -6 : 0) + (isNewCoach ? 3 : 0)}%)`;
  };

  const absenceBlock = (team, abs, depth) => {
    const lines = [];
    if (abs.goalkeeper)  lines.push(`Gardien absent (-10%${depth.goalkeeper  ? ', doublure >50% min → -5%' : ''})`);
    if (abs.topScorer)   lines.push(`Meilleur buteur absent (-8%${depth.topScorer ? ', doublure >50% min → -4%' : ''})`);
    if (abs.captain)     lines.push(`Capitaine absent (-5%${depth.captain    ? ', doublure >50% min → -2.5%' : ''})`);
    return lines.length
      ? `${team} : ${lines.join(' | ')}`
      : `${team} : aucune absence majeure`;
  };

  const motivBlock = (team, title, relg) => {
    const parts = [];
    if (title) parts.push('course au titre (+10%)');
    if (relg)  parts.push('zone de relégation (+15%)');
    return parts.length ? `${team} : ${parts.join(' + ')}` : `${team} : enjeu standard`;
  };

  const formeBlock = (team, streak, underperf, xgFor) => {
    const parts = [];
    if (streak >= 3) parts.push(`${streak} victoires consécutives (+5%${underperf ? ' → ANNULÉ car sous-performe xG' : ''})`);
    if (xgFor !== null) parts.push(`xG produits saison : ${xgFor}${underperf ? ' (sous-performance xG détectée)' : ''}`);
    return parts.length ? `${team} : ${parts.join(' | ')}` : `${team} : pas de série en cours`;
  };

  const h2hBlock = () => {
    if (!h2hSameVenue || h2hHomeWinRate === null)
      return 'H2H : données insuffisantes ou stade différent → H2H = 0%';
    const pct = Math.round(h2hHomeWinRate * 100);
    const delta = pct > 55 ? '+3%' : pct < 45 ? '-3%' : '0% (équilibré)';
    return `H2H même stade : taux domicile ${pct}% → ajustement ${delta}`;
  };

  const langMap = {
    fr: 'français', en: 'anglais', es: 'espagnol',
    pt: 'portugais', it: 'italien', de: 'allemand', ar: 'arabe'
  };

  // ── User Prompt ──────────────────────────────────────────────────
  return `
MATCH À ANALYSER
════════════════════════════════════════
Match       : ${home} vs ${away}
Compétition : ${competition}
Date        : ${date}
Type        : ${isDerby ? '⚠️ DERBY → Reset 50/50 étape 4' : 'Standard'}
Ligue       : ${isMinorLeague ? 'Mineure → H2H neutralisé, confidence max 65' : 'Normale'}

─── ÉTAPE 1 — BASE SCORE ───
${rank(home, homeRank)}
${rank(away, awayRank)}

─── ÉTAPE 2 — ENVIRONNEMENT, CLIMAT & VESTIAIRE ───
Domicile : +5% automatique pour ${home}
${travelBlock()}
${fatigue(home, homeLastMatchHoursAgo)}
${fatigue(away, awayLastMatchHoursAgo)}
${weatherBlock()}
${vestiaire(home, !!clubContext.homeCrisis, !!clubContext.homeNewCoachThisWeek)}
${vestiaire(away, !!clubContext.awayCrisis, !!clubContext.awayNewCoachThisWeek)}

─── ÉTAPE 3 — ABSENCES & DOUBLURES ───
${absenceBlock(home, homeAbsences, homeSubDepth)}
${absenceBlock(away, awayAbsences, awaySubDepth)}

─── ÉTAPE 4 — MOTIVATION & DERBY ───
${motivBlock(home, homeTitleRace, homeRelegation)}
${motivBlock(away, awayTitleRace, awayRelegation)}

─── ÉTAPE 5 — FORME, xG & H2H ───
${formeBlock(home, homeWinStreak, homeXgUnderperforming, homeXgFor)}
${formeBlock(away, awayWinStreak, awayXgUnderperforming, awayXgFor)}
${h2hBlock()}

─── LANGUE ───
Rédiger "analysis_summary" en ${langMap[userLang] || 'français'}.

Applique le pipeline dans l'ordre strict et retourne uniquement le JSON.
`;
}

/**
 * callGemini(apiData, geminiKey)
 * Cascade : gemini-2.5-flash → gemini-2.5-flash-lite
 * Validation + normalisation post-parsing
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
      const fp = result.final_probability;
      if (!fp || fp.home_win === undefined) throw new Error('JSON invalide');

      // Cap 0.05 / 0.95
      ['home_win', 'draw', 'away_win'].forEach(k => {
        fp[k] = Math.min(0.95, Math.max(0.05, Number(fp[k]) || 0.05));
      });

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

      console.log(`[Gemini] ${model} ✅ conf=${result.confidence}%`);
      return result;

    } catch (err) {
      console.warn(`[Gemini] ${model} error: ${err.message}`);
    }
  }
  throw new Error('Tous les modèles Gemini ont échoué');
}

/**
 * computeKellyAndValueEdge(geminiResult, userOdds)
 * Exécuté côté backend APRÈS réception du JSON Gemini.
 * Jamais dans le prompt Gemini.
 *
 * @param {Object} geminiResult
 * @param {number} userOdds - Cote décimale bookmaker
 * @returns {Object|null} { valueEdgePct, kellyUnits, recommendation }
 */
function computeKellyAndValueEdge(geminiResult, userOdds) {
  if (!userOdds || userOdds <= 1.01) return null;

  const fp = geminiResult.final_probability;
  const maxProb    = Math.max(fp.home_win, fp.draw, fp.away_win);
  const impliedProb = 1 / userOdds;
  const valueEdgePct = Math.round((maxProb - impliedProb) * 100 * 10) / 10;

  // Kelly fractionné à 25% — gestion du risque prudente
  const kellyFull  = (maxProb * userOdds - 1) / (userOdds - 1);
  const kellyUnits = Math.max(0, Math.min(5, Math.round(kellyFull * 0.25 * 10 * 10) / 10));

  let recommendation;
  if (valueEdgePct > 0 && geminiResult.confidence >= 70) {
    recommendation = 'VALUE BET DÉTECTÉ';
  } else if (valueEdgePct > 0 && geminiResult.confidence < 70) {
    recommendation = 'EDGE POSITIF — CONFIANCE INSUFFISANTE';
  } else {
    recommendation = 'PAS DE VALUE — NE PAS MISER';
  }

  return { valueEdgePct, kellyUnits, recommendation };
}

module.exports = {
  GEMINI_SYSTEM_PROMPT,
  buildPrompt,
  callGemini,
  computeKellyAndValueEdge,
};
