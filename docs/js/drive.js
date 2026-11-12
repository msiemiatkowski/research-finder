/* Saving to the visitor's own Google Drive. Sign-in uses Google's own window (Google Identity Services) and asks
   only for the "drive.file" permission: the app can see and change only the files it creates itself. Nothing goes
   through a server of ours: the browser talks to Google directly.

   Each saved search becomes one folder inside "Research Finder":
     <keywords> — <date>/
       Results            Google Sheet: one row per result, the same columns for every source, links to saved files
       Results.ris        the same results for reference managers and screening tools (Zotero, Rayyan, Covidence...)
       Files             Google Sheet: every file found, with its download link and whether it was saved
       Search details     Google Doc: where and how the search was made (keywords, every term, filters, the queries)
       PRISMA flow diagram.svg
       Research Finder search.json   the search and which results were saved, to run it again and add what is new
       Papers/            the open PDFs the browser may download
       Datasets/<title>/  the open data files of each dataset
     and, each time the search is run again, "New results <date>" (a sheet and a RIS file) with only the new ones. */
import { CONFIG } from "../config.js?v=40";
import { parseCsv } from "./util.js?v=40";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "application/vnd.google-apps.folder";
const SHEET = "application/vnd.google-apps.spreadsheet";
const DOC = "application/vnd.google-apps.document";
const SIMPLE_UPLOAD = 5 * 1024 * 1024;      // larger files go up in a resumable upload
let token = null;               // { access_token, expires_at }
let rootId = null;
let signIn = null;              // while saving: asks the visitor to connect again when the sign-in has run out
let pending = null;
const listeners = [];

export const driveConfigured = () => Boolean(CONFIG.googleClientId);
export const driveConnected = () => Boolean(token && token.expires_at > Date.now());
export const onDriveChange = (fn) => listeners.push(fn);
const changed = () => listeners.forEach((fn) => fn(driveConnected()));

function loadGoogle() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load Google sign-in"));
    document.head.append(s);
  });
}

export async function connect() {
  if (!driveConfigured()) throw new Error("saving to Google Drive is not set up on this site yet");
  await loadGoogle();
  await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.googleClientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = { access_token: r.access_token, expires_at: Date.now() + (Number(r.expires_in || 3600) - 60) * 1000 };
        resolve();
      },
      error_callback: (e) => reject(new Error(e && e.type === "popup_closed" ? "the Google window was closed" : (e && e.message) || "sign-in failed")),
    });
    client.requestAccessToken({ prompt: "" });          // asks for consent only the first time
  });
  changed();
}

export function disconnect() {
  if (token && window.google) window.google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null;
  rootId = null;
  changed();
}

/* A sign-in lasts an hour. When it runs out during a long save, the save waits until the visitor connects again
   (Google's window needs a click). */
async function ready() {
  if (driveConnected()) return;
  if (!pending) pending = (signIn ? signIn() : connect()).finally(() => { pending = null; });
  await pending;
}

