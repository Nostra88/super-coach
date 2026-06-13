// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH v9.0 — Moteur Quantitatif IA
// buildPrompt() : Génère le prompt système pour Gemini 2.5 Flash
// Architecture : API-Football → buildPrompt → Gemini → Kelly/ValueEdge
// ═══════════════════════════════════════════════════════════════════

/**
 * PROMPT SYSTÈME GEMINI — Mission 1
 * Injecté comme system instruction dans l'appel Gemini
 * temperature: 0.0, responseMimeType: "application/json"
 */
const GEMINI_SYSTEM_PROMPT = `
Tu es le moteur de calcul déterministe de SUPERCOACH.
Tu te comportes comme un script mathématique froid.
Tu n'écris JAMAIS de texte en dehors du JSON demandé.
Tu n'inventes JAMAIS de statistiques.
Tu n'utilises JAMAIS le prestige historique d'une équipe — seuls les faits de la saison en cours comptent.

══════════════════════════════════════════════
PIPELINE MATHÉMATIQUE — 5 ÉTAPES IMMUABLES
══════════════════════════════════════════════

ÉTAPE 1 — BASE SCORE (0-100)
Évalue la force brute sur la saison actuelle : classement, effectif, niveau de ligue.
ANTI-BIAIS : Interdit de surévaluer sur prestige historique (Real, PSG, Man City, etc.).
Seul le classement actuel et la dynamique de la saison en cours sont valides.

ÉTAPE 2 — DOMICILE & FATIGUE
+5% automatique pour l'équipe à domicile.
+2% si le déplacement adverse dépasse 4 heures de voyage.
FATIGUE : Si une équipe a disputé un match officiel il y a moins de 96h, appliquer -4%.

ÉTAPE 3 — ABSENCES & DOUBLURES (malus cumulables)
Gardien titulaire absent : -10%
Meilleur buteur absent : -8%
Capitaine absent : -5%
RÈGLE DOUBLURE : Si la doublure a disputé >50% des minutes saison avec performances stables, diviser le malus par 2.

ÉTAPE 4 — MOTIVATION & DERBY
Course au titre : +10%
Lutte contre la relégation : +15%
RÈGLE DERBY OPÉRATEUR :
  → Si match = derby : EFFACER les scores des étapes 1, 2, 3. Réinitialiser à 50/50.
  → Appliquer PAR-DESSUS ce reset uniquement : malus étape 3 + bonus étape 4.

ÉTAPE 5 — FORME & xG & H2H
Série de 3+ victoires consécutives : +5%
CORRECTION xG : Si l'équipe a systématiquement sous-performé ses xG malgré ses victoires (victoires par chance), annuler le +5%.
H2H : +/-3% UNIQUEMENT si même stade ET même surface. Sinon 0%.
LIGUE MINEURE : Si historique H2H insuffisant, neutraliser H2H à 0% et brider confidence à 65 max.

══════════════════════════════════════════════
MODÉLISATION DU MATCH NUL
══════════════════════════════════════════════
E = |score_final_home - score_final_away| après étape 5.
Si E <= 5  : draw = 0.32
Si 5 < E <= 15 : draw = 0.26
Si E > 15 : draw = 0.20
Redistribuer (1 - draw) proportionnellement entre home_win et away_win.
La somme home_win + draw + away_win doit être strictement égale à 1.00.

══════════════════════════════════════════════
SÉCURITÉ ANTI-CRASH
══════════════════════════════════════════════
Cap max : 0.95. Cap min : 0.05. Jamais >= 1.00 ou <= 0.00.
confidence = entier(probabilité_issue_la_plus_probable * 100), max 95.
Ligue mineure sans H2H : confidence = min(confidence, 65).

══════════════════════════════════════════════
FORMAT DE SORTIE — JSON PUR UNIQUEMENT
══════════════════════════════════════════════
Aucun texte en dehors des accolades. Aucun markdown. Aucune explication.
{
  "home_team": "string",
  "away_team": "string",
  "steps_log": {
    "step_1_base": {"home": 0, "away": 0},
    "step_2_home_and_fatigue": {"home": 0, "away": 0},
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
  "analysis_summary": "Explicabilité concise en français de l'arbre de décision"
}
`;

