/* Mission Révision — PWA de quiz alimentée par un dossier Google Drive (via Apps Script) */
'use strict';

const APP_VERSION = '2.2.0';

/* ================================ Stockage local ================================ */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('mr.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('mr.' + k, JSON.stringify(v)); } catch (e) { /* quota / privé */ } },
  del(k) { try { localStorage.removeItem('mr.' + k); } catch (e) { /* */ } },
};

/* ================================ État ================================ */
const S = {
  view: 'home',
  cfg: LS.get('cfg', { api: '', key: '' }),
  raw: LS.get('catalog', null),
  db: null,
  history: LS.get('history', { sessions: [] }),
  pending: LS.get('pending', []),
  sync: { loading: false, msg: '', type: '' },
  sel: LS.get('sel', {}),
  opts: Object.assign({ n: 10, second: true, mode: 'random' }, LS.get('opts', {})),
  quiz: null,
  last: null,
  zoom: null,
  quitArm: false,
  toast: '',
  theme: LS.get('theme', 'auto'),
  // Mode parent (création de missions) : configuré seulement sur le téléphone du parent
  parent: Object.assign({ geminiKey: '', adminCode: '', niveau: 'Secondaire 1 (Québec)', textModel: '', imageModel: '', illus: false, models: [] }, LS.get('parent', {})),
  create: null,
};
const parentReady = () => !!(S.cfg.api && S.parent.geminiKey && S.parent.adminCode && S.parent.textModel);

/* ================================ Thème clair / sombre ================================ */
const THEME_BG = { light: '#f5f6fb', dark: '#0e1220' };
function applyTheme() {
  const root = document.documentElement;
  if (S.theme === 'light' || S.theme === 'dark') root.dataset.theme = S.theme;
  else delete root.dataset.theme;
  // Couleur de la barre du navigateur / de statut
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const add = (content, media) => {
    const m = document.createElement('meta');
    m.name = 'theme-color'; m.content = content;
    if (media) m.media = media;
    document.head.appendChild(m);
  };
  if (S.theme === 'light' || S.theme === 'dark') add(THEME_BG[S.theme]);
  else { add(THEME_BG.light, '(prefers-color-scheme: light)'); add(THEME_BG.dark, '(prefers-color-scheme: dark)'); }
}

const app = document.getElementById('app');

