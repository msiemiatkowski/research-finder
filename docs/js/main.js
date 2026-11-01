/* Research Finder: the page. */
import { CONFIG } from "../config.js?v=24";
import { $, h, fill, fmt, plural, norm, escapeRe, NO_SPACES, safeUrl, local, toast } from "./util.js?v=24";
import { LANGS, LANG_NAMES, SRC_LABEL, SAMPLE, parseInput, makeGroup, enrich, activeTerms, isTranslation, translateGroup } from "./terms.js?v=24";
import { SOURCES, KIND_NAMES, REPO_NAMES, booleanQuery, repoQueries, maxParts, semanticScholarPdfs, pdfLinks, datasetFiles } from "./sources.js?v=24";
import { driveConfigured, driveConnected, connect, disconnect, saveSearch, onDriveChange } from "./drive.js?v=24";

const LIVE_WAIT = 40000;          // longest wait for the wordings and translations before searching anyway
const PAGE_SIZE = { studies: 25, data: 8 };
const emptyFilters = () => ({ kinds: [], langs: [], from: null, to: null, open: false, repos: [], fulltext: false });
const state = {
  input: "", groups: [], mode: "all", tab: "studies", sort: "rel",
  langsOff: new Set(local.get("langsOff", [])), filters: emptyFilters(), showAllLangs: false,
};
let results = [], total = 0, more = false, page = 1, notes = [], extra = {}, searchSeq = 0, highlight = null;
const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });

/* ------------------------------------------------------------------ searching */
const groupsForSearch = () => state.groups.map((g) => activeTerms(g, state.langsOff)).filter((ts) => ts.length);
const query = () => ({ groups: groupsForSearch(), mode: state.mode, filters: state.filters, sort: state.sort });

let timer = null;
function search(delay = 150) {
  clearTimeout(timer);
  timer = setTimeout(() => runSearch(), delay);
  toHash();
}

async function runSearch() {
  const id = ++searchSeq;
  const src = SOURCES[state.tab];
  const q = query();
  page = 1;
  results = [];
  notes = [];
  highlight = highlighter(q.groups.flat().map((t) => t.text));
  document.body.classList.toggle("searching", q.groups.length > 0);
  if (!q.groups.length) {           // nothing to ask the services yet
    total = 0;
    extra = {};
    fill($("#results"));
    $("#more").hidden = true;
    $("#toolbar").hidden = true;
    renderFilters();
    return;
  }
  renderToolbar("Searching…");
  fill($("#results"), h("li", { class: "loading" }, spinner(), `Searching ${src.note}…`));
  $("#more").hidden = true;
  try {
    const res = await src.search(q, page, PAGE_SIZE[state.tab]);
    if (id !== searchSeq) return;
    show(res, true);
  } catch (e) {
    if (id !== searchSeq) return;
    fill($("#results"), h("li", { class: "empty" }, h("strong", {}, "The search did not work. "), e.message));
    total = 0;
    renderToolbar();
  }
  renderFilters();
}

async function showMore() {
  const id = searchSeq;
  $("#more").disabled = true;
  try {
    const res = await SOURCES[state.tab].search(query(), page + 1, PAGE_SIZE[state.tab]);
    if (id !== searchSeq) return;
    page += 1;
    show(res, false);
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    $("#more").disabled = false;
  }
}

function show(res, first) {
  const known = new Set(results.map((r) => r.key));
  const fresh = res.items.filter((r) => !known.has(r.key));
  results.push(...fresh);
  total = res.total;
  more = res.more;
  extra = { totals: res.totals, dropped: res.dropped, parts: res.parts };
  notes = [...new Set([...(first ? [] : notes), ...(res.notes || [])])];
  const list = $("#results");
  if (first) fill(list);
  if (first && !results.length) list.append(h("li", { class: "empty" }, emptyMessage()));
  for (const r of fresh) list.append(renderRecord(r));
  $("#more").hidden = !more;
  renderToolbar();
}

function emptyMessage() {
  const tips = [];
  if (state.groups.length > 1 && state.mode === "all") tips.push("Switch to “any keyword”.");
  const f = state.filters;
  if (f.kinds.length || f.langs.length || f.from || f.to || f.open || f.repos.length) tips.push("Remove some filters.");
  if (state.tab === "data") tips.push("Datasets are described in English: try English keywords.");
  return [h("strong", {}, "Nothing found. "), tips.join(" ") || "Try other keywords."];
}

/* ------------------------------------------------------------------ keywords */
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderGroups(); }, 60);
}

function preparing() {
  document.body.classList.add("searching");
  $("#toolbar").hidden = true;
  $("#more").hidden = true;
  fill($("#results"), h("li", { class: "loading" }, spinner(),
    "Preparing the search: the wordings studies use for your keywords, and their translations into 39 languages…"));
}

/* Each keyword is looked up (Wikidata, the studies, the translations) before the search, so that it runs once with
   all the terms. */
async function setQuery(text) {
  state.input = String(text || "").trim();
  $("#q").value = state.input;
  $("#about").hidden = true;
  const groups = state.groups = parseInput(state.input).map(makeGroup);
  renderGroups();
  if (!groups.length) return search(0);
  preparing();
  const all = Promise.all(groups.map((g) => enrich(g, { onChange: () => { if (state.groups.includes(g)) renderSoon(); } })));
  const first = await Promise.race([all.then(() => true), new Promise((r) => setTimeout(() => r(false), LIVE_WAIT))]);
  if (state.groups !== groups) return;          // replaced by another search meanwhile
  renderGroups();
  search(0);
  if (!first) all.then(() => { if (state.groups === groups) search(0); });   // the terms came late: search again with them
}

function addKeyword(text) {
  const parts = parseInput(text).map(makeGroup);
  state.groups.push(...parts);
  state.input = state.groups.map((g) => g.label).join(", ");
  $("#q").value = state.input;
  renderGroups();
  Promise.all(parts.map((g) => enrich(g, { onChange: renderSoon }))).then(() => { renderGroups(); search(0); });
}

function removeGroup(g) {
  state.groups = state.groups.filter((x) => x !== g);
  state.input = state.groups.map((x) => x.label).join(", ");
  $("#q").value = state.input;
  renderGroups();
  search(0);
}

/* An English term switched on for the first time is translated too, then searched. */
async function translateMore(g) {
  g.stage = "Translating the new terms into 39 languages…";
  renderGroups();
  await translateGroup(g, { onProgress: (n, of) => { g.stage = `Translating the new terms: ${n} of ${of} languages…`; renderSoon(); } });
  g.stage = "";
  renderGroups();
  search(0);
}

