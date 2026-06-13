// ═══════════════════════════════════════════════════════════════════
// SUPERCOACH — MODULE 2 : Tests d'Intégration et de Robustesse
// supercoach.test.js — Jest
// Usage : npx jest supercoach.test.js --verbose
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── Helpers ──────────────────────────────────────────────────────────

// apiData minimal valide pour les tests
function makeApiData(overrides = {}) {
  return {
    sport: 'football',
    home: 'Team A', away: 'Team B',
    competition: 'Test League', date: '2026-06-01T20:00:00Z',
    isDerbyOrRivalry: false, isMinorLeague: false,
    homeRank: 5, awayRank: 10,
    environment: { travelTimeHours: 2, weatherCondition: 'clear', temperatureCelsius: 18,
                   baseballWindDirection: 'none', homeLastMatchHoursAgo: 120, awayLastMatchHoursAgo: 120 },
    context: { homeCrisis: false, awayCrisis: false, homeNewCoachThisWeek: false, awayNewCoachThisWeek: false },
    homeAbsences: {}, awayAbsences: {},
    homeSubDepth: {}, awaySubDepth: {},
    sportSpecific: {},
    homeTitleRace: false, homeRelegation: false,
    awayTitleRace: false, awayRelegation: false,
    homeWinStreak: 0, awayWinStreak: 0,
    advancedMetrics: {},
    h2hSameVenue: false, h2hHomeWinRate: null,
    userLang: 'en',
    ...overrides,
  };
}

// Normaliser les probabilités comme le fait callGemini
function normalizeProbabilities(fp, sport) {
  const twoWay = ['basketball', 'tennis', 'baseball'].includes(sport);
  if (twoWay) fp.draw = 0;

  ['home_win', 'draw', 'away_win'].forEach(k => {
    fp[k] = Math.min(0.95, Math.max(0.05, Number(fp[k]) || 0.05));
  });
  if (twoWay) fp.draw = 0;

  const total = fp.home_win + fp.draw + fp.away_win;
  if (Math.abs(total - 1.0) > 0.005) {
    fp.home_win /= total; fp.draw /= total; fp.away_win /= total;
  }
  ['home_win', 'draw', 'away_win'].forEach(k => {
    fp[k] = Math.round(fp[k] * 10000) / 10000;
  });
  return fp;
}

// ── Importer les modules ───────────────────────────────────────────────
const { buildPrompt, GEMINI_SYSTEM_PROMPT, computeKellyAndValueEdge } = require('./engine.js');

