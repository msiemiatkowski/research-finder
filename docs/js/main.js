/* Research Finder: the page. */
import { CONFIG } from "../config.js?v=34";
import { $, h, fill, fmt, plural, norm, escapeRe, NO_SPACES, safeUrl, local, toast } from "./util.js?v=34";
import { LANGS, LANG_NAMES, SRC_LABEL, SAMPLE, parseInput, makeGroup, enrich, activeTerms, isTranslation, translateGroup } from "./terms.js?v=34";
import { SOURCES, KIND_NAMES, REPO_NAMES, booleanQuery, repoQueries, maxParts, semanticScholarPdfs, pdfLinks, datasetFiles,
  relayAddress, needsRelay, relayed, checkRelay } from "./sources.js?v=34";
import { translationsOn, languageOf, languageName, knownTitle, translateTitle, translateText, titleLanguage, englishTitle, englishTitles,
  SAVE_TRANSLATIONS } from "./translate.js?v=34";
import { driveConfigured, driveConnected, connect, disconnect, saveSearch, onDriveChange, listSaves, readSave, fillSave } from "./drive.js?v=34";

const LIVE_WAIT = 40000;          // longest wait for the wordings and translations before searching anyway
const PAGE_SIZE = { studies: 25, data: 8 };
const emptyFilters = () => ({ kinds: [], langs: [], from: null, to: null, open: false, repos: [], fulltext: false });
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

function renderRecord(r) {
  const href = r.doi ? `https://doi.org/${r.doi}` : safeUrl(r.url) || safeUrl(r.pdf);
  const lang = r.lang && r.lang !== "en" ? languageName(r.lang) : "";
  const from = translationsOn() ? titleLanguage(r) : "";
  const li = h("li", { class: "result" },
    h("div", { class: "r-top" },
      h("span", { class: `badge kind-${r.kind}` }, KIND_NAMES[r.kind] || "Record"),
      r.year ? h("span", {}, r.year) : null,
      lang ? h("span", { class: "badge" }, lang) : null,
      r.open ? h("span", { class: "badge open", title: "Free to read or download" }, "Open") : null,
      r.cited ? h("span", { title: "Times cited" }, `${fmt(r.cited)} citations`) : null,
      r.files && r.files.length ? h("span", { title: "Open data files" }, plural(r.files.length, "file")) : null,
      h("span", { class: "src" }, r.source)),
    h("h3", { lang: from || null }, href ? link(href, marked(r.title, highlight)) : h("span", {}, marked(r.title, highlight))),
    from ? titleInEnglish(r, from) : null,
    [r.authors, r.venue].filter(Boolean).length ? h("div", { class: "byline" }, [r.authors, r.venue].filter(Boolean).join(" · ")) : null,
    abstractOf(r));
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
  const data = state.tab === "data";
  const under = status ? null
    : data && extra.totals ? h("small", {}, Object.entries(extra.totals).map(([n, c]) => `${n} ${fmt(c)}`).join(" · "))
      : split ? h("small", { title: `The terms did not fit in one OpenAlex search (1,500 characters), so Research Finder made ${extra.parts} searches and put their results together. The total counts a study found by two of them twice.` },
        `from ${extra.parts} searches put together: the terms do not fit in one`) : null;
  fill(bar,
    h("div", { class: "tb-main" },
      h("p", { class: "count" }, status || `${split ? "About " : ""}${plural(total, data ? "dataset" : "study", data ? "datasets" : "studies")}`, under),
      results.length ? h("button", { type: "button", class: "btn btn-primary tb-save", onclick: openSave, title: "Save the results, open PDFs and data files to your Google Drive" }, "Save to Google Drive") : null),
    h("div", { class: "tb-tools" },
      h("select", { "aria-label": "Sort", onchange: (e) => { state.sort = e.target.value; search(0); } },
        src.sorts.map(([v, l]) => h("option", { value: v, selected: state.sort === v }, l))),
      h("button", { type: "button", class: "btn btn-small", onclick: copySearchString, title: "Copy the terms as a Boolean search string" }, "Copy search string"),
      externalMenu(),
      results.length ? menu("Export ▾", [
        ["Spreadsheet (CSV)", exportCsv],
        ["References (RIS) for Zotero, EndNote, Rayyan, Covidence or ASReview", exportRis],
      ], "Download the results shown, with their abstracts") : null));
  const settings = (label) => h("button", { type: "button", class: "btn btn-small", onclick: openSettings }, label);
  const msgs = notes.map((text) => ({ text, warn: true }));
  if (extra.dropped && !data) {
    const key = local.get("openalexKey", "");
    msgs.push({
      text: `A long search: ${plural(extra.dropped, "term")} did not fit and ${extra.dropped === 1 ? "was" : "were"} left out. English terms and the languages with the most research come first. `
        + (key ? "Fewer languages make room for the ones you need." : "A free OpenAlex key makes room for more of them."),
      actions: [key ? null : settings("Add a key"), settings("Choose languages")],
    });
  } else if (extra.dropped) {
    msgs.push({ text: `${plural(extra.dropped, "term")} left out: the query would be too long for the repositories. The English terms and the languages with the most research come first.` });
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
]);

