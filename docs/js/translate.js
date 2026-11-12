/* Translations of results in other languages, into English or the language the reader chooses (Settings): a title's
   translation is shown under it in [brackets], and an abstract is translated when asked. Both come from Wikimedia's open machine translation (MinT), the service that translates the
   search terms, and the page says wherever it shows one that it is an automatic translation, not a professional one:
   enough to see what a study is about, not to quote it or to decide on it.
   A title's translation is checked by translating it back. For a short title, machine translation sometimes writes a
   sentence of its own ("The report also highlights…"); a translation whose back-translation shares too little with
   the original, or that opens or repeats itself the way those sentences do, is tried again (as a sentence or not, then
   after the word for "title"), and if it still fails it is not shown.
   Into a language other than English, a title or abstract in a third language goes through English, which machine
   translation does far better: Chinese and Japanese titles translated straight into Polish often come out as
   sentences of their own, and through English they mostly do not. */
import { local, norm } from "./util.js?v=43";
import { LANG_NAMES, MINT, mint } from "./terms.js?v=43";

const MIN_OVERLAP = 0.2;       // share of the original's letter groups its back-translation must have
const SUSPECT_OVERLAP = 0.4;   // the same, for a translation that looks made up
const CHUNK = 16;              // titles in one request
const ENDS = /[.!?。！？…]$/;

export const translationsOn = () => local.get("titlesEn", true) !== false;
/* The language results are translated into: English, or another the reader chooses. */
export const readingLanguage = () => {
  const l = local.get("readLang", "en");
  return l === "en" || LANG_NAMES[l] ? l : "en";
};

let names = null;
/* "Polish" for pl, and the name of any other language the browser knows. */
export function languageName(code) {
  if (LANG_NAMES[code]) return LANG_NAMES[code];
  try { names = names || new Intl.DisplayNames(["en"], { type: "language" }); return names.of(code) || code; } catch { return code; }
}

/* ------------------------------------------------------------------ which language a text is in */
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Arabic", "Hebrew", "Han", "Hiragana", "Katakana", "Hangul", "Thai", "Lao",
  "Khmer", "Myanmar", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam",
  "Sinhala", "Georgian", "Armenian", "Ethiopic", "Tibetan"].map((s) => [s, new RegExp(`\\p{Script=${s}}`, "gu")]);
/* the languages each script is written in, the most common first */
const BY_SCRIPT = {
  Cyrillic: ["ru", "uk", "bg", "sr", "mk", "be", "kk", "ky", "mn", "tg", "tt", "ba", "uz"],
  Arabic: ["ar", "fa", "ur", "ps", "ku", "ckb", "sd", "ug"], Devanagari: ["hi", "mr", "ne", "sa"], Bengali: ["bn", "as"],
  Hebrew: ["he", "yi"], Ethiopic: ["am", "ti"], Greek: ["el"], Thai: ["th"], Lao: ["lo"], Khmer: ["km"], Myanmar: ["my"],
  Gurmukhi: ["pa"], Gujarati: ["gu"], Oriya: ["or"], Tamil: ["ta"], Telugu: ["te"], Kannada: ["kn"], Malayalam: ["ml"],
  Sinhala: ["si"], Georgian: ["ka"], Armenian: ["hy"], Tibetan: ["bo"],
};
const NOT_LATIN = new Set([...Object.values(BY_SCRIPT).flat(), "zh", "ja", "ko"]);
const latinScript = (l) => !NOT_LATIN.has(l) || ["sr", "uz", "ku", "tk"].includes(l);

/* Letters only some Cyrillic alphabets have, and the languages that use them (the likeliest first). */
const CYRILLIC_LETTERS = [[/[ѓќѕ]/, ["mk"]], [/[ђћ]/, ["sr"]], [/[їєґ]/, ["uk"]], [/ұ/, ["kk"]], [/җ/, ["tt"]], [/[ҡҙҫ]/, ["ba"]],
  [/[ӣӯҷ]/, ["tg"]], [/ә/, ["kk", "tt", "ba"]], [/ў/, ["be", "uz"]], [/[қғҳ]/, ["kk", "uz", "tg"]], [/ң/, ["ky", "kk", "tt", "ba"]],
  [/[өү]/, ["mn", "ky", "kk", "tt", "ba"]], [/[јљњџ]/, ["sr", "mk"]], [/і/, ["uk", "be", "kk"]]];
