/* References: links to the visitor's own library (OpenURL link resolver and proxy), COinS for the Zotero Connector,
   BibTeX and CSL-JSON files, and references formatted in any CSL citation style, by the DOI Foundation's formatter
   (citation.doi.org, which uses the metadata registered with the DOI) or, for a record without a DOI, made here in
   APA style from OpenAlex's data. Nothing here costs any of the OpenAlex allowance. */
import { $, h, fill, fmt, plural, fold, norm, local, toast, safeUrl, stripHtml } from "./util.js?v=39";

const pause = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });

/* ------------------------------------------------------------------ names */
/* OpenAlex gives names as written ("Amy J. C. Cuddy"); references need the family name first. The last word is taken
   as the family name, with the particles before it ("van der Berg") and without a suffix ("Jr."). */
const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "dei", "di", "da", "dos", "das", "do", "du", "la", "le", "ter", "ten", "zu", "bin", "ibn", "al", "el"]);
const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;
export function splitName(name) {
  const n = String(name || "").replace(/\s+/g, " ").trim();
  if (!n) return { family: "", given: "", suffix: "" };
  if (n.includes(",")) {
    const [family, ...rest] = n.split(",");
    return { family: family.trim(), given: rest.join(",").trim(), suffix: "" };
  }
  const parts = n.split(" ");
  const suffix = parts.length > 2 && SUFFIX.test(parts[parts.length - 1]) ? parts.pop() : "";
  if (parts.length === 1) return { family: parts[0], given: "", suffix };
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return { given: parts.slice(0, i).join(" "), family: parts.slice(i).join(" "), suffix };
}
/* "Amy J. C." -> "A. J. C."; "Jean-Paul" -> "J.-P." */
const initials = (given) => given.split(/\s+/).filter(Boolean)
  .map((g) => g.split("-").map((x) => (x ? `${x[0].toUpperCase()}.` : "")).join("-")).join(" ");

const pages = (r, dash = "–") => (r.fpage && r.lpage && r.lpage !== r.fpage ? `${r.fpage}${dash}${r.lpage}` : r.fpage || "");
const linkOf = (r) => (r.doi ? `https://doi.org/${r.doi}` : safeUrl(r.url || r.landing) || "");

/* ------------------------------------------------------------------ OpenURL: library links and COinS */
/* The record as an OpenURL ContextObject (Z39.88-2004, key/encoded-value), which library link resolvers (SFX, 360 Link,
   Alma) read, and the Zotero Connector too, from a COinS span. */
export function openUrl(r) {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v != null && v !== "") p.append(k, String(v)); };
  set("url_ver", "Z39.88-2004");
  set("ctx_ver", "Z39.88-2004");
  set("rfr_id", "info:sid/research-finder");
  const people = r.people || [];
  const first = splitName(people[0] || "");
  const date = (r.date || "").slice(0, 10) || (r.year ? String(r.year) : "");
  const type = r.type || "";
  const authors = () => {
    if (first.family) set("rft.aulast", first.family);
    if (first.given) set("rft.aufirst", first.given);
    people.forEach((a) => set("rft.au", a));
  };
  if (r.kind === "d" || r.kind === "o" || r.kind === "r") {
    set("rft_val_fmt", "info:ofi/fmt:kev:mtx:dc");
    set("rft.title", r.title);
    people.forEach((a) => set("rft.creator", a));
    if (r.org) set("rft.creator", r.org);
    set("rft.date", date);
    set("rft.publisher", r.venue || r.publisher);
    set("rft.type", r.kind === "d" ? "dataset" : type || "text");
    set("rft.identifier", linkOf(r));
  } else if (r.kind === "t") {
    set("rft_val_fmt", "info:ofi/fmt:kev:mtx:dissertation");
    set("rft.title", r.title);
    authors();
    set("rft.date", date);
    set("rft.inst", r.venue);
  } else if (r.kind === "b") {
    set("rft_val_fmt", "info:ofi/fmt:kev:mtx:book");
    if (type === "book-chapter") {
      set("rft.genre", "bookitem");
      set("rft.atitle", r.title);
      set("rft.btitle", r.venue);
    } else {
      set("rft.genre", "book");
      set("rft.btitle", r.title);
    }
    authors();
    set("rft.date", date);
    set("rft.pub", r.publisher);
    set("rft.spage", r.fpage);
    set("rft.epage", r.lpage);
  } else {
    set("rft_val_fmt", "info:ofi/fmt:kev:mtx:journal");
    set("rft.genre", r.kind === "p" ? "preprint" : "article");
    set("rft.atitle", r.title);
    set("rft.jtitle", r.venue);
    authors();
    set("rft.date", date);
    set("rft.volume", r.volume);
    set("rft.issue", r.issue);
    set("rft.spage", r.fpage);
    set("rft.epage", r.lpage);
    set("rft.issn", r.issn);
  }
  if (r.doi) set("rft_id", `info:doi/${r.doi}`);
  if (r.pmid) set("rft_id", `info:pmid/${r.pmid}`);
  if (!r.doi && linkOf(r)) set("rft_id", linkOf(r));
  return p.toString();
}

