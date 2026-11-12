/* Where Research Finder searches: OpenAlex for studies of every field; DataCite, Zenodo, Harvard Dataverse, OSF and
   OpenAIRE for datasets. Every search returns records of one shape:
   { key, source, kind, year, date, title, authors, venue, doi, url, pdf, lang, keywords, abstract, open, cited,
     files (Zenodo: open data files), pid (Dataverse: the dataset's persistent id), osf (OSF: the project's address),
     landing (the repository's page of the dataset) } */
import { getJSON, local, norm, openalexJSON, openalexRefusal, snippet, stripHtml } from "./util.js?v=39";
import { LANG_PRIORITY, isTranslation, mainWords } from "./terms.js?v=39";

export const KIND_NAMES = { a: "Article", p: "Preprint", v: "Review", b: "Book or chapter", d: "Dataset", t: "Thesis", o: "Other", r: "Registered study", m: "Questionnaire or scale" };
const SRC_RANK = { you: 0, alias: 1, mt: 1, variant: 2, similar: 3, studies: 3 };
/* English terms first, then the translations: the first term in every language, then the second, and so on, the
   languages with the most research first. */
const termRank = (t) => (isTranslation(t) ? 10 + (t.of || 0) * 100 + LANG_PRIORITY.indexOf(t.lang) : (SRC_RANK[t.src] ?? 3) + t.i / 1e7);
const LUCENE = { or: " OR ", and: " AND " };
const TROVE = { or: " | ", and: " " };          // OSF's search
const FEW = { ...LUCENE, terms: 5 };             // OpenAIRE: at most four operators, so five terms

/* The terms as one Boolean query: OR within a keyword, AND (or OR) between keywords. Long queries are shortened in
   the order above (and to syntax.terms terms, where a service takes few operators); `used` tells which terms the
   query covers. */
export function booleanQuery(groups, mode, maxLen = 3000, syntax = LUCENE) {
  const perGroup = syntax.terms ? Math.max(1, Math.floor(syntax.terms / Math.max(1, groups.length))) : Infinity;
  const quote = (t) => (t.loose
    ? `(${mainWords(t.text).join(syntax.and)})`
    : `"${t.text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`);
  const budget = Math.max(60, Math.floor(maxLen / Math.max(1, groups.length)) - 6);
  let dropped = 0;
  const used = new Set();
  const parts = groups.map((terms) => {
    const keep = [], kept = [];
    let len = 0;
    for (const t of [...terms].sort((a, b) => termRank(a) - termRank(b))) {
      const n = ` ${norm(t.text)} `;
      if (kept.some((k) => n.includes(k))) { used.add(t.i); continue; }   // "public trust in science" adds nothing to an OR
      const q = quote(t);
      if ((len + q.length + syntax.or.length > budget || keep.length >= perGroup || (t.loose && syntax.terms)) && keep.length) { dropped++; continue; }
      keep.push(q);
      kept.push(n);
      used.add(t.i);
      len += q.length + syntax.or.length;
    }
    return keep.length > 1 ? `(${keep.join(syntax.or)})` : keep[0] || "";
  }).filter(Boolean);
  return { query: parts.join(mode === "all" ? syntax.and : syntax.or), dropped, used };
}

/* A search too long for one query as several, each within maxLen: the first with your words and the English terms
   (in one query with them, rare translations would outrank every English study), the next ones with the
   translations, the first translation in every language first (a keyword with none left keeps its translations, so
   that all keywords still have to match). */
export function booleanParts(groups, mode, maxLen, maxParts = 1, syntax = LUCENE) {
  const covered = new Set(), parts = [];
  const split = maxParts > 1 && groups.some((g) => g.some(isTranslation));      // with one query only, all in it
  let left = 0;
  while (parts.length < maxParts) {
    const first = !parts.length && split;
    const todo = groups.map((g) => {
      const english = g.filter((t) => !isTranslation(t)), translations = g.filter(isTranslation);
      if (first) return english.length ? english : g;
      const rest = g.filter((t) => !covered.has(t.i));
      if (rest.length) return rest;
      return mode === "all" ? (translations.length ? translations : g) : [];
    }).filter((g) => g.length);
    const bq = booleanQuery(todo, mode, maxLen, syntax);
    if (!bq.query) break;
    parts.push(bq.query);
    bq.used.forEach((i) => covered.add(i));
    left = groups.flat().filter((t) => !covered.has(t.i)).length;
    if (!left) break;
  }
  return { parts, dropped: left };
}

function openalexParams() {
  const p = new URLSearchParams();
  const key = local.get("openalexKey", "");
  if (key) p.set("api_key", key);
  return p;
}
/* OpenAlex searches one search takes: each costs a share of the daily allowance, which a key makes ten times larger. */
export const maxParts = () => (local.get("openalexKey", "") ? 8 : 3);

function friendly(e, who) {
  if (e.status === 400 && /too long/i.test(e.detail || "")) return `${who}: the search is too long; choose fewer languages under Settings.`;
  if (who === "OpenAlex" && openalexRefusal(e)) return openalexRefusal(e);
  if (e.status === 429) return `${who} is limiting searches right now; try again in a minute.`;
  return `${who}: ${e.message}`;
}

const authorList = (names) => names.slice(0, 4).join("; ") + (names.length > 4 ? " et al." : "");
const interleave = (lists) => {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
};

/* ------------------------------------------------------------------ OpenAlex: studies */
const OA_TYPES = { article: "a", preprint: "p", review: "v", book: "b", "book-chapter": "b", monograph: "b", dataset: "d",
  dissertation: "t", editorial: "a", letter: "a" };
const OA_FILTER_TYPES = { a: "article", p: "preprint", v: "review", b: "book|book-chapter", d: "dataset", t: "dissertation" };
const OA_FIELDS = "id,doi,display_name,publication_year,publication_date,type,language,primary_location,best_oa_location,open_access,authorships,keywords,abstract_inverted_index,cited_by_count,is_retracted,study_designs,biblio";

/* The whole abstract (the page shows its start; the sheets and the RIS file get all of it). */
function abstractOf(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) if (p < 3000) words[p] = w;
  return snippet(words.filter(Boolean).join(" "), 20000);
}

function fromOpenAlex(w) {
  const loc = w.primary_location || {}, src = loc.source || {}, oa = w.best_oa_location || {};
  const people = (w.authorships || []).map((a) => (a.author || {}).display_name).filter(Boolean);
  const full = abstractOf(w.abstract_inverted_index);
  return {
    key: w.doi ? `doi:${w.doi.replace(/^https?:\/\/doi\.org\//, "").toLowerCase()}` : w.id, source: "OpenAlex",
    kind: OA_TYPES[w.type] || "o", type: w.type || "", year: w.publication_year || 0, date: w.publication_date || "", title: w.display_name || "(untitled)",
    authors: authorList(people), people,
    venue: src.display_name || "", doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//, ""),
    url: w.doi ? "" : loc.landing_page_url || w.id, pdf: oa.pdf_url || "", lang: w.language || "",
    keywords: (w.keywords || []).map((k) => k.display_name).slice(0, 8), abstract: snippet(full, 400), full,
    open: !!(w.open_access || {}).is_oa, cited: w.cited_by_count || 0,
    retracted: Boolean(w.is_retracted), designs: (w.study_designs || []).map((d) => String(d.id || "").split("/").pop()).filter(Boolean),
    oa: oaId(w.id), refs: (w.referenced_works || []).map(oaId), pmid: oaId(((w.ids || {}).pmid) || ""),
    related: (w.related_works || []).map(oaId),
    site: loc.landing_page_url || "", doaj: Boolean(src.is_in_doaj),
    countries: [...new Set((w.authorships || []).flatMap((a) => a.countries || []))],
    // for references and library links: the journal's ISSN, the volume, issue and pages, the publisher
    issn: src.issn_l || (src.issn || [])[0] || "", volume: (w.biblio || {}).volume || "", issue: (w.biblio || {}).issue || "",
    fpage: (w.biblio || {}).first_page || "", lpage: (w.biblio || {}).last_page || "", publisher: src.host_organization_name || "",
  };
}
const oaId = (url) => String(url || "").split("/").pop();

