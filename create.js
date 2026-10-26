/* Mission Révision — création de missions depuis l'app (mode parent, API Gemini)
 *
 * Photos du manuel → Gemini (questions en JSON structuré) → découpe des figures dans les photos
 * → illustrations générées (option) → aperçu → publication dans Drive via le relais Apps Script.
 * La clé Gemini et le code parent restent sur l'appareil du parent (jamais dans le lien d'installation).
 */
'use strict';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_PHOTOS = 12;

/* ================================ Utilitaires ================================ */
const slugify = (s) => loose(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mission';
const pad2 = (n) => String(n).padStart(2, '0');
const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);
function saveParent() { LS.set('parent', S.parent); }

function loadImageEl(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image illisible')); im.src = src; });
}

async function resizeImage(file, max = 1600, quality = 0.85) {
  let src = null, bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { src = URL.createObjectURL(file); bmp = await loadImageEl(src); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (src) URL.revokeObjectURL(src);
  return { dataUrl: c.toDataURL('image/jpeg', quality), w, h };
}

async function toJpeg(dataUrl, max = 1024, quality = 0.88) {
  const im = await loadImageEl(dataUrl);
  const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/* ================================ API Gemini ================================ */
function friendlyGeminiError(status, msg) {
  const m = String(msg || '');
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'Clé API Gemini invalide (Réglages › Mode parent).';
  if (status === 402 || /prepayment credits are depleted/i.test(m)) return 'Crédit prépayé Gemini épuisé : recharge-le dans AI Studio › Facturation (ou active la recharge automatique).';
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(m)) return /PerDay|per day|daily/i.test(m) ? 'Quota quotidien Gemini atteint (clé gratuite). Réessaie demain ou active la facturation.' : 'Limite de débit Gemini atteinte. Les illustrations demandent une clé payante.';
  if (status === 404) return `Modèle introuvable (${m.slice(0, 120)}). Réglages › Mode parent › Tester pour le mettre à jour.`;
  if (status === 403) return 'Accès refusé par Gemini : ' + m.slice(0, 160);
  if (status === 503 || status === 500 || status === 502 || status === 504 || /high demand|overloaded|UNAVAILABLE/i.test(m)) return 'Gemini est surchargé en ce moment. Réessaie dans quelques minutes.';
  return `Erreur Gemini ${status || ''} : ${m.slice(0, 200)}`;
}

async function geminiFetch(path, body, timeoutMs = 240000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${GEMINI}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'x-goog-api-key': S.parent.geminiKey }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw networkError(e);
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* */ }
  if (!r.ok) throw apiError(r.status, j && j.error);
  return j;
}

/* Erreur d'API enrichie : statut, message brut, délai conseillé (quota par minute) */
function apiError(status, e) {
  const msg = (e && e.message) || '';
  const err = new Error(friendlyGeminiError(status, msg));
  err.status = status; err.raw = msg;
  const det = (e && e.details) || [];
  const ri = det.find((d) => d && d.retryDelay);
  if (ri) err.retryAfter = parseFloat(String(ri.retryDelay)) || 0;
  err.daily = /PerDay|per day|daily/i.test(msg + JSON.stringify(det));
  return err;
}

function networkError(e) {
  if (e && e.status !== undefined) return e;
  const err = new Error(e && e.name === 'AbortError'
    ? 'Gemini met trop de temps à répondre. Réessaie avec moins de photos ou de questions.'
    : 'La connexion à Gemini a été coupée (réseau instable, ou app mise en arrière-plan). Garde l\'app ouverte pendant la génération.');
  err.status = 0; err.network = true;
  return err;
}

/*
 * Appel en streaming (SSE) : la réponse arrive au fil de l'eau, ce qui garde la connexion
 * active sur le réseau mobile (pas de coupure pendant la minute de rédaction) et permet
 * d'afficher la progression. Coupe si plus rien n'arrive pendant `idleMs`.
 */
