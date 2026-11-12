/* Review tools: your studies (the list the tools start from), checking a search against studies it should find
   (relative recall), citation searching from your studies, studies similar to yours, the works your results cite most,
   and the PRISMA 2020 flow diagram. Every OpenAlex request here is a list
   by identifier (1 credit) unless it says otherwise; a check of what the search finds costs a search (10 credits) per
   part of the query. */
import { $, h, fill, fmt, plural, norm, local, NO_SPACES } from "./util.js?v=43";
import { SOURCES, KIND_NAMES, worksByIds, citingWorks } from "./sources.js?v=43";
import { openCite } from "./cite.js?v=43";

const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
const today = () => new Date().toISOString().slice(0, 10);
const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/* ------------------------------------------------------------------ the studies you paste */
/* DOIs (bare, doi: or https://doi.org/...), PubMed IDs and OpenAlex IDs, one or more per line. */
export function parseIds(text) {
  const dois = new Set(), pmids = new Set(), ids = new Set(), bad = [];
  const tokens = String(text || "").split(/\s+/).flatMap((t) => t.split(/,(?=\s*(?:10\.|https?:|doi:|pmid:|W\d))/i));
  for (const raw of tokens) {
    const s = raw.trim().replace(/[.,;)\]>]+$/, "").replace(/^[<(\[]+/, "");
    if (!s || !/\d/.test(s)) continue;                       // "doi:", "PMID:" on their own
    let m;
    if ((m = /(10\.\d{4,9}\/[^\s"<>]+)/i.exec(s))) {
      let doi = m[1];
      try { doi = decodeURIComponent(doi); } catch { /* as it is */ }
      if (doi.includes("|")) bad.push(raw); else dois.add(doi.toLowerCase());
    } else if ((m = /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(W\d{3,12})$/i.exec(s))) ids.add(m[1].toUpperCase());
    else if ((m = /^(?:pmid:?)?(\d{1,9})$/i.exec(s)) || (m = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/i.exec(s))) pmids.add(m[1]);
    else bad.push(raw);
  }
  return { dois: [...dois], pmids: [...pmids], ids: [...ids], bad, count: dois.size + pmids.size + ids.size };
}

/* Your studies: the identifiers in the box of the review tools, which the results' "Add to your studies" adds to. */
const knownText = () => local.get("known", "");
export const mineCount = () => parseIds(knownText()).count;
const idsOf = (r) => [r.doi, r.oa, r.pmid].filter(Boolean).map((x) => x.toLowerCase());
export function isMine(r) {
  const p = parseIds(knownText());
  const have = new Set([...p.dois, ...p.ids.map((x) => x.toLowerCase()), ...p.pmids]);
  return idsOf(r).some((x) => have.has(x));
}
/* Adds the study (its DOI, or its OpenAlex ID) or takes it out; true when it is in. */
export function toggleMine(r) {
  const text = knownText();
  if (!isMine(r)) {
    local.set("known", [text.trim(), r.doi || r.oa].filter(Boolean).join("\n"));
    return true;
  }
  const drop = new Set(idsOf(r));
  const keepToken = (tok) => {
    const p = parseIds(tok);
    const id = p.dois[0] || (p.ids[0] || "").toLowerCase() || p.pmids[0] || "";
    return !id || !drop.has(id);
  };
  local.set("known", text.split("\n").map((line) => line.split(/\s+/).filter(keepToken).join(" ")).filter((l) => l.trim()).join("\n"));
  return false;
}

/* The works for the identifiers pasted, each once, and the identifiers OpenAlex does not have. */
async function resolve(text) {
  const ids = parseIds(text);
  const works = [], seen = new Set();
  for (const w of await worksByIds(ids)) if (!seen.has(w.oa)) { seen.add(w.oa); works.push(w); }
  const known = new Set(works.flatMap((w) => [w.doi.toLowerCase(), w.pmid, w.oa]));
  const missing = [...ids.dois.filter((d) => !known.has(d)), ...ids.pmids.filter((p) => !known.has(p)).map((p) => `PMID ${p}`),
    ...ids.ids.filter((i) => !known.has(i))];
  return { ids, works, missing };
}

/* ------------------------------------------------------------------ checking the search */
/* Whether a text has a term, roughly as OpenAlex matches it: the words in the same order, a few endings ignored. */
const stem = (w) => (w.length > 4 ? w.replace(/(?:ies|ied)$/, "y").replace(/(?:ing|ed|es|s)$/, "") : w.replace(/s$/, ""));
function textOf(r) {
  const plain = norm(`${r.title} ${r.full || r.abstract || ""}`);
  return { plain, words: ` ${plain.split(" ").map(stem).join(" ")} `, set: new Set(plain.split(" ").map(stem)) };
}
function hasTerm(text, t) {
  if (NO_SPACES.test(t.text)) return text.plain.includes(norm(t.text));
  const ws = norm(t.text).split(" ").filter(Boolean).map(stem);
  if (!ws.length) return false;
  return t.loose ? ws.every((w) => text.set.has(w)) : text.words.includes(` ${ws.join(" ")} `);
}
const groupName = (g) => (g.find((t) => t.src === "you") || g[0] || {}).text || "a keyword";

/* Why the search probably missed a study: the filters, or the words. */
function whyMissed(q, r) {
  const f = q.filters, why = [];
  if (f.from && r.year && r.year < f.from) why.push(`it was published in ${r.year}, before ${f.from}`);
  if (f.to && r.year && r.year > f.to) why.push(`it was published in ${r.year}, after ${f.to}`);
  if (f.kinds.length && !f.kinds.includes(r.kind)) why.push(`its type, ${(KIND_NAMES[r.kind] || "other").toLowerCase()}, is not among the types chosen`);
  if (f.langs.length && r.lang && !f.langs.includes(r.lang)) why.push("its language is not among the languages chosen");
  if (f.open && !r.open) why.push("it is not open access");
  if ((f.designs || []).length && !(r.designs || []).some((d) => f.designs.includes(d))) why.push("it has none of the study designs chosen");
  const text = textOf(r);
  const lacking = q.groups.filter((g) => !g.some((t) => hasTerm(text, t)));
  if (q.mode === "all") lacking.forEach((g) => why.push(`none of the terms for “${groupName(g)}” is in its title or abstract`));
  else if (lacking.length === q.groups.length) why.push("none of the terms is in its title or abstract");
  if (!r.full && !r.abstract) why.push("OpenAlex has no abstract for it, so only its title is searched");
  if (!why.length) why.push("its title or abstract seems to have the words, but not in the form or order OpenAlex matched");
  return why;
}

/* A 95% Wilson interval for k of n. */
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, low: Math.max(0, (c - s) / d), high: Math.min(1, (c + s) / d) };
}
const pct = (x) => `${Math.round(x * 100)}%`;

export async function checkSearch(q, text, onProgress = () => {}) {
  onProgress("Looking up the studies in OpenAlex…");
  const { ids, works, missing } = await resolve(text);
  onProgress(`Checking which of the ${plural(works.length, "study", "studies")} your search finds…`);
  const found = works.length ? await SOURCES.studies.matches(q, works.map((w) => w.oa)) : new Set();
  const hit = works.filter((w) => found.has(w.oa)), missed = works.filter((w) => !found.has(w.oa));
  return { date: today(), pasted: ids.count, bad: ids.bad, missing, works, hit, missed: missed.map((r) => ({ r, why: whyMissed(q, r) })),
    recall: wilson(hit.length, works.length) };
}

/* ------------------------------------------------------------------ citation searching */
/* Backward (the references of your studies) and forward (the studies that cite them), each study once, with how it
   is linked to yours. */
export async function chaseCitations(text, { back = true, forward = true, max = 2000 } = {}, onProgress = () => {}) {
  onProgress("Looking up your studies in OpenAlex…");
  const { ids, works: seeds, missing } = await resolve(text);
  const seedIds = new Set(seeds.map((s) => s.oa));
  const out = new Map();
  const entry = (r) => out.get(r.oa) || out.set(r.oa, { r, citedBy: new Set(), cites: new Set() }).get(r.oa);
  let refs = 0, refsFound = 0, citing = 0, citingFetched = 0;
  if (back && seeds.length) {
    const linked = new Map();
    for (const s of seeds) for (const id of new Set(s.refs)) if (!seedIds.has(id)) (linked.get(id) || linked.set(id, new Set()).get(id)).add(s.oa);
    refs = linked.size;
    onProgress(`Getting the ${plural(refs, "reference")} of your studies…`);
    const works = await worksByIds({ ids: [...linked.keys()] });
    refsFound = works.length;
    for (const w of works) linked.get(w.oa).forEach((s) => entry(w).citedBy.add(s));
  }
  if (forward && seeds.length) {
    const res = await citingWorks([...seedIds], max, (n, of) => onProgress(`Getting the studies that cite yours: ${fmt(n)} of ${fmt(of)}…`));
    citing = res.total;
    citingFetched = res.works.length;
    for (const w of res.works) {
      if (seedIds.has(w.oa)) continue;
      const e = entry(w);
      w.refs.filter((id) => seedIds.has(id)).forEach((s) => e.cites.add(s));
    }
  }
  const records = [...out.values()].sort((a, b) => (b.citedBy.size + b.cites.size) - (a.citedBy.size + a.cites.size) || b.r.cited - a.r.cited);
  return { date: today(), pasted: ids.count, bad: ids.bad, missing, seeds, back, forward, max, refs, refsFound, citing, citingFetched, records };
}

/* "Cited by 3 of your studies; cites 1 of your studies" */
export function linkText(e) {
  const s = [e.citedBy.size ? `cited by ${e.citedBy.size} of your studies` : "", e.cites.size ? `cites ${e.cites.size} of your studies` : ""]
    .filter(Boolean).join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ similar studies */
/* "More like these": OpenAlex lists for every work the works most similar to it (up to ten, by the embeddings of their
   titles, abstracts and journals, since October 2026). The lists of your studies are put together, each study ranked by
   how many of yours it is similar to; optionally one step further, the studies similar to those. */
export async function similarStudies(q, text, { deeper = false } = {}, onProgress = () => {}) {
  onProgress("Looking up your studies in OpenAlex…");
  const { ids, works: seeds, missing } = await resolve(text);
  const seedIds = new Set(seeds.map((s) => s.oa));
  const add = (map, id, from) => (map.get(id) || map.set(id, new Set()).get(id)).add(from);
  const first = new Map(), second = new Map();
  for (const s of seeds) for (const id of s.related || []) if (!seedIds.has(id)) add(first, id, s.oa);
  onProgress(`Getting the ${plural(first.size, "similar study", "similar studies")}…`);
  const works = new Map(first.size ? (await worksByIds({ ids: [...first.keys()] })).map((w) => [w.oa, w]) : []);
  if (deeper) {
    for (const w of works.values()) for (const id of w.related || []) if (!seedIds.has(id) && !first.has(id)) add(second, id, w.oa);
    const next = [...second].sort((a, b) => b[1].size - a[1].size).slice(0, 300).map(([id]) => id);
    if (next.length) {
      onProgress(`Getting ${plural(next.length, "study", "studies")} similar to those…`);
      for (const w of await worksByIds({ ids: next })) if (!works.has(w.oa)) works.set(w.oa, w);
    }
  }
  let found = null;
  if (q.groups.length && works.size) {
    onProgress(`Checking which of the ${plural(works.size, "similar study", "similar studies")} your search finds…`);
    found = await SOURCES.studies.matches(q, [...works.keys()]);
  }
  const records = [...works.values()].filter((r) => !seedIds.has(r.oa))
    .map((r) => ({ r, seeds: first.get(r.oa) || new Set(), via: second.get(r.oa) || new Set(), found: found ? found.has(r.oa) : null }))
    .sort((a, b) => b.seeds.size - a.seeds.size || b.via.size - a.via.size || b.r.cited - a.r.cited);
  return { date: today(), pasted: ids.count, bad: ids.bad, missing, seeds, deeper, records, checked: Boolean(found) };
}

/* "Similar to 3 of your 5 studies" */
export function similarText(e, nSeeds) {
  const k = e.seeds.size;
  if (!k) return `Similar to ${plural(e.via.size, "study", "studies")} found in the first step`;
  return `Similar to ${k < nSeeds ? `${fmt(k)} of your ${fmt(nSeeds)} studies` : k === 1 ? "your study" : k === 2 ? "both your studies" : `all ${fmt(k)} of your studies`}`;
}

/* ------------------------------------------------------------------ what your results cite */
export async function citedByResults(q, onProgress = () => {}) {
  onProgress("Reading the references of your best-matching results…");
  const works = await SOURCES.studies.references(q);
  const counts = new Map();
  for (const refs of works.values()) for (const id of new Set(refs)) counts.set(id, (counts.get(id) || 0) + 1);
  const top = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 50);
  if (!top.length) return { read: works.size, items: [] };
  onProgress(`Looking up the ${plural(top.length, "work")} they cite most…`);
  const records = new Map((await worksByIds({ ids: top.map(([id]) => id) })).map((r) => [r.oa, r]));
  onProgress("Checking which of them your search finds…");
  const found = await SOURCES.studies.matches(q, [...records.keys()]);
  return { read: works.size, date: today(), items: top.filter(([id]) => records.has(id)).map(([id, n]) => ({ r: records.get(id), n, found: found.has(id) || works.has(id) })) };
}

/* ------------------------------------------------------------------ PRISMA 2020 flow diagram */
/* The PRISMA 2020 flow diagram for new reviews that searched databases, registers and other sources, as SVG: the
   numbers Research Finder knows are filled in, the others are left as (n = …) for you to fill. Numbers are never
   guessed. c: { date, databases: [[name, n]], registers, duplicates, otherRemoved, screened, citation } */
export function prismaSvg(c) {
  const W = 960, col = [56, 296, 536, 756], cw = [210, 210, 190, 190], line = 15, gap = 34;
  const n = (v) => (v == null ? "(n = …)" : `(n = ${fmt(v)})`);       // kept on one line
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const wrap = (text, width) => {
    const max = Math.floor(width / 6.3), out = [];
    for (const para of String(text).split("\n")) {
      let cur = "";
      for (const word of para.split(" ")) {
        if ((cur + " " + word).trim().length > max && cur) { out.push(cur); cur = word; } else cur = (cur + " " + word).trim();
      }
      out.push(cur);
    }
    return out;
  };
  const dbs = (c.databases || []).length === 1 ? c.databases[0][0] : (c.databases || []).map(([name, v]) => `${name} ${n(v)}`).join("\n");
  const rows = [
    { boxes: [[0, `Records identified from:\nDatabases ${n(c.databases && c.databases.length ? c.databases.reduce((s, [, v]) => s + (v || 0), 0) : null)}\n${dbs}\nRegisters ${n(c.registers)}`],
      [1, `Records removed before screening:\nDuplicate records removed ${n(c.duplicates)}\nRecords marked as ineligible by automation tools ${n(c.automation)}\nRecords removed for other reasons ${n(c.otherRemoved)}`],
      [2, `Records identified from:\nWebsites ${n(null)}\nOrganisations ${n(null)}\nCitation searching ${n(c.citation)}`]] },
    { boxes: [[0, `Records screened\n${n(c.screened)}`], [1, `Records excluded\n${n(c.excluded)}`]] },
    { boxes: [[0, `Reports sought for retrieval\n${n(null)}`], [1, `Reports not retrieved\n${n(null)}`], [2, `Reports sought for retrieval\n${n(null)}`], [3, `Reports not retrieved\n${n(null)}`]] },
    { boxes: [[0, `Reports assessed for eligibility\n${n(null)}`], [1, `Reports excluded:\nReason 1 ${n(null)}\nReason 2 ${n(null)}\nReason 3 ${n(null)}`],
      [2, `Reports assessed for eligibility\n${n(null)}`], [3, `Reports excluded:\nReason 1 ${n(null)}\nReason 2 ${n(null)}`]] },
    { boxes: [[0, `Studies included in review\n${n(null)}\nReports of included studies\n${n(null)}`]] },
  ];
  let y = 64;
  const placed = rows.map((row) => {
    const boxes = row.boxes.map(([ci, text]) => ({ ci, lines: wrap(text, cw[ci] - 16) }));
    const hgt = Math.max(...boxes.map((b) => b.lines.length)) * line + 18;
    const out = { y, h: hgt, boxes };
    y += hgt + gap;
    return out;
  });
  const H = y + 40;
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif" font-size="11.5">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="#222"/></marker></defs>`];
  const rect = (x, yy, w, hh, fill = "#ffffff") => `<rect x="${x}" y="${yy}" width="${w}" height="${hh}" rx="4" fill="${fill}" stroke="#222" stroke-width="1.2"/>`;
  const text = (x, yy, lines, w) => `<text x="${x + w / 2}" y="${yy + 16}" text-anchor="middle" fill="#111">${lines.map((l, i) => `<tspan x="${x + w / 2}" dy="${i ? line : 0}">${esc(l)}</tspan>`).join("")}</text>`;
  const arrow = (x1, y1, x2, y2) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#222" stroke-width="1.2" fill="none" marker-end="url(#a)"/>`;
  // headings
  svg.push(rect(col[0], 14, col[1] + cw[1] - col[0], 34, "#f2c14e"), `<text x="${(col[0] + col[1] + cw[1]) / 2}" y="36" text-anchor="middle" font-weight="bold">Identification of studies via databases and registers</text>`);
  svg.push(rect(col[2], 14, col[3] + cw[3] - col[2], 34, "#d9d9d9"), `<text x="${(col[2] + col[3] + cw[3]) / 2}" y="36" text-anchor="middle" font-weight="bold">Identification of studies via other methods</text>`);
  // stage labels
  const stage = (label, y1, y2) => svg.push(`<rect x="12" y="${y1}" width="30" height="${y2 - y1}" rx="4" fill="#9dc3e6" stroke="#222" stroke-width="1"/>`,
    `<text transform="translate(31 ${(y1 + y2) / 2}) rotate(-90)" text-anchor="middle" font-weight="bold">${label}</text>`);
  stage("Identification", placed[0].y, placed[0].y + placed[0].h);
  stage("Screening", placed[1].y, placed[3].y + placed[3].h);
  stage("Included", placed[4].y, placed[4].y + placed[4].h);
  const at = {};
  placed.forEach((row, ri) => row.boxes.forEach((b) => {
    svg.push(rect(col[b.ci], row.y, cw[b.ci], row.h), text(col[b.ci], row.y, b.lines, cw[b.ci]));
    at[`${ri}.${b.ci}`] = { x: col[b.ci], y: row.y, w: cw[b.ci], h: row.h };
  }));
  const right = (a, b) => arrow(a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2);
  const down = (a, b) => arrow(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y);
  svg.push(right(at["0.0"], at["0.1"]), down(at["0.0"], at["1.0"]), right(at["1.0"], at["1.1"]), down(at["1.0"], at["2.0"]),
    right(at["2.0"], at["2.1"]), down(at["2.0"], at["3.0"]), right(at["3.0"], at["3.1"]), down(at["3.0"], at["4.0"]),
    down(at["0.2"], at["2.2"]), right(at["2.2"], at["2.3"]), down(at["2.2"], at["3.2"]), right(at["3.2"], at["3.3"]));
  const s = at["3.2"], t = at["4.0"];
  svg.push(`<path d="M${s.x + s.w / 2} ${s.y + s.h} V${t.y + t.h / 2} H${t.x + t.w}" stroke="#222" stroke-width="1.2" fill="none" marker-end="url(#a)"/>`);
  svg.push(`<text x="${col[0]}" y="${H - 24}" fill="#333" font-size="10.5"><tspan x="${col[0]}">${esc(`Numbers filled in by Research Finder from its search on ${dayText(c.date || today())}; fill in the others after screening.`)}</tspan><tspan x="${col[0]}" dy="14">${esc("Template: Page MJ, McKenzie JE, Bossuyt PM, et al. The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ 2021;372:n71.")}</tspan></text>`);
  svg.push("</svg>");
  return svg.join("");
}

/* ------------------------------------------------------------------ the dialog */
/* ctx (from the search page): query(), results(), link(href, text), exportRecords(records, { extraName, extraOf, name, format }),
   saveRecords({ title, records, extraName, extraOf, details, progress }), remember(kind, result), lastCheck() */
const KNOWN_HINT = "One per line: DOIs (10.1234/abcd or https://doi.org/…), PubMed IDs or OpenAlex IDs (W123…).";

export function openTools(kind, ctx) {
  const d = $("#tools");
  const body = $("#tools-body");
  const title = { check: "Check your search", chase: "Citation search", cited: "What your results cite most", similar: "More like these", mine: "Your studies" }[kind];
  fill($("#tools-title"), title);
  const out = h("div", { class: "tools-out", role: "status", "aria-live": "polite" });
  const busy = (msg) => fill(out, h("p", { class: "note pending" }, spinner(), msg));
  const box = h("textarea", { id: "tools-ids", rows: 7, spellcheck: "false", placeholder: "10.1177/0956797610383437\n10.1037/a0021524\nPMID 21280961" }, local.get("known", ""));
  const keep = () => local.set("known", box.value.trim());
  const key = Boolean(local.get("openalexKey", ""));
  const parts = SOURCES.studies.queries(ctx.query()).parts.length;
  const listOf = (items, extra) => h("ol", { class: "tools-list" }, items.map((it) => {
    const r = it.r || it;
    const href = r.doi ? `https://doi.org/${r.doi}` : r.url || `https://openalex.org/${r.oa}`;
    return h("li", {}, ctx.link(href, r.title), h("span", { class: "tools-meta" }, [r.year, r.authors, r.venue].filter(Boolean).join(" · ")), extra ? extra(it) : null);
  }));
  if (kind === "check") {
    const go = h("button", { type: "button", class: "btn btn-primary" }, "Check the search");
    fill(body,
      h("p", {}, "Paste studies your search should find, such as studies you know are eligible or the studies of an earlier review. Research Finder finds them in OpenAlex and checks which of them your search, with its filters, retrieves: its relative recall. For each one it misses, it says why, so that you can add a term or change a filter."),
      h("label", { for: "tools-ids", class: "tools-label" }, "Studies your search should find"), box, h("p", { class: "note" }, KNOWN_HINT),
      h("p", { class: "note" }, `It uses ${plural(parts, "OpenAlex search", "OpenAlex searches")} for every 100 studies, one for each part of your search${key ? "" : " (OpenAlex allows about 100 a day without a key)"}, and a lookup that costs a tenth of a search.`),
      h("div", { class: "save-actions" }, go), out);
    go.addEventListener("click", async () => {
      keep();
      if (!parseIds(box.value).count) { fill(out, h("p", { class: "note warn" }, "No DOIs, PubMed IDs or OpenAlex IDs found in the box.")); return; }
      go.disabled = true;
      try {
        const res = await checkSearch(ctx.query(), box.value, busy);
        ctx.remember("check", res);
        fill(out, checkView(res, ctx, listOf));
      } catch (e) { fill(out, h("p", { class: "note warn" }, `The check did not work: ${e.message}`)); } finally { go.disabled = false; }
    });
  } else if (kind === "chase") {
    const back = h("input", { type: "checkbox", checked: true }), forward = h("input", { type: "checkbox", checked: true });
    const go = h("button", { type: "button", class: "btn btn-primary" }, "Search their citations");
    fill(body,
      h("p", {}, "Citation searching from the studies you include, as systematic review guidance asks: the studies they cite (backward) and the studies that cite them (forward), from OpenAlex's citation index, each study once. Run it again with the new studies you include, until it finds nothing new."),
      h("label", { for: "tools-ids", class: "tools-label" }, "Your studies"), box, h("p", { class: "note" }, KNOWN_HINT),
      h("label", { class: "f-option" }, back, "Their references (backward)"), h("label", { class: "f-option" }, forward, "Studies that cite them (forward), up to 2,000, newest first"),
      h("p", { class: "note" }, "It costs about one OpenAlex lookup (a tenth of a search) for every 100 references and every 200 citing studies. OpenAlex links only the references it can match to a work, so some are missing; record what you searched and when, and screen the results like the database records."),
      h("div", { class: "save-actions" }, go), out);
    go.addEventListener("click", async () => {
      keep();
      if (!parseIds(box.value).count) { fill(out, h("p", { class: "note warn" }, "No DOIs, PubMed IDs or OpenAlex IDs found in the box.")); return; }
      if (!back.checked && !forward.checked) { fill(out, h("p", { class: "note warn" }, "Choose backward, forward or both.")); return; }
      go.disabled = true;
      try {
        const res = await chaseCitations(box.value, { back: back.checked, forward: forward.checked }, busy);
        ctx.remember("chase", res);
        fill(out, chaseView(res, ctx, listOf));
      } catch (e) { fill(out, h("p", { class: "note warn" }, `The citation search did not work: ${e.message}`)); } finally { go.disabled = false; }
    });
  } else if (kind === "similar") {
    const deeper = h("input", { type: "checkbox" });
    const go = h("button", { type: "button", class: "btn btn-primary" }, "Find similar studies");
    fill(body,
      h("p", {}, "Studies similar to yours that your search may have missed. For every work, OpenAlex lists the ten works most like it, comparing their titles, abstracts and journals. Research Finder puts these lists together for your studies, ranks each study by how many of yours it is like, and checks which of them your search finds: a similar study your search misses may be worded in a way your terms do not cover."),
      h("label", { for: "tools-ids", class: "tools-label" }, "Your studies"), box, h("p", { class: "note" }, KNOWN_HINT, " Three to twenty relevant studies work best."),
      h("label", { class: "f-option" }, deeper, "One step further: also the studies similar to the ones found (more of them, less close)"),
      h("p", { class: "note" }, `It costs about one OpenAlex lookup (a tenth of a search) for every 100 studies, and ${plural(parts, "OpenAlex search", "OpenAlex searches")} for every 100 similar studies, to check which ones your search finds${key ? "" : " (OpenAlex allows about 100 searches a day without a key)"}. OpenAlex works out the similarities again from time to time, so the list can change: note when you made it.`),
      h("div", { class: "save-actions" }, go), out);
    go.addEventListener("click", async () => {
      keep();
      if (!parseIds(box.value).count) { fill(out, h("p", { class: "note warn" }, "No DOIs, PubMed IDs or OpenAlex IDs found in the box.")); return; }
      go.disabled = true;
      try {
        const res = await similarStudies(ctx.query(), box.value, { deeper: deeper.checked }, busy);
        ctx.remember("similar", res);
        fill(out, similarView(res, ctx, listOf));
      } catch (e) { fill(out, h("p", { class: "note warn" }, `This did not work: ${e.message}`)); } finally { go.disabled = false; }
    });
  } else if (kind === "mine") {
    const go = h("button", { type: "button", class: "btn btn-primary" }, "Show them");
    const show = async () => {
      keep();
      if (!parseIds(box.value).count) { fill(out, h("p", { class: "note" }, "None yet: add studies with “☆ Add to your studies” under each result, or paste their DOIs above.")); return; }
      go.disabled = true;
      try {
        busy("Looking up your studies in OpenAlex…");
        const res = await resolve(box.value);
        fill(out, mineView(res, ctx, listOf));
      } catch (e) { fill(out, h("p", { class: "note warn" }, `Your studies could not be looked up: ${e.message}`)); } finally { go.disabled = false; }
    };
    go.addEventListener("click", show);
    fill(body,
      h("p", {}, "The studies you keep: the ones you add with “☆ Add to your studies” under each result, from any search, and any you paste here. The review tools start from them, to check your search, search their citations and find similar studies, and here you can cite them or export them. They are kept only in this browser."),
      h("label", { for: "tools-ids", class: "tools-label" }, "Your studies"), box, h("p", { class: "note" }, KNOWN_HINT, " Looking them up costs one OpenAlex lookup (a tenth of a search) for every 100."),
      h("div", { class: "save-actions" }, go), out);
    show();
  } else {
    const go = h("button", { type: "button", class: "btn btn-primary" }, "Find them");
    fill(body,
      h("p", {}, "The works that your best-matching results cite most often, and whether your search finds them. A study many of your results cite but your search misses is often a key study worded differently: look at its title and abstract for terms to add."),
      h("p", { class: "note" }, `It reads the references of the up to 200 best-matching results of each part of your search and checks the 50 works they cite most. That uses ${plural(parts * 2, "OpenAlex search", "OpenAlex searches")}${key ? "" : " (OpenAlex allows about 100 a day without a key)"}.`),
      h("div", { class: "save-actions" }, go), out);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const res = await citedByResults(ctx.query(), busy);
        ctx.remember("cited", res);
        fill(out, citedView(res, ctx, listOf));
      } catch (e) { fill(out, h("p", { class: "note warn" }, `This did not work: ${e.message}`)); } finally { go.disabled = false; }
    });
  }
  if (!d.open) d.showModal();
}

