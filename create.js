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
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(m)) return 'Quota Gemini atteint. Avec une clé gratuite, attends quelques minutes ; les illustrations demandent une clé payante.';
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
    throw new Error(e.name === 'AbortError' ? 'Gemini met trop de temps à répondre. Réessaie avec moins de photos ou de questions.' : 'Connexion à Gemini impossible : ' + e.message);
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* */ }
  if (!r.ok) { const err = new Error(friendlyGeminiError(r.status, j && j.error && j.error.message)); err.status = r.status; err.raw = j && j.error && j.error.message; throw err; }
  return j;
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
    type: { type: 'STRING', enum: ['aucun', 'svg', 'figure', 'illustration'] },
    svg: { type: 'STRING' },
    photo: { type: 'INTEGER' },
    zone: { type: 'ARRAY', items: { type: 'INTEGER' } },
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
const SUB_SCHEMA = { type: 'OBJECT', properties: Q_PROPS, required: ['type', 'question', 'indice', 'explication'] };
const QUESTION_SCHEMA = {
  type: 'OBJECT',
  properties: Object.assign({}, Q_PROPS, {
    type: { type: 'STRING', enum: ['qcm', 'vrai_faux', 'choix_multiples', 'association', 'ordre', 'situation'] },
    titre: { type: 'STRING' },
    contexte: { type: 'STRING' },
    sous_questions: { type: 'ARRAY', items: SUB_SCHEMA },
  }),
  required: ['type', 'question'],
};
const MISSION_SCHEMA = {
  type: 'OBJECT',
  properties: { theme: { type: 'STRING' }, source: { type: 'STRING' }, questions: { type: 'ARRAY', items: QUESTION_SCHEMA } },
  required: ['questions'],
};

/* Thème laissé vide (ou « je ne sais pas ») : Gemini le déduit des pages */
const UNKNOWN_THEME = /^(je ne sais pas|je sais pas|sais pas|\?+|inconnu|aucun|a determiner|-)$/;
const themeGiven = (C) => { const t = C.theme.trim(); return t && !UNKNOWN_THEME.test(loose(t)) ? t : ''; };