async function geminiStream(model, body, onProgress, idleMs = 150000) {
  const ctrl = new AbortController();
  let idle = setTimeout(() => ctrl.abort(), idleMs);
  const poke = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), idleMs); };
  try {
    let r;
    try {
      r = await fetch(`${GEMINI}/models/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'x-goog-api-key': S.parent.geminiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) { throw networkError(e); }
    if (!r.ok) {
      let j = null;
      try { j = await r.json(); } catch (e) { /* */ }
      throw apiError(r.status, j && (Array.isArray(j) ? j[0] && j[0].error : j.error));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', finish = '', thoughts = 0, usage = null;
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) { throw networkError(e); }
      if (chunk.done) break;
      poke();
      buf += dec.decode(chunk.value, { stream: true }).replace(/\r/g, '');
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, cut); buf = buf.slice(cut + 2);
        ev.split('\n').forEach((line) => {
          if (!line.startsWith('data:')) return;
          let j;
          try { j = JSON.parse(line.slice(5)); } catch (e) { return; }
          if (j.error) throw apiError(j.error.code, j.error);
          if (j.usageMetadata) usage = j.usageMetadata;
          const c = j.candidates && j.candidates[0];
          ((c && c.content && c.content.parts) || []).forEach((p) => { if (p.thought) thoughts++; else if (p.text) text += p.text; });
          if (c && c.finishReason) finish = c.finishReason;
        });
      }
      onProgress && onProgress({ text, thoughts });
    }
    return { text, finish, usage };
  } finally { clearTimeout(idle); }
}

const versionOf = (name) => { const m = name.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
function pickTextModel(names) {
  const ok = names.filter((n) => /^gemini-[\d.]+-flash$/.test(n));
  const pool = ok.length ? ok : names.filter((n) => /flash/.test(n) && !/lite|image|tts|live|audio|embedding/.test(n));
  return pool.sort((a, b) => versionOf(b) - versionOf(a) || a.length - b.length)[0] || '';
}
function pickImageModel(names) {
  const pool = names.filter((n) => /image/.test(n) && !/preview|exp/.test(n));
  const all = pool.length ? pool : names.filter((n) => /image/.test(n));
  const score = (n) => (/flash-image$/.test(n) ? 2 : /flash/.test(n) && !/lite/.test(n) ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a) || versionOf(b) - versionOf(a))[0] || '';
}

async function listModels() {
  const j = await geminiFetch('models?pageSize=1000', null, 30000);
  return (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini/.test(n));
}

/* ================================ Prompt et schéma ================================ */
const VISUEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['aucun', 'figure', 'svg', 'illustration'] },
    photo: { type: 'INTEGER' },
    zone: { type: 'ARRAY', items: { type: 'INTEGER' } },
    svg: { type: 'STRING' },
    description: { type: 'STRING' },
  },
  required: ['type'],
};
const Q_PROPS = {
  type: { type: 'STRING', enum: ['qcm', 'vrai_faux', 'choix_multiples', 'association', 'ordre'] },
  notion: { type: 'STRING' },
  difficulte: { type: 'INTEGER' },
  question: { type: 'STRING' },
  options: { type: 'ARRAY', items: { type: 'STRING' } },
  reponse: { type: 'STRING' },
  reponse_vrai: { type: 'BOOLEAN' },
  reponses: { type: 'ARRAY', items: { type: 'STRING' } },
  paires: { type: 'ARRAY', items: { type: 'OBJECT', properties: { gauche: { type: 'STRING' }, droite: { type: 'STRING' } }, required: ['gauche', 'droite'] } },
  elements: { type: 'ARRAY', items: { type: 'STRING' } },
  indice: { type: 'STRING' },
  explication: { type: 'STRING' },
  astuce: { type: 'STRING' },
  page: { type: 'STRING' },
  visuel: VISUEL_SCHEMA,
};
// Indice, explication et astuce sont OBLIGATOIRES : le schéma l'impose au modèle
const REQUIRED = ['type', 'notion', 'difficulte', 'question', 'indice', 'explication', 'astuce', 'visuel'];
const SUB_SCHEMA = { type: 'OBJECT', properties: Q_PROPS, required: REQUIRED };
const QUESTION_SCHEMA = {
  type: 'OBJECT',
  properties: Object.assign({}, Q_PROPS, {
    type: { type: 'STRING', enum: ['qcm', 'vrai_faux', 'choix_multiples', 'association', 'ordre', 'situation'] },
    titre: { type: 'STRING' },
    contexte: { type: 'STRING' },
    sous_questions: { type: 'ARRAY', items: SUB_SCHEMA },
  }),
  required: ['type', 'question', 'visuel'],
};
const MISSION_SCHEMA = {
  type: 'OBJECT',
  properties: { matiere: { type: 'STRING' }, theme: { type: 'STRING' }, source: { type: 'STRING' }, questions: { type: 'ARRAY', items: QUESTION_SCHEMA } },
  required: ['questions'],
};

/* Thème laissé vide (ou « je ne sais pas ») : Gemini le déduit des pages */
const UNKNOWN_THEME = /^(je ne sais pas|je sais pas|sais pas|\?+|inconnu|aucun|a determiner|-)$/;
const themeGiven = (C) => { const t = C.theme.trim(); return t && !UNKNOWN_THEME.test(loose(t)) ? t : ''; };

const DEFAULT_MIX = 'environ 40 % qcm, 15 % vrai_faux, 15 % choix_multiples, 15 % association, 15 % ordre';

/*
 * Règle des visuels (dans cet ordre de priorité) :
 * 1. « figure » : la page contient déjà le schéma/tableau/photo utile → on le découpe dans la photo (gratuit, fidèle au manuel)
 * 2. « svg »    : il faut un schéma précis absent des pages (instrument gradué, figure géométrique, graphique) → dessiné par Gemini (gratuit)
 * 3. « illustration » : seulement si l'option est cochée, pour rendre concrète une question (objet, scène) → Nano Banana (payant)
 * Quotas par lot pour garder la génération rapide ; l'app les fait respecter.
 */
const visualQuota = (n, illus) => ({ figure: Math.ceil(n / 3), svg: Math.ceil(n / 8), illustration: illus ? Math.ceil(n / 5) : 0 });

/* Matières proposées (en plus de celles déjà présentes dans Drive) */
const COMMON_MATIERES = ['Sciences', 'Mathématiques', 'Français', 'Anglais', 'Histoire', 'Géographie', 'Culture et citoyenneté québécoise', 'Arts plastiques', 'Musique', 'Éducation physique', 'Espagnol'];
function matiereList() {
  const have = S.db ? Object.keys(S.db.tree) : [];
  return [...have.sort(sortAlpha), ...COMMON_MATIERES.filter((m) => !have.some((h) => loose(h) === loose(m)))];
}
/* Rattache la saisie à une matière existante (même nom aux accents/majuscules près) */
function canonicalMatiere(m) {
  const t = str(m);
  if (!t) return '';
  const have = S.db ? Object.keys(S.db.tree) : [];
  return have.find((h) => loose(h) === loose(t)) || COMMON_MATIERES.find((h) => loose(h) === loose(t)) || t;
}
const majority = (vals) => {
  const n = {};
  vals.map(str).filter(Boolean).forEach((v) => { n[v] = (n[v] || 0) + 1; });
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || '';
};

function buildPrompt(C, matiere, B) {
  const theme = themeGiven(C);
  const existing = matiere && S.db && S.db.tree[matiere] ? Object.keys(S.db.tree[matiere]) : [];
  const q = visualQuota(B.n, C.illus);
  const photos = B.photos.map((i) => i + 1);
  return `Tu es un enseignant expérimenté qui prépare un élève à une évaluation. À partir des photos de pages de manuel ci-jointes, crée des questions de révision.

PARAMÈTRES
- Matière : ${matiere || `non fournie : déduis-la des pages et renvoie-la dans « matiere », en choisissant si possible parmi : ${matiereList().join(', ')}`}
- Thème : ${theme || 'non fourni : déduis-le des pages (titre du chapitre ou de la section, 2 à 6 mots) et renvoie-le dans « theme »'}${!theme && existing.length ? `. Thèmes existants dans cette matière : ${existing.map((t) => `« ${t} »`).join(', ')} ; si les pages correspondent à l'un d'eux, reprends exactement ce nom` : ''}
- Niveau : ${S.parent.niveau || 'Secondaire 1 (Québec)'}
- Photos fournies : ${photos.map((n) => `Photo ${n}`).join(', ')}${B.focus ? ` (${B.focus})` : ''}
- Crée EXACTEMENT ${B.n} questions (chaque sous-question d'une mise en situation compte pour une).
- Types : ${B.types}.
- Mises en situation : ${B.situations ? `exactement ${B.situations} (type « situation », 2 ou 3 sous_questions chacune)` : 'aucune'}.
${C.consignes ? `- Consignes du parent : ${C.consignes}\n` : ''}${B.avoid && B.avoid.length ? `- Ces questions existent déjà, n'en crée pas de semblables : ${B.avoid.map((t) => `« ${t} »`).join(' ; ')}\n` : ''}
CONTENU
1. Utilise UNIQUEMENT le contenu des photos fournies et couvre toutes leurs notions importantes.
2. Français du Québec, phrases courtes et claires adaptées au niveau. Tutoie l'élève.
3. Difficulté : ~30 % faciles (1), ~50 % moyennes (2), ~20 % difficiles (3) qui demandent d'appliquer ou de raisonner.
4. Distracteurs plausibles (erreurs fréquentes, confusions entre notions voisines, mauvaises unités). Jamais « toutes ces réponses » ni « aucune de ces réponses ». Options de longueur semblable.
5. CHAQUE question et CHAQUE sous-question a OBLIGATOIREMENT, non vides :
   - « indice » : une piste qui fait réfléchir sans donner ni éliminer la réponse ;
   - « explication » : 1 à 2 phrases sur le POURQUOI de la bonne réponse ;
   - « astuce » : l'« astuce de pro », un moyen mnémotechnique, une règle simple ou un truc pour ne plus se tromper (1 phrase courte).
   Pour une « situation » elle-même, mets ces trois champs à "" : ils vont dans ses sous_questions.
6. « page » : numéro de page visible sur la photo ("" si illisible). « notion » : la sous-notion travaillée.
7. Virgule décimale, symboles Unicode (cm³, H₂O, °C, ×, −). Mot clé en gras possible avec **double astérisque**.

FORMAT PAR TYPE
- qcm : exactement 4 « options » ; « reponse » = copie EXACTE, caractère pour caractère, d'une option.
- vrai_faux : « reponse_vrai » = true ou false. Équilibre vrais et faux.
- choix_multiples : 5 ou 6 « options » ; « reponses » = 2 à 4 copies EXACTES d'options. Question commençant par « Lesquelles… » ou « Coche… ».
- association : « paires » de 3 à 5 {gauche, droite} ; éléments de droite tous différents et courts.
- ordre : « elements » (3 à 6) DANS LE BON ORDRE ; le critère d'ordre est dans la question.
- situation : « titre », « contexte » (scénario concret de 2 à 4 phrases avec les données utiles), « question » = courte consigne, « sous_questions ».

VISUELS (champ « visuel » obligatoire ; type « aucun » par défaut). Choisis dans cet ordre de priorité :
1. « figure » (au plus ${q.figure}) : la photo contient déjà un schéma, tableau, graphique ou une image utile à la question → donne « photo » (son numéro) et « zone » = [ymin, xmin, ymax, xmax] de 0 à 1000, cadrée serrée autour de la figure et de ses légendes, SANS texte qui donne la réponse.
2. « svg » (au plus ${q.svg}) : seulement si un schéma précis est indispensable et absent des pages (instrument gradué, figure géométrique, graphique). Une ligne <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 L H' width='L' height='H'> (L, H ≤ 300), apostrophes simples, formes simples, font-family='Arial', texte ≥ 13 px. Schéma exact et sobre.
${q.illustration ? `3. « illustration » (au plus ${q.illustration}) : pour rendre une question plus concrète (objet, scène, organisme) quand les pages n'ont pas d'image utile. « description » = description visuelle détaillée. Elle ne doit jamais être nécessaire pour répondre ni montrer la réponse.` : '3. N\'utilise JAMAIS le type « illustration ».'}
Pour tout visuel, « description » contient une phrase qui décrit l'image.

Avant de répondre, vérifie : nombre exact de questions, réponses copiées exactement des options, indice/explication/astuce présents partout, aucune erreur scientifique.
« source » : par exemple « Manuel, p. 112-118 ». « matiere » : ${matiere ? `« ${matiere} »` : 'la matière déduite des pages'}. « theme » : ${theme ? `« ${theme} »` : 'le thème déduit des pages'}.`;
}

/* Découpe la demande en lots générés EN PARALLÈLE (plus rapide, et un lot raté n'emporte pas tout) */
function planBatches(C) {
  const N = C.n, P = C.photos.length;
  const K = Math.max(1, Math.min(4, Math.round(N / 8)));
  const sizes = Array.from({ length: K }, (_, i) => Math.floor(N / K) + (i < N % K ? 1 : 0));
  const all = C.photos.map((_, i) => i);
  if (K === 1) return [{ n: N, photos: all, types: DEFAULT_MIX, situations: N >= 10 ? 1 : 0 }];
  const nSit = N >= 20 ? 2 : 1;
  if (P >= K) {
    // Chaque lot traite un groupe de pages consécutives (couverture complète, pas de doublons)
    const groups = Array.from({ length: K }, (_, i) => {
      const a = Math.round(i * P / K), z = Math.round((i + 1) * P / K);
      return all.slice(a, z);
    });
    return groups.map((g, i) => ({
      n: sizes[i], photos: g, types: DEFAULT_MIX, situations: i < nSit && sizes[i] >= 6 ? 1 : 0,
      focus: g.length > 1 ? `pages ${g[0] + 1} à ${g[g.length - 1] + 1} de ${P}` : `page ${g[0] + 1} de ${P}`,
    }));
  }
  // Peu de photos : chaque lot reçoit toutes les pages mais un groupe de types différent
  const TYPES = {
    2: [['qcm (≈70 %) et vrai_faux (≈30 %)', 0], ['choix_multiples, association et ordre, en parts égales', nSit]],
    3: [['qcm uniquement', 0], ['vrai_faux (≈50 %) et choix_multiples (≈50 %)', 0], ['association et ordre, en parts égales', nSit]],
    4: [['qcm uniquement', 0], ['vrai_faux (≈50 %) et choix_multiples (≈50 %)', 0], ['association et ordre, en parts égales', 0], ['qcm et choix_multiples de difficulté 3 (raisonnement, application)', nSit]],
  }[K];
  return TYPES.map(([types, sit], i) => ({ n: sizes[i], photos: all, types, situations: sit, focus: 'toutes les pages' }));
}

/* ---------- Lecture robuste du JSON (récupère les questions complètes d'une réponse coupée) ---------- */
function salvageQuestions(text) {
  const start = text.indexOf('"questions"');
  const out = [];
  if (start < 0) return out;
  let i = text.indexOf('[', start);
  if (i < 0) return out;
  let depth = 0, inStr = false, esc2 = false, objStart = -1;
  for (i = i + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc2) esc2 = false; else if (ch === '\\') esc2 = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && objStart >= 0) { try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch (e) { /* objet invalide */ } objStart = -1; } }
    else if (ch === ']' && depth === 0) break;
  }
  return out;
}
function parseMission(text) {
  try { const j = JSON.parse(text); if (j && Array.isArray(j.questions)) return { j, partial: false }; } catch (e) { /* */ }
  const themeM = text.match(/"theme"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const sourceM = text.match(/"source"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const matM = text.match(/"matiere"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { j: { matiere: matM ? JSON.parse(`"${matM[1]}"`) : '', theme: themeM ? JSON.parse(`"${themeM[1]}"`) : '', source: sourceM ? JSON.parse(`"${sourceM[1]}"`) : '', questions: salvageQuestions(text) }, partial: true };
}

/* ================================ Génération ================================ */
function genLog(C, msg) {
  const t = Math.round((Date.now() - (C.progress ? C.progress.startedAt : Date.now())) / 1000);
  (C.log = C.log || []).push(`[${t} s] ${msg}`);
}

function thinkingFor(model) {
  // Réflexion réduite : la rédaction de quiz n'a pas besoin d'un raisonnement long (gain de temps majeur)
  return versionOf(model) >= 3 ? { includeThoughts: true, thinkingLevel: 'low' } : { includeThoughts: true, thinkingBudget: 1024 };
}

/* Limiteur : les lots partent en parallèle, mais dès qu'une limite de débit (429) apparaît
   (fréquent avec une clé gratuite), on passe à un lot à la fois pour ne pas aggraver la situation. */
const Limiter = {
  max: 4, active: 0, queue: [],
  reset(n) { this.max = n; this.active = 0; this.queue = []; },
  async acquire() { while (this.active >= this.max) await new Promise((r) => this.queue.push(r)); this.active++; },
  release() { this.active = Math.max(0, this.active - 1); const next = this.queue.shift(); if (next) next(); },
  throttle() { this.max = 1; },
};

async function runBatch(C, matiere, B, row) {
  const parts = [{ text: buildPrompt(C, matiere, B) }];
  B.photos.forEach((i) => {
    parts.push({ text: `Photo ${i + 1} :` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64(C.photos[i].dataUrl) } });
  });
  const body = (schema, think, model) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: Object.assign(
      { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 24576 },
      schema ? { responseSchema: MISSION_SCHEMA } : {},
      think ? { thinkingConfig: thinkingFor(model) } : {}),
  });
  const status = (state, msg) => { Object.assign(row, { state, msg }); setProgress(); };
  const t0 = Date.now();
  const call = async (model) => {
    row.model = model;
    let schema = true, think = true;
    for (;;) {
      status('wait', Limiter.active >= Limiter.max ? 'en attente (un lot à la fois)' : 'Gemini lit les pages…');
      await Limiter.acquire();
      try {
        status('run', 'Gemini lit les pages…');
        return await geminiStream(model, body(schema, think, model), ({ text, thoughts }) => {
          const n = (text.match(/"question"\s*:/g) || []).length;
          status('run', n ? `≈ ${n} / ${B.n} rédigées` : thoughts ? 'Gemini analyse les pages…' : 'Gemini lit les pages…');
        });
      } catch (e) {
        if (e.status === 429 && Limiter.max > 1) { Limiter.throttle(); genLog(C, 'Limite de débit atteinte : passage à un lot à la fois'); }
        // Paramètre refusé par ce modèle : on le retire et on recommence
        if (e.status === 400 && think && /think|thought/i.test(e.raw || '')) { think = false; genLog(C, `${row.label} : ${model} refuse le réglage de réflexion, on le retire`); continue; }
        if (e.status === 400 && schema && /schema/i.test(e.raw || '')) { schema = false; genLog(C, `${row.label} : ${model} refuse le schéma JSON, on le retire`); continue; }
        throw e;
      } finally { Limiter.release(); }
    }
  };
  try {
    const res = await withFallback(C, textModelChain(), call, (msg) => status('retry', msg));
    const { j, partial } = parseMission(res.text || '');
    const u = res.usage || {};
    genLog(C, `${row.label} : ${j.questions.length} question(s) reçue(s) de ${row.model} en ${Math.round((Date.now() - t0) / 1000)} s · fin=${res.finish || '?'}${partial ? ' · réponse incomplète récupérée' : ''} · jetons entrée ${u.promptTokenCount || '?'}, sortie ${u.candidatesTokenCount || '?'}, réflexion ${u.thoughtsTokenCount || 0}`);
    status('ok', `${j.questions.length} reçue(s)`);
    return j;
  } catch (e) {
    if (S.create !== C) throw e;
    genLog(C, `${row.label} : ÉCHEC — ${e.message}${e.raw ? ` (${String(e.raw).slice(0, 160)})` : ''}`);
    status('err', e.message);
    return null;
  }
}

/* ---------- Résilience : nouvel essai automatique, puis modèle de secours ---------- */
const isTransient = (e) => e.network || [500, 502, 503, 504].includes(e.status) || (e.status === 429 && !e.daily);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Modèle choisi, puis jusqu'à 2 autres modèles Flash disponibles (plus récent d'abord, « lite » en dernier) */
function textModelChain() {
  const main = S.parent.textModel;
  const others = (S.parent.models || [])
    .filter((n) => n !== main && /flash/.test(n) && !/image|tts|live|audio|embedding|preview|exp/.test(n))
    .sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || versionOf(b) - versionOf(a));
  return [main, ...others.slice(0, 2)];
}

async function withFallback(C, models, call, onStatus) {
  const waits = [3, 8];
  let last;
  for (let m = 0; m < models.length; m++) {
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      if (S.create !== C) throw new Error('annulé');
      try {
        return await call(models[m]);
      } catch (e) {
        last = e;
        // Quota quotidien épuisé pour CE modèle : les autres modèles ont leur propre quota → on bascule tout de suite
        if (e.status === 429 && e.daily && m + 1 < models.length) { genLog(C, `${models[m]} : quota quotidien épuisé`); break; }
        if (!isTransient(e)) throw e;
        if (attempt < waits.length) {
          const wait = e.retryAfter ? Math.min(60, Math.ceil(e.retryAfter) + 1) : waits[attempt];
          genLog(C, `${models[m]} : ${e.network ? 'connexion coupée' : `erreur ${e.status}`}, nouvel essai dans ${wait} s`);
          for (let t = wait; t > 0; t--) {
            if (S.create !== C) throw new Error('annulé');
            onStatus(e.network ? `Connexion coupée, nouvel essai dans ${t} s` : e.status === 429 ? `Limite de débit de la clé, nouvel essai dans ${t} s` : `Gemini surchargé, nouvel essai dans ${t} s`);
            await sleep(1000);
          }
        }
      }
    }
    if (m + 1 < models.length) { genLog(C, `${models[m]} indisponible, bascule sur ${models[m + 1]}`); onStatus(`Bascule sur ${models[m + 1]}…`); }
  }
  throw last;
}

/* ---------- Conversion, réparation et contrôle qualité ---------- */
function similarity(a, b) {
  a = loose(a); b = loose(b);
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
/* Si la réponse n'est pas copiée mot pour mot, on la rattache à l'option la plus proche (si elle est vraiment proche) */
function closestOption(options, v) {
  const s = str(v);
  if (options.includes(s)) return s;
  let best = null, score = 0;
  options.forEach((o) => { const x = similarity(o, s); if (x > score) { score = x; best = o; } });
  return score >= 0.8 ? best : s;
}

function makeIds(C, matiere) {
  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(2)}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return { now, prefix: slugify(matiere).slice(0, 3) + stamp, day: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`, hm: `${pad2(now.getHours())}${pad2(now.getMinutes())}` };
}

function convertQuestion(q, id, C) {
  const o = { id, type: q.type };
  ['notion', 'question', 'indice', 'explication', 'astuce', 'page'].forEach((k) => { if (q[k] != null && String(q[k]).trim()) o[k] = String(q[k]).trim(); });
  if (q.difficulte) o.difficulte = Math.max(1, Math.min(3, Number(q.difficulte) || 2));
  switch (q.type) {
    case 'qcm': o.options = arrStr(q.options); o.reponse = closestOption(o.options, q.reponse); break;
    case 'vrai_faux': o.reponse = typeof q.reponse_vrai === 'boolean' ? q.reponse_vrai : toBool(q.reponse); break;
    case 'choix_multiples': o.options = arrStr(q.options); o.reponses = arrStr(q.reponses).map((r) => closestOption(o.options, r)); break;
    case 'association': o.paires = q.paires || []; break;
    case 'ordre': o.elements = arrStr(q.elements); break;
    case 'situation':
      if (q.titre) o.titre = String(q.titre).trim();
      o.contexte = [q.contexte, q.question && q.question !== q.contexte ? q.question : ''].filter(Boolean).join('\n');
      delete o.question; delete o.indice; delete o.explication; delete o.astuce;
      o.questions = (q.sous_questions || []).map((s, k) => convertQuestion(s, id + String.fromCharCode(97 + k), C));
      break;
  }
  const v = q.visuel;
  if (v && v.type && v.type !== 'aucun') {
    o._visuel = { type: v.type, photo: v.photo, zone: v.zone, svg: v.svg, description: v.description };
    if (v.description) o.image_alt = String(v.description).slice(0, 300);
  }
  return o;
}

/* Contrôle strict : structure valide ET indice + explication + astuce présents (questions et sous-questions).
   Renvoie { errs, missing } : `missing` liste les (sous-)questions auxquelles il ne manque que ces champs (réparables). */
const TIP_FIELDS = ['indice', 'explication', 'astuce'];
function checkQuestion(q, ctx) {
  const fakeDb = { images: {} };
  const r = normQ(Object.assign({}, q, { image: undefined, svg: undefined }), ctx, fakeDb, q.id, false);
  const errs = r.issues.filter((x) => x.level === 'error').map((x) => x.msg);
  const missing = [];
  const need = (x) => { const m = TIP_FIELDS.filter((k) => !x[k]); if (m.length) missing.push({ q: x, fields: m }); };
  if (q.type === 'situation') {
    (q.questions || []).forEach(need);
    if (!(q.questions || []).length) errs.push(`${q.id} : situation sans sous-question`);
  } else need(q);
  return { errs, missing };
}

const plainAnswer = (q) => {
  switch (q.type) {
    case 'qcm': return q.reponse;
    case 'vrai_faux': return q.reponse ? 'Vrai' : 'Faux';
    case 'choix_multiples': return (q.reponses || []).join(' ; ');
    case 'association': return (q.paires || []).map((p) => `${p.gauche} → ${p.droite}`).join(' ; ');
    case 'ordre': return (q.elements || []).join(' → ');
    default: return '';
  }
};

/* Réparation : un appel court (texte seul) pour compléter indice / explication / astuce manquants */
async function repairTips(C, items) {
  const list = items.map(({ q, fields }) => ({ id: q.id, question: q.question, bonne_reponse: plainAnswer(q), a_completer: fields }));
  const body = {
    contents: [{ role: 'user', parts: [{ text: `Voici des questions de révision (niveau ${S.parent.niveau || 'secondaire'}) dont certains champs manquent. Pour chacune, complète UNIQUEMENT les champs listés dans « a_completer » :
- « indice » : une piste qui fait réfléchir sans donner ni éliminer la réponse ;
- « explication » : 1 à 2 phrases sur le pourquoi de la bonne réponse ;
- « astuce » : astuce de pro, moyen mnémotechnique ou truc pour ne plus se tromper (1 phrase courte).
Français du Québec, tutoiement. Réponds en JSON : {"items":[{"id","indice","explication","astuce"}]}.

${JSON.stringify(list)}` }] }],
    generationConfig: {
      responseMimeType: 'application/json', temperature: 0.5, maxOutputTokens: 8192,
      responseSchema: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, indice: { type: 'STRING' }, explication: { type: 'STRING' }, astuce: { type: 'STRING' } }, required: ['id'] } } }, required: ['items'] },
    },
  };
  const j = await withFallback(C, textModelChain(), (model) => geminiFetch(`models/${model}:generateContent`, body, 90000), (m) => setProgress(undefined, m));
  const cand = j.candidates && j.candidates[0];
  const text = cand && cand.content && (cand.content.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const out = JSON.parse(text || '{}').items || [];
  const byId = {};
  out.forEach((x) => { byId[x.id] = x; });
  let fixed = 0;
  items.forEach(({ q, fields }) => {
    const x = byId[q.id];
    if (!x) return;
    fields.forEach((k) => { if (x[k] && String(x[k]).trim()) { q[k] = String(x[k]).trim(); fixed++; } });
  });
  return fixed;
}