/* Titles and abstracts, or with full texts too. */
function openalexQuery({ filters, sort }, search) {
  const p = openalexParams();
  const f = [];
  if (search && filters.fulltext) p.set("search", search);
  else if (search) p.set("search.title_and_abstract", search);
  if (filters.kinds.length) f.push(`type:${filters.kinds.map((k) => OA_FILTER_TYPES[k]).filter(Boolean).join("|")}`);
  if ((filters.designs || []).length) f.push(`study_designs.id:${filters.designs.join("|")}`);
  if (filters.from || filters.to) f.push(`publication_year:${filters.from || ""}-${filters.to || ""}`);
  if (filters.open) f.push("open_access.is_oa:true");
  if (filters.langs.length) f.push(`language:${filters.langs.join("|")}`);
  if ((filters.countries || []).length) f.push(`authorships.countries:${filters.countries.join("|")}`);
  if (filters.south) f.push("authorships.institutions.is_global_south:true");
  if (/^W\d+$/.test(filters.cites || "")) f.push(`cites:${filters.cites}`);
  if (f.length) p.set("filter", f.join(","));
  if (sort === "new") p.set("sort", "publication_date:desc");
  else if (sort === "cited") p.set("sort", "cited_by_count:desc");
  p.set("select", OA_FIELDS);
  return p;
}

/* The results of the parts of a search as one list: the first part's in its order, then the others' in turn, studies
   in English or in the browser's language first (a short title in another language often matches best); by date or
   citations when sorted so. */
function merge(lists, sort) {
  const seen = new Set(), out = [];
  const add = (r) => { if (!seen.has(r.key)) { seen.add(r.key); out.push(r); } };
  if (sort === "new") lists.flat().sort((a, b) => (b.date || String(b.year)).localeCompare(a.date || String(a.year))).forEach(add);
  else if (sort === "cited") lists.flat().sort((a, b) => b.cited - a.cited).forEach(add);
  else {
    (lists[0] || []).forEach(add);
    interleave(lists.slice(1)).forEach(add);
    const home = new Set(["en", (navigator.language || "en").slice(0, 2).toLowerCase()]);
    // OpenAlex leaves the language of many studies empty, and calls some in Chinese or Romanian English: the title
    // decides (English words, or a short title in plain letters)
    const plain = (title) => !/[^\x00-\x7f‘’“”–—]/.test(title);
    const english = (r) => plain(r.title) && (/\b(the|of|and|in|on|for|with|to|from|by|among|between|is|are|how|what|why|does)\b/i.test(r.title)
      || (r.lang === "en" && r.title.split(/\s+/).length <= 4));
    const later = (r) => (english(r) || (r.lang !== "en" && home.has(r.lang)) ? 0 : 1);
    out.sort((a, b) => later(a) - later(b));
  }
  return out;
}

const partCount = new Map();        // a part's query -> how many results it has, so finished parts are not asked again

export const studies = {
  id: "studies",
  name: "Studies",
  note: "OpenAlex: 270 million works from every field",
  tab: "OpenAlex", noun: ["study", "studies"],
  sorts: [["rel", "Best match"], ["new", "Newest first"], ["cited", "Most cited"]],
  filters: ["fulltext", "kinds", "designs", "years", "open", "langs", "authors"],
  kinds: ["a", "p", "v", "b", "d", "t"],
  queries: (q) => booleanParts(q.groups, q.mode, 1450, maxParts()),        // OpenAlex takes up to 1,500 characters
  async search(q, page, size = 25) {
    const { parts, dropped } = studies.queries(q);
    const notes = [];
    let total = 0, more = false;
    const answers = await Promise.allSettled(parts.map(async (search) => {
      const p = openalexQuery(q, search);
      const id = p.toString();
      const known = partCount.get(id);
      if (known != null && (page - 1) * size >= Math.min(known, 10000)) return { count: known, items: [] };
      p.set("per-page", String(size));
      p.set("page", String(page));
      const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 30000 });
      partCount.set(id, j.meta.count);
      return { count: j.meta.count, items: j.results.map(fromOpenAlex) };
    }));
    const lists = answers.map((a, i) => {
      if (a.status === "rejected") {
        if (i === 0) throw new Error(friendly(a.reason, "OpenAlex"));
        notes.push(`${friendly(a.reason, "OpenAlex").replace(/[^.]$/, "$&.")} Search ${i + 1} of ${parts.length} (more translations) was left out.`);
        return [];
      }
      total += a.value.count;
      if (page * size < Math.min(a.value.count, 10000)) more = true;
      return a.value.items;
    });
    return { total, items: merge(lists, q.sort), more, dropped, parts: parts.length, notes };
  },
  /* Whether a part of the search has more results than OpenAlex pages through without a key (10,000). */
  capped: (q) => studies.queries(q).parts.some((s) => (partCount.get(openalexQuery(q, s).toString()) || 0) > 10000),
  /* For saving: every result, round by round (200 from each part of the search a round, merged as on the page, each
     study once). Without a key OpenAlex pages through the first 10,000 results of a query; with one, its cursor goes
     to the end. A part that fails stops; when OpenAlex refuses (the day's allowance is spent), everything stops.
     `notes` says what happened. */
  async *all(q, notes = [], { queries = null, info = null } = {}) {
    const cursor = Boolean(local.get("openalexKey", ""));
    // `queries`: the exact searches of an earlier save, to run it again as it was; `info.total`: how many results the
    // searches have (a study two of them find counts twice), set once each has answered
    const parts = (queries || studies.queries(q).parts).map((search) => ({ search, next: cursor ? "*" : 1, done: false, count: null }));
    const seen = new Set();
    while (parts.some((s) => !s.done)) {
      const answers = await Promise.allSettled(parts.map(async (s, i) => {
        if (s.done) return [];
        const p = openalexQuery(q, s.search);
        p.set("per-page", "200");
        if (cursor) p.set("cursor", s.next); else p.set("page", String(s.next));
        const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 60000, cacheable: false });
        const items = (j.results || []).map(fromOpenAlex);
        if (s.count == null) {
          s.count = j.meta.count;
          if (info) info.total = parts.reduce((sum, x) => sum + (x.count || 0), 0);
        }
        if (cursor) {
          s.next = j.meta.next_cursor;
          s.done = !s.next || !items.length;
        } else {
          s.next += 1;
          s.done = !items.length || (s.next - 1) * 200 >= Math.min(j.meta.count, 10000);
          if (s.done && j.meta.count > 10000) {
            notes.push(`Without an OpenAlex key, only the first 10,000 of the ${j.meta.count.toLocaleString("en")} results of search ${i + 1} could be reached; a free key (Settings) reaches all of them.`);
          }
        }
        return items;
      }));
      answers.forEach((a, i) => {
        if (a.status !== "rejected") return;
        parts[i].done = true;
        const refused = openalexRefusal(a.reason);
        if (refused) {
          parts.forEach((s) => { s.done = true; });
          notes.push(`The save stopped early. ${refused}`);
        } else {
          notes.push(`${friendly(a.reason, "OpenAlex").replace(/[^.]$/, "$&.")} Search ${i + 1} of ${parts.length} stopped early.`);
        }
      });
      yield merge(answers.map((a) => (a.status === "fulfilled" ? a.value : [])), q.sort)
        .filter((r) => !seen.has(r.key) && seen.add(r.key));
    }
  },
  /* Which of these works (OpenAlex IDs) the search finds, with its filters: one search per part of the query for each
     100 works (each a search: 10 credits). */
  async matches(q, ids) {
    const found = new Set();
    for (const search of studies.queries(q).parts) {
      for (let i = 0; i < ids.length; i += 100) {
        const p = openalexQuery(q, search);
        p.set("filter", [p.get("filter"), `openalex:${ids.slice(i, i + 100).join("|")}`].filter(Boolean).join(","));
        p.set("per-page", "100");
        p.set("select", "id");
        const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 30000 });
        for (const w of j.results || []) found.add(oaId(w.id));
      }
    }
    return found;
  },
  /* Who and what the results are: every result counted by year, type, language, the countries of its authors, whether
     an author is at an institution in the Global South, its journal and open access, in one request per part of the
     search (a search: 10 credits each). The parts' counts are added up, so a study two parts find counts twice. */
  async overview(q) {
    const dims = ["publication_year", "type", "language", "authorships.countries", "authorships.institutions.is_global_south",
      "primary_location.source.id", "open_access.is_oa"];
    const sums = Object.fromEntries(dims.map((d) => [d, new Map()]));
    let count = 0;
    for (const search of studies.queries(q).parts) {
      const p = openalexQuery(q, search);
      p.delete("select");
      p.delete("sort");
      p.set("group_bys", dims.join(","));
      p.set("per-page", "200");
      const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 60000 });
      count += j.meta.count;
      for (const g of j.group_bys || []) {
        const m = sums[g.group_by_key];
        if (!m) continue;
        for (const x of g.groups || []) {
          const key = String(x.key).split("/").pop();
          const e = m.get(key) || m.set(key, { key, name: x.key_display_name || key, n: 0 }).get(key);
          e.n += x.count;
        }
      }
    }
    return { count, dims: Object.fromEntries(dims.map((d) => [d, [...sums[d].values()].sort((a, b) => b.n - a.n)])) };
  },
  /* The references of the best-matching results: up to 200 from each part of the search (one search each). */
  async references(q) {
    const works = new Map();
    for (const search of studies.queries(q).parts) {
      const p = openalexQuery({ ...q, sort: "rel" }, search);
      p.set("per-page", "200");
      p.set("select", "id,referenced_works");
      const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 60000 });
      for (const w of j.results || []) works.set(oaId(w.id), (w.referenced_works || []).map(oaId));
    }
    return works;
  },
};

