/* Where Research Finder searches: OpenAlex for studies of every field, and DataCite, Zenodo and Harvard Dataverse
   for datasets. Every search returns records of one shape:
   { key, source, kind, year, title, authors, venue, doi, url, pdf, lang, keywords, abstract, open, cited,
     files (Zenodo: open data files), pid (Dataverse: the dataset's persistent id) } */
import { getJSON, local, norm, openalexJSON, snippet, stripHtml } from "./util.js";
import { LANG_PRIORITY, mainWords } from "./terms.js";

export const KIND_NAMES = { a: "Article", p: "Preprint", v: "Review", b: "Book or chapter", d: "Dataset", t: "Thesis", o: "Other" };
const SRC_RANK = { you: 0, alias: 1, studies: 2, wikidata: 3 };

/* The terms as one Boolean query: OR within a keyword, AND (or OR) between keywords. Long queries are shortened,
   keeping your words and the English synonyms, then translations into the languages with the most research. */
export function booleanQuery(groups, mode, maxLen = 3000) {
  const quote = (t) => (t.loose
    ? `(${mainWords(t.text).join(" AND ")})`
    : `"${t.text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`);
  const budget = Math.max(60, Math.floor(maxLen / Math.max(1, groups.length)) - 6);
  const rank = (t) => SRC_RANK[t.src] + (t.lang ? (LANG_PRIORITY.indexOf(t.lang) + 1) / 100 : 0);
  let dropped = 0;
  const parts = groups.map((terms) => {
    const keep = [], kept = [];
    let len = 0;
    for (const t of [...terms].sort((a, b) => rank(a) - rank(b))) {
      const n = ` ${norm(t.text)} `;
      if (kept.some((k) => n.includes(k))) continue;      // "COVID-19 vaccine hesitancy" adds nothing to an OR
      const q = quote(t);
      if (len + q.length + 4 > budget && keep.length) { dropped++; continue; }
      keep.push(q);
      kept.push(n);
      len += q.length + 4;
    }
    return keep.length > 1 ? `(${keep.join(" OR ")})` : keep[0] || "";
  }).filter(Boolean);
  return { query: parts.join(mode === "all" ? " AND " : " OR "), dropped };
}

function openalexParams() {
  const p = new URLSearchParams();
  const key = local.get("openalexKey", ""), mail = local.get("email", "");
  if (key) p.set("api_key", key);
  if (mail) p.set("mailto", mail);
  return p;
}

function friendly(e, who) {
  if (e.status === 400 && /too long/i.test(e.detail || "")) return `${who}: the search is too long; choose fewer languages under Settings.`;
  if (e.status === 429 || (e.status === 403 && who === "OpenAlex")) {
    return `${who} is limiting free searches right now. Add a free OpenAlex key under Settings, or try again in a minute.`;
  }
  return `${who}: ${e.message}`;
}

const authorList = (names) => names.slice(0, 4).join("; ") + (names.length > 4 ? " et al." : "");

/* ------------------------------------------------------------------ OpenAlex: studies */
const OA_TYPES = { article: "a", preprint: "p", review: "v", book: "b", "book-chapter": "b", monograph: "b", dataset: "d",
  dissertation: "t", editorial: "a", letter: "a" };
const OA_FILTER_TYPES = { a: "article", p: "preprint", v: "review", b: "book|book-chapter", d: "dataset", t: "dissertation" };
const OA_FIELDS = "id,doi,display_name,publication_year,type,language,primary_location,best_oa_location,open_access,authorships,keywords,abstract_inverted_index,cited_by_count";

function abstractOf(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) if (p < 120) words[p] = w;
  return snippet(words.filter(Boolean).join(" "), 400);
}

function fromOpenAlex(w) {
  const loc = w.primary_location || {}, src = loc.source || {}, oa = w.best_oa_location || {};
  return {
    key: w.doi ? `doi:${w.doi.replace(/^https?:\/\/doi\.org\//, "").toLowerCase()}` : w.id, source: "OpenAlex",
    kind: OA_TYPES[w.type] || "o", year: w.publication_year || 0, title: w.display_name || "(untitled)",
    authors: authorList((w.authorships || []).map((a) => (a.author || {}).display_name).filter(Boolean)),
    venue: src.display_name || "", doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//, ""),
    url: w.doi ? "" : loc.landing_page_url || w.id, pdf: oa.pdf_url || "", lang: w.language || "",
    keywords: (w.keywords || []).map((k) => k.display_name).slice(0, 8), abstract: abstractOf(w.abstract_inverted_index),
    open: !!(w.open_access || {}).is_oa, cited: w.cited_by_count || 0,
  };
}

