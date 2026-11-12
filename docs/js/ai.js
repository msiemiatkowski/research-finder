/* AI helpers with the visitor's own key, sent straight from this page to the service the visitor chooses: Claude
   (Anthropic), OpenAI, Gemini (Google) or OpenRouter. Nothing goes through Research Finder. They suggest; the
   researcher decides:
   - screening: include, exclude or unsure against the researcher's criteria, with one short reason (in Screening);
   - study details from the abstracts: design, country or setting, sample size and population, each with the exact
     words it comes from, which are checked against the abstract;
   - an answer to a question from the abstracts of the first results, citing only them (the citations are checked);
   - more search terms for a keyword, offered like the wordings found in studies;
   - how one study relates to the question.
   Independent tests found that AI tools miss many relevant studies and make more extraction errors than people, so
   nothing here includes or excludes a study, and each answer says which model gave it. The key stays in this tab
   (sessionStorage) unless the visitor asks to remember it in this browser; it is never put in an address, an export
   or a save. Each use (service, model, date, requests, tokens) goes into "Search details", with the prompts. */
import { $, h, fill, fmt, plural, local, toast, norm } from "./util.js?v=43";

const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
const pause = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const TIMEOUT = 180000;

/* ------------------------------------------------------------------ services, keys and models */
export const SERVICES = {
  anthropic: { name: "Claude (Anthropic)", model: "claude-opus-5-5", keys: "https://platform.claude.com/settings/keys", hint: "sk-ant-…", who: "Anthropic" },
  openai: { name: "OpenAI", model: "gpt-6-astra", keys: "https://platform.openai.com/api-keys", hint: "sk-…", who: "OpenAI" },
  gemini: { name: "Gemini (Google)", model: "gemini-4-hydrogen", keys: "https://aistudio.google.com/apikey", hint: "AIza…", who: "Google" },
  openrouter: { name: "OpenRouter (many models, one key)", model: "anthropic/claude-opus-5.5", keys: "https://openrouter.ai/settings/keys", hint: "sk-or-…",
    who: "OpenRouter and the company whose model you choose" },
};

export const aiService = () => { const s = local.get("aiService", ""); return SERVICES[s] ? s : ""; };
export function setAiService(s) { local.set("aiService", SERVICES[s] ? s : null); changed(); }
const sessionName = (s) => `rf.aiKey.${s}`;
/* The key: for this tab only (sessionStorage), or remembered in this browser when the visitor asked. */
export function aiKey(s = aiService()) {
  if (!s) return "";
  try { const v = sessionStorage.getItem(sessionName(s)); if (v) return v; } catch { /* private window */ }
  return local.get(`aiKey.${s}`, "");
}
export const aiRemembered = (s = aiService()) => Boolean(s && local.get(`aiKey.${s}`, ""));
export function setAiKey(s, key, remember) {
  key = String(key || "").trim();
  try { if (key && !remember) sessionStorage.setItem(sessionName(s), key); else sessionStorage.removeItem(sessionName(s)); } catch { /* private window */ }
  local.set(`aiKey.${s}`, key && remember ? key : null);
  changed();
}
export const aiModel = (s = aiService()) => (s ? local.get("aiModels", {})[s] || SERVICES[s].model : "");
export function setAiModel(s, m) {
  const all = local.get("aiModels", {});
  m = String(m || "").trim();
  if (m && m !== SERVICES[s].model) all[s] = m; else delete all[s];
  local.set("aiModels", Object.keys(all).length ? all : null);
  changed();
}
export const aiReady = () => Boolean(aiService() && aiKey() && aiModel());
/* "Claude (Anthropic)" */
export const aiServiceName = (s = aiService()) => (s ? SERVICES[s].name.replace(/ \(many models, one key\)/, "") : "");
/* "Claude (Anthropic), claude-opus-5-5" */
export const aiLabel = (s = aiService(), m = aiModel(s)) => (s ? `${SERVICES[s].name.replace(/ \(many models, one key\)/, "")}, ${m}` : "");

const listeners = new Set();
export const onAiChange = (f) => listeners.add(f);
function changed() { for (const f of listeners) { try { f(); } catch { /* a listener's own problem */ } } }

/* ------------------------------------------------------------------ requests */
export class AiError extends Error {
  constructor(message, kind = "") { super(message); this.kind = kind; }
}