function exportButtons(ctx, records, opts) {
  return h("div", { class: "tools-actions" },
    h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { ...opts, format: "ris" }) }, "Export RIS"),
    h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { ...opts, format: "csv" }) }, "Export CSV"),
    h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { ...opts, format: "bib" }) }, "Export BibTeX"),
    h("button", { type: "button", class: "btn btn-small", onclick: () => ctx.exportRecords(records, { ...opts, format: "zotero" }) }, "Send to Zotero"));
}

/* A button that saves records in a folder of their own in Google Drive, with their own "Search details". */
function saveButton(ctx, saveBox, { title, records, opts, details }) {
  return h("button", { type: "button", class: "btn btn-small btn-primary", onclick: async (e) => {
    e.target.disabled = true;
    try {
      const done = await ctx.saveRecords({ title, records, ...opts, details, progress: (m) => fill(saveBox, spinner(), m) });
      fill(saveBox, h("p", {}, h("strong", {}, "Saved: "), ctx.link(done.folder, "Open the folder"), " · ", ctx.link(done.sheet, "Results"), " · ", ctx.link(done.doc, "Search details")));
    } catch (err) { fill(saveBox, h("p", { class: "note warn" }, `Not saved: ${err.message}`)); } finally { e.target.disabled = false; }
  } }, "Save to Google Drive");
}

