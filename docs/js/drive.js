/* Saving to the visitor's own Google Drive. Sign-in uses Google's own window (Google Identity Services) and asks
   only for the "drive.file" permission: the app can see and change only the files it creates itself. Nothing goes
   through a server of ours: the browser talks to Google directly.

   Each saved search becomes one folder inside "Research Finder":
     <keywords> — <date>/
       Results            Google Sheet: one row per result, the same columns for every source, links to saved files
       Search details     Google Doc: where and how the search was made (keywords, every term, filters, the query)
       Papers/            the open PDFs the browser may download
       Datasets/<title>/  the open data files of each dataset */
import { CONFIG } from "../config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "application/vnd.google-apps.folder";
const SIMPLE_UPLOAD = 5 * 1024 * 1024;      // larger files go up in a resumable upload
let token = null;               // { access_token, expires_at }
let rootId = null;
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

async function api(path, opts = {}) {
  if (!driveConnected()) await connect();
  const r = await fetch(`https://www.googleapis.com${path}`, {
    ...opts, headers: { Authorization: `Bearer ${token.access_token}`, ...(opts.headers || {}) },
  });
  if (r.status === 401) { token = null; changed(); throw new Error("the Google sign-in expired; connect again"); }
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
  if (!driveConnected()) await connect();
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

async function download(url, maxBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

/* jobs: [{ row, kind: "paper" | "data", urls, name, dataset }], the files to try; rows: the CSV's data rows, one
   per result (the "Saved in Drive" column is added here). */
export async function saveSearch({ title, header, rows, jobs, detailsHtml, maxFile, maxTotal, onProgress = () => {} }) {
  const root = await appFolder();
  const folder = await makeFolder(clean(title, 120), root);
  const sub = {};
  const within = async (key, name, parent) => (sub[key] = sub[key] || (await makeFolder(name, parent)).id);
  const saved = rows.map(() => []);
  let bytes = 0, papers = 0, dataFiles = 0;
  const failed = [];
  for (const [n, job] of jobs.entries()) {
    onProgress(`Saving files: ${n + 1} of ${jobs.length}${bytes ? ` (${(bytes / 1e6).toFixed(0)} MB so far)` : ""}`);
    if (bytes >= maxTotal) { failed.push({ ...job, why: "the total size limit was reached" }); continue; }
    let blob = null, why = "the site does not let browsers download it";
    for (const url of job.urls) {
      try {
        const b = await download(url, Math.min(maxFile, maxTotal - bytes));
        if (job.kind === "paper") {
          const head = new Uint8Array(await b.slice(0, 5).arrayBuffer());
          if (String.fromCharCode(...head) !== "%PDF-") { why = "the link gave a web page, not the PDF"; continue; }
        }
        blob = b;
        break;
      } catch (e) {
        why = e.message === "too large" ? "larger than the size limit" : why;
      }
    }
    if (!blob) { failed.push({ ...job, why }); continue; }
    try {
      const parent = job.kind === "paper"
        ? await within("papers", "Papers", folder.id)
        : await within(`d:${job.dataset}`, clean(job.dataset, 100), await within("datasets", "Datasets", folder.id));
      const file = await upload({ name: clean(job.name, 150), parents: [parent] },
        job.kind === "paper" ? new Blob([blob], { type: "application/pdf" }) : blob);
      saved[job.row].push(file.webViewLink);
      bytes += blob.size;
      if (job.kind === "paper") papers++; else dataFiles++;
    } catch (e) {
      failed.push({ ...job, why: e.message });
    }
  }
  onProgress("Saving the results as a Google Sheet…");
  const cell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [[...header, "Saved in Drive"], ...rows.map((r, i) => [...r, saved[i].join(" | ")])].map((r) => r.map(cell).join(",")).join("\r\n");
  const sheet = await upload({ name: "Results", mimeType: "application/vnd.google-apps.spreadsheet", parents: [folder.id] },
    new Blob([csv], { type: "text/csv" }));
  onProgress("Writing the search details…");
  const html = typeof detailsHtml === "function" ? detailsHtml({ papers, dataFiles, bytes, failed }) : detailsHtml;
  const doc = await upload({ name: "Search details", mimeType: "application/vnd.google-apps.document", parents: [folder.id] },
    new Blob([html], { type: "text/html" }));
  return { folder: folder.webViewLink, sheet: sheet.webViewLink, doc: doc.webViewLink, papers, dataFiles, bytes, failed };
}
