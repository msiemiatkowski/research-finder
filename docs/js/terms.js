/* From what people type to groups of search terms. Each comma-separated keyword becomes a group: the words as
   typed, plus, for any topic,
   - the topic's synonyms and its names in 39 other languages, from Wikidata;
   - the keywords that studies on it actually use, counted by OpenAlex (offered as suggestions).
   Every term can be switched on or off; translations follow the chosen search languages. */
import { getJSON, local, norm, openalexJSON } from "./util.js";

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
export const SRC_LABEL = { you: "your words", alias: "synonym (Wikidata)", wikidata: "translation (Wikidata)",
  studies: "keyword used in studies (OpenAlex)" };

let termSeq = 0, groupSeq = 0;
export const termText = new Map();          // term id -> text, for highlighting

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
  const g = { id: ++groupSeq, label, terms: [], seen: new Set(), edit: false, status: "pending", related: [], notes: [] };
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
  termText.set(t.i, text);
  g.terms.push(t);
  return t;
}

/* The terms a search uses: those switched on, translations only in the chosen languages. */
export function activeTerms(g, langsOff) {
  return g.terms.filter((t) => t.on && !(t.src === "wikidata" && langsOff.has(t.lang)));
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

/* The Wikidata item named exactly as typed (or with it as a synonym), not a publication or a person: its English
   synonyms and its names in the other languages. A synonym that is only part of the name is broader ("water" for
   "drinking water") and is left out. */
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
      names[k] = [...(names[k] || []), ...keep.slice(0, k === "en" ? 6 : 2)];
    }
    return { id: hit.id, label: (ent.labels.en || {}).value || hit.label, description: (ent.descriptions.en || {}).value || hit.description || "", names };
  }
  return null;
}

/* ------------------------------------------------------------------ OpenAlex: the keywords studies use */
function openalexParams() {
  const p = new URLSearchParams();
  const key = local.get("openalexKey", ""), mail = local.get("email", "");
  if (key) p.set("api_key", key);
  if (mail) p.set("mailto", mail);
  return p;
}

async function studyKeywords(g) {
  const core = g.terms.filter((t) => t.on && (t.src === "you" || t.src === "alias")).slice(0, 8)
    .map((t) => (t.loose ? `(${mainWords(t.text).join(" AND ")})` : `"${t.text.replace(/"/g, " ")}"`));
  const p = openalexParams();
  p.set("search", core.join(" OR "));
  p.set("group_by", "keywords.id");
  const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 25000 });
  return { total: j.meta.count, keywords: (j.group_by || []).slice(0, 24).map((x) => ({ text: x.key_display_name, n: x.count })) };
}

/* Wikidata first (synonyms and names in other languages), then the keywords studies use. Errors only leave the
   group as it was, with a note. */
export async function enrich(g, { live = true } = {}) {
  try {
    const wd = await wikidata(g.label);
    if (wd) {
      g.wikidata = wd;
      g.terms[0].loose = false;           // a known topic: its name is searched as a phrase
      for (const a of (wd.names.en || []).slice(0, 8)) addTerm(g, a, "alias", "en", 0.95, true);
      for (const l of LANGS) for (const t of (wd.names[l] || []).slice(0, 3)) addTerm(g, t, "wikidata", l, 0.9, true);
    }
  } catch (e) {
    g.notes.push(`Wikidata: ${e.message}`);
  }
  if (live) {
    try {
      const st = await studyKeywords(g);
      g.studies = st;
      // offered, not added: a narrower keyword adds nothing to the search, a broader or related one changes it
      for (const k of st.keywords) addTerm(g, k.text, "studies", "", 0.85, false, { n: k.n });
      g.related = st.keywords.slice(0, 12);
    } catch (e) {
      g.notes.push(e.status === 429 || e.status === 403
        ? "OpenAlex is limiting free searches right now; a free OpenAlex key (Settings) avoids this."
        : `OpenAlex: ${e.message}`);
    }
  }
  g.status = "done";
  return g;
}