async function call(url, { method = "POST", headers = {}, body, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const stop = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", stop, { once: true });
  try {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json", ...headers } : headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, ok: r.ok, j, text };
  } catch {
    if (signal && signal.aborted) throw new AiError("stopped", "stopped");
    throw new AiError(ctrl.signal.aborted ? "the service took too long to answer" : "the service could not be reached (no connection, or the browser blocked the request)", "network");
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", stop);
  }
}
const messageOf = (res) => {
  const e = res.j && (res.j.error || (Array.isArray(res.j) && res.j[0] && res.j[0].error));
  return String((e && (e.message || e.status)) || res.text || "").replace(/\s+/g, " ").slice(0, 300);
};

/* How each service is asked: one system text, one user text, an answer in JSON when a schema is given. "drop" holds
   options a model turned down (reasoning effort, the schema), which the next try leaves out. */
const ANTHROPIC_HEADERS = (key) => ({ "x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true" });
const ADAPTERS = {
  anthropic: {
    drops: [["effort", /effort/i], ["fallbacks", /fallback/i], ["schema", /json_schema|output_config\.format|schema/i]],
    async send({ key, model, system, prompt, schema, effort, maxTokens, signal, drop }) {
      // the current Claude models that can hand a declined request to another model (Anthropic's server-side fallback)
      const fallback = !drop.has("fallbacks") && /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/.test(model);
      const body = { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] };
      const oc = {};
      if (effort && !drop.has("effort")) oc.effort = effort;
      if (schema && !drop.has("schema")) oc.format = { type: "json_schema", schema };
      if (Object.keys(oc).length) body.output_config = oc;
      if (fallback) body.fallbacks = "default";
      const headers = ANTHROPIC_HEADERS(key);
      if (fallback) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      const res = await call("https://api.anthropic.com/v1/messages", { headers, body, signal });
      if (!res.ok) return { error: res };
      const j = res.j || {};
      if (j.stop_reason === "refusal") throw new AiError(`the model declined this request${j.stop_details && j.stop_details.category ? ` (${j.stop_details.category})` : ""}`, "refusal");
      if (j.stop_reason === "max_tokens") throw new AiError("the answer was cut off before it was complete", "length");
      const u = j.usage || {};
      return { text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""), model: j.model || model,
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 };
    },
    async models(key) {
      const res = await call("https://api.anthropic.com/v1/models?limit=100", { method: "GET", headers: ANTHROPIC_HEADERS(key) });
      if (!res.ok) return { error: res };
      return { list: ((res.j || {}).data || []).map((m) => m.id) };
    },
  },
  openai: {
    drops: [["effort", /reasoning/i], ["schema", /json_schema|text\.format|response_format/i]],
    async send({ key, model, system, prompt, schema, name, effort, maxTokens, signal, drop }) {
      // store: false asks OpenAI not to keep the response for later retrieval
      const body = { model, input: [{ role: "system", content: system }, { role: "user", content: prompt }], max_output_tokens: maxTokens, store: false };
      if (effort && !drop.has("effort")) body.reasoning = { effort };
      if (schema && !drop.has("schema")) body.text = { format: { type: "json_schema", name, strict: true, schema } };
      const res = await call("https://api.openai.com/v1/responses", { headers: { authorization: `Bearer ${key}` }, body, signal });
      if (!res.ok) return { error: res };
      const j = res.j || {};
      const parts = (j.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []);
      const refusal = parts.find((p) => p.type === "refusal");
      if (refusal) throw new AiError(`the model declined this request${refusal.refusal ? `: ${refusal.refusal}` : ""}`, "refusal");
      if (j.status === "incomplete") {
        const why = (j.incomplete_details || {}).reason || "";
        throw new AiError(why === "max_output_tokens" ? "the answer was cut off before it was complete" : `the answer is incomplete${why ? ` (${why})` : ""}`, "length");
      }
      const u = j.usage || {};
      return { text: parts.filter((p) => p.type === "output_text").map((p) => p.text).join(""), model: j.model || model, input: u.input_tokens || 0, output: u.output_tokens || 0 };
    },
    async models(key) {
      const res = await call("https://api.openai.com/v1/models", { method: "GET", headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) return { error: res };
      const skip = /embed|tts|whisper|transcri|audio|realtime|image|dall-e|moderation|search|babbage|davinci|computer|sora|vision/i;
      return { list: ((res.j || {}).data || []).filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id) && !skip.test(m.id)).sort((a, b) => (b.created || 0) - (a.created || 0)).map((m) => m.id) };
    },
  },
  gemini: {
    drops: [["effort", /thinking/i], ["schema", /response_?json_?schema|responseJsonSchema|schema/i]],
    async send({ key, model, system, prompt, schema, effort, maxTokens, signal, drop }) {
      const gc = { maxOutputTokens: maxTokens };
      if (schema) {
        gc.responseMimeType = "application/json";
        if (!drop.has("schema")) gc.responseJsonSchema = schema;
      }
      if (effort && !drop.has("effort")) gc.thinkingConfig = { thinkingLevel: effort.toUpperCase() };
      const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gc };
      const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`,
        { headers: { "x-goog-api-key": key }, body, signal });
      if (!res.ok) return { error: res };
      const j = res.j || {};
      if (j.promptFeedback && j.promptFeedback.blockReason) throw new AiError(`Gemini did not answer (${j.promptFeedback.blockReason})`, "refusal");
      const c = (j.candidates || [])[0] || {};
      if (c.finishReason === "MAX_TOKENS") throw new AiError("the answer was cut off before it was complete", "length");
      if (c.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(c.finishReason)) throw new AiError(`Gemini stopped the answer (${c.finishReason})`, "refusal");
      const u = j.usageMetadata || {};
      return { text: ((c.content || {}).parts || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join(""), model: j.modelVersion || model,
        input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
    },
    async models(key) {
      const res = await call("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { method: "GET", headers: { "x-goog-api-key": key } });
      if (!res.ok) return { error: res };
      const skip = /embed|aqa|imagen|veo|tts|image|live|audio|robotics|learnlm/i;
      return { list: ((res.j || {}).models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && !skip.test(m.name))
        .map((m) => m.name.replace(/^models\//, "")) };
    },
  },
  openrouter: {
    drops: [["schema", /response_format|structured|json_schema|schema/i], ["effort", /reasoning/i]],
    async send({ key, model, system, prompt, schema, name, effort, maxTokens, signal, drop }) {
      const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: maxTokens };
      if (schema && !drop.has("schema")) body.response_format = { type: "json_schema", json_schema: { name, strict: true, schema } };
      if (effort && !drop.has("effort")) body.reasoning = { effort };
      const res = await call("https://openrouter.ai/api/v1/chat/completions", { headers: { authorization: `Bearer ${key}`, "X-Title": "Research Finder" }, body, signal });
      if (!res.ok) return { error: res };
      const j = res.j || {};
      if (j.error) return { error: { ...res, status: Number(j.error.code) || 502 } };
      const c = (j.choices || [])[0] || {};
      if (c.finish_reason === "length") throw new AiError("the answer was cut off before it was complete", "length");
      if (c.finish_reason === "content_filter") throw new AiError("the model's provider filtered the answer", "refusal");
      const m = c.message || {};
      if (m.refusal) throw new AiError(`the model declined this request: ${m.refusal}`, "refusal");
      const u = j.usage || {};
      return { text: typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""), model: j.model || model,
        input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cost: typeof u.cost === "number" ? u.cost : null };
    },
    async models(key) {
      let res = await call("https://openrouter.ai/api/v1/key", { method: "GET", headers: { authorization: `Bearer ${key}` } });
      if (res.status === 404) res = await call("https://openrouter.ai/api/v1/auth/key", { method: "GET", headers: { authorization: `Bearer ${key}` } });
      if (!res.ok) return { error: res };
      const data = await openRouterModels();
      // models that can answer in a given JSON form first
      const so = (m) => (m.supported_parameters || []).includes("structured_outputs") ? 0 : 1;
      return { list: data.filter((m) => !/:batch$/.test(m.id)).sort((a, b) => so(a) - so(b)).map((m) => m.id), info: (res.j || {}).data || null };
    },
  },
};

function errorFor(service, res, msg, model) {
  const s = res.status, who = SERVICES[service].name;
  if (s === 401 || s === 403 || /api key not valid|invalid x-api-key|incorrect api key|no auth credentials|missing authentication/i.test(msg)) {
    return new AiError(`${who} did not accept the key${msg ? ` (${msg})` : ""}`, "key");
  }
  if (s === 402 || /insufficient_quota|quota|billing|credit|balance/i.test(msg)) return new AiError(`${who}: no credit or quota left on this key${msg ? ` (${msg})` : ""}`, "quota");
  if (s === 404 || /model.*(not found|does not exist|not supported|unknown)|not_found_error|is not found|not a valid model/i.test(msg)) {
    return new AiError(`${who} does not offer the model “${model}” to this key: choose another under Settings › AI helpers${msg ? ` (${msg})` : ""}`, "model");
  }
  if (s === 429) return new AiError(`${who} is limiting how fast this key may ask: wait a minute and try again${msg ? ` (${msg})` : ""}`, "rate");
  if (s >= 500) return new AiError(`${who} is busy or had a problem (HTTP ${s}): try again later`, "server");
  return new AiError(`${who} answered HTTP ${s}${msg ? `: ${msg}` : ""}`, "other");
}

/* An answer in JSON: as it is, or out of a ```json block, or between the first { and the last }. */
function parseJson(text) {
  const t = String(text || "").trim();
  const tries = [t, (t.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const x of tries) {
    if (!x) continue;
    try { return JSON.parse(x); } catch { /* the next */ }
  }
  return null;
}
const schemaText = (schema) => `Answer with JSON only, no other text, matching this JSON Schema:\n${JSON.stringify(schema)}`;

/* One request to the chosen service and model. A model that turns down an option (reasoning effort, the schema) is
   asked again without it; a busy service is asked again after a pause, up to three times. */
export async function aiAsk({ task, system, prompt, schema = null, name = "answer", effort = "low", maxTokens = 8000, signal } = {}) {
  const service = aiService(), key = aiKey(service), model = aiModel(service);
  if (!service || !key) throw new AiError("no AI service is set up: add your key under Settings › AI helpers", "setup");
  const ad = ADAPTERS[service];
  const drop = new Set();
  let busy = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = schema && drop.has("schema") ? `${prompt}\n\n${schemaText(schema)}` : prompt;
    const out = await ad.send({ key, model, system, prompt: p, schema, name, effort, maxTokens, signal, drop });
    if (!out.error) {
      record(task, service, out);
      const data = schema ? parseJson(out.text) : out.text;
      if (schema && (data == null || typeof data !== "object")) throw new AiError("the answer was not in the form asked for", "format");
      return { data, model: out.model, service };
    }
    const res = out.error, msg = messageOf(res);
    if (res.status === 400 || res.status === 422) {
      const d = ad.drops.find(([what, re]) => !drop.has(what) && re.test(msg));
      if (d) { drop.add(d[0]); continue; }
    }
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && !/quota|billing|credit|balance/i.test(msg) && busy < 3) {
      await pause(3000 * 2 ** busy++);
      continue;
    }
    throw errorFor(service, res, msg, model);
  }
  throw new AiError("the service kept turning the request down", "other");
}