/* One row per result, the same columns for every source; while translations are on, a title in another language has
   its English next to it. */
const EN_TITLE = "Title in English (automatic translation)";
const COLUMNS = ["No.", "Title", "Abstract", "Authors", "Year", "Type", "Journal or repository", "DOI", "Link", "Open PDF", "Language", "Keywords", "Source", "Citations", "License", "Size"];
const header = (en) => (en ? [COLUMNS[0], COLUMNS[1], EN_TITLE, ...COLUMNS.slice(2)] : COLUMNS);
function rowOf(r, i, en) {
  const row = [i + 1, r.title, r.full || r.abstract || "", r.authors, r.year || "", KIND_NAMES[r.kind] || "", r.venue, r.doi ? `https://doi.org/${r.doi}` : "",
    r.url || r.landing || "", r.pdf, r.lang, (r.keywords || []).join("; "), r.source, r.cited || "", r.license || "", r.size || ""];
  if (en) row.splice(2, 0, englishTitle(r));
  return row;
}

/* The same results as a RIS file, which reference managers (Zotero, EndNote, Mendeley) and screening tools (Rayyan,
   Covidence, ASReview) import. */
const RIS_TYPES = { article: "JOUR", review: "JOUR", editorial: "JOUR", letter: "JOUR", preprint: "UNPB", book: "BOOK", monograph: "BOOK",
  "book-chapter": "CHAP", dissertation: "THES", dataset: "DATA" };
function risOf(records, en = translationsOn()) {
  const tag = (t, v) => (v == null || v === "" ? "" : `${t}  - ${String(v).replace(/\s+/g, " ").trim()}\r\n`);
  // the English of a title goes into a note that says what it is (Zotero would file a "translated title" unlabelled)
  const english = (r) => { const t = en ? englishTitle(r) : ""; return t ? `Title in English, an automatic translation (Wikimedia MinT), not a professional one: ${t}` : ""; };
  return records.map((r) => [
    tag("TY", r.kind === "d" ? "DATA" : RIS_TYPES[r.type] || "GEN"),
    tag("TI", r.title),
    ...(r.people || []).map((p) => tag("AU", p)),
    tag("PY", r.year || ""),
    tag("DA", (r.date || "").slice(0, 10).replace(/-/g, "/")),
    tag(r.kind === "d" ? "PB" : "T2", r.venue),
    tag("AB", r.full || r.abstract),
    ...(r.keywords || []).map((k) => tag("KW", k)),
    tag("DO", r.doi),
    tag("UR", r.doi ? `https://doi.org/${r.doi}` : safeUrl(r.url || r.landing)),
    tag("LA", r.lang === "en" ? "English" : LANG_NAMES[r.lang] || r.lang),
    tag("DB", r.source),
    tag("N1", english(r)),
    "ER  - \r\n",
  ].join("")).join("\r\n");
}

function downloadFile(name, text, type) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(`Exported ${plural(results.length, "result")}${more ? ", the ones loaded so far (Save to Google Drive can save all of them)" : ""}`, 4000);
}
const fileDate = () => new Date().toISOString().slice(0, 10);

/* Before an export, the English of the titles in other languages among the results shown (most are translated already). */
async function englishFirst(records) {
  if (!translationsOn()) return;
  const slow = setTimeout(() => toast("Translating the titles in other languages into English…", 10000), 500);
  try { await englishTitles(records); } finally { clearTimeout(slow); }
}