/**
 * buildPrompt(apiData) — Mission 3
 * 
 * @param {Object} apiData — Données nettoyées depuis API-Football
 * @param {string} apiData.home - Nom équipe domicile
 * @param {string} apiData.away - Nom équipe extérieur
 * @param {string} apiData.competition - Nom de la compétition
 * @param {string} apiData.date - Date du match ISO8601
 * @param {number} apiData.homeRank - Classement équipe domicile
 * @param {number} apiData.awayRank - Classement équipe extérieur
 * @param {number} apiData.homePlayed - Matchs joués domicile cette saison
 * @param {number} apiData.awayPlayed - Matchs joués extérieur
 * @param {boolean} apiData.isDerby - Match est un derby
 * @param {boolean} apiData.homeTitleRace - Domicile en course titre
 * @param {boolean} apiData.homeRelegation - Domicile en zone relégation
 * @param {boolean} apiData.awayTitleRace
 * @param {boolean} apiData.awayRelegation
 * @param {number|null} apiData.homeLastMatchHoursAgo - Heures depuis dernier match officiel
 * @param {number|null} apiData.awayLastMatchHoursAgo
 * @param {Object} apiData.homeAbsences - { goalkeeper: bool, topScorer: bool, captain: bool }
 * @param {Object} apiData.awayAbsences
 * @param {Object} apiData.homeSubDepth - { goalkeeper: bool, topScorer: bool, captain: bool } → doublure >50% minutes
 * @param {Object} apiData.awaySubDepth
 * @param {number} apiData.homeWinStreak - Série de victoires consécutives
 * @param {number} apiData.awayWinStreak
 * @param {number|null} apiData.homeXgFor - xG produits saison
 * @param {number|null} apiData.homeXgAgainst
 * @param {number|null} apiData.awayXgFor
 * @param {number|null} apiData.awayXgAgainst
 * @param {boolean} apiData.homeXgUnderperforming - Sur-performe résultats vs xG
 * @param {boolean} apiData.awayXgUnderperforming
 * @param {boolean} apiData.h2hSameVenue - H2H disponible même stade
 * @param {number} apiData.h2hHomeWinRate - Taux victoire domicile en H2H (0-1)
 * @param {boolean} apiData.isMinorLeague - Ligue mineure sans données H2H
 * @param {string} apiData.userLang - Langue utilisateur (fr, en, es, etc.)
 * @returns {string} - Le prompt complet prêt à envoyer à Gemini
 */
function buildPrompt(apiData) {
  const {
    home = 'Équipe A',
    away = 'Équipe B',
    competition = 'Compétition inconnue',
    date = new Date().toISOString(),
    homeRank = null,
    awayRank = null,
    isDerby = false,
    homeTitleRace = false,
    homeRelegation = false,
    awayTitleRace = false,
    awayRelegation = false,
    homeLastMatchHoursAgo = null,
    awayLastMatchHoursAgo = null,
    homeAbsences = {},
    awayAbsences = {},
    homeSubDepth = {},
    awaySubDepth = {},
    homeWinStreak = 0,
    awayWinStreak = 0,
    homeXgFor = null,
    homeXgUnderperforming = false,
    awayXgFor = null,
    awayXgUnderperforming = false,
    h2hSameVenue = false,
    h2hHomeWinRate = null,
    isMinorLeague = false,
    userLang = 'fr',
  } = apiData;

  // ── Sérialisation des variables dynamiques ──────────────────────

  const fatigue = (h, hoursAgo) =>
    hoursAgo !== null && hoursAgo < 96
      ? `${h} a joué il y a ${hoursAgo}h (< 96h) → APPLIQUER malus fatigue -4%`
      : `${h} — pas de fatigue détectée`;

  const absences = (team, abs, depth) => {
    const lines = [];
    if (abs.goalkeeper)  lines.push(`Gardien absent${depth.goalkeeper  ? ' (doublure >50% min → malus ÷2)' : ''}`);
    if (abs.topScorer)   lines.push(`Meilleur buteur absent${depth.topScorer ? ' (doublure >50% min → malus ÷2)' : ''}`);
    if (abs.captain)     lines.push(`Capitaine absent${depth.captain    ? ' (doublure >50% min → malus ÷2)' : ''}`);
    return lines.length ? `${team} : ${lines.join(' | ')}` : `${team} : aucune absence majeure`;
  };

  const motivation = (team, titleRace, relegation) => {
    const lines = [];
    if (titleRace)  lines.push('en course pour le titre (+10%)');
    if (relegation) lines.push('en zone de relégation (+15%)');
    return lines.length ? `${team} : ${lines.join(' + ')}` : `${team} : enjeu standard`;
  };

  const xgInfo = (team, xgFor, underperforming) =>
    xgFor !== null
      ? `${team} xG produits : ${xgFor}${underperforming ? ' — SOUS-PERFORME ses xG → annuler bonus forme si applicable' : ''}`
      : `${team} : données xG non disponibles`;

  const h2hInfo = h2hSameVenue && h2hHomeWinRate !== null
    ? `H2H même stade disponible — taux victoire domicile historique : ${Math.round(h2hHomeWinRate * 100)}%`
    : `H2H : données insuffisantes ou stade différent → neutraliser (0%)`;

  const langInstruction = userLang !== 'en'
    ? `Le champ "analysis_summary" doit être rédigé en ${userLang === 'fr' ? 'français' : userLang}.`
    : 'Le champ "analysis_summary" doit être rédigé en anglais.';

  // ── Construction du prompt utilisateur ─────────────────────────
  const userPrompt = `
DONNÉES DU MATCH À ANALYSER
════════════════════════════
Match        : ${home} vs ${away}
Compétition  : ${competition}
Date         : ${date}
Type         : ${isDerby ? '⚠️ DERBY — Appliquer reset 50/50 à l\'étape 4' : 'Match standard'}
Ligue mineure: ${isMinorLeague ? 'OUI → H2H neutralisé, confidence max 65' : 'Non'}

CLASSEMENTS SAISON EN COURS
${homeRank !== null ? `${home} : ${homeRank}e` : `${home} : classement non disponible`}
${awayRank !== null ? `${away} : ${awayRank}e` : `${away} : classement non disponible`}

FATIGUE (seuil critique 96h)
${fatigue(home, homeLastMatchHoursAgo)}
${fatigue(away, awayLastMatchHoursAgo)}

ABSENCES
${absences(home, homeAbsences, homeSubDepth)}
${absences(away, awayAbsences, awaySubDepth)}

ENJEU
${motivation(home, homeTitleRace, homeRelegation)}
${motivation(away, awayTitleRace, awayRelegation)}

FORME RÉCENTE
${home} : ${homeWinStreak >= 3 ? `${homeWinStreak} victoires consécutives (+5%)` : 'Pas de série en cours'}
${away} : ${awayWinStreak >= 3 ? `${awayWinStreak} victoires consécutives (+5%)` : 'Pas de série en cours'}

EXPECTED GOALS (xG)
${xgInfo(home, homeXgFor, homeXgUnderperforming)}
${xgInfo(away, awayXgFor, awayXgUnderperforming)}

H2H
${h2hInfo}

LANGUE
${langInstruction}

Applique le pipeline en 5 étapes dans l'ordre strict et retourne uniquement le JSON.
`;

  return userPrompt;
}