function mineView(res, ctx, listOf) {
  const records = res.works;
  if (!records.length) return h("p", { class: "note warn" }, `None of them is in OpenAlex${res.missing.length ? `: ${res.missing.join(", ")}` : ""}.`);
  const saveBox = h("div", { class: "save-progress" });
  const opts = { extraName: "Your study", extraOf: () => "yes", name: "your-studies" };
  return [
    h("p", { class: "tools-head" }, h("strong", {}, `${plural(records.length, "study", "studies")} in OpenAlex.`),
      res.missing.length ? ` Not in OpenAlex: ${res.missing.join(", ")}.` : ""),
    res.ids.bad.length ? h("p", { class: "note" }, `Not recognized: ${res.ids.bad.slice(0, 10).join(", ")}${res.ids.bad.length > 10 ? "…" : ""}`) : null,
    h("div", { class: "tools-actions" },
      h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => openCite(records, ctx, { title: "References for your studies" }) }, "Cite them"),
      saveButton(ctx, saveBox, { title: `Your studies — ${plural(records.length, "study", "studies")}`, records, opts,
        details: (checks) => listHtml("Your studies", `${plural(records.length, "study", "studies")} kept by the reviewer in Research Finder (“Your studies”), looked up in OpenAlex.`, records, checks) }),
      exportButtons(ctx, records, opts)),
    saveBox,
    h("div", { class: "tools-actions" },
      h("span", { class: "note" }, "Start from them:"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => openTools("check", ctx) }, "Check your search"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => openTools("chase", ctx) }, "Citation search"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => openTools("similar", ctx) }, "More like these")),
    listOf(records),
  ];
}

