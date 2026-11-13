/* Combining searches: the exports of other databases (Scopus, Web of Science, PubMed, PsycINFO, Embase, any RIS or CSV)
   read in this browser, put together with this search's results, and the duplicates removed: the same DOI or PubMed
   ID, or a near-identical title backed by the year and the first author, the journal or the pages. Pairs that only
   look alike go to the reviewer. The counts of each database and the duplicates removed are what the PRISMA 2020 flow
   diagram and PRISMA-S items 15 and 16 ask for. Nothing leaves the browser until you save to your own Drive. */
import { $, h, fill, fmt, plural, norm, fold, toast, parseCsv, safeUrl } from "./util.js?v=44";

const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
const pause = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const doiOf = (s) => { const m = /(10\.\d{4,9}\/[^\s"<>]+)/i.exec(String(s || "")); return m ? m[1].replace(/[.,;)\]]+$/, "").toLowerCase() : ""; };
const yearOf = (s) => { const m = /\b(1[89]\d\d|20\d\d)\b/.exec(String(s || "")); return m ? Number(m[1]) : 0; };
const today = () => new Date().toISOString().slice(0, 10);
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/* ------------------------------------------------------------------ the records of an export */
const KIND = (type) => (/thesis|dissertation|THES/i.test(type) ? "t" : /preprint/i.test(type) ? "p" : /review/i.test(type) ? "v"
  : /chapter|CHAP|book|BOOK/i.test(type) ? "b" : /data/i.test(type) ? "d" : /article|journal|JOUR|JFULL|letter|editorial/i.test(type) || !type ? "a" : "o");
function make(f) {
  const people = (f.people || []).map((p) => clean(p).replace(/\s*\(\d+\)$/, "")).filter(Boolean);
  let fpage = clean(f.fpage), lpage = clean(f.lpage);
  if (!fpage && f.pages) [fpage = "", lpage = ""] = String(f.pages).split(/\s*[-–]\s*/).map(clean);
  if (/[-–]/.test(fpage) && !lpage) [fpage = "", lpage = ""] = fpage.split(/\s*[-–]\s*/).map(clean);
  const title = clean(f.title).replace(/^\[(.+)\]\.?$/, "$1");
  return {
    title: title || "(untitled)", people, authors: people.slice(0, 4).join("; ") + (people.length > 4 ? " et al." : ""), year: f.year || 0,
    date: String(f.year || ""), venue: clean(f.venue), volume: clean(f.volume), issue: clean(f.issue), fpage, lpage, doi: f.doi || "",
    pmid: clean(f.pmid).replace(/\D/g, ""), abstract: clean(f.abstract), full: clean(f.abstract), url: safeUrl(clean(f.url)) || "", pdf: "",
    lang: clean(f.lang), keywords: (f.keywords || []).map(clean).filter(Boolean).slice(0, 12), issn: clean(f.issn), type: clean(f.type),
    kind: KIND(clean(f.type)), accession: clean(f.accession), dbHint: clean(f.db), open: false, cited: 0,
  };
}

/* RIS (Scopus, Web of Science, EBSCO's PsycINFO, Ovid's Embase and MEDLINE, reference managers): TAG  - value. */
function parseRis(text) {
  const out = [];
  let cur = null, last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/.exec(line);
    if (m) {
      const [, tag, val] = m;
      if (tag === "TY") cur = {};
      if (!cur) continue;
      if (tag === "ER") { out.push(cur); cur = null; last = null; continue; }
      (cur[tag] = cur[tag] || []).push(val.trim());
      last = tag;
    } else if (cur && last && line.trim()) {
      const a = cur[last];
      a[a.length - 1] += ` ${line.trim()}`;
    }
  }
  if (cur) out.push(cur);
  return out.map((t) => {
    const one = (...ks) => { for (const k of ks) if (t[k] && clean(t[k][0])) return clean(t[k][0]); return ""; };
    const all = (...ks) => ks.flatMap((k) => t[k] || []).map(clean).filter(Boolean);
    const db = one("DB", "DP");
    const an = one("AN");
    const pmid = /pubmed|medline/i.test(db) && /^\d{1,9}$/.test(an) ? an : (/PMID:?\s*(\d{1,9})/i.exec(all("N1", "C2", "M2").join(" ")) || [])[1] || "";
    return make({
      title: one("TI", "T1", "CT"), people: all("AU", "A1"), year: yearOf(one("PY", "Y1", "DA", "Y2")), venue: one("T2", "JF", "JO", "JA", "J2", "BT"),
      volume: one("VL"), issue: one("IS", "CP"), fpage: one("SP"), lpage: one("EP"), doi: doiOf(one("DO")) || doiOf(all("M3", "UR", "L1", "L2", "N1").join(" ")),
      pmid, abstract: one("AB", "N2"), url: one("UR", "L2", "L1"), lang: one("LA"), keywords: all("KW"), issn: one("SN"), type: one("TY", "M3"), db, accession: an,
    });
  });
}

/* PubMed's MEDLINE format (.nbib, .txt): "TI  - " with lines continued after six spaces, one record per PMID. */
function parseMedline(text) {
  const out = [];
  let cur = null, last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z]{2,4})\s*- (.*)$/.exec(line);
    if (m) {
      if (m[1] === "PMID") { cur = {}; out.push(cur); }
      if (!cur) continue;
      (cur[m[1]] = cur[m[1]] || []).push(m[2].trim());
      last = m[1];
    } else if (cur && last && /^\s{4,}\S/.test(line)) {
      const a = cur[last];
      a[a.length - 1] += ` ${line.trim()}`;
    }
  }
  return out.map((t) => make({
    title: (t.TI || t.BTI || [""])[0], people: t.FAU || t.AU || [], year: yearOf((t.DP || [""])[0]), venue: (t.JT || t.TA || [""])[0],
    volume: (t.VI || [""])[0], issue: (t.IP || [""])[0], pages: (t.PG || [""])[0],
    doi: doiOf([...(t.LID || []), ...(t.AID || [])].find((x) => /\[doi\]/.test(x)) || ""), pmid: (t.PMID || [""])[0],
    abstract: (t.AB || []).join(" "), lang: (t.LA || [""])[0], keywords: [...(t.OT || []), ...(t.MH || [])], issn: ((t.IS || [""])[0] || "").split(" ")[0],
    type: (t.PT || []).join("; "), db: "PubMed", accession: (t.PMID || [""])[0],
  }));
}

