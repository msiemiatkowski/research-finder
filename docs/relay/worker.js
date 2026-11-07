/* Research Finder file relay: a Cloudflare Worker.

   A web page may download a file from another site only when that site allows it. OSF, figshare and many publishers
   do not, so Research Finder can copy their open files into Google Drive only through a relay like this one. It fetches
   the file and passes it straight through to the page that asked for it, keeping nothing:
   - OSF and figshare files, from their download addresses, followed only to the storage those sites keep files in;
   - open-access PDFs from any other public site, and only PDFs: anything else is refused, so the relay cannot be used
     to read web pages. When a link leads to an article's page instead, the relay follows the PDF link the page gives
     (citation_pdf_url, which publishers add for Google Scholar), at most two pages deep.
   It answers only the sites in ORIGINS, says who it is (AGENT) and does not try to get past the checks some sites use
   to let only browsers in: those PDFs stay as links.

   To set one up (free, about five minutes): in the Cloudflare dashboard, open Workers & Pages, Create application,
   start from "Hello World" and deploy it; then Edit code, replace the code with this file, and Deploy. Paste the
   Worker's address (https://<name>.<your-subdomain>.workers.dev) into Research Finder: Settings > File relay.
   Cloudflare's free plan allows 100,000 requests a day and is not billed. */

// the sites that may use this relay (a copy of Research Finder on another address adds its own here)
const ORIGINS = ["https://msiemiatkowski.github.io", "http://localhost:8765"];
// the OSF and figshare download addresses (not OSF's "forward" links, which can lead anywhere)
const START = [
  [/^(www\.)?osf\.io$/, /^\/(download\/[a-z0-9]{5,}(_v\d+)?|[a-z0-9]{5,}(_v\d+)?\/download)\/?$/i],
  [/^files(\.[a-z0-9-]+)?\.osf\.io$/, /^\/v1\/resources\//],
  [/^ndownloader\.figshare\.com$/, /^\/files\/\d+/],
  [/^figshare\.com$/, /^\/ndownloader\/files\/\d+/],
];
// where OSF and figshare send downloads: themselves, their file servers and the cloud storage they keep files in
const STORAGE = [/^(www\.)?osf\.io$/, /^files(\.[a-z0-9-]+)?\.osf\.io$/, /^(ndownloader\.)?figshare\.com$/, /\.amazonaws\.com$/, /(^|\.)storage\.googleapis\.com$/,
  /\.objectstorage\.[a-z0-9-]+\.oraclecloud\.com$/, /\.r2\.cloudflarestorage\.com$/, /\.blob\.core\.windows\.net$/];
const PASS = ["content-type", "content-length", "content-disposition", "last-modified", "etag"];
// a browser-like user agent gets an empty answer from figshare; publishers are told plainly who is asking
const AGENT = "ResearchFinder-relay/2 (+https://github.com/msiemiatkowski/research-finder)";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Expose-Headers": "Content-Length, Content-Disposition, Retry-After",
      Vary: "Origin",
    };
    const answer = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, ...extra, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET") return answer(405, { error: "only GET requests" });
    if (!ORIGINS.includes(origin)) return answer(403, { error: "this relay serves only the sites it was set up for" });
    const target = new URL(request.url).searchParams.get("url");
    if (!target) return answer(200, { service: "research-finder-relay", version: 2, hosts: ["osf.io", "figshare.com"], pdf: true });
    let url;
    try {
      url = new URL(target);
    } catch {
      return answer(400, { error: "not a web address" });
    }
    if (url.hostname === new URL(request.url).hostname) return answer(400, { error: "the relay does not fetch from itself" });
    if (url.protocol === "https:" && START.some(([host, path]) => host.test(url.hostname) && path.test(url.pathname))) {
      return storageFile(url, cors, answer);
    }
    if (!isPublic(url)) return answer(403, { error: "only public web addresses" });
    const got = await pdfFrom(url, { jar: [], fetches: 0 }, 0);
    if (got.response) {
      const headers = new Headers({ ...cors, "Cache-Control": "no-store", "Content-Type": "application/pdf" });
      for (const h of ["content-length", "content-disposition", "last-modified", "etag"]) {
        if (h === "content-length" && got.response.headers.get("content-encoding")) continue;   // the body is already decoded
        if (got.response.headers.get(h)) headers.set(h, got.response.headers.get(h));
      }
      return new Response(got.body, { status: 200, headers });
    }
    return answer(got.status, { error: got.error }, got.retry ? { "Retry-After": got.retry } : {});
  },
};

