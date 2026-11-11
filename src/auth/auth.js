// Accounts via Supabase Auth. Optional: every tool works signed out. The client library is loaded
// only when a config exists, so visitors' browsers never contact Supabase unless sign-in is enabled.
import { supabaseConfig } from "./config.js";

const config = globalThis.__lumenSupabase || supabaseConfig; // test hook: point at a local Supabase stack
export const authEnabled = !!(config?.url && config?.anonKey);

// What the email link brought back (read before the client consumes the URL fragment).
const hash = new URLSearchParams(location.hash.slice(1));
export const arrival = { type: hash.get("type"), error: hash.get("error_code") || hash.get("error"), description: hash.get("error_description") };

/** Where email links and Google sign-in return to: this page, without query or fragment. */
const here = () => location.origin + location.pathname;

let ready = null;
function load() {
  ready ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../../vendor/supabase/supabase.js", import.meta.url).href; // UMD build: defines window.supabase
    s.onload = () => resolve(globalThis.supabase.createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }));
    s.onerror = () => { ready = null; reject(new Error("Couldn't load the sign-in library.")); };
    document.head.append(s);
  });
  return ready;
}

const view = (u) => u && ({ id: u.id, email: u.email, name: u.user_metadata?.name || u.user_metadata?.full_name || "", verified: !!(u.email_confirmed_at || u.confirmed_at),
  password: (u.app_metadata?.providers || [u.app_metadata?.provider]).includes("email") });
const check = ({ data, error }) => { if (error) throw error; return data; };

/** Calls back with (user | null, event) now and on every change. */
export async function onUser(cb) {
  if (!authEnabled) { cb(null, "INITIAL_SESSION"); return; }
  const sb = await load();
  sb.auth.onAuthStateChange((event, session) => cb(view(session?.user) || null, event));
}

/** @returns {{user, needsConfirm: boolean}} needsConfirm: a confirmation link was emailed and must be opened first */
export async function signUp(email, password, name) {
  const sb = await load();
  const data = check(await sb.auth.signUp({ email, password, options: { data: name ? { name } : {}, emailRedirectTo: here() } }));
  // For an address that is already registered Supabase returns a decoy user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw Object.assign(new Error("exists"), { code: "user_already_exists" });
  return { user: view(data.user), needsConfirm: !data.session };
}
export async function signIn(email, password) { const sb = await load(); return view(check(await sb.auth.signInWithPassword({ email, password })).user); }
/** Leaves the page for Google, then returns here signed in. */
export async function signInWithGoogle() { const sb = await load(); check(await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: here() } })); }
export async function sendReset(email) { const sb = await load(); check(await sb.auth.resetPasswordForEmail(email, { redirectTo: here() })); }
export async function resendConfirmation(email) { const sb = await load(); check(await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: here() } })); }
export async function setPassword(password) { const sb = await load(); return view(check(await sb.auth.updateUser({ password })).user); }
export async function signOutUser() { const sb = await load(); const { error } = await sb.auth.signOut(); if (error) throw error; }
/** Needs the SQL in supabase/delete_account.sql to have been run once in the project. */
export async function deleteAccount() {
  const sb = await load();
  const { error } = await sb.rpc("delete_account");
  if (error) throw error;
  await sb.auth.signOut({ scope: "local" }).catch(() => {});
}

/** Plain-language message for an auth error. */
export function authMessage(e) {
  const code = e?.code || "", text = String(e?.message || "");
  const map = {
    invalid_credentials: "The email or password is incorrect.",
    email_not_confirmed: "Confirm your email first: open the link we sent you.",
    user_already_exists: "An account with this email already exists. Sign in instead.",
    email_exists: "An account with this email already exists. Sign in instead.",
    weak_password: "Choose a longer password (at least 8 characters).",
    same_password: "Choose a password you haven't used here before.",
    email_address_invalid: "That doesn't look like an email address.",
    validation_failed: "That doesn't look like an email address.",
    over_email_send_rate_limit: "Too many emails were requested. Wait a few minutes, then try again.",
    over_request_rate_limit: "Too many attempts. Wait a few minutes, then try again.",
    signup_disabled: "New sign-ups are closed at the moment.",
    email_provider_disabled: "Email sign-in isn't switched on for this site yet.",
    provider_disabled: "This sign-in method isn't switched on for this site yet.",
    user_banned: "This account has been disabled.",
    otp_expired: "That link has expired or was already used. Request a new one.",
    access_denied: "That link has expired or was already used. Request a new one.",
    session_not_found: "Your session ended. Sign in again.",
    PGRST202: "Account deletion isn't set up for this site yet.",
  };
  if (map[code]) return map[code];
  if (/failed to fetch|networkerror|load failed/i.test(text) || e?.name === "AuthRetryableFetchError") return "Couldn't reach the sign-in service. Check your connection and try again.";
  if (/invalid login credentials/i.test(text)) return map.invalid_credentials;
  if (/rate limit/i.test(text)) return map.over_request_rate_limit;
  return "Something went wrong. Try again.";
}