async function exportCsv() {
  await englishFirst(results);
  const en = translationsOn();
  const cell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header(en), ...results.map((r, i) => rowOf(r, i, en))].map((r) => r.map(cell).join(",")).join("\r\n");
  downloadFile(`research-finder-${fileDate()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
}
async function exportRis() {
  await englishFirst(results);
  downloadFile(`research-finder-${fileDate()}.ris`, risOf(results), "application/x-research-info-systems");
}

/* ------------------------------------------------------------------ saving to Google Drive */
const MB = 1e6;
const sizeName = (bytes) => (bytes >= 1e9 ? `${bytes / 1e9} GB` : `${bytes / MB} MB`);

function openSave() {
  const d = $("#save");
  if (!driveConfigured()) { toast("Saving to Google Drive is not set up on this copy of the site.", 4000); return; }
  const studiesTab = state.tab === "studies";
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
        translationsOn() ? ", and an automatic English translation of titles in other languages" : ""),
      h("li", {}, h("strong", {}, "Results.ris"), " — the same results as a reference file, to import into Zotero, EndNote, Mendeley, Rayyan, Covidence or ASReview"),
      h("li", {}, h("strong", {}, "Files"), " — a Google Sheet with every file found: its download link, and whether it was saved (and if not, why)"),
      h("li", {}, h("strong", {}, "Search details"), " — a document with your keywords, every term and translation used, the filters and the exact queries, so the search can be repeated"),
      studiesTab ? h("li", {}, h("strong", {}, "Papers/"), " — the open PDFs (also open versions found through Semantic Scholar, such as arXiv preprints)")
        : h("li", {}, h("strong", {}, "Datasets/"), " — one folder per dataset with its open data files")),
    h("p", { class: "save-row" }, h("label", { for: "save-count" }, "Save "), howMany, h("span", {}, ` of ${fmt(total)} results`)),
    sizeNote,
    h("p", { class: "save-row" }, h("label", {}, files, studiesTab ? " Save the open PDFs" : " Save the open data files")),
    h("p", { class: "save-row" }, h("span", {}, "Up to"), totalLimit, h("span", {}, "in all, files up to"), fileLimit, h("span", {}, "each")),
    studiesTab ? pdfNote : h("p", { class: "note" }, relayAddress()
        ? "Zenodo and Harvard Dataverse files are copied into your Drive, and OSF and figshare files through your file relay. For other repositories the sheet links to the dataset's page."
        : ["Zenodo and Harvard Dataverse files are copied into your Drive. OSF and figshare do not let browsers download files, so theirs are listed with their download links in “Files” (",
          h("button", { type: "button", class: "link-btn", onclick: () => { d.close(); openSettings(); } }, "connect a file relay"),
          " to copy them too). For other repositories the sheet links to the dataset's page."]),
    h("p", { class: "note" }, "A large save takes a while: keep this tab open. Your Drive needs to be connected: Google asks you to allow access the first time, and to connect again if a save takes more than an hour."),
    h("div", { class: "save-actions" },
      h("button", { type: "button", class: "btn btn-primary", id: "save-go", onclick: () => runSave(Number(howMany.value), files.checked, Number(fileLimit.value), Number(totalLimit.value)) }, "Save to my Drive")),
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
    const english = translationsOn()
      ? await englishTitles(rows, { onProgress: (n, of) => progress(`Translating the titles in other languages into English: ${fmt(n)} of ${fmt(of)}…`) }) : null;
    const jobs = [], relay = relayAddress();
    // a relay that fetches publishers' PDFs too (version 2) is asked for every PDF the browser cannot get itself
    const pdfRelay = relay && withFiles && state.tab === "studies" && (await checkRelay(relay)).pdf;
    if (relay && withFiles && state.tab === "studies") local.set("relayPdf", pdfRelay ? "1" : "");
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
      await pool(jobs, 4, async (j) => {
        j.urls = await pdfLinks(j.urls);
        j.source = j.urls[0];
        if (pdfRelay) j.urls = [...j.urls.filter((u) => !needsRelay(u)), ...j.urls.map(relayed)];
        else if (relay) j.urls = j.urls.map((u) => (needsRelay(u) ? relayed(u) : u));
      });
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
          jobs.push({ row: i, kind: "data", urls: [f.relay && relay ? relayed(f.url) : f.url], source: f.url, name: f.name, size: f.size || 0,
            copy: !f.relay || Boolean(relay), repo: repoOf(f.url) || r.source, dataset: `${r.year || "n.d."} ${r.title.slice(0, 80)}`, title: r.title });
        }
      });
    }
    const title = `${state.input} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const res = await saveSearch({
      title, header: header(Boolean(english)), rows: rows.map((r, i) => rowOf(r, i, Boolean(english))), ris: risOf(rows, Boolean(english)), jobs, maxFile,
      maxTotal: Math.max(maxTotal, maxFile), onProgress: progress,
      detailsHtml: (stats) => detailsHtml(rows.length, jobs.length, stats, gotNotes, english),
      onSignIn: () => new Promise((resolve, reject) => {
        fill($("#save-signin"), h("p", { class: "note warn" }, "Google's sign-in has run out (it lasts an hour). "),
          h("button", { type: "button", class: "btn btn-small btn-primary", onclick: async () => {
            try { await connect(); fill($("#save-signin")); resolve(); } catch (e) { reject(e); }
          } }, "Connect again and continue"));
      }),
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
        " can try them again later.") : null));
    fill($("#drive-result"), h("p", {}, "Saved in your Google Drive: ", links()));
    $("#drive-result").hidden = false;
  } catch (e) {
    fill($("#save-progress"), h("p", { class: "note warn" }, `Not saved: ${e.message}`));
  } finally {
    go.disabled = false;
  }
}

