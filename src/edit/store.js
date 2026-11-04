// Tiny IndexedDB key-value store for projects (transcript + edits), so reopening a file restores work.
// Every call is best-effort: private windows or blocked storage just mean nothing is remembered.
const DB = "lumen", STORE = "projects";
let dbp = null;
function open() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbp;
}
function tx(mode, fn) {
  return open().then((db) => db && new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode), r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r?.result ?? null);
      t.onerror = t.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
export const getProject = (key) => tx("readonly", (s) => s.get(key));
export const putProject = (key, value) => tx("readwrite", (s) => s.put({ ...value, savedAt: Date.now() }, key));
export const deleteProject = (key) => tx("readwrite", (s) => s.delete(key));
export const projectKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;