/* ------------------------------------------------------------------ OpenAlex: works by identifier, and their citations */
const WORK_FIELDS = `${OA_FIELDS},referenced_works,related_works,ids`;

/* Works by DOI, PubMed ID or OpenAlex ID, 100 to a request (a list, 1 credit: a tenth of a search). */
export async function worksByIds({ dois = [], pmids = [], ids = [] }) {
  const out = [];
  for (const [field, list] of [["doi", dois], ["pmid", pmids], ["openalex", ids]]) {
    for (let i = 0; i < list.length; i += 100) {
      const p = openalexParams();
      p.set("filter", `${field}:${list.slice(i, i + 100).join("|")}`);
      p.set("per-page", "100");
      p.set("select", WORK_FIELDS);
      const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 30000 });
      out.push(...(j.results || []).map(fromOpenAlex));
    }
  }
  return out;
}

/* Works that cite any of these works (OpenAlex IDs), the newest first, 200 to a request (1 credit), up to `max`.
   `total`: how many there are (a work citing two groups of 100 counts twice). */
export async function citingWorks(ids, max = 2000, onProgress = () => {}) {
  const out = new Map();
  let total = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const group = ids.slice(i, i + 100);
    for (let page = 1; ; page++) {
      const p = openalexParams();
      p.set("filter", `cites:${group.join("|")}`);
      p.set("sort", "publication_date:desc");
      p.set("per-page", "200");
      p.set("page", String(page));
      p.set("select", WORK_FIELDS);
      const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 60000 });
      if (page === 1) total += j.meta.count;
      for (const w of j.results || []) if (out.size < max) out.set(oaId(w.id), fromOpenAlex(w));
      onProgress(out.size, Math.min(total, max));
      if (out.size >= max || !(j.results || []).length || page * 200 >= Math.min(j.meta.count, 10000)) break;
    }
    if (out.size >= max) break;
  }
  return { works: [...out.values()], total };
}

/* ------------------------------------------------------------------ data repositories */
const val = (x) => ((x || [])[0] || {})["@value"] || "";
const OPENAIRE_LANGS = { eng: "en", deu: "de", ger: "de", fra: "fr", fre: "fr", spa: "es", por: "pt", ita: "it", pol: "pl", nld: "nl", dut: "nl", rus: "ru", zho: "zh", chi: "zh", jpn: "ja" };

function fromDataCite(d) {
  const a = d.attributes || {};
  const desc = (a.descriptions || []).find((x) => x.descriptionType === "Abstract") || (a.descriptions || [])[0] || {};
  const measure = /^10\.6102\//.test(a.doi || "") || (/^10\.23668\//.test(a.doi || "") && /^test$/i.test((a.types || {}).resourceType || ""));
  return {
    key: `doi:${(a.doi || "").toLowerCase()}`, source: measure ? (/^10\.6102\//.test(a.doi) ? "ZIS (GESIS)" : "PsychArchives (ZPID)") : "DataCite", kind: measure ? "m" : "d", year: +a.publicationYear || 0, date: String(a.publicationYear || ""),
    title: ((a.titles || [])[0] || {}).title || "(untitled)", authors: authorList((a.creators || []).map((c) => c.name).filter(Boolean)), people: (a.creators || []).map((c) => c.name).filter(Boolean),
    venue: typeof a.publisher === "object" ? (a.publisher || {}).name || "" : a.publisher || "", doi: a.doi || "", url: "", pdf: "",
    lang: (a.language || "").slice(0, 2), keywords: (a.subjects || []).map((s) => s.subject).filter(Boolean).slice(0, 8),
    abstract: snippet(stripHtml(desc.description || ""), 400), full: snippet(stripHtml(desc.description || ""), 20000), open: true, cited: a.citationCount || 0,
    size: (a.sizes || []).join(", "), license: ((a.rightsList || [])[0] || {}).rights || "", landing: a.url || "",
  };
}

function fromZenodo(r) {
  const m = r.metadata || {};
  const open = m.access_right === "open";
  return {
    key: `doi:${(r.doi || m.doi || `zenodo:${r.id}`).toLowerCase()}`, source: "Zenodo", kind: "d", year: +(m.publication_date || "").slice(0, 4) || 0,
    date: m.publication_date || "", title: m.title || "(untitled)", authors: authorList((m.creators || []).map((c) => c.name).filter(Boolean)), people: (m.creators || []).map((c) => c.name).filter(Boolean), venue: "Zenodo",
    doi: r.doi || m.doi || "", url: r.doi ? "" : (r.links || {}).self_html || "", pdf: "", lang: (m.language || "").slice(0, 2),
    keywords: (m.keywords || []).slice(0, 8), abstract: snippet(stripHtml(m.description || ""), 400), full: snippet(stripHtml(m.description || ""), 20000), open, cited: 0,
    license: ((m.license || {}).id || ""),
    files: open ? (r.files || []).map((f) => ({ name: f.key, size: f.size, url: (f.links || {}).self || "" })).filter((f) => f.url) : [],
  };
}

function fromDataverse(it) {
  const doi = (it.global_id || "").startsWith("doi:") ? it.global_id.slice(4) : "";
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : it.url, source: "Harvard Dataverse", kind: "d", year: +(it.published_at || "").slice(0, 4) || 0,
    date: it.published_at || "", title: it.name || "(untitled)", authors: authorList(it.authors || []), people: it.authors || [], venue: it.name_of_dataverse || "Harvard Dataverse",
    doi, url: doi ? "" : it.url || "", pdf: "", lang: "", keywords: [...(it.keywords || []), ...(it.subjects || [])].slice(0, 8),
    abstract: snippet(stripHtml(it.description || ""), 400), full: snippet(stripHtml(it.description || ""), 20000), open: true, cited: 0, pid: it.global_id || "",
  };
}