/* ------------------------------------------------------------------ earlier saves */
/* Adds to an earlier save the files it did not copy (a site that does not let browsers download them, a size limit, an
   interruption): reads the save's sheet "Files", tries those files again (through the file relay where it helps), puts
   the new ones into the save's own folders and updates "Files", "Results" and "Search details". */
const FILE_COLUMNS = ["Result no.", "Result", "File", "Size (MB)", "Repository", "Download link", "Saved in Drive", "Not saved because"];

async function openEarlier() {
  const d = $("#earlier"), body = $("#earlier-body");
  if (!d.open) d.showModal();
  const intro = h("p", {}, "Add to an earlier save the files it did not copy: for example the PDFs a file relay can fetch, or files a size limit left out. New files go into the save's own folders, and its sheets “Files” and “Results” and its “Search details” are updated.");
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
  } catch (e) {
    fill(box, h("p", { class: "note warn" }, `This save could not be read: ${e.message}`));
    return;
  }
  if ($("#earlier-pick").value !== save.id) return;   // another save was chosen meanwhile
  const say = (text, cls = "note") => fill(box, h("p", { class: cls }, text));
  if (!s.files) return say("This save has no sheet “Files”, so Research Finder cannot tell which files are missing (saves made with the first versions, before 2 November 2026, have none).");
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
  fill(box,
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
    ] : h("p", { class: "note" }, "Every file of this save is in your Drive."));
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
function detailsHtml(nRows, nJobs, stats, gotNotes = [], english = null) {
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
<p>${fmt(total)} results found${state.tab === "data" ? " (a dataset kept in two repositories counts twice)" : extra.parts > 1 ? " (a study found by two of the searches counts twice)" : ""}; ${fmt(nRows)} saved in “Results” and in the reference file “Results.ris”, in the order shown (${esc((src.sorts.find(([v]) => v === state.sort) || ["", "Best match"])[1])}), each once.</p>
${gotNotes.length ? `<p>${gotNotes.map(esc).join(" ")}</p>` : ""}
<p>Files: ${fmt(stats.papers)} PDFs and ${fmt(stats.dataFiles)} data files saved (${(stats.bytes / MB).toFixed(1)} MB), of ${fmt(nJobs)} found; the sheet “Files” lists every one.${listedOnly ? ` ${fmt(listedOnly)} are in repositories that do not let browsers download files (OSF, figshare): the sheet has their download links.` : ""}${stats.relayed ? ` ${fmt(stats.relayed)} of the files saved came through the file relay ${esc(relayAddress())}, because their sites do not let browsers download them.` : ""}</p>
${failed ? `<p>Not saved:</p><ul>${failed}</ul>` : ""}
${english && english.foreign ? `<h2>Titles in other languages</h2>
<p>${fmt(english.foreign)} of the results saved have a title in another language. ${fmt(english.shown)} of them have an automatic English translation in the column “${EN_TITLE}” of “Results”, and in a note in “Results.ris”, made by Wikimedia's open machine translation (MinT) and checked by translating it back into the original language${english.failed ? `; ${fmt(english.failed)} did not pass that check and have none` : ""}${english.same ? `; ${fmt(english.same)} needed none, as their title says it in English too` : ""}${english.missing ? `; ${fmt(english.missing)} were not translated, because MinT did not answer or a save translates at most ${fmt(SAVE_TRANSLATIONS)}` : ""}. These are machine translations, not professional ones: use them to see what a study is about, and the original titles to screen and to cite.</p>` : ""}
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
    h("h3", {}, h("label", { for: "set-mail" }, "Your email (optional)")),
    h("p", { class: "note" }, "Sent only to OpenAlex with your searches, as their guidelines ask; kept only in this browser."), mail,
    h("h3", {}, "Other services"),
    h("p", { class: "note" }, "No other keys are needed. Wikidata, Wikimedia's MinT translation, DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE are free and open. Machine translations are remembered in this browser, so each term and title is translated only once. Semantic Scholar, which Research Finder asks for open PDFs when you save, does not accept keys sent from web pages, so it is asked without one."));
  if (relay.value.trim()) check();
  d.onclose = () => {
    local.set("relay", relay.value.trim());
    local.set("openalexKey", key.value.trim());
    local.set("email", mail.value.trim());
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
    h("h3", {}, "What is saved"),
    h("p", {}, "Each saved search becomes a folder inside “Research Finder” in your Drive: the sheet “Results” (one row per result, with its abstract, in the same columns for every source, and an automatic English translation of titles in other languages), the same results as “Results.ris” for reference managers and screening tools, the sheet “Files” (every file found, its download link and whether it was saved), the document “Search details”, and the open PDFs and data files in their own folders."),
    h("h3", {}, "Reporting a search"),
    h("p", {}, "The document “Search details” in each saved folder has what a methods section and a search appendix need:"),
    h("ul", {},
      h("li", {}, "the sources: OpenAlex, or the data repositories, searched through Research Finder;"),
      h("li", {}, "the date of the search;"),
      h("li", {}, "every term and translation, and the exact queries sent;"),
      h("li", {}, "the limits: where in the records it searched, and the years, types and languages chosen;"),
      h("li", {}, "the number of records found and saved, for the flow diagram.")),
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
  if (f.langs.length) p.set("lang", f.langs.join(","));
  if (f.repos.length) p.set("repos", f.repos.join(","));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.open) p.set("open", "1");
  if (f.fulltext) p.set("fulltext", "1");
  const s = p.toString();
  const url = s ? `#${s}` : location.pathname + location.search;
  if (pushNext && location.hash !== (s ? `#${s}` : "")) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  pushNext = false;
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
  fill($("#foot-credit"), "Created by ", h("a", { href: "#about", onclick: openAbout }, c.name),
    c.affiliation ? ` (${c.affiliation})` : "", c.email ? [" · ", h("a", { href: `mailto:${c.email}` }, c.email)] : null);
}

