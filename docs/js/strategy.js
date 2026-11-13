/* A check of the search strategy before it is run or copied, and a PRESS packet for its peer review. Most published
   review searches contain errors that lower recall (Salvador-Oliván and colleagues 2019 found them in 92.7% of 137),
   and guidance asks for strategies to be peer reviewed, ideally with PRESS. The check looks at what Research Finder
   knows: the concepts and their terms (British and American spellings, concepts with one term, short or ambiguous
   terms, typed operators and wildcards), how the concepts combine, the limits and filters, and what did not fit. The
   packet lays the strategy out by PRESS's six elements with room for the reviewer's assessment. Nothing here is sent
   anywhere. */
import { h, fill, fmt, plural, norm } from "./util.js?v=44";

/* ------------------------------------------------------------------ British and American spellings */
const PAIRS = `behaviour behavior|behaviours behaviors|behavioural behavioral|colour color|favour favor|favourable favorable|honour honor|
humour humor|labour labor|neighbour neighbor|neighbourhood neighborhood|rumour rumor|vigour vigor|odour odor|tumour tumor|tumours tumors|
harbour harbor|savour savor|centre center|centres centers|fibre fiber|litre liter|metre meter|theatre theater|programme program|
programmes programs|catalogue catalog|dialogue dialog|analogue analog|ageing aging|grey gray|paediatric pediatric|paediatrics pediatrics|
anaemia anemia|anaemic anemic|anaesthesia anesthesia|haemorrhage hemorrhage|haemoglobin hemoglobin|haematology hematology|
leukaemia leukemia|oesophagus esophagus|oesophageal esophageal|oestrogen estrogen|oedema edema|foetus fetus|foetal fetal|diarrhoea diarrhea|
gynaecology gynecology|orthopaedic orthopedic|orthopaedics orthopedics|manoeuvre maneuver|defence defense|offence offense|licence license|
enrolment enrollment|fulfil fulfill|skilful skillful|wilful willful|modelling modeling|counselling counseling|counsellor counselor|
travelling traveling|traveller traveler|labelling labeling|signalling signaling|cancelled canceled|mould mold|sceptical skeptical|
scepticism skepticism|sulphur sulfur|aluminium aluminum|tyre tire|plough plow|jewellery jewelry`
  .split("|").map((p) => p.trim().split(" "));
const UK_US = new Map(), US_UK = new Map();
for (const [uk, us] of PAIRS) { UK_US.set(uk, us); US_UK.set(us, uk); }
// words that end like -ise/-ize but are not that suffix
const NOT_ISE = new Set(("advise arise chastise circumcise comprise compromise concise demise despise devise disguise enterprise excise exercise "
  + "expertise franchise improvise incise merchandise noise otherwise paradise poise praise precise premise promise raise reprise revise rise "
  + "supervise surmise surprise televise treatise wise apprise cruise anise valise mortise tortoise porpoise turquoise cerise chemise advertise bruise "
  + "guise liaise appraise exorcise").split(" "));
const NOT_IZE = new Set("size prize seize maize capsize baize assize oversize resize downsize upsize outsize".split(" "));
const ISE = /^(\p{L}{2,})is(e|ed|es|ing|ation|ations|er|ers|able)$/u, IZE = /^(\p{L}{2,})iz(e|ed|es|ing|ation|ations|er|ers|able)$/u;
const YSE = /^(\p{L}*(?:anal|paral|catal|dial|hydrol|electrol))ys(e|ed|es|ing|er|ers)$/u, YZE = /^(\p{L}*(?:anal|paral|catal|dial|hydrol|electrol))yz(e|ed|es|ing|er|ers)$/u;

