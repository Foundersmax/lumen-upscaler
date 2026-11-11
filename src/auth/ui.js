// Account button + dialog, shared by every page. Renders nothing until a Supabase config exists.
import { authEnabled, arrival, onUser, signUp, signIn, signInWithGoogle, sendReset, resendConfirmation, setPassword, signOutUser, deleteAccount, authMessage } from "./auth.js";

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (v === true) n.setAttribute(k, ""); else if (v !== false && v != null) n.setAttribute(k, v); }
  n.append(...kids.filter((k) => k !== null && k !== ""));
  return n;
};
const X_ICON = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3 3 8 8M11 3l-8 8"/></svg>';
const G_ICON = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A8.97 8.97 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
const EMAIL_RE = /^\S+@\S+\.\S+$/;

let user = null, mode = "signin", busy = false, pendingEmail = "", welcome = "";
let btn, dlg, body, titleEl;

function mount() {
  const header = document.querySelector("header");
  if (!header) return;
  let slot = header.querySelector(".head-actions");
  if (!slot) { slot = el("div", { class: "head-actions" }); header.append(slot); }
  btn = el("button", { class: "btn ghost small acct-btn", type: "button", id: "acctBtn", hidden: true });
  btn.addEventListener("click", () => open(user ? "account" : "signin"));
  slot.append(btn);

  dlg = el("dialog", { class: "sheet auth-sheet", id: "authDlg", "aria-labelledby": "authTitle" });
  titleEl = el("h2", { id: "authTitle" });
  const close = el("button", { class: "xbtn", type: "button", "aria-label": "Close", id: "authClose" }); close.innerHTML = X_ICON;
  close.addEventListener("click", () => dlg.close());
  body = el("div", { class: "sheet-body" });
  dlg.append(el("div", { class: "sheet-head" }, titleEl, close), body);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);

  // A failed email link (expired, already used) comes back as an error in the address.
  if (arrival.error) { history.replaceState(null, "", location.pathname + location.search); open("signin"); showIn(".err", authMessage({ code: arrival.error })); }

  onUser((u, event) => {
    const was = user; user = u; paintButton();
    if (event === "PASSWORD_RECOVERY") { open("newpass"); return; }         // arrived from a reset link
    if (u && !was && arrival.type === "signup" && !welcome) { welcome = "Your email is confirmed and you're signed in."; arrival.type = null; open("account"); return; }
    if (dlg.open && mode !== "newpass") { if (u && mode !== "account") render("account"); else if (!u && mode === "account") render("signin"); }
  }).catch((e) => console.warn("sign-in unavailable", e));
}

function paintButton() {
  btn.hidden = false; btn.textContent = "";
  if (user) {
    btn.classList.add("signed"); btn.setAttribute("aria-label", `Account: ${user.email}`); btn.title = user.email;
    btn.append(el("span", { class: "avatar", text: initial() }));
  } else { btn.classList.remove("signed"); btn.removeAttribute("aria-label"); btn.title = ""; btn.textContent = "Sign in"; }
}
const initial = () => (user?.name || user?.email || "?").trim()[0].toUpperCase();

function open(m) { render(m); if (!dlg.open) dlg.showModal(); }
function render(m) {
  mode = m; busy = false; body.textContent = "";
  ({ signin: renderSignIn, signup: renderSignUp, reset: renderReset, confirm: renderConfirm, newpass: renderNewPass, account: renderAccount })[m]();
  body.querySelector("input")?.focus();
}

const field = (id, label, type, autocomplete, extra = {}) => el("label", { class: "field", for: id }, el("span", { text: label }), el("input", { id, type, autocomplete, required: true, ...extra }));
const msg = (cls) => el("div", { class: cls, role: cls === "err" ? "alert" : "status", hidden: true });
const show = (node, text) => { if (node) { node.hidden = !text; node.textContent = text || ""; } };
const showIn = (sel, text) => show(body.querySelector(sel), text);
function setBusy(form, on, label) {
  busy = on;
  for (const c of form.querySelectorAll("button, input")) c.disabled = on;
  const main = form.querySelector(".btn.primary"); if (main && label) main.textContent = label;
}
const link = (text, id, to) => { const b = el("button", { class: "linkbtn", type: "button", id, text }); b.addEventListener("click", () => render(to)); return b; };
const divider = () => el("div", { class: "auth-or", text: "or" });
function googleButton(err) {
  const b = el("button", { class: "btn ghost google", type: "button", id: "authGoogle" }); b.innerHTML = G_ICON + "<span>Continue with Google</span>";
  b.addEventListener("click", async () => { if (busy) return; show(err, ""); b.disabled = true; try { await signInWithGoogle(); } catch (e) { b.disabled = false; show(err, authMessage(e)); } });
  return b;
}