async function apiRaw(path, opts = {}, again = true) {
  await ready();
  const r = await fetch(`https://www.googleapis.com${path}`, {
    ...opts, headers: { Authorization: `Bearer ${token.access_token}`, ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    token = null;
    changed();
    if (again) return apiRaw(path, opts, false);
    throw new Error("the Google sign-in expired; connect again");
  }
  if (!r.ok) throw new Error(`Google Drive answered HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r;
}
const api = async (path, opts = {}) => (await apiRaw(path, opts)).json();

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
const makeFolder = (name, parent) => api("/drive/v3/files?fields=id,webViewLink", json({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }));

async function appFolder() {
  if (rootId) return rootId;
  const q = encodeURIComponent(`name='Research Finder' and mimeType='${FOLDER}' and trashed=false`);
  const found = await api(`/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
  if (found.files && found.files.length) return (rootId = found.files[0].id);
  return (rootId = (await makeFolder("Research Finder")).id);
}

/* A large file goes up in two steps: Google gives an address for it, then the file is sent there. */
async function resumable(method, url, meta, blob) {
  await ready();
  const start = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": blob.type || "application/octet-stream", "X-Upload-Content-Length": String(blob.size) },
    body: JSON.stringify(meta),
  });
  const where = start.ok && start.headers.get("Location");
  if (!where) throw new Error(`Google Drive did not start the upload (HTTP ${start.status})`);
  const r = await fetch(where, { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
  if (!r.ok) throw new Error(`Google Drive answered HTTP ${r.status} to the upload`);
  return r.json();
}

async function upload(meta, blob) {
  if (blob.size > SIMPLE_UPLOAD) return resumable("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink", meta, blob);
  const b = `rf${Math.random().toString(36).slice(2)}`;
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
    blob, `\r\n--${b}--`]);
  return api("/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
}

/* New content for a file the app made; a Google Sheet takes a CSV, a Google Doc HTML (Google converts them). */
function replaceContent(id, blob) {
  if (blob.size > SIMPLE_UPLOAD) return resumable("PATCH", `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=resumable&fields=id,webViewLink`, {}, blob);
  return api(`/upload/drive/v3/files/${id}?uploadType=media&fields=id,webViewLink`, { method: "PATCH", headers: { "Content-Type": blob.type }, body: blob });
}

const viaRelay = (url) => /\/\?url=/.test(url);

/* A file the browser may download, within maxBytes; at least a minute, more for large files (100 kB/s). A site that
   asks to wait (HTTP 429) is asked twice more, after the time it gives (at most 30 seconds). */
async function download(url, maxBytes, size = 0, tries = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), size ? Math.max(60000, size / 100) : 600000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 429 && tries < 2) {
      const wait = Math.min(30, Number(r.headers.get("Retry-After")) || 5 * (tries + 1));
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return download(url, maxBytes, size, tries + 1);
    }
    if (r.status >= 400 && /json/.test(r.headers.get("Content-Type") || "") && viaRelay(url)) {
      const why = await r.json().then((j) => j.error, () => "");
      if (why) throw new Error(`the file relay answered: ${why}`);
    }
    if (r.status >= 400 && viaRelay(url)) throw new Error(`the file relay answered HTTP ${r.status}`);
    if (r.status !== 200 && r.status !== 203) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get("Content-Length") || 0) > maxBytes) throw new Error("too large");
    const blob = await r.blob();
    if (blob.size > maxBytes) throw new Error("too large");
    if (!blob.size) throw new Error("empty");
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