function fromOSF(m) {
  const ids = (m.identifier || []).map((x) => x["@value"] || "");
  const doi = (ids.find((x) => /doi\.org\/10\./i.test(x)) || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const type = ((m.resourceType || [])[0] || {})["@id"] || "";
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : m["@id"] || "", source: "OSF", kind: "d", year: +val(m.dateCreated).slice(0, 4) || 0,
    date: val(m.dateCreated), title: val(m.title) || "(untitled)", authors: authorList((m.creator || []).map((c) => val(c.name)).filter(Boolean)), people: (m.creator || []).map((c) => val(c.name)).filter(Boolean),
    venue: /Registration/.test(type) ? "OSF Registries" : "OSF", doi, url: doi ? "" : m["@id"] || "", pdf: "", lang: "",
    keywords: (m.keyword || []).map((k) => k["@value"]).filter(Boolean).slice(0, 8), abstract: snippet(val(m.description), 400), full: snippet(val(m.description), 20000),
    open: true, cited: 0, license: val(((m.rights || [])[0] || {}).name), osf: m["@id"] || "", landing: m["@id"] || "",
  };
}

function fromOpenAIRE(r) {
  const doi = ((r.pids || []).find((x) => x.scheme === "doi") || {}).value || "";
  const inst = (r.instances || [])[0] || {};
  const url = (inst.urls || [])[0] || "";
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : `openaire:${r.id}`, source: "OpenAIRE", kind: "d", year: +(r.publicationDate || "").slice(0, 4) || 0,
    date: r.publicationDate || "", title: r.mainTitle || "(untitled)", authors: authorList((r.authors || []).map((a) => a.fullName).filter(Boolean)), people: (r.authors || []).map((a) => a.fullName).filter(Boolean),
    venue: r.publisher || (inst.hostedBy || {}).value || "", doi, url: doi ? "" : url, pdf: "", lang: OPENAIRE_LANGS[(r.language || {}).code] || "",
    keywords: (r.subjects || []).map((s) => (s.subject || {}).value).filter((v) => v && !/^(\d|FOS:)/.test(v)).slice(0, 8),
    abstract: snippet(stripHtml((r.descriptions || [])[0] || ""), 400), full: snippet(stripHtml((r.descriptions || [])[0] || ""), 20000), open: !/closed|restricted|embargo/i.test((r.bestAccessRight || {}).label || ""),
    cited: ((r.indicators || {}).citationImpact || {}).citationCount || 0, license: inst.license || "", landing: url,
  };
}

/* One entry per dataset: versions have their own DOIs, a dataset can be in several repositories, and an OSF project
   and its registration are copies, so records with the same title and year count once; short generic titles ("Data",
   "Analyses"), which different projects share, count by their keys only. True for a record not seen before. */
function firstOf(r, seen) {
  const title = norm(r.title), same = title.split(" ").length >= 3 ? `${title}|${r.year}` : "";
  if (seen.has(r.key) || (same && seen.has(same))) return false;
  seen.add(r.key);
  if (same) seen.add(same);
  return true;
}

/* OSF's search pages by cursor: the address of each page comes with the one before it. */
const troveNext = new Map(), troveTotal = new Map();
async function trovePage(p, page) {
  const first = `https://share.osf.io/trove/index-card-search?${p}`;
  const pages = troveNext.get(first) || [first];
  troveNext.set(first, pages);
  while (pages.length < page) {
    const j = await getJSON(pages[pages.length - 1], { timeout: 25000 });
    const next = ((((j.data || {}).relationships || {}).searchResultPage || {}).links || {}).next;
    if (!next || !next.href) return { total: troveTotal.get(first) || 0, cards: [] };
    pages.push(next.href);
  }
  const j = await getJSON(pages[page - 1], { timeout: 25000 });
  const total = ((j.data || {}).attributes || {}).totalResultCount || 0;
  troveTotal.set(first, total);
  const cards = new Map((j.included || []).filter((x) => x.type === "index-card").map((c) => [c.id, c.attributes.resourceMetadata]));
  // in the order of the results
  const order = ((((j.data || {}).relationships || {}).searchResultPage || {}).data || [])
    .map((r) => ((((j.included || []).find((x) => x.type === "search-result" && x.id === r.id) || {}).relationships || {}).indexCard || {}).data)
    .map((d) => d && cards.get(d.id)).filter(Boolean);
  return { total, cards: order.length ? order : [...cards.values()] };
}

const yearList = (f) => {
  const now = new Date().getFullYear();
  const from = f.from || (f.to ? f.to - 60 : 0), to = Math.min(f.to || now, now);
  return from ? Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i).join(",") : "";
};
const yearsLucene = (f, field) => (f.from || f.to ? ` AND ${field}:[${f.from || 1000} TO ${f.to || 2999}]` : "");

/* Documented questionnaires and scales: GESIS's ZIS (DOI prefix 10.6102) and ZPID's PsychArchives tests (10.23668). */
const MEASURES = "(prefix:10.6102 OR (prefix:10.23668 AND types.resourceType:test))";

/* How long a query each repository takes (Zenodo and Dataverse fail on long Boolean queries), its syntax, and how many
   queries one search makes (OpenAIRE takes five terms a query). */
const REPO_LEN = { DataCite: 1500, Zenodo: 600, "Harvard Dataverse": 600, OSF: 800, OpenAIRE: 1000 };
const REPO_SYNTAX = { OSF: TROVE, OpenAIRE: FEW, Zenodo: { ...LUCENE, terms: 24 }, "Harvard Dataverse": { ...LUCENE, terms: 24 } };
const REPO_PARTS = { OpenAIRE: 4 };
const REPOS = {
  DataCite: async ([q], f, sort, page, size) => {
    const p = f.measures
      ? new URLSearchParams({ query: `(${q})${yearsLucene(f, "publicationYear")} AND ${MEASURES}`, "page[size]": String(Math.min(size, 1000)), "page[number]": String(page) })
      : new URLSearchParams({ query: q + yearsLucene(f, "publicationYear"), "resource-type-id": "dataset", "page[size]": String(Math.min(size, 1000)), "page[number]": String(page) });
    if (sort === "new") p.set("sort", "-published");
    const j = await getJSON(`https://api.datacite.org/dois?${p}`, { timeout: 25000 });
    return { total: (j.meta || {}).total || 0, items: (j.data || []).map(fromDataCite) };
  },
  Zenodo: async ([q], f, sort, page, size) => {
    const per = Math.min(size, 25), n = Math.ceil(size / per), out = { total: 0, items: [] };
    for (let k = 0; k < n; k++) {             // 25 a page without an account
      if (k) await new Promise((r) => setTimeout(r, 1000));          // about 60 requests a minute, Zenodo's limit
      const p = new URLSearchParams({ q: q + (f.from || f.to ? ` AND publication_date:[${f.from || 1000}-01-01 TO ${f.to || 2999}-12-31]` : ""), type: "dataset", size: String(per), page: String((page - 1) * n + k + 1) });
      p.set("sort", sort === "new" ? "newest" : "bestmatch");
      const j = await getJSON(`https://zenodo.org/api/records?${p}`, { timeout: 25000 });
      const items = ((j.hits || {}).hits || []).map(fromZenodo);
      out.total = (j.hits || {}).total || 0;
      out.items.push(...items);
      if (items.length < per) break;
    }
    return out;
  },
  "Harvard Dataverse": async ([q], f, sort, page, size) => {
    const p = new URLSearchParams({ q, type: "dataset", per_page: String(Math.min(size, 1000)), start: String((page - 1) * size) });
    if (f.from || f.to) p.set("fq", `dateSort:[${f.from || 1000}-01-01T00:00:00Z TO ${f.to || 2999}-12-31T23:59:59Z]`);
    if (sort === "new") { p.set("sort", "date"); p.set("order", "desc"); }
    const j = await getJSON(`https://dataverse.harvard.edu/api/search?${p}`, { timeout: 25000 });
    return { total: (j.data || {}).total_count || 0, items: ((j.data || {}).items || []).map(fromDataverse) };
  },
  OSF: async ([q], f, sort, page, size) => {
    const per = Math.min(size, 100), n = Math.ceil(size / per), out = { total: 0, items: [] };
    const p = new URLSearchParams({ cardSearchText: q, "cardSearchFilter[resourceType]": "Project,ProjectComponent,Registration,RegistrationComponent",
      "page[size]": String(per), acceptMediatype: "application/vnd.api+json" });
    if (sort === "new") p.set("sort", "-dateCreated");
    const years = yearList(f);
    if (years) p.set("cardSearchFilter[dateCreated]", years);
    for (let k = 0; k < n; k++) {
      const res = await trovePage(p, (page - 1) * n + k + 1);
      out.total = res.total;
      out.items.push(...res.cards.map(fromOSF));
      if (res.cards.length < per) break;
    }
    return out;
  },
  OpenAIRE: async (qs, f, sort, page, size) => {
    const per = Math.min(size, 100), n = Math.ceil(size / per);
    const one = async (q) => {
      const out = { total: 0, items: [] };
      for (let k = 0; k < n; k++) {
        const p = new URLSearchParams({ search: q, type: "dataset", pageSize: String(per), page: String((page - 1) * n + k + 1) });
        if (sort === "new") p.set("sortBy", "publicationDate DESC");
        if (f.from) p.set("fromPublicationDate", `${f.from}-01-01`);
        if (f.to) p.set("toPublicationDate", `${f.to}-12-31`);
        const j = await getJSON(`https://api.openaire.eu/graph/v1/researchProducts?${p}`, { timeout: 25000 });
        const items = (j.results || []).map(fromOpenAIRE);
        out.total = (j.header || {}).numFound || 0;
        out.items.push(...items);
        if (items.length < per) break;
      }
      return out;
    };
    const all = await Promise.all(qs.map(one));          // the first query has the main terms
    return { total: all.reduce((a, x) => a + x.total, 0), items: interleave(all.map((x) => x.items)) };
  },
};
export const REPO_NAMES = Object.keys(REPOS);
export const repoQueries = (n, groups, mode) => booleanParts(groups, mode, REPO_LEN[n], REPO_PARTS[n] || 1, REPO_SYNTAX[n]);

