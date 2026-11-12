// Account button + dialog, shared by every page. Renders nothing until a Firebase config exists.
import { authEnabled, onUser, signUp, signIn, signInWithGoogle, sendReset, resendVerification, refreshUser, signOutUser, deleteAccount, authMessage } from "./auth.js";

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (v === true) n.setAttribute(k, ""); else if (v !== false && v != null) n.setAttribute(k, v); }
  n.append(...kids);
  return n;
};
const X_ICON = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3 3 8 8M11 3l-8 8"/></svg>';
const G_ICON = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A8.97 8.97 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

let user = null, mode = "signin", busy = false;
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

  onUser((u) => { user = u; paintButton(); if (dlg.open) render(u ? "account" : mode === "account" ? "signin" : mode); });
}

function paintButton() {
  btn.hidden = false;
  btn.textContent = "";
  if (user) {
    btn.classList.add("signed"); btn.setAttribute("aria-label", `Account: ${user.email}`); btn.title = user.email;
    btn.append(el("span", { class: "avatar", text: (user.name || user.email || "?").trim()[0].toUpperCase() }));
  } else { btn.classList.remove("signed"); btn.removeAttribute("aria-label"); btn.title = ""; btn.textContent = "Sign in"; }
}

function open(m) { render(m); if (!dlg.open) dlg.showModal(); }

const field = (id, label, type, autocomplete, extra = {}) => el("label", { class: "field", for: id }, el("span", { text: label }), el("input", { id, type, autocomplete, required: true, ...extra }));
const msg = (cls) => el("div", { class: cls, role: cls === "err" ? "alert" : "status", hidden: true });
const show = (node, text) => { node.hidden = !text; node.textContent = text || ""; };
function setBusy(form, on, label) {
  busy = on;
  for (const c of form.querySelectorAll("button, input")) c.disabled = on;
  const main = form.querySelector(".btn.primary"); if (main && label) main.textContent = label;
}

function render(m) {
  mode = m; body.textContent = "";
  ({ signin: renderSignIn, signup: renderSignUp, reset: renderReset, account: renderAccount })[m]();
  body.querySelector("input:not([type=hidden])")?.focus();
}

function googleButton(err) {
  const b = el("button", { class: "btn ghost google", type: "button", id: "authGoogle" }); b.innerHTML = G_ICON + "<span>Continue with Google</span>";
  b.addEventListener("click", async () => {
    if (busy) return; show(err, "");
    try { await signInWithGoogle(); } catch (e) { const t = authMessage(e); if (t) show(err, t); }
  });
  return b;
}
const divider = () => el("div", { class: "auth-or", text: "or" });
const link = (text, id, to) => { const b = el("button", { class: "linkbtn", type: "button", id, text }); b.addEventListener("click", () => render(to)); return b; };