const pointsOf = (q) => (q.type === 'situation' ? (q.questions || []).length : 1);

/* Applique les quotas de visuels et prépare les tâches (découpe, SVG, illustration) */
function resolveVisuals(D, C) {
  const quota = visualQuota(C.n, C.illus);
  const used = { figure: 0, svg: 0, illustration: 0 };
  const tasks = [];
  const walk = (o) => {
    const v = o._visuel;
    delete o._visuel;
    if (v) {
      if (v.type === 'figure' && used.figure < quota.figure && Array.isArray(v.zone) && v.zone.length === 4 && v.photo >= 1 && v.photo <= C.photos.length) {
        used.figure++; o.image = `${o.id}-figure.jpg`; tasks.push({ kind: 'figure', name: o.image, photo: v.photo - 1, zone: v.zone, q: o });
      } else if (v.type === 'svg' && used.svg < quota.svg && /^<svg[\s>]/i.test(String(v.svg || '').trim())) {
        used.svg++; o.svg = String(v.svg).trim();
      } else if (v.type === 'illustration' && C.illus && S.parent.imageModel && used.illustration < quota.illustration && v.description) {
        used.illustration++; o.image = `${o.id}-illustration.jpg`; tasks.push({ kind: 'illustration', name: o.image, description: v.description, q: o });
      } else delete o.image_alt;
    }
    (o.questions || []).forEach(walk);
  };
  D.data.questions.forEach(walk);
  D.tasks = tasks;
  genLog(C, `Visuels retenus : ${used.figure} figure(s) du manuel, ${used.svg} schéma(s) SVG, ${used.illustration} illustration(s)`);
}