function chip(t, g, onToggle) {
  const where = LANG_NAMES[t.lang] ? ` · ${LANG_NAMES[t.lang]}` : "";
  const read = fmt((g.studies || {}).read || SAMPLE);
  const count = t.n ? (t.src === "studies" ? ` · a keyword of ${fmt(t.n)} of the ${read} studies read` : ` · in ${fmt(t.n)} of the ${read} studies read`) : "";
  const from = t.source && t.src === "mt" ? ` · of “${t.source}”` : "";
  const doubt = t.doubt ? " · it did not translate back to the same meaning, so it is left out unless you add it" : "";
  return h("button", {
    type: "button", class: `chip ${t.on ? "on" : "off"}${t.doubt ? " doubt" : ""}`, "aria-pressed": String(t.on),
    title: `${SRC_LABEL[t.src]}${where}${from}${count}${doubt} · click to ${t.on ? "leave out" : "add"}`,
    onclick: () => { t.on = !t.on; onToggle(t); },
  }, t.text, t.n ? h("span", { class: "n" }, fmt(t.n)) : null);
}

function renderGroups() {
  const box = $("#terms");
  fill(box);
  if (!state.groups.length) return;
  if (state.groups.length > 1) {
    box.append(h("div", { class: "mode-row" }, "Results must match",
      h("span", { class: "seg", role: "group", "aria-label": "How keywords combine" },
        h("button", { type: "button", "aria-pressed": String(state.mode === "all"), onclick: () => { state.mode = "all"; renderGroups(); search(0); } }, "all keywords"),
        h("button", { type: "button", "aria-pressed": String(state.mode === "any"), onclick: () => { state.mode = "any"; renderGroups(); search(0); } }, "any keyword"))));
  }
  for (const g of state.groups) box.append(groupCard(g));
}

function groupCard(g) {
  const rerender = () => { renderGroups(); search(); };
  const toggled = (t) => {
    if (t.on && !isTranslation(t) && !t.translated && g.status === "done") { t.picked = true; translateMore(g); }
    else rerender();
  };
  const english = g.terms.filter((t) => !isTranslation(t));
  const searching = english.filter((t) => t.on || (g.edit && ["you", "alias", "variant", "mt"].includes(t.src)));
  const offered = english.filter((t) => !t.on && (t.src === "similar" || t.src === "studies"));
  const off = english.filter((t) => !t.on);
  const card = h("div", { class: "group" }, h("div", { class: "group-head" },
    h("span", { class: "group-label" }, g.label),
    g.wikidata ? h("a", { class: "concept-badge wd", href: `https://www.wikidata.org/wiki/${g.wikidata.id}`, target: "_blank", rel: "noopener noreferrer",
      title: `Wikidata: ${g.wikidata.description || g.wikidata.label}` }, g.wikidata.label) : null,
    g.studies ? h("span", { class: "group-meta", title: "Studies in OpenAlex with the keyword in the title or abstract" }, `${plural(g.studies.total, "study", "studies")} in OpenAlex`) : null,
    h("span", { class: "group-actions" },
      h("button", { type: "button", class: "btn btn-small", "aria-expanded": String(g.edit), onclick: () => { g.edit = !g.edit; renderGroups(); } }, g.edit ? "Done" : "Edit terms"),
      h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: () => removeGroup(g), "aria-label": `Remove ${g.label}` }, "Remove"))));
  if (g.status === "pending" || g.stage) card.append(h("p", { class: "note pending" }, spinner(), g.stage || "Looking up the terms…"));
  if (g.wikidata && g.wikidata.description) card.append(h("p", { class: "note" }, `Matched to “${g.wikidata.label}”: ${g.wikidata.description}. Not this meaning? Choose Edit terms and switch its synonyms and translations off.`));
  for (const n of g.notes || []) card.append(h("p", { class: "note warn" }, n));

  const variants = english.filter((t) => t.src === "variant");
  card.append(h("div", { class: "g-row" }, h("p", { class: "g-row-title" }, "Searching for",
    variants.length && g.studies ? h("span", { class: "g-row-hint" }, `your words${g.wikidata ? ", synonyms" : ""} and the wordings found in the ${fmt(g.studies.read)} studies that match best`) : null),
    h("div", { class: "chips" }, searching.map((t) => chip(t, g, toggled)),
      !g.edit && off.length ? h("button", { type: "button", class: "link-btn", onclick: () => { g.edit = true; renderGroups(); } }, `${off.length} more suggestions`) : null)));
  if (g.edit && offered.length) {
    card.append(h("div", { class: "g-row" }, h("p", { class: "g-row-title" }, "Related phrases and keywords in these studies",
      h("span", { class: "g-row-hint" }, "click to search for them too")),
      h("div", { class: "chips" }, offered.map((t) => chip(t, g, toggled)))));
  }

  const tr = g.terms.filter(isTranslation);
  if (tr.length) {
    const langs = LANGS.filter((l) => tr.some((t) => t.lang === l));
    const active = langs.filter((l) => !state.langsOff.has(l));
    const used = tr.filter((t) => t.on && !state.langsOff.has(t.lang)).length;
    const row = h("div", { class: "g-row" }, h("p", { class: "g-row-title" }, `Also in ${plural(active.length, "other language")}`,
      h("span", { class: "g-row-hint" }, plural(used, "term")),
      g.edit ? null : h("button", { type: "button", class: "link-btn", onclick: () => { g.edit = true; renderGroups(); } }, "show all")));
    if (!g.edit) {
      const preview = active.slice(0, 6).map((l) => tr.find((t) => t.lang === l && t.on)).filter(Boolean).map((t) => t.text).join(" · ");
      row.append(h("div", { class: "note tr-preview" }, preview + (active.length > 6 ? " …" : "")));
    } else {
      const grid = h("div", { class: "tr-grid" });
      for (const l of langs) {
        const on = !state.langsOff.has(l);
        grid.append(h("div", { class: "tr-lang" }, h("label", {}, h("input", {
          type: "checkbox", checked: on, onchange: (e) => { setLang(l, e.target.checked); rerender(); },
        }), LANG_NAMES[l])), h("div", { class: "chips" }, tr.filter((t) => t.lang === l).map((t) => (on ? chip(t, g, rerender) : h("span", { class: "chip off lang" }, t.text)))));
      }
      row.append(grid, h("p", { class: "note" }, "Names from Wikidata are written by its volunteers. The others are machine translations by Wikimedia's MinT, each translated back into English as a check: the ones that did not come back with the same meaning are marked “?” and left out. Check them before relying on them in a review. Unticking a language turns it off for every keyword; Settings has the full list."));
    }
    card.append(row);
  } else if (g.status === "done") {
    card.append(h("p", { class: "note" }, "No translations found for this keyword; it is searched as typed. Shorter keywords, separated by commas, match more often."));
  }

  const rel = (g.related || []).filter((x) => norm(x.text) !== norm(g.label)).slice(0, g.edit ? 12 : 6);
  if (rel.length) {
    card.append(h("div", { class: "g-row" }, h("p", { class: "g-row-title" }, "Often studied together — add as another keyword"),
      h("div", { class: "chips" }, rel.map((x) => h("button", { type: "button", class: "chip topic", title: `Add “${x.text}” as another keyword`, onclick: () => addKeyword(x.text) },
        x.text, x.n ? h("span", { class: "n" }, fmt(x.n)) : null)))));
  }
  return card;
}