function similarView(res, ctx, listOf) {
  const recs = res.records, n = res.seeds.length;
  if (!recs.length) return h("p", {}, "OpenAlex lists no similar studies for these.");
  const records = recs.map((e) => e.r);
  const missed = recs.filter((e) => e.found === false).length;
  const why = new Map(recs.map((e) => [e.r.key, `${similarText(e, n)}${e.found == null ? "" : e.found ? "; found by your search" : "; not found by your search"}`]));
  const opts = { extraName: "Similar to your studies", extraOf: (r) => why.get(r.key) || "", name: "similar-studies" };
  const saveBox = h("div", { class: "save-progress" });
  return [
    h("p", { class: "tools-head" }, h("strong", {}, `${plural(recs.length, "study", "studies")} similar to ${n === 1 ? "your study" : `your ${fmt(n)} studies`}`),
      res.checked ? [": ", h("strong", {}, `${fmt(missed)} not found by your search`), "."] : "."),
    res.missing.length ? h("p", { class: "note warn" }, `Not in OpenAlex, so left out: ${res.missing.join(", ")}.`) : null,
    res.bad.length ? h("p", { class: "note" }, `Not recognized: ${res.bad.slice(0, 10).join(", ")}${res.bad.length > 10 ? "…" : ""}`) : null,
    h("div", { class: "tools-actions" },
      saveButton(ctx, saveBox, { title: `Similar studies — ${plural(n, "study", "studies")}`, records, opts, details: (checks) => similarHtml(res, checks) }),
      exportButtons(ctx, records, opts)),
    saveBox,
    listOf(recs, (e) => h("span", { class: `tools-why${e.found === false ? " tools-miss" : ""}` }, similarText(e, n),
      e.found == null ? "" : [" · ", e.found ? "found by your search" : h("strong", {}, "not found by your search")])),
  ];
}