/* An empty span that the Zotero Connector reads (its folder icon then lists the results shown to pick from). */
export const coins = (r) => h("span", { class: "Z3988", title: openUrl(r) });

/* The library's link resolver and proxy, as the visitor set them (Settings). */
export const library = () => ({ resolver: local.get("libResolver", ""), proxy: local.get("libProxy", "") });

/* A resolver's address from what the visitor pastes, which may be a whole link from their library or from Google
   Scholar: the citation's own parameters are taken out, the library's (Alma's institution and view) are kept. */
const OPENURL_KEYS = /^(rft[._].*|rfr_id|rfe_dat|ctx_.*|url_ver|url_ctx_fmt|svc_dat|req_dat|sid|pid|id|genre|atitle|title|jtitle|stitle|btitle|issn|eissn|isbn|date|year|volume|issue|spage|epage|pages|aulast|aufirst|auinit|au|doi|pmid)$/i;
export function resolverBase(text) {
  let u;
  try { u = new URL(String(text || "").trim()); } catch { return ""; }
  if (!/^https?:$/.test(u.protocol)) return "";
  for (const k of [...new Set(u.searchParams.keys())]) if (OPENURL_KEYS.test(k)) u.searchParams.delete(k);
  return u.href.replace(/\?$/, "");
}
/* A proxy prefix from what the visitor pastes ("https://…/login?url=", or a whole link through the proxy). */
export function proxyBase(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (!safeUrl(s.replace(/\{url\}/, "x"))) return "";
  return s.includes("{url}") ? s : s.replace(/([?&]q?url=).*$/i, "$1");
}
const proxied = (prefix, url) => (prefix.includes("{url}") ? prefix.replace("{url}", encodeURIComponent(url))
  : /qurl=$|openathens|redirector/i.test(prefix) ? prefix + encodeURIComponent(url) : prefix + url);

export function libraryLinks(r) {
  const { resolver, proxy } = library();
  const out = [];
  if (resolver) {
    out.push({ href: `${resolver}${resolver.includes("?") ? "&" : "?"}${openUrl(r)}`, text: "Find it at my library",
      title: "Your library's link resolver: the full text through your library's subscriptions, or how to get it" });
  }
  const target = linkOf(r);
  if (proxy && target) {
    out.push({ href: proxied(proxy, target), text: "Through my library", title: "The publisher's page through your library's proxy, which signs you in with your library account" });
  }
  return out;
}

/* ------------------------------------------------------------------ BibTeX and CSL-JSON */
const STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "with", "to", "from", "by", "at", "is", "are", "does", "do", "how", "what", "why", "when"]);
const BIB_TYPES = { article: "article", review: "article", editorial: "article", letter: "article", erratum: "article", preprint: "misc",
  book: "book", monograph: "book", "book-chapter": "incollection", dissertation: "phdthesis", dataset: "misc" };