/* ================================ Utilitaires ================================ */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Typographie française : espace insécable avant ! ? ; : » et après « (évite « ! » seul en début de ligne)
const nbsp = (s) => s.replace(/ ([!?;:»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
const fmt = (s) => nbsp(esc(s)).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
const str = (v) => (v == null ? '' : String(v).trim());
const loose = (s) => str(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
const arrStr = (a) => (Array.isArray(a) ? a.map(str).filter(Boolean) : []);
const plural = (n, one, many) => `${n} ${n > 1 ? (many || one + 's') : one}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }
function hash(s) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); }
function toBool(v) { if (typeof v === 'boolean') return v; const s = loose(v); if (['vrai', 'true', 'v', 'oui', '1'].includes(s)) return true; if (['faux', 'false', 'f', 'non', '0'].includes(s)) return false; return null; }
function ago(iso) {
  if (!iso) return 'jamais';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "à l'instant"; if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60); if (h < 24) return `il y a ${h} h`;
  return new Date(iso).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}
const dateFr = (iso) => new Date(iso).toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + new Date(iso).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });

/* ================================ Icônes ================================ */
const ICON = {
  right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  left: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  chart: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  auto: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

/* ================================ Normalisation du catalogue ================================ */
const TYPES = {
  qcm: 'qcm', choix_unique: 'qcm',
  vrai_faux: 'vrai_faux', 'vrai-faux': 'vrai_faux', vf: 'vrai_faux', true_false: 'vrai_faux',
  choix_multiples: 'choix_multiples', 'choix-multiples': 'choix_multiples', multi: 'choix_multiples', qcm_multiple: 'choix_multiples',
  association: 'association', associer: 'association', appariement: 'association',
  ordre: 'ordre', ordonner: 'ordre', classement: 'ordre',
  situation: 'situation', mise_en_situation: 'situation', 'mise-en-situation': 'situation',
};
const TYPE_LABEL = { qcm: 'Choix unique', vrai_faux: 'Vrai ou faux', choix_multiples: 'Plusieurs réponses', association: 'Associer', ordre: 'Remettre en ordre', situation: 'Mise en situation' };

function inferType(q) {
  if (Array.isArray(q.paires)) return 'association';
  if (Array.isArray(q.elements)) return 'ordre';
  if (Array.isArray(q.questions)) return 'situation';
  if (Array.isArray(q.reponses)) return 'choix_multiples';
  if (typeof q.reponse === 'boolean' || (!q.options && toBool(q.reponse) !== null)) return 'vrai_faux';
  return 'qcm';
}

function imageRef(q, db, warn) {
  const alt = str(q.image_alt || q.alt);
  if (q.svg) {
    let s = String(q.svg).trim();
    if (!/^<svg[\s>]/i.test(s)) { warn('le champ svg ne commence pas par <svg'); return null; }
    if (!/xmlns=/.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return { kind: 'svg', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s), alt };
  }
  const name = str(q.image);
  if (!name) return null;
  if (/^(https?:|data:)/i.test(name)) return { kind: 'url', src: name, alt };
  const k = name.toLowerCase();
  const img = db.images[k] || db.images[k.replace(/\.[a-z0-9]+$/, '')];
  if (!img) { warn(`image introuvable « ${name} »`); return { kind: 'missing', name, alt }; }
  return { kind: 'drive', id: img.id, url: img.url || '', v: img.updated || '', name: img.name, alt };
}

function normQ(q, ctx, db, label, isSub) {
  const issues = [];
  let bad = false;
  const err = (m) => { bad = true; issues.push({ level: 'error', msg: `${label} : ${m}` }); };
  const warn = (m) => issues.push({ level: 'warn', msg: `${label} : ${m}` });
  if (!q || typeof q !== 'object' || Array.isArray(q)) { err("n'est pas un objet"); return { issues }; }

  let type = q.type ? TYPES[loose(q.type).replace(/ /g, '_')] : inferType(q);
  if (!type) { err(`type inconnu « ${q.type} »`); return { issues }; }
  if (isSub && type === 'situation') { err('une situation ne peut pas contenir une autre situation'); return { issues }; }

  const it = {
    type, id: str(q.id),
    matiere: str(q.matiere) || ctx.matiere,
    theme: str(q.theme || q.sujet) || ctx.theme,
    notion: str(q.notion || q.section) || ctx.notion || '',
    file: ctx.file,
    text: str(q.question || q.enonce || q.consigne),
    indice: str(q.indice), explication: str(q.explication),
    astuce: str(q.astuce || q.astuce_mnemo),
    page: str(q.page != null ? q.page : q.reference_page) || ctx.page || '',
    difficulte: Number(q.difficulte) || 0,
    img: imageRef(q, db, warn),
  };

  const options = () => {
    const o = arrStr(q.options);
    if (o.length < 2) err('il faut au moins 2 options');
    if (new Set(o).size !== o.length) warn('options en double');
    return o;
  };
  const match = (opts, v) => { const s = str(v); if (opts.includes(s)) return s; return opts.find((o) => loose(o) === loose(s)); };

  switch (type) {
    case 'qcm': {
      it.options = options();
      let rep = q.reponse != null ? q.reponse : q.reponse_correcte;
      if (typeof rep === 'number' && Number.isInteger(rep) && !it.options.includes(String(rep)) && it.options[rep] != null) rep = it.options[rep];
      const m = match(it.options, rep);
      if (!m) err(`la réponse « ${str(rep)} » n'est pas dans les options`);
      it.answer = m;
      break;
    }
    case 'vrai_faux': {
      const b = toBool(q.reponse != null ? q.reponse : q.reponse_correcte);
      if (b === null) err('« reponse » doit valoir true ou false');
      it.answer = b;
      break;
    }
    case 'choix_multiples': {
      it.options = options();
      const reps = arrStr(q.reponses || q.reponses_correctes || (Array.isArray(q.reponse) ? q.reponse : []));
      if (!reps.length) err('« reponses » doit contenir au moins une bonne réponse');
      it.answers = [];
      reps.forEach((r) => { const m = match(it.options, r); if (m) it.answers.push(m); else err(`la réponse « ${r} » n'est pas dans les options`); });
      if (it.answers.length === it.options.length) warn('toutes les options sont de bonnes réponses');
      break;
    }
    case 'association': {
      const pairs = (Array.isArray(q.paires) ? q.paires : []).map((p) => (Array.isArray(p)
        ? { l: str(p[0]), r: str(p[1]) }
        : { l: str(p && (p.gauche != null ? p.gauche : p.terme)), r: str(p && (p.droite != null ? p.droite : p.definition)) }));
      if (pairs.some((p) => !p.l || !p.r)) err('chaque paire doit avoir « gauche » et « droite »');
      if (pairs.length < 2) err('il faut au moins 2 paires');
      if (new Set(pairs.map((p) => p.r)).size !== pairs.length) err('deux éléments de droite sont identiques');
      if (pairs.length > 6) warn('plus de 6 paires : difficile à lire sur téléphone');
      it.pairs = pairs;
      break;
    }
    case 'ordre': {
      it.elements = arrStr(q.elements || q.ordre);
      if (it.elements.length < 2) err('il faut au moins 2 éléments');
      if (new Set(it.elements).size !== it.elements.length) err('éléments en double');
      break;
    }
    case 'situation': {
      it.titre = str(q.titre);
      it.contexte = str(q.contexte || q.mise_en_situation || q.texte);
      if (!it.contexte && !it.img) warn('contexte vide');
      it.subs = [];
      (Array.isArray(q.questions) ? q.questions : []).forEach((s, i) => {
        const r = normQ(s, { ...ctx, matiere: it.matiere, theme: it.theme, notion: it.notion, page: it.page }, db, `${label}.${i + 1}`, true);
        issues.push(...r.issues);
        if (r.item) it.subs.push(r.item);
      });
      if (!it.subs.length) err('aucune sous-question valide');
      break;
    }
  }
  if (type !== 'situation' && !it.text) err('énoncé (« question ») manquant');
  if (type !== 'situation') {
    // Format attendu : indice (seconde chance), explication et astuce de pro pour chaque question
    const miss = [['indice', it.indice], ['explication', it.explication], ['astuce', it.astuce]].filter(([, v]) => !v).map(([k]) => k);
    if (miss.length) warn(`${miss.join(', ')} manquant${miss.length > 1 ? 's' : ''}`);
  }
  if (bad) return { issues };
  it.points = type === 'situation' ? it.subs.length : 1;
  return { item: it, issues };
}

function buildDb(raw) {
  const db = { questions: [], files: [], tree: {}, images: {}, byKey: {}, nImages: 0 };
  (raw.images || []).forEach((img) => {
    db.nImages++;
    const n = img.name.toLowerCase();
    db.images[n] = img;
    const base = n.replace(/\.[a-z0-9]+$/, '');
    if (!db.images[base]) db.images[base] = img;
  });
  (raw.errors || []).forEach((e) => db.files.push({ name: e.name, path: e.path || '', count: 0, titre: '', issues: [{ level: 'error', msg: e.error }] }));

  const assignKey = (it, info) => {
    let k = it.id || 'h' + hash(loose(it.matiere + '|' + it.text + '|' + (it.options || it.elements || '')));
    if (db.byKey[k]) {
      if (it.id) info.issues.push({ level: 'warn', msg: `identifiant en double « ${it.id} » (déjà utilisé dans ${db.byKey[k].file})` });
      k = k + '~' + hash(loose(it.file + it.text));
    }
    it.key = k;
    db.byKey[k] = it;
    (it.subs || []).forEach((s) => assignKey(s, info));
  };

  (raw.files || []).forEach((f) => {
    const info = { name: f.name, path: f.path || '', updated: f.updated, count: 0, titre: '', issues: [] };
    const blocks = Array.isArray(f.data) ? f.data : [f.data];
    blocks.forEach((b, bi) => {
      const where = blocks.length > 1 ? `Bloc ${bi + 1}` : 'Fichier';
      if (!b || typeof b !== 'object') { info.issues.push({ level: 'error', msg: `${where} : contenu invalide` }); return; }
      if (!info.titre) info.titre = str(b.titre);
      if (!Array.isArray(b.questions)) { info.issues.push({ level: 'error', msg: `${where} : champ « questions » manquant` }); return; }
      if (!b.matiere) info.issues.push({ level: 'warn', msg: `${where} : « matiere » manquante` });
      if (!b.theme && !b.sujet) info.issues.push({ level: 'warn', msg: `${where} : « theme » manquant` });
      const ctx = { matiere: str(b.matiere) || 'Sans matière', theme: str(b.theme || b.sujet) || 'Général', notion: '', page: '', file: f.name };
      b.questions.forEach((q, qi) => {
        const label = `Q${qi + 1}` + (q && q.id ? ` (${q.id})` : '');
        const r = normQ(q, ctx, db, label, false);
        info.issues.push(...r.issues);
        if (r.item) { assignKey(r.item, info); db.questions.push(r.item); info.count += r.item.points; }
      });
    });
    db.files.push(info);
  });

  db.questions.forEach((q) => {
    const m = db.tree[q.matiere] || (db.tree[q.matiere] = {});
    const t = m[q.theme] || (m[q.theme] = { count: 0, items: [] });
    t.count += q.points;
    t.items.push(q);
  });
  db.total = db.questions.reduce((a, q) => a + q.points, 0);
  db.nIssues = db.files.reduce((a, f) => a + f.issues.length, 0);
  db.nErrors = db.files.reduce((a, f) => a + f.issues.filter((i) => i.level === 'error').length, 0);
  return db;
}

const stepKeys = (it) => (it.type === 'situation' ? it.subs.map((s) => s.key) : [it.key]);
const sortAlpha = (a, b) => a.localeCompare(b, 'fr');

/* ================================ API Apps Script ================================ */
async function api(action, params = {}) {
  const u = new URL(S.cfg.api);
  u.searchParams.set('action', action);
  if (S.cfg.key) u.searchParams.set('key', S.cfg.key);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString(), { redirect: 'follow' });
  if (!r.ok) throw new Error('erreur réseau ' + r.status);
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('réponse inattendue — le script est-il déployé avec l\'accès « Tout le monde » ?'); }
  if (!j.ok) throw new Error(j.error || 'erreur du script');
  return j;
}
async function apiPost(body) {
  const r = await fetch(S.cfg.api, { method: 'POST', body: JSON.stringify({ ...body, key: S.cfg.key }), redirect: 'follow' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'erreur du script');
  return j;
}

/* ================================ Synchronisation ================================ */
async function loadDemo() {
  const man = await (await fetch('exemples/demo.json')).json();
  const files = []; const errors = [];
  for (const n of man.files) {
    try { files.push({ name: n, path: 'exemples', updated: '', data: await (await fetch('exemples/' + n)).json() }); }
    catch (e) { errors.push({ name: n, path: 'exemples', error: 'JSON invalide : ' + e.message }); }
  }
  const images = (man.images || []).map((n) => ({ id: 'demo:' + n, name: n, url: 'exemples/images/' + n }));
  S.raw = { source: 'demo', folder: 'Exemples intégrés', files, images, errors, syncedAt: new Date().toISOString() };
  S.db = buildDb(S.raw);
}

function mergeHistory(server) {
  const sessions = (server && Array.isArray(server.sessions)) ? server.sessions.slice() : [];
  const ids = new Set(sessions.map((s) => s.id));
  S.pending.forEach((p) => { if (!ids.has(p.id)) sessions.push(p); });
  S.history = { sessions };
  LS.set('history', S.history);
}

async function syncCatalog() {
  if (S.sync.loading) return;
  if (!S.cfg.api) {
    try { await loadDemo(); S.sync = { loading: false, msg: '', type: '' }; }
    catch (e) { S.sync = { loading: false, msg: 'Impossible de charger les exemples : ' + e.message, type: 'error' }; }
    render(); return;
  }
  S.sync = { loading: true, msg: 'Synchronisation avec Google Drive…', type: 'info' };
  render();
  try {
    const cat = await api('catalog');
    const { history, ...rest } = cat;
    S.raw = { ...rest, source: 'drive', syncedAt: new Date().toISOString() };
    LS.set('catalog', S.raw);
    mergeHistory(history);
    S.db = buildDb(S.raw);
    S.sync = { loading: false, msg: '', type: S.db.nErrors ? 'warn' : 'ok' };
    flushPending();
  } catch (e) {
    S.sync = { loading: false, msg: 'Synchronisation impossible : ' + e.message + (S.db ? ' (données en cache utilisées)' : ''), type: 'error' };
  }
  render();
}

async function flushPending() {
  if (!S.cfg.api || !S.pending.length) return;
  try {
    const r = await apiPost({ action: 'saveResults', results: S.pending });
    const saved = new Set(r.saved || []);
    S.pending = S.pending.filter((p) => !saved.has(p.id));
    LS.set('pending', S.pending);
    if (S.last && saved.has(S.last.id)) S.last.saved = 'drive';
    render();
  } catch (e) { /* on réessaiera plus tard */ }
}

/* ================================ Images ================================ */
const IMG_READY = new Map();
const IMG_LOAD = new Map();
const imgKey = (ref) => ref.id + '|' + ref.v;

function loadImage(ref) {
  if (ref.kind === 'svg' || ref.kind === 'url') return Promise.resolve(ref.src);
  if (ref.kind !== 'drive') return Promise.resolve(null);
  if (ref.url) return Promise.resolve(ref.url);
  const k = imgKey(ref);
  if (IMG_READY.has(k)) return Promise.resolve(IMG_READY.get(k));
  if (IMG_LOAD.has(k)) return IMG_LOAD.get(k);
  const p = (async () => {
    const cacheUrl = new URL('__img/' + encodeURIComponent(ref.id) + '?v=' + encodeURIComponent(ref.v), location.href).toString();
    let cache = null;
    try {
      cache = await caches.open('mr-images');
      const hit = await cache.match(cacheUrl);
      if (hit) return URL.createObjectURL(await hit.blob());
    } catch (e) { cache = null; }
    const r = await api('image', { id: ref.id });
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: r.mime || 'image/png' });
    if (cache) { try { await cache.put(cacheUrl, new Response(blob, { headers: { 'Content-Type': blob.type } })); } catch (e) { /* */ } }
    return URL.createObjectURL(blob);
  })();
  IMG_LOAD.set(k, p);
  p.then((src) => { IMG_READY.set(k, src); IMG_LOAD.delete(k); }, () => IMG_LOAD.delete(k));
  return p;
}

function figure(ref, cls = '') {
  if (!ref) return '';
  if (ref.kind === 'missing') {
    return `<div class="fig fig-missing ${cls}">${ic('image')}<div><strong>Image manquante :</strong> ${esc(ref.name)}${ref.alt ? `<br><span>${esc(ref.alt)}</span>` : ''}</div></div>`;
  }
  const direct = ref.kind === 'svg' || ref.kind === 'url' ? ref.src : (ref.url || IMG_READY.get(imgKey(ref)));
  const src = direct ? ` src="${esc(direct)}"` : '';
  const lazy = direct ? '' : ` data-ref="${esc(JSON.stringify(ref))}"`;
  return `<button class="fig ${cls}${direct ? '' : ' loading'}" data-action="zoom" aria-label="Agrandir l'image"><img alt="${esc(ref.alt)}"${src}${lazy}></button>`;
}

function hydrateImages() {
  app.querySelectorAll('img[data-ref]').forEach((el) => {
    const ref = JSON.parse(el.dataset.ref);
    el.removeAttribute('data-ref');
    loadImage(ref).then((src) => {
      if (src) { el.src = src; el.closest('.fig') && el.closest('.fig').classList.remove('loading'); }
    }).catch(() => {
      const box = el.closest('.fig');
      if (box) box.outerHTML = figure({ kind: 'missing', name: ref.name, alt: 'Chargement impossible (hors ligne ?)' });
    });
  });
}

/* ================================ Statistiques ================================ */
function questionStats() {
  const st = {};
  const sessions = S.history.sessions.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  sessions.forEach((s) => (s.details || []).forEach((d) => {
    const x = st[d.q] || (st[d.q] = { n: 0, first: 0, last: '' });
    x.n++;
    if (d.premierEssai) x.first++;
    x.last = d.premierEssai ? 'first' : d.ok ? 'second' : 'fail';
  }));
  return st;
}
const needsReview = (x) => x && x.last !== 'first';

function themeStats(items, st) {
  let total = 0, mastered = 0, review = 0, seen = 0;
  items.forEach((it) => stepKeys(it).forEach((k) => {
    total++;
    const x = st[k];
    if (x) seen++;
    if (x && x.last === 'first') mastered++;
    if (needsReview(x)) review++;
  }));
  return { total, mastered, review, seen };
}