const clean = (s, n = 90) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n).trim() || "file";
const csvOf = (rows) => rows.map((r) => r.map((v) => {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(",")).join("\r\n");

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/* Copies the files of `jobs` into a save's folder: PDFs into Papers/, data files into Datasets/<dataset>/ (folders made
   when first needed; `folders` holds the ones that already exist). Sets job.link, or job.why when a file was not
   saved. */
async function copyFiles(jobs, { folderId, folders = {}, maxFile, maxTotal, onProgress }) {
  const within = (key, name, parent) => (folders[key] = folders[key] || makeFolder(name, parent).then((f) => f.id));
  let bytes = 0, papers = 0, dataFiles = 0, relayed = 0, done = 0;
  const failed = [];
  const fail = (job, why) => { job.why = why; failed.push(job); };
  const save = async (job) => {
    if (job.copy === false) return fail(job, `${job.repo || "The repository"} does not let browsers download files: use the link, or connect a file relay (Settings)`);
    if (job.size > maxFile) return fail(job, "larger than the size limit");
    if (bytes + (job.size || 0) > maxTotal) return fail(job, "the total size limit was reached");
    let blob = null, why = "the site does not let browsers download it", from = "";
    for (const url of job.urls) {
      try {
        const b = await download(url, Math.min(maxFile, maxTotal - bytes), job.size);
        if (job.kind === "paper") {
          const head = new Uint8Array(await b.slice(0, 5).arrayBuffer());
          if (String.fromCharCode(...head) !== "%PDF-") { why = "the link gave a web page, not the PDF"; continue; }
        }
        blob = b;
        from = url;
        break;
      } catch (e) {
        why = e.message === "too large" ? "larger than the size limit" : /^the file relay/.test(e.message) ? e.message
          : !viaRelay(url) ? why : e.name === "AbortError" ? "the file relay took too long to answer"
            : "the file relay did not answer (trying again later may work)";
      }
    }
    if (!blob) return fail(job, why);
    try {
      const parent = job.kind === "paper"
        ? await within("papers", "Papers", folderId)
        : await within(`d:${clean(job.dataset, 100)}`, clean(job.dataset, 100), await within("datasets", "Datasets", folderId));
      const file = await upload({ name: clean(job.name, 150), parents: [parent] },
        job.kind === "paper" ? new Blob([blob], { type: "application/pdf" }) : blob);
      job.link = file.webViewLink;
      job.why = "";
      bytes += blob.size;
      if (job.kind === "paper") papers++; else dataFiles++;
      if (viaRelay(from)) relayed++;
    } catch (e) {
      fail(job, e.message);
    }
  };
  await pool(jobs, 3, async (job) => {
    await save(job);
    onProgress(`Saving files: ${fmtN(++done)} of ${fmtN(jobs.length)}${bytes ? ` (${(bytes / 1e6).toFixed(0)} MB so far)` : ""}`);
  });
  return { papers, dataFiles, bytes, relayed, failed };
}

const FILES_HEADER = ["Result no.", "Result", "File", "Size (MB)", "Repository", "Download link", "Saved in Drive", "Not saved because"];
export const RECORD = "Research Finder search.json";

/* A table as a Google Sheet; one too large for Google to turn into a sheet is kept as a CSV file instead (csv: true). */
async function table(name, list, parent) {
  const blob = new Blob([csvOf(list)], { type: "text/csv" });
  try {
    return { ...(await upload({ name, mimeType: SHEET, parents: [parent] }, blob)), csv: false };
  } catch (e) {
    if (/sign-in/.test(e.message)) throw e;
    return { ...(await upload({ name: `${name}.csv`, parents: [parent] }, blob)), csv: true };
  }
}
const fileRows = (jobs) => [FILES_HEADER,
  ...jobs.map((j) => [j.row + 1, j.title, j.name, j.size ? (j.size / 1e6).toFixed(2) : "", j.repo || "", j.source || j.urls[0] || "", j.link || "", j.link ? "" : j.why || ""])];
const jsonBlob = (x) => new Blob([JSON.stringify(x, null, 1)], { type: "application/json" });

/* jobs: [{ row, kind: "paper" | "data", urls, source, name, title, dataset, size, repo, copy }], every file found
   (copy: false when its repository does not let browsers download it and no file relay is connected: listed only;
   urls: the addresses to try in turn, some of them through the file relay; source: the file's own address); rows: the
   CSV's data rows, one per result (the "Saved in Drive" column is added here); ris: the same results as a RIS file, for
   reference managers and screening tools. extras: other files for the folder, [{ name, type, text }]. record: what
   Research Finder needs to run the search again (saved as RECORD). onSignIn: called when the sign-in runs out;
   resolves once connected again. */
export async function saveSearch({ title, header, rows, ris, jobs, detailsHtml, extras = [], tables = [], record = null, maxFile, maxTotal, onProgress = () => {}, onSignIn = null }) {
  signIn = onSignIn;
  try {
    const root = await appFolder();
    const folder = await makeFolder(clean(title, 120), root);
    const { papers, dataFiles, bytes, relayed, failed } = await copyFiles(jobs, { folderId: folder.id, maxFile, maxTotal, onProgress });
    const saved = rows.map(() => []);
    for (const j of jobs) if (j.link) saved[j.row].push(j.link);
    onProgress("Saving the results as a Google Sheet…");
    const sheet = await table("Results", [[...header, "Saved in Drive"], ...rows.map((r, i) => [...r, saved[i].join(" | ")])], folder.id);
    if (ris) await upload({ name: "Results.ris", parents: [folder.id] }, new Blob([ris], { type: "application/x-research-info-systems" }));
    let files = null;
    if (jobs.length) {
      onProgress("Listing every file in a sheet…");
      files = await table("Files", fileRows(jobs), folder.id);
    }
    for (const t of tables) await table(t.name, t.rows, folder.id);
    onProgress("Writing the search details…");
    const html = typeof detailsHtml === "function" ? detailsHtml({ papers, dataFiles, bytes, failed, relayed }) : detailsHtml;
    const doc = await upload({ name: "Search details", mimeType: DOC, parents: [folder.id] }, new Blob([html], { type: "text/html" }));
    for (const x of extras) await upload({ name: x.name, parents: [folder.id] }, new Blob([x.text], { type: x.type }));
    if (record) await upload({ name: RECORD, parents: [folder.id] }, jsonBlob(record));
    return { folder: folder.webViewLink, sheet: sheet.webViewLink, files: files && files.webViewLink, doc: doc.webViewLink,
      papers, dataFiles, bytes, failed, relayed, csv: sheet.csv || Boolean(files && files.csv) };
  } finally {
    signIn = null;
  }
}

/* ------------------------------------------------------------------ earlier saves */
async function children(id) {
  const out = [];
  let page = "";
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
    const j = await api(`/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,webViewLink,createdTime)&pageSize=1000&spaces=drive${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
    out.push(...(j.files || []));
    page = j.nextPageToken || "";
  } while (page);
  return out;
}

/* The searches saved so far, newest first: [{ id, name, created, link }]. */
export async function listSaves() {
  const root = await appFolder();
  return (await children(root)).filter((f) => f.mimeType === FOLDER)
    .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))
    .map((f) => ({ id: f.id, name: f.name, created: f.createdTime, link: f.webViewLink }));
}

const tableText = async (f) => (await apiRaw(f.mimeType === SHEET ? `/drive/v3/files/${f.id}/export?mimeType=text%2Fcsv` : `/drive/v3/files/${f.id}?alt=media`)).text();

/* What a save holds: its sheets "Files" and "Results" (and their rows), "Search details" and its Papers/ and Datasets/
   folders (and the dataset folders in that). A sheet Google cannot export (over 10 MB) is read as null. */
export async function readSave(save) {
  const kids = await children(save.id);
  const pick = (name) => kids.find((f) => f.name === name && f.mimeType === SHEET) || kids.find((f) => f.name === `${name}.csv`) || null;
  const folder = (name) => kids.find((f) => f.name === name && f.mimeType === FOLDER) || null;
  const files = pick("Files"), results = pick("Results"), datasets = folder("Datasets");
  const rowsOf = async (f) => {
    try { return f ? parseCsv(await tableText(f)) : null; } catch (e) { if (/sign-in/.test(e.message)) throw e; return null; }
  };
  const recordFile = kids.find((f) => f.name === RECORD) || null;
  let record = null;
  if (recordFile) {
    try { record = JSON.parse(await (await apiRaw(`/drive/v3/files/${recordFile.id}?alt=media`)).text()); } catch (e) { if (/sign-in/.test(e.message)) throw e; }
  }
  return {
    ...save, files, results, papers: folder("Papers"), datasets,
    details: kids.find((f) => f.name === "Search details" && f.mimeType === DOC) || null,
    datasetFolders: datasets ? (await children(datasets.id)).filter((f) => f.mimeType === FOLDER) : [],
    fileRows: await rowsOf(files), resultRows: await rowsOf(results),
    recordFile, record,
    // the sheets of earlier runs ("New results <date>"), whose results count as found before too
    added: await Promise.all(kids.filter((f) => /^New results \d{4}-\d{2}-\d{2}/.test(f.name) && !/\(files\)/.test(f.name) && (f.mimeType === SHEET || /\.csv$/.test(f.name)))
      .map(async (f) => ({ file: f, rows: await rowsOf(f) }))),
  };
}

/* A save's "Search details" as plain text ("" when it has none). */
export async function detailsText(save) {
  if (!save.details) return "";
  return (await apiRaw(`/drive/v3/files/${save.details.id}/export?mimeType=text%2Fplain`)).text();
}

/* A table with new rows; when Google does not take them in place, the new table is saved next to the old one. */
async function replaceTable(file, rows, parent) {
  const blob = new Blob([csvOf(rows)], { type: "text/csv" });
  try {
    return { ...(await replaceContent(file.id, blob)), replaced: true };
  } catch (e) {
    if (/sign-in/.test(e.message)) throw e;
    const name = `${file.name.replace(/\.csv$/, "")} (updated ${new Date().toISOString().slice(0, 10)})`;
    try {
      return await upload({ name, mimeType: SHEET, parents: [parent] }, blob);
    } catch {
      return upload({ name: `${name}.csv`, parents: [parent] }, blob);
    }
  }
}

/* Tries again the files a save did not copy (jobs as for saveSearch, plus `line`: the job's row in "Files"), puts the
   ones it gets into the save's folders, and updates "Files", the "Saved in Drive" column of "Results" and, with
   `note(stats)` (HTML), "Search details". */
export async function fillSave({ save, jobs, maxFile, maxTotal, note, onProgress = () => {}, onSignIn = null }) {
  signIn = onSignIn;
  try {
    const folders = {};
    if (save.papers) folders.papers = Promise.resolve(save.papers.id);
    if (save.datasets) folders.datasets = Promise.resolve(save.datasets.id);
    for (const f of save.datasetFolders) folders[`d:${f.name}`] = Promise.resolve(f.id);
    const stats = await copyFiles(jobs, { folderId: save.id, folders, maxFile, maxTotal, onProgress });
    onProgress("Updating the sheet “Files”…");
    const rows = save.fileRows.map((r) => [...r]);
    const col = (name) => rows[0].indexOf(name);
    for (const j of jobs) {
      const r = rows[j.line];
      while (r.length < rows[0].length) r.push("");
      r[col("Saved in Drive")] = j.link || "";
      r[col("Not saved because")] = j.link ? "" : j.why || "";
    }
    const out = { ...stats, files: await replaceTable(save.files, rows, save.id) };
    const added = jobs.filter((j) => j.link);
    if (added.length && save.results && save.resultRows) {
      onProgress("Adding the new links to “Results”…");
      try {
        const res = save.resultRows.map((r) => [...r]);
        const c = res[0].indexOf("Saved in Drive");
        if (c < 0) throw new Error("the sheet has no column “Saved in Drive”");
        for (const j of added) {
          const r = res[j.row + 1];
          if (!r) continue;
          while (r.length <= c) r.push("");
          r[c] = [r[c], j.link].filter(Boolean).join(" | ");
        }
        out.results = await replaceTable(save.results, res, save.id);
      } catch (e) {
        if (/sign-in/.test(e.message)) throw e;
        out.resultsError = e.message;
      }
    } else if (added.length) out.resultsError = "the sheet could not be read";
    if (save.details && note) {
      onProgress("Noting it in “Search details”…");
      try {
        const html = await (await apiRaw(`/drive/v3/files/${save.details.id}/export?mimeType=text%2Fhtml`)).text();
        const more = note(stats);
        const doc = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${more}</body>`) : html + more;
        await replaceContent(save.details.id, new Blob([doc], { type: "text/html" }));
        out.details = true;
      } catch (e) {
        if (/sign-in/.test(e.message)) throw e;
        out.detailsError = e.message;
      }
    }
    return out;
  } finally {
    signIn = null;
  }
}

