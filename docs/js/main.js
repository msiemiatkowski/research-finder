/* Research Finder: the page. */
import { CONFIG } from "../config.js?v=39";
import { $, h, fill, fmt, plural, norm, escapeRe, NO_SPACES, safeUrl, local, toast, openalexJSON } from "./util.js?v=39";
import { LANGS, LANG_NAMES, SRC_LABEL, SAMPLE, parseInput, makeGroup, enrich, activeTerms, isTranslation, translateGroup, METHOD, METHOD_WORDS } from "./terms.js?v=39";
import { SOURCES, KIND_NAMES, REPO_NAMES, booleanQuery, repoQueries, maxParts, semanticScholarPdfs, pdfLinks, datasetFiles,
  relayAddress, needsRelay, relayed, checkRelay, CT_STATUS_NAMES, STATUS_LABEL, CT_TYPES, phaseText, REGIONAL_NAMES, regionalQueries } from "./sources.js?v=39";
import { translationsOn, languageOf, languageName, knownTitle, translateTitle, translateText, titleLanguage, englishTitle, englishTitles,
  SAVE_TRANSLATIONS } from "./translate.js?v=39";
import { driveConfigured, driveConnected, connect, disconnect, saveSearch, onDriveChange, listSaves, readSave, fillSave, addToSave, detailsText,
  RECORD } from "./drive.js?v=39";
import { DESIGN_NAMES, designsOf, designText, checksOn, checkUpdates, updatesOf, updatesText, SERIOUS, loadReplications, replicationsDate,
  replicationsOf, replicationText, replicationsCell, loadHijacked, hijackOf, journalText, hijackedDate } from "./checks.js?v=39";
import { openTools, prismaSvg, checkHtml, isMine, toggleMine, mineCount } from "./review.js?v=39";
import { coins, libraryLinks, library, resolverBase, proxyBase, bibtexOf, cslOf, openCite } from "./cite.js?v=39";
import { openZotero, keyForm } from "./zotero.js?v=39";

const LIVE_WAIT = 40000;          // longest wait for the wordings and translations before searching anyway
const PAGE_SIZE = { studies: 25, data: 8, trials: 25, regional: 10 };
const emptyFilters = () => ({ kinds: [], designs: [], langs: [], from: null, to: null, open: false, repos: [], fulltext: false,
  countries: [], south: false, status: [], results: false, ctype: [], measures: false, cites: "" });
const state = {
  input: "", groups: [], mode: "all", tab: "studies", sort: "rel",
  langsOff: new Set(local.get("langsOff", [])), filters: emptyFilters(), showAllLangs: false,
};
let results = [], total = 0, more = false, page = 1, notes = [], extra = {}, searchSeq = 0, highlight = null;
const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
/* What the list shows while a search is on its way: what is happening, and the shapes of the results to come. */
const waiting = (text) => [h("li", { class: "loading", role: "status" }, spinner(), text),
  ...[0, 1, 2].map(() => h("li", { class: "skeleton", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("i")))];

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
  slots.clear();
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
  fill($("#results"), waiting(`Searching ${src.note}…`));
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
  runChecks(fresh);
}

function emptyMessage() {
  const tips = [];
  if (state.groups.length > 1 && state.mode === "all") tips.push("Switch to “any keyword”.");
  const f = state.filters;
  if (f.kinds.length || f.langs.length || f.from || f.to || f.open || f.repos.length || f.countries.length || f.south || f.status.length || f.results || f.ctype.length) tips.push("Remove some filters.");
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
  fill($("#results"), waiting("Preparing the search: reading how studies word your keywords, and translating the terms into 39 languages…"));
}

/* Each keyword is looked up (Wikidata, the studies, the translations) before the search, so that it runs once with
   all the terms. */
async function setQuery(text, fromHistory = false) {
  const input = String(text || "").trim();
  if (!fromHistory && input !== state.input) pushNext = true;
  state.input = input;
  $("#q").value = state.input;
  $("#about").hidden = true;
  toHash();
  if (window.scrollY > 0) window.scrollTo(0, 0);
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

const MT_NOTE = "Made by Wikimedia's open machine translation (MinT). It can be wrong: read the original before you include or exclude a study.";

/* A title in another language, in English: [the translation], said to be an automatic one. */
function titleInEnglish(r, from) {
  const line = h("p", { class: "r-en" });
  const show = (t) => {
    if (!t || (t.ok && !t.text)) { line.remove(); return; }
    if (!t.ok) {
      fill(line, h("span", { class: "tr-none", title: "Translated back, the machine translation had almost nothing in common with the original title, so it is not shown." },
        `No reliable automatic translation of this ${languageName(from)} title`));
      return;
    }
    fill(line, h("span", { class: "tr-text", lang: "en" }, "[", marked(t.text, highlight), "]"), " ",
      h("span", { class: "tr-tag", title: `${MT_NOTE} It was checked by translating it back.` }, `Automatic translation from ${languageName(from)}, not a professional one`));
  };
  const known = knownTitle(from, r.title);
  if (known && known.ok && !known.text) return null;
  if (known) show(known);
  else {
    fill(line, h("span", { class: "tr-wait" }, "Translating the title into English…"));
    translateTitle(from, r.title).then(show);
  }
  return line;
}

/* A button that translates the whole abstract into English, and the box it shows the translation in. */
function englishAbstract(r, from) {
  const box = h("div", { class: "abstract-en", lang: "en", hidden: true });
  const button = h("button", { type: "button", class: "link-btn", "aria-expanded": "false" }, "English translation");
  button.addEventListener("click", async () => {
    if (!box.hidden) {
      box.hidden = true;
      button.textContent = "English translation";
      button.setAttribute("aria-expanded", "false");
      return;
    }
    if (!box.childElementCount) {
      button.disabled = true;
      button.textContent = "Translating…";
      const text = await translateText(from, r.full || r.abstract);
      button.disabled = false;
      if (!text) { button.textContent = "English translation"; toast("The translation service did not answer. Try again in a moment.", 4000); return; }
      fill(box, h("p", { class: "tr-tag", title: MT_NOTE }, `Automatic translation of the abstract from ${languageName(from)}, not a professional one`),
        h("p", {}, marked(text, highlight)));
    }
    box.hidden = false;
    button.textContent = "Hide the translation";
    button.setAttribute("aria-expanded", "true");
  });
  return { box, button };
}

/* The start of the abstract, the rest of it on request, and its English when it is in another language. */
function abstractOf(r) {
  if (!r.abstract) return null;
  const p = h("p", { class: "abstract" });
  const from = translationsOn() ? languageOf((r.full || r.abstract).slice(0, 600), r.lang) : "";
  const english = from ? englishAbstract(r, from) : null;
  const more = r.full && r.full.length >= r.abstract.length + 40
    ? h("button", { type: "button", class: "link-btn", "aria-expanded": "false" }, "Whole abstract") : null;
  let whole = false;
  const draw = () => fill(p, marked(whole ? r.full : r.abstract, highlight), more ? [" ", more] : null, english ? [" ", english.button] : null);
  if (more) {
    more.addEventListener("click", () => {
      whole = !whole;
      more.textContent = whole ? "Less" : "Whole abstract";
      more.setAttribute("aria-expanded", String(whole));
      draw();
    });
  }
  draw();
  return english ? [p, english.box] : p;
}

/* ------------------------------------------------------------------ checks on studies */
/* Where each study shown has its retraction badges and the lines under its byline, so that they can be drawn again when
   Crossref answers and the replication data arrives. */
const slots = new Map();
const DESIGN_NOTE = "Study design, tagged automatically by OpenAlex from the title and abstract. The tags are rarely wrong, but many studies have none.";
const dateText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");
const UPDATE_NOTE = "From Crossref's update notices, which include the Retraction Watch database, or else from OpenAlex.";

function drawChecks({ r, flags, box }) {
  const { list } = updatesOf(r);
  const tone = (n) => (SERIOUS.includes(n.kind) ? "flag-serious" : n.kind === "expression_of_concern" ? "flag-concern" : "flag-minor");
  const fake = hijackOf(r);
  fill(flags, fake ? h("span", { class: "badge flag flag-serious", title: "Its page is on the address of a hijacked journal (Retraction Watch Hijacked Journal Checker)" }, "Hijacked journal") : null,
    list.map((n) => h("span", { class: `badge flag ${tone(n)}`, title: UPDATE_NOTE }, n.label)));
  const lines = [];
  if (fake) {
    lines.push(h("p", { class: "r-update flag-serious" }, h("strong", {}, "Hijacked journal: "),
      `its page is on ${fake.host}, a fake copy of “${fake.original}” in Retraction Watch's Hijacked Journal Checker. A paper there was not published by the real journal`,
      fake.originalUrl ? [" (", link(fake.originalUrl, "the real journal"), ")"] : "", "."));
  }
  if (list.length) {
    lines.push(h("p", { class: `r-update ${tone(list[0])}` }, list.map((n, i) => [i ? " · " : "",
      h("strong", {}, n.label), n.date ? ` on ${dateText(n.date)}` : "",
      n.sources[0] === "OpenAlex" ? " according to OpenAlex" : ` (${n.sources.join(", ")})`,
      n.notice ? [": ", link(`https://doi.org/${n.notice}`, "the notice")] : ""]), "."));
  }
  const reps = replicationsOf(r);
  if (reps) lines.push(replicationBox(reps));
  fill(box, lines);
}

/* The replications and reproductions FReD records for a study, folded until opened. */
function replicationBox(list) {
  return h("details", { class: "r-repl" },
    h("summary", {}, h("strong", {}, replicationText(list)), " in the FORRT Replication Database"),
    h("ul", {}, list.map((x) => h("li", {}, h("span", { class: `oc oc-${x.code}` }, x.outcome), ` · ${x.year || "n.d."} · `, link(x.link, x.title || x.link)))),
    h("p", { class: "note" }, "Outcomes as FReD records them. Data: ", link("https://forrt.org/replication-hub/", "FORRT Replication Database"),
      ` (CC BY 4.0), as of ${dateText(replicationsDate())}. A study it does not list may still have been replicated.`));
}

/* Asks Crossref about the studies just shown and loads the replication data, then draws what they say. */
async function runChecks(records) {
  if (state.tab !== "studies" || !records.length) return;
  const redraw = () => records.forEach((r) => { const s = slots.get(r.key); if (s) drawChecks(s); });
  await Promise.allSettled([loadReplications().then(redraw), checksOn() ? checkUpdates(records.map((r) => r.doi)).then(redraw) : null,
    checksOn() ? loadHijacked().then(redraw) : null]);
}

/* Before an export or a save: every study checked (Crossref and FReD), with progress for a large save. */
async function checkAll(records, progress) {
  if (state.tab !== "studies") return;
  await loadReplications();
  if (checksOn()) {
    await loadHijacked();
    await checkUpdates(records.map((r) => r.doi), progress ? (n, of) => progress(`Checking for retractions and corrections: ${fmt(n)} of ${fmt(of)} studies…`) : null);
  }
}

function renderRecord(r) {
  const href = r.doi ? `https://doi.org/${r.doi}` : safeUrl(r.url) || safeUrl(r.pdf);
  const lang = r.lang && r.lang !== "en" ? languageName(r.lang) : "";
  const from = translationsOn() ? titleLanguage(r) : "";
  const studies = state.tab === "studies";
  const flags = h("span", { class: "r-flags" }), box = h("div", { class: "r-checks" });
  const li = h("li", { class: "result" },
    h("div", { class: "r-top" },
      flags,
      h("span", { class: `badge kind-${r.kind}` }, KIND_NAMES[r.kind] || "Record"),
      designsOf(r).map((d) => h("span", { class: "badge design", title: DESIGN_NOTE }, DESIGN_NAMES[d])),
      r.year ? h("span", {}, r.year) : null,
      lang ? h("span", { class: "badge" }, lang) : null,
      r.kind === "r" && r.status ? h("span", { class: `badge status st-${r.status.toLowerCase()}`, title: "Status of the study, as registered" }, STATUS_LABEL[r.status] || r.status) : null,
      r.kind === "r" && phaseText(r) ? h("span", { class: "badge" }, phaseText(r)) : null,
      r.kind === "r" && r.results ? h("span", { class: "badge open", title: "Results are posted in the registry" }, "Results posted") : null,
      r.kind === "r" && r.enrollment ? h("span", { title: "Participants, as registered" }, `${fmt(r.enrollment)} participants`) : null,
      r.open && r.kind !== "r" ? h("span", { class: "badge open", title: "Free to read or download" }, "Open") : null,
      r.doaj && r.issn && r.source !== "DOAJ" ? h("a", { class: "badge doaj", href: `https://doaj.org/toc/${encodeURIComponent(r.issn)}`, target: "_blank", rel: "noopener noreferrer",
        title: "The journal is in the Directory of Open Access Journals, which lists open-access journals that meet its standards. Click for its fees, licence and peer review." }, "DOAJ") : null,
      r.cited ? h("span", { title: "Times cited" }, `${fmt(r.cited)} citations`) : null,
      r.files && r.files.length ? h("span", { title: "Open data files" }, plural(r.files.length, "file")) : null,
      h("span", { class: "src" }, r.source)),
    h("h3", { lang: from || null }, href ? link(href, marked(r.title, highlight)) : h("span", {}, marked(r.title, highlight))),
    from ? titleInEnglish(r, from) : null,
    [r.authors, r.venue].filter(Boolean).length ? h("div", { class: "byline" }, [r.authors, r.venue].filter(Boolean).join(" · ")) : null,
    box,
    abstractOf(r));
  if (studies) {
    const slot = { r, flags, box };
    slots.set(r.key, slot);
    drawChecks(slot);
  }
  if (r.keywords && r.keywords.length) {
    li.append(h("div", { class: "r-kw" }, r.keywords.map((k) => h("button", { type: "button", title: `Search for “${k}”`, onclick: () => setQuery(k) }, k))));
  }
  const links = [];
  if (r.doi) links.push(link(`https://doi.org/${r.doi}`, r.kind === "d" ? "Dataset page" : "DOI"));
  if (safeUrl(r.url)) links.push(link(safeUrl(r.url), r.kind === "r" ? "Registry record" : r.doi ? "Record page" : "Open record"));
  if (safeUrl(r.pdf)) links.push(link(safeUrl(r.pdf), "Open PDF"));
  if (r.kind === "r" && r.pmids && r.pmids.length) {
    links.push(link(`https://pubmed.ncbi.nlm.nih.gov/?term=${r.pmids.slice(0, 50).join("+OR+")}`, `${plural(r.pmids.length, "publication")} in PubMed`, "Publications the registration lists with its results"));
  }
  if (studies) for (const t of trialIds(r)) links.push(link(t.href, t.id, "The registration this study gives in its abstract"));
  if (studies) for (const l of libraryLinks(r)) links.push(link(l.href, l.text, l.title));
  links.push(h("button", { type: "button", class: "link-btn", title: "Its reference in APA or another style, or as a file for a reference manager", onclick: () => openCite([r], toolsCtx) }, "Cite"));
  if (studies && r.oa) links.push(mineButton(r));
  li.append(h("div", { class: "r-links" }, links), coins(r));
  return li;
}

/* Trial registration numbers a study gives in its abstract (ClinicalTrials.gov, ISRCTN), linked to the registry. */
function trialIds(r) {
  const text = `${r.full || r.abstract || ""}`;
  const out = new Map();
  for (const m of text.matchAll(/\bNCT\s?(\d{8})\b/g)) out.set(`NCT${m[1]}`, `https://clinicaltrials.gov/study/NCT${m[1]}`);
  for (const m of text.matchAll(/\bISRCTN\s?(\d{8})\b/g)) out.set(`ISRCTN${m[1]}`, `https://www.isrctn.com/ISRCTN${m[1]}`);
  return [...out].slice(0, 3).map(([id, href]) => ({ id: `Registered as ${id}`, href }));
}

/* Adds a study to "your studies", the list the review tools start from, or takes it out. */
function mineButton(r) {
  const b = h("button", { type: "button", class: "link-btn mine" });
  const draw = () => {
    const on = isMine(r);
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "★ In your studies" : "☆ Add to your studies";
    b.title = on ? "Take it out of your studies" : "Add it to your studies: the list that Review tools check your search against, search the citations of and find similar studies to";
  };
  b.addEventListener("click", () => { toast(toggleMine(r) ? "Added to your studies (Review tools › Your studies)" : "Taken out of your studies"); draw(); renderToolbar(); });
  draw();
  return b;
}

function renderToolbar(status) {
  const bar = $("#toolbar");
  bar.hidden = false;
  const src = SOURCES[state.tab];
  const split = extra.parts > 1;
  const data = state.tab === "data", studiesTab = state.tab === "studies", trialsTab = state.tab === "trials";
  const under = status ? null
    : (data || state.tab === "regional") && extra.totals ? h("small", {}, Object.entries(extra.totals).map(([n, c]) => `${n} ${fmt(c)}`).join(" · "))
      : trialsTab ? h("small", {}, "English terms only: registrations are written in English")
        : split ? h("small", { title: `The terms did not fit in one OpenAlex search (1,500 characters), so Research Finder made ${extra.parts} searches and put their results together. The total counts a study found by two of them twice.` },
          `from ${extra.parts} searches put together: the terms do not fit in one`) : null;
  fill(bar,
    h("div", { class: "tb-main" },
      h("p", { class: "count" }, status || `${split ? "About " : ""}${plural(total, ...src.noun)}`, under),
      results.length ? h("button", { type: "button", class: "btn btn-primary tb-save", onclick: openSave, title: "Save the results, open PDFs and data files to your Google Drive" }, "Save to Google Drive") : null),
    h("div", { class: "tb-tools" },
      h("select", { "aria-label": "Sort", onchange: (e) => { state.sort = e.target.value; search(0); } },
        src.sorts.map(([v, l]) => h("option", { value: v, selected: state.sort === v }, l))),
      h("button", { type: "button", class: "btn btn-small", onclick: copySearchString, title: "Copy the terms as a Boolean search string" }, "Copy search string"),
      externalMenu(),
      results.length ? menu("Export ▾", [
        ["Spreadsheet (CSV)", exportCsv],
        ["References (RIS) for Zotero, EndNote, Rayyan, Covidence or ASReview", exportRis],
        ["BibTeX for LaTeX, Overleaf or JabRef", () => exportRefs("bib")],
        ["CSL-JSON for Zotero, Pandoc or citation processors", () => exportRefs("csl")],
        ["Formatted references, in APA or another style", () => openCite(results, toolsCtx)],
        ["Send to Zotero (with your own Zotero key)", () => toolsCtx.exportRecords(results, { format: "zotero" })],
        ["PRISMA 2020 flow diagram (SVG), with the numbers of this search", exportPrisma],
      ], "Download the results shown, with their abstracts") : null,
      results.length && studiesTab ? h("button", { type: "button", class: "btn btn-small", onclick: openOverview, title: "Years, types, languages, the authors' countries and journals of all the results" }, "Overview") : null,
      results.length && studiesTab ? menu("Review tools ▾", [
        ["Check your search against studies it should find", () => openTools("check", toolsCtx)],
        ["Citation search from your studies", () => openTools("chase", toolsCtx)],
        ["More like these: studies similar to yours", () => openTools("similar", toolsCtx)],
        ["What your results cite most", () => openTools("cited", toolsCtx)],
        [`Your studies (${fmt(mineCount())}): see, cite or export them`, () => openTools("mine", toolsCtx)],
      ], "Check the search, search citations, find similar studies and key studies the search misses") : null));
  const settings = (label) => h("button", { type: "button", class: "btn btn-small", onclick: openSettings }, label);
  const msgs = notes.map((text) => ({ text, warn: true }));
  if (extra.dropped && studiesTab) {
    const key = local.get("openalexKey", "");
    msgs.push({
      text: `A long search: ${plural(extra.dropped, "term")} did not fit and ${extra.dropped === 1 ? "was" : "were"} left out. English terms and the languages with the most research come first. `
        + (key ? "Fewer languages make room for the ones you need." : "A free OpenAlex key makes room for more of them."),
      actions: [key ? null : settings("Add a key"), settings("Choose languages")],
    });
  } else if (extra.dropped) {
    msgs.push({ text: `${plural(extra.dropped, "term")} left out: the query would be too long for ${trialsTab ? "ClinicalTrials.gov" : state.tab === "regional" ? "these databases (each takes the terms in its own languages)" : "the repositories"}. The English terms and the languages with the most research come first.` });
  }
  if (msgs.length) {
    bar.append(h("div", { class: "toolbar-notes" }, msgs.map((m) => h("div", { class: `callout${m.warn ? " warn" : ""}` },
      h("p", {}, m.text), m.actions ? h("div", { class: "callout-actions" }, m.actions) : null))));
  }
}

function searchString(englishOnly = false, maxLen = 100000) {
  const groups = state.groups.map((g) => activeTerms(g, state.langsOff).filter((t) => !englishOnly || !isTranslation(t)));
  return booleanQuery(groups.filter((ts) => ts.length), state.mode, maxLen).query;
}

async function copySearchString() {
  const s = searchString();
  try { await navigator.clipboard.writeText(s); toast("Search string copied"); } catch { window.prompt("Copy the search string:", s); }
}

/* A small menu of links ([label, address]) and actions ([label, function]). */
function menu(label, entries, title) {
  const list = h("div", { class: "menu-list", hidden: true });
  for (const [text, go] of entries) list.append(typeof go === "function" ? h("button", { type: "button", onclick: go }, text) : link(go, text));
  return h("div", { class: "menu" }, h("button", {
    type: "button", class: "btn btn-small", "aria-haspopup": "true", title,
    onclick: (e) => { e.stopPropagation(); list.hidden = !list.hidden; if (!list.hidden) document.addEventListener("click", () => { list.hidden = true; }, { once: true }); },
  }, label), list);
}

const externalMenu = () => menu("Search elsewhere ▾", [
  ["Google Scholar (English terms)", `https://scholar.google.com/scholar?q=${encodeURIComponent(searchString(true, 250))}`],
  ["PubMed (English terms)", `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(searchString(true))}`],
  ["BASE (all terms)", `https://www.base-search.net/Search/Results?lookfor=${encodeURIComponent(searchString(false, 4000))}&type=all`],
  ["OpenAlex (English terms)", `https://openalex.org/works?search=${encodeURIComponent(searchString(true, 900))}`],
  ["ClinicalTrials.gov (English terms)", `https://clinicaltrials.gov/search?term=${encodeURIComponent(searchString(true, 1800))}`],
  ["WHO trials registry portal (ICTRP)", "https://trialsearch.who.int/"],
]);

/* One row per result, the same columns for every source; while translations are on, a title in another language has
   its English next to it; studies have their design, retraction or corrections, and replications after their type. */
const EN_TITLE = "Title in English (automatic translation)";
const COLUMNS = ["No.", "Title", "Abstract", "Authors", "Year", "Type", "Journal or repository", "DOI", "Link", "Open PDF", "Language", "Keywords", "Source", "Citations", "License", "Size"];
const CHECK_COLUMNS = ["Study design (automatic tag)", "Retraction or correction", "Replications (FReD)", "Journal (DOAJ, hijacked journals)"];
const TRIAL_COLUMNS = ["Status", "Phase", "Study type", "Results posted", "Participants", "Start", "Completion", "Conditions", "Interventions", "Countries", "Publications (PMIDs)", "Other IDs"];
function header(en, checks, tab = state.tab) {
  const row = [...COLUMNS];
  if (tab === "trials") row.splice(6, 0, ...TRIAL_COLUMNS);
  else if (checks) row.splice(6, 0, ...CHECK_COLUMNS);
  if (en) row.splice(2, 0, EN_TITLE);
  return row;
}
const trialCells = (r) => [STATUS_LABEL[r.status] || r.status || "", phaseText(r), CT_TYPES[r.studyType] || r.studyType || "", r.results ? "yes" : "no",
  r.enrollment || "", r.date || "", r.completion || "", (r.conditions || []).join("; "), (r.interventions || []).join("; "), (r.countries || []).join("; "),
  (r.pmids || []).join("; "), (r.otherIds || []).join("; ")];
/* "Status: Completed; Study type: Interventional; Results posted: yes; Participants: 555; Start: 2007-12" */
const trialSummary = (r) => TRIAL_COLUMNS.slice(0, 7).map((name, i) => [name, trialCells(r)[i]]).filter(([, v]) => v !== "" && v != null).map(([name, v]) => `${name}: ${v}`).join("; ");
function rowOf(r, i, en, checks, tab = state.tab) {
  const row = [i + 1, r.title, r.full || r.abstract || "", r.authors, r.year || "", KIND_NAMES[r.kind] || "", r.venue, r.doi ? `https://doi.org/${r.doi}` : "",
    r.url || r.landing || "", r.pdf, r.lang, (r.keywords || []).join("; "), r.source, r.cited || "", r.license || "", r.size || ""];
  if (tab === "trials") row.splice(6, 0, ...trialCells(r));
  else if (checks) row.splice(6, 0, designText(r), updatesText(r), replicationsCell(r), journalText(r));
  if (en) row.splice(2, 0, englishTitle(r));
  return row;
}

/* The same results as a RIS file, which reference managers (Zotero, EndNote, Mendeley) and screening tools (Rayyan,
   Covidence, ASReview) import. */
const RIS_TYPES = { article: "JOUR", review: "JOUR", editorial: "JOUR", letter: "JOUR", preprint: "UNPB", book: "BOOK", monograph: "BOOK",
  "book-chapter": "CHAP", dissertation: "THES", dataset: "DATA" };
function risOf(records, en = translationsOn(), checks = state.tab === "studies") {
  const tag = (t, v) => (v == null || v === "" ? "" : `${t}  - ${String(v).replace(/\s+/g, " ").trim()}\r\n`);
  // the English of a title goes into a note that says what it is (Zotero would file a "translated title" unlabelled)
  const english = (r) => { const t = en ? englishTitle(r) : ""; return t ? `Title in English, an automatic translation (Wikimedia MinT), not a professional one: ${t}` : ""; };
  const note = (label, text) => (checks && text ? `${label}: ${text}` : "");
  return records.map((r) => [
    tag("TY", r.kind === "d" ? "DATA" : RIS_TYPES[r.type] || "GEN"),
    tag("TI", r.title),
    ...(r.people || []).map((p) => tag("AU", p)),
    r.org && !(r.people || []).length ? tag("AU", r.org) : "",
    tag("PY", r.year || ""),
    tag("DA", (r.date || "").slice(0, 10).replace(/-/g, "/")),
    tag(r.kind === "d" ? "PB" : "T2", r.venue),
    tag("VL", r.volume),
    tag("IS", r.issue),
    tag("SP", r.fpage),
    tag("EP", r.lpage),
    tag("SN", r.issn),
    r.kind === "d" ? "" : tag("PB", r.publisher),
    tag("AB", r.full || r.abstract),
    ...(r.keywords || []).map((k) => tag("KW", k)),
    tag("DO", r.doi),
    tag("UR", r.doi ? `https://doi.org/${r.doi}` : safeUrl(r.url || r.landing)),
    tag("LA", r.lang === "en" ? "English" : LANG_NAMES[r.lang] || r.lang),
    tag("DB", r.source),
    tag("AN", r.nct),
    tag("N1", r.kind === "r" ? `Registered study: ${trialSummary(r)}` : ""),
    tag("N1", english(r)),
    tag("N1", note("Retraction or correction (Crossref, Retraction Watch)", updatesText(r))),
    tag("N1", note("Study design, tagged automatically by OpenAlex", designText(r))),
    tag("N1", note("Replications in the FORRT Replication Database (FReD)", replicationsCell(r))),
    tag("N1", hijackOf(r) ? note("Journal warning", journalText(r)) : ""),
    "ER  - \r\n",
  ].join("")).join("\r\n");
}

/* The results as a file for reference managers: RIS, BibTeX or CSL-JSON, with the same notes (an English title, a
   retraction or correction). */
const REF_FILES = { ris: ["ris", "application/x-research-info-systems"], bib: ["bib", "application/x-bibtex"], csl: ["json", "application/vnd.citationstyles.csl+json"] };
/* Notes that go with a reference: its English title, a retraction or correction, a hijacked journal, a registration's status. */
const refNotes = (en, checks) => (r) => [en && englishTitle(r) ? `Title in English, an automatic translation (Wikimedia MinT), not a professional one: ${englishTitle(r)}` : "",
  checks && updatesText(r) ? `Retraction or correction (Crossref, Retraction Watch): ${updatesText(r)}` : "",
  checks && hijackOf(r) ? `Journal warning: ${journalText(r)}` : "",
  r.kind === "r" ? `Registered study (${STATUS_LABEL[r.status] || r.status || "status not given"})` : ""].filter(Boolean);
function refsText(records, format, en = translationsOn(), checks = state.tab === "studies") {
  if (format === "ris") return risOf(records, en, checks);
  const notes = refNotes(en, checks);
  if (format === "bib") return bibtexOf(records, { notes, language: (r) => (r.lang === "en" ? "English" : LANG_NAMES[r.lang] || r.lang || "") });
  return cslOf(records, { notes });
}
async function exportRefs(format) {
  await englishFirst(results);
  await checksFirst(results);
  const [ext, type] = REF_FILES[format];
  downloadFile(`research-finder-${fileDate()}.${ext}`, refsText(results, format), type);
}

function downloadFile(name, text, type, message) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(message || `Exported ${plural(results.length, "result")}${more ? ", the ones loaded so far (Save to Google Drive can save all of them)" : ""}`, 4000);
}
const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const fileDate = () => new Date().toISOString().slice(0, 10);