/* ================================ Construction du quiz ================================ */
function selectedItems() {
  const out = [];
  Object.keys(S.sel).forEach((k) => {
    if (!S.sel[k]) return;
    const [m, t] = k.split('|||');
    const node = S.db.tree[m] && S.db.tree[m][t];
    if (node) out.push(...node.items);
  });
  return out;
}

/*
 * Mélange anti-mémorisation : les propositions sont mélangées à chaque quiz, et on évite
 * de reproduire la disposition de la fois précédente (pour un QCM, la bonne réponse
 * change de place) afin qu'on ne puisse pas retenir « c'était la 2ᵉ case ».
 */
const LAYOUT = LS.get('layout', {});
function shuffleAway(arr, key, avoid) {
  const prev = LAYOUT[key];
  const sig = (o) => o.join('\u0001');
  let o = shuffle(arr);
  for (let guard = 0; guard < 25 && arr.length > 1; guard++) {
    const same = prev && sig(o) === prev.sig;
    const samePos = prev && avoid != null && arr.length > 2 && o.indexOf(avoid) === prev.pos;
    const original = avoid === undefined && sig(o) === sig(arr); // pour l'ordre : jamais déjà trié
    if (!same && !samePos && !original) break;
    o = shuffle(arr);
  }
  LAYOUT[key] = { sig: sig(o), pos: avoid != null ? o.indexOf(avoid) : -1 };
  return o;
}

function prepStep(item, sit) {
  const s = { item, sit, key: item.key };
  if (item.type === 'qcm') s.options = shuffleAway(item.options, item.key, item.answer);
  if (item.type === 'choix_multiples') s.options = shuffleAway(item.options, item.key, null);
  if (item.type === 'vrai_faux') s.options = ['Vrai', 'Faux'];
  if (item.type === 'association') s.rights = shuffleAway(item.pairs.map((p) => p.r), item.key, null);
  if (item.type === 'ordre') s.order0 = shuffleAway(item.elements, item.key, undefined);
  return s;
}

function buildSteps(items, n, onlyKeys) {
  const steps = [];
  for (const it of items) {
    if (n !== 'all' && steps.length >= Number(n)) break;
    if (it.type === 'situation') {
      const subs = onlyKeys ? it.subs.filter((s) => onlyKeys.has(s.key)) : it.subs;
      subs.forEach((s, i) => steps.push(prepStep(s, { titre: it.titre, contexte: it.contexte, img: it.img, idx: i + 1, total: subs.length })));
    } else if (!onlyKeys || onlyKeys.has(it.key)) {
      steps.push(prepStep(it, null));
    }
  }
  const keys = Object.keys(LAYOUT);
  if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete LAYOUT[k]);
  LS.set('layout', LAYOUT);
  return steps;
}

function orderItems(pool, mode) {
  if (mode === 'random') return shuffle(pool);
  const st = questionStats();
  const weight = (it) => Math.max(...stepKeys(it).map((k) => {
    const x = st[k];
    if (!x) return 3;                       // jamais vue
    if (x.last === 'first') return x.first >= 2 ? 0.4 : 0.8; // maîtrisée
    return 5;                               // ratée ou réussie au 2e essai
  }));
  return pool.map((it) => ({ it, r: Math.pow(Math.random(), 1 / weight(it)) })).sort((a, b) => b.r - a.r).map((x) => x.it);
}

function startQuiz({ items, n, mode, onlyKeys, label }) {
  const steps = buildSteps(items, n, onlyKeys);
  if (!steps.length) { toast('Aucune question ne correspond à ta sélection.'); return; }
  const a0 = freshAnswer(steps[0]);
  S.quiz = {
    steps, i: 0, vi: 0, score: 0, second: 0, log: [], mode, label,
    themes: [...new Set(steps.map((s) => s.item.matiere + ' › ' + s.item.theme))],
    a: a0, answers: [a0],
    streak: 0, wrongStreak: 0,
  };
  S.quitArm = false;
  prepareAndLaunch(S.quiz);
}

/* Préchargement des images de la mission avant le décollage */
function quizImageRefs(steps) {
  const refs = [], seen = new Set();
  steps.forEach((s) => [s.item.img, s.sit && s.sit.img].forEach((r) => {
    if (!r || r.kind === 'missing' || r.kind === 'svg') return;
    const k = r.kind === 'drive' && !r.url ? imgKey(r) : (r.src || r.url);
    if (seen.has(k)) return;
    seen.add(k); refs.push(r);
  }));
  return refs;
}
const decodeImg = (src) => new Promise((res) => {
  const im = new Image();
  im.onload = im.onerror = () => res();
  im.src = src;
  if (im.decode) im.decode().then(res, res);
});
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), ms))]);