function checkView(res, ctx, listOf) {
  const n = res.works.length;
  const head = n
    ? `Your search finds ${fmt(res.hit.length)} of the ${plural(n, "study", "studies")} in OpenAlex: a relative recall of ${pct(res.recall.p)} (95% interval ${pct(res.recall.low)} to ${pct(res.recall.high)}).`
    : "None of the studies pasted is in OpenAlex.";
  return [
    h("p", { class: "tools-head" }, h("strong", {}, head)),
    res.missing.length ? h("p", { class: "note warn" }, `${plural(res.missing.length, "study is", "studies are")} not in OpenAlex, so no search here can find ${res.missing.length === 1 ? "it" : "them"}: search for ${res.missing.length === 1 ? "it" : "them"} in other databases too. `, h("span", { class: "tools-ids" }, res.missing.join(", "))) : null,
    res.bad.length ? h("p", { class: "note" }, `Not recognized: ${res.bad.slice(0, 10).join(", ")}${res.bad.length > 10 ? "…" : ""}`) : null,
    res.missed.length ? [h("h3", {}, `Missed (${fmt(res.missed.length)})`), listOf(res.missed, (m) => h("span", { class: "tools-why" }, `Probably because ${m.why.join("; ")}.`))] : null,
    res.hit.length ? [h("h3", {}, `Found (${fmt(res.hit.length)})`), listOf(res.hit)] : null,
    h("p", { class: "note" }, "The reasons for a miss are worked out on this page from the study's title and abstract, so they are a guide, not OpenAlex's own account. Saving the search puts this check into “Search details”."),
  ];
}