/* Before an export, the English of the titles in other languages among the results shown (most are translated already). */
async function englishFirst(records) {
  if (!translationsOn()) return;
  const slow = setTimeout(() => toast("Translating the titles in other languages into English…", 10000), 500);
  try { await englishTitles(records); } finally { clearTimeout(slow); }
}

/* Before an export: the studies shown checked with Crossref and FReD (most are by now). */
async function checksFirst(records) {
  const slow = setTimeout(() => toast("Checking for retractions and corrections…", 10000), 500);
  try { await checkAll(records); } finally { clearTimeout(slow); }
}

async function exportCsv() {
  await englishFirst(results);
  await checksFirst(results);
  const en = translationsOn() && state.tab !== "trials", checks = state.tab === "studies";
  const cell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header(en, checks), ...results.map((r, i) => rowOf(r, i, en, checks))].map((r) => r.map(cell).join(",")).join("\r\n");
  downloadFile(`research-finder-${fileDate()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
}
/* ------------------------------------------------------------------ review tools and the flow diagram */
/* What the review tools found in this visit, each with the search it belongs to (for "Search details"). */
const review = {};
const searchSignature = () => `${state.tab}|${state.mode}|${JSON.stringify(state.filters)}|${state.tab === "studies" ? SOURCES.studies.queries(query()).parts.join(" || ") : ""}`;

const toolsCtx = {
  query, link, results: () => results,
  remember(kind, res) { review[kind] = { ...res, signature: searchSignature() }; },
  async exportRecords(records, { extraName, extraOf, name, format }) {
    await englishFirst(records);
    await checksFirst(records);
    const en = translationsOn(), message = `Exported ${state.tab === "data" ? plural(records.length, "dataset") : plural(records.length, "study", "studies")}`;
    if (format === "zotero") {
      const what = { "citation-search": "Citation search", "similar-studies": "Similar studies", "your-studies": "Your studies", "cited-by-results": "Cited by the results" }[name];
      openZotero(records, { name: `${what ? `${what}: ` : ""}${state.input || "Research Finder"} — ${fileDate()}`, notes: refNotes(en, state.tab === "studies") });
      return;
    }
    if (REF_FILES[format]) {
      const [ext, type] = REF_FILES[format];
      downloadFile(`${name}-${fileDate()}.${ext}`, refsText(records, format, en, true), type, message);
      return;
    }
    const rows = [[...header(en, true), extraName], ...records.map((r, i) => [...rowOf(r, i, en, true), extraOf(r)])];
    downloadFile(`${name}-${fileDate()}.csv`, "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8", message);
  },
  async saveRecords({ title, records, extraName, extraOf, details, progress }) {
    if (!driveConfigured()) throw new Error("saving to Google Drive is not set up on this copy of the site");
    if (!driveConnected()) { progress("Connecting to Google Drive…"); await connect(); }
    const english = translationsOn()
      ? await englishTitles(records, { onProgress: (n, of) => progress(`Translating the titles in other languages into English: ${fmt(n)} of ${fmt(of)}…`) }) : null;
    await checkAll(records, progress);
    const en = Boolean(english);
    return saveSearch({
      title: `${title} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      header: [...header(en, true), extraName], rows: records.map((r, i) => [...rowOf(r, i, en, true), extraOf(r)]),
      ris: risOf(records, en, true), jobs: [], maxFile: 0, maxTotal: 0, onProgress: progress,
      detailsHtml: () => details(checksHtml(checkStats(records))), onSignIn: () => connect(),
    });
  },
};

/* The numbers of the PRISMA 2020 flow diagram that this search gives: the records each source found, the duplicates
   removed within the search when all of them were saved, and the citation search of this visit. Nothing is guessed. */
function prismaCounts(nRows = null, savedAll = false, gotNotes = []) {
  const studies = state.tab === "studies", trials = state.tab === "trials";
  const complete = savedAll && nRows != null && !gotNotes.length;
  return {
    date: new Date().toISOString().slice(0, 10),
    databases: studies ? [["OpenAlex", total]] : trials ? [] : Object.entries(extra.totals || {}),
    registers: trials ? total : null, duplicates: complete ? Math.max(0, total - nRows) : null, otherRemoved: null, screened: null,
    citation: review.chase ? review.chase.records.length : null,
  };
}
function exportPrisma() {
  downloadFile(`prisma-flow-diagram-${fileDate()}.svg`, prismaSvg(prismaCounts()), "image/svg+xml",
    "Flow diagram downloaded: the records this search found are filled in; fill in the rest after screening.");
}

async function exportRis() {
  await englishFirst(results);
  await checksFirst(results);
  downloadFile(`research-finder-${fileDate()}.ris`, risOf(results), "application/x-research-info-systems");
}

/* ------------------------------------------------------------------ versions of a questionnaire */
/* A scale's name (and its acronym) with the method words of validation and adaptation, translated into 39 languages;
   optionally only the studies that cite the scale's original paper. */
function citesName(w) {
  const t = (local.get("citesTitles", {}) || {})[w];
  return t ? `“${t}”` : `the work ${w}`;
}

