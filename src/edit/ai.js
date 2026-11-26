// AI requests with the user's own key, straight from the browser to Claude (Anthropic) or OpenAI.
// Only transcript text and timestamps are sent; the video never leaves the device.
//
// Claude is called over plain fetch rather than Anthropic's SDK: this app is static files with no
// bundler, and the SDK's browser entry pulls in Node-only and third-party modules a page can't load.

export const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export const PROVIDERS = {
  claude: { name: "Claude", company: "Anthropic", model: "claude-opus-5-5", keyHint: "sk-ant-…", keySite: "platform.claude.com → API keys" },
  openai: { name: "OpenAI", company: "OpenAI", model: "gpt-4.1-mini", keyHint: "sk-…", keySite: "platform.openai.com → API keys" },
};
// Claude models that take `effort` and server-side refusal fallbacks
const CLAUDE_CURRENT = /^claude-(opus-5|sonnet-5|fable-5|haiku-5)/;
const CLAUDE_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5-[12])/;

export class AIError extends Error {}

/**
 * Asks for a JSON reply that matches `schema`.
 * @param {{provider:"claude"|"openai", key:string, model?:string, system:string, prompt:string, schema:object,
 *          name:string, signal?:AbortSignal, url?:string, effort?:string}} o
 * @returns {Promise<any>} the parsed reply
 */
export async function askJSON(o) {
  const p = PROVIDERS[o.provider];
  if (!p) throw new AIError("Choose an AI provider first.");
  if (!o.key) throw new AIError(`Add your ${p.name} API key first.`);
  return o.provider === "claude" ? askClaude(o) : askOpenAI(o);
}

async function send(url, init, who, signal) {
  try { return await fetch(url, { ...init, signal }); }
  catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new AIError(`Couldn't reach ${who}. Check your connection and try again.`);
  }
}

async function askClaude({ key, model, system, prompt, schema, signal, url, effort = "medium" }) {
  model = model || PROVIDERS.claude.model;
  const body = {
    model, max_tokens: 16000, system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema }, ...(CLAUDE_CURRENT.test(model) ? { effort } : {}) },
  };
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2026-10-21",
    // Anthropic requires this to accept requests from a web page; the key is the user's own
    "anthropic-dangerous-direct-browser-access": "true",
  };
  // if a safety check declines the request, let the API retry it on a suitable model
  if (CLAUDE_FALLBACK.test(model)) { headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; body.fallbacks = "default"; }
  let res = await send(url || CLAUDE_URL, { method: "POST", headers, body: JSON.stringify(body) }, "Anthropic", signal);
  let data = null;
  try { data = await res.json(); } catch {}
  // the fallback is optional: if the account or model doesn't accept it, ask again without it
  if (res.status === 400 && body.fallbacks && /fallback|beta/i.test(data?.error?.message || "")) {
    delete body.fallbacks; delete headers["anthropic-beta"];
    res = await send(url || CLAUDE_URL, { method: "POST", headers, body: JSON.stringify(body) }, "Anthropic", signal);
    data = null; try { data = await res.json(); } catch {}
  }
  if (!res.ok) {
    const type = data?.error?.type || "", msg = data?.error?.message || "";
    if (res.status === 401) throw new AIError("Anthropic didn't accept the API key. Check it and try again.");
    if (res.status === 403) throw new AIError("This API key isn't allowed to use that model. Check your Anthropic Console settings.");
    if (/credit balance/i.test(msg)) throw new AIError("Your Anthropic account is out of credit. Add credit at platform.claude.com → Billing, then try again.");
    if (res.status === 429) throw new AIError("Anthropic is rate-limiting requests. Wait a minute, then try again.");
    if (res.status === 529 || type === "overloaded_error") throw new AIError("Claude is busy right now. Try again in a minute.");
    if (res.status === 404 || type === "not_found_error") throw new AIError(`The model "${model}" isn't available to your Anthropic account. Choose another model in the settings.`);
    if (res.status === 413 || /too long|context|too many tokens/i.test(msg)) throw new AIError("The transcript is too long for this model. Choose a model with a larger context window.");
    throw new AIError(`Anthropic returned an error (${res.status}${msg ? `: ${msg.slice(0, 140)}` : ""}).`);
  }
  if (data?.stop_reason === "refusal") throw new AIError("Claude declined to work on this transcript.");
  if (data?.stop_reason === "max_tokens") throw new AIError("Claude's reply was cut off. Ask for fewer results and try again.");
  const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { throw new AIError("Claude's reply couldn't be read. Try again."); }
}

async function askOpenAI({ key, model, system, prompt, schema, name, signal, url }) {
  model = model || PROVIDERS.openai.model;
  const body = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  };
  const res = await send(url || OPENAI_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, "OpenAI", signal);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const code = data?.error?.code || "", msg = data?.error?.message || "";
    if (res.status === 401) throw new AIError("OpenAI didn't accept the API key. Check it and try again.");
    if (res.status === 429 && /quota|billing/i.test(code + msg)) throw new AIError("Your OpenAI account is out of credit. Add billing at platform.openai.com, then try again.");
    if (res.status === 429) throw new AIError("OpenAI is rate-limiting requests. Wait a minute, then try again.");
    if (res.status === 404 || code === "model_not_found") throw new AIError(`The model "${model}" isn't available to your OpenAI account. Choose another model in the settings.`);
    if (res.status === 400 && /context|too long|maximum/i.test(msg)) throw new AIError("The transcript is too long for this model. Choose a model with a larger context window.");
    throw new AIError(`OpenAI returned an error (${res.status}${msg ? `: ${msg.slice(0, 140)}` : ""}).`);
  }
  const choice = data?.choices?.[0]?.message;
  if (choice?.refusal) throw new AIError("OpenAI declined to work on this transcript.");
  try { return JSON.parse(choice?.content || ""); } catch { throw new AIError("OpenAI's reply couldn't be read. Try again."); }
}