function setLang(l, on) {
  if (on) state.langsOff.delete(l); else state.langsOff.add(l);
  local.set("langsOff", [...state.langsOff]);
}

/* ------------------------------------------------------------------ results */
function highlighter(texts) {
  const parts = [];
  for (const t of [...new Set(texts)].sort((a, b) => b.length - a.length).slice(0, 150)) {
    if (NO_SPACES.test(t)) { parts.push(escapeRe(t.replace(/\s+/g, ""))); continue; }
    const ws = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!ws.length) continue;
    parts.push("(?<![\\p{L}\\p{N}])" + ws.map((w) => (w.length >= 5 && !/\d/.test(w)
      ? escapeRe(w.slice(0, w.length - (w.length >= 8 ? 2 : 1))) + "[\\p{L}\\p{N}]*" : escapeRe(w))).join("[^\\p{L}\\p{N}]+") + "(?![\\p{L}\\p{N}])");
  }
  if (!parts.length) return null;
  try { return new RegExp(parts.join("|"), "giu"); } catch { return null; }
}

function marked(text, re) {
  if (!re || !text) return [text || ""];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    out.push(text.slice(last, m.index), h("mark", {}, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const link = (href, text, title) => h("a", { href, target: "_blank", rel: "noopener noreferrer", title }, text);

function renderRecord(r) {
  const href = r.doi ? `https://doi.org/${r.doi}` : safeUrl(r.url) || safeUrl(r.pdf);
  const lang = r.lang && r.lang !== "en" ? LANG_NAMES[r.lang] || r.lang.toUpperCase() : "";
  const li = h("li", { class: "result" },
    h("div", { class: "r-top" },
      h("span", { class: `badge kind-${r.kind}` }, KIND_NAMES[r.kind] || "Record"),
      r.year ? h("span", {}, r.year) : null,
      lang ? h("span", { class: "badge" }, lang) : null,
      r.open ? h("span", { class: "badge open", title: "Free to read or download" }, "Open") : null,
      r.cited ? h("span", { title: "Times cited" }, `${fmt(r.cited)} citations`) : null,
      r.files && r.files.length ? h("span", { title: "Open data files" }, plural(r.files.length, "file")) : null,
      h("span", { class: "src" }, r.source)),
    h("h3", {}, href ? link(href, marked(r.title, highlight)) : h("span", {}, marked(r.title, highlight))),
    [r.authors, r.venue].filter(Boolean).length ? h("div", { class: "byline" }, [r.authors, r.venue].filter(Boolean).join(" · ")) : null,
    r.abstract ? h("p", { class: "abstract" }, marked(r.abstract, highlight)) : null);
  if (r.keywords && r.keywords.length) {
    li.append(h("div", { class: "r-kw" }, r.keywords.map((k) => h("button", { type: "button", title: `Search for “${k}”`, onclick: () => setQuery(k) }, k))));
  }
  const links = [];
  if (r.doi) links.push(link(`https://doi.org/${r.doi}`, r.kind === "d" ? "Dataset page" : "DOI"));
  if (safeUrl(r.url)) links.push(link(safeUrl(r.url), r.doi ? "Record page" : "Open record"));
  if (safeUrl(r.pdf)) links.push(link(safeUrl(r.pdf), "Open PDF"));
  if (links.length) li.append(h("div", { class: "r-links" }, links));
  return li;
}

function renderToolbar(status) {
  const bar = $("#toolbar");
  bar.hidden = false;
  const src = SOURCES[state.tab];
  const split = extra.parts > 1;
  const count = status || (state.tab === "data" && extra.totals
    ? `${plural(total, "result")} (${Object.entries(extra.totals).map(([n, c]) => `${n} ${fmt(c)}`).join(", ")})`
    : `${split ? "about " : ""}${plural(total, "result")}${split ? ` · ${extra.parts} searches` : ""}`);
  fill(bar,
    h("span", { class: "count", title: split ? `The terms did not fit in one OpenAlex search (1,500 characters), so Research Finder made ${extra.parts} searches and put their results together. The total counts a study found by two of them twice.` : null }, count),
    h("select", { "aria-label": "Sort", onchange: (e) => { state.sort = e.target.value; search(0); } },
      src.sorts.map(([v, l]) => h("option", { value: v, selected: state.sort === v }, l))),
    h("button", { type: "button", class: "btn btn-small", onclick: copySearchString, title: "Copy the terms as a Boolean search string" }, "Copy search string"),
    externalMenu(),
    results.length ? h("button", { type: "button", class: "btn btn-small", onclick: exportCsv, title: "Download the results shown as a spreadsheet (CSV)" }, "Export CSV") : null,
    results.length ? h("button", { type: "button", class: "btn btn-small btn-primary-soft", onclick: openSave, title: "Save the results, open PDFs and data files to your Google Drive" }, "Save to Google Drive") : null);
  const msgs = [...notes];
  if (extra.dropped) {
    msgs.push(state.tab === "studies"
      ? `${plural(extra.dropped, "term")} left out: even split into ${maxParts()} searches, the terms are longer than OpenAlex takes. ${local.get("openalexKey", "") ? "Choose fewer languages under Settings." : "A free OpenAlex key (Settings) allows up to 8 searches; or choose fewer languages."}`
      : `${plural(extra.dropped, "term")} left out: the query would be too long for the repositories. The English terms and the languages with the most research come first.`);
  }
  if (msgs.length) bar.append(h("div", { class: "toolbar-notes" }, msgs.map((m) => h("p", { class: "note warn" }, m))));
}

function searchString(englishOnly = false, maxLen = 100000) {
  const groups = state.groups.map((g) => activeTerms(g, state.langsOff).filter((t) => !englishOnly || !isTranslation(t)));
  return booleanQuery(groups.filter((ts) => ts.length), state.mode, maxLen).query;
}

async function copySearchString() {
  const s = searchString();
  try { await navigator.clipboard.writeText(s); toast("Search string copied"); } catch { window.prompt("Copy the search string:", s); }
}

function externalMenu() {
  const list = h("div", { class: "menu-list", hidden: true });
  const links = [
    ["Google Scholar (English terms)", `https://scholar.google.com/scholar?q=${encodeURIComponent(searchString(true, 250))}`],
    ["PubMed (English terms)", `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(searchString(true))}`],
    ["BASE (all terms)", `https://www.base-search.net/Search/Results?lookfor=${encodeURIComponent(searchString(false, 4000))}&type=all`],
    ["OpenAlex (English terms)", `https://openalex.org/works?search=${encodeURIComponent(searchString(true, 900))}`],
  ];
  for (const [l, href] of links) list.append(link(href, l));
  return h("div", { class: "menu" }, h("button", {
    type: "button", class: "btn btn-small", "aria-haspopup": "true",
    onclick: (e) => { e.stopPropagation(); list.hidden = !list.hidden; if (!list.hidden) document.addEventListener("click", () => { list.hidden = true; }, { once: true }); },
  }, "Search elsewhere ▾"), list);
}

/* One row per result, the same columns for every source. */
const HEADER = ["No.", "Title", "Authors", "Year", "Type", "Journal or repository", "DOI", "Link", "Open PDF", "Language", "Keywords", "Source", "Citations", "License", "Size"];
const rowOf = (r, i) => [i + 1, r.title, r.authors, r.year || "", KIND_NAMES[r.kind] || "", r.venue, r.doi ? `https://doi.org/${r.doi}` : "",
  r.url || r.landing || "", r.pdf, r.lang, (r.keywords || []).join("; "), r.source, r.cited || "", r.license || "", r.size || ""];

function exportCsv() {
  const cell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [HEADER, ...results.map(rowOf)].map((r) => r.map(cell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `research-finder-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(`Exported ${plural(results.length, "result")}${more ? " (the ones loaded so far)" : ""}`);
}

/* ------------------------------------------------------------------ saving to Google Drive */
const MB = 1e6;
const sizeName = (bytes) => (bytes >= 1e9 ? `${bytes / 1e9} GB` : `${bytes / MB} MB`);

function openSave() {
  const d = $("#save");
  if (!driveConfigured()) { toast("Saving to Google Drive is not set up on this copy of the site.", 4000); return; }
  const studiesTab = state.tab === "studies";
  // OpenAlex pages 200 studies at a time; without a key, its daily allowance covers about 2,000 a day
  const most = Math.min(total, studiesTab && !local.get("openalexKey", "") ? 2000 : 10000);
  const counts = [...new Set([results.length, 100, 500, 1000, 2000, 5000, most].filter((n) => n && n <= Math.max(results.length, most)))].sort((a, b) => a - b);
  const pick = counts.filter((n) => n <= 1000).pop() || counts[0];
  const howMany = h("select", { id: "save-count" }, counts.map((n) => h("option", { value: n, selected: n === pick },
    n === results.length ? `${fmt(n)} (the ones shown)` : n === total ? `all ${fmt(n)}` : `the first ${fmt(n)}`)));
  const files = h("input", { type: "checkbox", id: "save-files", checked: true });
  const totalLimit = h("select", { id: "save-total", "aria-label": "Size limit for all files" },
    [500 * MB, 2e9, 5e9, 15e9].map((b) => h("option", { value: b, selected: b === 2e9 }, sizeName(b))));
  const fileLimit = h("select", { id: "save-file", "aria-label": "Size limit for one file" },
    [50 * MB, 250 * MB, 1e9, 2e9].map((b) => h("option", { value: b, selected: b === 250 * MB }, sizeName(b))));
  fill($("#save-body"),
    h("p", {}, "Research Finder makes a folder for this search in your Google Drive, inside “Research Finder”:"),
    h("ul", { class: "tree" },
      h("li", {}, h("strong", {}, "Results"), " — a Google Sheet: one row per result, the same columns for every source, with links to the files saved"),
      h("li", {}, h("strong", {}, "Files"), " — a Google Sheet with every file found: its download link, and whether it was saved (and if not, why)"),
      h("li", {}, h("strong", {}, "Search details"), " — a document with your keywords, every term and translation used, the filters and the exact queries, so the search can be repeated"),
      studiesTab ? h("li", {}, h("strong", {}, "Papers/"), " — the open PDFs (also open versions found through Semantic Scholar, such as arXiv preprints)")
        : h("li", {}, h("strong", {}, "Datasets/"), " — one folder per dataset with its open data files")),
    h("p", { class: "save-row" }, h("label", { for: "save-count" }, "Save "), howMany, h("span", {}, ` of ${fmt(total)} results`)),
    h("p", { class: "save-row" }, h("label", {}, files, studiesTab ? " Save the open PDFs" : " Save the open data files")),
    h("p", { class: "save-row" }, h("span", {}, "Up to"), totalLimit, h("span", {}, "in all, files up to"), fileLimit, h("span", {}, "each")),
    h("p", { class: "note" }, studiesTab
      ? "Many publishers do not let browsers download their PDFs; those stay as links in the sheets."
      : "Zenodo and Harvard Dataverse files are copied into your Drive. OSF and figshare do not let browsers download files, so theirs are listed with their download links in “Files”; for other repositories the sheet links to the dataset's page."),
    h("p", { class: "note" }, "A large save takes a while: keep this tab open. Your Drive needs to be connected: Google asks you to allow access the first time, and to connect again if a save takes more than an hour."),
    h("div", { class: "save-actions" },
      h("button", { type: "button", class: "btn btn-primary", id: "save-go", onclick: () => runSave(Number(howMany.value), files.checked, Number(fileLimit.value), Number(totalLimit.value)) }, "Save to my Drive"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => d.close() }, "Close")),
    h("div", { id: "save-signin", class: "save-progress" }),
    h("div", { id: "save-progress", class: "save-progress", role: "status", "aria-live": "polite" }));
  if (!d.open) d.showModal();
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/* The first `count` results in the order shown, with further pages as needed (200 studies a page). */
async function collect(count, progress) {
  if (count <= results.length) return results.slice(0, count);
  const src = SOURCES[state.tab], q = query();
  if (state.tab === "data") {
    progress(`Getting the first ${fmt(count)} datasets…`);
    const repos = REPO_NAMES.filter((n) => !q.filters.repos.length || q.filters.repos.includes(n)).length;
    return (await src.search(q, 1, Math.min(count, Math.ceil(count / repos) * 2))).items.slice(0, count);
  }
  const rows = [], seen = new Set();
  for (let p = 1; rows.length < count && p <= 50; p++) {
    progress(`Getting the results: ${fmt(rows.length)} of ${fmt(count)}…`);
    const res = await src.search(q, p, 200);
    for (const r of res.items) if (!seen.has(r.key)) { seen.add(r.key); rows.push(r); }
    if (!res.more) break;
  }
  return rows.slice(0, count);
}

const repoOf = (url) => (/osf\.io/.test(url) ? "OSF" : /figshare/.test(url) ? "figshare" : /zenodo/.test(url) ? "Zenodo" : /dataverse/.test(url) ? "Harvard Dataverse" : "");

async function runSave(count, withFiles, maxFile, maxTotal) {
  const progress = (m) => fill($("#save-progress"), spinner(), m);
  const go = $("#save-go");
  go.disabled = true;
  try {
    if (!driveConnected()) { progress("Connecting to Google Drive…"); await connect(); }
    const rows = await collect(count, progress);
    const jobs = [];
    const name = (r) => `${((r.authors || "").split(/[;,]/)[0].trim().split(" ").pop() || "study")}_${r.year || "n.d."}_${r.title.slice(0, 70)}`;
    if (withFiles && state.tab === "studies") {
      progress("Looking for open PDFs…");
      const s2 = {};
      const dois = rows.map((r) => (r.doi || "").toLowerCase()).filter(Boolean);
      for (let i = 0; i < dois.length; i += 500) {
        try { Object.assign(s2, await semanticScholarPdfs(dois.slice(i, i + 500))); } catch { /* optional */ }
      }
      rows.forEach((r, i) => {
        const urls = [...new Set([safeUrl(r.pdf), ...(s2[(r.doi || "").toLowerCase()] || [])].filter(Boolean))];
        if (urls.length) jobs.push({ row: i, kind: "paper", urls, name: `${name(r)}.pdf`, title: r.title, repo: r.venue || "" });
      });
      await pool(jobs, 4, async (j) => { j.urls = await pdfLinks(j.urls); });
    }
    if (withFiles && state.tab === "data") {
      let listed = 0;
      const lists = rows.map(() => []);
      await pool(rows.map((r, i) => [r, i]), 4, async ([r, i]) => {
        try { lists[i] = await datasetFiles(r); } catch { /* listed as a link only */ }
        progress(`Listing the files of the datasets: ${fmt(++listed)} of ${fmt(rows.length)}…`);
      });
      rows.forEach((r, i) => {
        for (const f of lists[i]) {
          jobs.push({ row: i, kind: "data", urls: [f.url], name: f.name, size: f.size || 0, copy: f.copy !== false, repo: repoOf(f.url) || r.source,
            dataset: `${r.year || "n.d."} ${r.title.slice(0, 80)}`, title: r.title });
        }
      });
    }
    const title = `${state.input} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const res = await saveSearch({
      title, header: HEADER, rows: rows.map(rowOf), jobs, maxFile, maxTotal: Math.max(maxTotal, maxFile), onProgress: progress,
      detailsHtml: (stats) => detailsHtml(rows.length, jobs.length, stats),
      onSignIn: () => new Promise((resolve, reject) => {
        fill($("#save-signin"), h("p", { class: "note warn" }, "Google's sign-in has run out (it lasts an hour). "),
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: async () => {
            try { await connect(); fill($("#save-signin")); resolve(); } catch (e) { reject(e); }
          } }, "Connect again and continue"));
      }),
    });
    const listedOnly = res.failed.filter((j) => j.copy === false).length;
    const notSaved = res.failed.length - listedOnly;
    const filesNote = withFiles ? ` and ${plural(res.papers + res.dataFiles, "file")} (${(res.bytes / MB).toFixed(1)} MB)` : "";
    const links = () => [link(res.folder, "Open the folder"), " · ", link(res.sheet, "Results"), res.files ? [" · ", link(res.files, "Files")] : null, " · ", link(res.doc, "Search details")];
    fill($("#save-progress"), h("p", {}, h("strong", {}, "Saved: "), `${plural(rows.length, "result")}${filesNote}. `, links(),
      listedOnly ? h("span", { class: "note" }, ` ${plural(listedOnly, "file")} from OSF or figshare ${listedOnly === 1 ? "is" : "are"} listed with ${listedOnly === 1 ? "its" : "their"} download link in “Files”.`) : null,
      notSaved ? h("span", { class: "note" }, ` ${plural(notSaved, "file")} could not be saved; “Files” says why.`) : null));
    fill($("#drive-result"), h("p", {}, "Saved in your Google Drive: ", links()));
    $("#drive-result").hidden = false;
  } catch (e) {
    fill($("#save-progress"), h("p", { class: "note warn" }, `Not saved: ${e.message}`));
  } finally {
    go.disabled = false;
  }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* The record of the search, so that it can be reported and repeated. */
function detailsHtml(nRows, nJobs, stats) {
  const f = state.filters, src = SOURCES[state.tab];
  const when = new Date();
  const filters = [
    f.kinds.length ? `Types: ${f.kinds.map((k) => KIND_NAMES[k]).join(", ")}` : "",
    f.from || f.to ? `Years: ${f.from || "…"}–${f.to || "…"}` : "",
    f.open ? "Open access only" : "",
    f.fulltext ? "Full texts searched too" : "",
    f.langs.length ? `Languages of the studies: ${f.langs.map((l) => LANG_NAMES[l] || l).join(", ")}` : "",
    f.repos.length ? `Repositories: ${f.repos.join(", ")}` : "",
  ].filter(Boolean);
  const list = (ts, withCount) => ts.map((t) => esc(t.text) + (withCount && t.n ? ` (${t.n})` : "")).join("; ");
  const named = (ts) => ts.map((t) => `${esc(t.text)} (${esc(LANG_NAMES[t.lang] || t.lang)})`).join("; ");
  const groups = state.groups.map((g) => {
    const used = activeTerms(g, state.langsOff);
    const of = (srcs) => used.filter((t) => !isTranslation(t) && srcs.includes(t.src));
    const wd = used.filter((t) => isTranslation(t) && t.src === "wikidata"), mt = used.filter((t) => isTranslation(t) && t.src === "mt");
    const doubted = g.terms.filter((t) => t.doubt && !t.on).length;
    return `<h3>${esc(g.label)}</h3>`
      + (g.wikidata ? `<p>Matched to the Wikidata item <a href="https://www.wikidata.org/wiki/${g.wikidata.id}">${esc(g.wikidata.label)}</a>: ${esc(g.wikidata.description)}</p>` : "")
      + (g.studies ? `<p>Studies in OpenAlex with the keyword in the title or abstract: ${fmt(g.studies.total)}; the ${fmt(g.studies.read)} that match best were read for the wordings below.</p>` : "")
      + `<p><b>Your words:</b> ${list(of(["you"]))}</p>`
      + (of(["alias", "mt"]).length ? `<p><b>Synonyms (Wikidata) and English translation:</b> ${list(of(["alias", "mt"]))}</p>` : "")
      + (of(["variant"]).length ? `<p><b>Wordings used in studies</b> (in how many of the studies read): ${list(of(["variant"]), true)}</p>` : "")
      + (of(["similar", "studies"]).length ? `<p><b>Related phrases and keywords added:</b> ${list(of(["similar", "studies"]), true)}</p>` : "")
      + (wd.length ? `<p><b>Names in other languages (Wikidata):</b> ${named(wd)}</p>` : "")
      + (mt.length ? `<p><b>Machine translations</b> (Wikimedia MinT, each translated back into English as a check): ${named(mt)}</p>` : "")
      + (doubted ? `<p>${fmt(doubted)} machine translations did not translate back to the same meaning and were left out.</p>` : "");
  }).join("");
  const q = query();
  let queries;
  if (state.tab === "studies") {
    const { parts, dropped } = SOURCES.studies.queries(q);
    queries = `<p><b>OpenAlex</b> (search in titles and abstracts${f.fulltext ? ", and full texts" : ""})${parts.length > 1 ? `, as ${parts.length} searches whose results were put together, because OpenAlex takes up to 1,500 characters` : ""}:</p>`
      + parts.map((s, i) => `<p>${parts.length > 1 ? `Search ${i + 1}: ` : ""}<code>${esc(s)}</code></p>`).join("")
      + (dropped ? `<p>${fmt(dropped)} terms did not fit and were left out.</p>` : "");
  } else {
    queries = REPO_NAMES.filter((n) => !f.repos.length || f.repos.includes(n))
      .map((n) => `<p><b>${esc(n)}</b>:</p>${repoQueries(n, q.groups, q.mode).parts.map((s) => `<p><code>${esc(s)}</code></p>`).join("")}`).join("");
  }
  const failed = stats.failed.filter((j) => j.copy !== false).slice(0, 60).map((j) => `<li>${esc(j.title || j.name)} — ${esc(j.name)}: ${esc(j.why)}</li>`).join("");
  const listedOnly = stats.failed.filter((j) => j.copy === false).length;
  return `<html><head><meta charset="utf-8"></head><body>
<h1>Search details</h1>
<p>Saved with Research Finder (<a href="${esc(location.origin + location.pathname)}">${esc(location.origin + location.pathname)}</a>) on ${esc(when.toLocaleString("en-GB"))}.</p>
<h2>Where</h2><p>${esc(src.name)}: ${esc(src.note)}.</p>
<h2>Keywords</h2><p>Results had to match ${state.mode === "all" ? "all keywords" : "any keyword"}.</p>${groups}
<h2>Filters</h2><p>${filters.length ? filters.map(esc).join("<br>") : "None."}</p>
<h2>Queries sent</h2>${queries}
<h2>What was saved</h2>
<p>${fmt(total)} results found; the first ${fmt(nRows)} saved in the sheet “Results”, in the order shown (${esc((src.sorts.find(([v]) => v === state.sort) || ["", "Best match"])[1])}).</p>
<p>Files: ${fmt(stats.papers)} PDFs and ${fmt(stats.dataFiles)} data files saved (${(stats.bytes / MB).toFixed(1)} MB), of ${fmt(nJobs)} found; the sheet “Files” lists every one.${listedOnly ? ` ${fmt(listedOnly)} are in repositories that do not let browsers download files (OSF, figshare): the sheet has their download links.` : ""}</p>
${failed ? `<p>Not saved:</p><ul>${failed}</ul>` : ""}
<p>Repeat the search: ${esc(location.href)}</p>
</body></html>`;
}

/* ------------------------------------------------------------------ filters and tabs */
function renderTabs() {
  fill($("#tabs"), Object.values(SOURCES).map((s) => h("button", {
    type: "button", role: "tab", "aria-selected": String(state.tab === s.id), class: "tab", title: s.note,
    onclick: () => { if (state.tab !== s.id) { state.tab = s.id; state.sort = "rel"; state.filters = emptyFilters(); renderTabs(); search(0); } },
  }, s.name, h("span", { class: "tab-note" }, s.id === "studies" ? "OpenAlex" : "DataCite · Zenodo · Dataverse · OSF · OpenAIRE"))));
}

function renderFilters() {
  const src = SOURCES[state.tab], f = state.filters;
  const has = (x) => src.filters.includes(x);
  const opt = (label, checked, onchange, disabled) => h("label", { class: "f-option" }, h("input", { type: "checkbox", checked, onchange, disabled }), h("span", {}, label));
  const toggleIn = (arr, v, on) => { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); };
  const now = new Date().getFullYear();
  const yearInput = (key) => h("input", {
    type: "number", inputmode: "numeric", min: 1800, max: now + 1, placeholder: key === "from" ? "from" : "to", value: f[key] || "",
    "aria-label": key === "from" ? "From year" : "To year", onchange: (e) => { const v = parseInt(e.target.value, 10); f[key] = Number.isFinite(v) ? v : null; search(0); },
  });
  const quick = (label, from, to) => h("button", { type: "button", class: "btn btn-small", onclick: () => { f.from = from; f.to = to; search(0); } }, label);
  const langCodes = ["en", ...LANGS];
  const langs = state.showAllLangs ? langCodes : langCodes.slice(0, 8);
  for (const l of f.langs) if (!langs.includes(l)) langs.push(l);
  const sections = [];
  if (has("fulltext")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Search in"),
      opt("Titles and abstracts", true, null, true), opt("Full texts too (more results, less precise, slower)", f.fulltext, (e) => { f.fulltext = e.target.checked; search(0); })));
  }
  if (has("kinds")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Type"),
      src.kinds.map((k) => opt(KIND_NAMES[k], f.kinds.includes(k), (e) => { toggleIn(f.kinds, k, e.target.checked); search(0); }))));
  }
  if (has("repos")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Repositories"),
      REPO_NAMES.map((n) => opt(n, !f.repos.length || f.repos.includes(n),
        (e) => { f.repos = (f.repos.length ? f.repos : [...REPO_NAMES]).filter((x) => x !== n); if (e.target.checked) f.repos.push(n); if (f.repos.length === REPO_NAMES.length) f.repos = []; search(0); }))));
  }
  if (has("open")) sections.push(h("div", { class: "f-section" }, h("h3", {}, "Access"), opt("Open access", f.open, (e) => { f.open = e.target.checked; search(0); })));
  sections.push(h("div", { class: "f-section" }, h("h3", {}, "Year"),
    h("div", { class: "f-years" }, yearInput("from"), "–", yearInput("to")),
    h("div", { class: "f-quick" }, quick(`Since ${now - 4}`, now - 4, null), quick("Since 2015", 2015, null), f.from || f.to ? quick("Any year", null, null) : null)));
  if (has("langs")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Language of the study"),
      langs.map((l) => opt(l === "en" ? "English" : LANG_NAMES[l] || l.toUpperCase(), f.langs.includes(l), (e) => { toggleIn(f.langs, l, e.target.checked); search(0); })),
      h("button", { type: "button", class: "link-btn f-more", onclick: () => { state.showAllLangs = !state.showAllLangs; renderFilters(); } },
        state.showAllLangs ? "fewer languages" : `all ${langCodes.length} languages`)));
  }
  const active = f.kinds.length || f.langs.length || f.from || f.to || f.open || f.repos.length || f.fulltext;
  if (active) sections.push(h("div", { class: "f-section" }, h("button", { type: "button", class: "btn btn-small", onclick: () => { state.filters = emptyFilters(); search(0); } }, "Clear filters")));
  fill($("#filters-body"), sections);
}