function openalexQuery({ groups, mode, filters, sort }) {
  const { query, dropped } = booleanQuery(groups, mode, 1450);       // OpenAlex takes up to 1,500 characters
  const p = openalexParams();
  if (query) p.set("search", query);
  const f = [];
  if (filters.kinds.length) f.push(`type:${filters.kinds.map((k) => OA_FILTER_TYPES[k]).filter(Boolean).join("|")}`);
  if (filters.from || filters.to) f.push(`publication_year:${filters.from || ""}-${filters.to || ""}`);
  if (filters.open) f.push("open_access.is_oa:true");
  if (filters.langs.length) f.push(`language:${filters.langs.join("|")}`);
  if (f.length) p.set("filter", f.join(","));
  if (sort === "new") p.set("sort", "publication_date:desc");
  else if (sort === "cited") p.set("sort", "cited_by_count:desc");
  p.set("select", OA_FIELDS);
  return { p, dropped };
}

export const studies = {
  id: "studies",
  name: "Studies",
  note: "OpenAlex: 270 million works from every field",
  sorts: [["rel", "Best match"], ["new", "Newest first"], ["cited", "Most cited"]],
  filters: ["kinds", "years", "open", "langs"],
  kinds: ["a", "p", "v", "b", "d", "t"],
  async search(q, page, size = 25) {
    const { p, dropped } = openalexQuery(q);
    p.set("per-page", String(size));
    p.set("page", String(page));
    try {
      const j = await openalexJSON(`https://api.openalex.org/works?${p}`, { timeout: 30000 });
      return { total: j.meta.count, items: j.results.map(fromOpenAlex), more: page * size < Math.min(j.meta.count, 10000), dropped };
    } catch (e) {
      throw new Error(friendly(e, "OpenAlex"));
    }
  },
};

/* ------------------------------------------------------------------ data repositories */
function fromDataCite(d) {
  const a = d.attributes || {};
  const desc = (a.descriptions || []).find((x) => x.descriptionType === "Abstract") || (a.descriptions || [])[0] || {};
  return {
    key: `doi:${(a.doi || "").toLowerCase()}`, source: "DataCite", kind: "d", year: +a.publicationYear || 0,
    title: ((a.titles || [])[0] || {}).title || "(untitled)", authors: authorList((a.creators || []).map((c) => c.name).filter(Boolean)),
    venue: typeof a.publisher === "object" ? (a.publisher || {}).name || "" : a.publisher || "", doi: a.doi || "", url: "", pdf: "",
    lang: (a.language || "").slice(0, 2), keywords: (a.subjects || []).map((s) => s.subject).filter(Boolean).slice(0, 8),
    abstract: snippet(stripHtml(desc.description || ""), 400), open: true, cited: a.citationCount || 0,
    size: (a.sizes || []).join(", "), license: ((a.rightsList || [])[0] || {}).rights || "",
  };
}

function fromZenodo(r) {
  const m = r.metadata || {};
  const open = m.access_right === "open";
  return {
    key: `doi:${(r.doi || m.doi || `zenodo:${r.id}`).toLowerCase()}`, source: "Zenodo", kind: "d", year: +(m.publication_date || "").slice(0, 4) || 0,
    title: m.title || "(untitled)", authors: authorList((m.creators || []).map((c) => c.name).filter(Boolean)), venue: "Zenodo",
    doi: r.doi || m.doi || "", url: r.doi ? "" : (r.links || {}).self_html || "", pdf: "", lang: (m.language || "").slice(0, 2),
    keywords: (m.keywords || []).slice(0, 8), abstract: snippet(stripHtml(m.description || ""), 400), open, cited: 0,
    license: ((m.license || {}).id || ""),
    files: open ? (r.files || []).map((f) => ({ name: f.key, size: f.size, url: (f.links || {}).self || "" })).filter((f) => f.url) : [],
  };
}