function renderSignIn() {
  titleEl.textContent = "Sign in";
  const err = msg("err");
  const resend = el("button", { class: "linkbtn", type: "button", id: "authResendLink", text: "Send the confirmation link again", hidden: true });
  const form = el("form", { class: "auth-form", id: "authForm", novalidate: true },
    field("authEmail", "Email", "email", "email", { inputmode: "email", value: pendingEmail }),
    field("authPass", "Password", "password", "current-password"),
    err, resend,
    el("button", { class: "btn primary", type: "submit", text: "Sign in" }));
  resend.addEventListener("click", async () => {
    const email = form.authEmail.value.trim(); resend.disabled = true;
    try { await resendConfirmation(email); pendingEmail = email; render("confirm"); } catch (e) { resend.disabled = false; show(err, authMessage(e)); }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; show(err, ""); resend.hidden = true;
    const email = form.authEmail.value.trim(), pass = form.authPass.value;
    if (!email || !pass) { show(err, "Enter your email and password."); return; }
    setBusy(form, true, "Signing in…");
    try { await signIn(email, pass); }
    catch (e2) { setBusy(form, false, "Sign in"); show(err, authMessage(e2)); resend.hidden = e2?.code !== "email_not_confirmed"; form.authPass.focus(); }
  });
  body.append(form, el("div", { class: "auth-links" }, link("Forgot password?", "authToReset", "reset"), link("Create an account", "authToSignup", "signup")), divider(), googleButton(err),
    el("p", { class: "help", text: "Accounts are optional. The editor and upscaler work without one, and your videos never leave your device either way." }));
}