/* Whether the key works, and the models it can use (asked once a visit for each key, unless asked again). */
const checked = new Map();
export async function aiCheck(service, key, again = false) {
  const id = `${service}|${key}`;
  if (!again && checked.has(id)) return checked.get(id);
  const out = await ADAPTERS[service].models(key);
  if (out.error) throw errorFor(service, out.error, messageOf(out.error), aiModel(service));
  checked.set(id, out);
  return out;
}

/* ------------------------------------------------------------------ what was used, and what it may cost */
const uses = [];          // this visit: { task, service, model, first, last, requests, input, output, reported, all }
function record(task, service, out) {
  let u = uses.find((x) => x.task === task && x.service === service && x.model === out.model);
  if (!u) uses.push(u = { task, service, model: out.model, first: new Date().toISOString(), requests: 0, input: 0, output: 0, reported: 0, all: true });
  u.requests++;
  u.input += out.input || 0;
  u.output += out.output || 0;
  u.last = new Date().toISOString();
  // OpenRouter says what each request cost; for the others it is worked out from the listed prices
  if (out.cost != null) u.reported += out.cost; else u.all = false;
  if (!prices) loadPrices().then(changed);
  changed();
}
/* What a use cost, in dollars, or null when the model's prices are not known here. */
function useCost(u) {
  if (u.service === "openrouter" && u.all) return u.reported;
  return costOf(u.service, u.model, u.input, u.output);
}
export const aiUses = () => uses.map((u) => ({ ...u, cost: useCost(u) }));

