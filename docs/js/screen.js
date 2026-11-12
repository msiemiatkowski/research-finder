/* Screening titles and abstracts: one record at a time, include, maybe or exclude (with a reason), notes and undo,
   from the keyboard or the buttons. Once there is one record of each kind, the records most like the included ones come
   first: a TF-IDF text model with logistic regression, retrained as decisions accumulate (the idea of ASReview, rebuilt
   here; it ranks, it never decides). Stopping checks advise when to stop; two reviewers screen independently and
   exchange files; decisions go to ASReview, Rayyan or Covidence, or to Google Drive. Projects are kept in this
   browser (IndexedDB). With the visitor's own AI key, each record can show an AI suggestion against the criteria,
   with a one-line reason, next to the reviewer's decision; it never decides, and it does not change the order. */
import { $, h, fill, fmt, plural, norm, fold, local, toast, parseCsv } from "./util.js?v=43";
import { readExport } from "./combine.js?v=43";
import { aiReady, aiLabel, aiServiceName, suggestScreening, estimate, estimateText, promptChars, PROMPTS } from "./ai.js?v=43";

const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
const pause = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const dayText = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const REASONS = ["Wrong population", "Wrong intervention or exposure", "Wrong outcome", "Wrong study design", "Not a primary study", "Not about the topic", "Language", "Duplicate", "Other"];
const RELEVANT = (d) => d === "include" || d === "maybe";

