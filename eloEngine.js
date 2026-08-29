'use strict';

/**
 * eloEngine.js — Probability Engine V1 (statistique, indépendant de Gemini)
 *
 * Validé par le protocole LOT B (B.1 → B.4) :
 * - Log Loss holdout (2024-2025, jamais utilisé pour calibrer) : 0,99286
 * - Bat l'uniforme (1,0986) et la fréquence historique (1,0663) sur 7/7 compétitions et 3/3
 *   fenêtres temporelles glissantes testées.
 * - Gain statistiquement significatif vs version précédente (IC95% bootstrap exclut 0).
 *
 * IMPORTANT — ce que ce module NE prétend PAS :
 * - Ce n'est pas une preuve de rentabilité ni de supériorité sur le marché (bookmakers).
 *   Le benchmark marché reste un chantier séparé, non fait.
 * - regressionFactor=1 et homeAdvantage=0 sont des résultats empiriques sur les données
 *   actuelles (5 saisons, 7 compétitions) — pas des constantes universelles. Objet de
 *   ré-évaluation quand plus d'historique sera disponible (LOT A.4 et suivants).
 *
 * Aucune fonction ici ne fait d'appel réseau, de lecture DB, ni n'appelle Gemini.
 * Les ratings sont un ÉTAT PERSISTÉ (table team_elo_ratings), jamais recalculés depuis zéro
 * pendant une requête utilisateur — seul un job hors-ligne (voir /admin/seed-elo-ratings
 * dans server.js) réentraîne les ratings.
 */

// ── Paramètres validés (LOT B.4) ──
const ELO_PARAMS = Object.freeze({
  homeAdvantage: 0,      // neutralisé — testé, aucun impact mesurable (écart 0,00003 en Log Loss)
  kFactor: 25,
  regressionFactor: 1,   // aucune régression de saison — résultat empirique, pas une loi
});
const ORDERED_LOGIT_PARAMS = Object.freeze({
  beta: 0.0062893919998364845,
  alpha1: -0.964271538773436,
  alpha2: 0.2207952101780597,
});
const INITIAL_RATING = 1500;
const NO_SIGNAL_MATCHES_THRESHOLD = 10;
const TRAIN_ELO_GAP_RANGE = Object.freeze([-396, 491]); // plage observée à l'entraînement (LOT B.4)

function logistic(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Convertit un écart de rating en probabilités 1N2 via l'Ordered Logit validé.
 * Garantie : les 3 probabilités sont toujours strictement positives et somment à 1.
 */
function computeExpectedProbabilities(ratingHome, ratingAway) {
  const x = (ratingHome + ELO_PARAMS.homeAdvantage) - ratingAway;
  const { beta, alpha1, alpha2 } = ORDERED_LOGIT_PARAMS;
  const cdf1 = logistic(alpha1 - beta * x);
  const cdf2 = logistic(alpha2 - beta * x);
  return { pAway: cdf1, pDraw: cdf2 - cdf1, pHome: 1 - cdf2, eloGap: x };
}

/**
 * Met à jour les deux ratings après un match réel (résultat connu).
 * @param {number} actualResult - 1 = victoire domicile, 0.5 = nul, 0 = victoire extérieur
 */
function updateRatings(ratingHome, ratingAway, actualResult, matchesPlayedHome, matchesPlayedAway) {
  const x = (ratingHome + ELO_PARAMS.homeAdvantage) - ratingAway;
  const expectedHome = logisticElo(x);
  const kHome = matchesPlayedHome < NO_SIGNAL_MATCHES_THRESHOLD ? ELO_PARAMS.kFactor * 1.6 : ELO_PARAMS.kFactor;
  const kAway = matchesPlayedAway < NO_SIGNAL_MATCHES_THRESHOLD ? ELO_PARAMS.kFactor * 1.6 : ELO_PARAMS.kFactor;
  const kEffective = (kHome + kAway) / 2;
  const delta = kEffective * (actualResult - expectedHome);
  return { newHome: ratingHome + delta, newAway: ratingAway - delta };
}
function logisticElo(x) { return 1 / (1 + Math.pow(10, -x / 400)); }

function applySeasonRegression(rating, leagueMean) {
  return rating * ELO_PARAMS.regressionFactor + leagueMean * (1 - ELO_PARAMS.regressionFactor);
}

/**
 * Classification objective du signal — jamais une impression qualitative.
 * NO_SIGNAL   : historique insuffisant sur au moins une des deux équipes, ou équipe inconnue.
 * WEAK_SIGNAL : historique suffisant, mais écart de rating hors de la plage observée à
 *               l'entraînement (extrapolation) — le modèle répond quand même, avec réserve.
 * NORMAL      : dans les conditions où le modèle a été validé.
 */
function classifySignal(homeMatchesPlayed, awayMatchesPlayed, eloGap) {
  if (homeMatchesPlayed == null || awayMatchesPlayed == null) {
    return { status: 'NO_SIGNAL', reason: 'Équipe absente de la base historique.' };
  }
  if (homeMatchesPlayed < NO_SIGNAL_MATCHES_THRESHOLD || awayMatchesPlayed < NO_SIGNAL_MATCHES_THRESHOLD) {
    return { status: 'NO_SIGNAL', reason: `Historique insuffisant (< ${NO_SIGNAL_MATCHES_THRESHOLD} matchs) pour au moins une équipe.` };
  }
  if (eloGap < TRAIN_ELO_GAP_RANGE[0] || eloGap > TRAIN_ELO_GAP_RANGE[1]) {
    return { status: 'WEAK_SIGNAL', reason: `Écart de rating (${Math.round(eloGap)}) hors de la plage validée [${TRAIN_ELO_GAP_RANGE[0]}, ${TRAIN_ELO_GAP_RANGE[1]}].` };
  }
  return { status: 'NORMAL', reason: null };
}

module.exports = {
  ELO_PARAMS, ORDERED_LOGIT_PARAMS, INITIAL_RATING, NO_SIGNAL_MATCHES_THRESHOLD, TRAIN_ELO_GAP_RANGE,
  computeExpectedProbabilities, updateRatings, applySeasonRegression, classifySignal,
};
