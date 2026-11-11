/* English for results in other languages: a title's translation is shown under it in [brackets], and an abstract is
   translated when asked. Both come from Wikimedia's open machine translation (MinT), the service that translates the
   search terms, and the page says wherever it shows one that it is an automatic translation, not a professional one:
   enough to see what a study is about, not to quote it or to decide on it.
   A title's translation is checked by translating it back. For a short title, machine translation sometimes writes a
   sentence of its own ("The report also highlights…"); a translation whose back-translation shares almost nothing with
   the original is tried once more, written as a sentence or not, and if it fails again it is not shown. */
import { local, norm } from "./util.js?v=33";
import { LANG_NAMES, MINT, mint } from "./terms.js?v=33";

const MIN_OVERLAP = 0.2;       // share of the original's letter groups its back-translation must have
const SUSPECT_OVERLAP = 0.4;   // the same, for a translation that looks made up
const CHUNK = 16;              // titles in one request
const ENDS = /[.!?。！？…]$/;

export const translationsOn = () => local.get("titlesEn", true) !== false;

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

/* An all-capitals title in ordinary capitals, and with a full stop when it is to be read as a sentence. */
function prepare(title, lang, sentence) {
  let t = title.replace(/\s+/g, " ").trim();
  const upper = (t.match(/\p{Lu}/gu) || []).length, lower = (t.match(/\p{Ll}/gu) || []).length;
  if (upper > 12 && upper > 2.3 * lower) t = t.toLowerCase().replace(/^\P{L}*\p{L}/u, (m) => m.toUpperCase());
  if (sentence && !ENDS.test(t)) t += lang === "zh" || lang === "ja" ? "。" : ".";
  return t;
}

/* No full stop the title did not have, and nothing to show when the title already says it in English. */
function finish(title, text) {
  text = String(text || "").replace(/\s+/g, " ").trim().replace(/\s+([?!:;,.])/g, "$1").replace(/\s+(['’]s)\b/g, "$1");
  if (!ENDS.test(title.trim())) text = text.replace(/(?<!\.)[.。]$/, "");
  const own = new Set(norm(title).split(" "));
  const words = norm(text).split(" ").filter((w) => w.length >= 3);
  if (!words.length || words.filter((w) => own.has(w)).length >= 0.7 * words.length) return "";
  return text;
}

/* ------------------------------------------------------------------ translating titles */
let memo = null;               // "pl|title" -> [English, 1 when it passed the check]
const memory = () => memo || (memo = new Map(Object.entries(local.get("tt", {}))));
const remember = () => local.set("tt", Object.fromEntries([...memory()].slice(-1500)));
const failing = new Map();     // language -> requests that went unanswered this session

/* A title translated before: {text, ok}; text is "" when there is nothing to add to the title. */
export function knownTitle(lang, title) {
  const v = memory().get(`${lang}|${title}`);
  return v ? { text: v[0], ok: Boolean(v[1]) } : undefined;
}

async function attempt(lang, titles, sentence) {
  const out = await mint(titles.map((t) => prepare(t, lang, sentence)), lang, "en");
  if (!out) return null;
  const back = await mint(out.map((o) => o || "-"), "en", lang);
  return out.map((text, i) => ({ text, score: back ? overlap(titles[i], back[i]) : 1, suspect: suspect(titles[i], text || "") }));
}
const passes = (r) => Boolean(r.text) && r.score >= (r.suspect ? SUSPECT_OVERLAP : MIN_OVERLAP);

/* One request for up to CHUNK titles in one language, another to translate them back; a title that fails the check
   is tried once more the other way (Chinese titles do better without a full stop, the others with one). A title the
   translation only repeats (often an English title filed under another language) has nothing to show. */
async function translateChunk(lang, titles) {
  const sentence = lang !== "zh";
  const first = await attempt(lang, titles, sentence);
  if (!first) return null;
  const same = (r, i) => Boolean(r.text) && !finish(titles[i], r.text);
  const again = titles.map((t, i) => i).filter((i) => !same(first[i], i) && !passes(first[i]));
  if (again.length) {
    const second = await attempt(lang, again.map((i) => titles[i]), !sentence);
    if (second) {
      again.forEach((i, k) => {
        const r = second[k];
        if (same(r, i) || passes(r) || (r.text && !first[i].text) || (r.score > first[i].score && r.suspect <= first[i].suspect)) first[i] = r;
      });
    }
  }
  return first.map((r, i) => (same(r, i) ? ["", 1] : passes(r) ? [finish(titles[i], r.text), 1] : ["", 0]));
}

const waiting = new Map();     // "pl|title" -> {lang, title, done: [callbacks]}
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
  for (const j of jobs) byLang.set(j.lang, [...(byLang.get(j.lang) || []), j]);
  for (const [lang, list] of byLang) for (let i = 0; i < list.length; i += CHUNK) chunks.push([lang, list.slice(i, i + CHUNK)]);
  await pool(chunks, 3, async ([lang, list]) => {
    const res = (failing.get(lang) || 0) >= 2 ? null : await translateChunk(lang, list.map((j) => j.title));
    if (!res) failing.set(lang, (failing.get(lang) || 0) + 1);
    list.forEach((j, i) => {
      const v = res ? res[i] : null;
      if (v) memory().set(`${lang}|${j.title}`, v);
      j.done.forEach((f) => f(v ? { text: v[0], ok: Boolean(v[1]) } : null));
    });
  });
  remember();
}

/* The English of a title: {text, ok}, or null when the translation service could not be reached. Titles asked for
   together are sent together, by language. */
export function translateTitle(lang, title) {
  const known = knownTitle(lang, title);
  if (known) return Promise.resolve(known);
  const key = `${lang}|${title}`;
  return new Promise((resolve) => {
    const job = waiting.get(key) || { lang, title, done: [] };
    job.done.push(resolve);
    waiting.set(key, job);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { running = running.then(flush, flush); }, 60);
  });
}

/* ------------------------------------------------------------------ translating an abstract */
const abstracts = new Map();   // for this session
/* The English of an abstract (its first 6,000 characters), or null when the translation service did not answer. */
export async function translateText(lang, text) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (text.length > 6000) text = `${text.slice(0, 6000).replace(/\s+\S*$/, "")} …`;
  const key = `${lang}|${text}`;
  if (abstracts.has(key)) return abstracts.get(key);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(`${MINT}/${lang}/en/MinT`, { method: "POST", body: new URLSearchParams({ html: `<p>${esc(text)}</p>` }), signal: ctrl.signal });
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