function renderSignIn() {
  titleEl.textContent = "Sign in";
  const err = msg("err");
  const form = el("form", { class: "auth-form", id: "authForm", novalidate: true },
    field("authEmail", "Email", "email", "email", { inputmode: "email" }),
    field("authPass", "Password", "password", "current-password"),
    err,
    el("button", { class: "btn primary", type: "submit", text: "Sign in" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; show(err, "");
    const email = form.authEmail.value.trim(), pass = form.authPass.value;
    if (!email || !pass) { show(err, "Enter your email and password."); return; }
    setBusy(form, true, "Signing in…");
    try { await signIn(email, pass); } catch (e2) { setBusy(form, false, "Sign in"); show(err, authMessage(e2)); form.authPass.focus(); return; }
    busy = false;
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
    if (!/^\S+@\S+\.\S+$/.test(email)) { show(err, "That doesn't look like an email address."); form.authEmail.focus(); return; }
    if (pass.length < 8) { show(err, "Choose a longer password (at least 8 characters)."); form.authPass.focus(); return; }
    setBusy(form, true, "Creating account…");
    let created;
    try { created = await signUp(email, pass, name); } catch (e2) { setBusy(form, false, "Create account"); show(err, authMessage(e2)); return; }
    busy = false;
    // Firebase announces the new user before the name is saved; show the finished profile
    user = created; paintButton(); render("account");
  });
  body.append(form, el("div", { class: "auth-links" }, link("I already have an account", "authToSignin", "signin")), divider(), googleButton(err));
}

function renderReset() {
  titleEl.textContent = "Reset your password";
  const err = msg("err"), okMsg = msg("note");
  const form = el("form", { class: "auth-form", id: "authForm", novalidate: true },
    field("authEmail", "Email", "email", "email", { inputmode: "email" }), err, okMsg,
    el("button", { class: "btn primary", type: "submit", text: "Send reset link" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; show(err, ""); show(okMsg, "");
    const email = form.authEmail.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { show(err, "That doesn't look like an email address."); return; }
    setBusy(form, true, "Sending…");
    try { await sendReset(email); }
    catch (e2) { if (e2?.code !== "auth/user-not-found") { setBusy(form, false, "Send reset link"); show(err, authMessage(e2)); return; } }
    setBusy(form, false, "Send reset link");
    show(okMsg, `If an account exists for ${email}, a reset link is on its way. Check your spam folder too.`); // same message either way
  });
  body.append(form, el("div", { class: "auth-links" }, link("Back to sign in", "authToSignin", "signin")));
}

function renderAccount() {
  if (!user) return render("signin");
  titleEl.textContent = "Your account";
  const err = msg("err"), note = msg("note");
  const who = el("div", { class: "acct-who" }, el("span", { class: "avatar big", text: (user.name || user.email || "?").trim()[0].toUpperCase() }),
    el("div", {}, el("div", { class: "acct-name", id: "acctName", text: user.name || user.email }), user.name ? el("div", { class: "acct-email", id: "acctEmail", text: user.email }) : ""));
  body.append(who);
  if (user.password && !user.verified) {
    const resend = el("button", { class: "linkbtn", type: "button", id: "authResend", text: "Send it again" });
    const check = el("button", { class: "linkbtn", type: "button", id: "authCheck", text: "I've confirmed" });
    resend.addEventListener("click", async () => { show(err, ""); try { await resendVerification(); show(note, `Confirmation email sent to ${user.email}.`); } catch (e) { show(err, authMessage(e)); } });
    check.addEventListener("click", async () => { const u = await refreshUser().catch(() => null); if (u) { user = u; render("account"); if (!u.verified) show(body.querySelector(".note"), "Not confirmed yet. Open the link in the email, then try again."); } });
    body.append(el("div", { class: "verify", id: "authVerify" }, el("span", { text: "Confirm your email address using the link we sent you." }), el("span", { class: "verify-actions" }, resend, check)));
  }
  const out = el("button", { class: "btn ghost", type: "button", id: "authSignOut", text: "Sign out" });
  out.addEventListener("click", async () => { try { await signOutUser(); dlg.close(); } catch (e) { show(err, authMessage(e)); } });
  const del = el("button", { class: "linkbtn danger", type: "button", id: "authDelete", text: "Delete account" });
  const confirm = el("div", { class: "confirm", id: "authDeleteConfirm", hidden: true });
  const yes = el("button", { class: "btn ghost small danger", type: "button", id: "authDeleteYes", text: "Delete permanently" });
  const no = el("button", { class: "btn ghost small", type: "button", text: "Keep account" });
  confirm.append(el("span", { text: "This removes your account for good. Videos and projects stored in this browser aren't affected." }), el("span", { class: "verify-actions" }, yes, no));
  del.addEventListener("click", () => { confirm.hidden = false; del.hidden = true; });
  no.addEventListener("click", () => { confirm.hidden = true; del.hidden = false; });
  yes.addEventListener("click", async () => { show(err, ""); try { await deleteAccount(); dlg.close(); } catch (e) { show(err, authMessage(e)); } });
  body.append(note, err, out, del, confirm);
}

if (authEnabled) mount();
