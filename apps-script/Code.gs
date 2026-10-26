/**
 * Mission Révision — relais Google Apps Script
 * ------------------------------------------------
 * Lit tous les fichiers .json et Google Docs (questions) et les images d'un dossier Google Drive,
 * et enregistre l'historique des quiz dans ce même dossier (_historique.json).
 *
 * Installation : voir README.md (section « Relais Google Apps Script »).
 */

const CONFIG = {
  // ID du dossier Drive : la partie après /folders/ dans l'URL du dossier.
  FOLDER_ID: 'COLLE_ICI_L_ID_DU_DOSSIER',
  // Clé secrète partagée avec l'app (une suite de lettres/chiffres de ton choix).
  // Laisse vide pour ne pas en utiliser (déconseillé).
  KEY: 'CHANGE_MOI',
  HISTORY_FILE: '_historique.json',
};

const VERSION = '1.0.0';
const MAX_SESSIONS = 5000;

/* ============================ Points d'entrée ============================ */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    checkKey_(p.key);
    switch (p.action || 'catalog') {
      case 'ping':    return json_({ ok: true, app: 'mission-revision', version: VERSION });
      case 'catalog': return json_(getCatalog_());
      case 'image':   return json_(getImage_(p.id));
      default:        throw new Error('Action inconnue : ' + p.action);
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    if (body.action === 'saveResults') return json_(saveResults_(body.results || []));
    throw new Error('Action inconnue : ' + body.action);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ============================ Catalogue ============================ */

function getCatalog_() {
  const root = rootFolder_();
  const files = [];
  const errors = [];
  const images = [];

  walk_(root, '', function (file, path) {
    const name = file.getName();
    const mime = file.getMimeType();
    if (name.charAt(0) === '_') return;

    const isDoc = mime === MimeType.GOOGLE_DOCS;
    if (isDoc || /\.json$/i.test(name) || mime === 'application/json') {
      try {
        const text = isDoc
          ? DocumentApp.openById(file.getId()).getBody().getText()
          : file.getBlob().getDataAsString('UTF-8');
        files.push({
          id: file.getId(), name: name, path: path,
          updated: file.getLastUpdated().toISOString(),
          data: parseLoose_(text),
        });
      } catch (err) {
        errors.push({ name: name, path: path, error: 'JSON invalide : ' + err.message });
      }
    } else if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
      images.push({
        id: file.getId(), name: name, path: path, mime: mime,
        size: file.getSize(), updated: file.getLastUpdated().toISOString(),
      });
    }
  });

  return {
    ok: true, version: VERSION, generatedAt: new Date().toISOString(),
    folder: root.getName(), files: files, errors: errors, images: images,
    history: readHistory_(root).data,
  };
}

function walk_(folder, path, fn) {
  const it = folder.getFiles();
  while (it.hasNext()) fn(it.next(), path);
  const sub = folder.getFolders();
  while (sub.hasNext()) {
    const f = sub.next();
    if (f.getName().charAt(0) === '_') continue;
    walk_(f, path ? path + '/' + f.getName() : f.getName(), fn);
  }
}

/* ============================ Images ============================ */

function getImage_(id) {
  if (!id) throw new Error('Paramètre id manquant');
  const file = DriveApp.getFileById(id);
  if (!isInside_(file, CONFIG.FOLDER_ID)) throw new Error('Image hors du dossier Mission Révision');
  const blob = file.getBlob();
  return {
    ok: true, id: id, name: file.getName(),
    mime: blob.getContentType() || file.getMimeType(),
    data: Utilities.base64Encode(blob.getBytes()),
  };
}

function isInside_(file, rootId) {
  let queue = [];
  const parents = file.getParents();
  while (parents.hasNext()) queue.push(parents.next());
  for (let depth = 0; depth < 12 && queue.length; depth++) {
    const next = [];
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].getId() === rootId) return true;
      const pp = queue[i].getParents();
      while (pp.hasNext()) next.push(pp.next());
    }
    queue = next;
  }
  return false;
}

/* ============================ Historique ============================ */

function readHistory_(root) {
  const it = root.getFilesByName(CONFIG.HISTORY_FILE);
  if (!it.hasNext()) return { file: null, data: { format: 'mission-revision-historique/1', sessions: [] } };
  const file = it.next();
  try {
    const data = JSON.parse(file.getBlob().getDataAsString('UTF-8') || '{}');
    if (!Array.isArray(data.sessions)) data.sessions = [];
    return { file: file, data: data };
  } catch (err) {
    // Fichier corrompu : on le met de côté au lieu de l'écraser.
    file.setName('_historique_corrompu_' + Date.now() + '.json');
    return { file: null, data: { format: 'mission-revision-historique/1', sessions: [] } };
  }
}

function saveResults_(results) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const root = rootFolder_();
    const h = readHistory_(root);
    const known = {};
    h.data.sessions.forEach(function (s) { known[s.id] = true; });
    const saved = [];
    results.forEach(function (r) {
      if (!r || !r.id) return;
      if (!known[r.id]) { h.data.sessions.push(r); known[r.id] = true; }
      saved.push(r.id); // déjà présent = considéré comme sauvegardé
    });
    if (h.data.sessions.length > MAX_SESSIONS) h.data.sessions = h.data.sessions.slice(-MAX_SESSIONS);
    h.data.updated = new Date().toISOString();
    const content = JSON.stringify(h.data, null, 1);
    if (h.file) h.file.setContent(content);
    else root.createFile(CONFIG.HISTORY_FILE, content, 'application/json');
    return { ok: true, saved: saved, total: h.data.sessions.length };
  } finally {
    lock.releaseLock();
  }
}

/* ============================ Utilitaires ============================ */

/**
 * Lit du JSON « tolérant » : accepte du texte autour (ex. Google Doc exporté
 * depuis Gemini avec ``` ou une phrase d'intro) et les guillemets typographiques.
 */
function parseLoose_(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  try { return JSON.parse(text); } catch (e1) {
    const a = text.indexOf('{'), b = text.indexOf('[');
    const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start < 0 || end <= start) throw e1;
    const body = text.slice(start, end + 1);
    try { return JSON.parse(body); } catch (e2) {
      try { return JSON.parse(body.replace(/[\u201C\u201D]/g, '"')); } catch (e3) { throw e2; }
    }
  }
}

function rootFolder_() {
  if (!CONFIG.FOLDER_ID || CONFIG.FOLDER_ID.indexOf('COLLE_ICI') === 0) {
    throw new Error('FOLDER_ID non configuré dans le script');
  }
  return DriveApp.getFolderById(CONFIG.FOLDER_ID);
}

function checkKey_(key) {
  if (CONFIG.KEY && String(key || '') !== CONFIG.KEY) throw new Error('Clé invalide');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * À lancer UNE FOIS depuis l'éditeur (bouton « Exécuter ») :
 * autorise l'accès à Drive et vérifie le contenu du dossier.
 */
function verifierInstallation() {
  const cat = getCatalog_();
  let n = 0;
  cat.files.forEach(function (f) {
    const blocks = Array.isArray(f.data) ? f.data : [f.data];
    blocks.forEach(function (b) { n += (b && b.questions ? b.questions.length : 0); });
  });
  Logger.log('Dossier : ' + cat.folder);
  Logger.log(cat.files.length + ' fichier(s) JSON, ' + n + ' question(s), ' + cat.images.length + ' image(s)');
  cat.errors.forEach(function (e) { Logger.log('⚠️ ' + (e.path ? e.path + '/' : '') + e.name + ' — ' + e.error); });
  Logger.log(cat.history.sessions.length + ' session(s) dans l\'historique');
}
