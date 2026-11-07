/* Saving to the visitor's own Google Drive. Sign-in uses Google's own window (Google Identity Services) and asks
   only for the "drive.file" permission: the app can see and change only the files it creates itself. Nothing goes
   through a server of ours: the browser talks to Google directly.

   Each saved search becomes one folder inside "Research Finder":
     <keywords> — <date>/
       Results            Google Sheet: one row per result, the same columns for every source, links to saved files
       Results.ris        the same results for reference managers and screening tools (Zotero, Rayyan, Covidence...)
       Files             Google Sheet: every file found, with its download link and whether it was saved
       Search details     Google Doc: where and how the search was made (keywords, every term, filters, the queries)
       Papers/            the open PDFs the browser may download
       Datasets/<title>/  the open data files of each dataset */
import { CONFIG } from "../config.js?v=28";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "application/vnd.google-apps.folder";
const SHEET = "application/vnd.google-apps.spreadsheet";
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

async function api(path, opts = {}, again = true) {
  await ready();
  const r = await fetch(`https://www.googleapis.com${path}`, {
    ...opts, headers: { Authorization: `Bearer ${token.access_token}`, ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    token = null;
    changed();
    if (again) return api(path, opts, false);
    throw new Error("the Google sign-in expired; connect again");
  }
  if (!r.ok) throw new Error(`Google Drive answered HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
const makeFolder = (name, parent) => api("/drive/v3/files?fields=id,webViewLink", json({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }));

async function appFolder() {
  if (rootId) return rootId;
  const q = encodeURIComponent(`name='Research Finder' and mimeType='${FOLDER}' and trashed=false`);
  const found = await api(`/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
  if (found.files && found.files.length) return (rootId = found.files[0].id);
  return (rootId = (await makeFolder("Research Finder")).id);
}

async function upload(meta, blob) {
  if (blob.size <= SIMPLE_UPLOAD) {
    const b = `rf${Math.random().toString(36).slice(2)}`;
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`,
      blob, `\r\n--${b}--`]);
    return api("/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  }
  await ready();
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink", {
    method: "POST",
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

/* jobs: [{ row, kind: "paper" | "data", urls, source, name, title, dataset, size, repo, copy }], every file found
   (copy: false when its repository does not let browsers download it and no file relay is connected: listed only;
   urls: the addresses to try in turn, some of them through the file relay; source: the file's own address); rows: the CSV's data rows, one per result (the
   "Saved in Drive" column is added here); ris: the same results as a RIS file, for reference managers and screening
   tools. onSignIn: called when the sign-in runs out; resolves once connected again. */
export async function saveSearch({ title, header, rows, ris, jobs, detailsHtml, maxFile, maxTotal, onProgress = () => {}, onSignIn = null }) {
  signIn = onSignIn;
  try {
    const root = await appFolder();
    const folder = await makeFolder(clean(title, 120), root);
    const sub = {};
    const within = (key, name, parent) => (sub[key] = sub[key] || makeFolder(name, parent).then((f) => f.id));
    const saved = rows.map(() => []);
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
          why = e.message === "too large" ? "larger than the size limit" : /^the file relay/.test(e.message) ? e.message : why;
        }
      }
      if (!blob) return fail(job, why);
      try {
        const parent = job.kind === "paper"
          ? await within("papers", "Papers", folder.id)
          : await within(`d:${job.dataset}`, clean(job.dataset, 100), await within("datasets", "Datasets", folder.id));
        const file = await upload({ name: clean(job.name, 150), parents: [parent] },
          job.kind === "paper" ? new Blob([blob], { type: "application/pdf" }) : blob);
        saved[job.row].push(file.webViewLink);
        job.link = file.webViewLink;
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
    onProgress("Saving the results as a Google Sheet…");
    let csv = false;
    // a table too large for Google to turn into a sheet is kept as a CSV file instead
    const table = async (name, list) => {
      const blob = new Blob([csvOf(list)], { type: "text/csv" });
      try {
        return await upload({ name, mimeType: SHEET, parents: [folder.id] }, blob);
      } catch (e) {
        if (/sign-in/.test(e.message)) throw e;
        csv = true;
        return upload({ name: `${name}.csv`, parents: [folder.id] }, blob);
      }
    };
    const sheet = await table("Results", [[...header, "Saved in Drive"], ...rows.map((r, i) => [...r, saved[i].join(" | ")])]);
    if (ris) await upload({ name: "Results.ris", parents: [folder.id] }, new Blob([ris], { type: "application/x-research-info-systems" }));
    let files = null;
    if (jobs.length) {
      onProgress("Listing every file in a sheet…");
      files = await table("Files", [["Result no.", "Result", "File", "Size (MB)", "Repository", "Download link", "Saved in Drive", "Not saved because"],
        ...jobs.map((j) => [j.row + 1, j.title, j.name, j.size ? (j.size / 1e6).toFixed(2) : "", j.repo || "", j.source || j.urls[0] || "", j.link || "", j.link ? "" : j.why || ""])]);
    }
    onProgress("Writing the search details…");
    const html = typeof detailsHtml === "function" ? detailsHtml({ papers, dataFiles, bytes, failed, relayed }) : detailsHtml;
    const doc = await upload({ name: "Search details", mimeType: "application/vnd.google-apps.document", parents: [folder.id] },
      new Blob([html], { type: "text/html" }));
    return { folder: folder.webViewLink, sheet: sheet.webViewLink, files: files && files.webViewLink, doc: doc.webViewLink,
      papers, dataFiles, bytes, failed, relayed, csv };
  } finally {
    signIn = null;
  }
}

const fmtN = (n) => Number(n || 0).toLocaleString("en");