/* Web of Science: plain text (tags, lines continued after three spaces) or tab-delimited (a header of tags). */
const WOS_MULTI = new Set(["AU", "AF", "BE", "CA", "CR", "C1", "C3", "EM", "RI", "OI"]);
const SMALL = new Set(["of", "and", "the", "in", "for", "on", "at", "to", "a", "an", "de", "la", "y", "und", "für"]);
const titleCase = (s) => (s && s === s.toUpperCase()
  ? s.toLowerCase().split(" ").map((w, i) => (i && SMALL.has(w) ? w : w.replace(/^\p{L}/u, (c) => c.toUpperCase()))).join(" ") : s);
function fromWos(get) {
  const one = (k) => clean((get(k) || [])[0] || "");
  return make({
    title: one("TI"), people: get("AF").length ? get("AF") : get("AU"), year: yearOf(one("PY") || one("EA")), venue: titleCase(one("SO")),
    volume: one("VL"), issue: one("IS"), fpage: one("BP"), lpage: one("EP"), doi: doiOf(one("DI")), pmid: one("PM"), abstract: one("AB"), lang: one("LA"),
    keywords: [...one("DE").split(";"), ...one("ID").split(";")], issn: one("SN") || one("EI"), type: one("DT"), db: "Web of Science", accession: one("UT"),
  });
}
function parseWosText(text) {
  const out = [];
  let cur = null, last = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^ER\s*$/.test(line)) { if (cur) out.push(cur); cur = null; continue; }
    const m = /^([A-Z][A-Z0-9]) (.*)$/.exec(line);
    if (m && !["FN", "VR", "EF"].includes(m[1])) {
      if (m[1] === "PT") cur = {};
      if (!cur) continue;
      (cur[m[1]] = cur[m[1]] || []).push(m[2].trim());
      last = m[1];
    } else if (cur && last && /^ {2,3}\S/.test(line)) {
      if (WOS_MULTI.has(last)) cur[last].push(line.trim());
      else { const a = cur[last]; a[a.length - 1] += ` ${line.trim()}`; }
    }
  }
  return out.map((t) => fromWos((k) => t[k] || []));
}
function parseWosTab(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split("\t").map((x) => x.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    return fromWos((k) => {
      const v = clean(cells[head.indexOf(k)] || "");
      return !v ? [] : WOS_MULTI.has(k) ? v.split(/;\s*/).filter(Boolean) : [v];
    });
  });
}