/* ------------------------------------------------------------------ storage */
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open("rf-screening", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("projects", { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("projects", mode);
    const req = fn(tx.objectStore("projects"));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const saveProject = (p) => store("readwrite", (s) => s.put(p)).catch(() => toast("This browser does not keep the project (private window?): export your decisions before you close the tab.", 6000));
const listProjects = () => store("readonly", (s) => s.getAll()).catch(() => []);
const deleteProject = (id) => store("readwrite", (s) => s.delete(id));
let saveTimer = null;
const saveSoon = (p) => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveProject(p), 400); };

/* ------------------------------------------------------------------ the records */
const keyOf = (r) => r.key || (r.doi ? `doi:${r.doi.toLowerCase()}` : r.pmid ? `pmid:${r.pmid}` : `t:${norm(r.title).slice(0, 80)}|${r.year || ""}`);
const slim = (r) => ({
  key: keyOf(r), title: r.title, abstract: r.full || r.abstract || "", authors: r.authors || (r.people || []).slice(0, 6).join("; "), year: r.year || "",
  venue: r.venue || "", doi: r.doi || "", pmid: r.pmid || "", url: r.url || r.landing || "", source: r.source || r.label || "", kind: r.kind || "",
  keywords: (r.keywords || []).slice(0, 10), en: r.en || "",
});
function newProject(records, { name, source, terms = [] }) {
  const seen = new Set(), list = [];
  for (const r of records.map(slim)) if (!seen.has(r.key)) { seen.add(r.key); list.push(r); }
  return { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, source, created: new Date().toISOString(), records: list,
    order: list.map((r) => r.key), decisions: {}, log: [], reasons: local.get("screenReasons", REASONS), reviewer: local.get("reviewer", ""), terms: terms.slice(0, 300),
    others: [], final: {}, version: 1 };
}

/* ------------------------------------------------------------------ the text model */
const STOP = new Set(("about above after again against all also although among and any are because been before being between both but can could did does doing during each either few for from further had has have having her here hers him his how however into its itself just may might more most much must neither nor not now off once only other our ours out over own same she should since some such than that the their theirs them then there these they this those though through thus too under until upon very was were what when where whether which while who whom whose why will with within without would yet you your study studies results result effect effects using used based between among data analysis method methods paper research").split(" "));
function tokens(text) {
  const words = fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]}_${words[i + 1]}`);
  return out;
}
/* TF-IDF vectors (sublinear term frequency, L2 norm) of the title (twice), the English title, the abstract and the keywords. */
function vectorize(records) {
  const docs = records.map((r) => tokens(`${r.title} ${r.title} ${r.en} ${r.abstract} ${(r.keywords || []).join(" ")}`));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length, min = n >= 50 ? 2 : 1;
  const vocab = new Map();
  [...df].filter(([, c]) => c >= min && c <= Math.max(2, 0.6 * n)).sort((a, b) => b[1] - a[1]).slice(0, 40000).forEach(([t], i) => vocab.set(t, i));
  const idf = new Float32Array(vocab.size);
  for (const [t, i] of vocab) idf[i] = Math.log((n + 1) / (df.get(t) + 1)) + 1;
  const vecs = docs.map((d) => {
    const tf = new Map();
    for (const t of d) { const i = vocab.get(t); if (i !== undefined) tf.set(i, (tf.get(i) || 0) + 1); }
    const idx = Int32Array.from(tf.keys()), val = new Float32Array(idx.length);
    let norm2 = 0;
    idx.forEach((i, k) => { val[k] = (1 + Math.log(tf.get(i))) * idf[i]; norm2 += val[k] * val[k]; });
    const s = norm2 ? 1 / Math.sqrt(norm2) : 0;
    for (let k = 0; k < val.length; k++) val[k] *= s;
    return { idx, val };
  });
  return { vecs, size: vocab.size };
}
const dot = (w, x) => { let z = w[w.length - 1]; for (let k = 0; k < x.idx.length; k++) z += w[x.idx[k]] * x.val[k]; return z; };
/* Logistic regression by stochastic gradient descent, the rarer class weighted up so that it is not ignored. */
function train(model, labeled) {
  const w = new Float32Array(model.size + 1);
  const pos = labeled.filter(([, y]) => y).length, neg = labeled.length - pos;
  const wPos = Math.min(20, Math.max(1, neg / Math.max(1, pos)));
  const order = labeled.map((_, i) => i);
  for (let epoch = 0, rate = 0.5; epoch < 25; epoch++, rate *= 0.92) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const o of order) {
      const [x, y] = labeled[o];
      const p = 1 / (1 + Math.exp(-dot(w, x)));
      const g = (p - y) * (y ? wPos : 1);
      for (let k = 0; k < x.idx.length; k++) w[x.idx[k]] -= rate * (g * x.val[k] + 1e-4 * w[x.idx[k]]);
      w[w.length - 1] -= rate * g;
    }
  }
  return w;
}

/* ------------------------------------------------------------------ stopping */
const LOGF = [0];
const logFact = (n) => { for (let i = LOGF.length; i <= n; i++) LOGF[i] = LOGF[i - 1] + Math.log(i); return LOGF[n]; };
const logChoose = (n, k) => (k < 0 || k > n ? -Infinity : logFact(n) - logFact(k) - logFact(n - k));
function hyperCdf(x, N, K, n) {
  let s = 0;
  const lo = Math.max(0, n - (N - K)), denom = logChoose(N, n);
  for (let i = lo; i <= Math.min(x, K, n); i++) s += Math.exp(logChoose(K, i) + logChoose(N - K, n - i) - denom);
  return Math.min(1, s);
}
/* Callaghan and Müller-Hansen (2020): the chance of having seen so few relevant records in the last k screened if recall
   were still below the target, the smallest over every k. Below 0.05: stopping keeps recall at the target with 95%
   confidence, if the records screened last were as good as a random sample of those left. */
function stoppingP(seq, N, target = 0.95) {
  const rSeen = seq.reduce((a, b) => a + b, 0), n = seq.length;
  if (rSeen < 1 || n < 20 || n >= N) return n >= N ? 0 : null;
  let best = 1, rk = 0;
  for (let k = 1; k <= n; k++) {
    rk += seq[n - k];
    const Nk = N - (n - k), Kt = Math.floor(rSeen / target - (rSeen - rk)) + 1;
    if (Kt <= rk || Kt > Nk) continue;
    best = Math.min(best, hyperCdf(rk, Nk, Kt, k));
  }
  return best;
}

/* ------------------------------------------------------------------ agreement of two reviewers */
function agreement(mine, theirs) {
  const both = Object.keys(mine).filter((k) => theirs[k]);
  if (!both.length) return null;
  let a = 0, a1 = 0, b1 = 0;
  const conflicts = [];
  for (const k of both) {
    const x = RELEVANT(mine[k].d), y = RELEVANT(theirs[k].d);
    if (x === y) a++; else conflicts.push(k);
    if (x) a1++;
    if (y) b1++;
  }
  const n = both.length, po = a / n, pe = (a1 / n) * (b1 / n) + (1 - a1 / n) * (1 - b1 / n);
  return { n, po, kappa: pe < 1 ? (po - pe) / (1 - pe) : 1, pabak: 2 * po - 1, conflicts };
}
const kappaWord = (k) => (k > 0.9 ? "almost perfect" : k > 0.8 ? "strong" : k > 0.6 ? "moderate" : k > 0.4 ? "weak" : k > 0.2 ? "minimal" : "none");

/* ------------------------------------------------------------------ decisions from other tools */
/* A file of decisions: Research Finder's own (CSV or project JSON), ASReview's (an "included" column, or RIS notes
   ASReview_relevant / ASReview_irrelevant) or Rayyan's (notes "RAYYAN-INCLUSION: {"Name"=>"Included"}"). */
function decisionsFrom(text, filename, project) {
  const t = String(text || "").replace(/^﻿/, "");
  const byKey = new Map(project.records.map((r) => [r.key, r]));
  const byDoi = new Map(project.records.filter((r) => r.doi).map((r) => [r.doi.toLowerCase(), r]));
  const byTitle = new Map(project.records.map((r) => [`${norm(r.title).slice(0, 80)}|${r.year || ""}`, r]));
  const find = (x) => byKey.get(x.key) || (x.doi && byDoi.get(String(x.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//, "").toLowerCase()))
    || byTitle.get(`${norm(x.title || "").slice(0, 80)}|${x.year || ""}`) || null;
  const out = {};
  let reviewer = "", matched = 0, total = 0;
  if (/^\s*\{/.test(t)) {
    const j = JSON.parse(t);
    reviewer = j.reviewer || "";
    for (const [key, v] of Object.entries(j.decisions || {})) { total++; const r = byKey.get(key); if (r && v.d) { out[r.key] = v; matched++; } }
    return { reviewer, decisions: out, matched, total };
  }
  if (/^TY\s{1,2}-/m.test(t)) {
    const records = readExport(t, filename).records;
    const notes = t.split(/^ER\s{1,2}-.*$/m);
    records.forEach((x, i) => {
      total++;
      const label = /ASReview_relevant/.test(notes[i] || "") ? "include" : /ASReview_irrelevant/.test(notes[i] || "") ? "exclude" : "";
      const r = label && find(x);
      if (r) { out[r.key] = { d: label }; matched++; }
    });
    return { reviewer: "ASReview", decisions: out, matched, total };
  }
  const rows = parseCsv(t).filter((r) => r.some((x) => String(x).trim()));
  const head = rows[0].map((x) => String(x).trim().toLowerCase());
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = { key: col("key"), title: col("title", "ti"), year: col("year", "py"), doi: col("doi", "di"), decision: col("decision"), reason: col("reason"), note: col("note"), reviewer: col("reviewer"),
    label: col("included", "final_included", "label_included", "included_label", "included_final", "label", "included_flag", "include"), notes: col("notes") };
  for (const row of rows.slice(1)) {
    total++;
    const x = { key: row[c.key], title: row[c.title], year: row[c.year], doi: row[c.doi] };
    let d = "";
    if (c.decision >= 0) d = { include: "include", included: "include", maybe: "maybe", exclude: "exclude", excluded: "exclude" }[String(row[c.decision]).trim().toLowerCase()] || "";
    else if (c.label >= 0) d = String(row[c.label]).trim() === "1" ? "include" : String(row[c.label]).trim() === "0" ? "exclude" : "";
    else if (c.notes >= 0) {
      const m = /RAYYAN-INCLUSION:\s*\{[^}]*=>\s*"?(Included|Excluded|Maybe)/i.exec(row[c.notes] || "");
      d = m ? { included: "include", excluded: "exclude", maybe: "maybe" }[m[1].toLowerCase()] : "";
      if (m) reviewer = reviewer || "Rayyan";
    }
    if (c.reviewer >= 0 && row[c.reviewer]) reviewer = reviewer || row[c.reviewer];
    const r = d && find(x);
    if (r) { out[r.key] = { d, reason: c.reason >= 0 ? row[c.reason] : "", note: c.note >= 0 ? row[c.note] : "" }; matched++; }
  }
  return { reviewer: reviewer || filename.replace(/\.[a-z]+$/i, ""), decisions: out, matched, total };
}

/* ------------------------------------------------------------------ the dialog */
/* ctx (from the search page): current() → { name, shown, total, terms } or null; collect(count, progress) → { rows };
   english(records) → the records with their English titles where known; download(name, text, type, message);
   ris(records, notes); prisma(counts); save({ title, header, rows, ris, details, prisma, progress }) → { folder, sheet, doc };
   known() → identifiers of "your studies"; link(href, text). */
let ctx = null, project = null, model = null, modelFor = "", trainedAt = -1;

function dialog() {
  let d = $("#screen");
  if (!d) {
    d = h("dialog", { id: "screen", class: "screen-dialog", "aria-labelledby": "screen-title" },
      h("div", { class: "screen-inner" },
        h("div", { class: "screen-head" }, h("h2", { id: "screen-title" }, "Screening"), h("div", { class: "screen-head-tools" },
          h("button", { type: "button", class: "btn btn-small", id: "screen-projects" }, "Projects"),
          h("button", { type: "button", class: "btn btn-small", onclick: () => d.close() }, "Close"))),
        h("div", { id: "screen-body" })));
    document.body.append(d);
    $("#screen-projects", d).addEventListener("click", () => start());
    d.addEventListener("keydown", onKey);
  }
  return d;
}

export function openScreening(context, records = null, meta = null) {
  ctx = context;
  const d = dialog();
  if (!d.open) d.showModal();
  if (records) { project = newProject(records, meta); saveProject(project); model = null; screenView(); }
  else if (project) screenView();
  else start();
}

/* Where to start: this search, a project kept in this browser, or a file. */
async function start() {
  const body = $("#screen-body");
  const cur = ctx.current();
  const out = h("div", { class: "tools-out", role: "status" });
  const file = h("input", { type: "file", accept: ".ris,.txt,.nbib,.csv,.json", hidden: true });
  const count = h("select", { "aria-label": "How many results" });
  if (cur) {
    const opts = [...new Set([cur.shown, cur.total].filter(Boolean))];
    fill(count, opts.map((n) => h("option", { value: n, selected: n === (cur.total <= 2000 ? cur.total : cur.shown) }, n === cur.total ? `all ${fmt(n)} results` : `the ${fmt(n)} shown`)));
  }
  const name = h("input", { type: "text", id: "screen-reviewer", value: local.get("reviewer", ""), placeholder: "your name or initials", class: "finder-input" });
  name.addEventListener("change", () => local.set("reviewer", name.value.trim()));
  const begin = async () => {
    try {
      fill(out, h("p", { class: "note pending" }, spinner(), " Getting the results…"));
      const { rows } = await ctx.collect(Number(count.value), (m) => fill(out, h("p", { class: "note pending" }, spinner(), ` ${m}`)));
      project = newProject(await ctx.english(rows), { name: cur.name, source: `Research Finder search: ${cur.name}`, terms: cur.terms });
      await saveProject(project);
      model = null;
      screenView();
    } catch (e) {
      fill(out, h("p", { class: "note warn" }, `This did not work: ${e.message}`));
    }
  };
  file.addEventListener("change", async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    try {
      const text = await f.text();
      if (/^\s*\{/.test(text)) {
        const j = JSON.parse(text);
        if (j.type !== "screening-project") throw new Error("this is not a screening project of Research Finder");
        project = newProject(j.records, { name: j.name, source: `${j.source} (project file from ${j.reviewer || "another reviewer"})`, terms: j.terms || [] });
        project.reasons = j.reasons || project.reasons;
        project.criteria = j.criteria || "";
      } else {
        const res = readExport(text, f.name);
        project = newProject(res.records, { name: f.name.replace(/\.[a-z]+$/i, ""), source: `${res.format} file ${f.name}` });
      }
      await saveProject(project);
      model = null;
      screenView();
    } catch (e) {
      toast(`${f.name}: ${e.message}`, 6000);
    }
  });
  const saved = (await listProjects()).sort((a, b) => String(b.created).localeCompare(String(a.created)));
  fill($("#screen-title"), "Screening");
  fill(body, h("div", { class: "screen-start" },
    h("p", {}, "Screen titles and abstracts one at a time: include, maybe or exclude, with a reason. After your first include and exclude, the records most like the ones you include come first, so that most relevant records turn up early. It ranks the records; you decide each one. Your decisions stay in this browser until you export or save them."),
    h("label", { for: "screen-reviewer", class: "tools-label" }, "Reviewer"), name,
    cur ? h("div", { class: "cb-row" }, h("strong", {}, `This search: ${cur.name}`), count, h("button", { type: "button", class: "btn btn-small btn-primary", onclick: begin }, "Start screening")) : null,
    h("div", { class: "cb-row" }, h("span", {}, "A file: an export (RIS, PubMed, Web of Science, CSV), or a project another reviewer sent you"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => file.click() }, "Open a file")), file,
    saved.length ? [h("h3", {}, "Projects in this browser"), h("ul", { class: "screen-projects" }, saved.map((p) => {
      const n = Object.keys(p.decisions).length;
      return h("li", {}, h("strong", {}, p.name), h("span", { class: "tools-meta" }, `${fmt(n)} of ${fmt(p.records.length)} screened · started ${dayText(p.created)}`),
        h("span", { class: "tools-actions" },
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: () => { project = p; model = null; screenView(); } }, "Open"),
          h("button", { type: "button", class: "btn btn-small", onclick: async () => { if (confirm(`Delete the project “${p.name}” and its decisions from this browser?`)) { await deleteProject(p.id); start(); } } }, "Delete")));
    }))] : null, out));
}

/* ------------------------------------------------------------------ screening */
const decided = () => project.decisions;
const nextKey = () => project.order.find((k) => !decided()[k]);
const recordOf = (key) => project.records.find((r) => r.key === key);

/* Ranks the records not yet screened by the model, once there is a relevant and an irrelevant decision. */
async function rerank(force = false) {
  const dec = decided(), keys = Object.keys(dec);
  const pos = keys.filter((k) => RELEVANT(dec[k].d)).length, neg = keys.length - pos;
  if (!pos || !neg) return false;
  if (!force && keys.length - trainedAt < (keys.length < 50 ? 1 : 5)) return false;
  if (!model || modelFor !== project.id) { model = vectorize(project.records); modelFor = project.id; }
  const at = new Map(project.records.map((r, i) => [r.key, i]));
  const w = train(model, keys.map((k) => [model.vecs[at.get(k)], RELEVANT(dec[k].d) ? 1 : 0]));
  const left = project.records.filter((r) => !dec[r.key]).map((r) => [r.key, dot(w, model.vecs[at.get(r.key)])]).sort((a, b) => b[1] - a[1]);
  project.order = [...project.log.map((x) => x.key).filter((k) => dec[k]), ...left.map(([k]) => k)];
  project.ranked = true;
  trainedAt = keys.length;
  return true;
}

function decide(d, reason = "") {
  const key = nextKey();
  if (!key) return;
  project.decisions[key] = { d, reason: d === "exclude" ? reason : "", note: ($("#screen-note") || {}).value || "", at: new Date().toISOString() };
  project.log.push({ key, d });
  saveSoon(project);
  rerank().then(screenView);
}
function undo() {
  const last = project.log.pop();
  if (!last) return;
  delete project.decisions[last.key];
  project.order = [last.key, ...project.order.filter((k) => k !== last.key)];
  trainedAt = -1;
  saveSoon(project);
  screenView();
}

function onKey(e) {
  if (!project || !$("#screen-card") || local.get("screenKeys", true) === false) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "i") decide("include");
  else if (k === "m") decide("maybe");
  else if (k === "e") decide("exclude");
  else if (/^[1-9]$/.test(k) && project.reasons[Number(k) - 1]) decide("exclude", project.reasons[Number(k) - 1]);
  else if (k === "u" || k === "backspace") undo();
  else if (k === "n") { const n = $("#screen-note"); if (n) n.focus(); }
  else return;
  e.preventDefault();
}

/* The terms of the search, marked in the title and abstract. */
function marked(text) {
  const terms = (project.terms || []).filter((t) => t && t.length > 2).sort((a, b) => b.length - a.length).slice(0, 200);
  if (!terms.length || !text) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    out.push(text.slice(last, m.index), h("mark", {}, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function stats() {
  const dec = decided(), n = project.records.length;
  const seq = project.log.filter((x) => dec[x.key]).map((x) => (RELEVANT(dec[x.key].d) ? 1 : 0));
  let streak = 0;
  for (let i = seq.length - 1; i >= 0 && !seq[i]; i--) streak++;
  const counts = { include: 0, maybe: 0, exclude: 0 };
  for (const v of Object.values(dec)) counts[v.d]++;
  const known = ctx.known ? ctx.known() : null;
  let knownIn = 0, knownFound = 0;
  if (known) for (const r of project.records) if ((r.doi && known.dois.includes(r.doi.toLowerCase())) || (r.pmid && known.pmids.includes(r.pmid))) { knownIn++; if (dec[r.key] && RELEVANT(dec[r.key].d)) knownFound++; }
  return { n, screened: seq.length, seq, streak, counts, p: stoppingP(seq, n), knownIn, knownFound };
}

function chart(seq) {
  const W = 260, H = 90, n = seq.length;
  if (n < 2) return null;
  let c = 0;
  const pts = seq.map((x, i) => [i + 1, (c += x)]);
  const max = Math.max(1, c);
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${(x / n) * W} ${H - (y / max) * H}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "screen-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Relevant records found as screening went on: ${c} in ${n}`);
  svg.innerHTML = `<path d="M0 ${H} L${W} ${H}" class="axis"/><path d="${path}" class="line"/>`;
  return svg;
}