async function preloadImages(refs, onProgress) {
  let done = 0;
  const queue = refs.slice();
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try { const src = await withTimeout(loadImage(r), 25000); if (src) await withTimeout(decodeImg(src), 8000); } catch (e) { /* l'image sera signalée à l'affichage */ }
      onProgress(++done, refs.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

async function prepareAndLaunch(Q) {
  const refs = quizImageRefs(Q.steps);
  const pending = refs.filter((r) => !(r.kind === 'drive' && !r.url && IMG_READY.has(imgKey(r))));
  if (pending.length) {
    S.prep = { done: 0, total: pending.length, quiz: Q, cancelled: false };
    // L'écran de préparation n'apparaît que si le chargement prend plus d'un instant
    const showTimer = setTimeout(() => { if (S.prep && S.prep.quiz === Q && !S.prep.cancelled) go('prep'); }, 250);
    await preloadImages(pending, (done, total) => {
      if (!S.prep || S.prep.quiz !== Q) return;
      S.prep.done = done; S.prep.total = total;
      if (S.view === 'prep') render();
    });
    clearTimeout(showTimer);
    const cancelled = !S.prep || S.prep.quiz !== Q || S.prep.cancelled;
    S.prep = null;
    if (cancelled || S.quiz !== Q) return;
  }
  Q.startedAt = Date.now();
  go('quiz', S.view === 'prep');
  setTimeout(() => showMascot('happy', pick(MSG.start, 'start').replace('{n}', plural(Q.steps.length, 'question'))), 350);
}

function viewPrep() {
  const p = S.prep || { done: 0, total: 1 };
  const pct = Math.round(100 * p.done / Math.max(1, p.total));
  return `<section class="page prep">
    <div class="prep-rocket">${ic('rocket')}</div>
    <h1>Préparation du décollage…</h1>
    <p class="muted">Chargement des images : ${p.done} / ${p.total}</p>
    <div class="prep-bar"><i style="width:${pct}%"></i></div>
    <button class="btn ghost" data-action="cancel-prep">Annuler</button>
  </section>`;
}

/* La question affichée est-elle la question en cours (et non une question précédente revue) ? */
const atCurrent = () => S.quiz && S.quiz.vi === S.quiz.i;

function freshAnswer(step) {
  return { tries: 0, done: false, ok: null, retry: false, failed: [], sel: [], pairs: {}, order: step.order0 ? step.order0.slice() : [], wrongInfo: '', title: '', hintTitle: '' };
}

function launchFromSetup() {
  let pool = selectedItems();
  if (!pool.length) { toast('Coche au moins un thème.'); return; }
  let onlyKeys = null;
  if (S.opts.mode === 'errors') {
    const st = questionStats();
    onlyKeys = new Set();
    pool.forEach((it) => stepKeys(it).forEach((k) => { if (needsReview(st[k])) onlyKeys.add(k); }));
    pool = pool.filter((it) => stepKeys(it).some((k) => onlyKeys.has(k)));
    if (!pool.length) { toast('Aucune erreur à revoir dans ces thèmes. Bravo !'); return; }
  }
  startQuiz({ items: orderItems(pool, S.opts.mode === 'errors' ? 'weak' : S.opts.mode), n: S.opts.n, mode: S.opts.mode, onlyKeys });
}

function launchReviewAll() {
  const st = questionStats();
  const onlyKeys = new Set();
  S.db.questions.forEach((it) => stepKeys(it).forEach((k) => { if (needsReview(st[k])) onlyKeys.add(k); }));
  const pool = S.db.questions.filter((it) => stepKeys(it).some((k) => onlyKeys.has(k)));
  startQuiz({ items: orderItems(pool, 'weak'), n: S.opts.n, mode: 'errors', onlyKeys });
}

/* ================================ Correction ================================ */
function evaluate(step, a) {
  const it = step.item;
  switch (it.type) {
    case 'choix_multiples': {
      const sel = new Set(a.sel);
      const missing = it.answers.filter((x) => !sel.has(x)).length;
      const extra = a.sel.filter((x) => !it.answers.includes(x)).length;
      const ok = !missing && !extra;
      let info = '';
      if (!ok) info = extra && missing ? 'Certaines cases cochées sont fausses et il en manque.' : extra ? 'Tu as coché au moins une réponse de trop.' : `Il manque ${plural(missing, 'bonne réponse', 'bonnes réponses')}.`;
      return { ok, info };
    }
    case 'association': {
      const wrong = it.pairs.filter((p, i) => a.pairs[i] !== p.r).length;
      return { ok: wrong === 0, info: wrong ? `${plural(wrong, 'association est incorrecte', 'associations sont incorrectes')}.` : '' };
    }
    case 'ordre': {
      const wrong = a.order.filter((x, i) => x !== it.elements[i]).length;
      return { ok: wrong === 0, info: wrong ? `${plural(wrong, 'élément est mal placé', 'éléments sont mal placés')}.` : '' };
    }
    default: return { ok: false, info: '' };
  }
}

function submit(ok, info) {
  const Q = S.quiz, a = Q.a, step = Q.steps[Q.i];
  a.tries++;
  if (ok) { a.done = true; a.ok = true; a.retry = false; }
  else if (S.opts.second && a.tries === 1) { a.retry = true; a.wrongInfo = info || ''; a.hintTitle = pick(MSG.retry, 'retry'); }
  else { a.done = true; a.ok = false; a.retry = false; }
  let mascot = null, sparkle = false;
  if (a.done) {
    const first = a.ok && a.tries === 1;
    Q.log.push({ q: step.key, ok: a.ok, premierEssai: first, essais: a.tries });
    if (first) { Q.score++; S.bump = true; } else if (a.ok) Q.second++;
    a.title = pick(first ? MSG.first : a.ok ? MSG.second : MSG.wrong, first ? 'first' : a.ok ? 'second' : 'wrong');
    // Séries et moments clés
    if (first) {
      Q.streak++; Q.wrongStreak = 0;
      const s = Q.streak;
      if (s === 3) mascot = ['proud', pick(MSG.streak3, 's3')];
      else if (s === 5) mascot = ['star', pick(MSG.streak5, 's5')];
      else if (s >= 8 && s % 4 === 0) mascot = ['star', pick(MSG.streakBig, 'sb').replace('{s}', s)];
      sparkle = !!mascot || chance(0.22);
    } else {
      Q.streak = 0;
      if (a.ok) Q.wrongStreak = 0;
      else if (++Q.wrongStreak === 2 || (Q.wrongStreak > 2 && chance(0.4))) mascot = ['encourage', pick(MSG.twoWrong, 'tw')];
    }
  }
  S.flash = true;
  render();
  requestAnimationFrame(() => {
    const el = document.querySelector(a.done ? '.feedback' : '.hint');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (sparkle) {
      const good = document.querySelector('.answer.good, .pair.good, .order li.good, .feedback h3');
      if (good) burstFrom(good, mascot ? 60 : 26);
    }
  });
  if (mascot) setTimeout(() => showMascot(mascot[0], mascot[1]), 250);
}

function finishQuiz() {
  const Q = S.quiz;
  const total = Q.log.length;
  const session = {
    id: uid(), date: new Date().toISOString(), duree: Math.round((Date.now() - Q.startedAt) / 1000),
    mode: Q.mode, secondeChance: !!S.opts.second, themes: Q.themes,
    score: Q.score, secondEssai: Q.second, total, details: Q.log, app: APP_VERSION,
  };
  Q.finished = true;
  S.history.sessions.push(session);
  LS.set('history', S.history);
  const pct = total ? Math.round(100 * Q.score / total) : 0;
  const tier = pct === 100 ? 'perfect' : pct >= 80 ? 'great' : pct >= 60 ? 'good' : 'low';
  S.last = { ...session, saved: S.cfg.api ? 'pending' : 'local', pct, tier, msg: pick(MSG.results[tier], 'res' + tier) };
  S.celebrate = true;
  if (S.cfg.api) { S.pending.push(session); LS.set('pending', S.pending); flushPending(); }
  go('results', true);
}

function answerText(it) {
  switch (it.type) {
    case 'qcm': return esc(it.answer);
    case 'vrai_faux': return it.answer ? 'Vrai' : 'Faux';
    case 'choix_multiples': return it.answers.map(esc).join(' · ');
    case 'association': return it.pairs.map((p) => `${esc(p.l)} → ${esc(p.r)}`).join('<br>');
    case 'ordre': return it.elements.map((e, i) => `${i + 1}. ${esc(e)}`).join('<br>');
    default: return '';
  }
}

/* ================================ Effets : messages, mascotte, confettis ================================ */
const chance = (p) => Math.random() < p;
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const lastPick = {};
function pick(pool, key) {
  if (pool.length < 2) return pool[0];
  let x;
  do { x = pool[Math.floor(Math.random() * pool.length)]; } while (x === lastPick[key]);
  lastPick[key] = x;
  return x;
}

const MSG = {
  start: ['Décollage ! {n} au programme.', "C'est parti pour {n} !", 'Moteurs allumés : {n} à franchir.', 'Mission lancée. Concentration maximale !', '{n}, on y va tranquille.'],
  first: ['Excellente réponse !', 'Exactement !', 'Bien vu !', 'Parfait !', 'Dans le mille !', 'Impeccable !', 'Tout juste !', "Bravo, c'est ça !", 'Solide !', 'Rien à redire !', 'Pile-poil !', 'Joli coup !', 'Yes !', 'Bonne réponse !'],
  second: ['Bien joué, au deuxième essai !', 'Rattrapé de justesse !', "L'indice a fait son effet !", 'Deuxième essai réussi !', 'Bien récupéré !', 'Et voilà, trouvé !'],
  wrong: ['Pas cette fois…', 'Raté, mais tu vas la retenir !', 'Pas tout à fait…', "Presque ! Lis bien l'explication.", 'Celle-là, on la garde pour la prochaine fois.', 'Oups ! Pas grave.'],
  retry: ['Pas tout à fait… deuxième chance !', 'Hmm, pas encore. Un petit indice ?', 'Presque ! Essaie encore.', 'Pas cette réponse-là. Voici un coup de pouce :', 'Pas loin ! Relis avec cet indice :'],
  streak3: ["3 d'affilée ! Tu es lancé.", 'Trois sur trois, rien ne t\'arrête !', 'Belle série !', 'Ça tourne à plein régime !'],
  streak5: ["5 d'affilée ! En orbite !", 'Cinq de suite, impressionnant !', 'Série de 5 ! Tu maîtrises.'],
  streakBig: ['Série de {s} ! Inarrêtable.', "{s} d'affilée… record en vue ?", '{s} de suite, la classe !'],
  twoWrong: ['Pas grave : chaque erreur, c\'est une notion de plus à retenir.', 'On respire et on relit bien la question.', "Les erreurs font partie de l'entraînement !", 'Courage, la prochaine est pour toi.'],
  half: ['Mi-parcours ! Continue comme ça.', 'Déjà la moitié !', 'La moitié est faite, garde le rythme.'],
  last: ['Dernière question, on termine en beauté !', 'Ultime question !', 'Plus qu\'une !'],
  results: {
    perfect: ['Sans faute ! Tu maîtrises le sujet sur le bout des doigts.', 'Score parfait ! Rien ne t\'échappe.', '100 % ! Mission accomplie haut la main.', 'Perfection totale. Respect !'],
    great: ["Excellent travail, tu es prêt pour l'évaluation !", 'Très solide ! Encore un petit effort sur les questions ci-dessous.', 'Superbe mission ! Tu y es presque.', 'Bravo, tu connais bien ta matière !'],
    good: ['Bon effort ! Revois les questions ci-dessous et ce sera parfait.', 'Pas mal du tout ! Quelques notions à consolider.', 'Tu progresses ! Refais les questions ratées pour ancrer.', 'Bonne base, on peaufine le reste ?'],
    low: ["Ne lâche pas : la répétition, c'est la clé de la mémoire.", 'Chaque mission te fait progresser. On réessaie ?', 'Relis les explications ci-dessous, puis retente ta chance.', 'Ce n\'est qu\'un entraînement : maintenant tu sais quoi revoir !'],
  },
  hello: ['Prêt pour une petite mission ?', 'Salut ! On révise un peu ?', 'Quelques questions pour garder la forme ?', 'Ton cerveau est prêt au décollage ?'],
  morning: ['Bon matin ! Une mission pour bien commencer ?'],
  evening: ['Une petite mission avant le souper ?', 'Dernière révision de la journée ?'],
};

function greeting() {
  const h = new Date().getHours();
  const st = questionStats();
  let review = 0;
  S.db.questions.forEach((it) => stepKeys(it).forEach((k) => { if (needsReview(st[k])) review++; }));
  const pool = MSG.hello.slice();
  if (h < 11) pool.push(...MSG.morning); else if (h >= 16) pool.push(...MSG.evening);
  if (review) pool.push(`${plural(review, "question t'attend", "questions t'attendent")} dans « Revoir mes erreurs ».`);
  return pick(pool, 'hello');
}

/* --- Mascotte « Comète » (dessin original) --- */
function mascotSVG(mood) {
  const ink = '#7c2d12';
  const openEye = (cx, look) => `<g class="m-eye"><ellipse cx="${cx}" cy="50" rx="6" ry="7.2" fill="#fff"/><circle cx="${cx + 1}" cy="${look ? 47.5 : 51}" r="3.7" fill="#1e1b4b"/><circle cx="${cx + 2.3}" cy="${look ? 46 : 49.5}" r="1.3" fill="#fff"/></g>`;
  const happyEye = (cx) => `<path d="M${cx - 6} 51 Q${cx} 43.5 ${cx + 6} 51" stroke="${ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
  const starEye = (cx) => {
    const pts = [];
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 3.3 : 8, a = -Math.PI / 2 + i * Math.PI / 5; pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (50 + r * Math.sin(a)).toFixed(1)); }
    return `<polygon class="m-star" points="${pts.join(' ')}" fill="#db2777"/>`;
  };
  const bigMouth = `<path d="M62 62 Q72 77 82 62 Z" fill="${ink}"/><ellipse cx="72" cy="69.5" rx="4.5" ry="2.6" fill="#fb7185"/>`;
  let eyes, mouth, extra = '';
  switch (mood) {
    case 'proud': eyes = happyEye(62) + happyEye(82); mouth = bigMouth; break;
    case 'star': eyes = starEye(62) + starEye(82); mouth = bigMouth; extra = '<path class="m-spark" d="M101 18l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#fde047"/>'; break;
    case 'encourage':
      eyes = openEye(62, true) + openEye(82, true);
      mouth = `<path d="M66 65 Q72 69.5 78 65" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      extra = `<path d="M56 39.5 Q62 36 68 39.5 M76 39.5 Q82 36 88 39.5" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
      break;
    default: eyes = openEye(62) + openEye(82); mouth = `<path d="M63 63.5 Q72 72 81 63.5" stroke="${ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
  }
  return `<svg class="mascot" viewBox="0 0 120 100" aria-hidden="true">
    <defs>
      <radialGradient id="mg-body" cx=".38" cy=".33" r=".78"><stop offset="0" stop-color="#fff7c2"/><stop offset=".55" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/></radialGradient>
      <linearGradient id="mg-tail" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></linearGradient>
    </defs>
    <g class="m-tail" stroke="url(#mg-tail)" stroke-linecap="round" fill="none">
      <path d="M46 40 Q26 30 6 33" stroke-width="9"/><path d="M42 54 Q22 54 2 60" stroke-width="11"/><path d="M47 68 Q29 77 12 87" stroke-width="8"/>
    </g>
    <circle cx="72" cy="54" r="32" fill="url(#mg-body)"/>
    <ellipse cx="60" cy="38" rx="9" ry="5" fill="#fff" opacity=".45" transform="rotate(-25 60 38)"/>
    <ellipse cx="54" cy="61" rx="5" ry="3" fill="#fb7185" opacity=".45"/><ellipse cx="90" cy="61" rx="5" ry="3" fill="#fb7185" opacity=".45"/>
    ${eyes}${mouth}${extra}
  </svg>`;
}

let fxRoot = null, mascotTimer = null;
function fxLayer() {
  if (!fxRoot) { fxRoot = document.createElement('div'); fxRoot.id = 'fx'; document.body.appendChild(fxRoot); }
  return fxRoot;
}
function hideMascot(now) {
  clearTimeout(mascotTimer);
  if (!fxRoot) return;
  fxRoot.querySelectorAll('.mascot-pop').forEach((el) => {
    if (now) el.remove();
    else { el.classList.add('out'); setTimeout(() => el.remove(), 350); }
  });
}
function showMascot(mood, text, opts = {}) {
  hideMascot(true);
  const el = document.createElement('div');
  el.className = 'mascot-pop ' + (opts.pos || 'top');
  el.setAttribute('role', 'status');
  el.innerHTML = `${mascotSVG(mood)}<div class="bubble">${fmt(text)}</div>`;
  fxLayer().appendChild(el);
  mascotTimer = setTimeout(() => hideMascot(), opts.ms || 2900);
}

/* --- Confettis (canvas, sans dépendance) --- */
const FX = { canvas: null, ctx: null, parts: [], running: false, w: 0, h: 0 };
const CONFETTI_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#38bdf8', '#fde047'];
function fxCanvas() {
  if (!FX.canvas) {
    FX.canvas = document.createElement('canvas');
    FX.canvas.className = 'confetti';
    fxLayer().appendChild(FX.canvas);
    FX.ctx = FX.canvas.getContext('2d');
  }
  if (FX.w !== window.innerWidth || FX.h !== window.innerHeight) {
    const d = Math.min(2, window.devicePixelRatio || 1);
    FX.w = window.innerWidth; FX.h = window.innerHeight;
    FX.canvas.width = FX.w * d; FX.canvas.height = FX.h * d;
    FX.canvas.style.width = FX.w + 'px'; FX.canvas.style.height = FX.h + 'px';
    FX.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  return FX.ctx;
}
function confetti({ x = 0.5, y = 0.5, count = 80, angle = -90, spread = 70, power = 1 } = {}) {
  if (reduceMotion()) return;
  fxCanvas();
  for (let i = 0; i < count; i++) {
    const a = (angle + (Math.random() - 0.5) * spread) * Math.PI / 180;
    const v = (7 + Math.random() * 7) * power;
    FX.parts.push({
      x: x * FX.w, y: y * FX.h, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, tilt: Math.random() * 6.28, vt: 0.08 + Math.random() * 0.2,
      w: 5 + Math.random() * 5, h: 8 + Math.random() * 7, round: Math.random() < 0.25, t: 0,
      c: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    });
  }
  if (!FX.running) { FX.running = true; requestAnimationFrame(confettiTick); }
}
function confettiTick() {
  const ctx = FX.ctx;
  ctx.clearRect(0, 0, FX.w, FX.h);
  FX.parts = FX.parts.filter((p) => p.y < FX.h + 30 && p.t < 260);
  for (const p of FX.parts) {
    p.t++; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.32;
    p.x += p.vx; p.y += p.vy; p.r += p.vr; p.tilt += p.vt;
    ctx.save();
    ctx.globalAlpha = p.t > 200 ? (260 - p.t) / 60 : 1;
    ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.scale(1, Math.cos(p.tilt));
    ctx.fillStyle = p.c;
    if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, 6.283); ctx.fill(); }
    else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  if (FX.parts.length) requestAnimationFrame(confettiTick);
  else { FX.running = false; ctx.clearRect(0, 0, FX.w, FX.h); }
}
function burstFrom(el, count = 30) {
  const r = el.getBoundingClientRect();
  confetti({ x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight, count, spread: 140, power: 0.55 });
}
function cannons(scale = 1) {
  confetti({ x: 0.02, y: 0.98, angle: -62, spread: 38, count: Math.round(70 * scale), power: 1.6 });
  confetti({ x: 0.98, y: 0.98, angle: -118, spread: 38, count: Math.round(70 * scale), power: 1.6 });
}
function celebrate(tier) {
  if (tier === 'perfect') {
    cannons(1);
    setTimeout(() => confetti({ x: 0.5, y: 0.3, count: 130, spread: 360, power: 0.75 }), 550);
    setTimeout(() => cannons(0.6), 1400);
  } else if (tier === 'great') {
    confetti({ x: 0.5, y: 0.32, count: 110, spread: 110, power: 1 });
    if (chance(0.6)) setTimeout(() => cannons(0.5), 700);
  } else if (tier === 'good') {
    const ring = app.querySelector('.ring');
    if (ring) burstFrom(ring, 40);
  }
}
function countUp(el, target) {
  const t0 = performance.now(), dur = 1000;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))) + '%';
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function afterRender() {
  if (S.view === 'results' && S.celebrate && S.last) {
    S.celebrate = false;
    const el = app.querySelector('[data-count]');
    if (el && !reduceMotion()) countUp(el, Number(el.dataset.count));
    setTimeout(() => celebrate(S.last.tier), 350);
  }
  if (S.view === 'home' && S.db && !S.greeted) {
    S.greeted = true;
    if (chance(0.7)) setTimeout(() => { if (S.view === 'home') showMascot('happy', greeting(), { pos: 'bottom', ms: 3800 }); }, 800);
  }
}

