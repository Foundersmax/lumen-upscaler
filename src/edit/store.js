// IndexedDB storage for projects, so reopening a file restores work, plus a recent-projects list.
//   projects: the full project (transcript, edits, captions, reframe, …), keyed by projectKey(file)
//   meta:     a small summary per project for the Recent list (name, length, thumbnail, …)
// Every call is best-effort: private windows or blocked storage just mean nothing is remembered.
const DB = "lumen", STORES = ["projects", "meta"];
let dbp = null;
function open() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked")); // another tab still has the old version open
  }).catch(() => null);
  return dbp;
}
function tx(store, mode, fn) {
  return open().then((db) => db && new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode), r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r?.result ?? null);
      t.onerror = t.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
export const getProject = (key) => tx("projects", "readonly", (s) => s.get(key));
export async function putProject(key, value, savedAt = Date.now()) {
  persistStorage();
  const r = await tx("projects", "readwrite", (s) => s.put({ ...value, savedAt }, key));
  if (r !== null) await touchMeta(key, { ...summarize(value), savedAt });
  return r;
}
export async function deleteProject(key) {
  await tx("projects", "readwrite", (s) => s.delete(key));
  await tx("meta", "readwrite", (s) => s.delete(key));
}
export const projectKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;
const keyParts = (key) => { const m = /^(.*)\|(\d+)\|(-?\d+)$/.exec(key); return m ? { name: m[1], size: +m[2], lastModified: +m[3] } : { name: key, size: 0, lastModified: 0 }; };

/** The saved project for a file. A copy of the same file (same name and size, e.g. re-downloaded) has a
 *  different modified time, so fall back to the newest project saved under that name and size. */
export async function findProject(file) {
  const key = await findProjectKey(file);
  return key ? getProject(key) : null;
}
export async function findProjectKey(file) {
  const exact = projectKey(file);
  if (await getProject(exact)) return exact;
  const prefix = `${file.name}|${file.size}|`;
  const keys = (await tx("projects", "readonly", (s) => s.getAllKeys())) || [];
  let best = null, bestAt = -1;
  for (const k of keys) {
    if (typeof k !== "string" || !k.startsWith(prefix)) continue;
    const p = await getProject(k);
    if (p && (p.savedAt || 0) > bestAt) { best = k; bestAt = p.savedAt || 0; }
  }
  return best;
}

/** What the Recent list shows about a project, from its saved data. */
export function summarize(p) {
  const out = {};
  const d = p?.doc;
  if (d?.words) {
    out.words = d.words.length;
    out.transcribed = d.duration > 0 ? Math.min(1, (d.limit ?? d.duration) / d.duration) : 1;
    let cut = 0; d.words.forEach((w, i) => { if (d.cutW?.[i]) cut += w.e - w.s; });
    out.cutWords = cut;
  }
  if (p) {
    out.highlights = p.highlights?.length || 0;
    out.scenes = p.scenes?.length || 0;
    out.speakers = p.speakers?.names?.length || 0;
    out.captions = !!p.captions?.on;
    out.vertical = !!p.reframe && p.reframe.aspect !== "orig";
  }
  return out;
}

/** Merges fields into a project's summary (creating it if needed). */
export async function touchMeta(key, fields) {
  const old = (await tx("meta", "readonly", (s) => s.get(key))) || { key, ...keyParts(key) };
  const next = { ...old, ...fields, key };
  await tx("meta", "readwrite", (s) => s.put(next, key));
  return next;
}

/** Recent projects, most recently edited or opened first. Projects saved before the list existed get a summary. */
export async function listProjects() {
  const [metas, keys] = await Promise.all([tx("meta", "readonly", (s) => s.getAll()), tx("projects", "readonly", (s) => s.getAllKeys())]);
  const list = (metas || []).filter((m) => m?.key);
  const known = new Set(list.map((m) => m.key));
  for (const k of keys || []) {
    if (typeof k !== "string" || known.has(k)) continue;
    const p = await getProject(k);
    if (p) list.push(await touchMeta(k, { ...summarize(p), savedAt: p.savedAt || 0, duration: p.doc?.duration || 0 }));
  }
  const at = (m) => Math.max(m.savedAt || 0, m.openedAt || 0);
  return list.sort((a, b) => at(b) - at(a));
}

/** Asks the browser not to clear saved projects when space runs low (granted silently or ignored). */
let asked = false;
function persistStorage() {
  if (asked) return; asked = true;
  try { navigator.storage?.persisted?.().then((p) => p || navigator.storage.persist?.()).catch(() => {}); } catch {}
}

/* ---------- backup files ---------- */
export const BACKUP_EXT = ".wetnix";
const FORMAT = "wetnix-project";

/** A project as a self-contained backup file (the video itself isn't included). */
export async function backupBlob(key) {
  const [project, meta] = await Promise.all([getProject(key), tx("meta", "readonly", (s) => s.get(key))]);
  if (!project) throw new Error("This project hasn't been saved yet, so there's nothing to back up.");
  const body = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), key, meta: meta || { key, ...keyParts(key) }, project };
  return new Blob([JSON.stringify(body)], { type: "application/json" });
}

/** Reads a backup file. Returns {key, meta, project, existing} without saving anything. */
export async function readBackup(file) {
  let body;
  try { body = JSON.parse(await file.text()); } catch { throw new Error(`"${file.name}" isn't a Wetnix project backup.`); }
  if (body?.format !== FORMAT || typeof body.key !== "string" || typeof body.project !== "object" || !body.project) throw new Error(`"${file.name}" isn't a Wetnix project backup.`);
  if (body.version > 1) throw new Error("This backup was made by a newer version of Wetnix. Reload the page and try again.");
  const existing = await getProject(body.key);
  return { key: body.key, meta: body.meta || {}, project: body.project, existing };
}

/** Saves a backup read with readBackup(), replacing any project with the same key. */
export async function restoreBackup({ key, meta, project }) {
  const savedAt = project.savedAt || Date.now();
  const r = await tx("projects", "readwrite", (s) => s.put({ ...project, savedAt }, key));
  if (r === null) throw new Error("This browser isn't letting Wetnix save projects (private window or storage turned off).");
  const { thumb, duration, w, h } = meta;
  return touchMeta(key, { ...summarize(project), savedAt, duration: duration || project.doc?.duration || 0, w, h, thumb, imported: Date.now() });
}
export const getMeta = (key) => tx("meta", "readonly", (s) => s.get(key));