function openFinder() {
  const d = $("#tools");
  fill($("#tools-title"), "Versions of a questionnaire");
  const field = (id, label, placeholder) => {
    const input = h("input", { type: "text", id, placeholder, spellcheck: "false", autocomplete: "off", class: "finder-input" });
    return [h("label", { for: id, class: "tools-label" }, label), input];
  };
  const [nameLabel, name] = field("finder-name", "Name of the questionnaire or scale", "Rosenberg Self-Esteem Scale");
  const [acroLabel, acro] = field("finder-acronym", "Its acronym (optional)", "RSES");
  const [doiLabel, doi] = field("finder-doi", "DOI of the original paper (optional)", "10.1515/9781400876136");
  const citing = h("input", { type: "checkbox" });
  const out = h("div", { class: "tools-out", role: "status", "aria-live": "polite" });
  const go = h("button", { type: "button", class: "btn btn-primary" }, "Find its versions");
  const run = async () => {
    const n = name.value.replace(/[,;|]/g, " ").replace(/\s+/g, " ").trim();
    if (!n) { fill(out, h("p", { class: "note warn" }, "Type the name of the questionnaire or scale.")); return; }
    const a = acro.value.replace(/[,;|]/g, " ").replace(/\s+/g, " ").trim();
    const m = /(10\.\d{4,9}\/[^\s"<>]+)/.exec(doi.value || "");
    let cites = "";
    if (m) {
      go.disabled = true;
      fill(out, h("p", { class: "note pending" }, spinner(), " Looking up the original paper in OpenAlex…"));
      try {
        const key = local.get("openalexKey", "");
        const w = await openalexJSON(`https://api.openalex.org/works/doi:${encodeURIComponent(m[1].replace(/[.,;)]+$/, ""))}?select=id,display_name,publication_year${key ? `&api_key=${encodeURIComponent(key)}` : ""}`, { timeout: 30000 });
        cites = String(w.id || "").split("/").pop();
        local.set("citesTitles", { ...(local.get("citesTitles", {}) || {}), [cites]: `${w.display_name}${w.publication_year ? ` (${w.publication_year})` : ""}` });
      } catch (e) {
        fill(out, h("p", { class: "note warn" }, `OpenAlex does not know this DOI (${e.message}): the search runs without it.`));
      } finally {
        go.disabled = false;
      }
    }
    state.tab = "studies";
    state.sort = "rel";
    state.filters = emptyFilters();
    if (cites && citing.checked) state.filters.cites = cites;
    renderTabs();
    renderFilters();
    d.close();
    setQuery(`${n}${a ? ` | ${a}` : ""}, ${METHOD}`);
  };
  go.addEventListener("click", run);
  [name, acro, doi].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); }));
  fill($("#tools-body"),
    h("p", {}, "Finds the studies that validate, adapt or translate a questionnaire or scale, in any language: its name, and its acronym as it is, with method words such as “validation”, “adaptation”, “psychometric properties” or “factor structure”, each translated into 39 languages."),
    nameLabel, name, acroLabel, acro, doiLabel, doi,
    h("label", { class: "f-option" }, citing, "Only studies that cite the original paper"),
    h("p", { class: "note" }, "Most versions cite the original, but OpenAlex links the references of many studies, not all, so that filter can leave some out. Afterwards, “Overview” shows the versions by language and country, and the tab “Regional databases” runs the same terms in LA Referencia, DOAJ and CiNii. The method words are machine translations, checked by translating them back: switch off any that do not fit."),
    h("div", { class: "save-actions" }, go), out);
  if (!d.open) d.showModal();
  name.focus();
}

/* ------------------------------------------------------------------ overview */
/* Who and what all the results are, counted by OpenAlex (one request per part of the search); a bar adds its filter. */
const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
function countryName(code) { try { return (regionNames && regionNames.of(code)) || code; } catch { return code; } }
const TYPE_KIND = { article: "a", preprint: "p", review: "v", book: "b", "book-chapter": "b", dataset: "d", dissertation: "t" };
const overviews = new Map();        // a search's signature -> its overview
const OV_SOUTH = "authorships.institutions.is_global_south";

async function openOverview() {
  const d = $("#tools");
  fill($("#tools-title"), "Overview of the results");
  const sig = searchSignature(), parts = SOURCES.studies.queries(query()).parts.length;
  const out = h("div", { class: "tools-out", role: "status", "aria-live": "polite" });
  fill($("#tools-body"), out);
  if (!d.open) d.showModal();
  let ov = overviews.get(sig);
  if (!ov) {
    const key = Boolean(local.get("openalexKey", ""));
    fill(out, h("p", { class: "note pending" }, spinner(), ` Counting all ${fmt(total)} results with OpenAlex (${plural(parts, "search", "searches")}${key ? "" : "; OpenAlex allows about 100 a day without a key"})…`));
    try {
      ov = { ...(await SOURCES.studies.overview(query())), parts, date: new Date().toISOString().slice(0, 10) };
    } catch (e) {
      fill(out, h("p", { class: "note warn" }, `The overview could not be made: ${e.message}`));
      return;
    }
    overviews.set(sig, ov);
    review.overview = { ...ov, signature: sig };
  }
  fill(out, overviewView(ov, () => d.close()));
}

function overviewView(ov, close) {
  const f = state.filters;
  const n = Math.max(1, ov.count);
  const pct = (x) => `${Math.round((100 * x) / n)}%`;
  const apply = (fn) => () => { fn(); close(); search(0); };
  const bars = (items, { label = (x) => x.name, onPick = null, max = 12 } = {}) => {
    const top = items.slice(0, max), most = Math.max(1, ...top.map((x) => x.n));
    return h("ul", { class: "ov-bars" }, top.map((x) => {
      const pick = onPick && onPick(x);
      const row = [h("span", { class: "ov-label" }, label(x)), h("span", { class: "ov-bar" }, h("i", { style: `width:${Math.max(1, (100 * x.n) / most)}%` })),
        h("span", { class: "ov-n" }, `${fmt(x.n)} · ${pct(x.n)}`)];
      return h("li", {}, pick ? h("button", { type: "button", title: pick.title, onclick: apply(pick.go) }, row) : h("div", {}, row));
    }));
  };
  const years = ov.dims.publication_year.filter((x) => /^\d{4}$/.test(x.key)).map((x) => ({ ...x, y: Number(x.key) })).sort((a, b) => a.y - b.y);
  const recent = years.filter((x) => x.y >= Math.max(...years.map((y) => y.y)) - 39);
  const most = Math.max(1, ...recent.map((x) => x.n));
  const south = (ov.dims[OV_SOUTH].find((x) => x.key === "true") || { n: 0 }).n;
  const open = (ov.dims["open_access.is_oa"].find((x) => x.key === "true") || { n: 0 }).n;
  const csv = () => {
    const rows = [["Counted", "Key", "Name", "Results"]];
    for (const [dim, items] of Object.entries(ov.dims)) for (const x of items) rows.push([dim, x.key, x.name, x.n]);
    downloadFile(`overview-${fileDate()}.csv`, "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8", "Overview downloaded");
  };
  return [
    h("p", { class: "tools-head" }, h("strong", {}, `${fmt(ov.count)} results`), ov.parts > 1 ? ` from ${ov.parts} searches put together (a study two of them find counts twice)` : "",
      ", counted by OpenAlex. Choose a bar to filter the results by it."),
    h("div", { class: "tools-actions" }, h("button", { type: "button", class: "btn btn-small", onclick: csv }, "Download (CSV)")),
    h("h3", {}, "Year"),
    h("div", { class: "ov-years", role: "list" }, recent.map((x) => h("button", { type: "button", role: "listitem", class: "ov-year", title: `${x.y}: ${fmt(x.n)} results. Choose it to see only that year.`,
      "aria-label": `${x.y}: ${fmt(x.n)} results`, onclick: apply(() => { f.from = x.y; f.to = x.y; }) }, h("i", { style: `height:${Math.max(2, (100 * x.n) / most)}%` })))),
    recent.length ? h("p", { class: "ov-axis" }, h("span", {}, recent[0].y), h("span", {}, recent[recent.length - 1].y)) : null,
    years.length > recent.length ? h("p", { class: "note" }, `And ${fmt(years.filter((x) => x.y < recent[0].y).reduce((a, x) => a + x.n, 0))} results from before ${recent[0].y}.`) : null,
    h("h3", {}, "Where the authors are"),
    h("p", {}, h("button", { type: "button", class: "link-btn", onclick: apply(() => { f.south = true; }) }, `${fmt(south)} results (${pct(south)})`),
      " have at least one author at an institution in the Global South, as OpenAlex marks institutions."),
    bars(ov.dims["authorships.countries"], { max: 15, onPick: (x) => ({ title: `Only studies with an author in ${x.name}`, go: () => { f.countries = [x.key.toUpperCase()]; } }) }),
    h("p", { class: "note" }, "A study counts once for each country where one of its authors works, so the numbers add up to more than the results. These are the authors' institutions, not the samples studied, and OpenAlex knows them for most studies, not all."),
    h("h3", {}, "Language"),
    bars(ov.dims.language, { max: 10, onPick: (x) => (x.key === "en" || LANGS.includes(x.key) ? { title: `Only studies in ${x.name}`, go: () => { f.langs = [x.key]; } } : null) }),
    h("p", { class: "note" }, "OpenAlex's own labels, which count some studies in other languages as English."),
    h("h3", {}, "Type"),
    bars(ov.dims.type, { max: 10, label: (x) => x.name.replace(/-/g, " "), onPick: (x) => (TYPE_KIND[x.key] ? { title: `Only ${x.name}s`, go: () => { f.kinds = [TYPE_KIND[x.key]]; } } : null) }),
    h("h3", {}, "Open access"),
    h("p", {}, h("button", { type: "button", class: "link-btn", onclick: apply(() => { f.open = true; }) }, `${fmt(open)} results (${pct(open)})`), " are free to read."),
    h("h3", {}, "Journals and repositories"),
    bars(ov.dims["primary_location.source.id"], { max: 12 }),
  ];
}

/* For "Search details": the overview made in this visit. */
function overviewHtml(ov) {
  const pct = (x) => `${Math.round((100 * x) / Math.max(1, ov.count))}%`;
  const top = (dim, k) => ov.dims[dim].slice(0, k).map((x) => `${esc(x.name)} ${fmt(x.n)} (${pct(x.n)})`).join("; ");
  const south = (ov.dims[OV_SOUTH].find((x) => x.key === "true") || { n: 0 }).n;
  const open = (ov.dims["open_access.is_oa"].find((x) => x.key === "true") || { n: 0 }).n;
  const years = ov.dims.publication_year.map((x) => Number(x.key)).filter((y) => y > 1000);
  return `<h2>Overview of the results</h2>
<p>Counted by OpenAlex on ${esc(dateText(ov.date))} for all ${fmt(ov.count)} results${ov.parts > 1 ? " (a study found by two of the searches counts twice)" : ""}${years.length ? `, published from ${Math.min(...years)} to ${Math.max(...years)}` : ""}.</p>
<p><b>Authors' countries</b> (studies with at least one author at an institution there; not the countries of the samples): ${top("authorships.countries", 15)}.</p>
<p><b>Global South:</b> ${fmt(south)} studies (${pct(south)}) have at least one author at an institution OpenAlex marks as in the Global South.</p>
<p><b>Languages</b> (OpenAlex's labels): ${top("language", 10)}.</p>
<p><b>Types:</b> ${top("type", 8)}.</p>
<p><b>Open access:</b> ${fmt(open)} (${pct(open)}).</p>
<p><b>Journals and repositories:</b> ${top("primary_location.source.id", 10)}.</p>`;
}

/* ------------------------------------------------------------------ saving to Google Drive */
const MB = 1e6;
const sizeName = (bytes) => (bytes >= 1e9 ? `${bytes / 1e9} GB` : `${bytes / MB} MB`);

function openSave() {
  const d = $("#save");
  if (!driveConfigured()) { toast("Saving to Google Drive is not set up on this copy of the site.", 4000); return; }
  const studiesTab = state.tab === "studies", trialsTab = state.tab === "trials" || state.tab === "regional";
  const counts = [...new Set([results.length, 100, 500, 1000, 2000, 5000, 10000, total].filter((n) => n && n <= total))].sort((a, b) => a - b);
  const pick = counts.filter((n) => n <= 1000).pop() || counts[0];
  const howMany = h("select", { id: "save-count" }, counts.map((n) => h("option", { value: n, selected: n === pick },
    n === total ? `all ${fmt(n)}` : n === results.length ? `${fmt(n)} (the ones shown)` : `the first ${fmt(n)}`)));
  // what a large save of studies asks of OpenAlex: 200 results a request, about 100 requests a day without a key
  const sizeNote = h("p", { class: "note" });
  const explain = () => {
    const n = Number(howMany.value), key = Boolean(local.get("openalexKey", ""));
    if (!studiesTab || n <= results.length) return fill(sizeNote);
    const asks = Math.ceil(n / 200);
    fill(sizeNote, `Getting ${fmt(n)} results takes about ${plural(asks, "request")} to OpenAlex, 200 results each.`,
      !key && asks > 25 ? " Without a key, OpenAlex allows about 100 requests a day for everyone on your network, so a save this large may stop early: what it got by then is saved, and the save says how far it got. A free OpenAlex key (Settings) allows ten times more." : "",
      !key && n > 10000 && SOURCES.studies.capped(query()) ? " Without a key, OpenAlex also reaches only the first 10,000 results of each search; a key reaches all of them." : "");
  };
  howMany.addEventListener("change", explain);
  explain();
  const files = h("input", { type: "checkbox", id: "save-files", checked: true });
  const totalLimit = h("select", { id: "save-total", "aria-label": "Size limit for all files" },
    [500 * MB, 2e9, 5e9, 15e9].map((b) => h("option", { value: b, selected: b === 2e9 }, sizeName(b))));
  const fileLimit = h("select", { id: "save-file", "aria-label": "Size limit for one file" },
    [50 * MB, 250 * MB, 1e9, 2e9].map((b) => h("option", { value: b, selected: b === 250 * MB }, sizeName(b))));
  const pdfNote = h("p", { class: "note" }, pdfNoteText());
  fill($("#save-body"),
    h("p", {}, "Research Finder makes a folder for this search in your Google Drive, inside “Research Finder”:"),
    h("ul", { class: "tree" },
      h("li", {}, h("strong", {}, "Results"), " — a Google Sheet: one row per result with its abstract, the same columns for every source, with links to the files saved",
        studiesTab ? `, each study's design as OpenAlex tags it${checksOn() ? ", retractions and corrections, hijacked journals" : ""} and replications` : "",
        state.tab === "trials" ? ", each registration's status, phase, study type, whether results are posted, participants, dates, conditions, interventions, countries and publications" : "",
        translationsOn() && state.tab !== "trials" ? ", and an automatic English translation of titles in other languages" : ""),
      h("li", {}, h("strong", {}, "Results.ris"), " — the same results as a reference file, to import into Zotero, EndNote, Mendeley, Rayyan, Covidence or ASReview"),
      trialsTab ? null : h("li", {}, h("strong", {}, "Files"), " — a Google Sheet with every file found: its download link, and whether it was saved (and if not, why)"),
      h("li", {}, h("strong", {}, "Search details"), " — a document with your keywords, every term and translation used, the filters and the exact queries, so the search can be repeated, with the PRISMA-S items, a methods paragraph and the automated steps to report"),
      h("li", {}, h("strong", {}, "PRISMA flow diagram.svg"), " — the PRISMA 2020 flow diagram with the numbers of this search filled in, the rest for you to fill"),
      h("li", {}, h("strong", {}, RECORD), " — the search and which results were saved, so that Earlier saves can run it again and add only the new results"),
      studiesTab ? h("li", {}, h("strong", {}, "Papers/"), " — the open PDFs (also open versions found through Semantic Scholar, such as arXiv preprints)")
        : trialsTab ? null : h("li", {}, h("strong", {}, "Datasets/"), " — one folder per dataset with its open data files")),
    h("p", { class: "save-row" }, h("label", { for: "save-count" }, "Save "), howMany, h("span", {}, ` of ${fmt(total)} results`)),
    sizeNote,
    trialsTab ? null : h("p", { class: "save-row" }, h("label", {}, files, studiesTab ? " Save the open PDFs" : " Save the open data files")),
    trialsTab ? null : h("p", { class: "save-row" }, h("span", {}, "Up to"), totalLimit, h("span", {}, "in all, files up to"), fileLimit, h("span", {}, "each")),
    trialsTab ? null : studiesTab ? pdfNote : h("p", { class: "note" }, relayAddress()
        ? "Zenodo and Harvard Dataverse files are copied into your Drive, and OSF and figshare files through your file relay. For other repositories the sheet links to the dataset's page."
        : ["Zenodo and Harvard Dataverse files are copied into your Drive. OSF and figshare do not let browsers download files, so theirs are listed with their download links in “Files” (",
          h("button", { type: "button", class: "link-btn", onclick: () => { d.close(); openSettings(); } }, "connect a file relay"),
          " to copy them too). For other repositories the sheet links to the dataset's page."]),
    h("p", { class: "note" }, "A large save takes a while: keep this tab open. Your Drive needs to be connected: Google asks you to allow access the first time, and to connect again if a save takes more than an hour."),
    h("div", { class: "save-actions" },
      h("button", { type: "button", class: "btn btn-primary", id: "save-go", onclick: () => runSave(Number(howMany.value), files.checked && !trialsTab, Number(fileLimit.value), Number(totalLimit.value)) }, "Save to my Drive")),
    h("div", { id: "save-signin", class: "save-progress" }),
    h("div", { id: "save-progress", class: "save-progress", role: "status", "aria-live": "polite" }));
  if (!d.open) d.showModal();
  // whether the relay fetches publishers' PDFs too (its version 2 does): asked again each time, as its code may change
  if (studiesTab && relayAddress()) {
    checkRelay(relayAddress()).then((r) => {
      if (!r.ok) return;
      local.set("relayPdf", r.pdf ? "1" : "");
      fill(pdfNote, pdfNoteText());
    });
  }
}

