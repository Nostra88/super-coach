# 🧢⚡ SUPERCOACH

**L'IA qui analyse. Toi qui gagnes.**

App PWA d'analyse sportive et de prediction markets intelligence, avec paiement crypto intégré.

---

## Architecture (état actuel — v9.0)

- **Frontend** → Netlify (PWA, `index.html`) — supercoachlab.com
- **Backend** → Render (`server.js` v9.0) — supercoach-api-acyw.onrender.com — 7$/mois
- **Moteur IA** → `engine.js` v9.2, Google Gemini 2.5 Flash (gratuit, quota surveillé)
- **Auth + Base de données** → Supabase (Magic Link + Google OAuth)
- **Stockage secondaire** → Neon PostgreSQL
- **Paiement** → NOWPayments (crypto, actif) · Lemon Squeezy (carte, en attente)
- **Prediction Markets** → Polymarket + Manifold (actifs) · Kalshi (intégration en cours)
- **Cotes bookmakers** → The Odds API (payant)
- **Fixtures foot** → API-Football / api-sports.io

Détail complet : voir `SUPERCOACH_carnet_technique.md` et `SUPERCOACH_APIs_abonnements.md` dans ce dossier.

---

## Fonctionnalités actives

- SMART PICKS v2 avec badges VERDICT LAB
- Value Bet + Kelly Fractionnel
- Prediction Markets Intelligence (146+ marchés, refresh horaire)
- Essai gratuit 7 jours (anti-abus server-side)
- Parrainage (+7 jours Premium, référent + filleul)
- Gating Premium server-side (Market Edge, Kelly)
- 7 langues
- Backtest interne (endpoint protégé, non public)

---

## Déploiement

- **Netlify** et **Render** redéploient automatiquement à chaque commit sur `main`
- Variables d'environnement (Render → Environment) : voir `SUPERCOACH_carnet_technique.md`, section Render, pour la liste complète et leur rôle

---

*Document mis à jour le 21/08/2026. Pour l'historique du dépannage et le détail de chaque service, voir le carnet technique.*
