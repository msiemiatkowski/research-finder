/* From what people type to groups of search terms. Each comma-separated keyword becomes a group:
   - the words as typed;
   - when they name a known topic, its synonyms and its names in 39 other languages, from Wikidata;
   - the other wordings studies use for the same thing, read from the titles and abstracts of the 200 studies in
     OpenAlex that match it best ("trust in scientists" or "trustworthiness of science" for "trust in science"), with
     related phrases and the keywords of those studies offered as suggestions;
   - machine translations of the English terms into the 39 languages (Wikimedia's MinT), each checked by translating
     it back into English.
   Every term can be switched on or off; translations follow the chosen search languages. */
import { getJSON, local, norm, openalexJSON, openalexRefusal } from "./util.js?v=27";

export const LANG_NAMES = {
  pl: "Polish", de: "German", fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch", sv: "Swedish",
  da: "Danish", no: "Norwegian", fi: "Finnish", et: "Estonian", cs: "Czech", sk: "Slovak", sl: "Slovenian", hr: "Croatian",
  sr: "Serbian", bg: "Bulgarian", mk: "Macedonian", ru: "Russian", uk: "Ukrainian", el: "Greek", lt: "Lithuanian",
  lv: "Latvian", hu: "Hungarian", ro: "Romanian", ca: "Catalan", tr: "Turkish", ar: "Arabic", fa: "Persian", he: "Hebrew",
  hi: "Hindi", zh: "Chinese", ja: "Japanese", ko: "Korean", id: "Indonesian", ms: "Malay", vi: "Vietnamese", th: "Thai",
};
export const LANGS = Object.keys(LANG_NAMES);
/* when a search has to be shortened, translations into the languages with the most research are kept first */
export const LANG_PRIORITY = ["es", "fr", "de", "pt", "zh", "ru", "ja", "it", "pl", "tr", "ko", "ar", "nl", "id", "fa", "sv",
  "cs", "uk", "hu", "ro", "da", "no", "fi", "el", "he", "hr", "sr", "sk", "sl", "bg", "lt", "lv", "et", "mk", "ca", "ms", "vi",
  "th", "hi"];
export const SRC_LABEL = { you: "your words", alias: "synonym (Wikidata)", variant: "wording used in studies",
  similar: "related phrase in studies", studies: "keyword of studies (OpenAlex)", wikidata: "translation (Wikidata)",
  mt: "machine translation (Wikimedia MinT)" };
/* A term in another language than English (English terms have no language, or "en"). */
export const isTranslation = (t) => Boolean(LANG_NAMES[t.lang]);
export const SAMPLE = 200;                  // studies read for the wordings of each keyword
const MT_MAX = 8;                           // English terms translated at once; others when they are switched on

let termSeq = 0, groupSeq = 0;

const STOP = new Set(("a an and are as at be between by do does for from has have how in into is it its of on or the their " +
  "to towards what when which who why with without about among across after before during over under vs versus").split(" "));