function chaseView(res, ctx, listOf) {
  const recs = res.records;
  const records = recs.map((e) => e.r);
  const linkOf = new Map(recs.map((e) => [e.r.key, linkText(e)]));
  const opts = { extraName: "Found by citation searching", extraOf: (r) => linkOf.get(r.key) || "", name: "citation-search" };
  const saveBox = h("div", { class: "save-progress" });
  const shown = new Set(ctx.results().map((r) => r.key));
  const head = [
    res.back ? `${plural(res.refsFound, "reference")} (of ${fmt(res.refs)} linked in OpenAlex)` : "",
    res.forward ? `${plural(res.citingFetched, "citing study", "citing studies")}${res.citing > res.citingFetched ? ` (of ${fmt(res.citing)}: the newest ${fmt(res.citingFetched)} were fetched)` : ""}` : "",
  ].filter(Boolean).join(" and ");
  return [
    h("p", { class: "tools-head" }, h("strong", {}, `${fmt(recs.length)} studies from ${fmt(res.seeds.length)} of your studies: `), head, "."),
    res.missing.length ? h("p", { class: "note warn" }, `Not in OpenAlex, so not searched: ${res.missing.join(", ")}.`) : null,
    res.bad.length ? h("p", { class: "note" }, `Not recognized: ${res.bad.slice(0, 10).join(", ")}${res.bad.length > 10 ? "…" : ""}`) : null,
    recs.length ? h("div", { class: "tools-actions" },
      saveButton(ctx, saveBox, { title: `Citation search — ${plural(res.seeds.length, "study", "studies")}`, records, opts, details: (checks) => chaseHtml(res, checks) }),
      exportButtons(ctx, records, opts)) : null,
    saveBox,
    recs.length ? listOf(recs.slice(0, 200), (e) => h("span", { class: "tools-why" }, linkText(e), shown.has(e.r.key) ? " · also among the results shown" : "")) : null,
    recs.length > 200 ? h("p", { class: "note" }, `The first 200 of ${fmt(recs.length)} are listed; the export and the save have all of them.`) : null,
  ];
}

