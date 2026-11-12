/* Sending records to the visitor's own Zotero library through the Zotero web API, with a key the visitor creates in
   their Zotero account: a new collection named after the search, the records in it, 50 to a request. The key is kept
   for this visit only (sessionStorage) unless the visitor asks to remember it in this browser. */
import { $, h, fill, fmt, plural, local, toast } from "./util.js?v=43";
import { splitName } from "./cite.js?v=43";

const API = "https://api.zotero.org";
const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
const pause = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ------------------------------------------------------------------ the key */
const session = {
  get() { try { return sessionStorage.getItem("rf.zoteroKey") || ""; } catch { return ""; } },
  set(v) { try { if (v) sessionStorage.setItem("rf.zoteroKey", v); else sessionStorage.removeItem("rf.zoteroKey"); } catch { /* private window */ } },
};
export const zoteroKey = () => session.get() || local.get("zoteroKey", "");
export const zoteroRemembered = () => Boolean(local.get("zoteroKey", ""));
export function setZoteroKey(key, remember) {
  key = String(key || "").trim();
  session.set(remember ? "" : key);
  local.set("zoteroKey", remember ? key : null);
  who = null;
}

let who = null;           // { key, userID, username, write }
/* Whose key it is and whether it may write to their library. */
export async function zoteroWho(key = zoteroKey()) {
  if (!key) throw new Error("no Zotero key");
  if (who && who.key === key) return who;
  const r = await fetch(`${API}/keys/current`, { headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" } });
  if (r.status === 403) throw new Error("Zotero does not know this key");
  if (!r.ok) throw new Error(`Zotero answered HTTP ${r.status}`);
  const j = await r.json();
  const user = (j.access || {}).user || {};
  who = { key, userID: j.userID, username: j.username || "", write: Boolean(user.library && user.write) };
  return who;
}

/* ------------------------------------------------------------------ records as Zotero items */
const TYPES = { article: "journalArticle", review: "journalArticle", editorial: "journalArticle", letter: "journalArticle", erratum: "journalArticle",
  retraction: "journalArticle", preprint: "preprint", book: "book", monograph: "book", "book-chapter": "bookSection", dissertation: "thesis",
  dataset: "dataset", "conference-paper": "conferencePaper", "proceedings-article": "conferencePaper", report: "report" };
const itemType = (r) => (r.kind === "d" ? "dataset" : r.kind === "r" ? "report" : TYPES[r.type] || (r.kind === "t" ? "thesis" : r.kind === "a" ? "journalArticle" : "document"));

/* The fields each item type takes, from Zotero itself (asked once a visit), so that no item is refused for a field
   its type does not have. */
const fieldLists = new Map();
function fieldsOf(type) {
  if (!fieldLists.has(type)) {
    fieldLists.set(type, fetch(`${API}/itemTypeFields?itemType=${encodeURIComponent(type)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list) => new Set(list.map((f) => f.field)))
      .catch((e) => { fieldLists.delete(type); throw e; }));
  }
  return fieldLists.get(type);
}

const pages = (r) => (r.fpage && r.lpage && r.lpage !== r.fpage ? `${r.fpage}-${r.lpage}` : r.fpage || "");

/* notes(r): lines for Zotero's "Extra" field (an English title, a retraction). */
async function itemOf(r, collection, notes) {
  const type = itemType(r);
  const allowed = await fieldsOf(type);
  const fields = {
    title: r.title, abstractNote: r.full || r.abstract || "", date: r.date || (r.year ? String(r.year) : ""),
    url: r.doi ? `https://doi.org/${r.doi}` : r.url || r.landing || "", DOI: r.doi, language: r.lang, ISSN: r.issn,
    publicationTitle: r.venue, proceedingsTitle: r.venue, bookTitle: r.venue, repository: r.venue, university: r.venue,
    volume: r.volume, issue: r.issue, pages: pages(r), publisher: r.kind === "r" ? "ClinicalTrials.gov" : r.publisher || (type === "document" ? r.venue : ""),
    PMID: r.pmid, reportNumber: r.nct, reportType: r.kind === "r" ? "Study registration" : "", institution: r.kind === "r" ? "ClinicalTrials.gov" : r.venue,
    libraryCatalog: r.source,
  };
  const extra = [...notes(r), r.oa ? `OpenAlex: ${r.oa}` : "", r.pmid && !allowed.has("PMID") ? `PMID: ${r.pmid}` : "", r.nct ? `ClinicalTrials.gov: ${r.nct}` : ""].filter(Boolean);
  const item = { itemType: type, collections: [collection], tags: (r.keywords || []).slice(0, 10).map((tag) => ({ tag })), relations: {} };
  const people = (r.people || []).slice(0, 100).map((p) => {
    const n = splitName(p);
    return n.given ? { creatorType: "author", firstName: n.given, lastName: n.family } : { creatorType: "author", name: n.family };
  });
  item.creators = people.length ? people : r.org ? [{ creatorType: "author", name: r.org }] : [];
  for (const [k, v] of Object.entries(fields)) if (v && allowed.has(k)) item[k] = String(v);
  if (extra.length && allowed.has("extra")) item.extra = extra.join("\n");
  return item;
}

/* A write; waits when Zotero asks it to (Backoff, Retry-After) and tries again. */
async function write(path, body, key, tries = 0) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3", "Content-Type": "application/json",
      "Zotero-Write-Token": [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("") },
    body: JSON.stringify(body),
  });
  const wait = Number(r.headers.get("Retry-After") || r.headers.get("Backoff") || 0);
  if ((r.status === 429 || r.status === 503) && tries < 4) {
    await pause(Math.min(60, wait || 5 * (tries + 1)) * 1000);
    return write(path, body, key, tries + 1);
  }
  if (r.status === 403) throw new Error("Zotero refused: the key may not write to your library (create one with write access)");
  if (!r.ok) throw new Error(`Zotero answered HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  if (wait) await pause(Math.min(60, wait) * 1000);
  return r.json();
}

/* Sends the records into a new collection; { link, added, failed: [{ title, why }] }. */
export async function sendToZotero(records, { name, notes = () => [], onProgress = () => {} }) {
  const me = await zoteroWho();
  if (!me.write) throw new Error("this key may not write to your library: create a key with write access to your personal library");
  const base = `/users/${me.userID}`;
  onProgress(`Making the collection “${name}”…`);
  const made = await write(`${base}/collections`, [{ name: name.slice(0, 250) }], me.key);
  const collection = ((made.successful || {})["0"] || {}).key || (made.success || {})["0"];
  if (!collection) throw new Error(`Zotero did not make the collection${made.failed && made.failed["0"] ? `: ${made.failed["0"].message}` : ""}`);
  let added = 0;
  const failed = [];
  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50);
    onProgress(`Sending to Zotero: ${fmt(i)} of ${fmt(records.length)}…`);
    const items = await Promise.all(batch.map((r) => itemOf(r, collection, notes)));
    const res = await write(`${base}/items`, items, me.key);
    added += Object.keys(res.successful || res.success || {}).length + Object.keys(res.unchanged || {}).length;
    for (const [at, f] of Object.entries(res.failed || {})) failed.push({ title: batch[Number(at)].title, why: f.message || `code ${f.code}` });
  }
  return { link: me.username ? `https://www.zotero.org/${encodeURIComponent(me.username)}/collections/${collection}` : "https://www.zotero.org/mylibrary", added, failed };
}

/* ------------------------------------------------------------------ the form for the key, and the dialog */
/* The key's field, "remember", and a check of the key; onReady(who) once it works. */
export function keyForm(onReady = () => {}) {
  const input = h("input", { type: "password", id: "zotero-key", autocomplete: "off", spellcheck: "false", value: zoteroKey(), placeholder: "your Zotero API key" });
  const remember = h("input", { type: "checkbox", checked: zoteroRemembered() });
  const status = h("p", { class: "note", role: "status" });
  const check = async () => {
    const key = input.value.trim();
    setZoteroKey(key, remember.checked);
    if (!key) { fill(status, "No key: Research Finder cannot send anything to Zotero."); return; }
    fill(status, spinner(), " Checking the key with Zotero…");
    try {
      const me = await zoteroWho(key);
      fill(status, me.write ? `Works: Research Finder can add items to ${me.username ? `${me.username}'s` : "your"} library.`
        : "This key can read your library but not write to it: create one with “Allow write access”.");
      if (me.write) onReady(me);
    } catch (e) {
      fill(status, `This key does not work: ${e.message}.`);
    }
  };
  remember.addEventListener("change", () => setZoteroKey(input.value, remember.checked));
  if (input.value) check();
  return [
    h("p", { class: "note" }, "Create a key in your Zotero account (",
      h("a", { href: "https://www.zotero.org/settings/keys/new", target: "_blank", rel: "noopener noreferrer" }, "zotero.org › Settings › Security › Create new private key"),
      ") with “Allow library access” and “Allow write access” for your personal library, and paste it here. It goes only to Zotero. Unless you ask to remember it, it is forgotten when you close this tab; you can delete the key at zotero.org at any time."),
    h("div", { class: "relay-row" }, input, h("button", { type: "button", class: "btn btn-small", onclick: check }, "Check")),
    h("label", { class: "f-option" }, remember, "Remember it in this browser"),
    status,
  ];
}

/* The dialog: the collection's name, then the records go to Zotero. */
export function openZotero(records, { name, notes }) {
  const d = $("#tools");
  fill($("#tools-title"), "Send to Zotero");
  const out = h("div", { class: "tools-out", role: "status", "aria-live": "polite" });
  const nameInput = h("input", { type: "text", id: "zotero-collection", value: name, "aria-label": "Name of the new collection", spellcheck: "false" });
  const go = h("button", { type: "button", class: "btn btn-primary" }, `Send ${plural(records.length, "item")}`);
  const sendPart = h("div", { hidden: !zoteroKey() },
    h("label", { for: "zotero-collection", class: "tools-label" }, "Into a new collection"), nameInput,
    h("div", { class: "save-actions" }, go), out);
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const res = await sendToZotero(records, { name: nameInput.value.trim() || name, notes, onProgress: (m) => fill(out, h("p", { class: "note pending" }, spinner(), m)) });
      fill(out, h("p", {}, h("strong", {}, `Sent ${plural(res.added, "item")} to Zotero. `),
        h("a", { href: res.link, target: "_blank", rel: "noopener noreferrer" }, "Open the collection"),
        " (your Zotero app shows it after its next sync)."),
        res.failed.length ? [h("p", { class: "note warn" }, `${plural(res.failed.length, "item")} could not be added:`),
          h("ul", { class: "why-list" }, res.failed.slice(0, 10).map((f) => h("li", {}, `${f.title}: ${f.why}`)))] : null);
      toast(`Sent ${plural(res.added, "item")} to Zotero`);
    } catch (e) {
      fill(out, h("p", { class: "note warn" }, `Not sent: ${e.message}.`));
    } finally {
      go.disabled = false;
    }
  });
  fill($("#tools-body"),
    h("p", {}, `${plural(records.length, "item")} go into your own Zotero library, in a new collection, each with its abstract, authors, journal, DOI and keywords${records.some((r) => r.kind === "r") ? " (registered studies as reports)" : ""}. Zotero adds the PDFs it can find when you ask it (Find Available PDF).`),
    h("details", { class: "relay-guide", open: !zoteroKey() }, h("summary", {}, "Your Zotero key"), keyForm(() => { sendPart.hidden = false; })),
    sendPart);
  if (!d.open) d.showModal();
}