/* ================================ Navigation ================================ */
function go(view, replace) {
  S.view = view;
  S.zoom = null;
  hideMascot(true);
  try { history[replace ? 'replaceState' : 'pushState']({ v: view }, ''); } catch (e) { /* */ }
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', (e) => {
  if (S.zoom) { S.zoom = null; render(); return; }
  if (S.prep) { S.prep.cancelled = true; S.prep = null; S.quiz = null; }
  if (S.view === 'quiz' && S.quiz && !S.quiz.finished) {
    try { history.pushState({ v: 'quiz' }, ''); } catch (err) { /* */ }
    S.quitArm = true; render(); return;
  }
  S.view = (e.state && e.state.v) || 'home';
  if (S.view === 'quiz' || S.view === 'results') S.view = 'home';
  render();
});

let toastTimer = null;
function toast(msg) {
  S.toast = msg; render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = ''; render(); }, 3200);
}

/* ================================ Vues ================================ */
function topbar(title, back = 'home') {
  return `<header class="topbar"><button class="icon-btn" data-action="go" data-v="${back}" aria-label="Retour">${ic('left')}</button><h1>${esc(title)}</h1><span class="spacer"></span></header>`;
}

function syncLine() {
  if (S.sync.loading) return `<div class="sync info"><span class="spin">${ic('sync')}</span> ${esc(S.sync.msg)}</div>`;
  if (S.sync.type === 'error') return `<div class="sync error">${ic('alert')} ${esc(S.sync.msg)}</div>`;
  return '';
}

