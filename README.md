# Mission Révision

Application de quiz de révision (PWA) hébergée sur GitHub Pages, qui lit ses questions dans un **dossier Google Drive**. On ajoute des fichiers au fil de l'année, l'app les prend en compte automatiquement : plus besoin de toucher au code.

```
Photos du manuel ──► Gemini (prompt fixe) ──► fichier .json / Google Doc ──► dossier Drive
                                                                                │
         iPhone / Android ◄── PWA GitHub Pages ◄── relais Google Apps Script ◄──┘
                                       │                      ▲
                                       └── résultats ─────────┘ (_historique.json)
```

**Fonctions**

- Choix par **matière → thème**, nombre de questions (5 / 10 / 20 / toutes).
- 6 types de questions : choix unique, vrai/faux, plusieurs réponses, association, remise en ordre, mise en situation (scénario + sous-questions).
- Images : schémas SVG écrits directement dans le JSON, ou fichiers image du dossier Drive référencés par leur nom. Touche une image pour l'agrandir.
- Mode **Seconde chance** : indice puis nouvel essai ; le point ne compte qu'au premier essai.
- **Historique dans Drive** : progression par thème, mode « Points faibles » (priorité aux questions ratées / jamais vues) et « Revoir mes erreurs ».
- **Bibliothèque** : vérifie chaque fichier et liste les problèmes (JSON invalide, réponse absente des options, image introuvable…).
- Fonctionne hors ligne avec les dernières questions synchronisées ; les résultats sont envoyés au retour du réseau.

## Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/` | L'application (aucune dépendance, aucune compilation) |
| `exemples/` | Questions de démonstration (utilisées tant que Drive n'est pas connecté) |
| `apps-script/Code.gs` | Le relais à copier dans Google Apps Script |
| `docs/FORMAT.md` | Le format des fichiers de questions |
| `docs/PROMPT-GEMINI.md` | Le prompt réutilisable pour Gemini |

## Installation (≈ 15 minutes, une seule fois)

### 1. Dossier Google Drive
1. Crée un dossier, par exemple **Mission Révision**, avec un sous-dossier `images/`.
2. Ouvre-le : l'ID est la fin de l'URL, après `/folders/`. Copie-le.

### 2. Relais Google Apps Script
1. Va sur [script.google.com](https://script.google.com) › **Nouveau projet**, nomme-le « Mission Révision ».
2. Remplace le contenu de `Code.gs` par celui de `apps-script/Code.gs`.
3. En haut du fichier, renseigne :
   - `FOLDER_ID` : l'ID du dossier ;
   - `KEY` : une clé secrète de ton choix (ex. 20 lettres et chiffres au hasard).
4. Choisis la fonction **`verifierInstallation`** › **Exécuter** › accepte les autorisations (Drive et Docs). Le journal affiche le nombre de fichiers et de questions trouvés.
5. **Déployer › Nouveau déploiement** › type **Application Web** :
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
6. Copie l'URL qui se termine par `/exec`.

> Quand tu modifies le script plus tard : **Déployer › Gérer les déploiements › ✏️ › Version : Nouvelle version**. L'URL reste la même.

### 3. GitHub Pages
1. Crée un dépôt (ex. `mission-revision`) et dépose-y tous les fichiers de ce dossier.
2. **Settings › Pages** › *Deploy from a branch* › `main` / `(root)`.
3. L'app est en ligne à `https://<ton-compte>.github.io/mission-revision/`.

> Le `Code.gs` du dépôt garde les valeurs d'exemple : ton `FOLDER_ID` et ta `KEY` ne vivent que dans Apps Script.

### 4. Connexion et installation sur les téléphones
1. Ouvre l'app › **Réglages** › colle l'URL `/exec` et la clé › **Tester et enregistrer**.
2. Toujours dans Réglages, copie le **lien d'installation** (il contient l'URL et la clé) et envoie-le à l'élève.
3. Sur iPhone : ouvrir le lien dans Safari › **Partager › Sur l'écran d'accueil**. Sur Android : menu Chrome › **Installer l'application**.

## Au quotidien : ajouter une évaluation

1. Photographie les pages du plan d'étude.
2. Gemini : nouvelle conversation + photos + **prompt n° 1** de `docs/PROMPT-GEMINI.md` (seul le bloc PARAMÈTRES change).
3. Dépose le JSON (ou le Google Doc exporté) dans le dossier Drive, et les éventuelles images dans `images/`.
4. App › **Bibliothèque › Synchroniser** : vérifie qu'il n'y a pas d'erreur. C'est prêt.

Astuces d'organisation :
- Un fichier par évaluation ou par chapitre ; plusieurs fichiers peuvent partager le même thème (ils sont fusionnés).
- Ranger dans des sous-dossiers (`sciences/`, `francais/`) est libre : seuls `matiere` et `theme` comptent dans l'app.
- Préfixe un fichier ou un dossier par `_` pour le désactiver sans le supprimer (`_archive/`).
- Ne change pas les `id` d'un fichier déjà utilisé : l'historique s'y rattache.

## Bon à savoir

- **Confidentialité** : toute personne qui a le lien d'installation (URL + clé) peut lire les questions et l'historique des scores. Il ne contient aucune autre donnée personnelle. Pour couper l'accès : change `KEY` dans le script, redéploie une nouvelle version et renvoie un nouveau lien.
- **Mises à jour de l'app** : le service worker charge toujours la dernière version quand le réseau est disponible (cache seulement hors ligne).
- **Taille des images** : préfère des images de moins de 1 Mo ; elles sont mises en cache sur le téléphone après le premier affichage.
- **Mode démo** : sans connexion Drive, l'app utilise les questions de `exemples/`. Réglages › « Revenir au mode démo » pour y retourner.