/* The words of a long entry that carry its meaning. */
export function mainWords(text) {
  const ws = String(text).replace(/["\\()]/g, " ").trim().split(/\s+/);
  const keep = ws.filter((w) => !STOP.has(w.toLowerCase()));
  return keep.length ? keep : ws;
}

export function parseInput(input) {
  return String(input || "").split(/[,;\n]+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function makeGroup(label) {
  const g = { id: ++groupSeq, label, terms: [], seen: new Set(), edit: false, status: "pending", stage: "", related: [],
    notes: [], mtCount: 0 };
  // up to four words are a term ("trust in science") and searched as a phrase; a longer entry is a description,
  // searched by its main words
  addTerm(g, label, "you", "", 1, true, { loose: label.split(" ").length >= 5 });
  return g;
}

function addTerm(g, text, src, lang, w, on, extra = {}) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  const key = norm(text);
  if (!key || g.seen.has(key) || text.length > 120) return null;
  g.seen.add(key);
  const t = { i: ++termSeq, text, src, lang, w, on, ...extra };
  g.terms.push(t);
  return t;
}

/* The terms a search uses: those switched on, translations only in the chosen languages. */
export function activeTerms(g, langsOff) {
  return g.terms.filter((t) => t.on && !(isTranslation(t) && langsOff.has(t.lang)));
}

/* ------------------------------------------------------------------ Wikidata */
const WD = "https://www.wikidata.org/w/api.php";
const NOT_A_TOPIC = /\b(scientific article|scholarly article|article|journal|periodical|book|thesis|album|film|song|episode|family name|given name|surname|Wikimedia|painting|research project|conference|clinical trial|software|video game|web page|website)\b/i;
const SCRIPTS = [
  [/[Ѐ-ӿ]/, ["ru", "uk", "bg"]], [/[Ͱ-Ͽ]/, ["el"]], [/[؀-ۿ]/, ["ar", "fa"]], [/[֐-׿]/, ["he"]],
  [/[぀-ヿ]/, ["ja"]], [/[一-鿿]/, ["zh", "ja"]], [/[가-힯]/, ["ko"]], [/[฀-๿]/, ["th"]],
  [/[ऀ-ॿ]/, ["hi"]], [/[ąćęłńśźż]/i, ["pl"]], [/[äöüß]/i, ["de", "sv", "fi"]], [/[čřěůšž]/i, ["cs", "sk", "hr"]],
  [/[şğı]/i, ["tr"]], [/[őű]/i, ["hu"]], [/[ãõ]/i, ["pt"]], [/[ñ¿¡]/i, ["es"]], [/[éèêëàâîïôûç]/i, ["fr"]], [/[åæø]/i, ["da", "no", "sv"]],
];

function guessLanguages(text) {
  const out = [];
  for (const [re, ls] of SCRIPTS) if (re.test(text)) out.push(...ls);
  const own = (navigator.language || "en").slice(0, 2).toLowerCase();
  return [...new Set(["en", ...out, own])].slice(0, 3);
}
/* No letters of another script or alphabet: the words can be taken as English. */
const looksEnglish = (text) => !SCRIPTS.some(([re]) => re.test(text));

/* The Wikidata item named exactly as typed (or with it as a synonym), not a publication or a person: its English
   synonyms and its names in the other languages. A synonym that is only part of the name is broader ("water" for
   "drinking water") and is left out; in other languages only the name is used, as their synonyms are often broader
   words. */
async function wikidata(term) {
  for (const lang of guessLanguages(term)) {
    const s = await getJSON(`${WD}?action=wbsearchentities&search=${encodeURIComponent(term)}&language=${lang}&uselang=en&type=item&limit=6&format=json&origin=*`);
    const words = norm(term).split(" ").length;
    const hit = (s.search || []).find((x) => norm((x.match || {}).text || x.label) === norm(term)
      && !NOT_A_TOPIC.test(x.description || "") && norm(x.label || "").split(" ").length <= words + 3);
    if (!hit) continue;
    const want = [...LANGS.map((l) => (l === "no" ? "nb" : l)), "en"].join("|");
    const e = await getJSON(`${WD}?action=wbgetentities&ids=${hit.id}&props=labels|aliases|descriptions&languages=${want}&languagefallback=0&format=json&origin=*`);
    const ent = (e.entities || {})[hit.id];
    if (!ent) continue;
    const names = {};
    for (const [l, v] of Object.entries(ent.labels || {})) names[l === "nb" ? "no" : l] = [v.value];
    for (const [l, vs] of Object.entries(ent.aliases || {})) {
      const k = l === "nb" ? "no" : l;
      const label = ` ${norm((names[k] || [""])[0])} `;
      const keep = vs.map((v) => v.value).filter((a) => a.length > 3 && !label.includes(` ${norm(a)} `));
      if (k === "en") names.en = [...(names.en || []), ...keep.slice(0, 6)];
    }
    return { id: hit.id, label: (ent.labels.en || {}).value || hit.label, description: (ent.descriptions.en || {}).value || hit.description || "",
      names, matchedIn: (hit.match || {}).language || lang };
  }
  return null;
}

/* ------------------------------------------------------------------ OpenAlex: the studies on a keyword */
function openalexParams() {
  const p = new URLSearchParams();
  const key = local.get("openalexKey", ""), mail = local.get("email", "");
  if (key) p.set("api_key", key);
  if (mail) p.set("mailto", mail);
  return p;
}

/* The studies that match the keyword best in their titles and abstracts (one request): their texts show how the
   topic is worded, their keywords what it is studied with. */
async function studySample(g) {
  const core = g.terms.filter((t) => t.on && !isTranslation(t) && ["you", "alias", "mt"].includes(t.src)).slice(0, 6)
    .map((t) => (t.loose ? `(${mainWords(t.text).join(" AND ")})` : `"${t.text.replace(/["\\]/g, " ")}"`).replace(/[,|]/g, " "));
  const p = openalexParams();
  p.set("filter", `title_and_abstract.search:${core.length > 1 ? `(${core.join(" OR ")})` : core[0]}`);
  p.set("per-page", String(SAMPLE));
  p.set("select", "display_name,abstract_inverted_index,keywords");
  const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 30000 });
  return { total: j.meta.count, works: j.results || [] };
}

/* ------------------------------------------------------------------ the wordings studies use */
const FUNCTION = new Set([...STOP, ..."this that these those than then there were was been being not no can could may might will would should our we they them his her he she you your i my also both such more most less other some any each all one two three new whether although though while because since through via per however thus toward".split(" ")]);
const LINK = new Set("in of a an the about on for to toward towards".split(" "));
/* words that make a phrase a sentence fragment, not a term ("predicted trust", "trust scale") */
const VAGUE = new Set(("study studies effect effects role analysis relationship relationships association associations level levels " +
  "result results data evidence participant participants sample samples measure measures measurement scale scales research model " +
  "models factor factors use impact high low different based using approach review paper article survey surveys test tests testing " +
  "validation development case group groups people individuals person persons way ways time years year finding findings implication " +
  "implications perspective perspectives context contexts experiment experiments experimental evaluation investigation examination " +
  "exploration predictor predictors outcome outcomes consequence consequences antecedent antecedents correlate correlates link links " +
  "relation relations difference differences change changes trend trends issue issues question questions present current previous " +
  "prior recent general specific various several many increase increases increased increasing decrease decreased higher lower greater " +
  "strong stronger positive negative significant significantly related relevant associated predict predicts predicted predicting reduce " +
  "reduces reduced reducing tendency nature variance single form forms abstract non generic theoretical examine examined examining " +
  "explore explored tested show shows showed found find suggest suggests suggested indicate indicates tend tends cause causes play " +
  "affect affects explain explains explaining").split(" "));
const ADJECTIVE = /(ic|ical|al|ive|ous|ful|less|able|ible)$/;
const NOUN_LIKE = new Set("public topic logic music clinic panic rhetoric epidemic pandemic trial approval journal animal hospital capital potential material signal individual professional survival criminal chemical arrival proposal referral withdrawal rival festival".split(" "));
const ENDING = /^(|s|es|y|ies|e|ed|ing|er|ers)$/;

/* Words of one family: "trust" and "trusted", "science" and "scientists", "study" and "studies". */
function family(a, b) {
  if (a === b || a + "s" === b || b + "s" === a || a + "es" === b || b + "es" === a) return true;
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a[p] === b[p]) p++;
  if (p >= 4 && ENDING.test(a.slice(p)) && ENDING.test(b.slice(p))) return true;
  return p >= 5 && p >= n - 3;
}
const inflect = (w) => w.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
const tokens = (text) => String(text).toLowerCase().replace(/[\u2010-\u2015-]/g, " ").split(/[^\p{L}\p{N}']+/u)
  .map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, "")).filter(Boolean);