export const datasets = {
  id: "data",
  name: "Datasets",
  note: "DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE",
  tab: "DataCite · Zenodo · Dataverse · OSF · OpenAIRE", noun: ["dataset", "datasets"],
  sorts: [["rel", "Best match"], ["new", "Newest first"]],
  filters: ["measures", "years", "repos"],
  /* size: results asked of each repository */
  async search({ groups, mode, filters, sort }, page, size = 8) {
    // questionnaires and scales are only in DataCite
    const names = filters.measures ? ["DataCite"] : REPO_NAMES.filter((n) => !filters.repos.length || filters.repos.includes(n));
    let dropped = 0;
    const settled = await Promise.allSettled(names.map(async (n) => {
      const bq = repoQueries(n, groups, mode);
      if (n === "DataCite") dropped = bq.dropped;
      try {
        return await REPOS[n](bq.parts, filters, sort, page, size);
      } catch (e) {
        if (!(e.status >= 500)) throw e;
        // some repositories fail on long queries in many scripts: once more with the English terms only
        const english = groups.map((g) => g.filter((t) => !isTranslation(t))).filter((g) => g.length);
        return REPOS[n](repoQueries(n, english, mode).parts, filters, sort, page, size);
      }
    }));
    const lists = [], notes = [], totals = {};
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") { lists.push(s.value.items); totals[names[i]] = s.value.total; }
      else notes.push(friendly(s.reason, names[i]));
    });
    const seen = new Set();
    const items = interleave(lists).filter((r) => firstOf(r, seen));
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    return { total, items, more: Object.values(totals).some((t) => t > page * size), notes, totals, dropped };
  },
  /* For saving: every dataset, 200 from each repository a page, each dataset once, until the repositories have no more
     (Zenodo and DataCite page through their first 10,000). */
  async *all(q, notes = [], { info = null } = {}) {
    const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const res = await datasets.search(q, page, 200);
      notes.push(...(res.notes || []));
      if (info && page === 1) { info.total = res.total; info.totals = res.totals; }
      yield res.items.filter((r) => firstOf(r, seen));
      if (!res.more || !res.items.length) return;
    }
  },
};

/* ------------------------------------------------------------------ ClinicalTrials.gov: registered studies */
/* The registry's API (version 2) takes the English terms as one Boolean query and searches every field of the
   registrations. It publishes no rate limit, so requests start about a second apart. */
const CT_FIELDS = "NCTId,BriefTitle,OfficialTitle,Acronym,OverallStatus,StartDate,PrimaryCompletionDate,CompletionDate,StudyType,Phase,"
  + "EnrollmentCount,LeadSponsorName,Condition,InterventionName,BriefSummary,HasResults,LocationCountry,ReferencePMID,ReferenceType,"
  + "StudyFirstPostDate,SecondaryId";
export const CT_STATUS = { completed: ["COMPLETED"], recruiting: ["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"],
  active: ["ACTIVE_NOT_RECRUITING"], stopped: ["TERMINATED", "SUSPENDED", "WITHDRAWN"], unknown: ["UNKNOWN"] };
export const CT_STATUS_NAMES = { completed: "Completed", recruiting: "Recruiting, or about to", active: "Active, not recruiting",
  stopped: "Stopped early or withdrawn", unknown: "Status unknown" };
export const STATUS_LABEL = { COMPLETED: "Completed", RECRUITING: "Recruiting", NOT_YET_RECRUITING: "Not yet recruiting",
  ENROLLING_BY_INVITATION: "Enrolling by invitation", ACTIVE_NOT_RECRUITING: "Active, not recruiting", TERMINATED: "Terminated",
  SUSPENDED: "Suspended", WITHDRAWN: "Withdrawn", UNKNOWN: "Status unknown", AVAILABLE: "Available", NO_LONGER_AVAILABLE: "No longer available",
  TEMPORARILY_NOT_AVAILABLE: "Temporarily not available", APPROVED_FOR_MARKETING: "Approved for marketing", WITHHELD: "Withheld" };
export const CT_TYPES = { INTERVENTIONAL: "Interventional (clinical trials)", OBSERVATIONAL: "Observational", EXPANDED_ACCESS: "Expanded access" };
const PHASES = { EARLY_PHASE1: "Early phase 1", PHASE1: "Phase 1", PHASE2: "Phase 2", PHASE3: "Phase 3", PHASE4: "Phase 4" };
export const phaseText = (r) => (r.phases || []).map((x) => PHASES[x]).filter(Boolean).join("/");

function fromTrial(s) {
  const p = s.protocolSection || {}, id = p.identificationModule || {}, st = p.statusModule || {}, d = p.designModule || {};
  const summary = String((p.descriptionModule || {}).briefSummary || "").replace(/\s+/g, " ").trim();
  const conditions = (p.conditionsModule || {}).conditions || [];
  const interventions = [...new Set(((p.armsInterventionsModule || {}).interventions || []).map((x) => x.name).filter(Boolean))];
  const sponsor = ((p.sponsorCollaboratorsModule || {}).leadSponsor || {}).name || "";
  const start = (st.startDateStruct || {}).date || "";
  const nct = id.nctId || "";
  return {
    key: `nct:${nct}`, source: "ClinicalTrials.gov", kind: "r", type: "registration", nct,
    year: parseInt(start, 10) || 0, date: start, title: id.briefTitle || id.officialTitle || nct, officialTitle: id.officialTitle || "",
    authors: sponsor, people: [], org: sponsor, sponsor, venue: `ClinicalTrials.gov, ${nct}`, doi: "",
    url: `https://clinicaltrials.gov/study/${nct}`, pdf: "", lang: "en",
    keywords: [...conditions, ...interventions].slice(0, 10), conditions, interventions, abstract: snippet(summary, 400), full: summary,
    open: true, cited: 0, status: st.overallStatus || "", phases: d.phases || [], studyType: d.studyType || "",
    enrollment: (d.enrollmentInfo || {}).count || null, results: Boolean(s.hasResults),
    completion: (st.completionDateStruct || {}).date || (st.primaryCompletionDateStruct || {}).date || "",
    posted: (st.studyFirstPostDateStruct || {}).date || "",
    countries: [...new Set(((p.contactsLocationsModule || {}).locations || []).map((l) => l.country).filter(Boolean))],
    pmids: [...new Set(((p.referencesModule || {}).references || []).filter((x) => x.pmid && x.type !== "BACKGROUND").map((x) => x.pmid))],
    otherIds: ((id.secondaryIdInfos || [])).map((x) => x.id).filter(Boolean),
  };
}

