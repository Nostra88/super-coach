# 🧢⚡ SUPERCOACH — Guide de déploiement

## Architecture

- **Frontend** → Netlify (gratuit)
- **Backend** → Render (7$/mois, déjà payé)
- **IA** → Gemini 1.5 Flash (gratuit)

-----

## ÉTAPE 1 — Backend sur Render

1. Va sur **render.com** → New → Web Service
1. Connecte ton repo GitHub (dossier `backend/`)
1. Configure :
- **Build Command** : `npm install`
- **Start Command** : `node server.js`
1. Variables d’environnement :
- `GEMINI_KEY` = ta clé Gemini (AIzaSy…)
1. Copie l’URL générée : `https://supercoach-xxx.onrender.com`

-----

## ÉTAPE 2 — Frontend sur Netlify

1. Dans `frontend/index.html`, ligne :
   
   ```
   var BACKEND_URL = 'https://supercoach-api.onrender.com';
   ```
   
   Remplace par ton URL Render réelle.
1. Va sur **netlify.com** → Add new site → Import from Git
1. Sélectionne ton repo GitHub (dossier `frontend/`)
1. Deploy !
1. URL finale : `https://supercoach.netlify.app`

-----

## ÉTAPE 3 — Installer sur iPhone

1. Ouvre Safari → va sur ton URL Netlify
1. Appuie sur **Partager** (icône carré avec flèche)
1. **“Sur l’écran d’accueil”**
1. SUPERCOACH s’installe comme une vraie app ! 🎉

-----

## Structure des fichiers

```
supercoach/
├── backend/
│   ├── server.js       ← Serveur proxy Gemini
│   ├── package.json    ← Dépendances Node.js
│   └── .env.example    ← Variables d'environnement
└── frontend/
    ├── index.html      ← App complète
    ├── manifest.json   ← Config PWA
    ├── sw.js           ← Service Worker (offline)
    └── logo.svg        ← Logo SUPERCOACH
```