// ══════════════════════════════════════════════════════════════════════
// TEST SUITE 1 — buildPrompt() : Structure et Contenu
// ══════════════════════════════════════════════════════════════════════
describe('buildPrompt() — Structure', () => {

  test('Retourne une string non-vide', () => {
    const prompt = buildPrompt(makeApiData());
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
  });

  test('Contient les noms des équipes', () => {
    const prompt = buildPrompt(makeApiData({ home: 'Manchester City', away: 'Arsenal' }));
    expect(prompt).toContain('Manchester City');
    expect(prompt).toContain('Arsenal');
  });

  test('Contient le sport', () => {
    const prompt = buildPrompt(makeApiData({ sport: 'basketball' }));
    expect(prompt.toUpperCase()).toContain('BASKETBALL');
  });

  test('Indique DERBY pour un match de derby', () => {
    const prompt = buildPrompt(makeApiData({ isDerbyOrRivalry: true }));
    expect(prompt).toMatch(/DERBY|RIVALRY/i);
  });

  test('Indique ligue mineure si isMinorLeague=true', () => {
    const prompt = buildPrompt(makeApiData({ isMinorLeague: true }));
    expect(prompt).toMatch(/[Mm]ineure|[Mm]inor/);
  });

  test('Indique Back-to-Back pour NBA < 24h', () => {
    const prompt = buildPrompt(makeApiData({
      sport: 'basketball',
      environment: { homeLastMatchHoursAgo: 18, awayLastMatchHoursAgo: 60,
                     travelTimeHours: 0, weatherCondition: 'clear', temperatureCelsius: 20,
                     baseballWindDirection: 'none' },
    }));
    expect(prompt).toMatch(/BACK.TO.BACK|B2B/i);
  });

  test('Mention joueur absent pour tennis → match_cancelled', () => {
    const prompt = buildPrompt(makeApiData({
      sport: 'tennis',
      sportSpecific: { playerAbsent: true },
    }));
    expect(prompt).toMatch(/match_cancelled|ABSENT|blessé/i);
  });

  test('Contient instruction langue pour IT', () => {
    const prompt = buildPrompt(makeApiData({ userLang: 'it' }));
    expect(prompt).toMatch(/italian|italiano/i);
  });

  test('Draw = 0.00 pour basketball dans l\'instruction', () => {
    const prompt = buildPrompt(makeApiData({ sport: 'basketball' }));
    expect(prompt).toMatch(/draw.*0\.00|2.way/i);
  });

  test('Pas d\'injection de clé Gemini dans le prompt', () => {
    const prompt = buildPrompt(makeApiData());
    expect(prompt).not.toMatch(/AIza|sk-|Bearer/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// TEST SUITE 2 — Normalisation des Probabilités (Cap 0.05/0.95)
// ══════════════════════════════════════════════════════════════════════
describe('Normalisation des probabilités — Sécurité anti-crash', () => {

  test('Cap max 0.95 — match ultra-déséquilibré (tous bonus cumulés)', () => {
    // Gemini retourne 0.99 pour home_win après tous les bonus
    const fp = normalizeProbabilities({ home_win: 0.99, draw: 0.005, away_win: 0.005 }, 'football');
    expect(fp.home_win).toBeLessThanOrEqual(0.95);
    expect(fp.away_win).toBeGreaterThanOrEqual(0.05);
    expect(fp.draw).toBeGreaterThanOrEqual(0);
  });

  test('Cap min 0.05 — équipe très défavorisée', () => {
    const fp = normalizeProbabilities({ home_win: 0.98, draw: 0.01, away_win: 0.01 }, 'football');
    expect(fp.away_win).toBeGreaterThanOrEqual(0.05);
  });

  test('Somme = 1.00 après normalisation (football)', () => {
    const fp = normalizeProbabilities({ home_win: 0.70, draw: 0.20, away_win: 0.10 }, 'football');
    const sum = fp.home_win + fp.draw + fp.away_win;
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
  });

  test('Draw = 0 pour basketball', () => {
    const fp = normalizeProbabilities({ home_win: 0.65, draw: 0.10, away_win: 0.25 }, 'basketball');
    expect(fp.draw).toBe(0);
  });

  test('Draw = 0 pour tennis', () => {
    const fp = normalizeProbabilities({ home_win: 0.55, draw: 0.15, away_win: 0.30 }, 'tennis');
    expect(fp.draw).toBe(0);
  });

  test('Draw = 0 pour baseball', () => {
    const fp = normalizeProbabilities({ home_win: 0.48, draw: 0.12, away_win: 0.40 }, 'baseball');
    expect(fp.draw).toBe(0);
  });

  test('Somme = 1.00 pour basketball (sans draw)', () => {
    const fp = normalizeProbabilities({ home_win: 0.65, draw: 0.10, away_win: 0.25 }, 'basketball');
    const sum = fp.home_win + fp.away_win;
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
  });

  test('Probabilité invalide (NaN) → remplacée par 0.05', () => {
    const fp = normalizeProbabilities({ home_win: NaN, draw: 0.20, away_win: 0.80 }, 'football');
    expect(fp.home_win).toBeGreaterThanOrEqual(0.05);
    expect(isNaN(fp.home_win)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// TEST SUITE 3 — Parsing JSON robuste (texte parasite)
// ══════════════════════════════════════════════════════════════════════
describe('Parsing JSON — Robustesse contre texte parasite', () => {

  // Parser qui nettoie le texte avant JSON.parse (reproduit la logique backend)
  function safeParseGeminiResponse(raw) {
    if (!raw || typeof raw !== 'string') throw new Error('Réponse vide');
    let cleaned = raw.trim();
    // Supprimer les backticks markdown
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    // Extraire le JSON entre la première { et la dernière }
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Aucun JSON trouvé');
    cleaned = cleaned.slice(start, end + 1);
    return JSON.parse(cleaned);
  }

  test('Parse un JSON propre', () => {
    const raw = '{"home_team":"PSG","away_team":"OM","confidence":72}';
    expect(() => safeParseGeminiResponse(raw)).not.toThrow();
    expect(safeParseGeminiResponse(raw).confidence).toBe(72);
  });

  test('Supprime les backticks markdown en début/fin', () => {
    const raw = '```json\n{"home_team":"A","confidence":65}\n```';
    const parsed = safeParseGeminiResponse(raw);
    expect(parsed.home_team).toBe('A');
  });

  test('Ignore le texte avant la première accolade', () => {
    const raw = 'Voici mon analyse:\n{"home_team":"X","confidence":70}';
    const parsed = safeParseGeminiResponse(raw);
    expect(parsed.home_team).toBe('X');
  });

  test('Ignore le texte après la dernière accolade', () => {
    const raw = '{"home_team":"Y","confidence":68}\n\nNote: données partielles.';
    const parsed = safeParseGeminiResponse(raw);
    expect(parsed.home_team).toBe('Y');
  });

  test('Lève une exception propre si JSON invalide (pas de crash)', () => {
    expect(() => safeParseGeminiResponse('Aucun JSON ici')).toThrow('Aucun JSON trouvé');
  });

  test('Lève une exception propre si réponse vide', () => {
    expect(() => safeParseGeminiResponse('')).toThrow('Réponse vide');
  });

  test('Lève une exception propre si null', () => {
    expect(() => safeParseGeminiResponse(null)).toThrow('Réponse vide');
  });

  test('JSON avec texte parasite au milieu — extrait la partie valide', () => {
    const raw = 'Analyse complète :\n```json\n{"confidence":80,"sport":"football"}\n```\nFin.';
    const parsed = safeParseGeminiResponse(raw);
    expect(parsed.confidence).toBe(80);
  });
});

// ══════════════════════════════════════════════════════════════════════
// TEST SUITE 4 — Cascade Fallback Gemini (Mock fetch)
// ══════════════════════════════════════════════════════════════════════
describe('Cascade Fallback Gemini — Timeout & Rate Limit', () => {

  // Simuler callGemini avec un fetch mocké
  async function callGeminiWithMockFetch(mockFetch, apiData) {
    const userPrompt = buildPrompt(apiData);
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

    for (const model of models) {
      try {
        const res = await mockFetch(model, userPrompt);
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) continue;
        return { model, result: JSON.parse(raw) };
      } catch(e) {
        // Fallback au prochain modèle
      }
    }
    throw new Error('Tous les modèles ont échoué');
  }

  const validResponse = {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        home_team: 'A', away_team: 'B', confidence: 72,
        final_probability: { home_win: 0.60, draw: 0.25, away_win: 0.15 },
        steps_log: {}, analysis_summary: 'Test OK',
      }) }] } }],
    }),
  };

  test('Fallback sur flash-lite si flash timeout', async () => {
    let callCount = 0;
    const mockFetch = async (model) => {
      callCount++;
      if (model === 'gemini-2.5-flash') throw new Error('Timeout simulé');
      return validResponse;
    };
    const { model } = await callGeminiWithMockFetch(mockFetch, makeApiData());
    expect(model).toBe('gemini-2.5-flash-lite');
    expect(callCount).toBe(2);
  });

  test('Fallback sur flash-lite si flash retourne HTTP 429', async () => {
    const mockFetch = async (model) => {
      if (model === 'gemini-2.5-flash') return { ok: false, status: 429 };
      return validResponse;
    };
    const { model } = await callGeminiWithMockFetch(mockFetch, makeApiData());
    expect(model).toBe('gemini-2.5-flash-lite');
  });

  test('Lance une erreur si les DEUX modèles échouent', async () => {
    const mockFetch = async () => { throw new Error('Network error'); };
    await expect(callGeminiWithMockFetch(mockFetch, makeApiData())).rejects.toThrow('Tous les modèles ont échoué');
  });

  test('Utilise flash si flash répond correctement (pas de fallback)', async () => {
    let flashCalled = false;
    const mockFetch = async (model) => {
      if (model === 'gemini-2.5-flash') { flashCalled = true; return validResponse; }
      throw new Error('Ne doit pas être appelé');
    };
    const { model } = await callGeminiWithMockFetch(mockFetch, makeApiData());
    expect(model).toBe('gemini-2.5-flash');
    expect(flashCalled).toBe(true);
  });

  test('Fallback transparent si flash retourne JSON invalide', async () => {
    const mockFetch = async (model) => {
      if (model === 'gemini-2.5-flash') return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'texte invalide' }] } }] }),
      };
      return validResponse;
    };
    const { model } = await callGeminiWithMockFetch(mockFetch, makeApiData());
    expect(model).toBe('gemini-2.5-flash-lite');
  });
});

