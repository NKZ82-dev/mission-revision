# Prompt Gemini — génération d'un fichier de questions

**Comment l'utiliser**

1. Ouvre une nouvelle conversation Gemini, joins les photos des pages à réviser.
2. Copie le prompt ci-dessous, remplis le bloc **PARAMÈTRES** (le reste ne change jamais), envoie.
3. Copie le bloc JSON obtenu :
   - sur ordinateur : colle-le dans un fichier texte nommé `matiere-theme.json`, puis dépose-le dans le dossier Drive ;
   - sur téléphone : bouton **Partager › Exporter vers Docs**, puis déplace le Google Doc dans le dossier Drive (l'app lit aussi les Google Docs).
4. S'il y a des images à générer (liste à la fin de la réponse de Gemini), utilise le **prompt n° 2** plus bas.
5. Dans l'app : **Bibliothèque › Synchroniser** pour vérifier qu'il n'y a pas d'erreur.

---

## Prompt n° 1 — Questions

```text
Tu es un enseignant expérimenté qui prépare un élève à une évaluation. À partir des photos de pages de manuel ci-jointes, crée un fichier de questions de révision pour l'application « Mission Révision ».

### PARAMÈTRES (à modifier)
- Matière : Sciences
- Thème : Masse et volume
- Titre de l'évaluation : Évaluation du 12 novembre
- Niveau : Secondaire 1 (Québec)
- Nombre de questions : 20
- Préfixe des identifiants : sci-mv
- Répartition souhaitée : environ 40 % qcm, 15 % vrai_faux, 15 % choix_multiples, 10 % association, 10 % ordre, et 1 ou 2 mises en situation (type « situation », 2 à 4 sous-questions chacune)
- Visuels : oui, quand un schéma aide vraiment à comprendre (environ 1 question sur 5)

### RÈGLES DE CONTENU
1. Utilise UNIQUEMENT le contenu des pages fournies. N'invente aucune notion qui n'y figure pas. Couvre toutes les notions importantes des pages, pas seulement la première.
2. Écris en français du Québec, avec des phrases courtes et claires adaptées au niveau indiqué. Tutoie l'élève.
3. Varie les niveaux : environ 30 % faciles (difficulte 1), 50 % moyennes (2), 20 % difficiles (3). Les questions difficiles demandent d'appliquer ou de raisonner, pas seulement de réciter une définition.
4. Les mauvaises réponses (distracteurs) doivent être plausibles : erreurs fréquentes, confusions classiques entre notions voisines, mauvaises unités. Jamais de réponse absurde ou humoristique. Évite « toutes ces réponses » et « aucune de ces réponses ».
5. Toutes les options d'une question ont une longueur et une forme semblables (la bonne réponse ne doit pas se repérer parce qu'elle est plus longue ou plus précise).
6. « indice » : une piste qui fait réfléchir sans JAMAIS donner ni éliminer directement la réponse.
7. « explication » : 1 à 2 phrases qui expliquent POURQUOI c'est la bonne réponse.
8. « astuce » : un moyen mnémotechnique court, seulement s'il est vraiment utile (sinon omets le champ).
9. « page » : le numéro de page du manuel visible sur la photo où se trouve la notion (omets le champ si illisible).
10. « notion » : la sous-notion travaillée (ex. « Volume », « Unités »), pour regrouper les questions.
11. Pour les nombres, utilise la virgule décimale et les symboles Unicode (cm³, m², H₂O, °C, ×, ÷, −).
12. Tu peux mettre un mot clé en gras avec **double astérisque**.

### FORMAT DE SORTIE — À RESPECTER STRICTEMENT
Réponds avec UN SEUL bloc de code ```json contenant un JSON valide (guillemets doubles droits, aucune virgule finale, aucun commentaire), avec cette structure :

{
  "format": "mission-revision/1",
  "matiere": "<Matière>",
  "theme": "<Thème>",
  "titre": "<Titre de l'évaluation>",
  "niveau": "<Niveau>",
  "source": "Manuel, p. <première>-<dernière page>",
  "questions": [ ... ]
}

Chaque question a ces champs communs : "id" (préfixe + numéro sur 3 chiffres : "sci-mv-001", "sci-mv-002"…), "type", "notion", "difficulte", "question", "indice", "explication", et si pertinents "astuce" et "page".

Champs propres à chaque "type" :
- "qcm" : "options" (exactement 4 chaînes) et "reponse" (copie EXACTE, caractère pour caractère, de l'une des options).
- "vrai_faux" : "reponse" vaut true ou false (booléen, sans guillemets). Équilibre les vrais et les faux. Les affirmations fausses doivent être crédibles.
- "choix_multiples" : "options" (5 ou 6 chaînes) et "reponses" (liste de 2 à 4 copies EXACTES d'options). Commence la question par « Lesquelles… » ou « Coche… ».
- "association" : "paires" = liste de 3 à 5 objets {"gauche": "…", "droite": "…"}. Les éléments de droite sont tous différents et courts (moins de 60 caractères).
- "ordre" : "elements" = liste de 3 à 6 éléments écrits DANS LE BON ORDRE (l'application les mélange). Précise le critère d'ordre dans la question (« du plus petit au plus grand », « dans l'ordre des étapes »…).
- "situation" : "titre", "contexte" (un court scénario concret de la vie courante, 2 à 4 phrases, qui contient les données nécessaires) et "questions" (2 à 4 sous-questions de n'importe quel type sauf "situation", chacune avec son propre "id" : "sci-mv-010a", "sci-mv-010b"…). Les champs "indice" et "explication" vont dans chaque sous-question.

### VISUELS
Pour une question qui gagne à avoir un visuel, ajoute UN des deux champs suivants (jamais les deux), plus "image_alt" (une phrase qui décrit le visuel) :

A) "svg" — pour les schémas simples (instrument gradué, figure géométrique, graphique, schéma légendé, ligne du temps). Règles :
   - une seule ligne, qui commence par <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 L H' width='L' height='H'> (L et H ≤ 400) ;
   - attributs entre APOSTROPHES simples (') — jamais de guillemets doubles à l'intérieur du SVG ;
   - formes simples (rect, line, circle, path, polygon, text), font-family='Arial', texte ≥ 13 px, couleurs sobres sur fond clair ;
   - aucun script, aucune image externe, aucun texte qui se chevauche ;
   - le schéma doit être EXACT (graduations, valeurs, proportions) : vérifie que la bonne réponse se lit réellement sur le dessin ;
   - le SVG ne doit pas donner la réponse à lui seul quand la question porte justement sur ce qu'on y lit.

B) "image" — pour une illustration réaliste impossible à dessiner en SVG (photo d'un objet, scène, organisme). Mets un nom de fichier en minuscules sans accents ni espaces, préfixé par l'id : "sci-mv-014-balance-a-plateaux.png".

Après le bloc JSON, s'il y a des champs "image", ajoute une section « Images à générer » : pour chaque image, le nom de fichier exact puis une description détaillée pour la générer (style illustration éducative claire sur fond blanc, sans texte superflu, sans la réponse écrite dessus).

### VÉRIFICATION AVANT DE RÉPONDRE
Avant d'écrire ta réponse, vérifie mentalement :
- le nombre total de questions (les sous-questions d'une situation comptent chacune pour une) ;
- chaque "reponse" / "reponses" est une copie exacte d'une option ;
- chaque réponse est correcte selon les pages fournies (aucune erreur scientifique) ;
- les "id" sont uniques ;
- le JSON est valide.
```

---

## Prompt n° 2 — Générer les images (dans la même conversation)

```text
Génère maintenant l'image « <nom-du-fichier.png> » décrite dans ta liste. Style : illustration éducative claire, fond blanc, format carré, aucun texte sauf les légendes indispensables, et surtout aucune indication de la réponse.
```

Télécharge l'image, **renomme-la exactement** avec le nom indiqué (l'extension peut différer : `.png` ou `.jpg`, l'app ne tient pas compte de l'extension ni des majuscules), puis dépose-la dans le dossier `images/` du Drive.

> Si une image ne te plaît pas ou que tu n'as pas le temps : pas de panique, la question s'affiche quand même avec la description (`image_alt`) à la place de l'image, et la Bibliothèque te signale l'image manquante.

---

## Prompts utiles en complément

**Ajouter des questions à un thème existant** (dans la conversation d'origine) :
```text
Crée 10 nouvelles questions sur les mêmes pages, différentes des précédentes, en continuant la numérotation des id à partir de sci-mv-021. Même format, nouveau fichier complet (avec matiere, theme, titre).
```

**Corriger un fichier signalé en erreur par la Bibliothèque** :
```text
L'application signale ces problèmes dans ton JSON : <colle la liste>. Corrige-les et renvoie le fichier complet.
```