/* What a save dialog says about PDFs, by whether a file relay is connected and fetches publishers' PDFs. */
function pdfNoteText(dialog = "#save") {
  const relay = relayAddress();
  if (relay && local.get("relayPdf", "")) {
    return "PDFs that publishers do not let browsers download are fetched through your file relay. A few publishers let only browsers in; their PDFs stay as links in “Files”.";
  }
  const settings = (label) => h("button", { type: "button", class: "link-btn", onclick: () => { $(dialog).close(); openSettings(); } }, label);
  return relay
    ? ["Many publishers do not let browsers download their PDFs; those stay as links in “Files”. OSF preprints come through your file relay; with its current code (", settings("Settings"), ") it fetches publishers' PDFs too."]
    : ["Many publishers do not let browsers download their PDFs; those stay as links in “Files” (", settings("connect a file relay"), " to fetch many of them)."];
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/* The first `count` results in the order shown (all of them, when `count` is the total), 200 at a time, each once;
   `notes` says why it got fewer, when it did. */
async function collect(count, progress) {
  if (count <= results.length) return { rows: results.slice(0, count), notes: [] };
  const rows = [], notes = [];
  progress(`Getting the results: 0 of ${fmt(count)}…`);
  for await (const batch of SOURCES[state.tab].all(query(), notes)) {
    rows.push(...batch);
    progress(`Getting the results: ${fmt(Math.min(rows.length, count))} of ${fmt(count)}…`);
    if (rows.length >= count) break;
  }
  if (!rows.length) throw new Error(notes[0] || "the search gave no results");
  return { rows: rows.slice(0, count), notes: [...new Set(notes)] };
}

const repoOf = (url) => (/osf\.io/.test(url) ? "OSF" : /figshare/.test(url) ? "figshare" : /zenodo/.test(url) ? "Zenodo" : /dataverse/.test(url) ? "Harvard Dataverse" : "");

async function runSave(count, withFiles, maxFile, maxTotal) {
  const progress = (m) => fill($("#save-progress"), spinner(), m);
  const go = $("#save-go");
  go.disabled = true;
  try {
    if (!driveConnected()) { progress("Connecting to Google Drive…"); await connect(); }
    const { rows, notes: gotNotes } = await collect(count, progress);
    const english = translationsOn() && state.tab !== "trials"
      ? await englishTitles(rows, { onProgress: (n, of) => progress(`Translating the titles in other languages into English: ${fmt(n)} of ${fmt(of)}…`) }) : null;
    const checks = state.tab === "studies";
    if (checks) await checkAll(rows, progress);
    const jobs = withFiles ? await fileJobs(rows, state.tab, progress) : [];
    const title = `${state.input} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const res = await saveSearch({
      title, header: header(Boolean(english), checks), rows: rows.map((r, i) => rowOf(r, i, Boolean(english), checks)), ris: risOf(rows, Boolean(english), checks), jobs, maxFile,
      maxTotal: Math.max(maxTotal, maxFile), onProgress: progress,
      detailsHtml: (stats) => detailsHtml(rows.length, jobs.length, stats, gotNotes, english, checks ? checkStats(rows) : null, count >= total),
      extras: [{ name: "PRISMA flow diagram.svg", type: "image/svg+xml", text: prismaSvg(prismaCounts(rows.length, count >= total, gotNotes)) }],
      record: searchRecord(rows, count >= total && !gotNotes.length),
      onSignIn: signInAgain($("#save-signin")),
    });
    const listedOnly = res.failed.filter((j) => j.copy === false).length;
    const notSaved = res.failed.length - listedOnly;
    const filesNote = withFiles ? ` and ${plural(res.papers + res.dataFiles, "file")} (${(res.bytes / MB).toFixed(1)} MB${res.relayed ? `; ${fmt(res.relayed)} through your file relay` : ""})` : "";
    const links = () => [link(res.folder, "Open the folder"), " · ", link(res.sheet, "Results"), res.files ? [" · ", link(res.files, "Files")] : null, " · ", link(res.doc, "Search details")];
    fill($("#save-progress"), h("p", {}, h("strong", {}, "Saved: "), `${plural(rows.length, "result")}${filesNote}. `, links(),
      res.csv ? h("span", { class: "note" }, " The results were too many for Google to turn into a sheet, so they are saved as a CSV file, which Google Sheets and Excel open.") : null,
      gotNotes.length ? h("span", { class: "note warn" }, ` ${gotNotes.join(" ")}`) : null,
      listedOnly ? h("span", { class: "note" }, ` ${plural(listedOnly, "file")} from OSF or figshare ${listedOnly === 1 ? "is" : "are"} listed with ${listedOnly === 1 ? "its" : "their"} download link in “Files”; a file relay (Settings) copies them too.`) : null,
      notSaved ? h("span", { class: "note" }, ` ${plural(notSaved, "file")} could not be saved; “Files” says why, and `,
        h("button", { type: "button", class: "link-btn", onclick: () => { $("#save").close(); openEarlier(); } }, "Earlier saves"),
        " can try them again later.") : null,
      h("span", { class: "note" }, " To update it later, ", h("button", { type: "button", class: "link-btn", onclick: () => { $("#save").close(); openEarlier(); } }, "Earlier saves"),
        " runs the same search again and adds only the new results to this folder (",
        h("button", { type: "button", class: "link-btn", onclick: () => downloadReminder(title) }, "a monthly reminder for your calendar"), ").")));
    fill($("#drive-result"), h("p", {}, "Saved in your Google Drive: ", links()));
    $("#drive-result").hidden = false;
  } catch (e) {
    fill($("#save-progress"), h("p", { class: "note warn" }, `Not saved: ${e.message}`));
  } finally {
    go.disabled = false;
  }
}

/* What a Drive save waits on when Google's sign-in runs out (it lasts an hour): a button to connect again. */
const signInAgain = (box) => () => new Promise((resolve, reject) => {
  fill(box, h("p", { class: "note warn" }, "Google's sign-in has run out (it lasts an hour). "),
    h("button", { type: "button", class: "btn btn-small btn-primary", onclick: async () => {
      try { await connect(); fill(box); resolve(); } catch (e) { reject(e); }
    } }, "Connect again and continue"));
});

/* The files to save for these results: the open PDFs of studies (also open versions found through Semantic Scholar),
   the open data files of datasets, through the file relay where it helps. */
async function fileJobs(rows, tab, progress) {
  const jobs = [], relay = relayAddress();
  // a relay that fetches publishers' PDFs too (version 2) is asked for every PDF the browser cannot get itself
  const pdfRelay = relay && tab === "studies" && (await checkRelay(relay)).pdf;
  if (relay && tab === "studies") local.set("relayPdf", pdfRelay ? "1" : "");
  const name = (r) => `${((r.authors || "").split(/[;,]/)[0].trim().split(" ").pop() || "study")}_${r.year || "n.d."}_${r.title.slice(0, 70)}`;
  if (tab === "studies") {
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
    await pool(jobs, 4, async (j) => {
      j.urls = await pdfLinks(j.urls);
      j.source = j.urls[0];
      if (pdfRelay) j.urls = [...j.urls.filter((u) => !needsRelay(u)), ...j.urls.map(relayed)];
      else if (relay) j.urls = j.urls.map((u) => (needsRelay(u) ? relayed(u) : u));
    });
  }
  if (tab === "data") {
    let listed = 0;
    const lists = rows.map(() => []);
    await pool(rows.map((r, i) => [r, i]), 4, async ([r, i]) => {
      try { lists[i] = await datasetFiles(r); } catch { /* listed as a link only */ }
      progress(`Listing the files of the datasets: ${fmt(++listed)} of ${fmt(rows.length)}…`);
    });
    rows.forEach((r, i) => {
      for (const f of lists[i]) {
        jobs.push({ row: i, kind: "data", urls: [f.relay && relay ? relayed(f.url) : f.url], source: f.url, name: f.name, size: f.size || 0,
          copy: !f.relay || Boolean(relay), repo: repoOf(f.url) || r.source, dataset: `${r.year || "n.d."} ${r.title.slice(0, 80)}`, title: r.title });
      }
    });
  }
  return jobs;
}

/* ------------------------------------------------------------------ earlier saves */
/* Adds to an earlier save the files it did not copy (a site that does not let browsers download them, a size limit, an
   interruption): reads the save's sheet "Files", tries those files again (through the file relay where it helps), puts
   the new ones into the save's own folders and updates "Files", "Results" and "Search details". */
const FILE_COLUMNS = ["Result no.", "Result", "File", "Size (MB)", "Repository", "Download link", "Saved in Drive", "Not saved because"];

async function openEarlier() {
  const d = $("#earlier"), body = $("#earlier-body");
  if (!d.open) d.showModal();
  const intro = h("p", {}, "Run an earlier save's search again and add only the new results to its folder, or add the files it did not copy, for example the PDFs a file relay can fetch, or files a size limit left out.");
  if (!driveConnected()) {
    fill(body, intro, h("p", {}, h("button", { type: "button", class: "btn btn-small btn-drive", onclick: async () => {
      try { await connect(); openEarlier(); } catch (e) { toast(e.message, 5000); }
    } }, "Connect Google Drive")));
    return;
  }
  fill(body, intro, h("p", {}, spinner(), " Looking for your saves…"));
  let saves;
  try {
    saves = await listSaves();
  } catch (e) {
    fill(body, intro, h("p", { class: "note warn" }, `Your saves could not be listed: ${e.message}`));
    return;
  }
  if (!saves.length) { fill(body, intro, h("p", { class: "note" }, "There is no save in your “Research Finder” folder yet.")); return; }
  const pick = h("select", { id: "earlier-pick" }, saves.map((s) => h("option", { value: s.id }, s.name)));
  const box = h("div", { id: "earlier-detail" });
  fill(body, intro, h("p", { class: "save-row" }, h("label", { for: "earlier-pick" }, "Save "), pick), box);
  const show = () => showEarlierSave(saves.find((s) => s.id === pick.value), box);
  pick.addEventListener("change", show);
  show();
}

async function showEarlierSave(save, box) {
  fill(box, h("p", {}, spinner(), " Reading the save…"));
  let s;
  try {
    s = await readSave(save);
    // a save made before 12 November 2026 has no record of its search: its queries are read from "Search details"
    if (!s.record) s.guess = await recordFromDetails(s).catch((e) => { if (/sign-in/.test(e.message)) throw e; return null; });
  } catch (e) {
    fill(box, h("p", { class: "note warn" }, `This save could not be read: ${e.message}`));
    return;
  }
  if ($("#earlier-pick").value !== save.id) return;   // another save was chosen meanwhile
  fill(box, h("h3", {}, "Run its search again"), againPart(s), h("h3", {}, "Files it did not copy"), filesPart(s));
}

/* The files a save did not copy, and a button that tries them again. */
function filesPart(s) {
  const say = (text, cls = "note") => h("p", { class: cls }, text);
  if (!s.files) return say("This save has no sheet “Files”: it was saved without its files, or with a version from before 2 November 2026, so Research Finder cannot tell which files are missing.");
  if (!s.fileRows) return say("The sheet “Files” of this save could not be read.", "note warn");
  const head = s.fileRows[0] || [];
  const gone = FILE_COLUMNS.filter((n) => !head.includes(n));
  if (gone.length) return say(`The sheet “Files” no longer has the column${gone.length > 1 ? "s" : ""} ${gone.map((n) => `“${n}”`).join(", ")}, so Research Finder cannot use it.`, "note warn");
  const c = Object.fromEntries(FILE_COLUMNS.map((n) => [n, head.indexOf(n)]));
  const lines = s.fileRows.map((r, line) => ({ r, line })).slice(1).filter(({ r }) => r[c["Download link"]]);
  const missing = lines.filter(({ r }) => !r[c["Saved in Drive"]]);
  const source = s.resultRows ? s.resultRows[0].indexOf("Source") : -1;
  const studies = s.papers ? true : s.datasets ? false : Boolean(s.resultRows && s.resultRows[1] && s.resultRows[1][source] === "OpenAlex");
  const why = new Map();
  for (const { r } of missing) why.set(r[c["Not saved because"]] || "no reason given", (why.get(r[c["Not saved because"]] || "no reason given") || 0) + 1);
  const reasons = [...why].sort((a, b) => b[1] - a[1]);
  const totalLimit = h("select", { id: "earlier-total", "aria-label": "Size limit for all the new files" },
    [500 * MB, 2e9, 5e9, 15e9].map((b) => h("option", { value: b, selected: b === 2e9 }, sizeName(b))));
  const fileLimit = h("select", { id: "earlier-file", "aria-label": "Size limit for one file" },
    [50 * MB, 250 * MB, 1e9, 2e9].map((b) => h("option", { value: b, selected: b === 250 * MB }, sizeName(b))));
  const progress = h("div", { id: "earlier-progress", class: "save-progress", role: "status", "aria-live": "polite" });
  const signin = h("div", { id: "earlier-signin", class: "save-progress" });
  const go = h("button", { type: "button", class: "btn btn-primary", id: "earlier-go" }, missing.length === 1 ? "Add the missing file" : `Add the ${fmt(missing.length)} missing files`);
  go.onclick = () => runFill(s, missing, c, studies, Number(fileLimit.value), Number(totalLimit.value), go, progress, signin);
  return [
    h("p", {}, `${plural(lines.length, "file")} listed: ${fmt(lines.length - missing.length)} saved, ${fmt(missing.length)} not saved. `,
      link(s.link, "Open the folder"), " · ", link(s.files.webViewLink, "Files")),
    missing.length ? [
      h("ul", { class: "why-list" }, reasons.slice(0, 5).map(([k, n]) => h("li", {}, `${fmt(n)}: ${k}`)),
        reasons.length > 5 ? h("li", {}, `${fmt(reasons.slice(5).reduce((a, [, n]) => a + n, 0))}: other reasons`) : null),
      h("p", { class: "save-row" }, h("span", {}, "Up to"), totalLimit, h("span", {}, "more in all, files up to"), fileLimit, h("span", {}, "each")),
      h("p", { class: "note" }, studies ? pdfNoteText("#earlier") : relayAddress() ? "OSF and figshare files come through your file relay."
        : ["OSF and figshare files need a file relay (", h("button", { type: "button", class: "link-btn", onclick: () => { $("#earlier").close(); openSettings(); } }, "Settings"), ")."]),
      h("p", { class: "note" }, "This takes a while for many files: keep this tab open."),
      h("div", { class: "save-actions" }, go), signin, progress,
    ] : h("p", { class: "note" }, "Every file of this save is in your Drive."),
  ];
}

/* ------------------------------------------------------------------ running a saved search again */
/* What a save needs to be run again ("Research Finder search.json"): the search, its exact queries, and which results
   it saved (their DOIs, OpenAlex IDs and links), each run added to it. */
const linkKey = (r) => r.url || r.landing || "";
const itemKeys = (r) => [...new Set([r.doi && `doi:${r.doi.toLowerCase()}`, r.oa && `oa:${r.oa}`, linkKey(r) && `u:${linkKey(r)}`].filter(Boolean))];
const titleKey = (title, year) => `t:${norm(title).slice(0, 80)}|${year || ""}`;
const keysOf = (r) => [...itemKeys(r), titleKey(r.title, r.year)];
function searchRecord(rows, complete) {
  return {
    app: "Research Finder", format: 1,
    about: "Research Finder reads this file to run the search again and add only the new results to this folder (Settings › Earlier saves). Changing it can stop that from working.",
    site: location.origin + location.pathname, link: location.href,
    tab: state.tab, input: state.input, mode: state.mode, sort: state.sort, filters: state.filters,
    // the exact queries where one query is sent (OpenAlex, ClinicalTrials.gov); the others are rebuilt from the terms
    queries: SOURCES[state.tab].queries ? SOURCES[state.tab].queries(query()).parts : null,
    groups: groupsForSearch().map((ts) => ts.map(({ text, lang, src, of, i, loose }) => ({ text, lang, src, of, i, loose }))),
    runs: [{ date: new Date().toISOString(), total, saved: rows.length, all: complete }],
    items: rows.map(itemKeys),
  };
}

/* The results a save had, from its sheets "Results" and "New results ...", for a save without a record. */
function sheetRows(s) {
  return [s.resultRows, ...(s.added || []).map((a) => a.rows)].filter((rows) => rows && rows.length > 1).flatMap((rows) => {
    const c = (n) => rows[0].indexOf(n);
    const at = { doi: c("DOI"), url: c("Link"), title: c("Title"), year: c("Year") };
    return rows.slice(1).map((r) => ({ doi: String(r[at.doi] || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase(), url: r[at.url] || "", title: r[at.title] || "", year: r[at.year] || "" }));
  });
}
const sheetItems = (s) => sheetRows(s).map((r) => [r.doi && `doi:${r.doi}`, r.url && `u:${r.url}`, r.title && titleKey(r.title, r.year)].filter(Boolean)).filter((ks) => ks.length);

/* For a save made before 12 November 2026: its OpenAlex queries, from "Queries sent" in its "Search details", and its
   filters, from the link at the end ("Repeat the search: ..."). null when they cannot be read. */
async function recordFromDetails(s) {
  const text = String(await detailsText(s) || "").replace(/\r/g, "");
  const part = (text.split(/\n\s*Queries sent\s*\n/)[1] || "").split(/\n\s*What was saved\s*\n/)[0];
  if (!/^\s*OpenAlex/m.test(part)) return null;
  const queries = part.split("\n").map((l) => l.trim().replace(/^Search \d+:\s*/, "")).filter((l) => /^[("]/.test(l) && l.length <= 1500);
  if (!queries.length || queries.length > 8) return null;
  const where = (/Repeat the search:\s*(https?:\/\/\S+)/.exec(text) || [])[1] || "";
  let p;
  try { p = new URLSearchParams(new URL(where).hash.slice(1)); } catch { p = new URLSearchParams(); }
  const list = (k) => (p.get(k) || "").split(",").filter(Boolean);
  return {
    app: "Research Finder", format: 1, tab: "studies", link: where, input: p.get("q") || s.name.replace(/ — \d{4}-\d\d-\d\d \d\d[: ]\d\d$/, ""),
    mode: p.get("match") === "any" ? "any" : "all", sort: p.get("sort") || "rel", queries,
    filters: { ...emptyFilters(), kinds: list("type"), designs: list("design").filter((d) => DESIGN_NAMES[d]), langs: list("lang"),
      from: parseInt(p.get("from"), 10) || null, to: parseInt(p.get("to"), 10) || null, open: p.get("open") === "1", fulltext: p.get("fulltext") === "1" },
  };
}

/* "Searched on 12 November 2026, 3 months ago. ... turns 12 months old on 12 November 2027." */
function ageText(first, last, runs) {
  if (!last) return "";
  const days = Math.floor((Date.now() - new Date(`${last}T12:00:00Z`)) / 864e5);
  const due = new Date(`${last}T12:00:00Z`);
  due.setUTCFullYear(due.getUTCFullYear() + 1);
  const ago = days < 1 ? `today (${dateText(last)})` : days < 2 ? `yesterday (${dateText(last)})`
    : `on ${dateText(last)}, ${days < 61 ? `${days} days ago` : `${Math.round(days / 30.44)} months ago`}`;
  return `${runs > 1 ? `Saved on ${dateText(first)}; last run again` : "Searched"} ${ago}. `
    + (days > 365 ? "That is more than 12 months ago: reviews that follow Cochrane's standards run their searches again before they are published."
      : `Reviews that follow Cochrane's standards run their searches again within the 12 months before they are published: this search turns 12 months old on ${dateText(due.toISOString().slice(0, 10))}.`);
}

function againPart(s) {
  const rec = s.record || s.guess;
  const runs = (s.record && s.record.runs) || [];
  const first = ((runs[0] && runs[0].date) || s.created || "").slice(0, 10);
  const last = ((runs.length && runs[runs.length - 1].date) || s.created || "").slice(0, 10);
  const box = h("div", { class: "save-progress", role: "status", "aria-live": "polite" });
  const signin = h("div", { class: "save-progress" });
  const remind = h("button", { type: "button", class: "btn btn-small", onclick: () => downloadReminder(s.name), title: "A calendar file with a reminder every month for a year" }, "Monthly reminder");
  const out = [h("p", {}, ageText(first, last, runs.length))];
  if (!rec) {
    if (/^(Citation search|Similar studies|Your studies) — /.test(s.name)) return [h("p", { class: "note" }, "This folder holds studies from a review tool, not a saved search, so there is no search to run again.")];
    out.push(h("p", { class: "note" }, "This save cannot be run again here: it was made before Research Finder kept a record of its search (12 November 2026), and its queries could not be read from its “Search details”. Search for its keywords again and save the results as a new folder."),
      h("div", { class: "save-actions" }, remind));
    return out;
  }
  const tab = SOURCES[rec.tab] ? rec.tab : "studies", studies = tab === "studies";
  const nq = (rec.queries || []).length;
  const key = Boolean(local.get("openalexKey", ""));
  const prev = runs[runs.length - 1];
  const expected = (prev && (prev.total || prev.retrieved || prev.saved)) || (s.resultRows ? s.resultRows.length - 1 : 0);
  const asks = Math.max(nq || 1, Math.ceil((expected || 200) / 200));
  const files = h("input", { type: "checkbox", checked: true });
  const go = h("button", { type: "button", class: "btn btn-primary" }, "Run it again and add what is new");
  go.onclick = () => runAgain(s, rec, files.checked, go, box, signin);
  out.push(
    h("p", { class: "note" }, `Research Finder runs ${s.record ? "the same" : "its"} ${studies ? (nq > 1 ? `${nq} OpenAlex queries` : "OpenAlex query") : tab === "trials" ? "ClinicalTrials.gov query" : "queries in the same repositories"} again, with the same filters, and adds to this folder only the results it did not have: a sheet and a RIS file “New results” with the date${tab === "trials" ? "" : `, their open ${studies ? "PDFs" : "data files"}`}, and a note in “Search details”${studies && checksOn() ? ", which also lists the studies saved before that are now retracted" : ""}.`,
      studies ? ` It takes about ${plural(asks, "request")} to OpenAlex, 200 results each${!key && asks > 25 ? "; without a key OpenAlex allows about 100 a day for your network, so it may stop early (then it adds what it got, and the next run adds the rest)" : ""}.` : ""),
    s.record ? null : h("details", { class: "relay-guide" }, h("summary", {}, "Its queries, read from “Search details”"),
      h("p", { class: "note" }, "This save was made before Research Finder kept a record of its search, so the queries were read from its “Search details”, and the filters from the link at its end: check that they are the ones you ran."),
      (rec.queries || []).map((x) => h("p", { class: "tools-ids" }, x))),
    tab === "trials" ? null : h("p", { class: "save-row" }, h("label", {}, files, studies ? " Save the open PDFs of the new studies" : " Save the open data files of the new datasets")),
    h("div", { class: "save-actions" }, go, remind), signin, box);
  return out;
}

async function runAgain(s, rec, withFiles, go, box, signinBox) {
  const progress = (m) => fill(box, spinner(), m);
  go.disabled = true;
  try {
    if (!driveConnected()) { progress("Connecting to Google Drive…"); await connect(); }
    const tab = SOURCES[rec.tab] ? rec.tab : "studies", studies = tab === "studies";
    const q = { groups: rec.groups || [], mode: rec.mode === "any" ? "any" : "all", filters: { ...emptyFilters(), ...(rec.filters || {}) }, sort: rec.sort || "rel" };
    const info = {}, notes = [], rows = [];
    progress("Running the search again…");
    for await (const batch of SOURCES[tab].all(q, notes, { queries: studies ? rec.queries : null, info })) {
      rows.push(...batch);
      progress(`Running the search again: ${fmt(rows.length)}${info.total ? ` of about ${fmt(info.total)}` : ""} results…`);
    }
    if (!rows.length && notes.length) throw new Error(notes[0]);
    const earlier = s.record && s.record.items ? s.record.items : sheetItems(s);
    const before = new Set(earlier.flat());
    const fresh = rows.filter((r) => !keysOf(r).some((k) => before.has(k)));
    const now = new Set(rows.flatMap(keysOf));
    const gone = earlier.filter((ks) => !ks.some((k) => now.has(k))).length;
    const english = translationsOn() && fresh.length
      ? await englishTitles(fresh, { onProgress: (n, of) => progress(`Translating the titles in other languages into English: ${fmt(n)} of ${fmt(of)}…`) }) : null;
    let changed = [];
    if (studies) {
      await loadReplications();
      if (checksOn()) {
        const old = earlier.flatMap((ks) => ks.filter((k) => k.startsWith("doi:")).map((k) => k.slice(4)));
        await checkUpdates([...fresh.map((r) => r.doi), ...old], (n, of) => progress(`Checking for retractions and corrections: ${fmt(n)} of ${fmt(of)} studies…`));
        const titles = new Map(sheetRows(s).filter((r) => r.doi).map((r) => [r.doi, r.title]));
        changed = [...new Set(old)].map((doi) => ({ doi, title: titles.get(doi) || "", list: updatesOf({ doi }).list.filter((n) => SERIOUS.includes(n.kind) || n.kind === "expression_of_concern") }))
          .filter((x) => x.list.length);
      }
    }
    const jobs = withFiles && fresh.length ? await fileJobs(fresh, tab, progress) : [];
    const when = new Date();
    const name = `New results ${when.toISOString().slice(0, 16).replace("T", " ")}`;
    const en = Boolean(english);
    const total_ = info.total == null ? rows.length : info.total;
    const run = { date: when.toISOString(), total: total_, retrieved: rows.length, added: fresh.length, notFound: gone, ...(notes.length ? { stoppedEarly: true } : {}) };
    const record = { ...rec, app: "Research Finder", format: 1,
      runs: [...(s.record && rec.runs ? rec.runs : [{ date: s.created || "", saved: earlier.length }]), run], items: [...earlier, ...fresh.map(itemKeys)] };
    const res = await addToSave({
      save: s, name, header: header(en, studies, tab), rows: fresh.map((r, i) => rowOf(r, i, en, studies, tab)), ris: fresh.length ? risOf(fresh, en, studies) : "", jobs,
      maxFile: 250 * MB, maxTotal: 2e9, record, onProgress: progress, onSignIn: signInAgain(signinBox),
      note: (st) => againHtml({ when, rec, exact: Boolean(s.record), studies, total: total_, retrieved: rows.length, fresh, gone, earlier: earlier.length, changed, notes, name, st }),
    });
    fill(box, h("p", {},
      h("strong", {}, fresh.length ? `Added ${plural(fresh.length, "new result")}. ` : "Nothing new. "),
      `The search found ${plural(rows.length, ...SOURCES[tab].noun)}; ${fmt(rows.length - fresh.length)} of them were in this folder already. `,
      res.sheet ? [link(res.sheet.webViewLink, name), " · "] : null, link(s.link, "Open the folder"),
      jobs.length ? h("span", { class: "note" }, ` ${plural(res.papers + res.dataFiles, "file")} saved (${(res.bytes / MB).toFixed(1)} MB) of ${fmt(jobs.length)} found.`) : null,
      changed.length ? h("span", { class: "note warn" }, ` ${plural(changed.length, "study", "studies")} saved before ${changed.length === 1 ? "is" : "are"} now marked retracted, withdrawn or with an expression of concern: “Search details” lists ${changed.length === 1 ? "it" : "them"}.`) : null,
      notes.length ? h("span", { class: "note warn" }, ` ${[...new Set(notes)].join(" ")}`) : null,
      res.recordError ? h("span", { class: "note warn" }, ` The record of the search could not be updated (${res.recordError}), so the next run may list these results again.`) : null,
      res.detailsError ? h("span", { class: "note warn" }, ` “Search details” could not be updated (${res.detailsError}).`) : null));
    s.record = record;           // a second run in this visit starts from this one
    if (res.recordFile) s.recordFile = res.recordFile;
  } catch (e) {
    fill(box, h("p", { class: "note warn" }, `Stopped: ${e.message}`));
  } finally {
    go.disabled = false;
  }
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* For "Search details": what a run of the saved search found. */
function againHtml({ when, rec, exact, studies, total: n, retrieved, fresh, gone, earlier, changed, notes, name, st }) {
  const qs = rec.queries || [];
  const files = st.papers + st.dataFiles;
  const how = exact ? "DOI, OpenAlex ID or link" : "DOI, link, or title and year";
  return `<h2>Run again on ${esc(dateText(localDay(when)))}</h2>
<p>On ${esc(dateText(localDay(when)))} at ${esc(when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}, the search was run again with Research Finder (${esc(location.origin + location.pathname)}), ${exact ? "with the same queries and filters as when it was saved" : "with the queries in “Queries sent” above and the filters of the link at the end of this document"}${studies && qs.length ? `: ${qs.map((x) => `<code>${esc(x)}</code>`).join("; ")}` : ""}.</p>
<p>It found ${fmt(n)} records${retrieved !== n ? ` (${fmt(retrieved)} different ones retrieved)` : ""}. ${fresh.length
    ? `${fmt(fresh.length)} of them ${fresh.length === 1 ? "was" : "were"} not among the ${fmt(earlier)} records this folder had before (matched by ${how}): ${fresh.length === 1 ? "it is" : "they are"} in the sheet “${esc(name)}” and in “${esc(name)}.ris”, to screen. ${fresh.length === 1 ? "It was" : "They were"} newly retrieved, not necessarily newly published: a record can enter a search when its data changes.`
    : `All of them were among the ${fmt(earlier)} records this folder had before (matched by ${how}), so nothing was added.`} ${fmt(gone)} of the records saved before ${gone === 1 ? "was" : "were"} not found this time; OpenAlex corrects, merges and removes records.${files ? ` ${fmt(files)} files of the new results were saved (${(st.bytes / MB).toFixed(1)} MB).` : ""}</p>
${notes.length ? `<p>${[...new Set(notes)].map(esc).join(" ")}</p>` : ""}
${changed.length ? `<p>Studies saved before that are now marked (Crossref, which includes the Retraction Watch database):</p><ul>${changed.slice(0, 100).map((x) => `<li>${esc(x.title || x.doi)}, https://doi.org/${esc(x.doi)}: ${esc(x.list.map((u) => `${u.label}${u.date ? ` on ${dateText(u.date)}` : ""}`).join("; "))}</li>`).join("")}</ul>${changed.length > 100 ? `<p>And ${fmt(changed.length - 100)} more.</p>` : ""}`
    : studies && checksOn() ? "<p>None of the studies saved before is marked retracted, withdrawn or with an expression of concern (Crossref, which includes the Retraction Watch database).</p>" : ""}
<p>For the PRISMA 2020 flow diagram of an updated review: records identified in this run ${fmt(n)}; found in an earlier run ${fmt(retrieved - fresh.length)}; new records to screen ${fmt(fresh.length)}.</p>`;
}

/* A calendar file with a reminder every month for a year to run a saved search again. */
function downloadReminder(name) {
  const site = location.origin + location.pathname.replace(/index\.html$/, "");
  const start = new Date();
  start.setDate(Math.min(start.getDate(), 28));       // every month has it
  start.setMonth(start.getMonth() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const day = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const text = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  // lines of at most 75 bytes, continued on the next line after a space
  const fold = (line) => {
    const enc = new TextEncoder();
    let out = "", cur = "", size = 0;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (size + n > (out ? 74 : 75)) { out += (out ? "\r\n " : "") + cur; cur = ""; size = 0; }
      cur += ch;
      size += n;
    }
    return out ? `${out}\r\n ${cur}` : cur;
  };
  const keywords = String(name).replace(/ — \d{4}-\d\d-\d\d \d\d[: ]\d\d$/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Research Finder//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@research-finder`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`,
    `DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`, "RRULE:FREQ=MONTHLY;COUNT=12",
    `SUMMARY:${text(`Run the search “${keywords}” again (Research Finder)`)}`,
    `DESCRIPTION:${text(`Open Research Finder (${site}#earlier), choose the save “${name}” and “Run it again and add what is new”: it adds only the new results to the save's folder in your Google Drive.`)}`,
    `URL:${site}#earlier`, "END:VEVENT", "END:VCALENDAR"];
  downloadFile(`run-again-${fileDate()}.ics`, lines.map(fold).join("\r\n") + "\r\n", "text/calendar;charset=utf-8",
    "Calendar file downloaded: open it to add a reminder every month for a year.");
}

async function runFill(s, missing, c, studies, maxFile, maxTotal, go, box, signinBox) {
  const progress = (m) => fill(box, spinner(), m);
  go.disabled = true;
  try {
    if (!driveConnected()) { progress("Connecting to Google Drive…"); await connect(); }
    const relay = relayAddress();
    if (relay && studies) progress("Asking your file relay what it fetches…");
    const pdfRelay = relay && studies && (await checkRelay(relay)).pdf;
    if (relay && studies) local.set("relayPdf", pdfRelay ? "1" : "");
    const rh = s.resultRows ? s.resultRows[0] : [];
    const year = rh.indexOf("Year"), title = rh.indexOf("Title");
    const jobs = missing.map(({ r, line }) => {
      const row = (parseInt(r[c["Result no."]], 10) || 0) - 1;
      const result = (s.resultRows && s.resultRows[row + 1]) || [];
      return { row, line, kind: studies ? "paper" : "data", source: r[c["Download link"]], urls: [r[c["Download link"]]], name: r[c.File] || "file",
        size: Math.round((parseFloat(r[c["Size (MB)"]]) || 0) * MB), title: r[c.Result] || "", repo: r[c.Repository] || "",
        dataset: `${result[year] || "n.d."} ${String(result[title] || r[c.Result] || "").slice(0, 80)}` };
    });
    if (studies) {
      progress("Looking at the links…");
      await pool(jobs, 4, async (j) => {
        const urls = await pdfLinks(j.urls);
        j.urls = pdfRelay ? [...urls.filter((u) => !needsRelay(u)), ...urls.map(relayed)] : relay ? urls.map((u) => (needsRelay(u) ? relayed(u) : u)) : urls;
      });
    } else {
      for (const j of jobs) {
        if (!needsRelay(j.source)) continue;
        j.copy = Boolean(relay);
        if (relay) j.urls = [relayed(j.source)];
      }
    }
    const res = await fillSave({
      save: s, jobs, maxFile, maxTotal: Math.max(maxTotal, maxFile), onProgress: progress,
      note: (st) => `<h2>Files added later</h2><p>On ${esc(new Date().toLocaleString("en-GB"))}, the ${fmt(jobs.length)} files this save had not copied were tried again with Research Finder: ${fmt(st.papers + st.dataFiles)} were added (${(st.bytes / MB).toFixed(1)} MB)${st.relayed ? `, ${fmt(st.relayed)} of them through the file relay ${esc(relayAddress())}` : ""}. The sheet “Files” shows which, and why the others were not saved.</p>`,
      onSignIn: () => new Promise((resolve, reject) => {
        fill(signinBox, h("p", { class: "note warn" }, "Google's sign-in has run out (it lasts an hour). "),
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: async () => {
            try { await connect(); fill(signinBox); resolve(); } catch (e) { reject(e); }
          } }, "Connect again and continue"));
      }),
    });
    const added = res.papers + res.dataFiles, still = jobs.length - added;
    fill(box, h("p", {}, h("strong", {}, "Added: "), `${plural(added, "file")} (${(res.bytes / MB).toFixed(1)} MB${res.relayed ? `; ${fmt(res.relayed)} through your file relay` : ""}). `,
      link(s.link, "Open the folder"), " · ", link(res.files.webViewLink, res.files.replaced ? "Files" : "Files (updated)"),
      res.results ? [" · ", link(res.results.webViewLink, res.results.replaced ? "Results" : "Results (updated)")] : null,
      still ? h("span", { class: "note" }, ` ${plural(still, "file")} still could not be saved; “Files” says why.`) : null,
      res.files.replaced ? null : h("span", { class: "note warn" }, " Google did not let Research Finder change the sheet “Files”, so the updated list is a new sheet next to it."),
      res.results && !res.results.replaced ? h("span", { class: "note warn" }, " The results with the new links are a new sheet next to “Results”.") : null,
      res.resultsError ? h("span", { class: "note warn" }, ` The new links could not be added to “Results” (${res.resultsError}); “Files” has them.`) : null,
      res.detailsError ? h("span", { class: "note warn" }, ` “Search details” could not be updated (${res.detailsError}).`) : null));
  } catch (e) {
    fill(box, h("p", { class: "note warn" }, `Stopped: ${e.message}`));
  } finally {
    go.disabled = false;
  }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* The record of the search, so that it can be reported and repeated. */
/* What the checks found among the studies saved, for "Search details". */
function checkStats(rows) {
  const s = { on: checksOn(), withDoi: 0, checked: 0, serious: 0, concern: 0, corrected: 0, fromOpenAlex: 0, designed: 0, designs: {}, replicated: 0, date: replicationsDate(),
    doaj: 0, hijacked: 0, hijackDate: hijackedDate() };
  for (const r of rows) {
    if (r.doaj) s.doaj++;
    if (hijackOf(r)) s.hijacked++;
    if (r.doi) s.withDoi++;
    const u = updatesOf(r);
    if (u.checked) s.checked++;
    if (u.list.some((n) => SERIOUS.includes(n.kind))) s.serious++;
    if (u.list.some((n) => n.kind === "expression_of_concern")) s.concern++;
    if (u.list.some((n) => n.label === "Corrected")) s.corrected++;
    if (u.list.some((n) => n.sources.includes("OpenAlex"))) s.fromOpenAlex++;
    const ds = designsOf(r);
    if (ds.length) s.designed++;
    for (const d of ds) s.designs[d] = (s.designs[d] || 0) + 1;
    if (replicationsOf(r)) s.replicated++;
  }
  return s;
}

function checksHtml(c) {
  const designs = Object.keys(DESIGN_NAMES).filter((d) => c.designs[d]).map((d) => `${esc(DESIGN_NAMES[d])} ${fmt(c.designs[d])}`).join("; ");
  const unchecked = c.withDoi - c.checked;
  return `<h2>Checks on the studies</h2>
<p><b>Retractions and corrections</b> (column “Retraction or correction” of “Results”, and a note in “Results.ris”). ${c.on
    ? `${fmt(c.serious)} of the studies saved are retracted, partly retracted, withdrawn or removed; ${fmt(c.concern)} have an expression of concern; ${fmt(c.corrected)} were corrected. Research Finder asked Crossref, whose update notices include the Retraction Watch database, about the ${fmt(c.withDoi)} studies with a DOI on ${esc(dateText(new Date().toISOString().slice(0, 10)))}${unchecked > 0 ? `; ${fmt(unchecked)} could not be checked, because Crossref did not answer` : ""}. Where Crossref had no notice, OpenAlex's own retraction flag was used${c.fromOpenAlex ? ` (${fmt(c.fromOpenAlex)} studies)` : ""}. A study without a flag can still have problems that no notice records.`
    : "Not checked: the check was turned off in Settings."}</p>
<p><b>Study designs</b> (column “Study design (automatic tag)”). ${c.designed ? `${fmt(c.designed)} of the studies saved have a design tag: ${designs}.` : "None of the studies saved has a design tag."} OpenAlex tags seven designs from PubMed's study types automatically, from the title, journal and abstract. A tag is right at least 96% of the time (randomized controlled trials 99%), but many studies have none, among them every study without an abstract, so an empty cell does not mean that a study has another design.</p>
<p><b>Journals</b> (column “Journal (DOAJ, hijacked journals)”). ${fmt(c.doaj)} of the studies saved are in journals listed in the Directory of Open Access Journals (DOAJ), as OpenAlex records it; a journal outside DOAJ is not suspect for that reason. ${c.on
    ? `${fmt(c.hijacked)} ${c.hijacked === 1 ? "has its page" : "have their pages"} on the website of a hijacked journal, a fake copy of a real journal, in Retraction Watch's Hijacked Journal Checker${c.hijackDate ? ` (as read on ${esc(dateText(c.hijackDate))})` : ""}, which lists confirmed cases only.`
    : "Hijacked journals were not checked: the check was turned off in Settings."}</p>
<p><b>Replications</b> (column “Replications (FReD)”). ${fmt(c.replicated)} of the studies saved have replications or reproductions recorded in the FORRT Replication Database (FReD; CC BY 4.0; data of ${esc(c.date || "unknown date")}), which lists about 2,600 findings, most of them from psychology: a study it does not list may still have been replicated.</p>`;
}

/* For "Search details": the citation search of this visit, which is saved on its own. */
function chaseNote(c) {
  return `<h2>Citation searching</h2>
<p>On ${esc(dateText(c.date))}, a citation search in OpenAlex from ${plural(c.seeds.length, "study", "studies")} (${[c.back ? "their references" : "", c.forward ? "the studies that cite them" : ""].filter(Boolean).join(" and ")}) found ${plural(c.records.length, "study", "studies")}. It is not in this folder: save it from Review tools › Citation search, which gives it a folder with its own “Search details”.</p>`;
}

/* For "Search details": the similar studies found in this visit ("More like these"), which are saved on their own. */
function similarNote(c) {
  const missed = c.records.filter((e) => e.found === false).length;
  return `<h2>Similar studies</h2>
<p>On ${esc(dateText(c.date))}, “More like these” found ${plural(c.records.length, "study", "studies")} similar to ${plural(c.seeds.length, "study", "studies")} of the reviewer's, from OpenAlex's lists of related works (machine-learned similarity of titles, abstracts and venues)${c.checked ? `; ${fmt(missed)} of them were not found by the search it was checked against` : ""}. They are not in this folder: save them from Review tools › More like these, which gives them a folder with its own “Search details”.</p>`;
}

/* For "Search details": the PRISMA 2020 numbers, the PRISMA-S items, a methods paragraph and the automated steps to
   disclose, from what this search actually did. Placeholders in [brackets] are for the reviewers to complete. */
function reportingHtml(nRows, savedAll, gotNotes, english, checks, filters) {
  const f = state.filters, studies = state.tab === "studies", trials = state.tab === "trials";
  const day = dateText(new Date().toISOString().slice(0, 10));
  // a registry search uses the English terms only
  const groups = state.groups.map((g) => ({ g, used: activeTerms(g, state.langsOff).filter((t) => !trials || !isTranslation(t)) })).filter((x) => x.used.length);
  const used = groups.flatMap((x) => x.used);
  const machine = used.filter((t) => isTranslation(t) && t.src === "mt").length;
  const langs = new Set(used.filter(isTranslation).map((t) => t.lang));
  const mined = used.filter((t) => t.src === "variant").length;
  const added = used.filter((t) => ["similar", "studies"].includes(t.src)).length;
  const doubted = groups.reduce((s, x) => s + x.g.terms.filter((t) => t.doubt && !t.on).length, 0);
  const c = prismaCounts(nRows, savedAll, gotNotes);
  const limits = filters.join("; ");
  const ref = citation();
  const check = studies && review.check && review.check.signature === searchSignature() ? review.check : null;
  const regional = state.tab === "regional";
  const dbs = regional ? REGIONAL_NAMES.filter((n) => (!f.repos.length || f.repos.includes(n)) && (extra.totals || {})[n] != null) : [];
  const sources = studies ? "OpenAlex (https://openalex.org)" : trials ? "the trial registry ClinicalTrials.gov (https://clinicaltrials.gov)"
    : regional ? dbs.join(", ") : f.measures ? "DataCite (the questionnaires and scales of ZIS and PsychArchives)" : "DataCite, Zenodo, Harvard Dataverse, OSF (through its SHARE index) and OpenAIRE";
  const concepts = groups.map((x) => `“${esc(x.g.label)}” (${plural(x.used.length, "term")})`).join(state.mode === "all" ? " AND " : " OR ");
  const methods = `We searched ${esc(sources)} on ${esc(day)} with Research Finder, which sends the search to ${studies ? "the OpenAlex API" : trials ? "the ClinicalTrials.gov API (version 2)" : regional ? "the databases' APIs" : "the repositories' APIs"}. `
    + (groups.length > 1 ? `The search combined ${plural(groups.length, "concept")}, ${state.mode === "all" ? "all of which had to match" : "any of which could match"}: ${concepts}. ` : `The search used one concept, ${concepts}. `)
    + `${groups.length > 1 ? "The terms for each concept were" : "Its terms were"} our own words${mined ? `, the other wordings used in the ${SAMPLE} studies in OpenAlex that match it best` : ""}, synonyms from Wikidata${added ? ", related phrases we chose from those suggested" : ""}`
    + `${langs.size ? `, and translations into ${plural(langs.size, "language")} from Wikidata and Wikimedia's machine translation service MinT, each machine translation checked by translating it back into English` : ""}. `
    + `They were searched in ${trials ? "all the fields of the registrations" : regional ? "all the fields of the records" : f.fulltext ? "titles, abstracts and full texts" : "titles and abstracts"}. ${limits ? `Limits: ${esc(limits)}. ` : "No limits were applied. "}`
    + `The full strategy, with every term and the exact queries, is in [Supplementary file]. `
    + `The search found ${fmt(total)} records${c.duplicates != null ? `; after ${fmt(c.duplicates)} duplicates within the search were removed, ${fmt(nRows)} were exported for screening` : `, of which ${fmt(nRows)} were exported for screening`}`
    + `${check ? `. It retrieved ${fmt(check.hit.length)} of ${plural(check.works.length, "known eligible study", "known eligible studies")} that are in OpenAlex` : ""}.`;
  const prismaS = [
    ["Database name", studies ? "OpenAlex, searched through its API with Research Finder." : trials ? "None in this search: it searched a study registry (below). [Add the databases searched separately.]"
      : regional ? `${esc(dbs.join(", "))}, searched through their APIs with Research Finder.` : "DataCite, Zenodo, Harvard Dataverse, OSF (SHARE index) and OpenAIRE, searched through their APIs with Research Finder."],
    ["Multi-database searching", studies ? "Not applicable: OpenAlex is one index, which draws its records from Crossref, PubMed, repositories and other sources." : trials ? "Not applicable."
      : regional ? "Each database was searched on its own, with the terms in its languages, and the results were put together, each record once (by DOI, or by title and year)." : "Each repository was searched on its own and the results were put together, each dataset once."],
    ["Study registries", trials ? `ClinicalTrials.gov, searched through its API (version 2) with Research Finder on ${esc(day)}, with the English terms. [Add other registries searched, such as the WHO ICTRP portal or PROSPERO.]` : "[To complete: registries searched, such as ClinicalTrials.gov (Research Finder's tab “Registered studies”) or PROSPERO.]"],
    ["Online resources and browsing", "[To complete: websites, conference proceedings or tables of contents browsed, and how.]"],
    ["Citation searching", review.chase ? `Backward and forward citation searching in OpenAlex from ${plural(review.chase.seeds.length, "study", "studies")} on ${dateText(review.chase.date)}, with Research Finder.` : "[To complete, for example with Review tools › Citation search.]"],
    ["Contacts", "[To complete: authors, experts or others contacted.]"],
    ["Other methods", review.similar ? `Similar-article searching: OpenAlex's related works of ${plural(review.similar.seeds.length, "study", "studies")}, on ${esc(dateText(review.similar.date))}, with Research Finder (“More like these”). [Add any other methods.]` : "[To complete.]"],
    ["Full search strategies", "“Keywords” and “Queries sent” above: every term and translation, and each query exactly as sent."],
    ["Limits and restrictions", `${limits ? esc(limits) : "None."} [Give the reason for each limit.]`],
    ["Search filters", f.designs.length ? `OpenAlex's automatic study-design tags (not a validated search filter): ${esc(f.designs.map((d) => DESIGN_NAMES[d]).join(", "))}.` : "None."],
    ["Prior work", "[To complete: searches of earlier reviews that were adapted.]"],
    ["Updates", "To update the search, Research Finder (Settings › Earlier saves) runs the same queries again and adds only the new records to this folder, with a note below. [Say when and how often the search was run again.]"],
    ["Dates of searches", esc(day)],
    ["Peer review", "[To complete: for example, a PRESS peer review of the strategy.]"],
    ["Total records", `${studies ? "OpenAlex" : trials ? "ClinicalTrials.gov" : regional ? esc(Object.entries(extra.totals || {}).map(([n, v]) => `${n} ${fmt(v)}`).join(", ")) + ", in all" : "The repositories"}: ${fmt(total)}${c.duplicates != null ? `; ${fmt(nRows)} after duplicates within the search were removed` : `; ${fmt(nRows)} saved`}.`],
    ["Deduplication", trials ? "Each registration is one record (its NCT number). [Describe how registrations were matched to publications and how duplicates across all sources were removed.]"
      : `Within this search, each record was kept once by its DOI${studies ? " or OpenAlex ID" : ", or by its title and year"}. [Describe how duplicates across all databases were removed, and with which software.]`],
  ];
  const steps = [
    `<li><b>Term suggestions.</b> Wordings counted in the titles and abstracts of the ${SAMPLE} studies in OpenAlex that match each keyword best (a rule-based count, no AI model)${mined ? `: ${fmt(mined)} were searched` : ""}; synonyms from Wikidata. Every term was shown, and the reviewers could switch any of them off.</li>`,
    machine ? `<li><b>Machine translation of the terms.</b> ${fmt(machine)} terms translated by Wikimedia's MinT (open neural machine translation models) on ${esc(day)}, each translated back into English as a check${doubted ? `; ${fmt(doubted)} that did not come back with the same meaning were left out` : ""}. [Say whether someone who reads the language checked them.]</li>` : "",
    `<li><b>Ranking.</b> ${studies ? "OpenAlex's" : trials ? "ClinicalTrials.gov's" : regional ? "The databases'" : "The repositories'"} relevance order${savedAll ? ": all results were saved, so it did not decide which records were kept" : `: only the first ${fmt(nRows)} in that order were saved`}.</li>`,
    studies ? `<li><b>Study designs.</b> OpenAlex's automatic tags (a classifier reading the title and abstract; at least 96% precision by OpenAlex's benchmark, recall not reported) were shown${f.designs.length ? " and used as a filter" : ""}.</li>` : "",
    english && english.shown ? `<li><b>Machine translation of titles.</b> ${fmt(english.shown)} titles in other languages translated into English by MinT and checked by back-translation, to help screening.</li>` : "",
    check ? `<li><b>Validation.</b> The search was checked against ${plural(check.works.length, "known study", "known studies")} (see “Search validation”).</li>` : "",
    review.similar ? `<li><b>Similar studies.</b> OpenAlex's related works, chosen by a machine-learned similarity of titles, abstracts and venues, suggested ${plural(review.similar.records.length, "study", "studies")} like ${plural(review.similar.seeds.length, "study", "studies")} of the reviewers' (“More like these”, ${esc(dateText(review.similar.date))}).</li>` : "",
    `<li><b>Deduplication</b> within the search by exact DOI or OpenAlex ID.</li>`,
  ].filter(Boolean).join("");
  return `<h2>PRISMA 2020 flow diagram</h2>
<p>“PRISMA flow diagram.svg” in this folder is the PRISMA 2020 flow diagram with the numbers this search gives: records identified from ${c.databases.length ? esc(c.databases.map(([n, v]) => `${n} (n = ${fmt(v)})`).join(", ")) : `the register ClinicalTrials.gov (n = ${fmt(c.registers)})`}${c.duplicates != null ? `, and ${fmt(c.duplicates)} duplicate records removed within the search` : ""}${c.citation != null ? `, and ${fmt(c.citation)} records from the citation search` : ""}. The other boxes show (n = …), to fill in after screening.${c.duplicates == null ? " Duplicates are not counted because not all results were saved." : ""} If you searched other databases too, add their records and count duplicates across all of them.</p>
<h2>Reporting the search (PRISMA-S)</h2>
<table border="1" cellpadding="5" cellspacing="0"><tr><th>Item</th><th>What to report</th></tr>${prismaS.map(([item, text], i) => `<tr><td>${i + 1}. ${esc(item)}</td><td>${text}</td></tr>`).join("")}</table>
<h2>Methods paragraph</h2>
<p>To adapt for a methods section:</p>
<p>${methods}</p>${ref ? `<p>Reference: ${esc(ref)}</p>` : ""}
<h2>Use of automation and AI</h2>
<p>The 2025 position statement of Cochrane, the Campbell Collaboration, JBI and the Collaboration for Environmental Evidence asks reviews to report automation that makes or suggests judgements. In this search:</p>
<ul>${steps}</ul>
<p>None of these steps included or excluded a study. [Add how the reviewers checked the suggested terms and translations.]</p>`;
}

function detailsHtml(nRows, nJobs, stats, gotNotes = [], english = null, checks = null, savedAll = false) {
  const f = state.filters, src = SOURCES[state.tab];
  const when = new Date();
  const filters = [
    f.kinds.length ? `Types: ${f.kinds.map((k) => KIND_NAMES[k]).join(", ")}` : "",
    f.designs.length ? `Study designs (OpenAlex's automatic tags): ${f.designs.map((d) => DESIGN_NAMES[d]).join(", ")}` : "",
    f.from || f.to ? `Years: ${f.from || "…"}–${f.to || "…"}` : "",
    f.open ? "Open access only" : "",
    f.fulltext ? "Full texts searched too" : "",
    f.langs.length ? `Languages of the studies: ${f.langs.map((l) => LANG_NAMES[l] || l).join(", ")}` : "",
    f.repos.length ? `Repositories: ${f.repos.join(", ")}` : "",
    f.countries.length ? `Authors from: ${f.countries.map(countryName).join(", ")} (OpenAlex's institution countries)` : "",
    f.south ? "At least one author at an institution in the Global South (as OpenAlex marks institutions)" : "",
    f.status.length ? `Status: ${f.status.map((x) => CT_STATUS_NAMES[x]).join(", ")}` : "",
    f.results ? "Results posted in the registry" : "",
    f.ctype.length ? `Study types: ${f.ctype.map((x) => CT_TYPES[x]).join(", ")}` : "",
    f.measures ? "Questionnaires and scales only (ZIS and PsychArchives, in DataCite)" : "",
    f.cites ? `Only studies that cite ${citesName(f.cites)} (OpenAlex ${f.cites})` : "",
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
  } else if (state.tab === "regional") {
    queries = REGIONAL_NAMES.filter((n) => !f.repos.length || f.repos.includes(n))
      .map((n) => `<p><b>${esc(n)}</b>${n === "LA Referencia" ? " (all fields; terms in English, Spanish and Portuguese)" : n === "DOAJ" ? " (all fields; terms in every language)" : " (articles; terms in English and Japanese)"}:</p>${regionalQueries(n, q.groups, q.mode).parts.map((x) => `<p><code>${esc(x)}</code></p>`).join("")}`).join("");
  } else if (state.tab === "trials") {
    const { parts, dropped } = SOURCES.trials.queries(q);
    queries = `<p><b>ClinicalTrials.gov</b> (API version 2, <code>query.term</code>, which searches every field of the registrations; English terms only):</p>`
      + parts.map((x) => `<p><code>${esc(x)}</code></p>`).join("") + (dropped ? `<p>${fmt(dropped)} terms did not fit and were left out.</p>` : "");
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
<p>${fmt(total)} results found${state.tab === "data" ? " (a dataset kept in two repositories counts twice)" : extra.parts > 1 ? " (a study found by two of the searches counts twice)" : ""}; ${fmt(nRows)} saved in “Results” and in the reference file “Results.ris”, in the order shown (${esc((src.sorts.find(([v]) => v === state.sort) || ["", "Best match"])[1])}), each once.</p>
${gotNotes.length ? `<p>${gotNotes.map(esc).join(" ")}</p>` : ""}
${state.tab === "trials" ? "" : `<p>Files: ${fmt(stats.papers)} PDFs and ${fmt(stats.dataFiles)} data files saved (${(stats.bytes / MB).toFixed(1)} MB), of ${fmt(nJobs)} found; the sheet “Files” lists every one.${listedOnly ? ` ${fmt(listedOnly)} are in repositories that do not let browsers download files (OSF, figshare): the sheet has their download links.` : ""}${stats.relayed ? ` ${fmt(stats.relayed)} of the files saved came through the file relay ${esc(relayAddress())}, because their sites do not let browsers download them.` : ""}</p>`}
${failed ? `<p>Not saved:</p><ul>${failed}</ul>` : ""}
${english && english.foreign ? `<h2>Titles in other languages</h2>
<p>${fmt(english.foreign)} of the results saved have a title in another language. ${fmt(english.shown)} of them have an automatic English translation in the column “${EN_TITLE}” of “Results”, and in a note in “Results.ris”, made by Wikimedia's open machine translation (MinT) and checked by translating it back into the original language${english.failed ? `; ${fmt(english.failed)} did not pass that check and have none` : ""}${english.same ? `; ${fmt(english.same)} needed none, as their title says it in English too` : ""}${english.missing ? `; ${fmt(english.missing)} were not translated, because MinT did not answer or a save translates at most ${fmt(SAVE_TRANSLATIONS)}` : ""}. These are machine translations, not professional ones: use them to see what a study is about, and the original titles to screen and to cite.</p>` : ""}
${checks ? checksHtml(checks) : ""}
${state.tab === "studies" && review.overview && review.overview.signature === searchSignature() ? overviewHtml(review.overview) : ""}
${state.tab === "studies" && review.check && review.check.signature === searchSignature() ? checkHtml(review.check, esc) : ""}
${review.chase ? chaseNote(review.chase) : ""}
${review.similar ? similarNote(review.similar) : ""}
${reportingHtml(nRows, savedAll, gotNotes, english, checks, filters)}
<p>Repeat the search: ${esc(location.href)}</p>
</body></html>`;
}

/* ------------------------------------------------------------------ filters and tabs */
function renderTabs() {
  fill($("#tabs"), Object.values(SOURCES).map((s) => h("button", {
    type: "button", role: "tab", "aria-selected": String(state.tab === s.id), class: "tab", title: s.note,
    onclick: () => { if (state.tab !== s.id) { state.tab = s.id; state.sort = "rel"; state.filters = emptyFilters(); renderTabs(); search(0); } },
  }, s.name, h("span", { class: "tab-note" }, s.tab))));
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
  if (has("designs")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Study design"),
      Object.keys(DESIGN_NAMES).map((d) => opt(DESIGN_NAMES[d], f.designs.includes(d), (e) => { toggleIn(f.designs, d, e.target.checked); search(0); })),
      h("p", { class: "note f-note" }, "Tagged automatically by OpenAlex from titles and abstracts. The tags are rarely wrong, but many studies have none, among them every study without an abstract: use them to find studies, not to leave any out.")));
  }
  if (has("measures")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Kind"),
      opt("Questionnaires and scales only", f.measures, (e) => { f.measures = e.target.checked; search(0); }),
      h("p", { class: "note f-note" }, "Documented measures from GESIS's ZIS and ZPID's PsychArchives, many in German, with their licences.")));
  }
  if (has("repos") && !f.measures) {
    const all = src.repoNames || REPO_NAMES;
    sections.push(h("div", { class: "f-section" }, h("h3", {}, state.tab === "regional" ? "Databases" : "Repositories"),
      all.map((n) => opt(n, !f.repos.length || f.repos.includes(n),
        (e) => { f.repos = (f.repos.length ? f.repos : [...all]).filter((x) => x !== n); if (e.target.checked) f.repos.push(n); if (f.repos.length === all.length) f.repos = []; search(0); })),
      state.tab === "regional" && !local.get("ciniiAppId", "") ? h("p", { class: "note f-note" }, "CiNii Research needs a free application ID of your own: ",
        h("button", { type: "button", class: "link-btn", onclick: openSettings }, "Settings"), ".") : null));
  }
  if (f.cites && state.tab === "studies") {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Cites"),
      opt(`Only studies that cite ${citesName(f.cites)}`, true, () => { f.cites = ""; search(0); })));
  }
  if (has("open")) sections.push(h("div", { class: "f-section" }, h("h3", {}, "Access"), opt("Open access", f.open, (e) => { f.open = e.target.checked; search(0); })));
  if (has("authors")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Authors"),
      opt("At least one at an institution in the Global South", f.south, (e) => { f.south = e.target.checked; search(0); }),
      f.countries.map((c) => opt(`From ${countryName(c)}`, true, () => { toggleIn(f.countries, c, false); search(0); })),
      h("p", { class: "note f-note" }, "The Global South as OpenAlex marks institutions. ", f.countries.length ? "" : "Overview, above the results, adds a country.")));
  }
  if (has("status")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Status"),
      Object.entries(CT_STATUS_NAMES).map(([k, l]) => opt(l, f.status.includes(k), (e) => { toggleIn(f.status, k, e.target.checked); search(0); }))));
  }
  if (has("results")) sections.push(h("div", { class: "f-section" }, h("h3", {}, "Results"), opt("Results posted in the registry", f.results, (e) => { f.results = e.target.checked; search(0); })));
  if (has("ctype")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Study type"),
      Object.entries(CT_TYPES).map(([k, l]) => opt(l, f.ctype.includes(k), (e) => { toggleIn(f.ctype, k, e.target.checked); search(0); }))));
  }
  sections.push(h("div", { class: "f-section" }, h("h3", {}, state.tab === "trials" ? "Year the study started" : "Year"),
    h("div", { class: "f-years" }, yearInput("from"), "–", yearInput("to")),
    h("div", { class: "f-quick" }, quick(`Since ${now - 4}`, now - 4, null), quick("Since 2015", 2015, null), f.from || f.to ? quick("Any year", null, null) : null)));
  if (has("langs")) {
    sections.push(h("div", { class: "f-section" }, h("h3", {}, "Language of the study"),
      langs.map((l) => opt(l === "en" ? "English" : LANG_NAMES[l] || l.toUpperCase(), f.langs.includes(l), (e) => { toggleIn(f.langs, l, e.target.checked); search(0); })),
      h("button", { type: "button", class: "link-btn f-more", onclick: () => { state.showAllLangs = !state.showAllLangs; renderFilters(); } },
        state.showAllLangs ? "fewer languages" : `all ${langCodes.length} languages`)));
  }
  const active = f.kinds.length || f.designs.length || f.langs.length || f.from || f.to || f.open || f.repos.length || f.fulltext
    || f.countries.length || f.south || f.status.length || f.results || f.ctype.length || f.measures || f.cites;
  if (active) sections.push(h("div", { class: "f-section" }, h("button", { type: "button", class: "btn btn-small", onclick: () => { state.filters = emptyFilters(); search(0); } }, "Clear filters")));
  fill($("#filters-body"), sections);
}

/* ------------------------------------------------------------------ settings, about */
function openSettings() {
  const d = $("#settings");
  const key = h("input", { type: "password", autocomplete: "off", value: local.get("openalexKey", ""), placeholder: "optional", id: "set-key" });
  const langs = h("div", { class: "lang-grid" }, LANGS.map((l) => h("label", { class: "f-option" },
    h("input", { type: "checkbox", checked: !state.langsOff.has(l), onchange: (e) => { setLang(l, e.target.checked); } }), LANG_NAMES[l])));
  const relay = h("input", { type: "url", autocomplete: "off", spellcheck: "false", value: local.get("relay", ""), placeholder: "https://….workers.dev (optional)", id: "set-relay" });
  const relayStatus = h("p", { class: "note", role: "status" });
  const check = async () => {
    const address = relay.value.trim();
    local.set("relay", address);
    if (!address) { fill(relayStatus, "Not connected: files that sites do not let browsers download are listed with their links."); return; }
    fill(relayStatus, spinner(), " Checking the relay…");
    const r = await checkRelay(address);
    if (r.ok) local.set("relayPdf", r.pdf ? "1" : "");
    fill(relayStatus, !r.ok ? `This relay does not work: ${r.why}.`
      : r.pdf ? "Connected: OSF and figshare files, and the open-access PDFs publishers do not let browsers download, are copied into your Drive through it."
        : "Connected: OSF and figshare files are copied into your Drive through it. This relay runs older code: replace it with the current code (below) and deploy it again, and it fetches publishers' PDFs too.");
  };
  const cinii = h("input", { type: "text", id: "set-cinii", autocomplete: "off", spellcheck: "false", value: local.get("ciniiAppId", ""), placeholder: "optional" });
  const lib = library();
  const resolver = h("input", { type: "url", id: "set-resolver", autocomplete: "off", spellcheck: "false", value: lib.resolver, placeholder: "https://… (optional)" });
  const proxy = h("input", { type: "url", id: "set-proxy", autocomplete: "off", spellcheck: "false", value: lib.proxy, placeholder: "https://…/login?url= (optional)" });
  const libStatus = h("p", { class: "note", role: "status" });
  const libCheck = () => {
    const a = resolver.value.trim(), b = proxy.value.trim();
    fill(libStatus, [a && !resolverBase(a) ? "The link resolver's address is not a web address. " : "",
      b && !proxyBase(b) ? "The proxy's address is not a web address. " : ""].join("") || (resolverBase(a) || proxyBase(b) ? "Each study shows its library links after you close Settings." : ""));
  };
  resolver.addEventListener("change", libCheck);
  proxy.addEventListener("change", libCheck);
  const drive = !driveConfigured()
    ? h("p", { class: "note" }, "Saving to Google Drive is not set up on this copy of the site.")
    : driveConnected()
      ? h("p", {}, "Connected. ", h("button", { type: "button", class: "btn btn-small", onclick: () => { disconnect(); openSettings(); } }, "Disconnect"))
      : h("p", {}, h("button", { type: "button", class: "btn btn-small btn-drive", onclick: async () => { try { await connect(); openSettings(); } catch (e) { toast(e.message, 5000); } } }, "Connect Google Drive"),
        " Research Finder can only see the files it saves, in a folder called “Research Finder”.");
  const earlier = driveConfigured() ? h("p", { class: "note" }, "Files a save could not copy, for example before you connected a file relay, can be added to it later: ",
    h("button", { type: "button", class: "link-btn", onclick: () => { d.close(); openEarlier(); } }, "Earlier saves"), ".") : null;
  fill($("#settings-body"),
    h("h3", {}, "Search in these languages"),
    h("p", { class: "note" }, "The names and translations of your keywords in these languages are added to every search. Fewer languages make shorter queries."),
    h("div", { class: "f-quick" },
      h("button", { type: "button", class: "btn btn-small", onclick: () => { LANGS.forEach((l) => setLang(l, true)); openSettings(); } }, "All"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => { LANGS.forEach((l) => setLang(l, false)); openSettings(); } }, "English only")),
    langs,
    h("h3", {}, "Results in other languages"),
    h("label", { class: "f-option" }, h("input", { type: "checkbox", checked: translationsOn(), onchange: (e) => local.set("titlesEn", e.target.checked ? null : false) }),
      "Show their titles with an English translation"),
    h("p", { class: "note" }, "An automatic translation in [brackets] under each title in another language, and a button that translates its abstract. Wikimedia's MinT makes them, the open service that translates your keywords, and each title's translation is checked by translating it back. They are machine translations, not professional ones: enough to see what a study is about, not to quote."),
    h("h3", {}, "Retractions, corrections and hijacked journals"),
    h("label", { class: "f-option" }, h("input", { type: "checkbox", checked: checksOn(), onchange: (e) => local.set("updates", e.target.checked ? null : false) }),
      "Check the studies shown with Crossref and Retraction Watch"),
    h("p", { class: "note" }, "Research Finder sends the DOIs of the studies shown, and of the studies you save, to Crossref, whose update notices include the Retraction Watch database, and marks the ones that were retracted, withdrawn, corrected or given an expression of concern. It also reads Retraction Watch's list of hijacked journals (fake copies of real journals, from a Google Sheet, once a day) and marks studies whose pages are on their websites. Without this check, only OpenAlex's own retraction flag is shown."),
    h("h3", {}, "Your library (optional)"),
    h("p", { class: "note" }, "Studies behind a paywall can be opened through your university's subscriptions. With your library's link resolver, each study has a link “Find it at my library”; with its proxy, a link “Through my library” that opens the publisher's page signed in with your library account. Both addresses are kept only in this browser, and nothing is sent anywhere until you click a link."),
    h("label", { for: "set-resolver", class: "tools-label" }, "Link resolver (OpenURL)"), resolver,
    h("p", { class: "note" }, "Its address is on your library's website, often under “link resolver”, “OpenURL”, SFX, 360 Link or Alma. Or, if Google Scholar shows your library's link next to its results (Settings › Library links), copy one of those links and paste it here: Research Finder keeps only your library's part of it."),
    h("label", { for: "set-proxy", class: "tools-label" }, "Proxy (EZproxy or OpenAthens)"), proxy,
    h("p", { class: "note" }, "The start of the address your library uses to open publishers' pages, usually ending in “login?url=” or “?url=”; or paste a whole link that goes through it."),
    libStatus,
    h("h3", {}, "Google Drive"), drive, earlier,
    h("h3", {}, h("label", { for: "set-relay" }, "File relay (optional)")),
    h("p", { class: "note" }, "OSF and figshare do not let web pages download their files, and neither do many publishers for their open-access PDFs, so Research Finder lists those with their links. A file relay copies them into your Drive too: a small program that you run on your own free Cloudflare account. It fetches each file and passes it straight on, keeping nothing. You decide whether to set one up; its address is kept only in this browser."),
    h("div", { class: "relay-row" }, relay, h("button", { type: "button", class: "btn btn-small", onclick: check }, "Check"),
      CONFIG.fileRelay ? h("button", { type: "button", class: "btn btn-small", onclick: () => { relay.value = CONFIG.fileRelay; check(); } }, "Use this site's relay") : null),
    relayStatus,
    h("details", { class: "relay-guide" }, h("summary", {}, "Set up your own relay (free, about five minutes)"),
      h("ol", {},
        h("li", {}, "Create a free account at ", link("https://dash.cloudflare.com/sign-up", "Cloudflare"), "; no card is needed."),
        h("li", {}, "In the dashboard, open Workers & Pages, choose Create application, start from “Hello World” and deploy it."),
        h("li", {}, "Choose Edit code, replace all the code with the relay's (", h("button", { type: "button", class: "link-btn", onclick: copyRelayCode }, "copy it"),
          " or ", link("relay/worker.js", "read it"), "), and Deploy."),
        h("li", {}, "Copy the Worker's address, which ends in .workers.dev, paste it above and choose Check.")),
      h("p", { class: "note" }, "The relay answers only this site. From OSF and figshare it fetches files; from other sites, only PDFs, so it cannot be used to read web pages. It does not try to get past the checks some publishers use to let only browsers in. Cloudflare's free plan allows 100,000 files a day and is not billed.")),
    h("h3", {}, h("label", { for: "set-key" }, "OpenAlex key (optional)")),
    h("p", { class: "note" }, "Without a key, OpenAlex shares a free allowance of about 100 searches a day among everyone on your network, and limits free searches when it is busy. Each keyword takes one search to read how studies word it, and a search with many translations is split into up to 3 OpenAlex searches. A free personal key (",
      link("https://openalex.org/settings/api", "get one"), ") allows ten times more, up to 8 searches for one, and is not slowed down. It is kept only in this browser."), key,
    h("h3", {}, h("label", { for: "set-cinii" }, "CiNii Research application ID (optional)")),
    h("p", { class: "note" }, "The tab “Regional databases” searches the Japanese database CiNii Research only with an application ID of your own, which CiNii asks for and gives free (",
      link("https://support.nii.ac.jp/en/cinii/api/developer", "register"), "). It is kept only in this browser and sent only to CiNii."), cinii,
    h("h3", {}, "Zotero (optional)"),
    h("p", { class: "note" }, "With a key of your own, Export › Send to Zotero puts the results straight into your Zotero library, in a new collection."),
    keyForm(),
    h("h3", {}, "Other services"),
    h("p", { class: "note" }, "No other keys are needed. Wikidata, Wikimedia's MinT translation, Crossref, the DOI Foundation's citation formatter, ClinicalTrials.gov, DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE are free and open. Machine translations are remembered in this browser, so each term and title is translated only once. Semantic Scholar, which Research Finder asks for open PDFs when you save, does not accept keys sent from web pages, so it is asked without one. The replications come from a copy of the FORRT Replication Database that this site keeps, so looking them up sends nothing anywhere."));
  if (relay.value.trim()) check();
  d.onclose = () => {
    local.set("relay", relay.value.trim());
    local.set("openalexKey", key.value.trim());
    local.set("libResolver", resolverBase(resolver.value));
    local.set("libProxy", proxyBase(proxy.value));
    local.set("ciniiAppId", cinii.value.trim());
    renderGroups();
    if (state.groups.length) search(0);
  };
  if (!d.open) d.showModal();
}

async function copyRelayCode() {
  try {
    const code = await (await fetch("relay/worker.js", { cache: "no-cache" })).text();
    await navigator.clipboard.writeText(code);
    toast("The relay code is copied: paste it into the Cloudflare editor");
  } catch {
    window.open("relay/worker.js", "_blank", "noopener");
  }
}

/* "Siemiątkowski, M. (2026). Research Finder [Computer software]. <address>", as text or with the title in italics. */
function citation(html = false) {
  const names = String((CONFIG.creator || {}).name || "").trim().split(/\s+/).filter(Boolean);
  if (!names.length) return "";
  const last = names.pop();
  const who = names.length ? `${last}, ${names.map((n) => `${n[0]}.`).join(" ")}` : last;
  const where = location.origin + location.pathname.replace(/index\.html$/, "");
  const title = "Research Finder";
  return html
    ? [`${who} (${new Date().getFullYear()}). `, h("i", {}, title), ` [Computer software]. `, link(where, where)]
    : `${who} (${new Date().getFullYear()}). ${title} [Computer software]. ${where}`;
}

async function copyCitation() {
  const text = citation();
  try { await navigator.clipboard.writeText(text); toast("Citation copied"); } catch { window.prompt("Copy the citation:", text); }
}

function openAbout(e) {
  if (e) e.preventDefault();
  renderAbout();
  $("#about").hidden = false;
  $("#about").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* Who made the site, on the front page. */
function renderMaker() {
  const c = CONFIG.creator || {};
  if (!c.name) return;
  const role = [c.role ? c.role[0].toUpperCase() + c.role.slice(1) : "", c.affiliation].filter(Boolean).join(", ");
  fill($("#maker-body"),
    h("div", {},
      h("p", { class: "maker-name" }, c.name),
      role ? h("p", { class: "maker-role" }, role) : null,
      c.bio ? h("p", {}, c.bio) : null,
      c.email ? h("p", {}, "Questions, ideas or problems: ", h("a", { href: `mailto:${c.email}` }, c.email), ".") : null,
      h("p", { class: "maker-links" }, link("https://github.com/msiemiatkowski/research-finder", "Source code on GitHub"), " · ",
        h("a", { href: "privacy.html" }, "Privacy policy"), " · ", h("a", { href: "#about", onclick: openAbout }, "How it works, in detail"))),
    h("div", { class: "cite" },
      h("h3", {}, "Used it in a paper? Cite it"),
      h("p", {}, citation(true)),
      h("button", { type: "button", class: "btn btn-small", onclick: copyCitation }, "Copy the citation")));
  $("#maker").hidden = false;
}

function renderAbout() {
  const c = CONFIG.creator || {};
  fill($("#about-body"),
    h("p", { class: "lead-sm" }, "How your keywords become a search, what is saved, and how to report a search made with Research Finder."),
    h("h3", {}, "How your keywords become a search"),
    h("ol", {},
      h("li", {}, h("strong", {}, "Synonyms. "), "Wikidata, the open knowledge base behind Wikipedia, gives a known topic's synonyms and its names in other languages."),
      h("li", {}, h("strong", {}, "The wordings studies use. "), `Research Finder reads the titles and abstracts of the ${SAMPLE} studies in OpenAlex that match each keyword best and finds the phrases that say the same in other words: all of the keyword's words, in any form and order (“trust in scientists” and “trustworthiness of science” for “trust in science”). These are searched too. Related phrases (“epistemic trust”) and the keywords of those studies are offered for you to add.`),
      h("li", {}, h("strong", {}, "Translations. "), "Every English term is translated into 39 languages by Wikimedia's open machine translation (MinT), and each translation is translated back into English as a check: one that does not come back with the same meaning is left out."),
      h("li", {}, h("strong", {}, "The search. "), "All the terms become one Boolean query (OR within a keyword, AND between keywords), split into several queries when it is longer than a service takes. Studies come from OpenAlex; datasets from DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE.")),
    h("h3", {}, "Results in other languages"),
    h("p", {}, "A title in another language is shown with an automatic English translation in [brackets], and “English translation” under its abstract translates the abstract, both by Wikimedia's MinT. Each title's translation is translated back into the original language as a check: one that has almost nothing in common with the original, as machine translation sometimes writes for a short title, is not shown. They are machine translations, not professional ones, for a first look at what a study is about; Settings can turn them off."),
    h("h3", {}, "Checks on the studies"),
    h("p", {}, "Each study shows the design OpenAlex tags automatically from its title and abstract (randomized controlled trial, observational study, systematic review, meta-analysis, study protocol and others), and the filter “Study design” finds them; the tags are rarely wrong, but many studies have none. Studies that were retracted, withdrawn, corrected or given an expression of concern are marked, from Crossref's update notices, which include the Retraction Watch database. Studies with replication attempts recorded in the FORRT Replication Database, most of them in psychology, list them with their outcomes."),
    h("h3", {}, "Review tools"),
    h("p", {}, "The review tools start from your studies: the ones you add with “☆ Add to your studies” under each result, or paste by DOI, PubMed ID or OpenAlex ID. “Check your search” shows which of them the search retrieves (its relative recall) and why it misses the others. “Citation search” finds their references and the studies that cite them, in OpenAlex's citation index. “More like these” finds the studies most similar to them, from OpenAlex's lists of similar works, and marks the ones your search misses. “What your results cite most” lists the works your best-matching results cite most often and marks the ones your search does not find."),
    h("h3", {}, "Overview of the results"),
    h("p", {}, "“Overview”, above the results, counts all of them with OpenAlex: by year, type and language, by the countries of the authors' institutions and whether an author works in the Global South, by journal, and by open access. Each bar filters the results by it, so that, for example, the studies with an author in the Global South can be screened on their own."),
    h("h3", {}, "Regional databases and questionnaires"),
    h("p", {}, "The tab “Regional databases” searches LA Referencia (theses and articles from Latin American repositories, with the English, Spanish and Portuguese terms), DOAJ (articles of open-access journals worldwide, with all the terms) and, with your free application ID, CiNii Research (Japanese articles). “Versions of a questionnaire”, under the search box, finds the studies that validate or adapt a scale in other languages, and the filter “Questionnaires and scales” in Datasets finds documented measures from GESIS's ZIS and ZPID's PsychArchives."),
    h("h3", {}, "Registered studies"),
    h("p", {}, "The tab “Registered studies” searches ClinicalTrials.gov, more than 600,000 registered trials and observational studies, with the English terms of your keywords. Each registration shows its status, phase, participants and whether results are posted, with the publications it lists; registrations of completed studies without a publication are a check on publication bias. Studies whose abstracts give a registration number (NCT or ISRCTN) link to it."),
    h("h3", {}, "References and your library"),
    h("p", {}, "“Cite” under a study gives its reference in APA or any of more than 2,700 citation styles, formatted by the DOI Foundation's citation formatter from the data registered with its DOI; a study without a DOI gets an APA reference made from OpenAlex's data. Export gives the results as RIS, BibTeX or CSL-JSON, or as a reference list, or sends them to your Zotero library with a key of your own, and the page carries COinS data for the Zotero Connector. Studies in journals listed in the Directory of Open Access Journals carry a DOAJ badge, and studies on the websites of hijacked journals (fake copies of real journals, from Retraction Watch's list) are flagged. With your library's link resolver or proxy under Settings, each study links to its full text through your library's subscriptions."),
    h("h3", {}, "What is saved"),
    h("p", {}, "Each saved search becomes a folder inside “Research Finder” in your Drive: the sheet “Results” (one row per result, with its abstract, in the same columns for every source, each study's design tag, retractions and corrections, and replications, and an automatic English translation of titles in other languages), the same results as “Results.ris” for reference managers and screening tools, the sheet “Files” (every file found, its download link and whether it was saved), the document “Search details”, and the open PDFs and data files in their own folders."),
    h("h3", {}, "Running a search again"),
    h("p", {}, "Each save also keeps “Research Finder search.json”: the exact queries, the filters, and which results were saved. Settings › Earlier saves runs those queries again and adds to the folder only the records it did not have, as “New results” with the date, with their open PDFs, a note in “Search details” and the studies saved before that have since been retracted. Saves made before 12 November 2026 are run again from the queries in their “Search details”."),
    h("h3", {}, "Reporting a search"),
    h("p", {}, "The document “Search details” in each saved folder has what a methods section and a search appendix need:"),
    h("ul", {},
      h("li", {}, "the sources: OpenAlex, or the data repositories, searched through Research Finder;"),
      h("li", {}, "the date of the search;"),
      h("li", {}, "every term and translation, and the exact queries sent;"),
      h("li", {}, "the limits: where in the records it searched, and the years, types and languages chosen;"),
      h("li", {}, "the number of records found and saved, with a PRISMA 2020 flow diagram filled in as far as the search goes;"),
      h("li", {}, "the PRISMA-S items, a methods paragraph to adapt, and the automated steps to report.")),
    citation() ? h("p", {}, "Cite Research Finder as: ", citation(true)) : null,
    h("h3", {}, "Your Google Drive"),
    h("p", {}, "Connecting your Drive is optional. Research Finder asks Google only for access to the files it creates: it cannot see anything else in your Drive. Files are downloaded by your browser and go straight into your Drive. Some publishers and repositories (OSF, figshare) do not let browsers download files; those are listed with their download links, or, if you connect a file relay under Settings, copied through it."),
    h("h3", {}, "Privacy"),
    h("p", {}, "There is no server behind this site, no account and no tracking. Your searches go from your browser straight to the services above. See the ", h("a", { href: "privacy.html" }, "privacy policy"), "."),
    c.name ? h("h3", {}, "About the creator") : null,
    c.name ? h("p", {}, h("strong", {}, c.name), [c.role, c.affiliation].filter(Boolean).length ? `, ${[c.role, c.affiliation && `at the ${c.affiliation}`].filter(Boolean).join(" ")}.` : ".") : null,
    c.bio ? h("p", {}, c.bio) : null,
    c.email ? h("p", {}, "Questions, ideas or problems: write to ", h("a", { href: `mailto:${c.email}` }, c.email), ".") : null,
    h("p", {}, link("https://github.com/msiemiatkowski/research-finder", "Source code on GitHub"), " · ", h("a", { href: "privacy.html" }, "Privacy policy")));
}

