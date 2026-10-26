# Format des fichiers de questions — `mission-revision/1`

Chaque fichier `.json` déposé dans le dossier Drive est lu automatiquement par l'app.
Un fichier peut couvrir **un ou plusieurs thèmes**, et un thème peut être réparti sur **plusieurs fichiers** : l'app regroupe tout par **Matière → Thème**.

## Organisation du dossier Drive

```
Mission Révision/            ← le dossier partagé avec le script
├── sciences/                ← sous-dossiers libres (optionnels)
│   ├── masse-volume.json
│   └── etats-matiere.json
├── francais/
│   └── classes-de-mots.json
├── images/                  ← images référencées par nom de fichier
│   ├── cube-arete-3cm.svg
│   └── balance-plateaux.png
└── _historique.json         ← créé automatiquement (résultats de Clément)
```

- Tous les sous-dossiers sont parcourus.
- Les fichiers et dossiers qui commencent par `_` sont ignorés (brouillons, archives : `_archive/`).
- Les **noms d'images doivent être uniques** dans tout le dossier (l'app les retrouve par nom, sans tenir compte des majuscules ni de l'extension).

## Structure d'un fichier

```json
{
  "format": "mission-revision/1",
  "matiere": "Sciences",
  "theme": "Masse et volume",
  "titre": "Évaluation du 12 novembre",
  "niveau": "Secondaire 1",
  "source": "Manuel, p. 112-130",
  "questions": [ ... ]
}
```

| Champ | Obligatoire | Rôle |
|---|---|---|
| `matiere` | oui | Regroupement principal (Sciences, Français, Mathématiques…) |
| `theme` | oui | Regroupement secondaire, c'est ce qu'on coche avant le quiz |
| `titre`, `niveau`, `source` | non | Informatif (affiché dans la Bibliothèque) |
| `questions` | oui | Liste des questions |

Plusieurs thèmes dans un même fichier : soit on met `"theme"` sur chaque question (il remplace celui du fichier), soit le fichier contient une **liste** de blocs : `[ { "matiere": …, "theme": …, "questions": […] }, { … } ]`.

## Champs communs à toutes les questions

| Champ | Obligatoire | Rôle |
|---|---|---|
| `id` | fortement conseillé | Identifiant **unique et stable** (ex. `sci-mv-001`). Sert à l'historique : ne pas le changer après coup. |
| `type` | oui | `qcm`, `vrai_faux`, `choix_multiples`, `association`, `ordre`, `situation` |
| `question` | oui | L'énoncé. `**gras**` et retours de ligne `\n` acceptés. |
| `indice` | conseillé | Affiché au 2ᵉ essai (mode « Seconde chance »). Ne doit pas donner la réponse. |
| `explication` | conseillé | Affichée après la réponse. |
| `astuce` | non | Truc mnémotechnique. |
| `page` | non | Page du manuel. |
| `notion` | non | Sous-notion (ex. « Volume »), pour la progression. |
| `difficulte` | non | 1 (facile), 2, 3 (difficile). |
| `theme`, `matiere` | non | Remplace la valeur du fichier pour cette question. |
| `image` | non | Nom d'un fichier image du dossier Drive (`cube.png`), ou une URL `https://…` |
| `svg` | non | Un dessin SVG directement dans le JSON (attributs entre apostrophes `'`). |
| `image_alt` | conseillé avec une image | Description de l'image (affichée si l'image est introuvable). |

## Les 6 types

### `qcm` — une seule bonne réponse
```json
{ "type": "qcm", "question": "…", "options": ["A", "B", "C", "D"], "reponse": "B" }
```
`reponse` doit être **identique** (mot pour mot) à l'une des `options`. Les options sont mélangées par l'app.

### `vrai_faux`
```json
{ "type": "vrai_faux", "question": "1 mL équivaut à 1 cm³.", "reponse": true }
```

### `choix_multiples` — plusieurs bonnes réponses
```json
{ "type": "choix_multiples", "question": "…", "options": ["mL", "kg", "L", "g"], "reponses": ["mL", "L"] }
```
Juste seulement si toutes les bonnes réponses sont cochées, et aucune mauvaise.

### `association` — relier des paires
```json
{ "type": "association", "question": "Associe…",
  "paires": [ { "gauche": "Masse", "droite": "Balance" }, { "gauche": "Température", "droite": "Thermomètre" } ] }
```
De 3 à 6 paires. Les éléments de droite doivent tous être différents.

### `ordre` — remettre dans l'ordre
```json
{ "type": "ordre", "question": "Du plus petit au plus grand", "elements": ["5 mL", "0,5 L", "2 L"] }
```
`elements` est donné **dans le bon ordre** ; l'app les mélange. De 3 à 6 éléments.

### `situation` — mise en situation
```json
{ "type": "situation", "titre": "La roche mystère",
  "contexte": "Léa verse 40 mL d'eau…", "image": "roche.png",
  "questions": [ { "type": "qcm", … }, { "type": "vrai_faux", … } ] }
```
Le contexte (et son image) reste affiché au-dessus de chaque sous-question. Les sous-questions peuvent être de n'importe quel type sauf `situation`, et comptent chacune pour un point.

## Compatibilité

L'ancien format produit par Gemini est accepté tel quel : `sujet` (= `theme`), `section` (= `notion`), `reponse_correcte` (= `reponse`), `astuce_mnemo` (= `astuce`), `reference_page` (= `page`). Une question sans `type` est devinée à partir de ses champs.

## Vérifier un fichier

Après l'avoir déposé dans Drive : app → **Bibliothèque** → **Synchroniser**. Chaque fichier y apparaît avec son nombre de questions et la liste des problèmes détectés (JSON invalide, réponse absente des options, image introuvable, identifiant en double…). Une question invalide est simplement écartée ; le reste du fichier fonctionne.