/* CSV: Scopus's export, or any table with a column called Title (Research Finder's own, Covidence, Rayyan...). */
function parseTable(text) {
  const rows = parseCsv(text).filter((r) => r.some((x) => clean(x)));
  const head = rows[0].map((x) => clean(x).toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const c = {
    title: col("title", "document title", "article title", "ti"), people: col("author full names", "authors", "author", "au"),
    year: col("year", "publication year", "py", "date"), venue: col("source title", "journal", "journal title", "journal or repository", "publication title", "secondary title", "so"),
    volume: col("volume", "vl"), issue: col("issue", "is"), fpage: col("page start", "start page", "bp"), lpage: col("page end", "end page", "ep"), pages: col("pages", "pg"),
    doi: col("doi", "di"), pmid: col("pubmed id", "pmid", "pm"), abstract: col("abstract", "ab"), url: col("link", "url"), lang: col("language of original document", "language", "la"),
    keywords: col("author keywords", "keywords", "de"), type: col("document type", "type", "dt"), source: col("source"), issn: col("issn", "sn"), accession: col("eid", "ut", "accession number"),
  };
  if (c.title < 0) throw new Error("it has no column called “Title”");
  const at = (r, i) => (i >= 0 ? clean(r[i]) : "");
  const records = rows.slice(1).map((r) => make({
    title: at(r, c.title), people: at(r, c.people).split(/;\s*/).filter(Boolean), year: yearOf(at(r, c.year)), venue: at(r, c.venue),
    volume: at(r, c.volume), issue: at(r, c.issue), fpage: at(r, c.fpage), lpage: at(r, c.lpage), pages: at(r, c.pages), doi: doiOf(at(r, c.doi)),
    pmid: at(r, c.pmid), abstract: at(r, c.abstract), url: at(r, c.url), lang: at(r, c.lang), keywords: at(r, c.keywords).split(/;\s*/), type: at(r, c.type),
    issn: at(r, c.issn), accession: at(r, c.accession), db: at(r, c.source),
  }));
  return records.filter((r) => r.title !== "(untitled)" || r.doi);
}

/* Which database an export comes from, from its records ("Scopus", "APA PsycInfo", "Embase"). */
function guessDb(records) {
  const counts = new Map();
  for (const r of records) if (r.dbHint && r.dbHint.length < 60) counts.set(r.dbHint, (counts.get(r.dbHint) || 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= records.length / 2 ? best[0].replace(/^EBSCOhost$/i, "EBSCO") : "";
}
const baseName = (name) => String(name || "Export").replace(/\.[a-z0-9]+$/i, "");

export function readExport(text, filename = "") {
  const t = String(text || "").replace(/^﻿/, "");
  let format, records;
  if (/^PMID- /m.test(t)) { format = "PubMed (MEDLINE)"; records = parseMedline(t); }
  else if (/^PT\t/.test(t)) { format = "Web of Science (tab-delimited)"; records = parseWosTab(t); }
  else if (!/^TY\s{1,2}-/m.test(t) && (/^FN /m.test(t) || /^PT [A-Z]\s*$/m.test(t)) && /^ER\s*$/m.test(t)) { format = "Web of Science (plain text)"; records = parseWosText(t); }
  else if (/^TY\s{1,2}-/m.test(t)) { format = "RIS"; records = parseRis(t); }
  else if (/^\s*@\w+\s*\{/m.test(t)) throw new Error("BibTeX is not read yet: export the records as RIS instead");
  else if (/[,\t;]/.test(t.split(/\r?\n/)[0] || "")) { format = "CSV"; records = parseTable(t); }
  else throw new Error("it is not in a format Research Finder reads (RIS, PubMed, Web of Science, CSV)");
  if (!records.length) throw new Error(`no records found in this ${format} file`);
  const label = format.startsWith("PubMed") ? "PubMed" : format.startsWith("Web of Science") ? "Web of Science" : guessDb(records) || baseName(filename);
  return { format, records, label };
}

/* ------------------------------------------------------------------ duplicates */
const NOTICE = /^(erratum|errata|corrigendum|correction|retraction|retracted|notice of retraction|expression of concern|withdrawn|withdrawal)\b/;
function familyOf(name) {
  const s = clean(name);
  if (!s) return "";
  let fam;
  if (s.includes(",")) fam = s.split(",")[0];
  else {
    const parts = s.split(" ");
    const lastPart = parts[parts.length - 1];
    // "Carney D.R." (Scopus) or "Carney DR" (Web of Science): the initials come last
    fam = parts.length > 1 && /^([A-Z]\.?-?){1,4}$/.test(lastPart) ? parts.slice(0, -1).join(" ") : lastPart;
  }
  return fold(fam).replace(/[^\p{L}]/gu, "");
}
const gramsOf = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}
function prep(r, i) {
  const t = norm(r.title === "(untitled)" ? "" : r.title);
  const compact = t.replace(/ /g, "");
  return { i, t, compact, grams: gramsOf(compact.slice(0, 300)), doi: (r.doi || "").toLowerCase(), pmid: r.pmid || "", year: r.year || 0,
    first: familyOf((r.people || [])[0] || ""), journal: norm(r.venue || "").replace(/^the /, ""), volume: clean(r.volume), fpage: clean(r.fpage), notice: NOTICE.test(t) };
}

/* Whether two records are the same study: "same", "review" (for the reviewer) or "different", and why. */
function judge(a, b) {
  if (a.notice !== b.notice) return { v: "different" };
  if (a.doi && a.doi === b.doi) return { v: "same", why: "same DOI", sim: 1 };
  if (a.pmid && a.pmid === b.pmid) return { v: "same", why: "same PubMed ID", sim: 1 };
  if (a.year && b.year && Math.abs(a.year - b.year) > 1) return { v: "different" };
  const sim = dice(a.grams, b.grams);
  if (sim < 0.85 || Math.min(a.compact.length, b.compact.length) < 12) return { v: "different" };
  const agree = [a.first && a.first === b.first ? "first author" : "",
    a.journal && b.journal && (a.journal === b.journal || a.journal.includes(b.journal) || b.journal.includes(a.journal)) ? "journal" : "",
    a.volume && a.volume === b.volume && a.fpage && a.fpage === b.fpage ? "volume and pages" : ""].filter(Boolean);
  if (a.doi && b.doi) return { v: sim >= 0.95 ? "review" : "different", why: "similar titles but different DOIs (a preprint and its article, or another version?)", sim };
  if (a.pmid && b.pmid) return { v: sim >= 0.97 ? "review" : "different", why: "similar titles but different PubMed IDs", sim };
  if (sim >= 0.97 && agree.length && (a.year === b.year || !a.year || !b.year || agree.length > 1)) {
    return { v: "same", why: `same title${a.year && a.year === b.year ? ", year" : ""} and ${agree.join(" and ")}`, sim };
  }
  return { v: "review", why: agree.length ? `similar titles; the same ${agree.join(" and ")}` : "similar titles", sim };
}

/* Every pair of records that could be the same study: the same DOI or PubMed ID, or titles that begin or end alike. */
async function pairsOf(P, onProgress) {
  const buckets = new Map();
  const add = (key, i) => (buckets.get(key) || buckets.set(key, []).get(key)).push(i);
  for (const p of P) {
    if (p.doi) add(`d:${p.doi}`, p.i);
    if (p.pmid) add(`p:${p.pmid}`, p.i);
    if (p.compact.length >= 12) { add(`a:${p.compact.slice(0, 20)}`, p.i); add(`z:${p.compact.slice(-20)}`, p.i); }
  }
  const seen = new Set(), out = [];
  let n = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const L = list.slice(0, 300);
    for (let x = 0; x < L.length; x++) {
      for (let y = x + 1; y < L.length; y++) {
        const a = Math.min(L[x], L[y]), b = Math.max(L[x], L[y]), key = `${a}|${b}`;
        if (a === b || seen.has(key)) continue;
        seen.add(key);
        const j = judge(P[a], P[b]);
        if (j.v !== "different") out.push({ a, b, key, ...j });
        if (++n % 5000 === 0) { onProgress(n); await pause(); }
      }
    }
  }
  return out;
}

/* Clusters of the same study, from the pairs judged the same and the reviewer's decisions. */
function clustersOf(n, pairs, decisions) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const p of pairs) {
    const d = decisions.get(p.key);
    if (d ? d === "same" : p.v === "same") parent[find(p.a)] = find(p.b);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) (groups.get(find(i)) || groups.set(find(i), []).get(find(i))).push(i);
  return [...groups.values()];
}