const clauses = (text) => String(text).split(/[.!?;:,()[\]{}"“”‘’«»/]+/).map(tokens).filter((c) => c.length > 1);
const contains = (hay, needle) => {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((x, j) => hay[i + j] === x)) return true;
  return false;
};

function abstractText(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) words[p] = w;
  return words.filter(Boolean).join(" ");
}

function keywordOf(text) {
  const all = tokens(text);
  return { all, words: all.filter((w) => !FUNCTION.has(w)), sig: all.map(inflect) };
}

/* How a phrase relates to the keyword: "same" (another form of it), "narrower" (it, with more words), "variant"
   (all its words, in any form and order, and at most one more), "related" (it shares a word), or "". */
function relation(k, words) {
  const sig = words.map(inflect);
  if (sig.join(" ") === k.sig.join(" ")) return "same";
  if (contains(sig, k.sig)) return "narrower";
  const content = words.filter((x) => !FUNCTION.has(x));
  if (!content.some((x) => k.words.some((w) => family(w, x)))) return "";
  const used = new Set();
  const hasAll = k.words.every((w) => {
    const i = content.findIndex((x, j) => !used.has(j) && family(w, x));
    if (i >= 0) used.add(i);
    return i >= 0;
  });
  const extra = content.filter((x, j) => !used.has(j));
  if (k.words.length >= 2 && hasAll && extra.length <= 1 && !extra.some((x) => VAGUE.has(x))) return "variant";
  return "related";
}

