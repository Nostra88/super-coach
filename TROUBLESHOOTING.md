# SUPERCOACH — Post-Mortem & Règles Anti-Régression

## BUG #1 — Flux TODAY : bouton Analyser ne répondait pas
**Symptôme** : Clic sur "Analyser" → ❌ erreur instantanée sans spinner  
**Cause racine** : `goBtn` (onclick=`analyze()`) était positionné dans `panelFlux`. Sur iOS Safari, il captait tous les clics avant `fluxAnalyzeBtn`.  
**Fix** : `goBtn` redirigé vers `analyzeFlux()`. Ne jamais mettre deux boutons d'action dans le même panel.  
**Règle** : Chaque panel a UN SEUL bouton d'action principal. Vérifier les `onclick` de tous les boutons avant commit.

## BUG #2 — Sélection de matchs ignorée (selectedMatches vide)
**Symptôme** : Case cochée visuellement mais `analyzeFlux()` trouvait 0 matchs  
**Cause racine** : `overflow-y:auto` sur `.flux-list` — iOS Safari interprétait le tap comme scroll, le listener `click` n'était jamais déclenché.  
**Fix** : Suppression du `max-height` + ajout d'un listener `touchend` en parallèle du `click`.  
**Règle** : Sur iOS Safari, tout conteneur scrollable doit avoir les deux listeners : `click` ET `touchend`. Utiliser `e.preventDefault()` sur `touchend`.

## BUG #3 — Rendu DOM détruisant les closures
**Symptôme** : Clic sur match → re-render → anciens listeners pointaient vers mauvais indices  
**Cause racine** : `toggleFluxMatch()` appelait `renderFluxList()` → détruisait et recréait tout le DOM → les closures des listeners précédents devenaient invalides.  
**Fix** : `toggleFluxMatch()` met à jour UNIQUEMENT l'élément cliqué via `querySelector`. Jamais de re-render global sur une action utilisateur.  
**Règle** : **INTERDICTION** d'appeler `renderFluxList()` depuis `toggleFluxMatch()`. Mise à jour DOM ciblée uniquement.

## BUG #4 — Dictionnaire L={} supprimé accidentellement
**Symptôme** : App muette — toutes les traductions retournaient les clés brutes  
**Cause racine** : Une fonction mal délimitée (`buildPromptFromContent`) avait englobé tout le dictionnaire L={} dans son corps. Sa suppression a emporté les 7 langues.  
**Fix** : Réinjection manuelle du bloc SPORTS + STATE + LANG complet.  
**Règle** : Avant toute suppression de bloc JS, compter les accolades pour vérifier la délimitation exacte. Toujours faire `node --check` après.

## BUG #5 — clock24 vs clockIs24h
**Symptôme** : Onglet TODAY vide — aucun match affiché  
**Cause racine** : Variable `clock24` utilisée dans `renderFluxList()` au lieu de `clockIs24h` — crash silencieux bloquant tout le rendu DOM.  
**Règle** : Vérifier la cohérence des noms de variables JS dans **tout** le fichier avant chaque commit. `node --check` ne détecte pas les variables undefined en mode non-strict.

## Règles générales anti-régression

| Règle | Détail |
|---|---|
| `node --check` obligatoire | Avant chaque commit sur server.js et tout JS isolé |
| Commits via API GitHub | Jamais via Safari iPhone pour les fichiers >100KB |
| Un seul bouton d'action par panel | Évite les conflits de clic |
| Pas de re-render global sur action user | Mise à jour DOM ciblée uniquement |
| `classList.add/remove` | Jamais `classList.toggle(name, force)` — non supporté iOS <14 |
| Double listener click + touchend | Sur tous les éléments interactifs dans un conteneur scrollable |
| Vérifier délimitation des fonctions | Compter les accolades avant suppression |