/* The combined set: one record per study (the fullest one, with what the others add), where each was found, and the
   counts for the flow diagram. */
function build(all, pairs, decisions, labels) {
  const groups = clustersOf(all.length, pairs, decisions);
  const why = new Map(pairs.map((p) => [p.key, decisions.get(p.key) === "same" ? "the reviewer's decision" : p.why]));
  const score = (r) => (r.fromSearch ? 3 : 0) + (r.doi ? 4 : 0) + (r.abstract ? 2 : 0) + (r.pmid ? 1 : 0) + (r.volume ? 0.5 : 0) + (r.people.length ? 0.5 : 0);
  const merged = [], removed = [], combos = new Map();
  const group = new Int32Array(all.length);
  groups.forEach((g, k) => g.forEach((i) => { group[i] = k; }));
  const per = Object.fromEntries(labels.map((l) => [l, { records: 0, within: 0, shared: 0, only: 0 }]));
  for (const r of all) per[r.label].records++;
  for (const g of groups) {
    const members = g.map((i) => all[i]);
    const kept = [...members].sort((x, y) => score(y) - score(x))[0];
    const found = [...new Set(labels.filter((l) => members.some((m) => m.label === l)))];
    const m = { ...kept, foundIn: found, source: found.join("; "), merged: members.length };
    for (const k of ["doi", "pmid", "abstract", "full", "volume", "issue", "fpage", "lpage", "url", "venue", "issn", "lang"]) {
      if (!m[k]) m[k] = (members.find((x) => x[k]) || {})[k] || m[k];
    }
    merged.push(m);
    combos.set(found.join(" + "), (combos.get(found.join(" + ")) || 0) + 1);
    for (const l of found) {
      const c = members.filter((x) => x.label === l).length;
      per[l].within += c - 1;
      if (found.length > 1) per[l].shared++;
      else per[l].only++;
    }
    for (const x of members) {
      if (x === kept) continue;
      const a = Math.min(x.n, kept.n), b = Math.max(x.n, kept.n);
      removed.push({ r: x, kept: m, why: why.get(`${a}|${b}`) || "the same study as another record of this group" });
    }
  }
  return { merged, removed, per, combos: [...combos].sort((a, b) => b[1] - a[1]), review: pairs.filter((p) => p.v === "review"), group,
    total: all.length, byWhy: removed.reduce((o, x) => ({ ...o, [x.why]: (o[x.why] || 0) + 1 }), {}) };
}