function screenView() {
  const body = $("#screen-body");
  fill($("#screen-title"), project.name);
  const key = nextKey();
  const r = key && recordOf(key);
  const s = stats();
  const relevant = s.counts.include + s.counts.maybe;
  const card = r ? h("article", { id: "screen-card", class: "screen-card" },
    h("p", { class: "screen-pos" }, `Record ${fmt(s.screened + 1)} of ${fmt(s.n)}`, project.ranked ? " · ranked by your decisions so far" : " · in the search's order until you include and exclude one"),
    h("h3", {}, marked(r.title)), r.en && r.en !== r.title ? h("p", { class: "r-en" }, `[${r.en}]`) : null,
    h("p", { class: "tools-meta" }, [r.authors, r.year, r.venue, r.source].filter(Boolean).join(" · ")),
    h("div", { class: "screen-abstract" }, r.abstract ? marked(r.abstract) : h("em", {}, "No abstract.")),
    r.keywords && r.keywords.length ? h("p", { class: "tools-meta" }, `Keywords: ${r.keywords.join("; ")}`) : null,
    h("p", { class: "r-links" }, r.doi ? ctx.link(`https://doi.org/${r.doi}`, "DOI") : null, r.url ? [" ", ctx.link(r.url, "Record")] : null),
    aiCard(r))
    : h("div", { class: "screen-card done" }, h("h3", {}, "Every record is screened."), h("p", {}, `${plural(relevant, "record")} included or maybe, ${plural(s.counts.exclude, "record")} excluded.`));
  const bar = r ? h("div", { class: "screen-bar" },
    h("div", { class: "screen-main-buttons" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => decide("include") }, "Include ", h("kbd", {}, "I")),
      h("button", { type: "button", class: "btn", onclick: () => decide("maybe") }, "Maybe ", h("kbd", {}, "M")),
      h("button", { type: "button", class: "btn", onclick: () => decide("exclude") }, "Exclude ", h("kbd", {}, "E")),
      h("button", { type: "button", class: "btn btn-small", onclick: undo, disabled: !project.log.length }, "Undo ", h("kbd", {}, "U"))),
    h("div", { class: "screen-reasons" }, h("span", { class: "note" }, "Exclude because:"),
      project.reasons.slice(0, 9).map((x, i) => h("button", { type: "button", class: "btn btn-small", onclick: () => decide("exclude", x) }, h("kbd", {}, String(i + 1)), ` ${x}`))),
    h("input", { type: "text", id: "screen-note", placeholder: "Note (N), kept with the next decision", class: "finder-input" })) : null;
  const checks = [
    [s.screened >= 0.1 * s.n, `At least 10% of the records screened (${fmt(s.screened)} of ${fmt(s.n)})`],
    [s.streak >= 50, `50 irrelevant records in a row (now ${fmt(s.streak)})`],
    s.knownIn ? [s.knownFound === s.knownIn, `Your studies in this set all included (${fmt(s.knownFound)} of ${fmt(s.knownIn)})`] : null,
    [s.p != null && s.p < 0.05, s.p == null ? "Statistical test: needs a relevant record and 20 decisions" : `95% recall, 95% confidence: p = ${s.p < 0.001 ? "<0.001" : s.p.toFixed(3)}${s.p < 0.05 ? " (below 0.05)" : ""}`],
  ].filter(Boolean);
  const other = project.others && project.others.length ? project.others[project.others.length - 1] : null;
  const agree = other ? agreement(project.decisions, other.decisions) : null;
  const side = h("aside", { class: "screen-side" },
    h("p", { class: "screen-count" }, h("strong", {}, `${fmt(s.screened)} of ${fmt(s.n)} screened`), h("br"),
      `${fmt(s.counts.include)} included · ${fmt(s.counts.maybe)} maybe · ${fmt(s.counts.exclude)} excluded`),
    chart(s.seq), s.seq.length > 1 ? h("p", { class: "note" }, `Relevant records found (up) as you screen (across): ${fmt(relevant)}.`) : null,
    h("h4", {}, "When to stop"),
    h("ul", { class: "screen-checks" }, checks.map(([ok, text]) => h("li", { class: ok ? "ok" : "" }, ok ? "✓ " : "· ", text))),
    h("p", { class: "note" }, "Heuristics from SAFE (Boetje and van de Schoot 2024) and the test of Callaghan and Müller-Hansen (2020). No guidance makes any of them a rule: the decision to stop is yours, and the rule you used goes into your methods."),
    aiPanel(),
    h("h4", {}, "Second reviewer"),
    agree ? h("p", {}, `With ${other.reviewer || "the other reviewer"}: ${fmt(agree.n)} records screened by both, ${Math.round(agree.po * 100)}% agreement, Cohen's kappa ${agree.kappa.toFixed(2)} (${kappaWord(agree.kappa)}), PABAK ${agree.pabak.toFixed(2)}; `,
      h("button", { type: "button", class: "link-btn", onclick: conflictsView }, `${plural(agree.conflicts.length, "conflict")} to resolve`), ".") : null,
    h("div", { class: "tools-actions" },
      h("button", { type: "button", class: "btn btn-small", onclick: exportProject }, "Project for a second reviewer"),
      h("button", { type: "button", class: "btn btn-small", onclick: importDecisions }, "Compare with their decisions")),
    h("h4", {}, "Your decisions"),
    h("div", { class: "tools-actions" },
      h("button", { type: "button", class: "btn btn-small btn-primary", onclick: (e) => saveDrive(e.target) }, "Save to Google Drive"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => exportDecisions("csv") }, "Decisions (CSV)"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => exportDecisions("asreview") }, "For ASReview (RIS)"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => exportDecisions("included") }, "Included, for Covidence or Rayyan (RIS)"),
      h("button", { type: "button", class: "btn btn-small", onclick: importDecisions }, "Import decisions")),
    h("div", { id: "screen-save", class: "save-progress" }),
    h("h4", {}, "Settings"),
    h("label", { class: "f-option" }, h("input", { type: "checkbox", checked: local.get("screenKeys", true) !== false, onchange: (e) => local.set("screenKeys", e.target.checked ? null : false) }),
      "Single-key shortcuts (I, M, E, 1–9, U, N)"),
    h("details", { class: "relay-guide" }, h("summary", {}, "Exclusion reasons"),
      h("textarea", { rows: 6, class: "screen-reasons-edit", onchange: (e) => { project.reasons = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 9); local.set("screenReasons", project.reasons); saveSoon(project); screenView(); } }, project.reasons.join("\n")),
      h("p", { class: "note" }, "One per line, up to nine; keys 1–9 exclude with them.")));
  fill(body, h("div", { class: "screen-layout" }, h("div", { class: "screen-left" }, card, bar), side));
  aiEstimate();
}

