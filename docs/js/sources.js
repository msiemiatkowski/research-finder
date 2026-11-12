/* Where Research Finder searches: OpenAlex for studies of every field; DataCite, Zenodo, Harvard Dataverse, OSF and
   OpenAIRE for datasets. Every search returns records of one shape:
   { key, source, kind, year, date, title, authors, venue, doi, url, pdf, lang, keywords, abstract, open, cited,
     files (Zenodo: open data files), pid (Dataverse: the dataset's persistent id), osf (OSF: the project's address),
     landing (the repository's page of the dataset) } */
import { getJSON, local, norm, openalexJSON, openalexRefusal, snippet, stripHtml } from "./util.js?v=35";
import { LANG_PRIORITY, isTranslation, mainWords } from "./terms.js?v=35";

export const KIND_NAMES = { a: "Article", p: "Preprint", v: "Review", b: "Book or chapter", d: "Dataset", t: "Thesis", o: "Other" };
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
const OA_FIELDS = "id,doi,display_name,publication_year,publication_date,type,language,primary_location,best_oa_location,open_access,authorships,keywords,abstract_inverted_index,cited_by_count,is_retracted,study_designs";

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
  };
}

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
  sorts: [["rel", "Best match"], ["new", "Newest first"], ["cited", "Most cited"]],
  filters: ["fulltext", "kinds", "designs", "years", "open", "langs"],
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
  async *all(q, notes = []) {
    const cursor = Boolean(local.get("openalexKey", ""));
    const parts = studies.queries(q).parts.map((search) => ({ search, next: cursor ? "*" : 1, done: false }));
    const seen = new Set();
    while (parts.some((s) => !s.done)) {
      const answers = await Promise.allSettled(parts.map(async (s, i) => {
        if (s.done) return [];
        const p = openalexQuery(q, s.search);
        p.set("per-page", "200");
        if (cursor) p.set("cursor", s.next); else p.set("page", String(s.next));
        const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 60000, cacheable: false });
        const items = (j.results || []).map(fromOpenAlex);
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
};

/* ------------------------------------------------------------------ data repositories */
const val = (x) => ((x || [])[0] || {})["@value"] || "";
const OPENAIRE_LANGS = { eng: "en", deu: "de", ger: "de", fra: "fr", fre: "fr", spa: "es", por: "pt", ita: "it", pol: "pl", nld: "nl", dut: "nl", rus: "ru", zho: "zh", chi: "zh", jpn: "ja" };

function fromDataCite(d) {
  const a = d.attributes || {};
  const desc = (a.descriptions || []).find((x) => x.descriptionType === "Abstract") || (a.descriptions || [])[0] || {};
  return {
    key: `doi:${(a.doi || "").toLowerCase()}`, source: "DataCite", kind: "d", year: +a.publicationYear || 0, date: String(a.publicationYear || ""),
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

/* How long a query each repository takes (Zenodo and Dataverse fail on long Boolean queries), its syntax, and how many
   queries one search makes (OpenAIRE takes five terms a query). */
const REPO_LEN = { DataCite: 1500, Zenodo: 600, "Harvard Dataverse": 600, OSF: 800, OpenAIRE: 1000 };
const REPO_SYNTAX = { OSF: TROVE, OpenAIRE: FEW, Zenodo: { ...LUCENE, terms: 24 }, "Harvard Dataverse": { ...LUCENE, terms: 24 } };
const REPO_PARTS = { OpenAIRE: 4 };
const REPOS = {
  DataCite: async ([q], f, sort, page, size) => {
    const p = new URLSearchParams({ query: q + yearsLucene(f, "publicationYear"), "resource-type-id": "dataset", "page[size]": String(Math.min(size, 1000)), "page[number]": String(page) });
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
  sorts: [["rel", "Best match"], ["new", "Newest first"]],
  filters: ["years", "repos"],
  /* size: results asked of each repository */
  async search({ groups, mode, filters, sort }, page, size = 8) {
    const names = REPO_NAMES.filter((n) => !filters.repos.length || filters.repos.includes(n));
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
  async *all(q, notes = []) {
    const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const res = await datasets.search(q, page, 200);
      notes.push(...(res.notes || []));
      yield res.items.filter((r) => firstOf(r, seen));
      if (!res.more || !res.items.length) return;
    }
  },
};

export const SOURCES = { studies, data: datasets };

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