/* ------------------------------------------------------------------ settings, about */
function openSettings() {
  const d = $("#settings");
  const key = h("input", { type: "password", autocomplete: "off", value: local.get("openalexKey", ""), placeholder: "optional", id: "set-key" });
  const mail = h("input", { type: "email", autocomplete: "email", value: local.get("email", ""), placeholder: "optional", id: "set-mail" });
  const langs = h("div", { class: "lang-grid" }, LANGS.map((l) => h("label", { class: "f-option" },
    h("input", { type: "checkbox", checked: !state.langsOff.has(l), onchange: (e) => { setLang(l, e.target.checked); } }), LANG_NAMES[l])));
  const drive = !driveConfigured()
    ? h("p", { class: "note" }, "Saving to Google Drive is not set up on this copy of the site.")
    : driveConnected()
      ? h("p", {}, "Connected. ", h("button", { type: "button", class: "btn btn-small", onclick: () => { disconnect(); openSettings(); } }, "Disconnect"))
      : h("p", {}, h("button", { type: "button", class: "btn btn-small btn-drive", onclick: async () => { try { await connect(); openSettings(); } catch (e) { toast(e.message, 5000); } } }, "Connect Google Drive"),
        " Research Finder can only see the files it saves, in a folder called “Research Finder”.");
  fill($("#settings-body"),
    h("h3", {}, "Search in these languages"),
    h("p", { class: "note" }, "The names and translations of your keywords in these languages are added to every search. Fewer languages make shorter queries."),
    h("div", { class: "f-quick" },
      h("button", { type: "button", class: "btn btn-small", onclick: () => { LANGS.forEach((l) => setLang(l, true)); openSettings(); } }, "All"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => { LANGS.forEach((l) => setLang(l, false)); openSettings(); } }, "English only")),
    langs,
    h("h3", {}, "Google Drive"), drive,
    h("h3", {}, h("label", { for: "set-key" }, "OpenAlex key (optional)")),
    h("p", { class: "note" }, "Without a key, OpenAlex shares a free allowance of about 100 searches a day among everyone on your network, and limits free searches when it is busy. Each keyword takes one search to read how studies word it, and a search with many translations is split into up to 3 OpenAlex searches. A free personal key (",
      link("https://openalex.org/settings/api", "get one"), ") allows ten times more, up to 8 searches for one, and is not slowed down. It is kept only in this browser."), key,
    h("h3", {}, h("label", { for: "set-mail" }, "Your email (optional)")),
    h("p", { class: "note" }, "Sent only to OpenAlex with your searches, as their guidelines ask; kept only in this browser."), mail,
    h("h3", {}, "Other services"),
    h("p", { class: "note" }, "No other keys are needed. Wikidata, Wikimedia's MinT translation, DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE are free and open. Machine translations are remembered in this browser, so each term is translated only once. Semantic Scholar, which Research Finder asks for open PDFs when you save, does not accept keys sent from web pages, so it is asked without one."));
  d.onclose = () => {
    local.set("openalexKey", key.value.trim());
    local.set("email", mail.value.trim());
    renderGroups();
    if (state.groups.length) search(0);
  };
  if (!d.open) d.showModal();
}