function cyrillic(text, claimed) {
  const t = text.toLowerCase();
  let fits = null;               // the languages whose alphabet has every special letter of the text
  for (const [re, langs] of CYRILLIC_LETTERS) if (re.test(t)) fits = fits ? fits.filter((l) => langs.includes(l)) : langs;
  if (fits && fits.includes(claimed)) return claimed;
  if (fits && fits.length) return fits[0];
  if (BY_SCRIPT.Cyrillic.includes(claimed)) return claimed;
  return /[ыэё]/.test(t) || !/ъ\p{L}/u.test(t) ? "ru" : "bg";          // Bulgarian has no ы or э, and ъ inside words
}

function arabic(text, claimed) {
  if (BY_SCRIPT.Arabic.includes(claimed)) return claimed;
  if (/[ٹڈڑںےھ]/.test(text)) return "ur";
  return /[پچژگکی]/.test(text) ? "fa" : "ar";
}

/* Words that mark a title as English, and the small words of other languages written in Latin letters. */
const ENGLISH = new Set(("the of and for with from on at its their this these those into during after before between among " +
  "through within without toward towards using based how what why which who does were been than not").split(" "));
const WORDS = Object.fromEntries(Object.entries({
  es: "el la los las de del y en por para con una un sobre entre como su sus al que se estudio análisis",
  pt: "o os as do da dos das e em no na nos nas por para com uma um sobre entre como seu sua ao à que se estudo análise",
  fr: "le la les des du et en dans pour par sur une un aux au chez entre selon étude analyse",
  de: "der die das den dem des und im mit für von zur zum bei über auf eine ein einer eines als aus durch",
  it: "il lo la gli le di del della delle dei degli e nel nella per con su tra una un al alla studio analisi",
  nl: "de het een van en op voor met bij naar door over tussen onderzoek",
  pl: "w i z na do się oraz dla od po przez jako jest wpływ badanie analiza",
  cs: "a v ve na z do se pro od jako při",
  sk: "a v na z do sa pre od ako pri",
  sv: "och i på av för med en ett som till om från hos",
  da: "og i på af for med en et som til om fra hos",
  no: "og i på av for med en et som til om fra hos",
  fi: "ja sekä on tai kanssa mukaan välillä",
  et: "ja on ning kui või",
  hu: "a az és egy vagy hogy mint között",
  ro: "și în de la cu pe din pentru o un al ale unei unui",
  tr: "ve bir ile için bu da de olarak üzerine",
  id: "dan yang di dari pada dengan untuk dalam terhadap sebagai oleh",
  hr: "i u na za od s sa o kao ili",
  sl: "in v na za od z s o kot ali",
  ca: "el la els les de del i en per amb una un als",
  lt: "ir su iš į kaip apie",
  lv: "un ar no uz par kā",
  vi: "và của các trong cho với những một là",
}).map(([l, ws]) => [l, new Set(ws.split(" "))]));
const MARKS = { es: /[ñ¿¡]/, pt: /[ãõ]/, fr: /[œèêëîïûù]/, de: /[äöüß]/, pl: /[ąęłśźżćń]/, cs: /[řůě]/, sk: /[ľĺŕô]/,
  hu: /[őű]/, ro: /[șțăâ]/, tr: /[ğış]/, sv: /å/, lt: /[ėįų]/, lv: /[āēīķļņģ]/,
  vi: /[ơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/ };

function latin(text, claimed) {
  const low = text.toLowerCase();
  const words = new Set(low.match(/\p{L}+/gu) || []);
  let english = 0;
  for (const w of words) if (ENGLISH.has(w)) english++;
  const score = (l) => {
    let n = 0;
    if (WORDS[l]) for (const w of words) if (WORDS[l].has(w)) n++;
    return n + (MARKS[l] && MARKS[l].test(low) ? 2 : 0);
  };
  if (claimed && claimed !== "en" && latinScript(claimed)) {     // trust the record, unless the words are English
    const own = score(claimed);
    return (english >= 2 && english > own) || (english && !own) ? "" : claimed;
  }
  if (english) return "";
  let best = "", top = 0, second = 0;
  for (const l of Object.keys(WORDS)) {
    const s = score(l);
    if (s > top) { second = top; top = s; best = l; } else if (s > second) second = s;
  }
  return top >= 2 && top > second ? best : "";
}

/* The language to translate a text from ("" for English, or when it is not clear). The record's language helps, but
   does not decide: OpenAlex leaves many empty, and gives some English titles another language. */
export function languageOf(text, claimed = "") {
  text = String(text || "");
  claimed = /^[a-z]{2,3}$/.test(claimed || "") ? claimed : "";
  if (!text || text === "(untitled)") return "";
  const counts = {};
  let letters = 0;
  for (const [s, re] of SCRIPTS) {
    const n = (text.match(re) || []).length;
    if (n) { counts[s] = n; letters += n; }
  }
  if (!letters) return "";
  const share = (...ss) => ss.reduce((n, s) => n + (counts[s] || 0), 0) / letters;
  if (share("Latin") >= 0.6) return latin(text, claimed);
  if ((counts.Hiragana || counts.Katakana) && share("Han", "Hiragana", "Katakana") >= 0.5) return "ja";
  if (counts.Hangul && share("Hangul", "Han") >= 0.5) return "ko";
  if (share("Han") >= 0.5) return ["zh", "ja", "ko"].includes(claimed) ? claimed : "zh";
  if (share("Cyrillic") >= 0.5) return cyrillic(text, claimed);
  if (share("Arabic") >= 0.5) return arabic(text, claimed);
  for (const [s, langs] of Object.entries(BY_SCRIPT)) if (share(s) >= 0.5) return langs.includes(claimed) ? claimed : langs[0];
  return "";
}

/* ------------------------------------------------------------------ the check */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/* Groups of letters: pairs in scripts written without spaces, threes within words in the others (so that small
   words such as "de" or "la", which most titles in a language share, count for nothing). */
function groups(s) {
  s = s.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const out = new Set();
  if (NO_SPACES.test(s)) {
    const cs = [...s.replace(/\s+/g, "")];
    for (let i = 0; i < cs.length - 1; i++) out.add(cs[i] + cs[i + 1]);
    return out;
  }
  for (const w of s.split(" ")) {
    const cs = [...w];
    for (let i = 0; i < cs.length - 2; i++) out.add(cs[i] + cs[i + 1] + cs[i + 2]);
  }
  return out;
}
function overlap(original, back) {
  const a = groups(original), b = groups(back);
  if (!a.size) return 1;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / a.size;
}

/* What made-up translations of short titles tend to look like: an opening such as "The report also highlights" or
   "I'm not sure", or the same words again and again ("The data set is the data set of the data set"). */
const SUSPECT_START = /^(and |but |so |i['’]m |i am |i don['’]t |we['’]re |we are going |you['’]re |the (first|second) is\b|the following\b|the report\b|the commission\b|this is (a|the|not)\b|it['’]s (a|not|the)\b)/i;
const SMALL = new Set("the and for with from that this its are was were has have not but".split(" "));
function repeats(text) {
  const counts = new Map();
  for (const w of norm(text).split(" ")) if (w.length >= 3 && !SMALL.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  let twice = 0, most = 0;
  for (const n of counts.values()) { if (n >= 2) twice++; most = Math.max(most, n); }
  return { twice, most };
}
function suspect(original, text) {
  if (SUSPECT_START.test(text)) return true;
  const o = NO_SPACES.test(original) ? { twice: 0, most: 1 } : repeats(original), t = repeats(text);
  return (t.most >= 3 && t.most > o.most) || (t.twice >= 2 && t.twice > o.twice);
}

/* The word for "title" in the commonest languages: "Titel: …" makes machine translation read a short title as one
   ("Title: Communication of science in crisis") where it would otherwise make up a sentence. */
const TITLE_WORD = { de: "Titel", nl: "Titel", da: "Titel", sv: "Titel", no: "Tittel", fi: "Otsikko", et: "Pealkiri",
  pt: "Título", es: "Título", ca: "Títol", fr: "Titre", it: "Titolo", ro: "Titlu", pl: "Tytuł", cs: "Název", sk: "Názov",
  sl: "Naslov", hr: "Naslov", sr: "Наслов", bg: "Заглавие", mk: "Наслов", ru: "Название", uk: "Назва", be: "Назва",
  lt: "Pavadinimas", lv: "Nosaukums", hu: "Cím", el: "Τίτλος", tr: "Başlık", ar: "العنوان", fa: "عنوان", he: "כותרת",
  hi: "शीर्षक", zh: "论文题目", ja: "論文のタイトル", ko: "논문 제목", id: "Judul", ms: "Tajuk", vi: "Tiêu đề", th: "ชื่อเรื่อง" };
const TITLED = /^\s*(the\s+)?((paper|article|study)\s+)?(title|heading|headline)(\s+of\s+(the|this|a)\s+(paper|article|study|work|thesis))?(\s+is)?\s*[:：.\-–—]\s*/i;

/* An all-capitals title in ordinary capitals; then, by mode, with a full stop ("sentence"), as it is ("plain"), or
   after the word for "title" ("titled"). */
function prepare(title, lang, mode) {
  let t = title.replace(/\s+/g, " ").trim();
  const upper = (t.match(/\p{Lu}/gu) || []).length, lower = (t.match(/\p{Ll}/gu) || []).length;
  if (upper > 12 && upper > 2.3 * lower) t = t.toLowerCase().replace(/^\P{L}*\p{L}/u, (m) => m.toUpperCase());
  if (mode === "titled") return `${TITLE_WORD[lang]}${lang === "zh" || lang === "ja" ? "：" : ": "}${t}`;
  if (mode === "sentence" && !ENDS.test(t)) t += lang === "zh" || lang === "ja" ? "。" : ".";
  return t;
}

/* No sentence and no full stop the title did not have ("LingVaria. What is it?" for the journal LingVaria), and
   nothing to show when the title already says it in English. */
function finish(title, text) {
  text = String(text || "").replace(/\s+/g, " ").trim().replace(/\s+([?!:;,.])/g, "$1").replace(/\s+(['’]s)\b/g, "$1");
  if (!/[.!?。！？]\s/.test(title)) {
    const first = text.match(/^(.*?\p{L}{4,}[.!?])\s+\p{Lu}/u);
    if (first) text = first[1];
  }
  if (!ENDS.test(title.trim())) text = text.replace(/(?<!\.)[.。]$/, "");
  const own = new Set(norm(title).split(" "));
  const words = norm(text).split(" ").filter((w) => w.length >= 3);
  if (!words.length || words.filter((w) => own.has(w)).length >= 0.7 * words.length) return "";
  return text;
}

/* ------------------------------------------------------------------ translating titles */
let memo = null;               // "pl|title" (into English) or "en>pl|title" -> [translation, 1 when it passed the check]
const memory = () => memo || (memo = new Map(Object.entries(local.get("tt", {}))));
const memoKey = (lang, title, to = readingLanguage()) => (to === "en" ? `${lang}|${title}` : `${lang}>${to}|${title}`);
const remember = () => local.set("tt", Object.fromEntries([...memory()].slice(-1500)));
const failing = new Map();     // language -> requests that went unanswered this session

/* A title translated before: {text, ok}; text is "" when there is nothing to add to the title. */
export function knownTitle(lang, title) {
  const v = memory().get(memoKey(lang, title));
  return v ? { text: v[0], ok: Boolean(v[1]) } : undefined;
}

async function attempt(lang, titles, mode, to) {
  let out = await mint(titles.map((t) => prepare(t, lang, mode)), lang, to);
  if (!out) return null;
  // a "titled" translation counts only when it kept the word ("Title: …"), which then goes
  if (mode === "titled") out = out.map((o) => (TITLED.test(o || "") ? o.replace(TITLED, "") : ""));
  const back = await mint(out.map((o) => o || "-"), to, lang);
  return out.map((text, i) => ({ text, score: back ? overlap(titles[i], back[i]) : 1, suspect: suspect(titles[i], text || "") }));
}
const passes = (r) => Boolean(r.text) && r.score >= (r.suspect ? SUSPECT_OVERLAP : MIN_OVERLAP);

/* One request for up to CHUNK titles in one language, another to translate them back; a title that fails the check
   is tried again another way: Chinese titles do better as they are, the others with a full stop, and a title that
   still fails goes after the word for "title" (into English only). For each title: {text, verdict}, the verdict
   "same" when the translation only repeats it (often an English title filed under another language), "ok" when it
   passed the check, "fail" when it did not. */
async function translateChunk(lang, titles, to) {
  // the word for "title" is recognised only in English translations
  const modes = (lang === "zh" ? ["plain", "sentence", "titled"] : ["sentence", "plain", "titled"]).filter((m) => m !== "titled" || to === "en");
  const best = await attempt(lang, titles, modes[0], to);
  if (!best) return null;
  const same = (r, i) => Boolean(r.text) && !finish(titles[i], r.text);
  for (const mode of modes.slice(1)) {
    if (mode === "titled" && !TITLE_WORD[lang]) break;
    const again = titles.map((t, i) => i).filter((i) => !same(best[i], i) && !passes(best[i]));
    if (!again.length) break;
    const next = await attempt(lang, again.map((i) => titles[i]), mode, to);
    if (!next) continue;
    again.forEach((i, k) => {
      const r = next[k];
      if (same(r, i) || passes(r) || (r.text && !best[i].text) || (r.score > best[i].score && r.suspect <= best[i].suspect)) best[i] = r;
    });
  }
  return best.map((r, i) => ({ text: r.text, verdict: same(r, i) ? "same" : passes(r) ? "ok" : "fail" }));
}

/* What is remembered of each title: [translation, 1], ["", 1] when there is nothing to add, ["", 0] when the
   translation failed the check; null when the service did not answer. Into English or from English, one step; from a
   third language, through English: the English translation, checked and remembered as such, is translated in turn
   and checked against itself. */
async function translatePair(lang, titles, to) {
  if (lang === "en" || to === "en") {
    const res = await translateChunk(lang, titles, to);
    return res && res.map((r, i) => (r.verdict === "same" ? ["", 1] : r.verdict === "ok" ? [finish(titles[i], r.text), 1] : ["", 0]));
  }
  const missing = titles.filter((t) => !memory().has(memoKey(lang, t, "en")));
  if (missing.length) {
    const res = await translatePair(lang, missing, "en");
    if (!res) return null;
    missing.forEach((t, i) => memory().set(memoKey(lang, t, "en"), res[i]));
  }
  // the English of each title; a title its English translation only repeats is in English already
  const via = titles.map((t) => { const [text, ok] = memory().get(memoKey(lang, t, "en")); return ok ? text || t : null; });
  const go = titles.map((t, i) => i).filter((i) => via[i] !== null);
  const res = go.length ? await translateChunk("en", go.map((i) => via[i]), to) : [];
  if (!res) return null;
  const out = titles.map(() => ["", 0]);
  go.forEach((i, k) => { if (res[k].verdict !== "fail") out[i] = [finish(titles[i], res[k].text), 1]; });
  return out;
}

const waiting = new Map();     // "pl|title" -> {lang, to, title, done: [callbacks]}
let flushTimer = 0, running = Promise.resolve();

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function flush() {
  const jobs = [...waiting.values()];
  waiting.clear();
  const chunks = [];
  const byLang = new Map();
  for (const j of jobs) byLang.set(`${j.lang}>${j.to}`, [...(byLang.get(`${j.lang}>${j.to}`) || []), j]);
  for (const list of byLang.values()) for (let i = 0; i < list.length; i += CHUNK) chunks.push([list[0].lang, list[0].to, list.slice(i, i + CHUNK)]);
  await pool(chunks, 3, async ([lang, to, list]) => {
    const pair = `${lang}>${to}`;
    const res = (failing.get(pair) || 0) >= 2 ? null : await translatePair(lang, list.map((j) => j.title), to);
    if (!res) failing.set(pair, (failing.get(pair) || 0) + 1);
    list.forEach((j, i) => {
      const v = res ? res[i] : null;
      if (v) memory().set(memoKey(lang, j.title, to), v);
      j.done.forEach((f) => f(v ? { text: v[0], ok: Boolean(v[1]) } : null));
    });
  });
  remember();
}

/* A title in the reader's language: {text, ok}, or null when the translation service could not be reached. Titles
   asked for together are sent together, by language. */
export function translateTitle(lang, title) {
  const known = knownTitle(lang, title);
  if (known) return Promise.resolve(known);
  const to = readingLanguage(), key = memoKey(lang, title, to);
  return new Promise((resolve) => {
    const job = waiting.get(key) || { lang, to, title, done: [] };
    job.done.push(resolve);
    waiting.set(key, job);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { running = running.then(flush, flush); }, 60);
  });
}

/* ------------------------------------------------------------------ for sheets and files */
const langOf = new WeakMap();
/* The language to translate a text from into the reader's language: "" when it is in that language already, or when
   it is not clear. Into another language than English, a text in Latin letters that looks like no other language
   counts as English. */
export function translateFrom(text, claimed = "") {
  const to = readingLanguage();
  let from = languageOf(text, claimed);
  if (!from && to !== "en" && text && text !== "(untitled)") {
    const t = String(text);
    const latin = (t.match(/\p{Script=Latin}/gu) || []).length, letters = (t.match(/\p{L}/gu) || []).length;
    if (letters && latin >= 0.6 * letters) from = "en";
  }
  return from === to ? "" : from;
}
/* The language to translate a record's title from, worked out once per record and reading language. */
export function titleLanguage(r) {
  const to = readingLanguage();
  if (!langOf.has(r) || langOf.get(r)[0] !== to) langOf.set(r, [to, translateFrom(r.title, r.lang)]);
  return langOf.get(r)[1];
}

/* A record's title in the reader's language, when it is in another language and its translation passed the check
   (named for English, the first language it translated into). */
export function englishTitle(r) {
  const from = titleLanguage(r);
  const known = from ? knownTitle(from, r.title) : null;
  return known && known.ok ? known.text : "";
}

/* Titles one save or export translates at most: 2,000 into English, 500 into another language (nearly every title then
   needs a translation, and each takes a request or two to Wikimedia's service). */
export const saveLimit = () => (readingLanguage() === "en" ? 2000 : 500);
/* Translates the titles in other languages of many records (for a save or an export) that are not translated yet, at
   most `max`, and says what became of them all: {foreign, shown, failed, same, missing}. */
export async function englishTitles(records, { max = saveLimit(), onProgress = () => {} } = {}) {
  const todo = new Map();
  for (const r of records) {
    const from = titleLanguage(r);
    if (from && !knownTitle(from, r.title)) todo.set(`${from}|${r.title}`, [from, r.title]);
  }
  const now = [...todo.values()].slice(0, max);
  let done = 0;
  if (now.length) onProgress(0, now.length);
  await Promise.all(now.map(([from, title]) => translateTitle(from, title).then(() => onProgress(++done, now.length))));
  const out = { foreign: 0, shown: 0, failed: 0, same: 0, missing: 0 };
  for (const r of records) {
    const from = titleLanguage(r);
    if (!from) continue;
    out.foreign++;
    const known = knownTitle(from, r.title);
    if (!known) out.missing++;
    else if (!known.ok) out.failed++;
    else if (known.text) out.shown++;
    else out.same++;
  }
  return out;
}

/* ------------------------------------------------------------------ translating an abstract */
const abstracts = new Map();   // for this session
/* An abstract (its first 6,000 characters) in the reader's language, through English from a third language, or null
   when the translation service did not answer. */
export async function translateText(lang, text, to = readingLanguage()) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (text.length > 6000) text = `${text.slice(0, 6000).replace(/\s+\S*$/, "")} …`;
  if (lang !== "en" && to !== "en") {
    const english = await translateText(lang, text, "en");
    return english && translateText("en", english, to);
  }
  const key = `${lang}>${to}|${text}`;
  if (abstracts.has(key)) return abstracts.get(key);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(`${MINT}/${lang}/${to}/MinT`, { method: "POST", body: new URLSearchParams({ html: `<p>${esc(text)}</p>` }), signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const out = (new DOMParser().parseFromString(j.contents || "", "text/html").body.textContent || "").replace(/\s+/g, " ").trim();
    if (!out) return null;
    abstracts.set(key, out);
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