async function cropFigure(C, t) {
  const p = C.photos[t.photo];
  const im = await loadImageEl(p.dataUrl);
  let [y0, x0, y1, x1] = t.zone.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000);
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 < x0) [x0, x1] = [x1, x0];
  const padY = (y1 - y0) * 0.04 + 0.005, padX = (x1 - x0) * 0.04 + 0.005;
  y0 = Math.max(0, y0 - padY); x0 = Math.max(0, x0 - padX); y1 = Math.min(1, y1 + padY); x1 = Math.min(1, x1 + padX);
  const W = im.naturalWidth, H = im.naturalHeight;
  const sx = x0 * W, sy = y0 * H, sw = (x1 - x0) * W, sh = (y1 - y0) * H;
  if (sw < 40 || sh < 40) throw new Error('zone trop petite');
  if (sw * sh > 0.85 * W * H) throw new Error('zone = page entière');
  const k = Math.min(1, 1200 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

async function generateIllustration(t) {
  const prompt = `Illustration éducative pour un élève de ${S.parent.niveau || 'secondaire'} : ${t.description}. Style : illustration claire, nette et colorée sur fond blanc, format carré, sans texte (sauf légendes indispensables). Ne montre jamais la réponse à une question.`;
  const j = await geminiFetch(`models/${S.parent.imageModel}:generateContent`, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
  }, 120000);
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const img = parts.map((p) => p.inlineData || p.inline_data).find(Boolean);
  if (!img) throw new Error('aucune image renvoyée');
  return toJpeg(`data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.data}`, 1024, 0.86);
}