/* ------------------------------------------------------------------ AI suggestions */
let aiRun = null;          // the run in progress: { ctrl, done, of }
const aiOf = (key) => (project.ai || {})[key];
const criteriaSet = () => Boolean(String(project.criteria || "").trim());
/* Records not screened and not yet suggested for, in the order they will be shown. */
const aiNext = (count) => project.order.filter((k) => !decided()[k] && !aiOf(k)).slice(0, count).map(recordOf).filter(Boolean);

function aiCard(r) {
  const v = aiOf(r.key);
  if (v) {
    return h("div", { class: `ai-suggest ai-${v.s}` }, h("strong", {}, `AI suggests: ${v.s}`), ` — ${v.why} `,
      h("span", { class: "ai-model" }, `(${v.model}; a suggestion, not a decision)`));
  }
  if (!aiReady() || !criteriaSet()) return null;
  return h("p", {}, h("button", { type: "button", class: "btn btn-small", disabled: Boolean(aiRun), onclick: () => runAi([r]) }, "Ask the AI about this record"));
}

async function runAi(records) {
  if (aiRun || !records.length) return;
  const ctrl = new AbortController();
  aiRun = { ctrl, done: 0, of: records.length };
  project.aiService = aiServiceName();
  project.aiCriteria = project.criteria;
  screenView();
  try {
    await suggestScreening(records, project.criteria, {
      signal: ctrl.signal,
      onResult: (k, v) => { (project.ai = project.ai || {})[k] = v; },
      onProgress: (n, of) => { aiRun.done = n; const p = $("#screen-ai-progress"); if (p) fill(p, spinner(), ` ${fmt(n)} of ${fmt(of)} records…`); },
    });
  } catch (e) {
    if (e.kind !== "stopped") toast(`AI suggestions stopped: ${e.message}`, 6000);
  } finally {
    aiRun = null;
    saveSoon(project);
    if ($("#screen-card") || $("#screen-body")) screenView();
  }
}