/* The wordings of a keyword in the titles and abstracts of studies on it:
   - variants: all the keyword's words, in any form and order, with at most one more word ("trust in scientists",
     "trustworthiness of science" for "trust in science"); they are searched too;
   - related phrases: two or three words sharing a word with the keyword ("public trust", "epistemic trust"); offered.
   Phrases that only add words to the keyword ("public trust in science") are narrower and add nothing to a search. */
function wordings(k, works) {
  if (!k.words.length || !works.length) return { variants: [], related: [] };
  const df = new Map(), forms = new Map();
  const longest = Math.min(5, k.all.length + 3);
  for (const w of works) {
    const seen = new Set();
    for (const c of clauses(`${w.display_name || ""}. ${abstractText(w.abstract_inverted_index)}`)) {
      for (let n = 2; n <= longest; n++) {
        for (let i = 0; i + n <= c.length; i++) {
          const g = c.slice(i, i + n);
          if (FUNCTION.has(g[0]) || FUNCTION.has(g[n - 1]) || g.some((x) => /^\d{1,2}$/.test(x))) continue;
          const inner = g.filter((x) => FUNCTION.has(x));
          if (inner.length > 2 || inner.some((x) => !LINK.has(x))) continue;
          if (!g.some((x) => !FUNCTION.has(x) && k.words.some((kw) => family(kw, x)))) continue;
          const s = g.map(inflect).join(" "), text = g.join(" ");
          if (!seen.has(s)) { seen.add(s); df.set(s, (df.get(s) || 0) + 1); }
          const f = forms.get(s) || new Map();
          f.set(text, (f.get(text) || 0) + 1);
          forms.set(s, f);
        }
      }
    }
  }
  const size = works.length;
  const min = { variant: Math.max(2, Math.round(size * 0.01)), longer: Math.max(3, Math.round(size * 0.02)), related: Math.max(3, Math.round(size * 0.02)) };
  const cands = [...df].map(([s, n]) => {
    const text = [...forms.get(s)].sort((a, b) => b[1] - a[1])[0][0];
    return { n, text, sig: s.split(" "), words: text.split(" ") };
  }).sort((a, b) => a.sig.length - b.sig.length || b.n - a.n);
  const variants = [], related = [];
  for (const c of cands) {
    const rel = relation(k, c.words);
    if (rel !== "variant" && rel !== "related") continue;
    const last = c.words[c.words.length - 1];
    if (ADJECTIVE.test(last) && !NOUN_LIKE.has(last)) continue;              // cut off: "trust in scientific"
    const shorter = variants.find((v) => contains(c.sig, v.sig));
    if (shorter && c.n < 0.5 * shorter.n) continue;                          // a variant with a word added, rarely
    const content = c.words.filter((x) => !FUNCTION.has(x));
    const extra = content.filter((x) => !k.words.some((kw) => family(kw, x)));
    if (rel === "variant") {
      if (c.n >= (extra.length ? min.longer : min.variant)) variants.push(c);
    } else if (k.words.length >= 2 && content.length === c.words.length && content.length <= 3 && c.n >= min.related
      && extra.length && !extra.some((x) => VAGUE.has(x)) && !(/(ing|ed)$/.test(c.words[0]) && extra.includes(c.words[0]))
      && !shorter && !variants.some((v) => contains(v.sig, c.sig))) {
      related.push(c);
    }
  }
  const top = (list, n) => list.sort((a, b) => b.n - a.n).slice(0, n).map((c) => ({ text: c.text, n: c.n }));
  return { variants: top(variants, 12), related: top(related, 12) };
}