/* Rafraîchit l'écran de progression (au plus ~3 fois par seconde) */
let progressTimer = null;
function setProgress(step, detail) {
  const C = S.create;
  if (!C || !C.progress) return;
  if (step !== undefined) C.progress.step = step;
  if (detail !== undefined) C.progress.detail = detail;
  if (progressTimer) return;
  progressTimer = setTimeout(() => { progressTimer = null; if (S.view === 'create' && S.create && (S.create.stage === 'gen' || S.create.stage === 'publish')) render(); }, 300);
}

async function generateMission() {
  const C = S.create;
  let matiere = canonicalMatiere(C.matiereNew);
  if (!C.photos.length) { toast('Ajoute au moins une photo.'); return; }
  const batches = planBatches(C);
  C.stage = 'gen'; C.error = ''; C.log = [];
  C.progress = {
    step: 'Gemini rédige les questions…', detail: `${C.photos.length} photo(s) · ${C.n} questions · ${plural(batches.length, 'lot')} en parallèle`, startedAt: Date.now(),
    rows: batches.map((B, i) => ({ label: `Lot ${i + 1}`, info: `${B.n} questions · ${B.focus || 'toutes les pages'}`, state: 'wait', msg: 'en attente' })),
  };
  genLog(C, `Demande : ${C.n} questions, ${C.photos.length} photo(s), ${batches.length} lot(s), modèle ${S.parent.textModel}${C.illus ? ', illustrations activées' : ''}`);
  render(); startTicker(); saveCreateState();
  await keepAwake(true);
  try {
    // 1. Lots en parallèle (ou un à la fois si la clé est limitée en débit)
    Limiter.reset(batches.length);
    const results = await Promise.all(batches.map((B, i) => runBatch(C, matiere, B, C.progress.rows[i])));
    if (S.create !== C) return;
    const raws = results.filter(Boolean);
    // Matière et thème : saisis par le parent, sinon le choix majoritaire des lots
    if (!matiere) { matiere = canonicalMatiere(majority(raws.map((r) => r.matiere))) || 'Divers'; genLog(C, `Matière déduite : ${matiere}`); }
    let theme = themeGiven(C) || majority(raws.map((r) => r.theme)) || 'Général';
    theme = String(theme).trim().slice(0, 80);
    const source = (raws.find((r) => r.source) || {}).source;
    const ids = makeIds(C, matiere);
    const ctx = { matiere, theme, notion: '', page: '', file: 'brouillon' };
    let seq = 0;
    const kept = [], rejected = [];
    const accept = async (list) => {
      const incomplete = [];
      list.forEach((rq) => {
        const q = convertQuestion(rq, `${ids.prefix}-${pad2(++seq)}`, C);
        const { errs, missing } = checkQuestion(q, ctx);
        if (errs.length) rejected.push(`${q.id} écartée : ${errs.join(' ; ')}`);
        else if (missing.length) incomplete.push({ q, missing });
        else kept.push(q);
      });
      if (!incomplete.length) return;
      // Indice / explication / astuce manquants : on les fait compléter plutôt que de jeter la question
      const items = incomplete.flatMap((x) => x.missing);
      setProgress('Gemini complète les indices et astuces…', plural(items.length, 'question'));
      try { const n = await repairTips(C, items); genLog(C, `Réparation : ${n} champ(s) complété(s) sur ${items.reduce((a, x) => a + x.fields.length, 0)}`); }
      catch (e) { genLog(C, `Réparation impossible : ${e.message}`); }
      incomplete.forEach(({ q }) => {
        const { errs, missing } = checkQuestion(q, ctx);
        if (errs.length || missing.length) rejected.push(`${q.id} écartée : ${[...errs, ...missing.map((m) => `${m.q.id} : ${m.fields.join(', ')} manquant(s)`)].join(' ; ')}`);
        else kept.push(q);
      });
    };
    await accept(raws.flatMap((r) => r.questions || []));
    let total = kept.reduce((a, q) => a + pointsOf(q), 0);
    genLog(C, `Contrôle qualité : ${total} question(s) valide(s), ${rejected.length} écartée(s)`);
    rejected.forEach((m) => genLog(C, '  ' + m));

    // 2. Complément automatique s'il en manque
    const missing = C.n - total;
    if (missing > 0) {
      const row = { label: 'Complément', info: `${missing} question(s) manquante(s)`, state: 'wait', msg: '' };
      C.progress.rows.push(row);
      setProgress('Gemini complète les questions manquantes…', `${total} / ${C.n} prêtes`);
      const B = { n: Math.min(missing, 12), photos: C.photos.map((_, i) => i), types: DEFAULT_MIX, situations: 0, focus: 'toutes les pages', avoid: kept.map((q) => q.question || q.titre).filter(Boolean).slice(0, 40) };
      const extra = await runBatch(C, matiere, B, row);
      if (S.create !== C) return;
      if (extra) await accept((extra.questions || []).slice(0, B.n + 2));
      total = kept.reduce((a, q) => a + pointsOf(q), 0);
      genLog(C, `Après complément : ${total} question(s) valide(s)`);
    }
    if (!kept.length) throw new Error('Aucune question valide n\'a été produite. Ouvre « Détails techniques » ci-dessous pour voir pourquoi, puis réessaie.');

    // 3. Ajuste au nombre demandé (on retire d'abord des questions simples en fin de liste)
    while (total > C.n) {
      let idx = -1;
      for (let i = kept.length - 1; i >= 0; i--) if (kept[i].type !== 'situation') { idx = i; break; }
      if (idx < 0) break;
      kept.splice(idx, 1); total--;
    }

    const D = {
      data: {
        format: 'mission-revision/1', matiere, theme,
        titre: C.titre.trim() || undefined, niveau: S.parent.niveau || undefined, source: source || undefined,
        genere: { par: [...new Set(C.progress.rows.map((r) => r.model).filter(Boolean))].join(', ') || S.parent.textModel, le: ids.now.toISOString() },
        questions: kept,
      },
      files: {}, removed: new Set(), warnings: rejected.slice(),
      base: `${slugify(theme).slice(0, 40)}-${ids.day}-${ids.hm}`,
    };
    D.fileName = D.base + '.json';
    if (total < C.n) D.warnings.unshift(`${total} question(s) sur ${C.n} demandées : Gemini n'a pas pu fournir le reste.`);

    // 4. Visuels : découpe des figures, puis illustrations (2 à la fois)
    resolveVisuals(D, C);
    const figs = D.tasks.filter((t) => t.kind === 'figure');
    if (figs.length) setProgress('Découpe des figures du manuel…', plural(figs.length, 'figure'));
    for (const t of figs) {
      try { D.files[t.name] = await cropFigure(C, t); }
      catch (e) { delete t.q.image; delete t.q.image_alt; D.warnings.push(`Figure non découpée (${t.q.id}) : ${e.message}`); }
    }
    const ill = D.tasks.filter((t) => t.kind === 'illustration');
    let done = 0, stop = false;
    const worker = async () => {
      while (ill.length) {
        const t = ill.shift();
        if (stop || S.create !== C) { delete t.q.image; delete t.q.image_alt; continue; }
        try { D.files[t.name] = await withFallback(C, [S.parent.imageModel], () => generateIllustration(t), (m) => setProgress(undefined, m)); }
        catch (e) {
          delete t.q.image; delete t.q.image_alt;
          D.warnings.push(`Illustration non générée (${t.q.id}) : ${e.message}`);
          genLog(C, `Illustration ${t.q.id} : ÉCHEC — ${e.message}`);
          if (e.status === 429 || e.status === 403 || e.status === 404) stop = true;
        }
        setProgress('Création des illustrations…', `${++done} / ${done + ill.length}`);
      }
    };
    if (ill.length) { setProgress('Création des illustrations…', `0 / ${ill.length}`); await Promise.all([worker(), worker()]); }
    if (S.create !== C) return;

    validateDraft(D);
    genLog(C, `Terminé : ${D.items.reduce((a, it) => a + it.points, 0)} question(s) en ${Math.round((Date.now() - C.progress.startedAt) / 1000)} s`);
    C.draft = D; C.stage = 'preview';
  } catch (e) {
    if (S.create !== C) return;
    genLog(C, `ÉCHEC : ${e.message}`);
    C.stage = 'form'; C.error = e.message;
  } finally { stopTicker(); keepAwake(false); saveCreateState(); }
  if (S.view === 'create') { render(); window.scrollTo(0, 0); }
}