/* The other spelling of a word, or "" when it has none here. */
function otherWord(w) {
  if (UK_US.has(w)) return UK_US.get(w);
  if (US_UK.has(w)) return US_UK.get(w);
  let m;
  if ((m = ISE.exec(w)) && !NOT_ISE.has(`${m[1]}ise`) && !NOT_ISE.has(w) && !/wise$/.test(`${m[1]}ise`)) return `${m[1]}iz${m[2]}`;
  if ((m = IZE.exec(w)) && !NOT_IZE.has(`${m[1]}ize`) && !NOT_IZE.has(w)) return `${m[1]}is${m[2]}`;
  if ((m = YSE.exec(w))) return `${m[1]}yz${m[2]}`;
  if ((m = YZE.exec(w))) return `${m[1]}ys${m[2]}`;
  return "";
}
/* The other spelling of a term (every word that has one changed), or "" when no word has one. */
export function otherSpelling(term) {
  const words = String(term).split(/(\s+|-)/);
  let changed = false;
  const out = words.map((w) => {
    const low = w.toLowerCase();
    const o = /^\p{L}+$/u.test(w) ? otherWord(low) : "";
    if (!o) return w;
    changed = true;
    return w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase() ? o[0].toUpperCase() + o.slice(1) : o;
  });
  return changed ? out.join("") : "";
}

/* ------------------------------------------------------------------ the check */
/* s (a snapshot of the search, from the search page): { tab, source, date, mode, total, dropped, fulltext, filters:
   [text], filterKinds: { langs, years, designs, open, kinds, countries }, parts: [{ query, count }], groups: [{ id,
   label, method, wikidata, studies, english: [{ text, src, on }], translations: [{ lang, text, on, doubt }] }] }.
   Each finding: { level: "warn" | "info", text, group, spellings: [variants to add] }. */
export function checkStrategy(s) {
  const out = [];
  for (const g of s.groups) {
    if (g.method) continue;
    const on = g.english.filter((t) => t.on);
    const have = new Set(g.english.map((t) => norm(t.text)));
    const spellings = [...new Set(on.map((t) => otherSpelling(t.text)).filter((v) => v && !have.has(norm(v))))];
    if (spellings.length) {
      out.push({ level: "warn", group: g, spellings,
        text: `“${g.label}”: the other spelling of ${spellings.length === 1 ? "a term is" : "some terms is"} not searched: ${spellings.join("; ")}. British and American spellings are different words to a search engine.` });
    }
    if (on.length === 1 && !g.translations.some((t) => t.on)) {
      out.push({ level: "warn", group: g, text: `“${g.label}” is searched with one term only, in English only. Add synonyms, or the wordings found in studies (Edit terms).` });
    } else if (on.length === 1) {
      out.push({ level: "info", group: g, text: `“${g.label}” has one English term (and its translations): are there synonyms researchers use? Edit terms shows the wordings found in studies.` });
    }
    for (const t of on) {
      if (/[*?]/.test(t.text)) out.push({ level: "warn", group: g, text: `“${t.text}”: OpenAlex has no truncation or wildcards; the * or ? is searched as text. Write out the word forms instead.` });
      if (/\b(AND|OR|NOT|NEAR|ADJ\d*)\b/.test(t.text)) out.push({ level: "warn", group: g, text: `“${t.text}” contains a search operator, which is searched as a word inside a phrase. Give each idea its own keyword (comma-separated); NOT is best avoided in reviews.` });
      const letters = t.text.replace(/[^\p{L}\p{N}]/gu, "");
      if (letters.length <= 3 && !/\s/.test(t.text)) out.push({ level: "info", group: g, text: `“${t.text}” is short: an acronym may also mean other things. Check that the results are about your topic, or search it only with a second keyword.` });
    }
    if (g.studies != null && g.studies === 0) out.push({ level: "warn", group: g, text: `“${g.label}” is in no study's title or abstract in OpenAlex as typed: check the spelling or the wording.` });
  }
  const concepts = s.groups.filter((g) => !g.method).length;
  if (s.mode === "all" && concepts >= 4) out.push({ level: "warn", text: `${plural(concepts, "keyword")} combined with AND: each one more lowers recall. Reviews usually search two or three concepts (for example population and intervention), and screen for the rest.` });
  if (s.mode === "any" && concepts >= 2) out.push({ level: "info", text: "The keywords combine with OR: a study needs only one of them. For a review question this is usually too broad; “all keywords” combines them with AND." });
  if (s.dropped) out.push({ level: "warn", text: `${plural(s.dropped, "term")} did not fit in the search and ${s.dropped === 1 ? "was" : "were"} left out. Fewer languages (Settings), or a free OpenAlex key, make room.` });
  const f = s.filterKinds || {};
  if (f.langs) out.push({ level: "warn", text: "The results are limited by the language of the study. Cochrane advises against language limits: a study in another language can be translated, or listed as awaiting classification." });
  if (f.years) out.push({ level: "info", text: "A year limit is set: say why in your methods (PRISMA-S item 9)." });
  if (f.designs) out.push({ level: "warn", text: "The study-design filter uses OpenAlex's automatic tags, which are not a validated search filter and are missing for many studies (all without an abstract). Use it to find studies, not to leave any out." });
  if (f.open) out.push({ level: "warn", text: "Open access only: studies behind a paywall are left out, which a review should not do." });
  if (f.kinds) out.push({ level: "info", text: "A type limit is set (for example articles only): preprints, theses and reports can hold eligible studies." });
  if (s.fulltext) out.push({ level: "info", text: "Full texts are searched too: other databases cannot repeat such a search, and it finds many studies that only mention a term. Say so in your methods." });
  if (s.total > 20000) out.push({ level: "info", text: `${fmt(s.total)} results: a broad search. More specific terms, or another keyword, would make screening shorter; check first with your studies (Review tools › Check your search) that recall holds.` });
  else if (s.total > 0 && s.total < 30) out.push({ level: "info", text: `Only ${fmt(s.total)} results: a narrow search. Synonyms, the wordings found in studies, or fewer keywords would find more.` });
  return out;
}