/* ------------------------------------------------------------------ address bar */
let pushNext = false;        // a new search gets its own entry in the browser's history, so that Back returns to the one before
function toHash() {
  const p = new URLSearchParams();
  const f = state.filters;
  if (state.input) p.set("q", state.input);
  if (state.tab !== "studies") p.set("in", state.tab);
  if (state.mode !== "all") p.set("match", state.mode);
  if (state.sort !== "rel") p.set("sort", state.sort);
  if (f.kinds.length) p.set("type", f.kinds.join(","));
  if (f.designs.length) p.set("design", f.designs.join(","));
  if (f.langs.length) p.set("lang", f.langs.join(","));
  if (f.repos.length) p.set("repos", f.repos.join(","));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.open) p.set("open", "1");
  if (f.fulltext) p.set("fulltext", "1");
  if (f.countries.length) p.set("country", f.countries.join(","));
  if (f.south) p.set("south", "1");
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.results) p.set("results", "1");
  if (f.ctype.length) p.set("studytype", f.ctype.join(","));
  if (f.measures) p.set("measures", "1");
  if (f.cites) p.set("cites", f.cites);
  const s = p.toString();
  const url = s ? `#${s}` : location.pathname + location.search;
  if (pushNext && location.hash !== (s ? `#${s}` : "")) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  pushNext = false;
}