const bibText = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim()
  .replace(/\\/g, "\\textbackslash{}").replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
const bibName = (p) => {
  const n = splitName(p);
  if (!n.given) return `{${bibText(n.family)}}`;           // one word: an organisation, or a name given once
  return n.suffix ? `${bibText(n.family)}, ${bibText(n.suffix)}, ${bibText(n.given)}` : `${bibText(n.family)}, ${bibText(n.given)}`;
};
function bibKey(r, used) {
  const family = fold(splitName((r.people || [])[0] || "").family).replace(/[^a-z0-9]/g, "") || "anon";
  const word = (norm(r.title).split(" ").find((w) => w.length > 2 && !STOP.has(w)) || "").replace(/[^a-z0-9]/g, "");
  const key = `${family}${r.year || "nd"}${word}`;
  let k = key;
  for (let i = 0; used.has(k); i++) k = key + (i < 26 ? String.fromCharCode(97 + i) : i);
  used.add(k);
  return k;
}

/* opts: language(r) -> its name; notes(r) -> [text] (an English title, a retraction) */
export function bibtexOf(records, { language = () => "", notes = () => [] } = {}) {
  const used = new Set();
  return records.map((r) => {
    const type = r.kind === "d" ? "misc" : BIB_TYPES[r.type] || (r.kind === "t" ? "phdthesis" : r.kind === "b" ? "book" : r.kind === "a" ? "article" : "misc");
    const venue = { article: "journal", incollection: "booktitle", phdthesis: "school" }[type] || (type === "book" ? "" : "howpublished");
    const fields = [
      ["author", r.org && !(r.people || []).length ? `{${bibText(r.org)}}` : (r.people || []).map(bibName).join(" and ")],
      ["title", bibText(r.title)],
      venue ? [venue, bibText(r.venue)] : null,
      ["year", r.year || ""],
      ["volume", bibText(r.volume)],
      ["number", bibText(r.issue)],
      ["pages", bibText(pages(r, "--"))],
      ["publisher", type === "book" || type === "incollection" ? bibText(r.publisher || (type === "book" ? r.venue : "")) : ""],
      ["doi", bibText(r.doi)],
      ["url", r.doi ? "" : bibText(linkOf(r))],
      ["issn", bibText(r.issn)],
      ["language", bibText(language(r))],
      ["keywords", bibText((r.keywords || []).join(", "))],
      ["abstract", bibText(r.full || r.abstract)],
      ["note", bibText([r.kind === "d" ? "Dataset" : r.kind === "p" ? "Preprint" : "", ...notes(r)].filter(Boolean).join(". "))],
    ].filter((f) => f && f[1] !== "" && f[1] != null);
    return `@${type}{${bibKey(r, used)},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
  }).join("\n\n") + "\n";
}

const CSL_TYPES = { article: "article-journal", review: "article-journal", editorial: "article-journal", letter: "article-journal", erratum: "article-journal",
  preprint: "article", book: "book", monograph: "book", "book-chapter": "chapter", dissertation: "thesis", dataset: "dataset" };
const dateParts = (r) => {
  const d = (r.date || "").slice(0, 10).split("-").map(Number).filter(Boolean);
  return d.length ? { "date-parts": [d] } : r.year ? { "date-parts": [[r.year]] } : null;
};

/* CSL-JSON, which Zotero, Pandoc and citation processors read. */
export function cslOf(records, { notes = () => [] } = {}) {
  const ids = new Set();
  return JSON.stringify(records.map((r, i) => {
    let id = r.doi || r.oa || `item${i + 1}`;
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const item = {
      id, type: r.kind === "d" ? "dataset" : r.kind === "r" ? "report" : CSL_TYPES[r.type] || (r.kind === "t" ? "thesis" : r.kind === "b" ? "book" : r.kind === "a" ? "article-journal" : "document"),
      title: r.title,
      author: r.org && !(r.people || []).length ? [{ literal: r.org }]
        : (r.people || []).map((p) => { const n = splitName(p); return n.given ? { family: n.family, given: n.given, ...(n.suffix ? { suffix: n.suffix } : {}) } : { literal: n.family }; }),
      "container-title": r.kind === "r" ? "" : r.venue, publisher: r.kind === "r" ? "ClinicalTrials.gov" : r.publisher, number: r.nct, genre: r.kind === "r" ? "Study registration" : "",
      issued: dateParts(r), volume: r.volume, issue: r.issue, page: pages(r, "-"),
      DOI: r.doi, URL: r.doi ? "" : linkOf(r), ISSN: r.issn, PMID: r.pmid, abstract: r.full || r.abstract, language: r.lang,
      keyword: (r.keywords || []).join(", "), note: notes(r).join(". "),
    };
    return Object.fromEntries(Object.entries(item).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)));
  }), null, 2);
}

/* ------------------------------------------------------------------ formatted references */
export const STYLES = [
  ["apa", "APA (7th edition)"], ["chicago-author-date", "Chicago (author-date)"], ["harvard-cite-them-right", "Harvard (Cite Them Right)"],
  ["modern-language-association", "MLA (9th edition)"], ["american-sociological-association", "ASA"], ["elsevier-vancouver", "Vancouver"],
  ["american-medical-association", "AMA"], ["ieee", "IEEE"], ["nature", "Nature"],
];
const LOCALES = [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["de-DE", "German"], ["es-ES", "Spanish"], ["fr-FR", "French"],
  ["it-IT", "Italian"], ["nl-NL", "Dutch"], ["pl-PL", "Polish"], ["pt-BR", "Portuguese (Brazil)"], ["pt-PT", "Portuguese (Portugal)"]];
export const styleName = (id) => (STYLES.find(([s]) => s === id) || [id, id])[1];

/* A reference in APA style, made here from OpenAlex's data, for a record without a DOI (or when the formatter does
   not answer). OpenAlex does not say which part of a name is the family name, so long names may come out wrong. */
export function localReference(r) {
  if (r.kind === "r") {
    return `${r.org ? `${r.org.replace(/\.$/, "")}. ` : ""}(${r.year || "n.d."}). ${String(r.title || "").replace(/[.\s]+$/, "")} (ClinicalTrials.gov identifier ${r.nct}). ${r.url}`;
  }
  const names = (r.people || []).map(splitName);
  const au = names.map((n) => (n.given ? `${n.family}, ${initials(n.given)}${n.suffix ? `, ${n.suffix}` : ""}` : n.family));
  const authors = au.length > 20 ? `${au.slice(0, 19).join(", ")}, … ${au[au.length - 1]}`
    : au.length > 1 ? `${au.slice(0, -1).join(", ")}, & ${au[au.length - 1]}` : au[0] || "";
  const year = `(${r.year || "n.d."})`;
  const title = String(r.title || "").replace(/[.\s]+$/, "");
  const kindNote = r.kind === "d" ? " [Data set]" : r.kind === "p" ? " [Preprint]" : r.kind === "t" ? " [Doctoral dissertation]" : "";
  const where = r.venue ? `${r.venue}${r.volume ? `, ${r.volume}` : ""}${r.issue ? `(${r.issue})` : ""}${pages(r) ? `, ${pages(r)}` : ""}.` : "";
  return [authors ? `${authors} ${year}.` : "", `${title}${kindNote}.`, authors ? "" : `${year}.`, where, linkOf(r)].filter(Boolean).join(" ");
}

const formatted = new Map();       // style|locale|doi -> the reference
let citeNext = 0;
/* One reference from citation.doi.org, about four a second. */
async function fromDoi(doi, style, locale) {
  const key = `${style}|${locale}|${doi.toLowerCase()}`;
  if (formatted.has(key)) return formatted.get(key);
  const at = Math.max(Date.now(), citeNext);
  citeNext = at + 250;
  await pause(at - Date.now());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch(`https://citation.doi.org/format?doi=${encodeURIComponent(doi)}&style=${encodeURIComponent(style)}&lang=${encodeURIComponent(locale)}`, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = stripHtml((await r.text()) || "").replace(/\s+/g, " ").trim();
  if (!r.ok || !text) throw new Error(r.status === 404 ? "DOI not found" : `HTTP ${r.status}`);
  if (/^unknown style/i.test(text)) { const e = new Error(`there is no citation style “${style}”`); e.style = true; throw e; }
  formatted.set(key, text);
  return text;
}

/* References for records in a style: [{ r, text, local }] in the style's order (alphabetical for author-date styles,
   as listed for numbered ones, renumbered). */
export async function references(records, style, locale = "en-US", onProgress = () => {}) {
  const out = [];
  let done = 0;
  const one = async (r) => {
    let text = "", made = false;
    if (r.doi) {
      try { text = await fromDoi(r.doi, style, locale); } catch (e) { if (e.style) throw e; }
    }
    if (!text) { text = localReference(r); made = true; }
    out.push({ r, text, local: made });
    onProgress(++done, records.length);
  };
  // two at a time, in the order given
  const queue = [...records];
  await Promise.all([0, 1].map(async () => { while (queue.length) await one(queue.shift()); }));
  const order = new Map(records.map((r, i) => [r, i]));
  out.sort((a, b) => order.get(a.r) - order.get(b.r));
  const numbered = out.some((x) => !x.local && /^(\[\d+\]|\d+\.)\s/.test(x.text));
  if (numbered) {
    const bracket = out.some((x) => /^\[\d+\]/.test(x.text));
    out.forEach((x, i) => { x.text = `${bracket ? `[${i + 1}]` : `${i + 1}.`} ${x.text.replace(/^(\[\d+\]|\d+\.)\s*/, "")}`; });
  } else {
    out.sort((a, b) => fold(a.text).localeCompare(fold(b.text)));
  }
  return out;
}

/* ------------------------------------------------------------------ the dialog */
let allStyles = null;
async function styleList() {
  if (!allStyles) {
    allStyles = fetch("https://citation.doi.org/styles").then((r) => (r.ok ? r.json() : [])).catch(() => []);
  }
  return allStyles;
}

/* References for one or more records, in the style the visitor picks; ctx: { link(href, text), exportRecords(records,
   { format, name }) } */
export function openCite(records, ctx, { title } = {}) {
  const d = $("#tools");
  const one = records.length === 1;
  fill($("#tools-title"), title || (one ? "Cite this study" : `References for ${plural(records.length, "study", "studies")}`));
  const saved = local.get("citeStyle", "apa");
  const known = STYLES.some(([s]) => s === saved);
  const pick = h("select", { id: "cite-style", "aria-label": "Citation style" },
    STYLES.map(([v, l]) => h("option", { value: v, selected: v === saved }, l)),
    h("option", { value: "", selected: !known }, "Another style…"));
  const other = h("input", { type: "text", id: "cite-other", list: "cite-styles", spellcheck: "false", autocomplete: "off",
    placeholder: "the style's name, e.g. apa-6th-edition", value: known ? "" : saved, hidden: known, "aria-label": "Another citation style" });
  const options = h("datalist", { id: "cite-styles" });
  const locale = h("select", { id: "cite-locale", "aria-label": "Language of the reference" },
    LOCALES.map(([v, l]) => h("option", { value: v, selected: v === local.get("citeLocale", "en-US") }, l)));
  const out = h("div", { class: "tools-out", role: "status", "aria-live": "polite" });
  let last = [], run = 0;
  const style = () => (pick.value || other.value.trim());
  const make = async () => {
    const s = style();
    if (!s) return;
    const id = ++run;
    local.set("citeStyle", s);
    local.set("citeLocale", locale.value);
    fill(out, h("p", { class: "note pending" }, spinner(), one ? "Formatting the reference…" : `Formatting the references: 0 of ${fmt(records.length)}…`));
    try {
      const list = await references(records, s, locale.value, (n, of) => {
        if (id === run && !one) fill(out, h("p", { class: "note pending" }, spinner(), `Formatting the references: ${fmt(n)} of ${fmt(of)}…`));
      });
      if (id !== run) return;
      last = list;
      const made = list.filter((x) => x.local).length;
      fill(out,
        h("div", { class: "refs" }, list.map((x) => h("p", { class: x.local ? "ref-local" : null }, x.text))),
        h("div", { class: "tools-actions" },
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: copy }, one ? "Copy the reference" : "Copy the references"),
          one ? null : h("button", { type: "button", class: "btn btn-small", onclick: download }, "Download (.txt)")),
        h("p", { class: "note" }, made === list.length
          ? `${one ? "This record has no DOI (or the formatter did not answer), so its reference was" : "These records have no DOI (or the formatter did not answer), so their references were"} made here in APA style from OpenAlex's data: check the names and details.`
          : [made ? `${plural(made, "reference")} (marked with a line) ${made === 1 ? "was" : "were"} made here in APA style from OpenAlex's data, for records without a DOI or that the formatter did not answer for: check the names and details. ` : "",
            `${made ? "The others were" : one ? "It was" : "They were"} formatted from the metadata registered with ${one && !made ? "the" : "each"} DOI (Crossref or DataCite) by the DOI Foundation's citation formatter. Check ${one && !made ? "it" : "them"} against the study: titles sometimes lack their subtitle, and italics are not kept.`]));
    } catch (e) {
      if (id === run) fill(out, h("p", { class: "note warn" }, `The references could not be made: ${e.message}.`));
    }
  };
  const text = () => last.map((x) => x.text).join(one ? "" : "\n\n");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text()); toast(one ? "Reference copied" : "References copied"); } catch { window.prompt("Copy:", text()); }
  };
  const download = () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([text() + "\n"], { type: "text/plain;charset=utf-8" })), download: `references-${style()}-${new Date().toISOString().slice(0, 10)}.txt` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  pick.addEventListener("change", () => {
    other.hidden = Boolean(pick.value);
    if (!pick.value) {
      other.focus();
      styleList().then((list) => fill(options, list.map((s) => h("option", { value: s }))));
    } else make();
  });
  other.addEventListener("change", make);
  locale.addEventListener("change", make);
  fill($("#tools-body"),
    one ? h("p", { class: "tools-head" }, h("strong", {}, records[0].title), records[0].year ? ` (${records[0].year})` : "") : null,
    h("div", { class: "cite-row" }, h("label", { for: "cite-style" }, "Style"), pick, other, options, h("label", { for: "cite-locale" }, "Language"), locale),
    out,
    h("div", { class: "tools-actions cite-files" },
      h("span", { class: "note" }, one ? "For a reference manager:" : "For a reference manager, the same records as a file:"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { format: "ris", name: one ? "reference" : "references" }) }, "RIS"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { format: "bib", name: one ? "reference" : "references" }) }, "BibTeX"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { format: "csl", name: one ? "reference" : "references" }) }, "CSL-JSON"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { format: "zotero", name: one ? "reference" : "references" }) }, "Zotero")));
  if (!d.open) d.showModal();
  if (records.length > 300) {
    fill(out, h("p", { class: "note" }, `Formatting ${fmt(records.length)} references takes about ${Math.ceil(records.length / 4 / 60)} minutes. `,
      h("button", { type: "button", class: "btn btn-small", onclick: make }, "Format them")));
  } else make();
}