/* A search run again: the new results go into the save's folder as "<name>" (a sheet and a RIS file, and their files
   in Papers/ or Datasets/), with a note at the end of "Search details" (`note(stats)`, HTML) and the save's record
   (RECORD) replaced by `record`. */
export async function addToSave({ save, name, header, rows, ris, jobs, maxFile, maxTotal, note, record, extras = [], onProgress = () => {}, onSignIn = null }) {
  signIn = onSignIn;
  try {
    const folders = {};
    if (save.papers) folders.papers = Promise.resolve(save.papers.id);
    if (save.datasets) folders.datasets = Promise.resolve(save.datasets.id);
    for (const f of save.datasetFolders) folders[`d:${f.name}`] = Promise.resolve(f.id);
    const stats = await copyFiles(jobs, { folderId: save.id, folders, maxFile, maxTotal, onProgress });
    const saved = rows.map(() => []);
    for (const j of jobs) if (j.link) saved[j.row].push(j.link);
    let sheet = null;
    if (rows.length) {
      onProgress("Saving the new results as a Google Sheet…");
      sheet = await table(name, [[...header, "Saved in Drive"], ...rows.map((r, i) => [...r, saved[i].join(" | ")])], save.id);
      if (ris) await upload({ name: `${name}.ris`, parents: [save.id] }, new Blob([ris], { type: "application/x-research-info-systems" }));
    }
    const files = jobs.length ? await table(`${name} (files)`, fileRows(jobs), save.id) : null;
    for (const x of extras) await upload({ name: x.name, parents: [save.id] }, new Blob([x.text], { type: x.type }));
    const out = { ...stats, sheet, files };
    if (record) {
      try {
        if (save.recordFile) await replaceContent(save.recordFile.id, jsonBlob(record));
        else out.recordFile = await upload({ name: RECORD, parents: [save.id] }, jsonBlob(record));
      } catch (e) {
        if (/sign-in/.test(e.message)) throw e;
        out.recordError = e.message;
      }
    }
    if (save.details && note) {
      onProgress("Noting it in “Search details”…");
      try {
        const html = await (await apiRaw(`/drive/v3/files/${save.details.id}/export?mimeType=text%2Fhtml`)).text();
        const more = note(stats);
        await replaceContent(save.details.id, new Blob([/<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${more}</body>`) : html + more], { type: "text/html" }));
      } catch (e) {
        if (/sign-in/.test(e.message)) throw e;
        out.detailsError = e.message;
      }
    }
    return out;
  } finally {
    signIn = null;
  }
}

const fmtN = (n) => Number(n || 0).toLocaleString("en");