function fromHash() {
  const raw = location.hash.slice(1);
  if (raw === "about" || raw === "earlier") return raw;
  const p = new URLSearchParams(raw);
  const list = (k) => (p.get(k) || "").split(",").filter(Boolean);
  const f = state.filters;
  state.tab = SOURCES[p.get("in")] ? p.get("in") : "studies";
  state.mode = p.get("match") === "any" ? "any" : "all";
  state.sort = p.get("sort") || "rel";
  f.kinds = list("type");
  f.designs = list("design").filter((d) => DESIGN_NAMES[d]);
  f.langs = list("lang");
  f.repos = list("repos");
  f.from = parseInt(p.get("from"), 10) || null;
  f.to = parseInt(p.get("to"), 10) || null;
  f.open = p.get("open") === "1";
  f.fulltext = p.get("fulltext") === "1";
  f.countries = list("country").filter((c) => /^[A-Za-z]{2}$/.test(c)).map((c) => c.toUpperCase());
  f.south = p.get("south") === "1";
  f.status = list("status").filter((x) => CT_STATUS_NAMES[x]);
  f.results = p.get("results") === "1";
  f.ctype = list("studytype").filter((x) => CT_TYPES[x]);
  f.measures = p.get("measures") === "1";
  f.cites = /^W\d+$/.test(p.get("cites") || "") ? p.get("cites") : "";
  state.input = p.get("q") || "";
  return null;
}