function ctParams({ filters: f, sort }, query) {
  const p = new URLSearchParams();
  p.set("query.term", query);
  p.set("fields", CT_FIELDS);
  p.set("countTotal", "true");
  const statuses = (f.status || []).flatMap((x) => CT_STATUS[x] || []);
  if (statuses.length) p.set("filter.overallStatus", statuses.join(","));
  const advanced = [];
  if (f.from || f.to) advanced.push(`AREA[StartDate]RANGE[${f.from ? `${f.from}-01-01` : "MIN"},${f.to ? `${f.to}-12-31` : "MAX"}]`);
  if ((f.ctype || []).length) advanced.push(`(${f.ctype.map((t) => `AREA[StudyType]${t}`).join(" OR ")})`);
  if (advanced.length) p.set("filter.advanced", advanced.join(" AND "));
  if (f.results) p.set("aggFilters", "results:with");
  if (sort === "new") p.set("sort", "StudyFirstPostDate:desc");
  else if (sort === "start") p.set("sort", "StartDate:desc");
  return p;
}

let ctNext = 0;
async function ctJSON(url) {
  const at = Math.max(Date.now(), ctNext);
  ctNext = at + 800;
  await new Promise((r) => setTimeout(r, at - Date.now()));
  return getJSON(url, { timeout: 60000 });
}
const ctPages = new Map();     // a query -> { total, tokens: the token of each page after the first }

export const trials = {
  id: "trials",
  name: "Registered studies",
  note: "ClinicalTrials.gov: more than 600,000 registered clinical trials and observational studies",
  tab: "ClinicalTrials.gov", noun: ["registered study", "registered studies"],
  sorts: [["rel", "Best match"], ["new", "Newest registrations"], ["start", "Latest start"]],
  filters: ["status", "results", "ctype", "years"],
  /* English terms only: registrations are written in English. */
  queries: (q) => booleanParts(q.groups.map((g) => g.filter((t) => !isTranslation(t))).filter((g) => g.length), q.mode, 1800, 1),
  async search(q, page, size = 25) {
    const { parts, dropped } = trials.queries(q);
    if (!parts.length) return { total: 0, items: [], more: false, dropped, notes: [], parts: 0 };
    const p = ctParams(q, parts[0]);
    const base = `${p}`;
    const known = ctPages.get(base) || ctPages.set(base, { total: 0, tokens: [] }).get(base);
    p.set("pageSize", String(size));
    if (page > 1) {
      const token = known.tokens[page];
      if (!token) return { total: known.total, items: [], more: false, dropped, notes: [], parts: 1 };
      p.set("pageToken", token);
    }
    let j;
    try {
      j = await ctJSON(`https://clinicaltrials.gov/api/v2/studies?${p}`);
    } catch (e) {
      throw new Error(friendly(e, "ClinicalTrials.gov"));
    }
    if (page === 1 || j.totalCount != null) known.total = j.totalCount || 0;
    known.tokens[page + 1] = j.nextPageToken || "";
    return { total: known.total, items: (j.studies || []).map(fromTrial), more: Boolean(j.nextPageToken), dropped, notes: [], parts: 1 };
  },
  /* For saving: every registration, 1,000 a request. */
  async *all(q, notes = [], { info = null } = {}) {
    const { parts } = trials.queries(q);
    if (!parts.length) return;
    const p = ctParams(q, parts[0]);
    p.set("pageSize", "1000");
    let token = "";
    for (let round = 0; round < 200; round++) {
      if (token) p.set("pageToken", token);
      let j;
      try {
        j = await ctJSON(`https://clinicaltrials.gov/api/v2/studies?${p}`);
      } catch (e) {
        notes.push(`${friendly(e, "ClinicalTrials.gov").replace(/[^.]$/, "$&.")} The save stopped early.`);
        return;
      }
      if (info && !round) info.total = j.totalCount || 0;
      yield (j.studies || []).map(fromTrial);
      token = j.nextPageToken || "";
      if (!token) return;
    }
  },
};

/* ------------------------------------------------------------------ regional databases */
/* LA Referencia (theses and articles from Latin American repositories), DOAJ (articles of open-access journals,
   many of them small regional ones) and CiNii Research (Japanese articles; only with the visitor's own free application
   ID, which CiNii asks for). Each gets the terms in its languages; none uses the OpenAlex allowance. */
const regionName = (() => { try { const d = new Intl.DisplayNames(["en"], { type: "region" }); return (c) => { try { return d.of(c); } catch { return c; } }; } catch { return (c) => c; } })();
const ISO3 = { spa: "es", por: "pt", eng: "en", fra: "fr", fre: "fr", ita: "it", deu: "de", ger: "de", jpn: "ja" };
const kindOf = (format) => (/thesis/i.test(format) ? "t" : /article|journal/i.test(format) ? "a" : /book/i.test(format) ? "b" : /preprint/i.test(format) ? "p" : "o");
const doiIn = (urls) => { for (const u of urls) { const m = /doi\.org\/(10\.\d{4,9}\/\S+)/i.exec(u || ""); if (m) return decodeURIComponent(m[1]); } return ""; };
const keysOf = (x) => (x && !Array.isArray(x) ? Object.keys(x) : []);

function fromLaReferencia(r) {
  const people = [...keysOf((r.authors || {}).primary), ...keysOf((r.authors || {}).secondary)];
  const urls = (r.urls || []).map((u) => u.url).filter(Boolean);
  const country = /^([A-Z]{2})_/.exec(r.id || "");
  const summary = ((r.summary || [])[0] || "").replace(/\s+/g, " ").trim();
  const doi = doiIn(urls);
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : `lr:${r.id}`, source: "LA Referencia", kind: kindOf((r.formats || [])[0] || ""),
    year: parseInt((r.publicationDates || [])[0], 10) || 0, date: String((r.publicationDates || [])[0] || ""), title: r.title || "(untitled)",
    authors: authorList(people), people, venue: country ? `LA Referencia, ${regionName(country[1])}` : "LA Referencia", doi,
    url: urls.find((u) => !/doi\.org/.test(u)) || urls[0] || "", pdf: "", lang: ISO3[(r.languages || [])[0]] || String((r.languages || [])[0] || "").slice(0, 2),
    keywords: [...new Set((r.subjects || []).flat().filter((x) => x && !/^https?:/.test(x)))].slice(0, 8), abstract: snippet(summary, 400), full: summary, open: true, cited: 0,
  };
}

function fromDoaj(r) {
  const b = r.bibjson || {}, j = b.journal || {};
  const doi = ((b.identifier || []).find((x) => /^doi$/i.test(x.type)) || {}).id || "";
  const people = (b.author || []).map((a) => a.name).filter(Boolean);
  const abstract = String(b.abstract || "").replace(/\s+/g, " ").trim();
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : `doaj:${r.id}`, source: "DOAJ", kind: "a", year: parseInt(b.year, 10) || 0,
    date: [b.year, b.month && String(b.month).padStart(2, "0")].filter(Boolean).join("-"), title: b.title || "(untitled)",
    authors: authorList(people), people, venue: [j.title, j.country ? regionName(j.country) : ""].filter(Boolean).join(", "), doi,
    url: doi ? "" : (((b.link || []).find((l) => l.type === "fulltext") || {}).url || ""), pdf: "",
    lang: String((j.language || [])[0] || "").slice(0, 2).toLowerCase(), keywords: (b.keywords || []).slice(0, 8),
    abstract: snippet(abstract, 400), full: abstract, open: true, cited: 0, doaj: true, issn: (j.issns || [])[0] || "",
    volume: j.volume || "", issue: j.number || "", fpage: b.start_page || "", lpage: b.end_page || "", publisher: j.publisher || "",
  };
}

