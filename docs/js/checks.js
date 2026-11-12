/* Checks on studies: their study designs (OpenAlex's automatic tags), retractions and corrections (Crossref, which
   carries the Retraction Watch database, and OpenAlex's own flag), replication attempts (the FORRT Replication
   Database, FReD) and their journals (DOAJ, and Retraction Watch's list of hijacked journals). */
import { getJSON, local, plural, parseCsv } from "./util.js?v=40";

const pause = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ------------------------------------------------------------------ study designs */
/* OpenAlex tags seven designs, taken from PubMed's study types, from a study's title, venue and abstract. */
export const DESIGN_NAMES = {
  "randomized-controlled-trial": "Randomized controlled trial", "clinical-trial": "Clinical trial",
  "observational-study": "Observational study", "systematic-review": "Systematic review", "meta-analysis": "Meta-analysis",
  "study-protocol": "Study protocol", "case-report": "Case report",
};
/* A design comes with its parent (every randomized trial is a clinical trial, every meta-analysis a systematic
   review), which adds nothing next to it. */
const PARENT = { "randomized-controlled-trial": "clinical-trial", "meta-analysis": "systematic-review" };
export function designsOf(r) {
  const ds = r.designs || [];
  return ds.filter((d) => DESIGN_NAMES[d] && !ds.some((x) => PARENT[x] === d));
}
export const designText = (r) => designsOf(r).map((d) => DESIGN_NAMES[d]).join("; ");

/* ------------------------------------------------------------------ retractions and corrections */
export const checksOn = () => local.get("updates", true) !== false;

/* Crossref's kinds of update notice that matter for using a study, the most serious first. */
const KINDS = {
  retraction: "Retracted", partial_retraction: "Partly retracted", withdrawal: "Withdrawn", removal: "Removed",
  expression_of_concern: "Expression of concern", correction: "Corrected", corrigendum: "Corrected", erratum: "Corrected",
};
const ORDER = Object.keys(KINDS);
export const SERIOUS = ["retraction", "partial_retraction", "withdrawal", "removal"];
const SOURCE_NAMES = { "retraction-watch": "Retraction Watch", publisher: "publisher" };

const updates = new Map();       // DOI (lower case) -> its notices, [] when Crossref has none
const asking = new Map();        // DOI -> the request on its way
let queue = Promise.resolve(), nextAt = 0;

/* One request at a time, about one a second, as Crossref's public API asks. */
function crossref(url) {
  const run = queue.then(async () => {
    await pause(nextAt - Date.now());
    try { return await getJSON(url, { timeout: 30000, cacheable: false }); } finally { nextAt = Date.now() + 1000; }
  });
  queue = run.catch(() => {});
  return run;
}

/* A work's notices, one per kind (Retraction Watch and the publisher often report the same retraction), dated by the
   notice itself where there is one (a publisher may also mark the work, with another date). */
function notices(item) {
  const own = String(item.DOI || "").toLowerCase();
  const byLabel = new Map();
  for (const u of item["updated-by"] || []) {
    if (!KINDS[u.type]) continue;
    const label = KINDS[u.type];
    const n = byLabel.get(label) || { kind: u.type, label, notice: "", noticeDate: "", otherDate: "", sources: [] };
    const date = ((u.updated || {})["date-time"] || "").slice(0, 10);
    const notice = String(u.DOI || "").toLowerCase();
    if (notice && notice !== own) {
      if (!n.notice) n.notice = notice;
      if (date && (!n.noticeDate || date < n.noticeDate)) n.noticeDate = date;
    } else if (date && (!n.otherDate || date < n.otherDate)) n.otherDate = date;
    const source = SOURCE_NAMES[u.source] || u.source || "Crossref";
    if (!n.sources.includes(source)) n.sources.push(source);
    byLabel.set(label, n);
  }
  return [...byLabel.values()].map(({ noticeDate, otherDate, ...n }) => ({ ...n, date: noticeDate || otherDate }))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/* Asks Crossref about the DOIs it has not been asked about, up to 100 a request; resolves when every one of them has
   an answer (or Crossref did not answer). `onProgress(done, of)` follows the DOIs this call asks about. */
export async function checkUpdates(dois, onProgress) {
  const all = [...new Set(dois.map((d) => String(d || "").toLowerCase()).filter((d) => d.startsWith("10.") && !d.includes(",")))];
  const todo = all.filter((d) => !updates.has(d) && !asking.has(d));
  let done = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    const p = new URLSearchParams({ filter: batch.map((d) => `doi:${d}`).join(","), select: "DOI,updated-by", rows: String(batch.length) });
    const ask = crossref(`https://api.crossref.org/works?${p}`).then((j) => {
      batch.forEach((d) => updates.set(d, []));
      for (const it of (j.message || {}).items || []) updates.set(String(it.DOI).toLowerCase(), notices(it));
    }, () => { /* not answered: the studies stay unchecked */ }).finally(() => {
      batch.forEach((d) => asking.delete(d));
      done += batch.length;
      if (onProgress) onProgress(done, todo.length);
    });
    batch.forEach((d) => asking.set(d, ask));
  }
  await Promise.all([...new Set(all.map((d) => asking.get(d)).filter(Boolean))]);
}

/* What is known about a study's retraction and corrections: Crossref's notices, and OpenAlex's retraction flag when
   Crossref has no serious notice (OpenAlex takes it from Retraction Watch too, but sometimes sets it for a correction,
   so Crossref's answer wins when it has notices). `checked`: whether Crossref answered about it. */