function fromDataverse(it) {
  const doi = (it.global_id || "").startsWith("doi:") ? it.global_id.slice(4) : "";
  return {
    key: doi ? `doi:${doi.toLowerCase()}` : it.url, source: "Harvard Dataverse", kind: "d", year: +(it.published_at || "").slice(0, 4) || 0,
    title: it.name || "(untitled)", authors: authorList(it.authors || []), venue: it.name_of_dataverse || "Harvard Dataverse",
    doi, url: doi ? "" : it.url || "", pdf: "", lang: "", keywords: [...(it.keywords || []), ...(it.subjects || [])].slice(0, 8),
    abstract: snippet(stripHtml(it.description || ""), 400), open: true, cited: 0, pid: it.global_id || "",
  };
}

/* How long a query each repository takes: Zenodo and Dataverse fail on long Boolean queries. */
const REPO_LEN = { DataCite: 1500, Zenodo: 600, "Harvard Dataverse": 600 };
const yearsLucene = (f, field) => (f.from || f.to ? ` AND ${field}:[${f.from || 1000} TO ${f.to || 2999}]` : "");
const REPOS = {
  DataCite: async (q, f, sort, page, size) => {
    const p = new URLSearchParams({ query: q + yearsLucene(f, "publicationYear"), "resource-type-id": "dataset", "page[size]": String(size), "page[number]": String(page) });
    if (sort === "new") p.set("sort", "-published");
    const j = await getJSON(`https://api.datacite.org/dois?${p}`, { timeout: 25000 });
    return { total: (j.meta || {}).total || 0, items: (j.data || []).map(fromDataCite) };
  },
  Zenodo: async (q, f, sort, page, size) => {
    const p = new URLSearchParams({ q: q + (f.from || f.to ? ` AND publication_date:[${f.from || 1000}-01-01 TO ${f.to || 2999}-12-31]` : ""), type: "dataset", size: String(Math.min(size, 25)), page: String(page) });
    p.set("sort", sort === "new" ? "newest" : "bestmatch");
    const j = await getJSON(`https://zenodo.org/api/records?${p}`, { timeout: 25000 });
    return { total: (j.hits || {}).total || 0, items: ((j.hits || {}).hits || []).map(fromZenodo) };
  },
  "Harvard Dataverse": async (q, f, sort, page, size) => {
    const p = new URLSearchParams({ q, type: "dataset", per_page: String(size), start: String((page - 1) * size) });
    if (f.from || f.to) p.set("fq", `dateSort:[${f.from || 1000}-01-01T00:00:00Z TO ${f.to || 2999}-12-31T23:59:59Z]`);
    if (sort === "new") { p.set("sort", "date"); p.set("order", "desc"); }
    const j = await getJSON(`https://dataverse.harvard.edu/api/search?${p}`, { timeout: 25000 });
    return { total: (j.data || {}).total_count || 0, items: ((j.data || {}).items || []).map(fromDataverse) };
  },
};
export const REPO_NAMES = Object.keys(REPOS);

export const datasets = {
  id: "data",
  name: "Datasets",
  note: "DataCite, Zenodo and Harvard Dataverse",
  sorts: [["rel", "Best match"], ["new", "Newest first"]],
  filters: ["years", "repos"],
  async search({ groups, mode, filters, sort }, page, size = 10) {
    const names = REPO_NAMES.filter((n) => !filters.repos.length || filters.repos.includes(n));
    let dropped = 0;
    const settled = await Promise.allSettled(names.map((n) => {
      const bq = booleanQuery(groups, mode, REPO_LEN[n]);
      if (n === "DataCite") dropped = bq.dropped;
      return REPOS[n](bq.query, filters, sort, page, size);
    }));
    const lists = [], notes = [], totals = {};
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") { lists.push(s.value.items); totals[names[i]] = s.value.total; }
      else notes.push(friendly(s.reason, names[i]));
    });
    // one entry per dataset: versions have their own DOIs, and a dataset can be in several repositories
    const seen = new Set(), items = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const r = l[i];
        if (!r) continue;
        const same = `${norm(r.title)}|${r.year}`;
        if (seen.has(r.key) || seen.has(same)) continue;
        seen.add(r.key);
        seen.add(same);
        items.push(r);
      }
    }
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    return { total, items, more: Object.values(totals).some((t) => t > page * size), notes, totals, dropped };
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

/* The open data files of a dataset: Zenodo lists them with the record; Harvard Dataverse is asked per dataset;
   a Zenodo DOI found through DataCite is looked up at Zenodo. Restricted files are left out. */
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
  return [];
}