function citedView(res, ctx, listOf) {
  if (!res.items.length) return h("p", {}, `No work is cited by two or more of the ${fmt(res.read)} results read.`);
  const missing = res.items.filter((x) => !x.found);
  const records = res.items.map((x) => x.r);
  const counts = new Map(res.items.map((x) => [x.r.key, `cited by ${x.n} of the ${res.read} results read; ${x.found ? "found by your search" : "not found by your search"}`]));
  return [
    h("p", { class: "tools-head" }, h("strong", {}, `${fmt(missing.length)} of the ${fmt(res.items.length)} works your results cite most ${missing.length === 1 ? "is" : "are"} not found by your search.`),
      ` Read: the references of ${plural(res.read, "result")}.`),
    exportButtons(ctx, records, { extraName: "Cited by your results", extraOf: (r) => counts.get(r.key) || "", name: "cited-by-results" }),
    listOf(res.items, (x) => h("span", { class: `tools-why${x.found ? "" : " tools-miss"}` }, `Cited by ${x.n} of your results · `, x.found ? "found by your search" : h("strong", {}, "not found by your search"))),
  ];
}

/* For "Search details": what a check of the search found. */
export function checkHtml(res, esc) {
  const n = res.works.length;
  return `<h2>Search validation</h2>
<p>On ${esc(dayText(res.date))} the search was checked against ${plural(res.pasted, "study", "studies")} it should find (pasted by the reviewer): ${fmt(n)} are in OpenAlex${res.missing.length ? ` (not in OpenAlex: ${esc(res.missing.join(", "))})` : ""}. The search, with its filters, retrieved ${fmt(res.hit.length)} of the ${fmt(n)}${n ? `: a relative recall of ${pct(res.recall.p)} (95% Wilson interval ${pct(res.recall.low)} to ${pct(res.recall.high)})` : ""}.</p>
${res.missed.length ? `<p>Missed:</p><ul>${res.missed.map((m) => `<li>${esc(m.r.title)} (${m.r.year || "n.d."})${m.r.doi ? `, https://doi.org/${esc(m.r.doi)}` : ""}: probably because ${esc(m.why.join("; "))}.</li>`).join("")}</ul>` : ""}`;
}

const htmlEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const seedList = (seeds) => `<ul>${seeds.map((s) => `<li>${htmlEsc(s.authors)} (${s.year || "n.d."}). ${htmlEsc(s.title)}. ${s.doi ? `https://doi.org/${htmlEsc(s.doi)}` : `https://openalex.org/${htmlEsc(s.oa)}`}</li>`).join("")}</ul>`;
const made = () => `<p>Made with Research Finder (<a href="${htmlEsc(location.origin + location.pathname)}">${htmlEsc(location.origin + location.pathname)}</a>) on ${htmlEsc(dayText(today()))}.</p>`;

/* For the "Search details" of a save of your studies. */
function listHtml(title, what, records, checks) {
  return `<html><head><meta charset="utf-8"></head><body>
<h1>${htmlEsc(title)}</h1>
${made()}
<p>${htmlEsc(what)}</p>
${seedList(records)}
${checks || ""}
</body></html>`;
}

/* For the "Search details" of a save of similar studies. */
function similarHtml(res, checks) {
  const missed = res.records.filter((e) => e.found === false).length;
  return `<html><head><meta charset="utf-8"></head><body>
<h1>Similar studies</h1>
${made()}
<h2>Starting studies</h2>
<p>${plural(res.seeds.length, "study", "studies")} found in OpenAlex${res.missing.length ? `; not in OpenAlex, so left out: ${htmlEsc(res.missing.join(", "))}` : ""}:</p>
${seedList(res.seeds)}
<h2>Method</h2>
<p>For every work, OpenAlex lists up to ten related works, the ones most similar to it by machine-learned embeddings of their titles, abstracts and venues (since October 2026). Research Finder took these lists for the starting studies${res.deeper ? ", and, one step further, for the studies found, keeping the 300 that were similar to the most of them" : ""}, and ranked each study by how many of the starting studies it is similar to. The starting studies are left out. OpenAlex recomputes the similarities from time to time, so the same request can give other studies later. Report this as a supplementary search method (similar-article searching), with its date.</p>
<h2>Results</h2>
<p>${fmt(res.records.length)} studies, in “Results” and “Results.ris”, with what each is similar to (column “Similar to your studies”)${res.checked ? `. ${fmt(missed)} of them were not found by the search the reviewer had open (${htmlEsc(location.href)}), which was checked with its filters` : ""}. Deduplicate them against the database searches in your reference manager or screening tool.</p>
${checks || ""}
</body></html>`;
}

/* For a citation search's own "Search details": what was done, in the terms of the TARCiS statement. */
function chaseHtml(res, checks) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<html><head><meta charset="utf-8"></head><body>
<h1>Citation search</h1>
<p>Made with Research Finder (<a href="${esc(location.origin + location.pathname)}">${esc(location.origin + location.pathname)}</a>) on ${esc(dayText(res.date))}.</p>
<h2>Starting studies</h2>
<p>${plural(res.seeds.length, "study", "studies")} found in OpenAlex${res.missing.length ? `; not in OpenAlex, so not searched: ${esc(res.missing.join(", "))}` : ""}:</p>
<ul>${res.seeds.map((s) => `<li>${esc(s.authors)} (${s.year || "n.d."}). ${esc(s.title)}. ${s.doi ? `https://doi.org/${esc(s.doi)}` : `https://openalex.org/${esc(s.oa)}`}</li>`).join("")}</ul>
<h2>Method</h2>
<p>Citation index: OpenAlex (its references are matched to works by DOI and other metadata; references it cannot match are not listed). Directions: ${[res.back ? "backward (the references of the starting studies)" : "", res.forward ? `forward (the studies that cite them; the newest ${fmt(res.max)} at most)` : ""].filter(Boolean).join(" and ")}. One round. Each study is listed once; the starting studies are left out.</p>
<h2>Results</h2>
<p>${res.back ? `Backward: ${fmt(res.refs)} references linked in OpenAlex, ${fmt(res.refsFound)} retrieved. ` : ""}${res.forward ? `Forward: ${fmt(res.citing)} citing studies, ${fmt(res.citingFetched)} retrieved. ` : ""}In all ${fmt(res.records.length)} studies, in “Results” and “Results.ris”, with how each is linked to the starting studies (column “Found by citation searching”). Deduplicate them against the database searches in your reference manager or screening tool; the PRISMA 2020 flow diagram counts them under “Citation searching”.</p>
${checks || ""}
</body></html>`;
}