/* An OSF or figshare file: redirects are followed one at a time, and only to OSF, figshare or their storage. */
async function storageFile(start, cors, answer) {
  let url = start;
  for (let hops = 0; hops < 6; hops++) {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": AGENT } });
    const next = r.status >= 300 && r.status < 400 && r.headers.get("Location");
    if (next) {
      url = new URL(next, url);
      if (url.protocol !== "https:" || !STORAGE.some((re) => re.test(url.hostname))) {
        return answer(502, { error: `the file is kept at ${url.hostname}, where this relay does not go` });
      }
      continue;
    }
    const headers = new Headers({ ...cors, "Cache-Control": "no-store" });
    for (const h of PASS) if (r.headers.get(h)) headers.set(h, r.headers.get(h));
    return new Response(r.body, { status: r.status, headers });
  }
  return answer(502, { error: "too many redirects" });
}

/* A public web address: http(s), a host name (not an address, not a local name), no user name or password. */
function isPublic(url) {
  const host = url.hostname.toLowerCase();
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && host.includes(".")
    && !/^[\d.]+$/.test(host) && !host.startsWith("[") && !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host);
}

/* The file behind an address that gave a viewer page instead, or null: in DSpace 7 repositories /bitstreams/<id>/download
   is the web app (in some of them), and the file is at /server/api/core/bitstreams/<id>/content; in Open Journal
   Systems /article/view/<article>/<file> shows the PDF in a viewer, and /article/download/... is the PDF. */
function viewerFile(url) {
  const u = new URL(url);
  const dspace = /^(.*)\/bitstreams\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download\/?$/i.exec(u.pathname);
  if (dspace) u.pathname = `${dspace[1]}/server/api/core/bitstreams/${dspace[2]}/content`;
  else u.pathname = u.pathname.replace(/\/article\/view\/(\d+\/\d+)\/?$/, "/article/download/$1");
  return u.href === new URL(url).href ? null : u;
}

/* The PDF a link leads to, following redirects (with the cookies sites set on the way) and article pages:
   { response, body } or { status, error, retry }. */
