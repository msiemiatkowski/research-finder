/* Research Finder file relay: a Cloudflare Worker.

   OSF and figshare do not let web pages download their files, so Research Finder can copy them into Google Drive only
   through a relay like this one. It fetches an open file from OSF or figshare and passes it straight through to the
   page that asked for it, keeping nothing. It answers only the sites in ORIGINS, starts only from OSF and figshare
   download addresses and follows them only to the cloud storage they keep files in, so it cannot be used to reach
   other websites.

   To set one up (free, about five minutes): in the Cloudflare dashboard, open Workers & Pages, Create application,
   start from "Hello World" and deploy it; then Edit code, replace the code with this file, and Deploy. Paste the
   Worker's address (https://<name>.<your-subdomain>.workers.dev) into Research Finder: Settings > OSF and figshare
   files. Cloudflare's free plan allows 100,000 requests a day and is not billed. */

// the sites that may use this relay (a copy of Research Finder on another address adds its own here)
const ORIGINS = ["https://msiemiatkowski.github.io", "http://localhost:8765"];
// the download addresses a relay starts from (not OSF's "forward" links, which can lead anywhere)
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
// a browser-like user agent gets an empty answer from figshare
const AGENT = "ResearchFinder-relay/1 (+https://github.com/msiemiatkowski/research-finder)";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Expose-Headers": "Content-Length, Content-Disposition",
      Vary: "Origin",
    };
    const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET") return answer(405, { error: "only GET requests" });
    if (!ORIGINS.includes(origin)) return answer(403, { error: "this relay serves only the sites it was set up for" });
    const target = new URL(request.url).searchParams.get("url");
    if (!target) return answer(200, { service: "research-finder-relay", version: 1, hosts: ["osf.io", "figshare.com"] });
    let url;
    try {
      url = new URL(target);
    } catch {
      return answer(400, { error: "not a web address" });
    }
    if (url.protocol !== "https:" || !START.some(([host, path]) => host.test(url.hostname) && path.test(url.pathname))) {
      return answer(403, { error: "only OSF and figshare download addresses" });
    }
    // redirects are followed here, one at a time, so that they too can only lead to OSF, figshare or their storage
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
  },
};