/* Valide chaque question avec le même moteur que la Bibliothèque (images comprises) */
function validateDraft(D) {
  const fakeDb = { images: {} };
  Object.keys(D.files).forEach((name) => { fakeDb.images[name.toLowerCase()] = { id: 'local:' + name, name, url: D.files[name], updated: '' }; });
  const ctx = { matiere: D.data.matiere, theme: D.data.theme, notion: '', page: '', file: D.fileName };
  D.items = [];
  const kept = [];
  D.data.questions.forEach((q, i) => {
    const r = normQ(q, ctx, fakeDb, q.id || `Q${i + 1}`, false);
    if (r.item) { kept.push(q); D.items.push(r.item); }
    else D.warnings.push(r.issues.map((x) => x.msg).join(' ; '));
  });
  D.data.questions = kept;
}

/* Empêche l'écran de se mettre en veille pendant la génération (Android, iOS 16.4+) */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* non supporté : sans conséquence */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.create && (S.create.stage === 'gen' || S.create.stage === 'publish')) keepAwake(true);
});

/* ---------- Sauvegarde du formulaire et de l'aperçu (survit à la fermeture de l'app) ---------- */
const IDB = {
  db: null,
  open() {
    if (this.db) return this.db;
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open('mission-revision', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => { const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); });
  },
  get(k) { return this.run('readonly', (st) => st.get(k)).catch(() => null); },
  set(k, v) { return this.run('readwrite', (st) => st.put(v, k)).catch(() => null); },
  del(k) { return this.run('readwrite', (st) => st.delete(k)).catch(() => null); },
};
let saveTimer = null;
function saveCreateState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const C = S.create;
    if (!C) { IDB.del('create'); return; }
    const D = C.draft;
    IDB.set('create', {
      matiereNew: C.matiereNew, theme: C.theme, titre: C.titre, n: C.n, consignes: C.consignes, illus: C.illus, photos: C.photos, log: C.log || [],
      draft: D ? { data: D.data, files: D.files, fileName: D.fileName, base: D.base, removed: [...D.removed], warnings: D.warnings, items: D.items, tasks: [] } : null,
      wasGenerating: C.stage === 'gen',
    });
  }, 300);
}
async function restoreCreateState() {
  const saved = await IDB.get('create');
  if (!saved) return null;
  if (saved.matiere && saved.matiere !== '__new' && !saved.matiereNew) saved.matiereNew = saved.matiere;
  delete saved.matiere;
  const C = Object.assign(newCreate(), saved, { stage: 'form', draft: null, progress: null, error: '' });
  if (saved.draft) { C.draft = Object.assign(saved.draft, { removed: new Set(saved.draft.removed || []) }); C.stage = 'preview'; }
  else if (saved.wasGenerating) C.error = 'La génération a été interrompue (app fermée). Tes photos sont conservées : relance-la.';
  delete C.wasGenerating;
  return C;
}

let ticker = null;
function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    const el = document.getElementById('gen-elapsed');
    if (el && S.create && S.create.progress) el.textContent = Math.round((Date.now() - S.create.progress.startedAt) / 1000) + ' s';
  }, 1000);
}
function stopTicker() { clearInterval(ticker); ticker = null; }

/* ================================ Publication ================================ */
async function publishMission() {
  const C = S.create, D = C.draft;
  const questions = D.data.questions.filter((q, i) => !D.removed.has(i));
  if (!questions.length) { toast('Garde au moins une question.'); return; }
  const data = Object.assign({}, D.data, { questions });
  const used = new Set();
  const collect = (q) => { if (q.image && D.files[q.image]) used.add(q.image); (q.questions || []).forEach(collect); };
  questions.forEach(collect);

  const files = [...used].map((name) => ({ folder: 'images', name, mime: 'image/jpeg', data: b64(D.files[name]) }));
  C.photos.forEach((p, i) => files.push({ folder: `_sources/${D.base}`, name: `photo-${pad2(i + 1)}.jpg`, mime: 'image/jpeg', data: b64(p.dataUrl) }));

  C.stage = 'publish'; C.progress = { step: 'Publication dans Google Drive…', detail: '', startedAt: Date.now() };
  render();
  await keepAwake(true);
  try {
    // Envois par lots (< ~3 Mo) : images d'abord, puis le fichier de questions
    let batch = [], size = 0, sent = 0;
    const flush = async () => {
      if (!batch.length) return;
      await apiPost({ action: 'uploadFiles', admin: S.parent.adminCode, files: batch });
      sent += batch.length; batch = []; size = 0;
      setProgress('Publication dans Google Drive…', `${sent} / ${files.length} fichiers`);
    };
    for (const f of files) {
      if (size + f.data.length > 3e6) await flush();
      batch.push(f); size += f.data.length;
    }
    await flush();
    await apiPost({ action: 'saveMission', admin: S.parent.adminCode, folder: data.matiere, name: D.fileName, content: JSON.stringify(data, null, 2) });
    const n = questions.reduce((a, q) => a + (q.type === 'situation' ? (q.questions || []).length : 1), 0);
    S.create = null; IDB.del('create'); keepAwake(false);
    S.sel[data.matiere + '|||' + data.theme] = true; LS.set('sel', S.sel);
    go('home', true);
    toast(`Mission publiée : ${plural(n, 'question')}`);
    setTimeout(() => showMascot('star', `Nouvelle mission « ${data.theme} » prête au décollage !`, { pos: 'bottom', ms: 3600 }), 400);
    syncCatalog();
  } catch (e) {
    keepAwake(false);
    C.stage = 'preview'; C.error = 'Publication impossible : ' + e.message;
    render();
  }
}