/* ------------------------------------------------------------------ the dialog */
export function strategyView(s, { onAddSpellings = () => {}, onPacket = () => {} } = {}) {
  const found = checkStrategy(s);
  const warns = found.filter((x) => x.level === "warn"), infos = found.filter((x) => x.level === "info");
  const item = (x) => h("li", { class: x.level === "warn" ? "warn" : "" }, x.level === "warn" ? "⚠ " : "· ", x.text,
    x.spellings && x.spellings.length ? [" ", h("button", { type: "button", class: "btn btn-small", onclick: (e) => { e.target.disabled = true; onAddSpellings(x.group, x.spellings); } }, x.spellings.length === 1 ? "Add it" : "Add them")] : null);
  return [
    h("p", {}, "Common errors in review searches, checked before you run or copy the search. In one study, 92.7% of 137 published review search strategies had errors, most of them errors that cost recall (",
      h("a", { href: "https://jmla.pitt.edu/ojs/jmla/article/view/567/811", target: "_blank", rel: "noopener noreferrer" }, "Salvador-Oliván and colleagues 2019"), ")."),
    found.length ? h("ul", { class: "strategy-list" }, warns.map(item), infos.map(item)) : h("p", { class: "note" }, "Nothing to point out in what Research Finder can check."),
    h("h3", {}, "Peer review (PRESS)"),
    h("p", {}, "Guidance asks for search strategies to be peer reviewed before they are run, ideally by a librarian or information specialist with the PRESS checklist. The packet lays your strategy out by PRESS's six elements, the concepts and every term, the exact queries with their counts, the limits and this check, with room for the reviewer's assessment of each element."),
    h("div", { class: "tools-actions" }, h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => onPacket(found) }, "Download the PRESS packet")),
    h("p", { class: "note" }, "An HTML file: open it in a word processor or a browser, or upload it to Google Docs, and send it to the reviewer."),
  ];
}

/* ------------------------------------------------------------------ the PRESS packet */
const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SRC_NAMES = { you: "your words", alias: "synonym (Wikidata)", variant: "wording used in studies", similar: "related phrase", studies: "keyword of studies",
  mt: "English translation", ai: "suggested by AI", spelling: "spelling variant", mined: "from your studies" };
const assess = `<p><b>Assessment:</b> [ ] No revision &nbsp; [ ] Revision suggested &nbsp; [ ] Revision required</p><p><b>Comments:</b></p><p>&nbsp;</p>`;