/* ------------------------------------------------------------------ the dialog */
/* ctx (from the search page): current() → { label, shown, total, query, link } or null; collect(count, progress) →
   { rows, notes }; download(name, text, type, message); ris(records); prisma(counts) → SVG; save({ title, records,
   details, tables, prisma, progress }) → { folder, sheet, doc }; header() and rowOf(r, i) for the sheet. */
const job = { files: [], decisions: new Map(), result: null, pairs: null, all: null, useSearch: true, count: 0, searchLabel: "" };

export function openCombine(ctx) {
  const d = $("#tools");
  fill($("#tools-title"), "Combine searches and remove duplicates");
  const cur = ctx.current();
  const list = h("div", { class: "cb-sources" });
  const out = h("div", { class: "tools-out", role: "status", "aria-live": "polite" });
  const input = h("input", { type: "file", multiple: true, accept: ".ris,.txt,.nbib,.csv,.tsv,.ciw", hidden: true });
  const drop = h("div", { class: "cb-drop", tabindex: "0" }, "Drop the exports of your other searches here, or ",
    h("button", { type: "button", class: "link-btn", onclick: () => input.click() }, "choose the files"),
    h("span", { class: "note" }, "RIS (Scopus, Web of Science, PsycINFO, Embase, any reference manager), PubMed (.nbib or MEDLINE .txt), Web of Science (plain text or tab-delimited), Scopus CSV or any CSV with a Title column."));
  const go = h("button", { type: "button", class: "btn btn-primary" }, "Remove the duplicates");
  const count = h("select", { "aria-label": "How many results of this search" });
  const draw = () => {
    fill(list,
      cur ? h("div", { class: "cb-row" }, h("label", { class: "f-option" }, h("input", { type: "checkbox", checked: job.useSearch, onchange: (e) => { job.useSearch = e.target.checked; } }),
        h("span", {}, h("strong", {}, cur.label), ` — this search: `)), count) : h("p", { class: "note" }, "No search is open, so only the files below are combined."),
      job.files.map((f, i) => h("div", { class: "cb-row" },
        h("input", { type: "text", value: f.label, "aria-label": `Name of the database of ${f.name}`, onchange: (e) => { f.label = clean(e.target.value) || f.label; }, class: "cb-label" }),
        h("span", { class: "cb-meta" }, `${f.name} · ${f.format} · ${plural(f.records.length, "record")}`),
        h("button", { type: "button", class: "link-btn", onclick: () => { job.files.splice(i, 1); draw(); } }, "Remove"))));
  };
  if (cur) {
    const options = [...new Set([cur.shown, cur.total].filter((n) => n))];
    // all the results by default when they are not many (200 a request); otherwise the ones shown, until you choose all
    const pick = job.count && options.includes(job.count) ? job.count : cur.total <= 1000 ? cur.total : cur.shown;
    fill(count, options.map((n) => h("option", { value: n, selected: n === pick }, n === cur.total ? `all ${fmt(n)} results` : `the ${fmt(n)} shown`)));
    count.addEventListener("change", () => { job.count = Number(count.value); });
    job.count = Number(count.value);
  }
  const add = async (files) => {
    for (const file of files) {
      try {
        const res = readExport(await file.text(), file.name);
        let label = res.label;
        while (job.files.some((f) => f.label === label) || (cur && label === cur.label)) label = `${label} (2)`;
        job.files.push({ name: file.name, format: res.format, records: res.records, label });
      } catch (e) {
        toast(`${file.name}: ${e.message}`, 6000);
      }
    }
    draw();
  };
  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("on"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("on"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("on"); add([...e.dataTransfer.files]); });
  go.addEventListener("click", async () => {
    const sources = [];
    go.disabled = true;
    try {
      if (cur && job.useSearch) {
        fill(out, h("p", { class: "note pending" }, spinner(), " Getting this search's results…"));
        const { rows } = await ctx.collect(job.count || cur.shown, (m) => fill(out, h("p", { class: "note pending" }, spinner(), ` ${m}`)));
        // a search of several databases (repositories, regional databases) counts each of them on its own
        const by = new Map();
        for (const r of rows) {
          const l = cur.split ? r.source || cur.label : cur.label;
          (by.get(l) || by.set(l, []).get(l)).push({ ...r, fromSearch: true });
        }
        for (const [label, records] of by) sources.push({ label, records, format: "Research Finder", name: "this search" });
      }
      sources.push(...job.files);
      if (sources.length < 1 || sources.reduce((s, x) => s + x.records.length, 0) < 2) { fill(out, h("p", { class: "note warn" }, "Add at least one export (or this search) with records.")); return; }
      fill(out, h("p", { class: "note pending" }, spinner(), " Comparing the records…"));
      await pause(20);
      job.all = sources.flatMap((s) => s.records.map((r) => ({ ...r, label: s.label })));
      job.all.forEach((r, n) => { r.n = n; });
      job.sources = sources;
      job.labels = [...new Set(sources.map((s) => s.label))];
      const P = job.all.map((r, n) => prep(r, n));
      job.pairs = await pairsOf(P, (k) => fill(out, h("p", { class: "note pending" }, spinner(), ` Comparing the records: ${fmt(k)} pairs…`)));
      job.decisions = new Map();
      job.date = today();
      job.search = cur && job.useSearch ? cur : null;
      show(out, ctx);
    } catch (e) {
      fill(out, h("p", { class: "note warn" }, `This did not work: ${e.message}`));
    } finally {
      go.disabled = false;
    }
  });
  draw();
  fill($("#tools-body"),
    h("p", {}, "Put the records of your other database searches together with this search, and remove the duplicates: records with the same DOI or PubMed ID, and records whose titles are the same and whose year and first author, journal or pages agree. Pairs that only look alike are shown to you to decide. You get one record per study, where each was found, and the numbers of each database for the PRISMA flow diagram. The files are read in this browser and sent nowhere."),
    list, input, drop, h("div", { class: "save-actions" }, go), out);
  if (!d.open) d.showModal();
}