/* The AI's suggestions as decisions, for the agreement with the reviewer's ("unsure" counts as maybe). */
function aiDecisions() {
  const out = {};
  for (const [k, v] of Object.entries(project.ai || {})) out[k] = { d: v.s === "unsure" ? "maybe" : v.s };
  return out;
}

function aiPanel() {
  const criteria = h("textarea", { rows: 4, id: "screen-criteria", class: "screen-reasons-edit", placeholder: "Include: …\nExclude: …",
    onchange: (e) => { project.criteria = e.target.value; saveSoon(project); screenView(); } });
  criteria.value = project.criteria || "";
  const n = Object.keys(project.ai || {}).length;
  const agree = n ? agreement(project.decisions, aiDecisions()) : null;
  const left = aiNext(1).length;
  return [
    h("h4", {}, "Criteria and AI suggestions"),
    h("label", { for: "screen-criteria", class: "tools-label" }, "Your criteria"), criteria,
    h("p", { class: "note" }, "They go with the project file to a second reviewer, and to the AI if you use it."),
    !aiReady() ? h("p", { class: "note" }, "Optional: with a key of your own for an AI service, each record can show a suggestion with a one-line reason next to your decision. ",
      h("button", { type: "button", class: "link-btn", onclick: () => ctx.settings() }, "Set up in Settings"), ".")
      : !criteriaSet() ? h("p", { class: "note" }, "Write your criteria to get AI suggestions.")
        : [aiRun ? h("p", { class: "note pending", id: "screen-ai-progress" }, spinner(), ` ${fmt(aiRun.done)} of ${fmt(aiRun.of)} records…`) : null,
          h("div", { class: "tools-actions" }, aiRun ? h("button", { type: "button", class: "btn btn-small", onclick: () => aiRun.ctrl.abort() }, "Stop")
            : [10, 50].map((c) => h("button", { type: "button", class: "btn btn-small", disabled: !left, onclick: () => runAi(aiNext(c)) }, `Suggest for the next ${c}`))),
          h("p", { class: "note", id: "screen-ai-estimate" }),
          h("p", { class: "note" }, `${aiLabel()} reads each record's title, abstract and keywords with your criteria and suggests include, exclude or unsure, with a reason. The suggestion shows next to the record; the decision is yours, and the order does not change.`)],
    n ? h("p", { class: "note" }, `${plural(n, "record")} with an AI suggestion.`,
      agree ? ` On the ${fmt(agree.n)} you have screened too, it agreed with you on ${Math.round(agree.po * 100)}% (Cohen's kappa ${agree.kappa.toFixed(2)}, counting “unsure” as maybe).` : "") : null,
  ];
}