export function pressHtml(s, found, { name = "", reference = "" } = {}) {
  const concepts = s.groups.map((g, i) => {
    const on = g.english.filter((t) => t.on), off = g.english.filter((t) => !t.on);
    const langs = [...new Set(g.translations.filter((t) => t.on).map((t) => t.lang))];
    return `<tr><td>${i + 1}</td><td><b>${esc(g.label)}</b>${g.wikidata ? `<br><small>Wikidata: ${esc(g.wikidata.label)} (${esc(g.wikidata.id)})</small>` : ""}${g.studies != null ? `<br><small>${fmt(g.studies)} studies in OpenAlex with it in the title or abstract</small>` : ""}</td>`
      + `<td>${on.map((t) => `${esc(t.text)} <small>(${esc(SRC_NAMES[t.src] || t.src)})</small>`).join("<br>") || "—"}</td>`
      + `<td>${langs.length ? `${fmt(g.translations.filter((t) => t.on).length)} terms in ${plural(langs.length, "language")}` : "none"}${g.translations.some((t) => t.doubt && !t.on) ? `; ${fmt(g.translations.filter((t) => t.doubt && !t.on).length)} doubtful translations left out` : ""}</td>`
      + `<td>${off.length ? off.slice(0, 30).map((t) => esc(t.text)).join("; ") : "—"}</td></tr>`;
  }).join("");
  const lines = s.parts.map((p, i) => `<tr><td>${i + 1}</td><td><code>${esc(p.query)}</code></td><td>${p.count != null ? fmt(p.count) : "—"}</td></tr>`).join("");
  const checks = found.length ? `<ul>${found.map((x) => `<li>${x.level === "warn" ? "Warning: " : ""}${esc(x.text)}</li>`).join("")}</ul>` : "<p>No findings.</p>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>PRESS packet: ${esc(name)}</title>
<style>body{font:11pt/1.45 Georgia,serif;max-width:900px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:5px;vertical-align:top;text-align:left}code{font-size:9pt;word-break:break-word}small{color:#444}h2{margin-top:28px}</style></head><body>
<h1>Search strategy for peer review (PRESS)</h1>
<p><b>Search:</b> ${esc(name)} · <b>Source:</b> ${esc(s.source)} · <b>Prepared:</b> ${esc(s.date)} with Research Finder (${esc(reference)}) · <b>Records:</b> ${fmt(s.total)}</p>
<p><b>Reviewer:</b> ______________________ &nbsp; <b>Date of review:</b> ____________</p>
<p>PRESS (Peer Review of Electronic Search Strategies, McGowan and colleagues 2016) asks the reviewer to assess six elements. For each, the strategy as it was run is given below, with room for the assessment. Research Finder searches OpenAlex's titles and abstracts${s.fulltext ? " and full texts" : ""}; it has no subject headings, so element 3 concerns the concepts and synonyms instead.</p>
<h2>1. Translation of the research question</h2>
<p><b>Research question:</b> [the authors write it here, for example as PICO]</p>
<p>${plural(s.groups.length, "concept")}, combined with ${s.mode === "all" ? "AND (a study must match every concept)" : "OR (a study may match any concept)"}: ${s.groups.map((g) => `“${esc(g.label)}”`).join(s.mode === "all" ? " AND " : " OR ")}.</p>${assess}
<h2>2. Boolean and proximity operators</h2>
<p>Within a concept its terms are combined with OR, each term a phrase in quotation marks; concepts are combined with ${s.mode === "all" ? "AND" : "OR"}. OpenAlex has no proximity operators. When the terms do not fit in one query (OpenAlex takes about 1,500 characters), the search is split into parts whose results are put together:</p>
<table><tr><th>Line</th><th>Query (OpenAlex, titles and abstracts${s.fulltext ? " and full texts" : ""})</th><th>Records</th></tr>${lines}</table>${assess}
<h2>3. Subject headings (here: concepts and synonyms)</h2>
<p>OpenAlex has no controlled vocabulary. Each keyword was matched to a Wikidata item where one has exactly that name, for synonyms and names in other languages.</p>${assess}
<h2>4. Text word searching (free text)</h2>
<table><tr><th>#</th><th>Concept</th><th>English terms searched (source)</th><th>Translations searched</th><th>Offered but not searched</th></tr>${concepts}</table>${assess}
<h2>5. Spelling, syntax and line numbers</h2>
<p>Research Finder's automatic check of the strategy:</p>${checks}${assess}
<h2>6. Limits and filters</h2>
<p>${s.filters.length ? s.filters.map(esc).join("<br>") : "None."}${s.dropped ? `<br>${plural(s.dropped, "term")} did not fit in the search and ${s.dropped === 1 ? "was" : "were"} left out.` : ""}</p>${assess}
<h2>Overall</h2>
<p>[ ] No revisions &nbsp; [ ] Revisions suggested &nbsp; [ ] Revisions required</p><p><b>Comments for the authors:</b></p><p>&nbsp;</p>
</body></html>`;
}
