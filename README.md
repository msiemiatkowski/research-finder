# Research Finder

Find the studies and open data on your topic in 40 languages, with a record of how you found them: a free search
for systematic reviews, meta-analyses, literature reviews and secondary data analysis.

**https://msiemiatkowski.github.io/research-finder/**

## What it does for your research

- **Systematic reviews and meta-analyses.** Builds the search string from the wordings researchers actually use for
  each keyword (read from the 200 studies that match it best) and Wikidata synonyms; searches every term in 39 more
  languages, against language bias; covers preprints, theses, datasets and OSF preregistrations, against publication
  bias; copies the search as a Boolean string for Scopus, Web of Science or PsycINFO, or opens it in PubMed, Google
  Scholar or BASE; saves up to 2,000 records (10,000 with a free OpenAlex key) with abstracts and without duplicates,
  as a Google Sheet and a RIS file for Rayyan, Covidence, ASReview, Zotero or EndNote; collects the open PDFs and
  data files; and records the sources, date, terms, filters, exact queries and counts for the PRISMA flow diagram
  and the search appendix (PRISMA 2020 items 6 and 7).
- **Literature reviews.** How many studies each keyword has, existing reviews (Review filter), the most cited and the
  newest work, related phrases and the topics most often studied with yours, the open PDFs in one folder.
- **Secondary data analysis.** DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE at once, with the open data
  files saved into one Drive folder per dataset and a sheet listing every file.
- **Cross-cultural research.** Studies published in other languages, such as validation studies of adapted
  questionnaires in national journals; filter by the language of the study.

## What is saved

Each saved search becomes one folder in the visitor's own Google Drive:

```
Research Finder/
  <keywords> — <date and time>/
    Results          Google Sheet: one row per result with its abstract, the same columns for every source,
                     with links to the files saved for it
    Results.ris      the same results for Zotero, EndNote, Mendeley, Rayyan, Covidence or ASReview
    Files            Google Sheet: every file found, with its download link, and whether it was saved
                     (and if not, why)
    Search details   Google Doc: keywords, every term and translation used, filters, the exact queries,
                     what was saved and what could not be
    Papers/          the open PDFs, named author_year_title
    Datasets/        one folder per dataset with its open data files
```

The results shown can also be exported without Drive, as CSV or RIS. The site is private by design: a static page
with no server, no account and no tracking. The browser talks to the services directly, and Google Drive access is
limited to the files the app creates (`drive.file`).

## How it works

1. **Synonyms.** For each comma-separated keyword the app looks for a Wikidata item with exactly that name (or that
   synonym), skipping publications and people, and takes its English synonyms and its names in other languages
   (synonyms that are only part of the name, which are broader, are left out).
2. **The wordings studies use.** The app reads the titles and abstracts of the 200 studies in OpenAlex that match the
   keyword best (one request) and collects the phrases of two to five words that contain all of the keyword's words,
   in any form and order, with at most one more word: for "trust in science", "trust in scientists" and
   "trustworthiness of science". Words count as one family when they share their stem ("science", "scientists").
   Phrases that only add words to the keyword ("public trust in science") are narrower and left out. The most
   frequent wordings are searched too; related phrases ("epistemic trust") and the keywords of those studies are
   offered.
3. **Translations.** Every English term is translated into 39 languages by Wikimedia's open machine translation,
   [MinT](https://mint.wmcloud.org) (one request per language), and every translation is translated back into
   English: one that does not come back with the keyword's words, or another of its terms, is left out (it stays
   visible, marked "?"). Translations are remembered in the browser.
4. **Search.** The terms become one Boolean query: OR within a keyword, AND (or OR) between keywords, in titles and
   abstracts (full texts optionally). A query longer than a service takes is split into several (OpenAlex: 1,500
   characters a query, up to 3 queries without a key and 8 with one; OpenAIRE: five terms a query), English terms
   first, then the first translation in every language, then the next. Their results are put together.
5. **Saving.** The results go into a Google Sheet and a RIS file, with their full abstracts, every file found into a
   second sheet. For studies, the app also asks
   Semantic Scholar (by DOI) for open versions of the papers, such as arXiv preprints, and saves the PDFs the browser
   may download. For datasets it lists the files of Zenodo, Harvard Dataverse, OSF and figshare records (also those
   found through DataCite or OpenAIRE) and saves the Zenodo and Dataverse ones; OSF and figshare do not let browsers
   download files, so theirs are listed with their download links. You choose how many results (up to 2,000, or
   10,000 with an OpenAlex key) and the size limits.