/* What the next 50 suggestions would roughly cost. */
async function aiEstimate() {
  const box = $("#screen-ai-estimate");
  if (!box || aiRun) return;
  const next = aiNext(50);
  if (!next.length) { fill(box, "Every record left has a suggestion."); return; }
  const e = await estimate("screen", promptChars(next) + Math.ceil(next.length / 10) * String(project.criteria || "").length, next.length, Math.ceil(next.length / 10));
  if (box.isConnected) fill(box, `For the next ${fmt(next.length)}: ${estimateText(e)}`);
}

/* ------------------------------------------------------------------ two reviewers */
function download(name, text, type, message) { ctx.download(name, text, type, message); }
function exportProject() {
  const j = { app: "Research Finder", type: "screening-project", format: 1, name: project.name, source: project.source, reviewer: project.reviewer || local.get("reviewer", ""),
    created: today(), reasons: project.reasons, criteria: project.criteria || "", terms: project.terms, records: project.records };
  download(`screening-project-${today()}.json`, JSON.stringify(j), "application/json", "Project file downloaded: send it to the second reviewer, who opens it under Screening › Projects › Open a file.");
}
function pickFile(accept, then) {
  const f = h("input", { type: "file", accept });
  f.addEventListener("change", async () => { if (f.files[0]) then(await f.files[0].text(), f.files[0].name); });
  f.click();
}
function importDecisions() {
  pickFile(".csv,.json,.ris,.txt", (text, name) => {
    try {
      const res = decisionsFrom(text, name, project);
      if (!res.matched) { toast(`No decisions in ${name} match this project's records.`, 6000); return; }
      project.others = [...(project.others || []), { reviewer: res.reviewer, decisions: res.decisions, file: name, at: today() }];
      saveSoon(project);
      toast(`${plural(res.matched, "decision")} of ${res.reviewer || name} read (of ${fmt(res.total)} records in the file).`, 5000);
      screenView();
    } catch (e) {
      toast(`${name}: ${e.message}`, 6000);
    }
  });
}
function conflictsView() {
  const other = project.others[project.others.length - 1];
  const agree = agreement(project.decisions, other.decisions);
  const label = { include: "Include", maybe: "Maybe", exclude: "Exclude" };
  fill($("#screen-body"), h("div", { class: "screen-start" },
    h("p", {}, h("button", { type: "button", class: "btn btn-small", onclick: screenView }, "Back to screening")),
    h("p", { class: "tools-head" }, h("strong", {}, `${plural(agree.conflicts.length, "conflict")} with ${other.reviewer || "the other reviewer"}`),
      `: records one of you included (or marked maybe) and the other excluded. The final decision is kept with your decisions.`),
    h("ol", { class: "cb-pairs" }, agree.conflicts.map((k) => {
      const r = recordOf(k), fin = project.final[k];
      const set = (d) => { project.final[k] = d; saveSoon(project); conflictsView(); };
      return h("li", { class: `cb-pair${fin ? ` decided-${RELEVANT(fin) ? "same" : "different"}` : ""}` },
        h("strong", {}, r.title), h("span", { class: "tools-meta" }, [r.authors, r.year, r.venue].filter(Boolean).join(" · ")),
        h("p", { class: "cb-why" }, `You: ${label[project.decisions[k].d]}${project.decisions[k].reason ? ` (${project.decisions[k].reason})` : ""} · ${other.reviewer || "Other"}: ${label[other.decisions[k].d]}${other.decisions[k].reason ? ` (${other.decisions[k].reason})` : ""}`),
        h("div", { class: "tools-actions" }, ["include", "exclude"].map((d) => h("button", { type: "button", class: "btn btn-small", "aria-pressed": String(fin === d), onclick: () => set(d) }, `Final: ${label[d]}`))));
    }))));
}