function renderSignUp() {
  titleEl.textContent = "Create your account";
  const err = msg("err");
  const form = el("form", { class: "auth-form", id: "authForm", novalidate: true },
    field("authName", "Name (optional)", "text", "name", { required: false, maxlength: 80 }),
    field("authEmail", "Email", "email", "email", { inputmode: "email" }),
    field("authPass", "Password", "password", "new-password", { minlength: 8, "aria-describedby": "authPassHint" }),
    el("div", { class: "hintline", id: "authPassHint", text: "At least 8 characters." }),
    err,
    el("button", { class: "btn primary", type: "submit", text: "Create account" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; show(err, "");
    const email = form.authEmail.value.trim(), pass = form.authPass.value, name = form.authName.value.trim();
    if (!EMAIL_RE.test(email)) { show(err, "That doesn't look like an email address."); form.authEmail.focus(); return; }
    if (pass.length < 8) { show(err, "Choose a longer password (at least 8 characters)."); form.authPass.focus(); return; }
    setBusy(form, true, "Creating account…");
    let res;
    try { res = await signUp(email, pass, name); } catch (e2) { setBusy(form, false, "Create account"); show(err, authMessage(e2)); return; }
    busy = false;
    if (res.needsConfirm) { pendingEmail = email; render("confirm"); }
    else { user = res.user; paintButton(); render("account"); }
  });
  body.append(form, el("div", { class: "auth-links" }, link("I already have an account", "authToSignin", "signin")), divider(), googleButton(err));
}

/** After sign-up: the account exists but the emailed link must be opened before signing in. */
function renderConfirm() {
  titleEl.textContent = "Check your email";
  const err = msg("err"), note = msg("note");
  const resend = el("button", { class: "btn ghost", type: "button", id: "authResend", text: "Send it again" });
  resend.addEventListener("click", async () => {
    show(err, ""); show(note, ""); resend.disabled = true;
    try { await resendConfirmation(pendingEmail); show(note, "Sent. It can take a minute to arrive."); } catch (e) { show(err, authMessage(e)); }
    resend.disabled = false;
  });
  body.append(el("p", { class: "auth-lead", id: "authConfirmText" }, "We sent a confirmation link to ", el("b", { text: pendingEmail }), ". Open it to finish creating your account. Check your spam folder if you don't see it."),
    note, err, resend, el("div", { class: "auth-links" }, link("Back to sign in", "authToSignin", "signin")));
}

function renderReset() {
  titleEl.textContent = "Reset your password";
  const err = msg("err"), okMsg = msg("note");
  const form = el("form", { class: "auth-form", id: "authForm", novalidate: true },
    field("authEmail", "Email", "email", "email", { inputmode: "email", value: pendingEmail }), err, okMsg,
    el("button", { class: "btn primary", type: "submit", text: "Send reset link" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; show(err, ""); show(okMsg, "");
    const email = form.authEmail.value.trim();
    if (!EMAIL_RE.test(email)) { show(err, "That doesn't look like an email address."); return; }
    setBusy(form, true, "Sending…");
    try { await sendReset(email); } catch (e2) { setBusy(form, false, "Send reset link"); show(err, authMessage(e2)); return; }
    setBusy(form, false, "Send reset link");
    show(okMsg, `If an account exists for ${email}, a reset link is on its way. Check your spam folder too.`); // same message either way
  });
  body.append(form, el("div", { class: "auth-links" }, link("Back to sign in", "authToSignin", "signin")));
}

/** Arrived from a reset link: already signed in with a recovery session, so just set the password. */
function renderNewPass() {
  titleEl.textContent = "Choose a new password";
  const err = msg("err");
  const form = el("form", { class: "auth-form", id: "authForm", novalidate: true },
    field("authPass", "New password", "password", "new-password", { minlength: 8, "aria-describedby": "authPassHint" }),
    el("div", { class: "hintline", id: "authPassHint", text: "At least 8 characters." }), err,
    el("button", { class: "btn primary", type: "submit", text: "Save password" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; show(err, "");
    const pass = form.authPass.value;
    if (pass.length < 8) { show(err, "Choose a longer password (at least 8 characters)."); return; }
    setBusy(form, true, "Saving…");
    try { const u = await setPassword(pass); if (u) user = u; } catch (e2) { setBusy(form, false, "Save password"); show(err, authMessage(e2)); return; }
    busy = false; welcome = "Password updated. You're signed in."; paintButton(); render("account");
  });
  body.append(form);
}

function renderAccount() {
  if (!user) return render("signin");
  titleEl.textContent = "Your account";
  const err = msg("err"), note = msg("note");
  body.append(el("div", { class: "acct-who" }, el("span", { class: "avatar big", text: initial() }),
    el("div", {}, el("div", { class: "acct-name", id: "acctName", text: user.name || user.email }), user.name ? el("div", { class: "acct-email", id: "acctEmail", text: user.email }) : null)));
  const out = el("button", { class: "btn ghost", type: "button", id: "authSignOut", text: "Sign out" });
  out.addEventListener("click", async () => { out.disabled = true; try { await signOutUser(); dlg.close(); } catch (e) { out.disabled = false; show(err, authMessage(e)); } });
  const del = el("button", { class: "linkbtn danger", type: "button", id: "authDelete", text: "Delete account" });
  const confirm = el("div", { class: "confirm", id: "authDeleteConfirm", hidden: true });
  const yes = el("button", { class: "btn ghost small danger", type: "button", id: "authDeleteYes", text: "Delete permanently" });
  const no = el("button", { class: "btn ghost small", type: "button", text: "Keep account" });
  confirm.append(el("span", { text: "This removes your account for good. Videos and projects stored in this browser aren't affected." }), el("span", { class: "verify-actions" }, yes, no));
  del.addEventListener("click", () => { confirm.hidden = false; del.hidden = true; });
  no.addEventListener("click", () => { confirm.hidden = true; del.hidden = false; });
  yes.addEventListener("click", async () => { show(err, ""); yes.disabled = true; try { await deleteAccount(); dlg.close(); } catch (e) { yes.disabled = false; show(err, authMessage(e)); } });
  body.append(note, err, out, del, confirm);
  if (welcome) { show(note, welcome); welcome = ""; }
}

if (authEnabled) mount();
