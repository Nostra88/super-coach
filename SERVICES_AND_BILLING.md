# SUPERCOACH — Services & Facturation

## Services actifs

| Service | Rôle | Coût/mois | Prélèvement | Statut |
|---|---|---|---|---|
| **Render Starter** | Hébergement backend Node.js | $7 | — | ✅ Actif |
| **Netlify** | Hébergement frontend PWA | $0 | — | ✅ Actif |
| **Google Gemini API** | Moteur d'analyse IA | ~$5 | À l'usage | ✅ Actif |
| **API-Football Pro** | Données football mondial (7500 req/jour) | $15 | 2026-07-10 | ✅ Actif |
| **API-Basketball Free** | Données basketball (100 req/jour) | $0 | 2027-06-01 | ✅ Actif |
| **API-Baseball Free** | Données baseball (100 req/jour) | $0 | 2027-06-01 | ✅ Actif |
| **API-Hockey Free** | Données hockey (100 req/jour) | $0 | 2027-06-01 | ✅ Actif |
| **API-Rugby Free** | Données rugby (100 req/jour) | $0 | 2027-06-01 | ✅ Actif |
| **Neon PostgreSQL** | Base de données (ROI Tracker) | $0 | — | ✅ Actif |
| **Stripe** | Paiement abonnements | — | — | ⏳ À intégrer |

## Résumé financier

| | Montant |
|---|---|
| **Coût mensuel actuel** | ~$27/mois |
| **Revenu break-even** | 3 abonnés × $9.99 |
| **Revenu cible Phase 1** | 10 abonnés × $9.99 = $99.90/mois |

## Variables d'environnement (Render)

| Variable | Service | Statut |
|---|---|---|
| `GEMINI_KEY` | Google Gemini | ✅ Configurée |
| `APISPORTS_KEY` | API-Sports (tous modules) | ✅ Configurée |
| `ODDS_API_KEY` | TheOddsAPI | ✅ Configurée |
| `DATABASE_URL` | Neon PostgreSQL | ✅ Configurée |
| `STRIPE_SECRET_KEY` | Stripe | ⏳ À configurer |

## Roadmap Phase 2 (à budgéter)

| Service | Rôle | Coût estimé |
|---|---|---|
| API-Basketball Pro | Données basketball complètes | $15/mois |
| API-Tennis Pro | Données tennis complètes | $15/mois |
| Render Standard | Si trafic > 1000 users/jour | $25/mois |