/**
 * callGemini(apiData) — Appel complet Gemini avec system prompt + user prompt
 * Séparation stricte : Gemini calcule les probabilités pures.
 * Le Kelly et le Value Edge sont calculés APRÈS réception du JSON.
 */
async function callGemini(apiData, geminiKey) {
  const userPrompt = buildPrompt(apiData);

  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

  for (const model of models) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 25000);

      const response = await fetch(
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

      if (!response.ok) {
        console.warn(`[Gemini] ${model} HTTP ${response.status} — fallback`);
        continue;
      }

      const data = await response.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;

      const result = JSON.parse(raw);

      // ── Validation sécurité post-parsing ──────────────────────
      const fp = result.final_probability;
      if (!fp || fp.home_win === undefined) throw new Error('JSON invalide');

      // Cap 0.05 / 0.95
      ['home_win', 'draw', 'away_win'].forEach(k => {
        fp[k] = Math.min(0.95, Math.max(0.05, fp[k]));
      });

      // Normalisation somme = 1.00
      const total = fp.home_win + fp.draw + fp.away_win;
      if (Math.abs(total - 1.0) > 0.01) {
        fp.home_win /= total;
        fp.draw     /= total;
        fp.away_win /= total;
      }

      // confidence entier
      result.confidence = Math.min(95, Math.round(
        Math.max(fp.home_win, fp.draw, fp.away_win) * 100
      ));

      // Ligue mineure → confidence max 65
      if (apiData.isMinorLeague) {
        result.confidence = Math.min(65, result.confidence);
      }

      console.log(`[Gemini] ${model} ✅ confidence=${result.confidence}%`);
      return result;

    } catch (err) {
      console.warn(`[Gemini] ${model} error: ${err.message}`);
    }
  }

  throw new Error('Tous les modèles Gemini ont échoué');
}

/**
 * computeKellyAndValueEdge(geminiResult, userOdds) — Mission 2 (côté backend)
 * Calcul Kelly et Value Edge APRÈS réception du JSON Gemini.
 * Jamais dans le prompt Gemini.
 *
 * @param {Object} geminiResult - JSON retourné par Gemini
 * @param {number} userOdds - Cote bookmaker saisie par l'utilisateur
 * @returns {Object} - { valueEdgePct, kellyUnits, recommendation }
 */
function computeKellyAndValueEdge(geminiResult, userOdds) {
  if (!userOdds || userOdds <= 1) return null;

  const fp = geminiResult.final_probability;
  const maxProb = Math.max(fp.home_win, fp.draw, fp.away_win);
  const impliedProb = 1 / userOdds;

  // Value Edge = (probabilité estimée - probabilité implicite cote) × 100
  const valueEdgePct = Math.round((maxProb - impliedProb) * 100 * 10) / 10;

  // Critère Kelly fractionné (25% Kelly pour limiter le risque)
  const kellyFull = (maxProb * userOdds - 1) / (userOdds - 1);
  const kellyUnits = Math.max(0, Math.min(5, Math.round(kellyFull * 0.25 * 10 * 10) / 10));

  const recommendation = valueEdgePct > 0 && geminiResult.confidence >= 70
    ? 'VALUE BET DÉTECTÉ'
    : valueEdgePct > 0 && geminiResult.confidence < 70
    ? 'EDGE POSITIF — CONFIANCE INSUFFISANTE'
    : 'PAS DE VALUE — NE PAS MISER';

  return { valueEdgePct, kellyUnits, recommendation };
}

module.exports = { buildPrompt, callGemini, computeKellyAndValueEdge, GEMINI_SYSTEM_PROMPT };