// ══════════════════════════════════════════════════════════════════════
// TEST SUITE 5 — Kelly & Value Edge
// ══════════════════════════════════════════════════════════════════════
describe('computeKellyAndValueEdge() — Calcul financier', () => {

  const baseResult = {
    final_probability: { home_win: 0.65, draw: 0.20, away_win: 0.15 },
    confidence: 65,
  };

  test('Value Edge positif si prob > cote implicite', () => {
    const kelly = computeKellyAndValueEdge(baseResult, 1.80);
    // prob 0.65 > 1/1.80 = 0.556 → value edge positif
    expect(kelly.valueEdgePct).toBeGreaterThan(0);
  });

  test('Value Edge négatif si prob < cote implicite', () => {
    const kelly = computeKellyAndValueEdge(baseResult, 1.10);
    // prob 0.65 < 1/1.10 = 0.909 → pas de value
    expect(kelly.valueEdgePct).toBeLessThan(0);
  });

  test('Kelly units entre 0 et 5', () => {
    const kelly = computeKellyAndValueEdge(baseResult, 1.80);
    expect(kelly.kellyUnits).toBeGreaterThanOrEqual(0);
    expect(kelly.kellyUnits).toBeLessThanOrEqual(5);
  });

  test('Retourne null si odds <= 1', () => {
    expect(computeKellyAndValueEdge(baseResult, 0.90)).toBeNull();
    expect(computeKellyAndValueEdge(baseResult, 1.00)).toBeNull();
  });

  test('Retourne null si pas de odds', () => {
    expect(computeKellyAndValueEdge(baseResult, null)).toBeNull();
    expect(computeKellyAndValueEdge(baseResult, undefined)).toBeNull();
  });

  test('Recommendation VALUE BET si edge > 0 et confidence >= 70', () => {
    const highConf = { ...baseResult, confidence: 75,
      final_probability: { home_win: 0.80, draw: 0.10, away_win: 0.10 } };
    const kelly = computeKellyAndValueEdge(highConf, 1.50);
    expect(kelly.recommendation).toBe('VALUE BET DÉTECTÉ');
  });

  test('Recommendation EDGE POSITIF si edge > 0 et confidence < 70', () => {
    const lowConf = { ...baseResult, confidence: 60,
      final_probability: { home_win: 0.65, draw: 0.20, away_win: 0.15 } };
    const kelly = computeKellyAndValueEdge(lowConf, 1.80);
    if (kelly.valueEdgePct > 0) {
      expect(kelly.recommendation).toBe('EDGE POSITIF — CONFIANCE INSUFFISANTE');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// TEST SUITE 6 — GEMINI_SYSTEM_PROMPT
// ══════════════════════════════════════════════════════════════════════
describe('GEMINI_SYSTEM_PROMPT — Contenu', () => {

  test('Est une string non-vide', () => {
    expect(typeof GEMINI_SYSTEM_PROMPT).toBe('string');
    expect(GEMINI_SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });

  test('Contient les 5 étapes du pipeline', () => {
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/ÉTAPE 1/);
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/ÉTAPE 2/);
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/ÉTAPE 3/);
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/ÉTAPE 4/);
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/ÉTAPE 5/);
  });

  test('Contient l\'instruction anti-biais prestige', () => {
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/ANTI.BIAIS|prestige historique/i);
  });

  test('Contient le cap 0.95', () => {
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/0\.95/);
  });

  test('Contient la règle draw=0 pour basketball', () => {
    expect(GEMINI_SYSTEM_PROMPT).toMatch(/basketball.*draw.*0\.00|draw.*0\.00.*basketball/is);
  });

  test('Ne contient pas de clé API', () => {
    expect(GEMINI_SYSTEM_PROMPT).not.toMatch(/AIza[A-Za-z0-9_-]{35}/);
  });
});