let orModels = null;      // OpenRouter's public list of models, once a visit
function openRouterModels() {
  if (!orModels) {
    orModels = fetch("https://openrouter.ai/api/v1/models").then((r) => r.json()).then((j) => j.data || []).catch(() => { orModels = null; return []; });
  }
  return orModels;
}
let prices = null;        // model -> [dollars per input token, per output token], from that list, kept a day
export async function loadPrices() {
  if (prices) return prices;
  const cached = local.get("aiPrices", null);
  if (cached && Date.now() - cached.at < 86400000 && cached.p && Object.keys(cached.p).length) return (prices = cached.p);
  const p = {};
  for (const m of await openRouterModels()) {
    const a = Number((m.pricing || {}).prompt), b = Number((m.pricing || {}).completion);
    if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0) p[m.id] = [a, b];
  }
  if (Object.keys(p).length) local.set("aiPrices", { at: Date.now(), p });
  return (prices = p);
}
// "claude-opus-5-5" and OpenRouter's "anthropic/claude-opus-5.5" are the same model
const priceKey = (id) => String(id || "").toLowerCase().replace(/^[a-z0-9-]+\//, "").replace(/[^a-z0-9]/g, "");
function priceOf(service, model) {
  if (!prices) return null;
  if (service === "openrouter") return prices[model] || null;
  const want = priceKey(model.replace(/^models\//, ""));
  for (const [id, pr] of Object.entries(prices)) if (!id.includes(":") && priceKey(id) === want) return pr;
  return null;
}
function costOf(service, model, input, output) {
  const pr = priceOf(service, model);
  return pr ? input * pr[0] + output * pr[1] : null;
}
export const money = (x) => (x < 0.01 ? "less than $0.01" : `about $${x < 10 ? x.toFixed(2) : Math.round(x)}`);

/* What a run will roughly use: its text in characters, the records answered, the requests. Reasoning that a model
   does before it answers is billed as output too, and is not in the estimate. */
const OUT_PER = { screen: 70, extract: 260, answer: 900, terms: 450, match: 90 };
export async function estimate(task, chars, records, requests) {
  await loadPrices();
  const input = Math.round(chars / 3.6) + requests * 420;
  const output = OUT_PER[task] * (task === "answer" || task === "terms" ? requests : records);
  return { requests, input, output, cost: costOf(aiService(), aiModel(), input, output) };
}
export const estimateText = (e) => `About ${plural(e.requests, "request")} to ${aiLabel()}: roughly ${fmt(e.input)} tokens in and ${fmt(e.output)} out, `
  + `${e.cost != null ? `${money(e.cost)} at the prices OpenRouter lists for this model` : "at the model's prices (not known here)"}, plus whatever the model spends on reasoning before it answers.`;

export function usageText() {
  if (!uses.length) return "";
  const t = aiUses().reduce((a, u) => ({ r: a.r + u.requests, i: a.i + u.input, o: a.o + u.output, c: a.c + (u.cost || 0), p: a.p && u.cost != null }), { r: 0, i: 0, o: 0, c: 0, p: true });
  return `This visit: ${plural(t.r, "request")} to the AI service, ${fmt(t.i)} tokens in and ${fmt(t.o)} out${t.p ? `, ${money(t.c)}` : ""}.`;
}

/* ------------------------------------------------------------------ the prompts */
export const PROMPTS = {
  screen: "You help a researcher screen records for a literature review by title and abstract. You suggest; the researcher decides. Compare each record with the researcher's criteria and answer \"include\", \"exclude\" or \"unsure\", with one short reason that points to what the title or abstract says. Answer \"unsure\" when the abstract is missing or does not say enough to decide. Use only what each record says; do not use outside knowledge about the study.",
  extract: "You read the titles and abstracts of studies for a literature review and record four details of each: the study design, the country or setting, the sample size and the population. For each detail give a short value and the exact words of the title or abstract it comes from, copied without any change. When a record does not report a detail, give \"not reported\" as the value and an empty quote. Do not guess and do not use outside knowledge.",
  answer: "You answer a researcher's question using only the numbered abstracts given. Cite the abstracts you use with their numbers in square brackets, such as [3] or [2][5]. Cite nothing else and use no outside knowledge. If the abstracts do not answer the question, say so plainly. Write at most two short paragraphs, then one sentence on what the abstracts leave open.",
  terms: "You suggest search terms for one concept of a literature search, in English: other words and phrases that researchers use for the same concept (synonyms, spelling variants, abbreviations and their full forms, and narrower terms that a search for the concept should find). Do not suggest broader or merely related concepts, and do not repeat the terms already searched. Give each term as researchers write it, with a few words on why.",
  match: "In one or two sentences, say how this study relates to the researcher's question, and what it does not cover, using only its title and abstract. Do not use outside knowledge.",
};
const TASK_NAMES = { screen: "Screening suggestions", extract: "Study details from the abstracts", answer: "Answer from the abstracts", terms: "Search term suggestions", match: "How a study matches the question" };

const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const STR = { type: "string" };
const QUOTED = obj({ value: STR, quote: STR });
const SCHEMAS = {
  screen: obj({ records: { type: "array", items: obj({ n: { type: "integer" }, suggestion: { type: "string", enum: ["include", "exclude", "unsure"] }, reason: STR }) } }),
  extract: obj({ records: { type: "array", items: obj({ n: { type: "integer" }, design: QUOTED, country: QUOTED, sample_size: QUOTED, population: QUOTED }) } }),
  answer: obj({ answer: STR }),
  terms: obj({ terms: { type: "array", items: obj({ term: STR, why: STR }) } }),
  match: obj({ note: STR }),
};

/* ------------------------------------------------------------------ the helpers */
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")} …` : s; };
/* A record as the model reads it: [n] title, year, abstract (up to 3,000 characters), keywords. */
const recordText = (r, i) => `[${i + 1}] Title: ${clip(r.title, 400)}${r.year ? `\nYear: ${r.year}` : ""}\nAbstract: ${clip(r.abstract, 3000) || "(none)"}`
  + (r.keywords && r.keywords.length ? `\nKeywords: ${r.keywords.slice(0, 8).join("; ")}` : "");
export const promptChars = (records) => records.reduce((n, r, i) => n + recordText(r, i).length + 2, 0);
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

/* Up to two requests at a time; the first error stops the rest. */
async function pool(items, n, fn) {
  let next = 0, failed = null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try { await fn(item); } catch (e) { failed = failed || e; }
    }
  }));
  if (failed) throw failed;
}

/* Screening suggestions for records ({ key, title, abstract, keywords, year }), ten to a request; onResult(key, { s,
   why, model, at }) as they come. */
export async function suggestScreening(records, criteria, { signal, onResult = () => {}, onProgress = () => {} } = {}) {
  let done = 0;
  await pool(chunks(records, 10), 2, async (part) => {
    const prompt = `The researcher's criteria:\n${String(criteria).trim()}\n\nRecords:\n\n${part.map(recordText).join("\n\n")}\n\nGive one entry for each of the ${part.length} records, with its number.`;
    const { data, model } = await aiAsk({ task: "screen", system: PROMPTS.screen, prompt, schema: SCHEMAS.screen, name: "screening", effort: "low", maxTokens: 8000, signal });
    for (const x of data.records || []) {
      const r = part[Number(x.n) - 1];
      if (!r) continue;
      const s = String(x.suggestion || "").toLowerCase();
      onResult(r.key, { s: ["include", "exclude", "unsure"].includes(s) ? s : "unsure", why: clip(x.reason, 300), model, at: new Date().toISOString() });
    }
    onProgress((done += part.length), records.length);
  });
}

/* Whether the words a model quotes are in the record: the same letters and digits in the same order, any spacing,
   capitals or punctuation; a quote in pieces ("…") needs every piece. */