function buildPrompt(C, matiere) {
  const illus = C.illus;
  const theme = themeGiven(C);
  const existing = S.db && S.db.tree[matiere] ? Object.keys(S.db.tree[matiere]) : [];
  return `Tu es un enseignant expérimenté qui prépare un élève à une évaluation. À partir des photos de pages de manuel ci-jointes (numérotées Photo 1, Photo 2…), crée des questions de révision.

PARAMÈTRES
- Matière : ${matiere}
- Thème : ${theme || 'non fourni : déduis-le des pages (titre du chapitre ou de la section, 2 à 6 mots) et renvoie-le dans « theme »'}${!theme && existing.length ? `. Thèmes existants dans cette matière : ${existing.map((t) => `« ${t} »`).join(', ')} ; si les pages correspondent à l'un d'eux, reprends exactement ce nom` : ''}
- Niveau : ${S.parent.niveau || 'Secondaire 1 (Québec)'}
- Nombre de questions : ${C.n} (les sous-questions d'une mise en situation comptent chacune pour une)
- Répartition : environ 40 % qcm, 15 % vrai_faux, 15 % choix_multiples, 10 % association, 10 % ordre, et ${C.n >= 12 ? '1 ou 2 mises en situation (type « situation », 2 à 4 sous_questions chacune)' : 'au plus 1 mise en situation'}.
${C.consignes ? `- Consignes particulières du parent : ${C.consignes}\n` : ''}
CONTENU
1. Utilise UNIQUEMENT le contenu des photos. Couvre toutes les notions importantes de toutes les pages, pas seulement la première.
2. Français du Québec, phrases courtes et claires adaptées au niveau. Tutoie l'élève.
3. Difficulté : ~30 % faciles (1), ~50 % moyennes (2), ~20 % difficiles (3) qui demandent d'appliquer ou de raisonner.
4. Distracteurs plausibles (erreurs fréquentes, confusions entre notions voisines, mauvaises unités). Jamais de réponse absurde, ni « toutes ces réponses » / « aucune de ces réponses ».
5. Les options d'une même question ont une longueur et une forme semblables.
6. « indice » : une piste qui fait réfléchir sans donner ni éliminer la réponse. « explication » : 1 à 2 phrases sur le POURQUOI. « astuce » : moyen mnémotechnique court, seulement s'il est utile (sinon chaîne vide).
7. « page » : numéro de page visible sur la photo (chaîne vide si illisible). « notion » : la sous-notion travaillée.
8. Virgule décimale et symboles Unicode (cm³, H₂O, °C, ×, −). Mot clé en gras possible avec **double astérisque**.

FORMAT PAR TYPE
- qcm : exactement 4 « options » et « reponse » = copie EXACTE d'une option.
- vrai_faux : « reponse_vrai » = true ou false. Équilibre vrais et faux ; affirmations fausses crédibles.
- choix_multiples : 5 ou 6 « options » et « reponses » = 2 à 4 copies EXACTES d'options. Question commençant par « Lesquelles… » ou « Coche… ».
- association : « paires » de 3 à 5 {gauche, droite}, éléments de droite tous différents et courts.
- ordre : « elements » (3 à 6) DANS LE BON ORDRE ; le critère d'ordre est précisé dans la question.
- situation : « titre », « contexte » (scénario concret de 2 à 4 phrases contenant les données utiles), « question » = courte consigne générale, et « sous_questions » (2 à 4, de n'importe quel autre type).

VISUELS (champ « visuel », environ 1 question sur 4 ; sinon type « aucun »)
- « figure » : quand une photo contient un schéma, un tableau, un graphique ou une illustration utile à la question. Donne « photo » (numéro de la photo, à partir de 1) et « zone » = [ymin, xmin, ymax, xmax] en coordonnées normalisées de 0 à 1000, cadrée serrée autour de la figure avec ses légendes. La zone ne doit contenir AUCUN texte qui donne la réponse. Préfère ce type quand la figure du manuel existe.
- « svg » : schéma simple dessiné par toi (instrument gradué, figure géométrique, graphique, ligne du temps) : une seule ligne commençant par <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 L H' width='L' height='H'> (L, H ≤ 400), attributs entre apostrophes simples, formes simples, font-family='Arial', texte ≥ 13 px, aucun script. Le schéma doit être EXACT.
${illus
    ? `- « illustration » : image générée par IA pour rendre la question plus concrète (objet, scène, organisme). Donne dans « description » une description visuelle détaillée en français. Au plus 1 question sur 5. L'illustration ne doit jamais être nécessaire pour répondre ni montrer la réponse.`
    : '- N\'utilise JAMAIS le type « illustration ».'}
- Pour tout visuel, « description » contient aussi une phrase qui décrit l'image (texte alternatif).