/* ------------------------------------------------------------------ exports and Drive */
const finalOf = (k) => project.final[k] || (project.decisions[k] || {}).d || "";
const HEAD = ["Key", "Title", "Authors", "Year", "Journal or source", "DOI", "Link", "Abstract", "Decision", "Reason", "Note", "Reviewer", "Order screened", "Other reviewer", "Final decision",
  "AI suggestion", "AI reason", "AI model"];
function rows() {
  const order = new Map(project.log.map((x, i) => [x.key, i + 1]));
  const other = project.others && project.others.length ? project.others[project.others.length - 1] : null;
  return project.records.map((r) => {
    const d = project.decisions[r.key] || {};
    return [r.key, r.title, r.authors, r.year, r.venue, r.doi ? `https://doi.org/${r.doi}` : "", r.url, r.abstract, d.d || "", d.reason || "", d.note || "",
      d.d ? project.reviewer || local.get("reviewer", "") : "", order.get(r.key) || "", other && other.decisions[r.key] ? `${other.reviewer}: ${other.decisions[r.key].d}` : "", finalOf(r.key),
      (aiOf(r.key) || {}).s || "", (aiOf(r.key) || {}).why || "", (aiOf(r.key) || {}).model || ""];
  });
}
const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function exportDecisions(kind) {
  if (kind === "csv") { download(`screening-decisions-${today()}.csv`, "﻿" + [HEAD, ...rows()].map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8", "Decisions exported"); return; }
  const recs = project.records.map((r) => ({ ...r, people: String(r.authors || "").split(/;\s*/).filter(Boolean), full: r.abstract }));
  if (kind === "asreview") {
    // ASReview reads labels from the notes: relevant, irrelevant, or not seen
    const note = (r) => { const d = finalOf(r.key); return [d ? (RELEVANT(d) ? "ASReview_relevant" : "ASReview_irrelevant") : "ASReview_not_seen"]; };
    download(`for-asreview-${today()}.ris`, ctx.ris(recs, note), "application/x-research-info-systems", "Exported with ASReview's labels: import it into ASReview LAB, which reads them as prior knowledge");
    return;
  }
  const inc = recs.filter((r) => RELEVANT(finalOf(r.key)));
  download(`included-${today()}.ris`, ctx.ris(inc, () => []), "application/x-research-info-systems", `Exported ${plural(inc.length, "included record")} (and maybes)`);
}
function screeningHtml() {
  const s = stats();
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const other = project.others && project.others.length ? project.others[project.others.length - 1] : null;
  const agree = other ? agreement(project.decisions, other.decisions) : null;
  const resolved = agree ? agree.conflicts.filter((k) => project.final[k]).length : 0;
  return `<html><head><meta charset="utf-8"></head><body>
<h1>Screening: ${esc(project.name)}</h1>
<p>Made with Research Finder (${esc(location.origin + location.pathname)}) on ${esc(dayText(today()))}. Records: ${esc(project.source)}; screening started on ${esc(dayText(project.created))}.</p>
<h2>What was screened</h2>
<p>${fmt(s.n)} records; ${fmt(s.screened)} screened on title and abstract by ${esc(project.reviewer || local.get("reviewer", "") || "[reviewer]")}: ${fmt(s.counts.include)} included, ${fmt(s.counts.maybe)} marked maybe, ${fmt(s.counts.exclude)} excluded${s.n > s.screened ? `; ${fmt(s.n - s.screened)} were not screened` : ""}.</p>
<p>Exclusion reasons: ${esc(Object.entries(Object.values(project.decisions).filter((d) => d.d === "exclude").reduce((o, d) => ({ ...o, [d.reason || "no reason given"]: (o[d.reason || "no reason given"] || 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join("; ") || "none")}.</p>
<h2>Prioritised screening</h2>
<p>Records were shown in the search's order until the first included and excluded records, then ranked by a text classifier retrained as decisions accumulated (TF-IDF of words and word pairs in the title, abstract and keywords, logistic regression, the relevant class weighted up), a reimplementation of the approach of ASReview, not ASReview itself. It ordered the records; every decision was the reviewer's.</p>
<h2>Stopping</h2>
<p>At this point: ${fmt(s.screened)} of ${fmt(s.n)} records screened (${Math.round((100 * s.screened) / Math.max(1, s.n))}%); the last ${fmt(s.streak)} screened were irrelevant${s.knownIn ? `; ${fmt(s.knownFound)} of the ${fmt(s.knownIn)} known relevant studies in the set were included` : ""}; ${s.p == null ? "the statistical stopping test could not be computed yet" : `the statistical stopping test (Callaghan and Müller-Hansen 2020; 95% recall target) gave p = ${s.p < 0.001 ? "<0.001" : s.p.toFixed(3)}`}. [State the stopping rule you used and why.]</p>
${agree ? `<h2>Second reviewer</h2><p>${esc(other.reviewer || "A second reviewer")} screened independently (decisions imported from ${esc(other.file)} on ${esc(dayText(other.at))}). On the ${fmt(agree.n)} records both screened (included or maybe against excluded): agreement ${Math.round(agree.po * 100)}%, Cohen's kappa ${agree.kappa.toFixed(2)}, prevalence- and bias-adjusted kappa (PABAK) ${agree.pabak.toFixed(2)}; ${fmt(agree.conflicts.length)} conflicts, ${fmt(resolved)} resolved (column “Final decision”).</p>` : ""}
${aiHtml(esc)}
<h2>For the PRISMA 2020 flow diagram</h2>
<p>Records screened (n = ${fmt(s.screened)}); records excluded (n = ${fmt(s.counts.exclude)})${s.n > s.screened ? `; records not screened after the stopping rule (n = ${fmt(s.n - s.screened)}), which reviews often report as excluded by an automation tool [say how you report them]` : ""}. PRISMA 2020 item 8 asks how many reviewers screened each record, whether independently, and which automation tools were used.</p>
</body></html>`;
}
/* The AI suggestions, for the screening record: which model, how many, how they agreed with the reviewer, the prompt. */
function aiHtml(esc) {
  const list = Object.values(project.ai || {});
  if (!list.length) return "";
  const days = list.map((v) => String(v.at).slice(0, 10)).sort();
  const models = [...new Set(list.map((v) => v.model))];
  const counts = list.reduce((o, v) => ({ ...o, [v.s]: (o[v.s] || 0) + 1 }), {});
  const agree = agreement(project.decisions, aiDecisions());
  return `<h2>AI suggestions</h2>
<p>An AI model (${project.aiService ? `${esc(project.aiService)}, ` : ""}${models.length > 1 ? "models" : "model"} ${esc(models.join(", "))}) suggested include, exclude or unsure, with a one-line reason, for ${fmt(list.length)} records (${fmt(counts.include || 0)} include, ${fmt(counts.exclude || 0)} exclude, ${fmt(counts.unsure || 0)} unsure), from ${esc(dayText(days[0]))}${days[0] !== days[days.length - 1] ? ` to ${esc(dayText(days[days.length - 1]))}` : ""}, using the titles, abstracts and keywords with the criteria below. Each suggestion was shown to the reviewer next to the record; every decision was the reviewer's, and the suggestions did not change the order of screening.${agree ? ` On the ${fmt(agree.n)} records that both covered, the suggestions agreed with the reviewer's decisions on ${Math.round(agree.po * 100)}% (Cohen's kappa ${agree.kappa.toFixed(2)}; “unsure” counted as maybe).` : ""} [Say how the suggestions were used, and report the AI use as your reporting guideline asks.]</p>
<p><b>Criteria given to the model:</b> ${esc(project.aiCriteria || project.criteria || "")}</p>
<p><b>Instructions given to the model:</b> ${esc(PROMPTS.screen)}</p>`;
}
async function saveDrive(button) {
  const box = $("#screen-save");
  button.disabled = true;
  try {
    const s = stats();
    const recs = project.records.map((r) => ({ ...r, people: String(r.authors || "").split(/;\s*/).filter(Boolean), full: r.abstract }));
    const done = await ctx.save({
      title: `Screening — ${project.name}`, header: HEAD, rows: rows(),
      ris: ctx.ris(recs.filter((r) => RELEVANT(finalOf(r.key))), () => []), details: screeningHtml,
      prisma: ctx.prisma({ date: today(), databases: [], registers: null, duplicates: null, otherRemoved: null, screened: s.screened, excluded: s.counts.exclude,
        automation: s.n > s.screened ? s.n - s.screened : null, citation: null }),
      progress: (m) => fill(box, spinner(), m),
    });
    fill(box, h("p", {}, h("strong", {}, "Saved: "), ctx.link(done.folder, "Open the folder"), " · ", ctx.link(done.sheet, "Decisions"), " · ", ctx.link(done.doc, "Screening record")));
  } catch (e) {
    fill(box, h("p", { class: "note warn" }, `Not saved: ${e.message}`));
  } finally {
    button.disabled = false;
  }
}

/* For testing the stopping rule and the agreement on their own. */
export { stoppingP, agreement };