function fromCinii(it) {
  const ids = [].concat(it["dc:identifier"] || []);
  const doi = (ids.find((x) => /doi/i.test(x["@type"] || "")) || {})["@value"] || "";
  const people = [].concat(it["dc:creator"] || []).map((x) => (typeof x === "string" ? x : x["@value"] || "")).filter(Boolean);
  const desc = String([].concat(it.description || it["dc:description"] || [])[0] || "").replace(/\s+/g, " ").trim();
  const date = String(it["prism:publicationDate"] || "");
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : `cinii:${((it.link || {})["@id"] || "").split("/").pop()}`, source: "CiNii Research",
    kind: kindOf(it["dc:type"] || "article"), year: parseInt(date, 10) || 0, date, title: it.title || "(untitled)", authors: authorList(people), people,
    venue: it["prism:publicationName"] || it["dc:publisher"] || "", doi, url: doi ? "" : (it.link || {})["@id"] || "", pdf: "", lang: "ja",
    keywords: [], abstract: snippet(desc, 400), full: desc, open: false, cited: 0,
    volume: String(it["prism:volume"] || "").replace(/^Vol\.?\s*/i, ""), issue: String(it["prism:number"] || ""), fpage: it["prism:startingPage"] || "", lpage: it["prism:endingPage"] || "",
  };
}

const doajNext = { at: 0 };
const REGIONAL = {
  "LA Referencia": {
    langs: ["es", "pt"], len: 1400,
    async search(q, f, sort, page, size) {
      const p = new URLSearchParams({ lookfor: q, type: "AllFields", limit: String(Math.min(size, 100)), page: String(page) });
      for (const x of ["id", "title", "authors", "publicationDates", "summary", "urls", "languages", "formats", "subjects"]) p.append("field[]", x);
      if (f.from || f.to) p.append("filter[]", `publishDate:"[${f.from || 1000} TO ${f.to || 2999}]"`);
      if (sort === "new") p.set("sort", "year");
      const j = await getJSON(`https://buscador.lareferencia.info/api/v1/search?${p}`, { timeout: 30000 });
      return { total: j.resultCount || 0, items: (j.records || []).map(fromLaReferencia) };
    },
  },
  DOAJ: {
    langs: null, len: 900, encoded: 1600,            // much longer addresses get an error from DOAJ's server
    async search(q, f, sort, page, size) {
      // two requests a second at most
      const at = Math.max(Date.now(), doajNext.at);
      doajNext.at = at + 600;
      await new Promise((r) => setTimeout(r, at - Date.now()));
      const query = `(${q})${yearsLucene(f, "bibjson.year")}`;
      const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?page=${page}&pageSize=${Math.min(size, 100)}`;
      let j;
      try {
        j = await getJSON(url, { timeout: 45000 });
      } catch (e) {
        // DOAJ's server sometimes fails a request it answers a moment later
        if (e.status && e.status < 500) throw e;
        await new Promise((r) => setTimeout(r, 2500));
        j = await getJSON(url, { timeout: 45000 });
      }
      return { total: j.total || 0, items: (j.results || []).map(fromDoaj) };
    },
  },
  "CiNii Research": {
    langs: ["ja"], len: 900, encoded: 2000, needs: () => local.get("ciniiAppId", ""),
    async search(q, f, sort, page, size) {
      const n = Math.min(size, 200);
      const p = new URLSearchParams({ q, count: String(n), start: String((page - 1) * n + 1), format: "json", appid: local.get("ciniiAppId", "") });
      if (f.from) p.set("from", String(f.from));
      if (f.to) p.set("until", String(f.to));
      if (sort === "new") p.set("sortorder", "0");
      const j = await getJSON(`https://cir.nii.ac.jp/opensearch/articles?${p}`, { timeout: 30000 });
      return { total: Number(j["opensearch:totalResults"]) || 0, items: (j.items || []).map(fromCinii) };
    },
  },
};
export const REGIONAL_NAMES = Object.keys(REGIONAL);
/* The terms each database gets: your words, the English terms and the translations into its languages (DOAJ, which
   publishes in every language, all of them). */
export function regionalQueries(n, groups, mode) {
  const db = REGIONAL[n];
  const use = groups.map((g) => g.filter((t) => !isTranslation(t) || !db.langs || db.langs.includes(t.lang))).filter((g) => g.length);
  // a query in many scripts is much longer once it is put into an address: shortened until it fits
  for (let len = db.len; ; len = Math.floor(len * 0.85)) {
    const bq = booleanParts(use, mode, len, 1);
    if (!db.encoded || !bq.parts.length || encodeURIComponent(`(${bq.parts[0]})`).length <= db.encoded || len < 200) return bq;
  }
}

export const regional = {
  id: "regional",
  name: "Regional databases",
  note: "LA Referencia (Latin American repositories), DOAJ (open-access journals) and CiNii Research (Japan)",
  tab: "LA Referencia · DOAJ · CiNii", noun: ["record", "records"], repoNames: REGIONAL_NAMES,
  sorts: [["rel", "Best match"], ["new", "Newest first"]],
  filters: ["years", "repos"],
  /* size: results asked of each database */
  async search({ groups, mode, filters, sort }, page, size = 10) {
    const chosen = REGIONAL_NAMES.filter((n) => !filters.repos.length || filters.repos.includes(n));
    const notes = [];
    const names = chosen.filter((n) => !REGIONAL[n].needs || REGIONAL[n].needs());
    if (names.length < chosen.length && page === 1) notes.push("CiNii Research was not searched: it asks for a free application ID of your own (Settings).");
    let dropped = 0;
    const settled = await Promise.allSettled(names.map(async (n) => {
      const bq = regionalQueries(n, groups, mode);
      dropped += bq.dropped;
      return bq.parts.length ? REGIONAL[n].search(bq.parts[0], filters, sort, page, size) : { total: 0, items: [] };
    }));
    const lists = [], totals = {};
    settled.forEach((x, i) => {
      if (x.status === "fulfilled") { lists.push(x.value.items); totals[names[i]] = x.value.total; } else notes.push(friendly(x.reason, names[i]));
    });
    const seen = new Set();
    let items = interleave(lists).filter((r) => firstOf(r, seen));
    if (sort === "new") items = items.sort((a, b) => (b.date || String(b.year)).localeCompare(a.date || String(a.year)));
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    return { total, items, more: Object.values(totals).some((t) => t > page * size), notes, totals, dropped };
  },
  /* For saving: every record, 100 from each database a page, each once. */
  async *all(q, notes = [], { info = null } = {}) {
    const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const res = await regional.search(q, page, 100);
      notes.push(...(res.notes || []));
      if (info && page === 1) { info.total = res.total; info.totals = res.totals; }
      yield res.items.filter((r) => firstOf(r, seen));
      if (!res.more || !res.items.length) return;
    }
  },
};

export const SOURCES = { studies, data: datasets, trials, regional };

/* ------------------------------------------------------------------ files to save */
/* Open PDFs that Semantic Scholar knows for these DOIs (one request for up to 500). Its open versions are often on
   arXiv or PubMed Central, which let browsers download them. No key: Semantic Scholar refuses keys sent from web
   pages, and answers anonymous requests from a shared allowance. */