function renderAbout() {
  const c = CONFIG.creator || {};
  fill($("#about-body"),
    h("p", { class: "lead-sm" }, "Research Finder is a free tool for researchers who need more than a list of papers: it finds studies and the datasets behind them, in many languages, and saves everything it finds to your Google Drive in a clear, repeatable structure."),
    h("h3", {}, "What makes it different"),
    h("ul", {},
      h("li", {}, h("strong", {}, "Datasets, not only papers. "), "Studies from OpenAlex (about 270 million works) and datasets from DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE, with their open data files."),
      h("li", {}, h("strong", {}, "Everything saved, in order. "), "Each search becomes a folder in your Drive: a sheet with one row per result in the same columns for every source, a sheet with every file found and its download link, the open PDFs and data files in their own folders, and a record of exactly how you searched."),
      h("li", {}, h("strong", {}, "Every wording, in 40 languages. "), "Your keywords are expanded with the other wordings studies use for them, and translated, so studies written in Polish, Spanish or Japanese are found too."),
      h("li", {}, h("strong", {}, "Built for systematic work. "), "You see and control every term; the search details, the Boolean search string and the CSV export make a search easy to report and to repeat in other databases.")),
    h("h3", {}, "How your keywords become a search"),
    h("ol", {},
      h("li", {}, h("strong", {}, "Synonyms. "), "Wikidata, the open knowledge base behind Wikipedia, gives a known topic's synonyms and its names in other languages."),
      h("li", {}, h("strong", {}, "The wordings studies use. "), `Research Finder reads the titles and abstracts of the ${SAMPLE} studies in OpenAlex that match each keyword best and finds the phrases that say the same in other words: all of the keyword's words, in any form and order (“trust in scientists” and “trustworthiness of science” for “trust in science”). These are searched too. Related phrases (“epistemic trust”) and the keywords of those studies are offered for you to add.`),
      h("li", {}, h("strong", {}, "Translations. "), "Every English term is translated into 39 languages by Wikimedia's open machine translation (MinT), and each translation is translated back into English as a check: one that does not come back with the same meaning is left out."),
      h("li", {}, h("strong", {}, "The search. "), "All the terms become one Boolean query (OR within a keyword, AND between keywords), split into several queries when it is longer than a service takes. Studies come from OpenAlex; datasets from DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE.")),
    h("h3", {}, "Your Google Drive"),
    h("p", {}, "Connecting your Drive is optional. Research Finder asks Google only for access to the files it creates: it cannot see anything else in your Drive. Files are downloaded by your browser and go straight into your Drive. Some publishers and repositories (OSF, figshare) do not let browsers download files; those are listed with their download links."),
    h("h3", {}, "Privacy"),
    h("p", {}, "There is no server behind this site, no account and no tracking. Your searches go from your browser straight to the services above. See the ", h("a", { href: "privacy.html" }, "privacy policy"), "."),
    c.name ? h("h3", {}, "About the creator") : null,
    c.name ? h("p", {}, h("strong", {}, c.name), [c.role, c.affiliation].filter(Boolean).length ? `, ${[c.role, c.affiliation && `at the ${c.affiliation}`].filter(Boolean).join(" ")}.` : ".") : null,
    c.bio ? h("p", {}, c.bio) : null,
    c.email ? h("p", {}, "Questions, ideas or problems: write to ", h("a", { href: `mailto:${c.email}` }, c.email), ".") : null,
    h("p", {}, link("https://github.com/msiemiatkowski/research-finder", "Source code on GitHub"), " · ", h("a", { href: "privacy.html" }, "Privacy policy")));
}