function keywordCounts(works) {
  const counts = new Map();
  for (const w of works) for (const kw of w.keywords || []) counts.set(kw.display_name, (counts.get(kw.display_name) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/* ------------------------------------------------------------------ machine translation */
const MINT = "https://cxserver.wikimedia.org/v2/translate";
let memo = null;                    // "pl|trust in science" -> [translation, passed the check]
const memory = () => memo || (memo = new Map(Object.entries(local.get("mt", {}))));
const remember = () => local.set("mt", Object.fromEntries([...memory()].slice(-3000)));

/* Wikimedia's open machine translation (MinT): many terms in one request, as the items of a list. */
async function mint(texts, from, to) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${MINT}/${from}/${to}/MinT`, {
      method: "POST", body: new URLSearchParams({ html: `<ul>${texts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` }), signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const items = [...new DOMParser().parseFromString(j.contents || "", "text/html").querySelectorAll("li")]
      .map((li) => li.textContent.replace(/\s+/g, " ").trim());
    return items.length === texts.length ? items : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* A translation is kept when translating it back gives another of the keyword's English terms, or the English words
   again in any form, at least half of them, with none lost: "elderly adults" for "older adults" passes, "adulthood"
   for "older adulthood" does not. */
function sameMeaning(en, back, english) {
  if (english.has(norm(back))) return true;
  const want = tokens(en).filter((w) => !FUNCTION.has(w)), got = tokens(back).filter((w) => !FUNCTION.has(w));
  const hit = want.filter((w) => got.some((b) => family(w, b))).length;
  return hit === want.length || (hit > 0 && hit * 2 >= want.length && got.length >= want.length);
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/* Machine translations of the group's English terms that are switched on (the first eight; others when they are
   switched on), into all 39 languages. */
export async function translateGroup(g, { onProgress = () => {} } = {}) {
  const sources = g.terms.filter((t) => t.on && !isTranslation(t) && !t.translated && !t.loose && (t.src !== "you" || g.youEnglish)
    && !(t.src === "variant" && t.n < 3 && !t.picked)).slice(0, MT_MAX);
  if (!sources.length) return 0;
  for (const s of sources) {
    s.translated = true;
    if (s.of == null) s.of = g.mtCount++;
  }
  const english = new Set(g.terms.filter((t) => !isTranslation(t)).map((t) => norm(t.text)));
  const m = memory();
  let done = 0, added = 0;
  await pool(LANGS, 12, async (lang) => {
    const todo = sources.filter((s) => !m.has(`${lang}|${s.text}`));
    if (todo.length) {
      const out = await mint(todo.map((s) => s.text), "en", lang);
      const back = out && (await mint(out, lang, "en"));
      if (out) todo.forEach((s, i) => m.set(`${lang}|${s.text}`, [out[i], back ? sameMeaning(s.text, back[i], english) : true]));
    }
    for (const s of sources) {
      const [text, ok] = m.get(`${lang}|${s.text}`) || [];
      if (text && addTerm(g, text, "mt", lang, 0.8, ok, { of: s.of, doubt: !ok, source: s.text })) added++;
    }
    onProgress(++done, LANGS.length);
  });
  remember();
  return added;
}

/* ------------------------------------------------------------------ all together */
/* Wikidata first (synonyms and names in other languages), then the wordings and keywords of the studies, then the
   machine translations. A step that fails leaves the group as it was, with a note. */
export async function enrich(g, { live = true, onChange = () => {} } = {}) {
  const stage = (text) => { g.stage = text; onChange(); };
  stage("Looking the topic up in Wikidata…");
  try {
    const wd = await wikidata(g.label);
    if (wd) {
      g.wikidata = wd;
      g.terms[0].loose = false;           // a known topic: its name is searched as a phrase
      for (const a of (wd.names.en || []).slice(0, 5)) addTerm(g, a, "alias", "en", 0.95, true);
      for (const l of LANGS) (wd.names[l] || []).slice(0, 3).forEach((t, i) => addTerm(g, t, "wikidata", l, 0.9, true, { of: i }));
    }
  } catch (e) {
    g.notes.push(`Wikidata: ${e.message}`);
  }
  g.youEnglish = looksEnglish(g.label) && (!g.wikidata || g.wikidata.matchedIn === "en");
  if (!g.youEnglish && !g.wikidata) {     // another language and no known topic: into English first
    const from = guessLanguages(g.label).find((l) => LANG_NAMES[l]);
    const out = from ? await mint([g.label], from, "en") : null;
    if (out) addTerm(g, out[0], "mt", "en", 0.9, true, { from });
  }
  if (live) {
    stage(`Reading how the ${SAMPLE} best-matching studies word it…`);
    try {
      const st = await studySample(g);
      g.studies = { total: st.total, read: st.works.length };
      const base = g.youEnglish ? g.label : (g.wikidata ? g.wikidata.label : (g.terms.find((t) => t.src === "mt") || {}).text);
      if (base && !g.terms[0].loose) {
        const k = keywordOf(base);
        const w = wordings(k, st.works);
        w.variants.forEach((v, i) => addTerm(g, v.text, "variant", "en", 0.9, i < 6, { n: v.n }));
        for (const r of w.related) addTerm(g, r.text, "similar", "en", 0.8, false, { n: r.n });
        const counts = keywordCounts(st.works);
        for (const [text, n] of counts.slice(0, 40)) {
          const rel = relation(k, tokens(text));
          if (rel === "variant") addTerm(g, text, "variant", "en", 0.9, n >= 0.05 * st.works.length, { n });
          else if (rel === "related" || rel === "") addTerm(g, text, "studies", "", 0.85, false, { n });
        }
        g.related = counts.filter(([text]) => relation(k, tokens(text)) === "").slice(0, 12).map(([text, n]) => ({ text, n }));
      } else {
        g.related = keywordCounts(st.works).filter(([text]) => norm(text) !== norm(g.label)).slice(0, 12).map(([text, n]) => ({ text, n }));
        for (const x of g.related) addTerm(g, x.text, "studies", "", 0.85, false, { n: x.n });
      }
    } catch (e) {
      g.notes.push(openalexRefusal(e) || `OpenAlex: ${e.message}`);
    }
  }
  stage("Translating the terms into 39 languages…");
  try {
    await translateGroup(g, { onProgress: (n, of) => stage(`Translating the terms into other languages: ${n} of ${of}…`) });
  } catch (e) {
    g.notes.push(`Translation: ${e.message}`);
  }
  g.stage = "";
  g.status = "done";
  onChange();
  return g;
}