export async function semanticScholarPdfs(dois) {
  const ids = [...new Set(dois.filter(Boolean))].slice(0, 500);
  if (!ids.length) return {};
  const r = await fetch("https://api.semanticscholar.org/graph/v1/paper/batch?fields=openAccessPdf,externalIds", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.map((d) => `DOI:${d}`) }),
  });
  if (!r.ok) return {};
  const rows = await r.json();
  const out = {};
  rows.forEach((row, i) => {
    const pdf = row && row.openAccessPdf && row.openAccessPdf.url;
    const arxiv = row && row.externalIds && row.externalIds.ArXiv;
    const urls = [pdf, arxiv ? `https://arxiv.org/pdf/${arxiv}` : ""].filter((u) => u && /^https?:/.test(u));
    if (urls.length) out[ids[i].toLowerCase()] = urls;
  });
  return out;
}

/* Links that lead to a file the browser may download: a Zenodo record page becomes its PDFs (through Zenodo's API),
   an arXiv abstract page its PDF, an OSF preprint link (PsyArXiv, SocArXiv...) OSF's download address. */
const OSF_PREPRINT = /^https?:\/\/(?:www\.)?(?:osf\.io(?:\/preprints\/[a-z]+)?|psyarxiv\.com|socarxiv\.org|edarxiv\.org|engrxiv\.org|mindrxiv\.org|metaarxiv\.org|sportrxiv\.org|ecoevorxiv\.org|eartharxiv\.org|paleorxiv\.org)\/([a-z0-9]{5}(?:_v\d+)?)\/download\/?$/i;
export async function pdfLinks(urls) {
  const out = [];
  for (const u of urls) {
    const osf = OSF_PREPRINT.exec(u);
    if (osf) out.push(`https://osf.io/download/${osf[1].toLowerCase()}/`);
    const zen = /^https?:\/\/(?:www\.)?zenodo\.org\/records?\/(\d+)(?:\/files\/([^?#]+))?/i.exec(u);
    const arxiv = /^https?:\/\/arxiv\.org\/abs\/([^?#]+)/i.exec(u);
    if (arxiv) out.push(`https://arxiv.org/pdf/${arxiv[1]}`);
    else if (zen && zen[2]) out.push(`https://zenodo.org/api/records/${zen[1]}/files/${zen[2]}/content`);
    else if (zen) {
      try {
        const rec = await getJSON(`https://zenodo.org/api/records/${zen[1]}`, { timeout: 15000 });
        for (const f of rec.files || []) if (/\.pdf$/i.test(f.key || "") && (f.links || {}).self) out.push(f.links.self);
      } catch { /* the page itself is tried */ }
    }
    out.push(u);
  }
  return [...new Set(out)];
}

function figshareId(r) {
  const m = /^10\.6084\/m9\.figshare\.(\d+)/i.exec(r.doi || "")
    || /figshare\.com\/articles\/.+\/(\d{6,})(?:\/\d{1,3})?\/?(?:[?#].*)?$/i.exec(r.landing || r.url || "");
  return m ? m[1] : "";
}

/* ------------------------------------------------------------------ the file relay */
/* OSF, figshare and many publishers do not let web pages download their files. A file relay (docs/relay/worker.js, a
   small Cloudflare Worker on the visitor's own free account, or one they were given) fetches them instead: OSF and
   figshare files, and (version 2 on, `pdf: true`) open-access PDFs from other sites. Each visitor decides whether to
   connect one, under Settings; its address is kept in their browser. */
export const relayAddress = () => String(local.get("relay", "") || "").trim().replace(/\/+$/, "");
export const needsRelay = (url) => /^https:\/\/((www\.)?osf\.io\/(download\/[a-z0-9]{5,}(_v\d+)?|[a-z0-9]{5,}(_v\d+)?\/download)\/?$|files(\.[a-z0-9-]+)?\.osf\.io\/v1\/resources\/|ndownloader\.figshare\.com\/files\/\d|figshare\.com\/ndownloader\/files\/\d)/i.test(url || "");
export const relayed = (url) => `${relayAddress()}/?url=${encodeURIComponent(url)}`;

/* Whether an address answers as a Research Finder file relay: { ok, hosts, pdf } (pdf: it also fetches publishers'
   PDFs) or { ok: false, why }. */
export async function checkRelay(address) {
  try {
    const j = await getJSON(`${String(address).trim().replace(/\/+$/, "")}/`, { timeout: 15000, cacheable: false });
    return j && j.service === "research-finder-relay" ? { ok: true, hosts: j.hosts || [], pdf: j.pdf === true }
      : { ok: false, why: "it answers, but it is not a Research Finder relay" };
  } catch (e) {
    return { ok: false, why: e.status === 403 ? "it does not serve this site: this address must be in the relay's list of sites (ORIGINS)" : e.message };
  }
}

/* The open data files of a dataset: [{ name, size, url, relay }]. Zenodo lists them with the record; Harvard Dataverse,
   OSF and figshare are asked per dataset; a Zenodo, OSF or figshare DOI found through DataCite or OpenAIRE is looked up
   there. OSF and figshare files can be downloaded only through a file relay (relay: true); without one they are listed
   with their links. Restricted files are left out. */
export async function datasetFiles(r) {
  if (r.files && r.files.length) return r.files;
  const zen = /^10\.5281\/zenodo\.(\d+)$/i.exec(r.doi || "");
  if (zen) {
    const rec = await getJSON(`https://zenodo.org/api/records/${zen[1]}`, { timeout: 20000 });
    if ((rec.metadata || {}).access_right !== "open") return [];
    return (rec.files || []).map((f) => ({ name: f.key, size: f.size, url: (f.links || {}).self || "" })).filter((f) => f.url);
  }
  const pid = r.pid || (/^10\.7910\//.test(r.doi || "") ? `doi:${r.doi}` : "");
  if (pid) {
    const j = await getJSON(`https://dataverse.harvard.edu/api/datasets/:persistentId/?persistentId=${encodeURIComponent(pid)}`, { timeout: 20000 });
    const files = (((j.data || {}).latestVersion || {}).files || []).filter((f) => !f.restricted && f.dataFile);
    return files.map((f) => ({
      name: f.dataFile.originalFileName || f.dataFile.filename || f.label, size: f.dataFile.originalFileSize || f.dataFile.filesize || 0,
      url: `https://dataverse.harvard.edu/api/access/datafile/${f.dataFile.id}${f.dataFile.originalFileFormat ? "?format=original" : ""}`,
    }));
  }
  const osfDoi = /^10\.17605\/osf\.io\/([a-z0-9]{5})$/i.exec(r.doi || "");
  const osf = r.osf || (osfDoi ? `https://osf.io/${osfDoi[1].toLowerCase()}` : "");
  if (osf) {
    const p = new URLSearchParams({ "cardSearchFilter[isContainedBy]": osf, "cardSearchFilter[resourceType]": "File", "page[size]": "100",
      acceptMediatype: "application/vnd.api+json" });
    const { cards } = await trovePage(p, 1);
    return cards.map((m) => {
      const version = (m["osf:hasFileVersion"] || [])[0] || {};
      const guid = (m["@id"] || "").replace(/\/$/, "").split("/").pop();
      return { name: val(m.fileName) || guid, size: Math.round((parseFloat(val(version["dcterms:extent"])) || 0) * 1e6),
        url: `https://osf.io/download/${guid}/`, page: m["@id"], relay: true };
    });
  }
  const figFiles = async (id) => {
    const files = await getJSON(`https://api.figshare.com/v2/articles/${id}/files`, { timeout: 20000 });
    return (Array.isArray(files) ? files : []).filter((f) => !f.is_link_only && f.download_url)
      .map((f) => ({ name: f.name, size: f.size || 0, url: f.download_url, relay: true }));
  };
  const collection = /^10\.6084\/m9\.figshare\.c\.(\d+)/i.exec(r.doi || "");
  if (collection) {             // a figshare collection: the files of its items (the first 30)
    const items = await getJSON(`https://api.figshare.com/v2/collections/${collection[1]}/articles?page_size=30`, { timeout: 20000 });
    const out = [];
    for (const a of Array.isArray(items) ? items : []) out.push(...(await figFiles(a.id)));
    return out;
  }
  const fig = figshareId(r);
  return fig ? figFiles(fig) : [];
}
