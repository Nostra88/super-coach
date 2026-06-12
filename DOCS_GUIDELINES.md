# SUPERCOACH — Documentation & Guidelines

## Identité du produit
- **Nom** : SUPERCOACH
- **Tagline** : Your AI sports copilot
- **Mascotte** : "The Coach" — éclair doré ⚡ dans un cercle vert
- **Positionnement** : Outil d'analyse sportive IA, informatif uniquement. Pas un service de paris.
- **Architecture** : Single-file PWA (index.html ~187KB) + backend Node.js sur Render

## Stack technique
| Composant | Technologie | URL |
|---|---|---|
| Frontend | HTML/CSS/JS (single file) | Netlify |
| Backend | Node.js / Express | Render Starter |
| IA | Gemini 2.5 Flash (thinkingBudget:1024) | Google AI |
| Données foot | API-Football Pro (7500 req/jour) | api-sports.io |
| Autres sports | API-Sports Free (100 req/jour) | api-sports.io |
| Base de données | Neon PostgreSQL | neon.tech |
| Auth (à venir) | À définir | — |
| Paiement (à venir) | Stripe | — |

## Règles architecturales permanentes

### Backend (server.js)
- `node --check` avant chaque commit
- `thinkingBudget` plafonné à 1024 — jamais dépasser sur Render Starter
- Pas de règles calendaires hardcodées
- Clé unique `APISPORTS_KEY` pour tous les modules API-Sports
- Endpoint `/fixtures` : API-Football en priorité, ESPN en fallback automatique

### Frontend (index.html)
- **Emojis** : toujours en Unicode natif, jamais en séquences Python (`\uXXXX`)
- **Traductions** : 7 langues (EN/FR/ES/PT/IT/DE/AR), toujours via `t('clé')`, jamais hardcodées
- **Clés de traduction** : ajoutées strictement à la fin de chaque bloc de langue
- **Variable `validation`** : toujours null-protégée
- **URL input** : jamais wrappée dans `buildPrompt()`
- **Affichage** : zéro JSON brut visible — double protection serveur + parser frontend
- **Cohérence JS** : vérifier les noms de variables dans tout le fichier avant commit
- **Commits iPhone** : fichiers >100KB se tronquent via Safari — utiliser l'API GitHub

### Pipeline d'analyse (doctrine v9.0)
> "External APIs validate. Gemini analyzes. Never the reverse."

1. TheOddsAPI → validation
2. API-Sports → données
3. ESPN → enrichissement seulement
4. Gemini → analyse finale

### Doctrine "Sniper Mode"
- Max 3 picks par analyse
- Confiance ≥ 75%
- Compétitions réelles uniquement — pas de matchs amicaux

## Identité visuelle
- **Palette** : fond noir #0a0a0a, vert primaire #2d8a55, vert secondaire #1a5c35
- **Typographie** : Bebas Neue (titres), Inter (corps), JetBrains Mono (données)
- **Couleurs sport** : foot #4ade80, basket #f97316, tennis #eab308, hockey #3b82f6, baseball #10b981, WC #fde68a
- **Style cartes** : DeepSeek ultra-lisible — textes aérés, indicateurs en gras, puces alignées

## Marques et légalité
- **FIFA** : marque déposée — utiliser "World Cup 2026" uniquement
- **Jeu responsable** : mention obligatoire 18+ sur toutes les interfaces
- **Disclaimer** : "Informational purposes only. Not financial advice."