### Limits

- OpenAlex gives anonymous users a small shared allowance (about 100 searches a day per network) and slows free
  searches when it is busy. Each keyword costs one search for its wordings, and a search with many translations up
  to three. Visitors can add a free OpenAlex key under Settings (ten times the allowance); it stays in their browser.
- Semantic Scholar does not accept API keys sent from web pages, so it is asked anonymously; when it is busy, fewer
  extra PDFs are found.
- Many publishers do not let browsers download their PDFs. Those stay as links in the sheet.
- Names in other languages come from Wikidata and from machine translation; the back-translation check catches many
  but not all poor translations. Check them before relying on them, for example in a systematic review.
- OSF and figshare files cannot be copied into Drive by a browser alone; the "Files" sheet has their download links,
  or a file relay copies them (below).

## File relay for OSF and figshare (optional)

OSF and figshare do not let web pages download their files. A file relay, [`docs/relay/worker.js`](docs/relay/worker.js),
is a small Cloudflare Worker that fetches an open file from OSF or figshare (and only from them) and passes it straight
to the page, keeping nothing; it answers only the sites listed in its `ORIGINS`. Each visitor decides whether to use
one: under Settings, "OSF and figshare files", they paste a relay's address and choose Check. The address stays in their
browser. With a relay connected, OSF and figshare files (and OSF preprint PDFs) are copied into Drive like the others.

To set one up (free, about five minutes): create a Cloudflare account; in the dashboard open Workers & Pages, Create
application, start from "Hello World" and deploy it; choose Edit code, replace the code with `docs/relay/worker.js` and
Deploy; paste the Worker's address (`https://<name>.<subdomain>.workers.dev`) into Settings. With Wrangler instead:
`npx wrangler deploy docs/relay/worker.js --name research-finder-relay --compatibility-date 2026-11-01`. Cloudflare's
free plan allows 100,000 requests a day and is not billed. A copy of the site on another address adds that address to
`ORIGINS`; to offer a relay to all its visitors (each still chooses to use it), put its address in `docs/config.js` as
`fileRelay`.

## Run your own copy

1. Fork the repository and turn on GitHub Pages for the `main` branch, folder `/docs`.
2. To let visitors save to Google Drive, create a sign-in ID once:
   1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the
      **Google Drive API**.
   2. **Google Auth Platform**: app name, support email, audience **External**. Under **Data access** add
      `https://www.googleapis.com/auth/drive.file`. Under **Branding** add the home page, the privacy policy
      (`docs/privacy.html`) and your site's domain as an authorised domain. Under **Audience**, publish the app.
   3. **Clients > Create client**, type **Web application**, with your site's address (for example
      `https://<user>.github.io`) as an authorised JavaScript origin.
   4. Put the client ID into `docs/config.js` as `googleClientId`. It is public by design; it is not a password.
3. To try it locally: `python3 -m http.server 8765 --directory docs` and open <http://localhost:8765> (add
   `http://localhost:8765` as an authorised origin to test Drive saving).

The app is plain JavaScript modules (`docs/js/`): `terms.js` (keywords, Wikidata, the wordings studies use, machine
translation), `sources.js` (OpenAlex, DataCite, Zenodo, Harvard Dataverse, OSF, OpenAIRE, files to save), `drive.js`
(Google sign-in and the folder structure), `main.js` (the page) and `util.js`. Module imports carry a version
(`?v=26`); change it in every file at once when publishing changes, so that browsers do not mix old and new modules.

## Creator

Research Finder is made by **Maciej Siemiątkowski**, researcher at the Faculty of Psychology, University of Warsaw.
Questions, ideas or problems: [maciej.siemiatkowski@psych.uw.edu.pl](mailto:maciej.siemiatkowski@psych.uw.edu.pl), or
open an issue in this repository.

To cite it: Siemiątkowski, M. (2026). *Research Finder* [Computer software].
https://msiemiatkowski.github.io/research-finder/