const plain = (s) => ` ${String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
function quoted(quote, r) {
  const hay = plain(`${r.title} ${r.abstract}`);
  const pieces = String(quote || "").split(/\.\.\.|…/).map((p) => plain(p).trim()).filter((p) => p.length >= 2);
  return pieces.length > 0 && pieces.every((p) => hay.includes(` ${p} `));
}
const NOT_REPORTED = /^(not reported|not stated|none|n\/a|unknown|not given|not specified)?\.?$/i;
export const DETAILS = [["design", "Study design"], ["country", "Country or setting"], ["sample_size", "Sample size"], ["population", "Population"]];

/* Study details from the abstracts, ten records to a request; onResult(key, { design: { value, quote, ok }, …, model,
   at }) where ok is true when the quoted words are in the record, false when they are not, null when not reported. */
export async function extractDetails(records, { signal, onResult = () => {}, onProgress = () => {} } = {}) {
  let done = 0;
  await pool(chunks(records, 10), 2, async (part) => {
    const prompt = `Records:\n\n${part.map(recordText).join("\n\n")}\n\nGive one entry for each of the ${part.length} records, with its number.`;
    const { data, model } = await aiAsk({ task: "extract", system: PROMPTS.extract, prompt, schema: SCHEMAS.extract, name: "study_details", effort: "low", maxTokens: 12000, signal });
    for (const x of data.records || []) {
      const r = part[Number(x.n) - 1];
      if (!r) continue;
      const out = { model, at: new Date().toISOString() };
      for (const [k] of DETAILS) {
        const v = x[k] || {};
        const value = clip(v.value, 200), quote = clip(v.quote, 400);
        out[k] = NOT_REPORTED.test(value) ? { value: "not reported", quote: "", ok: null } : { value, quote, ok: quoted(quote, r) };
      }
      onResult(r.key, out);
    }
    onProgress((done += part.length), records.length);
  });
}

/* An answer from the abstracts of records; the citations [n] that point to none of them are counted and marked. */
export async function answerQuestion(question, records, { signal } = {}) {
  const prompt = `Question: ${String(question).trim()}\n\nAbstracts:\n\n${records.map(recordText).join("\n\n")}`;
  const { data, model } = await aiAsk({ task: "answer", system: PROMPTS.answer, prompt, schema: SCHEMAS.answer, name: "answer", effort: "medium", maxTokens: 16000, signal });
  const answer = String(data.answer || "").trim();
  const cited = new Set(), bad = new Set();
  for (const m of answer.matchAll(/\[([\d\s,;–-]+)\]/g)) {
    for (const n of citedNumbers(m[1])) (n >= 1 && n <= records.length ? cited : bad).add(n);
  }
  return { answer, cited: [...cited].sort((a, b) => a - b), bad: [...bad], model, at: new Date().toISOString() };
}
/* "2, 5" or "3–6" -> the numbers */
function citedNumbers(s) {
  const out = [];
  for (const part of s.split(/[,;]/)) {
    const m = part.trim().match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (m) { for (let n = Number(m[1]); n <= Math.min(Number(m[2]), Number(m[1]) + 50); n++) out.push(n); }
    else if (/^\d+$/.test(part.trim())) out.push(Number(part.trim()));
  }
  return out;
}

/* More English terms for a keyword: [{ term, why }]. */
export async function suggestTerms(keyword, existing, others = [], { signal } = {}) {
  const prompt = `Concept: ${keyword}\nTerms already searched for it: ${existing.slice(0, 60).join("; ") || "none"}\n`
    + `The search's other concepts, for context only: ${others.join("; ") || "none"}\n\nSuggest up to 12 new terms for the concept.`;
  const { data, model } = await aiAsk({ task: "terms", system: PROMPTS.terms, prompt, schema: SCHEMAS.terms, name: "search_terms", effort: "low", maxTokens: 6000, signal });
  const seen = new Set(existing.map(norm));
  const terms = (data.terms || []).map((t) => ({ term: clip(t.term, 100), why: clip(t.why, 200) })).filter((t) => t.term && !seen.has(norm(t.term)) && seen.add(norm(t.term)));
  return { terms: terms.slice(0, 12), model };
}

/* How one record relates to the question: one or two sentences. */
export async function howItMatches(question, r, { signal } = {}) {
  const prompt = `The researcher's question: ${String(question).trim()}\n\nThe study:\n${recordText(r, 0)}`;
  const { data, model } = await aiAsk({ task: "match", system: PROMPTS.match, prompt, schema: SCHEMAS.match, name: "match_note", effort: "low", maxTokens: 4000, signal });
  return { note: clip(data.note, 600), model };
}

/* ------------------------------------------------------------------ connecting to OpenRouter without pasting a key */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/* OpenRouter's sign-in (OAuth with PKCE): the visitor approves Research Finder there and comes back with a key of
   their own, with the spending limit they set. The current search's address is kept to return to. */
export async function connectOpenRouter(remember) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  try { sessionStorage.setItem("rf.orPkce", JSON.stringify({ verifier, state, remember: Boolean(remember), back: location.hash })); }
  catch { toast("This browser does not let the page remember the sign-in (private window?): paste a key instead.", 6000); return; }
  const back = `${location.origin}${location.pathname}`;
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(back)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
}
/* On coming back from OpenRouter: the address is put back as it was at once, then the code is exchanged for the key. */
export function aiReturn() {
  const p = new URLSearchParams(location.search);
  const code = p.get("code");
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem("rf.orPkce") || "null"); } catch { /* none */ }
  if (!code || !pending) return null;
  try { sessionStorage.removeItem("rf.orPkce"); } catch { /* private window */ }
  history.replaceState(null, "", `${location.pathname}${pending.back || ""}`);
  if (p.get("state") && p.get("state") !== pending.state) {
    toast("OpenRouter's answer did not match this page's request, so no key was kept.", 6000);
    return null;
  }
  return (async () => {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/auth/keys", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: "S256" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.key) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
      setAiKey("openrouter", j.key, pending.remember);
      setAiService("openrouter");
      toast("Connected to OpenRouter: the AI helpers are ready (Settings › AI helpers).", 6000);
      return true;
    } catch (e) {
      toast(`OpenRouter did not give a key: ${e.message}`, 6000);
      return false;
    }
  })();
}