/* ================================ Vues ================================ */
function newCreate() {
  const ms = S.db ? Object.keys(S.db.tree).sort(sortAlpha) : [];
  return { matiereNew: ms.length === 1 ? ms[0] : '', theme: '', titre: '', n: 15, consignes: '', illus: !!S.parent.illus, photos: [], stage: 'form', progress: null, draft: null, error: '' };
}

function viewCreate() {
  const C = S.create;
  if (C.stage === 'gen' || C.stage === 'publish') return viewCreateProgress(C);
  if (C.stage === 'preview') return viewCreatePreview(C);
  const ms = S.db ? Object.keys(S.db.tree).sort(sortAlpha) : [];
  const mat = canonicalMatiere(C.matiereNew);
  const themes = S.db && S.db.tree[mat] ? Object.keys(S.db.tree[mat]).sort(sortAlpha) : [];
  const seg = (k, val, items) => `<div class="seg">${items.map(([v, l]) => `<button class="${String(val) === String(v) ? 'on' : ''}" data-action="c-set" data-k="${k}" data-val="${v}">${l}</button>`).join('')}</div>`;
  return `${topbar('Créer une mission')}
  <section class="page create">
    ${C.error ? `<div class="sync error">${ic('alert')} ${esc(C.error)}</div>${logDetails(C)}` : ''}
    <div class="card form">
      <div class="card-head"><h3>1. Le sujet</h3>${C.photos.length || C.theme || C.titre ? '<button class="link" data-action="c-reset">Tout effacer</button>' : ''}</div>
      <label>Matière (facultatif)<input id="c-mat" data-bind="matiereNew" data-rerender-blur="1" type="text" list="c-mats" autocomplete="off" placeholder="Vide = Gemini la devine" value="${esc(C.matiereNew)}"></label>
      <datalist id="c-mats">${matiereList().map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <label>Thème (facultatif)<input id="c-theme" data-bind="theme" type="text" list="c-themes" placeholder="Vide = Gemini le devine" value="${esc(C.theme)}"></label>
      <datalist id="c-themes">${themes.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <label>Titre (facultatif)<input id="c-titre" data-bind="titre" type="text" placeholder="ex. Évaluation du 12 nov." value="${esc(C.titre)}"></label>
    </div>

    <div class="card">
      <h3>2. Les pages à réviser</h3>
      <div class="photos">
        ${C.photos.map((p, i) => `<div class="photo"><img src="${p.dataUrl}" alt="Photo ${i + 1}"><span class="photo-n">${i + 1}</span><button class="photo-x" data-action="c-photo-del" data-i="${i}" aria-label="Retirer la photo ${i + 1}">${ic('x')}</button></div>`).join('')}
        ${C.photos.length < MAX_PHOTOS ? `<label class="photo add">${C.adding ? `<span class="spin">${ic('sync')}</span>` : ic('camera')}<span>${C.photos.length ? 'Ajouter' : 'Prendre ou choisir des photos'}</span><input class="file-hidden" type="file" accept="image/*" multiple data-change="c-photos"></label>` : ''}
      </div>
      <p class="hint-text">Une photo par page, bien droite et lisible. Jusqu'à ${MAX_PHOTOS} photos.</p>
    </div>

    <div class="card form opts">
      <h3>3. Les réglages</h3>
      <label class="opt-label">Nombre de questions</label>
      ${seg('n', C.n, [[10, '10'], [15, '15'], [20, '20'], [30, '30']])}
      <label>Consignes pour Gemini (facultatif)<textarea id="c-consignes" data-bind="consignes" rows="2" placeholder="ex. Insiste sur les conversions d'unités">${esc(C.consignes)}</textarea></label>
      ${S.parent.imageModel ? `<button class="switch-row" role="switch" aria-checked="${C.illus}" data-action="c-set" data-k="illus" data-val="${!C.illus}">
        <span><strong>Illustrations générées</strong><small>Gemini dessine des images pour certaines questions (clé payante, environ 3 à 7 ¢ par image).</small></span>
        <span class="switch ${C.illus ? 'on' : ''}"><i></i></span>
      </button>` : ''}
    </div>
    <div class="sticky-cta">
      <button class="btn primary xl" data-action="c-generate" ${C.photos.length && !C.adding ? '' : 'disabled'}>${ic('wand')} Générer les questions</button>
    </div>
  </section>`;
}

function viewCreateProgress(C) {
  const p = C.progress || {};
  return `<section class="page prep">
    <div class="prep-rocket">${ic(C.stage === 'publish' ? 'folder' : 'wand')}</div>
    <h1>${esc(p.step || 'Préparation…')}</h1>
    <p class="muted">${esc(p.detail || '')}</p>
    <div class="prep-bar indeterminate"><i></i></div>
    ${p.rows && C.stage === 'gen' ? `<div class="gen-rows">${p.rows.map((r) => `<div class="gen-row ${r.state}">
      <span class="gen-dot">${r.state === 'ok' ? ic('check') : r.state === 'err' ? ic('x') : r.state === 'wait' ? '' : `<span class="spin">${ic('sync')}</span>`}</span>
      <span class="grow"><strong>${esc(r.label)}</strong> <small>${esc(r.info || '')}</small><br><small>${esc(r.msg || '')}</small></span></div>`).join('')}</div>` : ''}
    <p class="small muted"><span id="gen-elapsed">${Math.round((Date.now() - (p.startedAt || Date.now())) / 1000)} s</span> · garde l'app ouverte</p>
    ${C.stage === 'gen' ? '<button class="btn ghost" data-action="c-cancel-gen">Annuler</button>' : ''}
  </section>`;
}

function logDetails(C) {
  return C.log && C.log.length ? `<details class="gen-log"><summary>Détails techniques</summary><pre>${esc(C.log.join('\n'))}</pre>
    <button class="link" data-action="c-copy-log">${ic('copy')} Copier</button></details>` : '';
}

function previewExtras(it) {
  const line = (cls, label, v) => `<div class="pv-x ${cls}${v ? '' : ' missing'}"><b>${label}</b> ${v ? fmt(v) : 'manquant'}</div>`;
  return line('h', 'Indice', it.indice) + line('e', 'Explication', it.explication) + line('t', 'Astuce de pro', it.astuce);
}
function previewAnswer(it) {
  if (it.type === 'situation') return it.subs.map((s, k) => `<div class="pv-sub"><strong>${String.fromCharCode(97 + k)}.</strong> ${fmt(s.text)}<div class="pv-a">${answerText(s)}</div>${previewExtras(s)}</div>`).join('');
  return `<div class="pv-a">${answerText(it)}</div>${previewExtras(it)}`;
}
function previewImg(D, q) {
  if (q.svg) return `<img class="pv-img" alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(/xmlns=/.test(q.svg) ? q.svg : q.svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'))}">`;
  if (q.image && D.files[q.image]) return `<img class="pv-img" alt="" src="${D.files[q.image]}">`;
  return '';
}