/* ------------------------------------------------------------------ start */
function start() {
  renderCredit();
  renderMaker();
  const panel = fromHash();
  renderTabs();
  renderFilters();
  if (state.input) setQuery(state.input);
  else search(0);
  if (panel) { renderAbout(); $("#about").hidden = false; }
}

window.addEventListener("popstate", () => {
  const panel = fromHash();
  renderTabs();
  renderFilters();
  setQuery(state.input, true);
  if (panel) { renderAbout(); $("#about").hidden = false; }
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
$("#save-close").addEventListener("click", () => $("#save").close());
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); setQuery($("#q").value); });
document.querySelectorAll(".example").forEach((b) => b.addEventListener("click", () => {
  setQuery(b.dataset.q || b.textContent);
  window.scrollTo({ top: 0, behavior: "smooth" });
}));
$("#more").addEventListener("click", showMore);
$("#about-link").addEventListener("click", openAbout);
document.querySelectorAll(".close-panel").forEach((b) => b.addEventListener("click", () => { $("#" + b.dataset.close).hidden = true; }));
$("#home-link").addEventListener("click", (e) => { e.preventDefault(); $("#about").hidden = true; state.filters = emptyFilters(); setQuery(""); });
$("#filters-toggle").addEventListener("click", () => {
  const box = $("#filters");
  box.classList.toggle("open");
  $("#filters-toggle").setAttribute("aria-expanded", String(box.classList.contains("open")));
});
start();