export function updatesOf(r) {
  const doi = (r.doi || "").toLowerCase();
  const known = doi && checksOn() ? updates.get(doi) : undefined;
  const list = known ? [...known] : [];
  if (r.retracted && !list.length) {
    list.push({ kind: "retraction", label: "Retracted", date: "", notice: "", sources: ["OpenAlex"] });
  }
  return { checked: known !== undefined, list };
}

export const updatesText = (r) => updatesOf(r).list
  .map((n) => `${n.label}${n.date ? ` ${n.date}` : ""} (${n.sources.join(", ")})${n.notice ? `: https://doi.org/${n.notice}` : ""}`).join("; ");

/* ------------------------------------------------------------------ replications */
let replications = null, loading = null;

/* The replication attempts FReD records (a file this site keeps, built by tools/replications.py), loaded once. */
export function loadReplications() {
  if (!loading) {
    loading = getJSON(new URL("../data/replications.json?v=40", import.meta.url).href, { timeout: 30000 })
      .then((j) => { replications = j; return j; }, () => { loading = null; return null; });
  }
  return loading;
}
export const replicationsDate = () => (replications && replications.generated) || "";

const OUTCOMES = { s: "successful", f: "failed", m: "mixed", r: "reproduction", o: "other result" };
/* The replications and reproductions of a study: [{ link, year, code, title, outcome }], or null. */
export function replicationsOf(r) {
  if (!replications || !r.doi) return null;
  const list = replications.studies[r.doi.toLowerCase()];
  return list ? list.map(([link, year, code, title, outcome]) => ({
    link: /^https?:/.test(link) ? link : `https://doi.org/${link}`, year, code, title, outcome: outcome || OUTCOMES[code],
  })) : null;
}

/* "2 replications (1 successful, 1 failed) and 1 reproduction" */
export function replicationText(list) {
  const reps = list.filter((x) => x.code !== "r"), reproductions = list.length - reps.length;
  const by = [["s", "successful"], ["f", "failed"], ["m", "mixed"], ["o", "other"]]
    .map(([c, l]) => [reps.filter((x) => x.code === c).length, l]).filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
  return [reps.length ? `${plural(reps.length, "replication")}${by.length ? ` (${by.join(", ")})` : ""}` : "",
    reproductions ? plural(reproductions, "reproduction") : ""].filter(Boolean).join(" and ");
}

export function replicationsCell(r) {
  const list = replicationsOf(r);
  return list ? `${replicationText(list)}: ${list.map((x) => `${x.year || "n.d."} ${x.outcome} ${x.link}`).join("; ")}` : "";
}

/* ------------------------------------------------------------------ journals: DOAJ, hijacked copies */
/* Retraction Watch's Hijacked Journal Checker lists confirmed fake copies of real journals with their web addresses (a
   Google Sheet, read as CSV and kept in this browser for a day). A study whose page or PDF is at such an address is
   flagged. The real journal's ISSN alone says nothing: the copies use it too. */
const HIJACKED_CSV = "https://docs.google.com/spreadsheets/d/1ak985WGOgGbJRJbZFanoktAN_UFeExpE/gviz/tq?tqx=out:csv";
let hijacked = null, hijackLoading = null, hijackedAt = 0;
const hostOf = (u) => {
  try { return new URL(/^https?:/i.test(u) ? u : `http://${u}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
};
export function loadHijacked() {
  if (!checksOn()) return Promise.resolve(null);
  if (!hijackLoading) {
    hijackLoading = (async () => {
      const kept = local.get("hijacked", null);
      let rows = kept && Date.now() - kept.at < 864e5 && Array.isArray(kept.rows) ? kept.rows : null;
      hijackedAt = rows ? kept.at : Date.now();
      if (!rows) {
        const r = await fetch(HIJACKED_CSV);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // columns: number, journal, address of the copy, its ISSN, the real journal, its ISSN, its address
        rows = parseCsv(await r.text()).filter((x) => /^\d+$/.test(String(x[0]).trim()) && x[2]).map((x) => [x[1], x[2], x[4], x[6]].map((v) => String(v || "").trim()));
        if (rows.length < 50) throw new Error("the list looks wrong");
        local.set("hijacked", { at: hijackedAt, rows });
      }
      hijacked = new Map();
      for (const [title, url, original, originalUrl] of rows) {
        for (const u of url.split(/[\s,;]+/)) {
          const host = hostOf(u);
          if (host && host.includes(".")) hijacked.set(host, { title, url: u, original: original || title, originalUrl: /^https?:/.test(originalUrl) ? originalUrl : "" });
        }
      }
      return hijacked;
    })().catch(() => { hijackLoading = null; return null; });
  }
  return hijackLoading;
}
export const hijackedDate = () => (hijackedAt ? new Date(hijackedAt).toISOString().slice(0, 10) : "");

/* The hijacked copy a study's page or PDF is on (its address, the real journal), or null. */
export function hijackOf(r) {
  if (!hijacked || !checksOn()) return null;
  for (const u of [r.site, r.pdf, r.url]) {
    let host = hostOf(u || "");
    while (host && host.split(".").length >= 2) {
      if (hijacked.has(host)) return { ...hijacked.get(host), host };
      host = host.split(".").slice(1).join(".");
    }
  }
  return null;
}

/* For the sheet and the RIS file. */
export function journalText(r) {
  const h = hijackOf(r);
  if (h) return `On ${h.host}, a hijacked copy of “${h.original}” (Retraction Watch Hijacked Journal Checker)${h.originalUrl ? `; the real journal: ${h.originalUrl}` : ""}`;
  return r.doaj ? "Journal in DOAJ" : "";
}