function renderCredit() {
  const c = CONFIG.creator || {};
  if (!c.name) return;
  fill($("#foot-credit"), "Created by ", h("a", { href: "#about", onclick: openAbout }, c.name),
    c.affiliation ? ` (${c.affiliation})` : "", c.email ? [" · ", h("a", { href: `mailto:${c.email}` }, c.email)] : null);
}

/* ------------------------------------------------------------------ start */
function start() {
  local.set("email", null);        // asked for until November 2026 for OpenAlex, which no longer uses it
  renderCredit();
  renderMaker();
  const panel = fromHash();
  renderTabs();
  renderFilters();
  if (state.input) setQuery(state.input);
  else search(0);
  showPanel(panel);
}

/* The panel an address asks for: #about (how it works) or #earlier (Earlier saves, from a reminder). */
function showPanel(panel) {
  if (panel === "about") { renderAbout(); $("#about").hidden = false; }
  if (panel === "earlier" && driveConfigured()) openEarlier();
}

window.addEventListener("popstate", () => {
  const panel = fromHash();
  renderTabs();
  renderFilters();
  setQuery(state.input, true);
  showPanel(panel);
});
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
$("#earlier-close").addEventListener("click", () => $("#earlier").close());
$("#tools-close").addEventListener("click", () => $("#tools").close());
$("#save-close").addEventListener("click", () => $("#save").close());
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); setQuery($("#q").value); });
document.querySelectorAll(".example").forEach((b) => b.addEventListener("click", () => {
  setQuery(b.dataset.q || b.textContent);
  window.scrollTo({ top: 0, behavior: "smooth" });
}));
$("#more").addEventListener("click", showMore);
if ($("#finder-link")) $("#finder-link").addEventListener("click", openFinder);
$("#about-link").addEventListener("click", openAbout);
document.querySelectorAll(".close-panel").forEach((b) => b.addEventListener("click", () => { $("#" + b.dataset.close).hidden = true; }));
$("#home-link").addEventListener("click", (e) => { e.preventDefault(); $("#about").hidden = true; state.filters = emptyFilters(); setQuery(""); });
$("#filters-toggle").addEventListener("click", () => {
  const box = $("#filters");
  box.classList.toggle("open");
  $("#filters-toggle").setAttribute("aria-expanded", String(box.classList.contains("open")));
});
start();