/* ------------------------------------------------------------------ Settings */
/* The form in Settings: service, key (and "remember"), model, a check of the key, and what a visit has used. */
export function aiSettings() {
  const box = h("div", { class: "ai-settings" });
  const draw = () => {
    const s = aiService();
    const service = h("select", { id: "ai-service", onchange: (e) => { setAiService(e.target.value); draw(); } },
      h("option", { value: "" }, "None"), Object.entries(SERVICES).map(([k, v]) => h("option", { value: k, selected: k === s }, v.name)));
    const parts = [h("label", { for: "ai-service", class: "tools-label" }, "Service"), service];
    if (s) {
      const sv = SERVICES[s];
      const key = h("input", { type: "password", id: "ai-key", autocomplete: "off", spellcheck: "false", value: aiKey(s), placeholder: `your API key (${sv.hint})` });
      const remember = h("input", { type: "checkbox", checked: aiRemembered(s) });
      const list = h("datalist", { id: "ai-models" });
      const model = h("input", { type: "text", id: "ai-model", list: "ai-models", autocomplete: "off", spellcheck: "false", value: aiModel(s), class: "finder-input" });
      const status = h("p", { class: "note", role: "status" });
      const check = async (again = true) => {
        setAiKey(s, key.value, remember.checked);
        if (!key.value.trim()) { fill(status, "No key: the AI helpers are off."); return; }
        fill(status, spinner(), ` Checking the key with ${sv.name.replace(/ \(.*\)$/, "")}…`);
        try {
          const out = await aiCheck(s, key.value.trim(), again);
          fill(list, out.list.slice(0, 600).map((m) => h("option", { value: m })));
          const has = out.list.includes(aiModel(s));
          const credit = out.info && out.info.limit != null ? ` Spending limit on this key: $${Number(out.info.limit).toFixed(2)}${out.info.usage != null ? `, used $${Number(out.info.usage).toFixed(2)}` : ""}.` : "";
          fill(status, `Works: ${plural(out.list.length, "model")} ${out.list.length === 1 ? "is" : "are"} open to this key. `,
            has || !out.list.length ? `The helpers use ${aiModel(s)}.` : h("strong", {}, `The model “${aiModel(s)}” is not in this key's list: choose one from the list.`), credit);
        } catch (e) {
          fill(status, `This key does not work: ${e.message}.`);
        }
      };
      key.addEventListener("change", () => setAiKey(s, key.value, remember.checked));
      remember.addEventListener("change", () => setAiKey(s, key.value, remember.checked));
      model.addEventListener("change", () => { setAiModel(s, model.value); model.value = aiModel(s); });
      parts.push(
        h("label", { for: "ai-key", class: "tools-label" }, "Your key"),
        h("p", { class: "note" }, "Create one at ", h("a", { href: sv.keys, target: "_blank", rel: "noopener noreferrer" }, sv.keys.replace(/^https:\/\//, "")),
          s === "openrouter" ? ", or connect without pasting one." : ", ideally a key for this use alone, with a low spending limit."),
        h("div", { class: "relay-row" }, key, h("button", { type: "button", class: "btn btn-small", onclick: () => check(true) }, "Check")),
        s === "openrouter" ? h("p", {}, h("button", { type: "button", class: "btn btn-small", onclick: () => connectOpenRouter(remember.checked) }, "Connect with OpenRouter"),
          h("span", { class: "note" }, " You approve Research Finder at OpenRouter, set a spending limit there, and come back with a key of your own.")) : null,
        h("label", { class: "f-option" }, remember, "Remember the key in this browser"),
        h("label", { for: "ai-model", class: "tools-label" }, "Model"), model, list,
        h("p", { class: "note" }, "“Check” lists the models open to your key. Larger models cost more for long runs; the cost of each run is estimated before it starts."),
        status,
        aiKey(s) ? h("p", {}, h("button", { type: "button", class: "btn btn-small", onclick: () => { setAiKey(s, "", false); draw(); toast("The key is forgotten in this browser."); } }, "Forget the key")) : null);
      if (aiKey(s)) setTimeout(() => check(false), 0);
    }
    const used = usageText();
    if (used) parts.push(h("p", { class: "note" }, used));
    fill(box, parts);
  };
  draw();
  return [
    h("p", { class: "note" }, "Optional. With a key of your own for an AI service, helpers can suggest screening decisions against your criteria, take study details out of the abstracts, answer a question from the abstracts of the first results, suggest more search terms and say how a study relates to your question. They suggest; you decide. Nothing is included or excluded by them."),
    box,
    h("p", { class: "note" }, "What a helper needs, the titles, abstracts and keywords involved and your criteria or question, goes from this page straight to the service you choose, which bills you for it; its terms decide what it keeps (some free plans use what you send to improve their models). Unless you ask to remember the key, it is forgotten when you close this tab, and it is never put in a save, an export or an address. Independent tests found that AI tools miss many relevant studies and make more errors than people when they take data out of studies: check what they suggest. The service, the model and the date go into Search details."),
  ];
}

/* ------------------------------------------------------------------ for "Search details" */
const dayText = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
/* The AI uses of this visit (tasks given, or all), as list items, and the prompts they used. */
export function aiDetails(esc, tasks = Object.keys(TASK_NAMES)) {
  const list = aiUses().filter((u) => tasks.includes(u.task));
  if (!list.length) return { steps: "", prompts: "" };
  const steps = list.map((u) => `<li><b>${esc(TASK_NAMES[u.task])} (AI).</b> ${esc(SERVICES[u.service].name)}, model ${esc(u.model)}, on ${esc(dayText(u.first))}: ${plural(u.requests, "request")}, ${fmt(u.input)} tokens in and ${fmt(u.output)} out${u.cost != null ? ` (${esc(money(u.cost))})` : ""}. Suggestions only, checked by the reviewers; the prompt is below.</li>`).join("");
  const prompts = `<h2>AI prompts</h2><p>The instructions each AI helper gave the model (the records, criteria or question followed them in the same request):</p>${[...new Set(list.map((u) => u.task))].map((t) => `<p><b>${esc(TASK_NAMES[t])}:</b> ${esc(PROMPTS[t])}</p>`).join("")}`;
  return { steps, prompts };
}

/* ------------------------------------------------------------------ the dialogs: study details, and questions */
/* ctx (from the search page): results() → the records loaded; question() → the keywords as a question; link(href,
   text, title); download(name, text, type, message); settings() opens Settings. */
let ctx = null;
export const setAiContext = (c) => { ctx = c; };
function dialog(title) {
  const d = $("#ai");
  fill($("#ai-title"), title);
  if (!d.open) d.showModal();
  return $("#ai-body");
}
const slimRecord = (r) => ({ key: r.key, title: r.title || "", abstract: r.full || r.abstract || "", keywords: r.keywords || [], year: r.year || "", doi: r.doi || "",
  url: r.url || r.landing || "" });
const withAbstract = () => ctx.results().filter((r) => r.full || r.abstract).map(slimRecord);
const hrefOf = (r) => (r.doi ? `https://doi.org/${r.doi}` : /^https?:\/\//.test(r.url || "") ? r.url : "");
const today = () => new Date().toISOString().slice(0, 10);
const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function notReady(body) {
  fill(body, h("p", {}, "The AI helpers need a key of your own for Claude (Anthropic), OpenAI, Gemini (Google) or OpenRouter, which you add under Settings › AI helpers. The key stays in this browser, and you pay the service for what you use."),
    h("p", {}, h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => { $("#ai").close(); ctx.settings(); } }, "Set up in Settings")));
}

/* The question the helpers work with: the one asked in "Ask the results", or else the keywords. */
export const aiQuestion = () => local.get("aiQuestion", "") || (ctx ? ctx.question() : "");

/* Study details kept for this visit, for the table, the CSV and the columns of saves and exports. */
const details = new Map();       // record key -> { design, country, sample_size, population: { value, quote, ok }, model, at }
export const detailsCount = () => details.size;
export const DETAIL_COLUMNS = ["Study design (AI, from the abstract)", "Country or setting (AI)", "Sample size (AI)", "Population (AI)"];
export const detailCells = (r) => {
  const d = details.get(r.key);
  return DETAILS.map(([k]) => (!d ? "" : d[k].ok === false ? `${d[k].value} [these words are not in the abstract: “${d[k].quote}”]` : d[k].value));
};

export function openExtract() {
  const body = dialog("Study details from the abstracts (AI)");
  if (!aiReady()) return notReady(body);
  const recs = withAbstract();
  if (!recs.length) { fill(body, h("p", {}, "None of the results loaded has an abstract to read.")); return; }
  const sizes = [...new Set([10, 25, 50, 100, 200].filter((n) => n < recs.length).concat(recs.length))];
  const count = h("select", { "aria-label": "How many studies" },
    sizes.map((n) => h("option", { value: n, selected: n === Math.min(25, recs.length) || (recs.length < 25 && n === recs.length) }, n === recs.length ? `all ${fmt(n)} loaded with an abstract` : `the first ${fmt(n)}`)));
  const todo = () => recs.slice(0, Number(count.value)).filter((r) => !details.has(r.key));
  const est = h("p", { class: "note" });
  const out = h("div", { class: "tools-out" });
  const go = h("button", { type: "button", class: "btn btn-small btn-primary" }, "Take out the details");
  const stop = h("button", { type: "button", class: "btn btn-small", hidden: true }, "Stop");
  let ctrl = null;
  const update = async () => {
    const t = todo();
    if (!t.length) { fill(est, "These studies have their details already."); return; }
    fill(est, estimateText(await estimate("extract", promptChars(t), t.length, Math.ceil(t.length / 10))));
  };
  const cell = (v) => (!v ? h("td") : h("td", { class: v.ok === false ? "ai-unverified" : "" }, v.value,
    v.ok === false ? h("span", { class: "ai-flag", title: "Research Finder did not find these words in the abstract" }, " ⚠ words not in the abstract") : null,
    v.quote ? h("small", { class: "ai-quote" }, `“${clip(v.quote, 160)}”`) : null));
  const table = (msg = "") => {
    const done = recs.filter((r) => details.has(r.key));
    const bad = done.reduce((n, r) => n + DETAILS.filter(([k]) => details.get(r.key)[k].ok === false).length, 0);
    const model = done.length ? details.get(done[0].key).model : "";
    fill(out, msg ? h("p", { class: "note warn" }, msg) : null,
      done.length ? [
        h("p", {}, `${plural(done.length, "study", "studies")} with details from ${model}. `, bad ? h("strong", {}, `${plural(bad, "value")} came with words that are not in the abstract (marked ⚠): check them first. `) : "Every value's words were found in its abstract. ",
          "Hover or read the small print for the words each value comes from."),
        h("div", { class: "tools-actions" }, h("button", { type: "button", class: "btn btn-small", onclick: () => downloadDetails(done) }, "Download (CSV)"),
          h("span", { class: "note" }, " The four columns are also added to the sheet of your next save to Google Drive and to the CSV export.")),
        h("div", { class: "ai-table-wrap", tabindex: "0", role: "region", "aria-label": "Study details" }, h("table", { class: "ai-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Study"), DETAILS.map(([, name]) => h("th", {}, name)))),
          h("tbody", {}, done.map((r) => h("tr", {}, h("td", {}, hrefOf(r) ? ctx.link(hrefOf(r), clip(r.title, 140)) : clip(r.title, 140), r.year ? ` (${r.year})` : ""),
            DETAILS.map(([k]) => cell(details.get(r.key)[k])))))))] : null);
  };
  const downloadDetails = (done) => {
    const head = ["No.", "Title", "Year", "DOI or link", ...DETAILS.flatMap(([, name]) => [name, `${name}: words in the abstract`, `${name}: check`]), "Model", "Date"];
    const rows = done.map((r, i) => {
      const d = details.get(r.key);
      return [i + 1, r.title, r.year, hrefOf(r), ...DETAILS.flatMap(([k]) => [d[k].value, d[k].quote, d[k].ok === null ? "not reported" : d[k].ok ? "words found in the abstract" : "WORDS NOT FOUND in the abstract"]),
        d.model, String(d.at).slice(0, 10)];
    });
    ctx.download(`study-details-ai-${today()}.csv`, "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8", `Exported the details of ${plural(done.length, "study", "studies")}`);
  };
  count.addEventListener("change", update);
  stop.addEventListener("click", () => { if (ctrl) ctrl.abort(); });
  go.addEventListener("click", async () => {
    const t = todo();
    if (!t.length) { table(); return; }
    ctrl = new AbortController();
    go.disabled = true;
    stop.hidden = false;
    const prog = h("p", { class: "note pending" }, spinner(), ` 0 of ${fmt(t.length)} studies…`);
    fill(out, prog);
    try {
      await extractDetails(t, { signal: ctrl.signal, onResult: (k, v) => details.set(k, v), onProgress: (n, of) => fill(prog, spinner(), ` ${fmt(n)} of ${fmt(of)} studies…`) });
      table();
    } catch (e) {
      table(e.kind === "stopped" ? "Stopped. The details taken out so far are kept." : `Stopped: ${e.message}. The details taken out so far are kept.`);
    } finally {
      go.disabled = false;
      stop.hidden = true;
      ctrl = null;
      update();
    }
  });
  fill(body,
    h("p", {}, "The AI reads each abstract and gives the study's design, its country or setting, the sample size and the population, each with the exact words it comes from. Research Finder checks that those words are in the abstract and marks the values whose words it cannot find. What an abstract does not say is “not reported”: abstracts leave much out, and the full text decides."),
    h("div", { class: "cb-row" }, h("span", {}, "Studies"), count, go, stop),
    est,
    h("p", { class: "note" }, `Sent to ${SERVICES[aiService()].who}: the title, abstract and keywords of each study, ten to a request. Model: ${aiModel()}.`),
    out);
  update();
  if (details.size) table();
}

