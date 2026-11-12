// Accounts via Firebase Auth. Optional: every tool works signed out. The SDK is loaded only when
// a config exists, so visitors' browsers never contact Google unless sign-in is enabled.
import { firebaseConfig } from "./config.js";

// Test hook: { config, emulator } lets the suite run against the Firebase Auth emulator.
const override = globalThis.__lumenFirebase || null;
const config = override?.config || firebaseConfig;
export const authEnabled = !!config;

let ready = null;
function load() {
  ready ||= (async () => {
    const [{ initializeApp }, A] = await Promise.all([import("../../vendor/firebase/firebase-app.js"), import("../../vendor/firebase/firebase-auth.js")]);
    const auth = A.getAuth(initializeApp(config));
    if (override?.emulator) A.connectAuthEmulator(auth, override.emulator, { disableWarnings: true });
    return { auth, A };
  })();
  return ready;
}

/** Calls back with the user (or null) now and on every change. Returns an unsubscribe function. */
export async function onUser(cb) {
  if (!authEnabled) { cb(null); return () => {}; }
  const { auth, A } = await load();
  return A.onAuthStateChanged(auth, (u) => cb(u ? view(u) : null));
}
const view = (u) => ({ uid: u.uid, email: u.email, name: u.displayName || "", verified: u.emailVerified, photo: u.photoURL || "",
  password: u.providerData.some((p) => p.providerId === "password") });

export async function signUp(email, password, name) {
  const { auth, A } = await load();
  const cred = await A.createUserWithEmailAndPassword(auth, email, password);
  if (name) await A.updateProfile(cred.user, { displayName: name });
  await A.sendEmailVerification(cred.user).catch((e) => console.warn("verification email not sent", e));
  return view(auth.currentUser);
}
export async function signIn(email, password) {
  const { auth, A } = await load();
  return view((await A.signInWithEmailAndPassword(auth, email, password)).user);
}
export async function signInWithGoogle() {
  const { auth, A } = await load();
  return view((await A.signInWithPopup(auth, new A.GoogleAuthProvider())).user);
}
export async function sendReset(email) { const { auth, A } = await load(); await A.sendPasswordResetEmail(auth, email); }
export async function resendVerification() { const { auth, A } = await load(); if (auth.currentUser) await A.sendEmailVerification(auth.currentUser); }
export async function refreshUser() { const { auth } = await load(); await auth.currentUser?.reload(); return auth.currentUser ? view(auth.currentUser) : null; }
export async function signOutUser() { const { auth, A } = await load(); await A.signOut(auth); }
export async function deleteAccount() { const { auth, A } = await load(); if (auth.currentUser) await A.deleteUser(auth.currentUser); }

/** Plain-language message for a Firebase Auth error; null means "say nothing" (the person cancelled). */
export function authMessage(e) {
  const code = e?.code || "";
  const map = {
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/wrong-password": "The email or password is incorrect.",
    "auth/user-not-found": "The email or password is incorrect.",
    "auth/invalid-email": "That doesn't look like an email address.",
    "auth/missing-password": "Enter your password.",
    "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
    "auth/weak-password": "Choose a longer password (at least 8 characters).",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes, then try again.",
    "auth/network-request-failed": "Couldn't reach the sign-in service. Check your connection and try again.",
    "auth/user-disabled": "This account has been disabled.",
    "auth/popup-blocked": "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.",
    "auth/requires-recent-login": "For security, sign out, sign in again, then retry.",
    "auth/operation-not-allowed": "This sign-in method isn't switched on for this site yet.",
    "auth/unauthorized-domain": "This site's address isn't authorised for sign-in yet.",
    "auth/account-exists-with-different-credential": "An account with this email already exists with a different sign-in method.",
  };
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return null;
  return map[code] || "Something went wrong signing in. Try again.";
}