/* ------------------------------------------------------------------ address bar */
function toHash() {
  const p = new URLSearchParams();
  const f = state.filters;
  if (state.input) p.set("q", state.input);
  if (state.tab !== "studies") p.set("in", state.tab);
  if (state.mode !== "all") p.set("match", state.mode);
  if (state.sort !== "rel") p.set("sort", state.sort);
  if (f.kinds.length) p.set("type", f.kinds.join(","));
  if (f.langs.length) p.set("lang", f.langs.join(","));
  if (f.repos.length) p.set("repos", f.repos.join(","));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.open) p.set("open", "1");
  if (f.fulltext) p.set("fulltext", "1");
  const s = p.toString();
  history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
}

function fromHash() {
  const raw = location.hash.slice(1);
  if (raw === "about") return raw;
  const p = new URLSearchParams(raw);
  const list = (k) => (p.get(k) || "").split(",").filter(Boolean);
  const f = state.filters;
  state.tab = SOURCES[p.get("in")] ? p.get("in") : "studies";
  state.mode = p.get("match") === "any" ? "any" : "all";
  state.sort = p.get("sort") || "rel";
  f.kinds = list("type");
  f.langs = list("lang");
  f.repos = list("repos");
  f.from = parseInt(p.get("from"), 10) || null;
  f.to = parseInt(p.get("to"), 10) || null;
  f.open = p.get("open") === "1";
  f.fulltext = p.get("fulltext") === "1";
  state.input = p.get("q") || "";
  return null;
}