export function openAsk() {
  const body = dialog("Ask the results (AI)");
  if (!aiReady()) return notReady(body);
  const recs = withAbstract();
  if (!recs.length) { fill(body, h("p", {}, "None of the results loaded has an abstract to read.")); return; }
  const q = h("textarea", { rows: 3, id: "ai-question", class: "ai-question", placeholder: "For example: Which effects of social support on depression do these studies report, and in which populations?" });
  q.value = local.get("aiQuestion", "");
  const sizes = [...new Set([10, 20, 30, 50].filter((n) => n < recs.length).concat(Math.min(recs.length, 50)))];
  const count = h("select", { "aria-label": "How many abstracts" },
    sizes.map((n) => h("option", { value: n, selected: n === Math.min(20, recs.length) }, n === recs.length ? `all ${fmt(n)} loaded with an abstract` : `the first ${fmt(n)}`)));
  const est = h("p", { class: "note" });
  const out = h("div", { class: "tools-out", "aria-live": "polite" });
  const go = h("button", { type: "button", class: "btn btn-small btn-primary" }, "Ask");
  const update = async () => {
    const t = recs.slice(0, Number(count.value));
    fill(est, estimateText(await estimate("answer", promptChars(t) + q.value.length, t.length, 1)));
  };
  count.addEventListener("change", update);
  q.addEventListener("change", () => local.set("aiQuestion", q.value.trim() || null));
  go.addEventListener("click", async () => {
    const question = q.value.trim();
    if (!question) { q.focus(); return; }
    local.set("aiQuestion", question);
    const t = recs.slice(0, Number(count.value));
    go.disabled = true;
    fill(out, h("p", { class: "note pending" }, spinner(), ` Asking ${aiModel()} about ${plural(t.length, "abstract")}…`));
    try {
      const a = await answerQuestion(question, t);
      fill(out, answerView(a, t, question));
    } catch (e) {
      fill(out, h("p", { class: "note warn" }, `No answer: ${e.message}.`));
    } finally {
      go.disabled = false;
    }
  });
  fill(body,
    h("p", {}, "Ask a question about the studies found. The AI answers from the abstracts of the first results only, and cites them by number; Research Finder links each citation to its study and marks any that point to no abstract it was given. An answer from abstracts is a first look, not a review: check every study it cites."),
    h("label", { for: "ai-question", class: "tools-label" }, "Your question"), q,
    h("div", { class: "cb-row" }, h("span", {}, "From"), count, go),
    est,
    h("p", { class: "note" }, `Sent to ${SERVICES[aiService()].who}: your question and the title, abstract and keywords of each study. Model: ${aiModel()}.`),
    out);
  update();
}