function viewCreatePreview(C) {
  const D = C.draft;
  const kept = D.data.questions.filter((q, i) => !D.removed.has(i));
  const nKept = kept.reduce((a, q) => a + (q.type === 'situation' ? (q.questions || []).length : 1), 0);
  const nImg = Object.keys(D.files).length;
  return `${topbar('Aperçu de la mission')}
  <section class="page create">
    ${C.error ? `<div class="sync error">${ic('alert')} ${esc(C.error)}</div>` : ''}
    <div class="card">
      <h3>${esc(D.data.matiere)} › ${esc(D.data.theme)}</h3>
      <p class="small muted">${plural(nKept, 'question')}${nImg ? ` · ${plural(nImg, 'image')}` : ''} · fichier ${esc(D.fileName)}</p>
      ${D.warnings.length ? `<details><summary><b class="amber-t">${plural(D.warnings.length, 'remarque')}</b></summary><ul class="issues">${D.warnings.map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul></details>` : ''}
      <p class="hint-text">Touche « Retirer » pour écarter une question avant de publier.</p>
      ${logDetails(C)}
    </div>
    ${D.data.questions.map((q, i) => {
      const it = D.items[i], off = D.removed.has(i);
      return `<div class="card pv ${off ? 'off' : ''}">
        <div class="pv-head"><span class="tag ghost">${TYPE_LABEL[it.type]}</span>${it.difficulte ? `<span class="tag ghost">${'●'.repeat(it.difficulte)}</span>` : ''}
          <button class="link pv-toggle" data-action="c-toggle-q" data-i="${i}">${off ? `${ic('plus')} Remettre` : `${ic('trash')} Retirer`}</button></div>
        ${it.type === 'situation' ? `<p class="pv-ctx">${it.titre ? `<strong>${esc(it.titre)}.</strong> ` : ''}${fmt(it.contexte)}</p>` : `<p class="pv-q">${fmt(it.text)}</p>`}
        ${previewImg(D, q)}
        ${previewAnswer(it)}
      </div>`;
    }).join('')}
    <div class="sticky-cta">
      <button class="btn primary xl" data-action="c-publish" ${nKept ? '' : 'disabled'}>${ic('check')} Publier ${plural(nKept, 'question')}</button>
      <button class="btn ghost block" data-action="c-back-form">${ic('retry')} Modifier les réglages et régénérer</button>
    </div>
  </section>`;
}

/* ---------- Carte « Mode parent » dans les Réglages ---------- */
function parentSettingsCard() {
  const P = S.parent;
  const text = P.models.filter((n) => !/image|tts|embedding|live|audio/.test(n));
  const imgs = P.models.filter((n) => /image/.test(n));
  const opt = (list, val, none) => (none ? `<option value="">${none}</option>` : '') + list.map((n) => `<option value="${esc(n)}" ${n === val ? 'selected' : ''}>${esc(n)}</option>`).join('');
  return `<div class="card form">
    <h3>${ic('key')} Mode parent : créer des missions</h3>
    <p class="small muted">À configurer sur <strong>ton</strong> téléphone seulement : la clé et le code restent sur cet appareil et ne sont jamais dans le lien d'installation.</p>
    <label>Clé API Gemini<input id="p-gkey" type="password" autocomplete="off" placeholder="AIza…" value="${esc(P.geminiKey)}"></label>
    <label>Code parent<input id="p-admin" type="password" autocomplete="off" placeholder="la valeur de ADMIN_CODE dans le script" value="${esc(P.adminCode)}"></label>
    <label>Niveau scolaire<input id="p-niveau" type="text" value="${esc(P.niveau)}"></label>
    ${P.models.length ? `
      <label>Modèle pour les questions<select data-bind-parent="textModel">${opt(text, P.textModel)}</select></label>
      <label>Modèle pour les illustrations<select data-bind-parent="imageModel">${opt(imgs, P.imageModel, 'Aucun (pas d\'illustrations)')}</select></label>` : ''}
    <button class="btn primary block" data-action="p-test">${ic('check')} Tester et enregistrer</button>
    ${P.textModel ? `<p class="ok-t small">${ic('check')} Prêt : questions avec ${esc(P.textModel)}${P.imageModel ? `, illustrations avec ${esc(P.imageModel)}` : ''}</p>` : ''}
    ${P.geminiKey ? '<button class="btn ghost block" data-action="p-clear">Désactiver le mode parent sur cet appareil</button>' : ''}
  </div>`;
}

/* ================================ Actions ================================ */
VIEWS.create = () => (S.create ? viewCreate() : viewHome());

Object.assign(ACTIONS, {
  'create-open': async () => {
    if (!S.create) S.create = (await restoreCreateState()) || newCreate();
    go('create');
  },
  'c-set': (d) => {
    const C = S.create;
    let v = d.val;
    if (d.k === 'n') v = Number(v);
    if (d.k === 'illus') v = v === 'true';
    C[d.k] = v; render(); saveCreateState();
  },
  'c-photo-del': (d) => { S.create.photos.splice(Number(d.i), 1); render(); saveCreateState(); },
  'c-reset': () => { S.create = newCreate(); IDB.del('create'); render(); window.scrollTo(0, 0); },
  'c-generate': () => generateMission(),
  'c-cancel-gen': () => { const C = S.create; S.create = Object.assign(newCreate(), { matiereNew: C.matiereNew, theme: C.theme, titre: C.titre, n: C.n, consignes: C.consignes, illus: C.illus, photos: C.photos }); stopTicker(); keepAwake(false); render(); saveCreateState(); },
  'c-toggle-q': (d) => { const D = S.create.draft, i = Number(d.i); if (D.removed.has(i)) D.removed.delete(i); else D.removed.add(i); render(); saveCreateState(); },
  'c-back-form': () => { const C = S.create; C.stage = 'form'; C.draft = null; C.error = ''; render(); saveCreateState(); window.scrollTo(0, 0); },
  'c-publish': () => publishMission(),
  'c-copy-log': async () => { try { await navigator.clipboard.writeText((S.create.log || []).join('\n')); toast('Détails copiés'); } catch (e) { toast('Copie impossible'); } },
  'p-test': async () => {
    const P = S.parent;
    P.geminiKey = str(valueOf('p-gkey')); P.adminCode = str(valueOf('p-admin')); P.niveau = str(valueOf('p-niveau')) || P.niveau;
    if (!P.geminiKey || !P.adminCode) { toast('Renseigne la clé Gemini et le code parent.'); return; }
    toast('Vérification…');
    try {
      const names = await listModels();
      P.models = names;
      if (!P.textModel || !names.includes(P.textModel)) P.textModel = pickTextModel(names);
      if (P.imageModel && !names.includes(P.imageModel)) P.imageModel = '';
      if (!P.imageModel) P.imageModel = pickImageModel(names);
      if (!P.textModel) throw new Error('aucun modèle Gemini Flash disponible pour cette clé');
    } catch (e) { saveParent(); render(); toast('Gemini : ' + e.message); return; }
    try { await apiPost({ action: 'checkAdmin', admin: P.adminCode }); }
    catch (e) { saveParent(); render(); toast('Code parent : ' + e.message); return; }
    saveParent(); render(); toast('Mode parent activé !');
  },
  'p-clear': () => {
    S.parent = { geminiKey: '', adminCode: '', niveau: S.parent.niveau, textModel: '', imageModel: '', illus: false, models: [] };
    saveParent(); setValue('p-gkey', ''); setValue('p-admin', ''); render(); toast('Mode parent désactivé sur cet appareil');
  },
});

/* Liaison des champs du formulaire (sans re-rendu pour la saisie de texte) */
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-bind]');
  if (!el || !S.create) return;
  S.create[el.dataset.bind] = el.value;
  saveCreateState();
});
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-bind]');
  if (sel && S.create && (sel.dataset.rerender || sel.dataset.rerenderBlur)) { S.create[sel.dataset.bind] = sel.value; render(); saveCreateState(); return; }
  const ps = e.target.closest('[data-bind-parent]');
  if (ps) { S.parent[ps.dataset.bindParent] = ps.value; saveParent(); render(); return; }
  const inp = e.target.closest('[data-change="c-photos"]');
  if (!inp || !S.create) return;
  const C = S.create;
  const files = [...inp.files].slice(0, MAX_PHOTOS - C.photos.length);
  if (!files.length) return;
  C.adding = true; render();
  for (const f of files) {
    try { C.photos.push(Object.assign({ name: f.name }, await resizeImage(f))); }
    catch (err) { toast('Photo illisible : ' + f.name); }
    if (S.view === 'create') render();
  }
  C.adding = false; render(); saveCreateState();
});