async function pdfFrom(start, ctx, depth) {
  let url = start;
  for (let hops = 0; hops < 10; hops++) {
    if (!isPublic(url)) return { status: 403, error: `the link leads to ${url.hostname}, which is not a public web address` };
    if (++ctx.fetches > 24) return { status: 502, error: "too many steps on the way to the PDF" };
    let r;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const cookie = ctx.jar.filter((c) => url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`)).map((c) => `${c.name}=${c.value}`).join("; ");
      r = await fetch(url, { redirect: "manual", signal: ctrl.signal,
        headers: { "User-Agent": AGENT, Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8", ...(cookie ? { Cookie: cookie } : {}) } });
    } catch {
      return { status: 502, error: `the relay could not reach ${url.hostname}` };
    } finally {
      clearTimeout(timer);
    }
    keepCookies(ctx.jar, url, r.headers);
    const next = r.status >= 300 && r.status < 400 && r.headers.get("Location");
    if (next) {
      if (r.body) r.body.cancel();
      try {
        url = new URL(next, url);
      } catch {
        return { status: 502, error: "the site sent the relay to an address that does not work" };
      }
      continue;
    }
    const type = (r.headers.get("Content-Type") || "").toLowerCase();
    if (r.status === 200 && !/html/.test(type)) {
      const body = r.body && (await pdfBody(r.body));
      if (body) return { response: r, body };
      return { status: 415, error: `the link gives ${type.split(";")[0].trim() ? `a ${type.split(";")[0].trim()} file` : "a file"}, not a PDF` };
    }
    const page = r.body ? await readText(r.body, 1 << 20) : "";
    const refused = refusal(r, page);
    if (refused) return refused;
    if (depth >= 2) return { status: 502, error: "the link leads to web pages, not to the PDF" };
    const links = pdfLinksIn(page, url);
    const file = viewerFile(url);
    if (file && !links.some((l) => l.href === file.href)) links.unshift(file);
    if (!links.length && ROBOT_PAGE.test(page.slice(0, 30000))) return { status: 403, error: ROBOTS };
    const title = unescape((/<title[^>]*>([^<]{1,300})/i.exec(page) || ["", ""])[1]).replace(/\s+/g, " ").slice(0, 80);
    let last = { status: 502, error: `the link gives a web page${title ? ` (“${title}”)` : ""}, not the PDF (the PDF may not be open)` };
    for (const link of links.slice(0, 3)) {
      const got = await pdfFrom(link, ctx, depth + 1);
      if (got.response) return got;
      last = got;
    }
    return last;
  }
  return { status: 502, error: "too many redirects" };
}

const ROBOTS = "the site lets only browsers download it (it checks for robots), so the relay cannot";
// the pages of such checks that come with HTTP 200 (Anubis, DDoS-Guard and others), when a page gives no PDF link
const ROBOT_PAGE = /anubis_challenge|\.within\.website\/|making sure you(?:'|&#39;|’)re not a bot|checking your browser before|verify (?:that )?you are (?:a )?human|are you a robot|ddos-guard|cf-chl-/i;

/* Why a site's answer is not a page to look into: a check that lets only browsers in, a refusal, a missing file. */
function refusal(r, page) {
  const s = r.status;
  const head = page.slice(0, 20000);
  const check = r.headers.get("cf-mitigated") === "challenge" || r.headers.get("x-amzn-waf-action") || s === 202
    || /Just a moment\.\.\.|challenge-platform|Pardon Our Interruption|Request unsuccessful\. Incapsula/i.test(head)
    || (s !== 200 && /captcha|bot detection|are you a robot|verify (that )?you are (a )?human/i.test(head));
  if (check) return { status: 403, error: ROBOTS };
  if (s === 429) return { status: 429, error: "the site asks to wait before more downloads", retry: r.headers.get("Retry-After") || "10" };
  if (s === 404 || s === 410) return { status: 404, error: `the site says the file is not there (HTTP ${s})` };
  if (s === 401 || s === 403) return { status: 403, error: `the site refused the relay (HTTP ${s})` };
  if (s >= 500) return { status: 502, error: `the site had an error (HTTP ${s})` };
  if (s !== 200) return { status: 502, error: `the site answered HTTP ${s}` };
  return null;
}

/* Cookies set along the way, sent back to the same sites (some publishers send a download through a cookie check). */
function keepCookies(jar, url, headers) {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : [];
  for (const line of lines) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    const dom = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
    let domain = dom ? dom.slice(7).replace(/^\./, "").toLowerCase() : url.hostname;
    if (!domain.includes(".") || (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))) domain = url.hostname;
    const i = jar.findIndex((c) => c.name === name && c.domain === domain);
    if (i >= 0) jar.splice(i, 1);
    if (jar.length < 60) jar.push({ name, value, domain });
  }
}

/* The body again, if it starts as a PDF does ("%PDF-"); null otherwise. */
async function pdfBody(body) {
  const reader = body.getReader();
  let first = new Uint8Array(0);
  while (first.length < 5) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(first.length + value.length);
    joined.set(first);
    joined.set(value, first.length);
    first = joined;
  }
  if (String.fromCharCode(...first.subarray(0, 5)) !== "%PDF-") {
    reader.cancel();
    return null;
  }
  return new ReadableStream({
    start(c) { c.enqueue(first); },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel(why) { return reader.cancel(why); },
  });
}

async function readText(body, max) {
  const reader = body.getReader(), parts = [];
  let size = 0;
  while (size < max) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  if (size >= max) reader.cancel();
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new TextDecoder("utf-8").decode(all);
}

const unescape = (s) => s.replace(/&amp;|&#0*38;|&#x0*26;/gi, "&").replace(/&quot;|&#0*34;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").trim();

/* The PDF links an article's page gives: citation_pdf_url and similar tags, a PDF named as the page's alternate,
   a redirect in the page, Open Journal Systems' download links, and a PDF shown in a frame. At most three. */
function pdfLinksIn(page, base) {
  const out = [];
  const attr = (tag, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
    return m ? unescape(m[1].replace(/^["']|["']$/g, "")) : "";
  };
  for (const [tag] of page.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(tag, "name") || attr(tag, "property")).toLowerCase();
    if (["citation_pdf_url", "bepress_citation_pdf_url", "eprints.document_url", "wkhealth_pdf_url"].includes(name)) out.push(attr(tag, "content"));
    if (/^refresh$/i.test(attr(tag, "http-equiv"))) {
      const to = /url\s*=\s*['"]?([^'";]+)/i.exec(attr(tag, "content"));
      if (to) out.push(to[1].trim());
    }
  }
  for (const [tag] of page.matchAll(/<link\b[^>]*>/gi)) {
    if (/pdf/i.test(attr(tag, "type")) && /alternate/i.test(attr(tag, "rel"))) out.push(attr(tag, "href"));
  }
  for (const [tag] of page.matchAll(/<a\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:download|obj_galley_link)\b[^>]*>/gi)) {
    const classes = attr(tag, "class").split(/\s+/);
    if (classes.includes("download")) out.push(attr(tag, "href"));
    else if (classes.includes("obj_galley_link") && classes.includes("pdf")) out.push(attr(tag, "href").replace("/article/view/", "/article/download/"));
  }
  for (const [tag] of page.matchAll(/<(?:iframe|embed|object)\b[^>]*>/gi)) {
    let src = attr(tag, "src") || attr(tag, "data");
    const file = /[?&]file=([^&#]+)/.exec(src);
    try {
      if (file) src = decodeURIComponent(file[1]);
    } catch { /* kept as it is */ }
    if (/\.pdf\b|\/download\b|\bpdf\b/i.test(src)) out.push(src);
  }
  const seen = new Set([base.href]);
  const links = [];
  for (const href of out) {
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(u.pathname) || seen.has(u.href) || !isPublic(u)) continue;
    seen.add(u.href);
    links.push(u);
  }
  return links.slice(0, 3);
}