function renderCredit() {
  const c = CONFIG.creator || {};
  if (!c.name) return;
  fill($("#foot-credit"), "Created by ", h("a", { href: "#about", onclick: (e) => { e.preventDefault(); renderAbout(); $("#about").hidden = false; $("#about").scrollIntoView({ behavior: "smooth", block: "start" }); } }, c.name),
    c.affiliation ? ` (${c.affiliation})` : "", c.email ? [" · ", h("a", { href: `mailto:${c.email}` }, c.email)] : null);
}

/* ------------------------------------------------------------------ start */
function start() {
  renderCredit();
  const panel = fromHash();
  renderTabs();
  renderFilters();
  if (state.input) setQuery(state.input);
  else search(0);
  if (panel) { renderAbout(); $("#about").hidden = false; }
}

onDriveChange((on) => {
  const b = $("#drive-btn");
  b.textContent = on ? "Drive connected" : "Connect Google Drive";
  b.classList.toggle("on", on);
});
$("#drive-btn").addEventListener("click", async () => {
  if (!driveConfigured() || driveConnected()) return openSettings();
  try { await connect(); toast("Google Drive connected"); } catch (e) { toast(e.message, 5000); }
});
$("#settings-btn").addEventListener("click", openSettings);
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); setQuery($("#q").value); });
document.querySelectorAll(".example").forEach((b) => b.addEventListener("click", () => setQuery(b.textContent)));
$("#more").addEventListener("click", showMore);
$("#about-link").addEventListener("click", (e) => { e.preventDefault(); renderAbout(); $("#about").hidden = false; $("#about").scrollIntoView({ behavior: "smooth", block: "start" }); });
document.querySelectorAll(".close-panel").forEach((b) => b.addEventListener("click", () => { $("#" + b.dataset.close).hidden = true; }));
$("#home-link").addEventListener("click", (e) => { e.preventDefault(); $("#about").hidden = true; state.filters = emptyFilters(); setQuery(""); });
$("#filters-toggle").addEventListener("click", () => {
  const box = $("#filters");
  box.classList.toggle("open");
  $("#filters-toggle").setAttribute("aria-expanded", String(box.classList.contains("open")));
});
start();
