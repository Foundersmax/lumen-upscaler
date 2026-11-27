// Project sync: a signed-in person's projects (transcript and edits, never the video) are copied to
// their own space in Firestore, users/{uid}/projects, so they show up on every device they sign in on.
//
// Each project is one small document (name, length, thumbnail, when it was saved) plus its data,
// gzipped and split into chunks under it, since a Firestore document holds at most 1 MiB.
// A removed project leaves a "deleted" marker behind, so other devices remove it too instead of
// uploading it again.
import { load, override } from "./auth.js";

const CHUNK = 700 * 1024;        // bytes of compressed data per chunk document
const MAX_BYTES = 9 * 1024 * 1024; // one write batch carries at most 10 MiB

let fsp = null;
function fs() {
  fsp ||= (async () => {
    const { app } = await load();
    const F = await import("../../vendor/firebase/firebase-firestore-lite.js");
    const db = F.getFirestore(app);
    if (override?.firestore) { const [host, port] = override.firestore.split(":"); F.connectFirestoreEmulator(db, host, +port); }
    return { db, F };
  })();
  return fsp;
}

/** Firestore-safe document id for a project key (keys contain file names, which may contain "/"). */
async function docId(key) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return [...h.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function gzip(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
const projects = (F, db, uid) => F.collection(db, "users", uid, "projects");

export class SyncError extends Error {}
/** Plain-language message for a Firestore error. */
export function syncMessage(e) {
  if (e instanceof SyncError) return e.message;
  const code = e?.code || "", msg = String(e?.message || "");
  if (/has not been used|is disabled|database .*does not exist/i.test(msg)) return "Sync isn't set up yet: the Firestore database hasn't been created.";
  if (code === "permission-denied") return "Sync is blocked by your Firestore security rules. Check the rules in the Firebase console.";
  if (code === "not-found") return "Sync isn't set up yet: the Firestore database hasn't been created.";
  if (code === "unavailable" || !navigator.onLine) return "You're offline. Projects will sync when you're back online.";
  if (code === "resource-exhausted") return "Your Firebase project has reached its free daily limit. Sync will resume tomorrow.";
  if (code === "unauthenticated") return "Sign in again to keep syncing.";
  return "Couldn't sync your projects. They're still saved in this browser.";
}

/** The summaries of everything in the person's account (no project data). */
export async function listRemote(uid) {
  const { db, F } = await fs();
  const snap = await F.getDocs(projects(F, db, uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => typeof r.key === "string");
}

/** Uploads one project with its summary. */
export async function upload(uid, key, project, meta) {
  const { db, F } = await fs();
  const id = await docId(key), main = F.doc(db, "users", uid, "projects", id);
  const bytes = await gzip(project);
  if (bytes.length > MAX_BYTES) throw new SyncError(`"${meta.name}" is too large to sync (${(bytes.length / 1048576).toFixed(1)} MB compressed). It's still saved in this browser.`);
  const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
  const old = await F.getDoc(main);
  const oldN = old.exists() ? old.data().chunks || 0 : 0;
  const batch = F.writeBatch(db);
  for (let i = 0; i < n; i++) batch.set(F.doc(main, "chunks", String(i)), { d: F.Bytes.fromUint8Array(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
  for (let i = n; i < oldN; i++) batch.delete(F.doc(main, "chunks", String(i)));
  const { thumb = null, name = "", size = 0, duration = 0, w = 0, h = 0 } = meta;
  batch.set(main, { v: 1, key, name, size, duration, w, h, thumb, savedAt: project.savedAt || meta.savedAt || Date.now(), chunks: n, bytes: bytes.length, deleted: false, summary: summaryOf(meta) });
  await batch.commit();
}
const SUMMARY = ["words", "transcribed", "cutWords", "highlights", "scenes", "speakers", "captions", "vertical"];
const summaryOf = (m) => Object.fromEntries(SUMMARY.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));

/** Downloads a project's data. */
export async function download(uid, remote) {
  const { db, F } = await fs();
  const main = F.doc(db, "users", uid, "projects", remote.id);
  const parts = await Promise.all(Array.from({ length: remote.chunks || 0 }, (_, i) => F.getDoc(F.doc(main, "chunks", String(i)))));
  if (!parts.length || parts.some((p) => !p.exists())) throw new SyncError(`"${remote.name}" is still uploading from another device. Try again in a moment.`);
  const arrays = parts.map((p) => p.data().d.toUint8Array());
  const all = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0));
  let o = 0; for (const a of arrays) { all.set(a, o); o += a.length; }
  return gunzip(all);
}

/** Removes a project's data from the account and leaves a marker so other devices remove it too. */
export async function removeRemote(uid, key, name, at = Date.now()) {
  const { db, F } = await fs();
  const main = F.doc(db, "users", uid, "projects", await docId(key));
  const old = await F.getDoc(main);
  const batch = F.writeBatch(db);
  for (let i = 0; i < (old.exists() ? old.data().chunks || 0 : 0); i++) batch.delete(F.doc(main, "chunks", String(i)));
  batch.set(main, { v: 1, key, name, savedAt: at, deleted: true, chunks: 0 });
  await batch.commit();
}