function show(out, ctx) {
  const res = job.result = build(job.all, job.pairs, job.decisions, job.labels);
  const summary = h("div", {});
  const drawSummary = () => {
    const r = job.result = build(job.all, job.pairs, job.decisions, job.labels);
    // a pair whose two records are already in one group (through another decision) needs no decision
    const open = r.review.filter((p) => !job.decisions.has(p.key) && r.group[p.a] !== r.group[p.b]).length;
    fill(summary,
      h("p", { class: "tools-head" }, h("strong", {}, `${plural(r.total, "record")} from ${plural(job.labels.length, "source")}: ${plural(r.removed.length, "duplicate")} removed, ${plural(r.merged.length, "record")} left.`),
        r.review.length ? ` ${plural(r.review.length, "pair looks", "pairs look")} alike; ${open ? `${fmt(open)} still for you to decide (until then they are kept apart).` : "you have decided all of them."}` : ""),
      h("table", { class: "cb-table" },
        h("thead", {}, h("tr", {}, ["Source", "Records", "Duplicates within it", "Also in another source", "Only here"].map((x) => h("th", {}, x)))),
        h("tbody", {}, job.labels.map((l) => h("tr", {}, h("td", {}, l), h("td", {}, fmt(r.per[l].records)), h("td", {}, fmt(r.per[l].within)), h("td", {}, fmt(r.per[l].shared)), h("td", {}, fmt(r.per[l].only)))))),
      h("p", { class: "note" }, "Found in: ", r.combos.slice(0, 8).map(([k, n], i) => [i ? " · " : "", h("strong", {}, k), ` ${fmt(n)}`])),
      h("div", { class: "tools-actions" },
        h("button", { type: "button", class: "btn btn-small btn-primary", onclick: (e) => save(e.target, ctx, saveBox) }, "Save to Google Drive"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => exportCsv(ctx) }, "Export CSV"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.download(`combined-${today()}.ris`, ctx.ris(r.merged), "application/x-research-info-systems", `Exported ${plural(r.merged.length, "record")}`) }, "Export RIS"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => exportRemoved(ctx) }, "Duplicates removed (CSV)"),
        h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.download(`prisma-flow-diagram-${today()}.svg`, ctx.prisma(counts(r)), "image/svg+xml", "Flow diagram downloaded") }, "PRISMA diagram (SVG)"),
        ctx.screen ? h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.screen(r.merged, { name: `Combined search ${job.date}`, source: `Combined search: ${job.labels.join(", ")}`, terms: [] }) }, "Screen these records") : null));
  };
  const saveBox = h("div", { class: "save-progress" });
  const pairsBox = h("ol", { class: "cb-pairs" });
  let shownPairs = 50;
  const describe = (r) => h("div", { class: "cb-rec" }, h("span", { class: "cb-src" }, r.label), h("strong", {}, r.title),
    h("span", { class: "tools-meta" }, [r.year, r.authors, r.venue, r.doi ? `DOI ${r.doi}` : "", r.pmid ? `PMID ${r.pmid}` : ""].filter(Boolean).join(" · ")));
  const drawPairs = () => {
    const list = [...res.review].sort((a, b) => b.sim - a.sim).slice(0, shownPairs);
    fill(pairsBox, list.map((p) => {
      const choose = (v) => { if (job.decisions.get(p.key) === v) job.decisions.delete(p.key); else job.decisions.set(p.key, v); drawPairs(); drawSummary(); };
      const dec = job.decisions.get(p.key);
      return h("li", { class: `cb-pair${dec ? ` decided-${dec}` : ""}` },
        h("p", { class: "cb-why" }, `${Math.round(p.sim * 100)}% alike: ${p.why}.`), describe(job.all[p.a]), describe(job.all[p.b]),
        h("div", { class: "tools-actions" },
          h("button", { type: "button", class: "btn btn-small", "aria-pressed": String(dec === "same"), onclick: () => choose("same") }, "The same study"),
          h("button", { type: "button", class: "btn btn-small", "aria-pressed": String(dec === "different"), onclick: () => choose("different") }, "Not the same")));
    }));
  };
  drawSummary();
  drawPairs();
  fill(out, summary, saveBox,
    res.review.length ? [h("h3", {}, `Pairs to check (${fmt(res.review.length)})`), pairsBox,
      res.review.length > shownPairs ? h("button", { type: "button", class: "btn btn-small", onclick: (e) => { shownPairs += 100; drawPairs(); if (shownPairs >= res.review.length) e.target.remove(); } }, "Show more pairs") : null] : null,
    h("p", { class: "note" }, "Rules: the same DOI or PubMed ID; or titles at least 97% alike (letter pairs, after removing case, accents and punctuation) with the year (or the year ±1 when two other details agree) and the first author, the journal, or the volume and first page; never a correction or retraction notice with the article it corrects. Titles 85–97% alike, and near-identical titles with different DOIs (a preprint and its article), are left for you. The fullest record of each group is kept, with the DOI, abstract and pages the others add."));
}