function viewHome() {
  const db = S.db;
  const demo = !S.cfg.api;
  const st = db ? questionStats() : {};
  let review = 0;
  if (db) db.questions.forEach((it) => stepKeys(it).forEach((k) => { if (needsReview(st[k])) review++; }));
  const nSub = db ? Object.keys(db.tree).length : 0;
  return `
  <section class="home">
    <div class="hero">
      <div class="logo">${ic('rocket')}</div>
      <h1>Mission Révision</h1>
      <p class="muted">${db ? `${plural(db.total, 'question')} · ${plural(nSub, 'matière')}` : 'Chargement des questions…'}</p>
    </div>
    ${demo ? `<div class="banner">${ic('alert')}<div><strong>Mode démo.</strong> Ce sont des questions d'exemple. Connecte ton dossier Google Drive dans <button class="link" data-action="go" data-v="settings">Réglages</button>.</div></div>` : ''}
    ${syncLine()}
    <button class="btn primary xl" data-action="go" data-v="setup" ${db && db.total ? '' : 'disabled'}>${ic('play')} Nouvelle mission</button>
    ${parentReady() ? `<button class="btn create-btn xl" data-action="create-open">${ic('camera')} Créer une mission à partir de photos</button>` : ''}
    ${review ? `<button class="btn warn-btn xl" data-action="review-all">${ic('target')} Revoir mes erreurs <span class="pill">${review}</span></button>` : ''}
    <nav class="tiles">
      <button class="tile" data-action="go" data-v="progress">${ic('chart')}<span>Progression</span></button>
      <button class="tile" data-action="go" data-v="library">${ic('folder')}<span>Bibliothèque</span>${db && db.nIssues ? `<em class="dot ${db.nErrors ? 'red' : 'amber'}"></em>` : ''}</button>
      <button class="tile" data-action="go" data-v="settings">${ic('sliders')}<span>Réglages</span></button>
    </nav>
    <p class="foot muted">${demo ? 'Exemples intégrés' : `Drive synchronisé ${ago(S.raw && S.raw.syncedAt)}`}${S.pending.length ? ` · ${plural(S.pending.length, 'résultat')} en attente d'envoi` : ''}
      ${demo ? '' : `<button class="link" data-action="sync">${ic('sync')} Actualiser</button>`}</p>
  </section>`;
}

function viewSetup() {
  const db = S.db;
  const st = questionStats();
  const matieres = Object.keys(db.tree).sort(sortAlpha);
  const pool = selectedItems();
  const avail = pool.reduce((a, it) => a + it.points, 0);
  let errs = 0;
  pool.forEach((it) => stepKeys(it).forEach((k) => { if (needsReview(st[k])) errs++; }));
  const seg = (name, val, items) => `<div class="seg" role="radiogroup">${items.map(([v, l]) => `<button role="radio" aria-checked="${String(val) === String(v)}" class="${String(val) === String(v) ? 'on' : ''}" data-action="opt" data-k="${name}" data-val="${v}">${l}</button>`).join('')}</div>`;

  return `${topbar('Préparer la mission')}
  <section class="page">
    <h2 class="step-title"><span>1</span> Choisis tes thèmes</h2>
    ${matieres.map((m) => {
      const themes = Object.keys(db.tree[m]).sort(sortAlpha);
      const all = themes.every((t) => S.sel[m + '|||' + t]);
      return `<div class="card subject">
        <div class="subject-head"><h3>${esc(m)}</h3><button class="link" data-action="sel-all" data-m="${esc(m)}">${all ? 'Tout décocher' : 'Tout cocher'}</button></div>
        <div class="themes">${themes.map((t) => {
          const k = m + '|||' + t; const on = !!S.sel[k];
          const ts = themeStats(db.tree[m][t].items, st);
          const pct = ts.total ? Math.round(100 * ts.mastered / ts.total) : 0;
          return `<button class="theme ${on ? 'on' : ''}" role="checkbox" aria-checked="${on}" data-action="sel" data-k="${esc(k)}">
            <span class="box">${on ? ic('check') : ''}</span>
            <span class="theme-body"><strong>${esc(t)}</strong><small>${plural(ts.total, 'question')}${ts.seen ? ` · ${pct}% maîtrisé` : ''}${ts.review ? ` · <b class="amber-t">${ts.review} à revoir</b>` : ''}</small>
            <span class="bar"><i style="width:${pct}%"></i></span></span>
          </button>`;
        }).join('')}</div>
      </div>`;
    }).join('')}

    <h2 class="step-title"><span>2</span> Règle ta mission</h2>
    <div class="card opts">
      <label class="opt-label">Nombre de questions</label>
      ${seg('n', S.opts.n, [[5, '5'], [10, '10'], [20, '20'], ['all', 'Toutes']])}
      <label class="opt-label">Choix des questions</label>
      ${seg('mode', S.opts.mode, [['random', 'Au hasard'], ['weak', 'Points faibles'], ['errors', 'Mes erreurs']])}
      <p class="hint-text">${S.opts.mode === 'random' ? 'Questions tirées au hasard dans les thèmes cochés.' : S.opts.mode === 'weak' ? 'Priorité aux questions ratées et jamais vues.' : 'Seulement les questions ratées ou réussies au 2ᵉ essai la dernière fois.'}</p>
      <button class="switch-row" role="switch" aria-checked="${S.opts.second}" data-action="opt" data-k="second" data-val="${!S.opts.second}">
        <span><strong>Seconde chance</strong><small>En cas d'erreur, un indice s'affiche et tu peux réessayer. Le point ne compte qu'au premier essai.</small></span>
        <span class="switch ${S.opts.second ? 'on' : ''}"><i></i></span>
      </button>
    </div>
    <div class="sticky-cta">
      <button class="btn primary xl" data-action="launch" ${avail ? '' : 'disabled'}>${ic('play')} Lancer la mission</button>
      <p class="muted center small">${avail ? `${plural(avail, 'question disponible', 'questions disponibles')}${errs ? ` · ${errs} à revoir` : ''}` : 'Coche au moins un thème'}</p>
    </div>
  </section>`;
}

function viewQuiz() {
  const Q = S.quiz, vi = Q.vi, step = Q.steps[vi], it = step.item, a = Q.answers[vi];
  const past = vi < Q.i;
  const pct = Math.round(100 * (Q.i + (Q.a.done ? 1 : 0)) / Q.steps.length);
  const sit = step.sit;
  const multiInput = ['choix_multiples', 'association', 'ordre'].includes(it.type);

  let body = '';
  if (it.type === 'qcm' || it.type === 'vrai_faux') body = answersChoice(step, a);
  else if (it.type === 'choix_multiples') body = answersMulti(step, a);
  else if (it.type === 'association') body = answersPairs(step, a);
  else if (it.type === 'ordre') body = answersOrder(step, a);

  const canValidate = it.type === 'choix_multiples' ? a.sel.length > 0 : it.type === 'association' ? it.pairs.every((p, i) => a.pairs[i]) : true;

  return `
  <div class="quiz-top">
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="quiz-bar">
      <button class="icon-btn ${S.quitArm ? 'armed' : ''}" data-action="quit" aria-label="Quitter">${S.quitArm ? '<span class="quit-txt">Quitter ?</span>' : ic('x')}</button>
      <span class="nav-group">
        <button class="icon-btn sm nav" data-action="nav" data-d="-1" ${vi === 0 ? 'disabled' : ''} aria-label="Question précédente">${ic('left')}</button>
        <span class="chip ${past ? 'past' : ''}">${vi + 1} / ${Q.steps.length}</span>
        <button class="icon-btn sm nav" data-action="nav" data-d="1" ${vi >= Q.i ? 'disabled' : ''} aria-label="Question suivante">${ic('right')}</button>
      </span>
      <span class="chip score${S.bump ? ' bump' : ''}">${ic('spark')} ${Q.score}</span>
    </div>
  </div>
  <section class="page quiz">
    ${past ? `<div class="past-banner">${ic('retry')}<span>Tu revois une question déjà répondue.</span><button class="link" data-action="nav-current">Question en cours ${ic('right')}</button></div>` : ''}
    ${sit ? `<div class="card situation">
      <div class="sit-head">${ic('book')} Mise en situation${sit.titre ? ` — ${esc(sit.titre)}` : ''}<span class="chip small">${sit.idx}/${sit.total}</span></div>
      ${sit.contexte ? `<p>${fmt(sit.contexte)}</p>` : ''}
      ${figure(sit.img)}
    </div>` : ''}
    <article class="card question">
      <div class="q-meta"><span class="tag">${esc(it.theme)}</span><span class="tag ghost">${TYPE_LABEL[it.type]}</span></div>
      <h2 class="q-text">${fmt(it.text)}</h2>
      ${figure(it.img)}
      ${a.retry ? `<div class="hint">${ic('bulb')}<div><strong>${fmt(a.hintTitle || 'Pas tout à fait… deuxième chance !')}</strong>${a.wrongInfo ? `<span class="hint-info">${esc(a.wrongInfo)}</span>` : ''}<span>${it.indice ? fmt(it.indice) : 'Relis bien la question et réessaie.'}</span></div></div>` : ''}
      ${body}
      ${multiInput && !a.done ? `<button class="btn primary block" data-action="validate" ${canValidate ? '' : 'disabled'}>${ic('check')} Valider</button>` : ''}
    </article>
    ${a.done ? feedback(step, a, Q, past) : ''}
  </section>`;
}

function answersChoice(step, a) {
  const it = step.item;
  const correct = it.type === 'vrai_faux' ? (it.answer ? 'Vrai' : 'Faux') : it.answer;
  return `<div class="answers ${it.type === 'vrai_faux' ? 'two' : ''}">${step.options.map((o, i) => {
    const failed = a.failed.includes(o);
    let cls = '';
    if (a.done) cls = o === correct ? 'good' : failed ? 'bad' : 'dim';
    else if (failed) cls = 'bad';
    const mark = a.done && o === correct ? ic('check', 'mk') : failed ? ic('x', 'mk') : '';
    return `<button class="answer ${cls}" style="--i:${i}" data-action="choose" data-o="${esc(o)}" ${a.done || failed ? 'disabled' : ''}><span>${fmt(o)}</span>${mark}</button>`;
  }).join('')}</div>`;
}

function answersMulti(step, a) {
  const it = step.item;
  return `<p class="hint-text">Plusieurs réponses possibles — coche toutes les bonnes.</p>
  <div class="answers">${step.options.map((o, i) => {
    const on = a.sel.includes(o), good = it.answers.includes(o);
    let cls = on ? 'on' : '', note = '';
    if (a.done) { cls = good ? (on ? 'good' : 'good missed') : on ? 'bad' : 'dim'; if (good && !on) note = '<em>oubliée</em>'; }
    return `<button class="answer check ${cls}" style="--i:${i}" role="checkbox" aria-checked="${on}" data-action="toggle" data-o="${esc(o)}" ${a.done ? 'disabled' : ''}>
      <span class="box">${on ? ic('check') : ''}</span><span class="grow">${fmt(o)} ${note}</span>${a.done && good ? ic('check', 'mk') : a.done && on ? ic('x', 'mk') : ''}</button>`;
  }).join('')}</div>`;
}

function answersPairs(step, a) {
  const it = step.item;
  return `<div class="pairs">${it.pairs.map((p, i) => {
    const v = a.pairs[i] || '';
    if (a.done) {
      const ok = v === p.r;
      return `<div class="pair ${ok ? 'good' : 'bad'}"><div class="pair-l">${fmt(p.l)}</div>
        <div class="pair-r">${ok ? `${ic('check', 'mk')} ${esc(p.r)}` : `<s>${esc(v || '—')}</s><span class="fix">${ic('right')} ${esc(p.r)}</span>`}</div></div>`;
    }
    return `<label class="pair" style="--i:${i}"><div class="pair-l">${fmt(p.l)}</div>
      <select data-change="pair" data-i="${i}" class="${v ? 'set' : ''}">
        <option value="">Choisir…</option>
        ${step.rights.map((r) => `<option value="${esc(r)}" ${r === v ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select></label>`;
  }).join('')}</div>`;
}

function answersOrder(step, a) {
  const it = step.item;
  if (a.done) {
    return `<ol class="order">${a.order.map((x, i) => {
      const ok = x === it.elements[i];
      return `<li class="${ok ? 'good' : 'bad'}"><span class="num">${i + 1}</span><span class="grow">${fmt(x)}</span>${ok ? ic('check', 'mk') : ic('x', 'mk')}</li>`;
    }).join('')}</ol>
    ${a.ok ? '' : `<p class="label-sm">Le bon ordre :</p><ol class="order solution">${it.elements.map((x, i) => `<li><span class="num">${i + 1}</span><span class="grow">${fmt(x)}</span></li>`).join('')}</ol>`}`;
  }
  return `<p class="hint-text">Fais glisser les éléments avec le doigt pour les remettre dans l'ordre.</p>
  <ol class="order sortable">${a.order.map((x, i) => `<li data-i="${i}" style="--i:${i}"><span class="num">${i + 1}</span><span class="grow">${fmt(x)}</span>
    <span class="grip">${ic('grip')}</span></li>`).join('')}</ol>`;
}

function feedback(step, a, Q, past) {
  const it = step.item;
  const title = fmt(a.title || (a.ok ? 'Excellente réponse !' : 'Pas cette fois…'));
  const last = Q.i + 1 === Q.steps.length;
  const showAnswer = !a.ok && (it.type === 'qcm' || it.type === 'vrai_faux');
  return `<div class="card feedback ${a.ok ? 'ok' : 'ko'}">
    <h3>${a.ok ? ic('check') : ic('x')} ${title}</h3>
    ${showAnswer ? `<p class="answer-line">Bonne réponse : <strong>${answerText(it)}</strong></p>` : ''}
    ${it.explication ? `<p class="expl">${fmt(it.explication)}</p>` : ''}
    ${it.astuce ? `<div class="tip">${ic('spark')}<div><small>Astuce de pro</small><span>${fmt(it.astuce)}</span></div></div>` : ''}
    <div class="fb-foot">
      ${it.page ? `<span class="chip">${ic('book')} Page ${esc(it.page)}</span>` : '<span></span>'}
      ${past
        ? `<button class="btn dark" data-action="nav" data-d="1">${Q.vi + 1 === Q.i ? 'Question en cours' : 'Suivante'} ${ic('right')}</button>`
        : `<button class="btn dark" data-action="next">${last ? 'Voir le bilan' : 'Suivante'} ${ic('right')}</button>`}
    </div>
  </div>`;
}

function viewResults() {
  const r = S.last, Q = S.quiz;
  const pct = r.total ? Math.round(100 * r.score / r.total) : 0;
  const mood = { perfect: 'star', great: 'proud', good: 'happy', low: 'encourage' }[r.tier] || 'happy';
  const tone = pct >= 80 ? 'good' : pct >= 60 ? 'mid' : 'low';
  const missed = Q.steps.filter((s, i) => Q.log[i] && !Q.log[i].premierEssai);
  const saved = r.saved === 'drive' ? `${ic('check')} Résultat enregistré dans Drive` : r.saved === 'pending' ? `${ic('sync')} Enregistrement dans Drive…` : 'Résultat enregistré sur cet appareil (mode démo)';
  return `<section class="page results">
    <h1 class="center">Bilan de mission</h1>
    <div class="ring ${tone}" style="--p:${pct}"><div><strong data-count="${pct}">${pct}%</strong><small>${r.score} / ${r.total}</small></div></div>
    <div class="res-mascot ${mood}">${mascotSVG(mood)}<p class="bubble lead">${fmt(r.msg)}</p></div>
    ${r.secondEssai ? `<p class="center muted">+ ${plural(r.secondEssai, 'question réussie', 'questions réussies')} au 2ᵉ essai</p>` : ''}
    <p class="center small muted save-state">${saved}</p>
    ${missed.length ? `<h2 class="section-title">À revoir</h2>
      <div class="review-list">${missed.map((s) => `<div class="card review">
        ${s.sit ? `<p class="small muted">Mise en situation${s.sit.titre ? ' — ' + esc(s.sit.titre) : ''}</p>` : ''}
        <p class="q">${fmt(s.item.text)}</p>
        <p class="a">${answerText(s.item)}</p>
        ${s.item.page ? `<span class="chip small">${ic('book')} p. ${esc(s.item.page)}</span>` : ''}
      </div>`).join('')}</div>
      <button class="btn warn-btn xl" data-action="redo-missed">${ic('retry')} Refaire ces ${missed.length} questions</button>` : ''}
    <button class="btn primary xl" data-action="go" data-v="setup">${ic('play')} Nouvelle mission</button>
    <button class="btn ghost xl" data-action="go" data-v="home">Accueil</button>
  </section>`;
}

function viewProgress() {
  const st = questionStats();
  const sessions = S.history.sessions.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const all = themeStats(S.db.questions, st);
  const answered = S.history.sessions.reduce((a, s) => a + (s.total || 0), 0);
  return `${topbar('Progression')}
  <section class="page">
    <div class="stats">
      <div class="stat"><strong>${sessions.length}</strong><small>missions</small></div>
      <div class="stat"><strong>${answered}</strong><small>réponses</small></div>
      <div class="stat"><strong>${all.total ? Math.round(100 * all.mastered / all.total) : 0}%</strong><small>maîtrisé</small></div>
    </div>
    ${Object.keys(S.db.tree).sort(sortAlpha).map((m) => `<div class="card">
      <h3>${esc(m)}</h3>
      ${Object.keys(S.db.tree[m]).sort(sortAlpha).map((t) => {
        const ts = themeStats(S.db.tree[m][t].items, st);
        const pM = ts.total ? 100 * ts.mastered / ts.total : 0;
        const pR = ts.total ? 100 * ts.review / ts.total : 0;
        return `<div class="prog-row"><div class="prog-head"><span>${esc(t)}</span><small>${ts.mastered}/${ts.total}${ts.review ? ` · <b class="amber-t">${ts.review} à revoir</b>` : ''}</small></div>
          <div class="bar stacked"><i style="width:${pM}%"></i><i class="amber" style="width:${pR}%"></i></div></div>`;
      }).join('')}
    </div>`).join('')}
    <p class="legend small muted"><i class="lg green"></i> réussie du premier coup la dernière fois <i class="lg amber"></i> à revoir</p>
    <h2 class="section-title">Dernières missions</h2>
    ${sessions.length ? `<div class="card list">${sessions.slice(0, 15).map((s) => {
      const p = s.total ? Math.round(100 * s.score / s.total) : 0;
      return `<div class="row"><div><strong>${dateFr(s.date)}</strong><small>${esc((s.themes || []).join(', '))}</small></div><span class="score-badge ${p >= 80 ? 'good' : p >= 60 ? 'mid' : 'low'}">${p}%</span></div>`;
    }).join('')}</div>` : '<p class="muted center">Aucune mission pour l\'instant.</p>'}
  </section>`;
}

function viewLibrary() {
  const db = S.db, raw = S.raw || {};
  const files = db.files.slice().sort((a, b) => sortAlpha((a.path + '/' + a.name), (b.path + '/' + b.name)));
  return `${topbar('Bibliothèque')}
  <section class="page">
    <div class="card">
      <div class="lib-head"><div><strong>${esc(raw.folder || '—')}</strong><small>${raw.source === 'demo' ? 'Exemples intégrés à l\'app' : `Synchronisé ${ago(raw.syncedAt)}`}</small></div>
      ${raw.source === 'demo' ? '' : `<button class="btn small" data-action="sync" ${S.sync.loading ? 'disabled' : ''}><span class="${S.sync.loading ? 'spin' : ''}">${ic('sync')}</span> Synchroniser</button>`}</div>
      ${syncLine()}
      <div class="stats compact">
        <div class="stat"><strong>${db.files.length}</strong><small>fichiers</small></div>
        <div class="stat"><strong>${db.total}</strong><small>questions</small></div>
        <div class="stat"><strong>${db.nImages}</strong><small>images</small></div>
      </div>
    </div>
    ${files.map((f) => {
      const errs = f.issues.filter((i) => i.level === 'error'), warns = f.issues.filter((i) => i.level === 'warn');
      return `<div class="card file ${errs.length ? 'has-err' : warns.length ? 'has-warn' : ''}">
        <div class="file-head"><div><strong>${esc(f.name)}</strong><small>${esc(f.path || 'racine')}${f.titre ? ' · ' + esc(f.titre) : ''}</small></div><span class="chip">${f.count} Q</span></div>
        ${f.issues.length ? `<details ${errs.length ? 'open' : ''}><summary>${errs.length ? `<b class="red-t">${plural(errs.length, 'erreur')}</b>` : ''}${errs.length && warns.length ? ' · ' : ''}${warns.length ? `<b class="amber-t">${plural(warns.length, 'avertissement')}</b>` : ''}</summary>
          <ul class="issues">${f.issues.map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul></details>` : `<p class="ok-t small">${ic('check')} Aucun problème</p>`}
      </div>`;
    }).join('')}
    <p class="small muted center">Les questions en erreur sont écartées ; le reste du fichier fonctionne.</p>
  </section>`;
}

function viewSettings() {
  const link = S.cfg.api ? `${location.origin}${location.pathname}?api=${encodeURIComponent(S.cfg.api)}${S.cfg.key ? '&key=' + encodeURIComponent(S.cfg.key) : ''}` : '';
  const themes = [['auto', 'Automatique', 'auto'], ['light', 'Clair', 'sun'], ['dark', 'Sombre', 'moon']];
  return `${topbar('Réglages')}
  <section class="page">
    <div class="card">
      <h3>Apparence</h3>
      <div class="seg theme-seg" role="radiogroup">${themes.map(([v, l, i]) => `<button role="radio" aria-checked="${S.theme === v}" class="${S.theme === v ? 'on' : ''}" data-action="theme" data-val="${v}">${ic(i)} ${l}</button>`).join('')}</div>
      <p class="hint-text">« Automatique » suit le réglage clair/sombre du téléphone.</p>
    </div>
    <div class="card form">
      <h3>Connexion au dossier Google Drive</h3>
      <label>URL du script Google Apps Script<input id="f-api" type="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(S.cfg.api)}"></label>
      <label>Clé secrète<input id="f-key" type="text" autocomplete="off" autocapitalize="off" placeholder="la valeur de KEY dans le script" value="${esc(S.cfg.key)}"></label>
      <button class="btn primary block" data-action="save-cfg">${ic('check')} Tester et enregistrer</button>
      ${S.cfg.api ? `<button class="btn ghost block" data-action="demo">Revenir au mode démo</button>` : ''}
    </div>
    ${S.cfg.api && typeof parentSettingsCard === 'function' ? parentSettingsCard() : ''}
    ${link ? `<div class="card">
      <h3>Lien d'installation</h3>
      <p class="small muted">Envoie ce lien sur le téléphone de l'élève : il ouvre l'app déjà connectée. Ensuite, « Partager › Sur l'écran d'accueil » (iPhone) ou « Installer l'application » (Android).</p>
      <div class="copy-row"><code>${esc(link)}</code><button class="icon-btn" data-action="copy" data-t="${esc(link)}" aria-label="Copier">${ic('copy')}</button></div>
    </div>` : ''}
    <div class="card">
      <h3>Cet appareil</h3>
      <p class="small muted">${plural(S.history.sessions.length, 'mission')} dans l'historique${S.pending.length ? ` · ${plural(S.pending.length, 'résultat')} en attente d'envoi` : ''}.</p>
      <button class="btn ghost block" data-action="clear-cache">Vider le cache des images</button>
    </div>
    <p class="small muted center">Mission Révision v${APP_VERSION}</p>
  </section>`;
}

function viewZoom() {
  return S.zoom ? `<div class="zoom" data-action="unzoom"><img src="${esc(S.zoom)}" alt=""><button class="icon-btn" aria-label="Fermer">${ic('x')}</button></div>` : '';
}

/* ================================ Rendu ================================ */
const VIEWS = { prep: viewPrep, home: viewHome, setup: viewSetup, quiz: viewQuiz, results: viewResults, progress: viewProgress, library: viewLibrary, settings: viewSettings };

function render() {
  // Conserver la saisie en cours dans les réglages
  // Conserver la saisie en cours (champs texte) quand on reste sur le même écran
  const keep = {};
  if (app.dataset.view === S.view) app.querySelectorAll('input[id]:not([type=file]):not([type=checkbox]), textarea[id]').forEach((el) => { keep[el.id] = el.value; });
  if ((S.view === 'quiz' && !S.quiz) || (S.view === 'results' && !S.last) || (S.view === 'prep' && !S.prep) || !VIEWS[S.view]) S.view = 'home';
  let html;
  if (S.view === 'settings') html = viewSettings();
  else if (!S.db) html = `<div class="boot">${S.sync.type === 'error' ? `<p>${esc(S.sync.msg)}</p><button class="btn primary" data-action="go" data-v="settings">Réglages</button>` : 'Chargement…'}</div>`;
  else html = VIEWS[S.view]();
  app.innerHTML = html + viewZoom() + (S.toast ? `<div class="toast">${esc(S.toast)}</div>` : '');
  Object.keys(keep).forEach((id) => setValue(id, keep[id]));
  app.classList.toggle('enter', app.dataset.view !== S.view || !!S.enter);
  app.classList.toggle('flash', !!S.flash);
  S.enter = false; S.flash = false; S.bump = false;
  app.dataset.view = S.view;
  hydrateImages();
  afterRender();
}
const valueOf = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

/* ================================ Actions ================================ */
const ACTIONS = {
  go: (d) => {
    if (d.v === 'setup' && !Object.values(S.sel).some(Boolean) && S.db) {
      // Pré-cocher tout s'il n'y a qu'une matière
      const ms = Object.keys(S.db.tree);
      if (ms.length === 1) Object.keys(S.db.tree[ms[0]]).forEach((t) => { S.sel[ms[0] + '|||' + t] = true; });
    }
    go(d.v);
  },
  sync: () => syncCatalog(),
  sel: (d) => {
    S.sel[d.k] = !S.sel[d.k];
    LS.set('sel', S.sel); render();
  },
  'sel-all': (d) => {
    const themes = Object.keys(S.db.tree[d.m] || {});
    const all = themes.every((t) => S.sel[d.m + '|||' + t]);
    themes.forEach((t) => { S.sel[d.m + '|||' + t] = !all; });
    LS.set('sel', S.sel); render();
  },
  opt: (d) => {
    let v = d.val;
    if (d.k === 'second') v = v === 'true';
    else if (d.k === 'n' && v !== 'all') v = Number(v);
    S.opts[d.k] = v; LS.set('opts', S.opts); render();
  },
  theme: (d) => { S.theme = d.val; LS.set('theme', S.theme); applyTheme(); render(); },
  launch: () => launchFromSetup(),
  'review-all': () => launchReviewAll(),
  choose: (d) => {
    if (!atCurrent()) return;
    const Q = S.quiz, step = Q.steps[Q.i], a = Q.a, it = step.item;
    if (a.done || a.failed.includes(d.o)) return;
    const correct = it.type === 'vrai_faux' ? (it.answer ? 'Vrai' : 'Faux') : it.answer;
    if (d.o !== correct) a.failed.push(d.o);
    submit(d.o === correct, '');
  },
  toggle: (d) => {
    if (!atCurrent()) return;
    const a = S.quiz.a; if (a.done) return;
    a.sel = a.sel.includes(d.o) ? a.sel.filter((x) => x !== d.o) : a.sel.concat(d.o);
    render();
  },
  validate: () => {
    if (!atCurrent()) return;
    const Q = S.quiz, r = evaluate(Q.steps[Q.i], Q.a);
    submit(r.ok, r.info);
  },
  next: () => {
    const Q = S.quiz;
    if (!atCurrent()) return;
    if (Q.i + 1 >= Q.steps.length) { finishQuiz(); return; }
    Q.i++; Q.a = freshAnswer(Q.steps[Q.i]); Q.answers[Q.i] = Q.a; Q.vi = Q.i;
    S.quitArm = false; S.enter = true;
    hideMascot();
    render(); window.scrollTo(0, 0);
    const n = Q.steps.length;
    if (Q.i === n - 1 && n >= 5 && chance(0.6)) setTimeout(() => showMascot('happy', pick(MSG.last, 'last')), 300);
    else if (n >= 8 && Q.i === Math.floor(n / 2) && chance(0.5)) setTimeout(() => showMascot('happy', pick(MSG.half, 'half')), 300);
  },
  nav: (d) => {
    const Q = S.quiz;
    const vi = Math.max(0, Math.min(Q.i, Q.vi + Number(d.d)));
    if (vi === Q.vi) return;
    Q.vi = vi; S.enter = true; hideMascot(true);
    render(); window.scrollTo(0, 0);
  },
  'nav-current': () => { const Q = S.quiz; if (Q.vi !== Q.i) { Q.vi = Q.i; S.enter = true; render(); window.scrollTo(0, 0); } },
  'cancel-prep': () => { if (S.prep) S.prep.cancelled = true; S.prep = null; S.quiz = null; go('setup', true); },
  quit: () => {
    if (S.quitArm) { S.quiz = null; S.quitArm = false; go('home', true); return; }
    S.quitArm = true; render();
    setTimeout(() => { if (S.quitArm) { S.quitArm = false; if (S.view === 'quiz') render(); } }, 3000);
  },
  'redo-missed': () => {
    const Q = S.quiz;
    const keys = new Set(Q.steps.filter((s, i) => Q.log[i] && !Q.log[i].premierEssai).map((s) => s.key));
    const seen = new Set();
    const items = [];
    Q.steps.forEach((s) => { if (keys.has(s.key)) { const top = S.db.questions.find((q) => q === s.item || (q.subs && q.subs.includes(s.item))); if (top && !seen.has(top)) { seen.add(top); items.push(top); } } });
    startQuiz({ items: shuffle(items), n: 'all', mode: 'errors', onlyKeys: keys });
  },
  zoom: (d, el) => { const img = el.querySelector('img'); if (img && img.src) { S.zoom = img.src; try { history.pushState({ v: S.view }, ''); } catch (e) { /* */ } render(); } },
  unzoom: () => { S.zoom = null; render(); },
  'save-cfg': async () => {
    const apiUrl = str(valueOf('f-api')), key = str(valueOf('f-key'));
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(apiUrl)) { toast("L'URL doit commencer par https://script.google.com/"); return; }
    const prev = S.cfg;
    S.cfg = { api: apiUrl, key };
    try {
      await api('ping');
      LS.set('cfg', S.cfg);
      toast('Connexion réussie !');
      await syncCatalog();
    } catch (e) {
      S.cfg = prev;
      toast('Échec : ' + e.message);
    }
  },
  demo: async () => { setValue('f-api', ''); setValue('f-key', ''); S.cfg = { api: '', key: '' }; LS.set('cfg', S.cfg); LS.del('catalog'); await loadDemo(); toast('Mode démo activé'); render(); },
  copy: async (d) => { try { await navigator.clipboard.writeText(d.t); toast('Lien copié'); } catch (e) { toast('Copie impossible — sélectionne le lien à la main'); } },
  'clear-cache': async () => { try { await caches.delete('mr-images'); } catch (e) { /* */ } IMG_READY.clear(); toast('Cache des images vidé'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !app.contains(el)) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change="pair"]');
  if (!el || !S.quiz || !atCurrent()) return;
  const a = S.quiz.a, i = Number(el.dataset.i), v = el.value;
  if (a.done) return;
  // Un élément de droite ne peut être utilisé qu'une fois : on libère l'autre ligne
  Object.keys(a.pairs).forEach((k) => { if (Number(k) !== i && a.pairs[k] === v) delete a.pairs[k]; });
  if (v) a.pairs[i] = v; else delete a.pairs[i];
  render();
});

/* ================================ Glisser-déposer (questions « ordre ») ================================ */
let drag = null;

document.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('.order.sortable li');
  if (!li || drag || !S.quiz || !atCurrent() || S.quiz.a.done) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const items = [...li.parentElement.children];
  const rects = items.map((el) => el.getBoundingClientRect());
  const from = items.indexOf(li);
  const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 8;
  drag = {
    li, items, from, to: from, id: e.pointerId, lastY: e.clientY,
    startY: e.clientY + window.scrollY,
    tops: rects.map((r) => r.top + window.scrollY),
    hs: rects.map((r) => r.height),
    step: rects[from].height + gap,
  };
  try { li.setPointerCapture(e.pointerId); } catch (err) { /* */ }
  li.classList.add('dragging');
  li.parentElement.classList.add('is-dragging');
  if (navigator.vibrate) navigator.vibrate(8);
  e.preventDefault();
  requestAnimationFrame(autoScroll);
});

function dragMove(clientY) {
  const d = drag;
  d.lastY = clientY;
  const dy = clientY + window.scrollY - d.startY;
  d.li.style.transform = `translateY(${dy}px)`;
  const center = d.tops[d.from] + d.hs[d.from] / 2 + dy;
  // Position cible = nombre d'autres éléments dont le milieu est au-dessus du centre de l'élément tiré
  let to = 0;
  d.items.forEach((el, i) => { if (i !== d.from && d.tops[i] + d.hs[i] / 2 < center) to++; });
  if (to !== d.to && navigator.vibrate) navigator.vibrate(4);
  d.to = to;
  d.items.forEach((el, i) => {
    if (i === d.from) return;
    let shift = 0;
    if (i > d.from && i <= to) shift = -d.step;
    if (i < d.from && i >= to) shift = d.step;
    el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function autoScroll() {
  if (!drag) return;
  const top = 100, bottom = window.innerHeight - 80;
  let v = 0;
  if (drag.lastY < top) v = -Math.min(14, (top - drag.lastY) / 4);
  else if (drag.lastY > bottom) v = Math.min(14, (drag.lastY - bottom) / 4);
  if (v) { window.scrollBy(0, v); dragMove(drag.lastY); }
  requestAnimationFrame(autoScroll);
}

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  e.preventDefault();
  dragMove(e.clientY);
}, { passive: false });

function dragEnd(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { from, to } = drag;
  drag = null;
  const a = S.quiz && S.quiz.a;
  if (a && !a.done && from !== to) {
    const arr = a.order.slice();
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
    a.order = arr;
  }
  render();
}
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', dragEnd);

window.addEventListener('online', () => { flushPending(); });

/* ================================ Démarrage ================================ */
(function init() {
  applyTheme();
  // Configuration par lien : ?api=…&key=…
  const p = new URLSearchParams(location.search);
  if (p.get('api')) {
    S.cfg = { api: p.get('api'), key: p.get('key') || '' };
    LS.set('cfg', S.cfg);
    LS.del('catalog');
    S.raw = null;
    history.replaceState({ v: 'home' }, '', location.pathname);
  } else {
    history.replaceState({ v: 'home' }, '');
  }
  if (S.cfg.api && S.raw && S.raw.source === 'drive') { try { S.db = buildDb(S.raw); } catch (e) { S.db = null; } }
  render();
  syncCatalog();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* */ });
  }
})();