/* The answer, its citations linked to the studies, the studies cited, and what the check found. */
function answerView(a, recs, question) {
  const link = (n) => {
    const r = recs[n - 1];
    if (!r) return h("span", { class: "ai-bad-cite", title: "No abstract with this number was given" }, `${n}?`);
    return hrefOf(r) ? ctx.link(hrefOf(r), String(n), r.title) : h("span", { title: r.title }, String(n));
  };
  const para = (text) => {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(/\[([\d\s,;–-]+)\]/g)) {
      parts.push(text.slice(last, m.index), "[", citedNumbers(m[1]).map((n, i) => [i ? ", " : "", link(n)]), "]");
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return h("p", {}, parts);
  };
  const copy = async () => {
    const text = `${question}\n\n${a.answer}\n\n${a.cited.map((n) => `[${n}] ${recs[n - 1].title}${recs[n - 1].year ? ` (${recs[n - 1].year})` : ""}${hrefOf(recs[n - 1]) ? ` ${hrefOf(recs[n - 1])}` : ""}`).join("\n")}\n\nAI answer (${a.model}, ${a.at.slice(0, 10)}) from ${recs.length} abstracts found with Research Finder; not checked against the full texts.`;
    try { await navigator.clipboard.writeText(text); toast("Answer copied, with its references"); } catch { window.prompt("Copy the answer:", text); }
  };
  return h("div", { class: "ai-answer" },
    h("p", { class: "tr-tag" }, `AI answer from ${plural(recs.length, "abstract")} (${a.model}, ${dayText(a.at)}), not checked against the full texts`),
    a.answer.split(/\n{2,}/).map((t) => para(t.trim())),
    a.cited.length ? [h("h4", {}, "Studies cited"), h("ol", { class: "ai-cited" }, a.cited.map((n) => h("li", { value: n },
      hrefOf(recs[n - 1]) ? ctx.link(hrefOf(recs[n - 1]), recs[n - 1].title) : recs[n - 1].title, recs[n - 1].year ? ` (${recs[n - 1].year})` : "")))] : h("p", { class: "note" }, "The answer cites none of the abstracts."),
    h("p", { class: a.bad.length ? "note warn" : "note" }, a.bad.length
      ? `${plural(a.bad.length, "citation")} pointed to no abstract that was given (${a.bad.join(", ")}) and ${a.bad.length === 1 ? "is" : "are"} marked “?”: treat what ${a.bad.length === 1 ? "it supports" : "they support"} as unsupported.`
      : `Each citation points to one of the ${plural(recs.length, "abstract")} given.`),
    h("div", { class: "tools-actions" }, h("button", { type: "button", class: "btn btn-small", onclick: copy }, "Copy the answer")));
}