VÉRIFICATION AVANT DE RÉPONDRE : nombre total de questions, chaque réponse copiée exactement d'une option, aucune erreur scientifique, zones bien cadrées.
« source » : par exemple « Manuel, p. 112-118 ». « theme » : ${theme ? `« ${theme} »` : 'le thème déduit des pages'}.`;
}

/* ================================ Génération ================================ */
async function geminiQuestions(C, matiere) {
  const parts = [{ text: buildPrompt(C, matiere) }];
  C.photos.forEach((p, i) => {
    parts.push({ text: `Photo ${i + 1} :` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64(p.dataUrl) } });
  });
  const body = (schema) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: Object.assign({ responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 32768 }, schema ? { responseSchema: MISSION_SCHEMA } : {}),
  });
  const call = async (model) => {
    C.usedModel = model;
    try { return await geminiFetch(`models/${model}:generateContent`, body(true)); }
    catch (e) {
      // Certains modèles refusent un schéma trop riche : on réessaie avec le JSON simple
      if (e.status === 400 && /schema|response_schema|responseSchema/i.test(e.raw || '')) return geminiFetch(`models/${model}:generateContent`, body(false));
      throw e;
    }
  };
  const j = await withFallback(C, textModelChain(), call, 'Gemini lit les pages et rédige les questions…');
  const cand = j.candidates && j.candidates[0];
  const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini n\'a pas renvoyé de questions' + (cand && cand.finishReason ? ` (${cand.finishReason})` : '') + '. Réessaie.');
  try { return JSON.parse(text); }
  catch (e) {
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a >= 0 && z > a) return JSON.parse(text.slice(a, z + 1));
    throw new Error('Réponse de Gemini illisible. Réessaie.');
  }
}

/* ---------- Résilience : nouvel essai automatique, puis modèle de secours ---------- */
const isTransient = (e) => [500, 502, 503, 504].includes(e.status) || (e.status === 429 && /high demand|overloaded|try again/i.test(e.raw || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Modèle choisi, puis jusqu'à 2 autres modèles Flash disponibles (plus récent d'abord, « lite » en dernier) */
function textModelChain() {
  const main = S.parent.textModel;
  const others = (S.parent.models || [])
    .filter((n) => n !== main && /flash/.test(n) && !/image|tts|live|audio|embedding|preview|exp/.test(n))
    .sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || versionOf(b) - versionOf(a));
  return [main, ...others.slice(0, 2)];
}

async function withFallback(C, models, call, label) {
  const waits = [3, 8, 15];
  let last;
  for (let m = 0; m < models.length; m++) {
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      if (S.create !== C) throw new Error('annulé');
      try {
        if (m || attempt) setProgress(label, `Essai ${attempt + 1} avec ${models[m]}…`);
        return await call(models[m]);
      } catch (e) {
        last = e;
        if (!isTransient(e)) throw e;
        if (attempt < waits.length) {
          for (let t = waits[attempt]; t > 0; t--) {
            if (S.create !== C) throw new Error('annulé');
            setProgress(label, `Gemini est surchargé (${models[m]}). Nouvel essai dans ${t} s…`);
            await sleep(1000);
          }
        }
      }
    }
    if (m + 1 < models.length) setProgress(label, `${models[m]} est indisponible : on passe à ${models[m + 1]}…`);
  }
  throw last;
}

/* Convertit la réponse de Gemini au format de l'app, attribue identifiants et noms de fichiers */
function toMission(raw, C, matiere) {
  const now = new Date();
  const theme = themeGiven(C) || String(raw.theme || '').trim().slice(0, 80) || 'Général';
  const stamp = `${String(now.getFullYear()).slice(2)}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const prefix = slugify(matiere).slice(0, 3) + stamp;
  const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const base = `${slugify(theme).slice(0, 40)}-${day}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const tasks = [];

  const convert = (q, id) => {
    const o = { id, type: q.type };
    ['notion', 'question', 'indice', 'explication', 'astuce', 'page'].forEach((k) => { if (q[k] != null && String(q[k]).trim()) o[k] = String(q[k]).trim(); });
    if (q.difficulte) o.difficulte = Math.max(1, Math.min(3, Number(q.difficulte) || 2));
    switch (q.type) {
      case 'qcm': o.options = q.options || []; o.reponse = q.reponse; break;
      case 'vrai_faux': o.reponse = typeof q.reponse_vrai === 'boolean' ? q.reponse_vrai : toBool(q.reponse); break;
      case 'choix_multiples': o.options = q.options || []; o.reponses = q.reponses || []; break;
      case 'association': o.paires = q.paires || []; break;
      case 'ordre': o.elements = q.elements || []; break;
      case 'situation':
        if (q.titre) o.titre = q.titre;
        o.contexte = [q.contexte, q.question && q.question !== q.contexte ? q.question : ''].filter(Boolean).join('\n');
        delete o.question;
        o.questions = (q.sous_questions || []).map((s, k) => convert(s, id + String.fromCharCode(97 + k)));
        break;
    }
    const v = q.visuel;
    if (v && v.type && v.type !== 'aucun') {
      if (v.description) o.image_alt = String(v.description).slice(0, 300);
      if (v.type === 'svg' && /^<svg[\s>]/i.test(String(v.svg || '').trim())) o.svg = String(v.svg).trim();
      else if (v.type === 'figure' && Array.isArray(v.zone) && v.zone.length === 4 && v.photo >= 1 && v.photo <= C.photos.length) {
        o.image = `${id}-figure.jpg`;
        tasks.push({ kind: 'figure', name: o.image, photo: v.photo - 1, zone: v.zone, q: o });
      } else if (v.type === 'illustration' && C.illus && v.description) {
        o.image = `${id}-illustration.jpg`;
        tasks.push({ kind: 'illustration', name: o.image, description: v.description, q: o });
      }
    }
    return o;
  };

  const questions = (raw.questions || []).map((q, i) => convert(q, `${prefix}-${pad2(i + 1)}`));
  const data = {
    format: 'mission-revision/1', matiere, theme,
    titre: C.titre.trim() || undefined, niveau: S.parent.niveau || undefined,
    source: raw.source || undefined,
    genere: { par: C.usedModel || S.parent.textModel, le: now.toISOString() },
    questions,
  };
  return { data, tasks, files: {}, fileName: base + '.json', base, removed: new Set(), warnings: [] };
}

/* Valide chaque question avec le même moteur que la Bibliothèque ; écarte les invalides */
function validateDraft(D) {
  const fakeDb = { images: {} };
  D.tasks.forEach((t) => { if (D.files[t.name]) fakeDb.images[t.name.toLowerCase()] = { id: 'local:' + t.name, name: t.name, url: D.files[t.name], updated: '' }; });
  const ctx = { matiere: D.data.matiere, theme: D.data.theme, notion: '', page: '', file: D.fileName };
  D.items = [];
  const kept = [];
  D.data.questions.forEach((q, i) => {
    const r = normQ(q, ctx, fakeDb, `Q${i + 1}`, false);
    if (r.item) { kept.push(q); D.items.push(r.item); }
    else D.warnings.push(r.issues.map((x) => x.msg).join(' ; '));
  });
  D.data.questions = kept;
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

function setProgress(step, detail) {
  const C = S.create;
  C.progress = Object.assign(C.progress || {}, { step, detail: detail || '' });
  if (S.view === 'create') render();
}

async function generateMission() {
  const C = S.create;
  const matiere = (C.matiere === '__new' ? C.matiereNew : C.matiere).trim();
  if (!matiere) { toast('Indique la matière.'); return; }
  if (!C.photos.length) { toast('Ajoute au moins une photo.'); return; }
  C.stage = 'gen'; C.error = ''; C.progress = { step: '', detail: '', startedAt: Date.now() };
  setProgress('Gemini lit les pages et rédige les questions…', `${C.photos.length} photo(s) · ${C.n} questions · environ 1 minute`);
  startTicker();
  try {
    const raw = await geminiQuestions(C, matiere);
    if (S.create !== C) return;
    const D = toMission(raw, C, matiere);
    const figs = D.tasks.filter((t) => t.kind === 'figure');
    if (figs.length) setProgress('Découpe des figures du manuel…', plural(figs.length, 'figure'));
    for (const t of figs) {
      try { D.files[t.name] = await cropFigure(C, t); }
      catch (e) { delete t.q.image; D.warnings.push(`Figure non découpée (${t.name}) : ${e.message}`); }
    }
    const ill = D.tasks.filter((t) => t.kind === 'illustration');
    let stopIllus = false;
    for (let k = 0; k < ill.length; k++) {
      const t = ill[k];
      if (stopIllus) { delete t.q.image; continue; }
      setProgress('Création des illustrations…', `${k + 1} / ${ill.length}`);
      try { D.files[t.name] = await withFallback(C, [S.parent.imageModel], () => generateIllustration(t), `Création des illustrations… (${k + 1} / ${ill.length})`); }
      catch (e) {
        delete t.q.image;
        D.warnings.push(`Illustration non générée : ${e.message}`);
        if (e.status === 429 || e.status === 403 || e.status === 404) stopIllus = true;
      }
      if (S.create !== C) return;
    }
    validateDraft(D);
    if (!D.data.questions.length) throw new Error('Aucune question valide n\'a été produite. Réessaie.');
    C.draft = D; C.stage = 'preview';
  } catch (e) {
    if (S.create !== C) return;
    C.stage = 'form'; C.error = e.message;
  } finally { stopTicker(); }
  if (S.view === 'create') { render(); window.scrollTo(0, 0); }
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
    S.create = null;
    S.sel[data.matiere + '|||' + data.theme] = true; LS.set('sel', S.sel);
    go('home', true);
    toast(`Mission publiée : ${plural(n, 'question')}`);
    setTimeout(() => showMascot('star', `Nouvelle mission « ${data.theme} » prête au décollage !`, { pos: 'bottom', ms: 3600 }), 400);
    syncCatalog();
  } catch (e) {
    C.stage = 'preview'; C.error = 'Publication impossible : ' + e.message;
    render();
  }
}

/* ================================ Vues ================================ */
function newCreate() {
  const ms = S.db ? Object.keys(S.db.tree).sort(sortAlpha) : [];
  return { matiere: ms[0] || '__new', matiereNew: '', theme: '', titre: '', n: 15, consignes: '', illus: !!S.parent.illus, photos: [], stage: 'form', progress: null, draft: null, error: '' };
}

function viewCreate() {
  const C = S.create;
  if (C.stage === 'gen' || C.stage === 'publish') return viewCreateProgress(C);
  if (C.stage === 'preview') return viewCreatePreview(C);
  const ms = S.db ? Object.keys(S.db.tree).sort(sortAlpha) : [];
  const themes = C.matiere !== '__new' && S.db && S.db.tree[C.matiere] ? Object.keys(S.db.tree[C.matiere]).sort(sortAlpha) : [];
  const seg = (k, val, items) => `<div class="seg">${items.map(([v, l]) => `<button class="${String(val) === String(v) ? 'on' : ''}" data-action="c-set" data-k="${k}" data-val="${v}">${l}</button>`).join('')}</div>`;
  return `${topbar('Créer une mission')}
  <section class="page create">
    ${C.error ? `<div class="sync error">${ic('alert')} ${esc(C.error)}</div>` : ''}
    <div class="card form">
      <h3>1. Le sujet</h3>
      <label>Matière
        <select data-bind="matiere" data-rerender="1">
          ${ms.map((m) => `<option value="${esc(m)}" ${C.matiere === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          <option value="__new" ${C.matiere === '__new' ? 'selected' : ''}>+ Nouvelle matière…</option>
        </select>
      </label>
      ${C.matiere === '__new' ? `<label>Nom de la nouvelle matière<input id="c-mat" data-bind="matiereNew" type="text" placeholder="ex. Histoire" value="${esc(C.matiereNew)}"></label>` : ''}
      <label>Thème (facultatif)<input id="c-theme" data-bind="theme" type="text" list="c-themes" placeholder="Laisse vide : Gemini le trouvera" value="${esc(C.theme)}"></label>
      <datalist id="c-themes">${themes.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <label>Titre (facultatif)<input id="c-titre" data-bind="titre" type="text" placeholder="ex. Évaluation du 12 novembre" value="${esc(C.titre)}"></label>
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
    <p class="small muted"><span id="gen-elapsed">${Math.round((Date.now() - (p.startedAt || Date.now())) / 1000)} s</span> · garde l'app ouverte</p>
    ${C.stage === 'gen' ? '<button class="btn ghost" data-action="c-cancel-gen">Annuler</button>' : ''}
  </section>`;
}

function previewAnswer(it) {
  if (it.type === 'situation') return it.subs.map((s, k) => `<div class="pv-sub"><strong>${String.fromCharCode(97 + k)}.</strong> ${fmt(s.text)}<div class="pv-a">${answerText(s)}</div></div>`).join('');
  return `<div class="pv-a">${answerText(it)}</div>`;
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
  'create-open': () => { if (!S.create || S.create.stage === 'publish') S.create = newCreate(); go('create'); },
  'c-set': (d) => {
    const C = S.create;
    let v = d.val;
    if (d.k === 'n') v = Number(v);
    if (d.k === 'illus') v = v === 'true';
    C[d.k] = v; render();
  },
  'c-photo-del': (d) => { S.create.photos.splice(Number(d.i), 1); render(); },
  'c-generate': () => generateMission(),
  'c-cancel-gen': () => { const C = S.create; S.create = Object.assign(newCreate(), { matiere: C.matiere, matiereNew: C.matiereNew, theme: C.theme, titre: C.titre, n: C.n, consignes: C.consignes, illus: C.illus, photos: C.photos }); stopTicker(); render(); },
  'c-toggle-q': (d) => { const D = S.create.draft, i = Number(d.i); if (D.removed.has(i)) D.removed.delete(i); else D.removed.add(i); render(); },
  'c-back-form': () => { const C = S.create; C.stage = 'form'; C.draft = null; C.error = ''; render(); window.scrollTo(0, 0); },
  'c-publish': () => publishMission(),
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
});
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-bind]');
  if (sel && S.create && sel.dataset.rerender) { S.create[sel.dataset.bind] = sel.value; render(); return; }
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
  C.adding = false; render();
});