function counts(r) {
  return { date: job.date, databases: job.labels.map((l) => [l, r.per[l].records]), registers: null, duplicates: r.removed.length, otherRemoved: null, screened: null, citation: null };
}

const HEAD = ["No.", "Title", "Abstract", "Authors", "Year", "Journal or source", "Volume", "Issue", "Pages", "DOI", "PubMed ID", "Link", "Language", "Keywords", "Found in", "Records merged"];
const rowOf = (r, i) => [i + 1, r.title, r.full || r.abstract || "", (r.people || []).join("; ") || r.authors, r.year || "", r.venue, r.volume, r.issue,
  [r.fpage, r.lpage].filter(Boolean).join("-"), r.doi ? `https://doi.org/${r.doi}` : "", r.pmid, r.url || r.landing || "", r.lang, (r.keywords || []).join("; "), (r.foundIn || []).join("; "), r.merged];
const REMOVED_HEAD = ["Removed record", "From", "Year", "DOI", "PubMed ID", "Kept record", "Kept from", "Why"];
const removedRows = (r) => r.removed.map((x) => [x.r.title, x.r.label, x.r.year || "", x.r.doi, x.r.pmid, x.kept.title, x.kept.label, x.why]);
const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

function exportCsv(ctx) {
  const r = job.result;
  ctx.download(`combined-${today()}.csv`, csv([HEAD, ...r.merged.map(rowOf)]), "text/csv;charset=utf-8", `Exported ${plural(r.merged.length, "record")}`);
}
function exportRemoved(ctx) {
  const r = job.result;
  ctx.download(`duplicates-removed-${today()}.csv`, csv([REMOVED_HEAD, ...removedRows(r)]), "text/csv;charset=utf-8", `Exported ${plural(r.removed.length, "duplicate")}`);
}

async function save(button, ctx, box) {
  const r = job.result;
  button.disabled = true;
  try {
    const done = await ctx.save({
      title: `Combined search${job.search && job.search.query ? ` (${job.search.query})` : ""}`, header: [...HEAD], rows: r.merged.map(rowOf), records: r.merged,
      details: () => combineHtml(r), tables: [{ name: "Duplicates removed", rows: [REMOVED_HEAD, ...removedRows(r)] }], prisma: ctx.prisma(counts(r)),
      progress: (m) => fill(box, spinner(), m),
    });
    fill(box, h("p", {}, h("strong", {}, "Saved: "), ctx.link(done.folder, "Open the folder"), " · ", ctx.link(done.sheet, "Records"), " · ", ctx.link(done.doc, "Search details")));
  } catch (e) {
    fill(box, h("p", { class: "note warn" }, `Not saved: ${e.message}`));
  } finally {
    button.disabled = false;
  }
}

