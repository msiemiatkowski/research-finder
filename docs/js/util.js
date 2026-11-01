/* Small helpers shared by the app's modules. */

export const $ = (s, el = document) => el.querySelector(s);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

export const fmt = (n) => Number(n || 0).toLocaleString("en");
export const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many || one + "s"}`;

const NON_ASCII = /[^\x00-\x7f]/;
const SPECIAL = /[łŀøđßıæœ‐‑‒–—―’ʼ]/g;
const SPECIAL_AS = { "ł": "l", "ŀ": "l", "ø": "o", "đ": "d", "ß": "ss", "ı": "i", "æ": "ae", "œ": "oe", "‐": "-", "‑": "-",
  "‒": "-", "–": "-", "—": "-", "―": "-", "’": "'", "ʼ": "'" };
const PUNCT = /[ -¿ -⁯←-⯿　-〿＀-／]/g;
/* Lower case without accents (the same as in search-worker.js), so "Smoleński" and "smolenski" match. */
export function fold(s) {
  s = String(s || "").toLowerCase();
  if (!NON_ASCII.test(s)) return s;
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(SPECIAL, (c) => SPECIAL_AS[c]).replace(PUNCT, " ");
}
export const norm = (s) => fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function safeUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; }
}

export function stripHtml(html) {
  if (!html || !/[<&]/.test(html)) return html || "";
  return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
}

export function snippet(text, n = 400) {
  text = String(text || "").replace(/\s+/g, " ").trim()
    .replace(/^(abstract|summary|résumé|zusammenfassung|resumen|streszczenie)\b[\s:.\-–—]*/i, "");
  if (text.length <= n) return text;
  return text.slice(0, n).replace(/\s+\S*$/, "").replace(/[\s,;:.]+$/, "") + "…";
}

/* Settings kept in this browser only (an OpenAlex key, which languages to search in...). */
export const local = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`rf.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { if (value == null || value === "") localStorage.removeItem(`rf.${key}`); else localStorage.setItem(`rf.${key}`, JSON.stringify(value)); } catch { /* private window */ }
  },
};

/* fetch() with a time limit and readable errors; answers are cached for the session. */
const cache = new Map();
export async function getJSON(url, { timeout = 20000, headers, cacheable = true } = {}) {
  if (cacheable && cache.has(url)) return cache.get(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let resp;
  try {
    resp = await fetch(url, { signal: ctrl.signal, headers });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `${new URL(url).hostname} did not answer in time` : `could not reach ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 200); } catch { /* none */ }
    const err = new Error(`${new URL(url).hostname} answered HTTP ${resp.status}`);
    err.status = resp.status;
    err.detail = detail;
    throw err;
  }
  const data = await resp.json();
  if (cacheable) {
    if (cache.size > 300) cache.clear();
    cache.set(url, data);
  }
  return data;
}

/* OpenAlex answers at most about one search a second without a key (five with one), and HTTP 429 to bursts:
   its requests go one at a time, spaced out, and a refused one is tried once more. */
let oaChain = Promise.resolve(), oaLast = 0;
export function openalexJSON(url, opts) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  const gap = /[?&]api_key=/.test(url) ? 250 : 1100;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async () => {
    await pause(Math.max(0, oaLast + gap - Date.now()));
    oaLast = Date.now();
    try {
      return await getJSON(url, opts);
    } catch (e) {
      if (e.status !== 429) throw e;
      // "Anonymous search is temporarily rate-limited while the search cluster is under elevated load":
      // OpenAlex says how long to wait
      const wait = Math.min(45, Number((/"retryAfter"\s*:\s*(\d+)/.exec(e.detail || "") || [])[1]) || 3);
      if (wait > 3) toast(`OpenAlex is busy: trying again in ${wait} seconds. A free OpenAlex key (Settings) avoids this.`, wait * 1000);
      await pause(wait * 1000);
      oaLast = Date.now();
      return getJSON(url, opts);
    }
  };
  const p = oaChain.then(run, run);
  oaChain = p.catch(() => {});
  return p;
}

let toastTimer = null;
export function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