/* "Search details" of a combined search: the sources, the method and the numbers, for PRISMA-S items 15 and 16. */
export function combineHtml(r) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const decided = [...job.decisions.values()];
  const same = decided.filter((v) => v === "same").length, apart = decided.filter((v) => v === "different").length;
  const undecided = r.review.filter((p) => !job.decisions.has(p.key));
  const joined = undecided.filter((p) => r.group[p.a] === r.group[p.b]).length, open = undecided.length - joined;
  const src = job.sources.map((s) => `<tr><td>${esc(s.label)}</td><td>${esc(s.name)}</td><td>${esc(s.format)}</td><td>${fmt(s.records.length)}</td></tr>`).join("");
  const per = job.labels.map((l) => `<tr><td>${esc(l)}</td><td>${fmt(r.per[l].records)}</td><td>${fmt(r.per[l].within)}</td><td>${fmt(r.per[l].shared)}</td><td>${fmt(r.per[l].only)}</td></tr>`).join("");
  const whys = Object.entries(r.byWhy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)}: ${fmt(n)}`).join("; ");
  return `<html><head><meta charset="utf-8"></head><body>
<h1>Combined search</h1>
<p>Made with Research Finder (<a href="${esc(location.origin + location.pathname)}">${esc(location.origin + location.pathname)}</a>) on ${esc(dayText(job.date))}.</p>
<h2>Sources</h2>
<table border="1" cellpadding="5" cellspacing="0"><tr><th>Database</th><th>File</th><th>Format</th><th>Records</th></tr>${src}</table>
${job.search ? `<p>“${esc(job.search.label)}” is the search made in Research Finder (${esc(job.search.link)}); its own “Search details”, saved with it, has its terms and queries.</p>` : ""}
<p>[Give, for each database, the platform, the date of the search and the full strategy, as PRISMA-S items 1 and 8 ask.]</p>
<h2>Deduplication</h2>
<p>The ${fmt(r.total)} records were put together and compared in Research Finder: records with the same DOI or PubMed ID were taken as the same study; so were records whose titles were at least 97% alike (letter pairs, after case, accents and punctuation were removed) and whose year (or year ±1, when two other details agreed) and first author, journal, or volume and first page agreed, except a correction or retraction notice and the article it concerns. Pairs whose titles were 85–97% alike, and near-identical titles with different DOIs (such as a preprint and its article), were shown to the reviewer${r.review.length ? `: ${fmt(r.review.length)} pairs, of which ${fmt(same)} were judged the same study, ${fmt(apart)} not the same${joined ? `, ${fmt(joined)} were joined through another decision` : ""}, and ${fmt(open)} were left undecided and kept apart` : "; there were none"}. In each group, the record with the most details was kept, with the DOI, abstract and pages the others added. [Say who checked the pairs.]</p>
<p>${fmt(r.removed.length)} duplicates were removed (${whys || "none"}), leaving ${fmt(r.merged.length)} records, in “Results” and “Results.ris”, each with the sources it was found in (column “Found in”). The sheet “Duplicates removed” lists every removed record, the record kept and why.</p>
<h2>Where the records were found</h2>
<table border="1" cellpadding="5" cellspacing="0"><tr><th>Source</th><th>Records</th><th>Duplicates within it</th><th>Also in another source</th><th>Only here</th></tr>${per}</table>
<p>Combinations: ${r.combos.map(([k, n]) => `${esc(k)} ${fmt(n)}`).join("; ")}.</p>
<h2>PRISMA 2020 flow diagram</h2>
<p>“PRISMA flow diagram.svg” in this folder has these numbers: records identified from databases: ${job.labels.map((l) => `${esc(l)} (n = ${fmt(r.per[l].records)})`).join(", ")}; duplicate records removed (n = ${fmt(r.removed.length)}). Fill in the rest after screening.</p>
<h2>Reporting (PRISMA-S)</h2>
<p><b>Item 15, total records:</b> ${job.labels.map((l) => `${esc(l)} ${fmt(r.per[l].records)}`).join("; ")}; ${fmt(r.total)} in all.</p>
<p><b>Item 16, deduplication:</b> duplicates were removed with Research Finder's deduplication (the rules above), on ${esc(dayText(job.date))}${r.review.length ? `, with ${fmt(r.review.length)} possible duplicates checked by the reviewer` : ""}: ${fmt(r.removed.length)} duplicates removed, ${fmt(r.merged.length)} records left.</p>
</body></html>`;
}
