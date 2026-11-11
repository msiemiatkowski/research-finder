# Research Finder

Find the studies your keywords miss: a free literature search for systematic reviews, meta-analyses and literature
reviews. It searches for every wording researchers use for a topic, in 40 languages, in about 270 million studies
and five open-data repositories, and files the records, open PDFs, data files and a record of the search in the
visitor's own Google Drive.

A real example (11 November 2026, titles and abstracts in OpenAlex, each study counted once): the phrase "trust in
science" finds 2,383 studies; with the 6 other wordings researchers use, 3,129; with translations into 39 languages,
3,402. A search for the phrase alone misses 1,019 of them, 3 in every 10.

**https://msiemiatkowski.github.io/research-finder/**

## What it does for your research

- **Systematic reviews and meta-analyses.** Builds the search string from the wordings researchers actually use for
  each keyword (read from the 200 studies that match it best) and Wikidata synonyms; searches every term in 39 more
  languages, against language bias; covers preprints, theses, datasets and OSF preregistrations, against publication
  bias; copies the search as a Boolean string for Scopus, Web of Science or PsycINFO, or opens it in PubMed, Google
  Scholar or BASE; saves every record a search finds, with abstracts and without duplicates,
  as a Google Sheet and a RIS file for Rayyan, Covidence, ASReview, Zotero or EndNote; links every open PDF and
  copies the ones it can fetch, and the open data files; and records the sources, date, terms, filters, exact
  queries and counts for the PRISMA flow diagram and the search appendix (PRISMA 2020 items 6 and 7).
- **Literature reviews.** How many studies each keyword has, existing reviews (Review filter), the most cited and the
  newest work, related phrases and the topics most often studied with yours, every abstract in one sheet and a
  RIS file for a reference manager.
- **Secondary data analysis.** DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE at once, with the open data
  files saved into one Drive folder per dataset and a sheet listing every file.
- **Cross-cultural research.** Studies published in other languages, such as validation studies of adapted
  questionnaires in national journals; filter by the language of the study. Their titles come with an automatic
  English translation in [brackets], and an abstract translates with one click, for a first look at what a study is
  about.

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
    Papers/          a search for studies: the open PDFs that could be fetched, named author_year_title
    Datasets/        a search for datasets: one folder per dataset with its open data files
```

Files a save did not copy (a site that does not let browsers download them, a size limit, an interruption) can be
added to it later: Settings > "Earlier saves" lists the searches saved in the folder, reads a save's "Files" sheet,
tries those files again (through a file relay where one helps), puts the new ones into the save's own folders and
updates "Files", the "Saved in Drive" column of "Results" and "Search details".

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
   may download (and, through a file relay, many of those it may not). For datasets it lists the files of Zenodo, Harvard Dataverse, OSF and figshare records (also those
   found through DataCite or OpenAIRE) and saves the Zenodo and Dataverse ones; OSF and figshare do not let browsers
   download files, so theirs are listed with their download links (or copied through a file relay). You choose how
   many results, up to all of them, and the size limits. A save of all results pages through every part of the search
   200 at a time; when OpenAlex's free allowance runs out, it saves what it has and says how far it got.
6. **Results in other languages.** The language of a title is read from its letters and small words, with the
   record's language as a hint (OpenAlex leaves many empty and files some English titles under other languages).
   A title in another language gets an English translation from MinT, shown in [brackets] and labelled as an
   automatic translation, not a professional one; "English translation" under an abstract translates the abstract.
   Each title's translation is translated back as a check: a translation whose back-translation shares too few
   letter groups with the original (machine translation sometimes writes a sentence of its own for a short title,
   such as "The report also highlights..."), or one that opens or repeats itself the way those made-up sentences do,
   is tried once more, written as a sentence or not, and otherwise not shown. Titles are sent to MinT by language,
   16 to a request, and remembered in the browser. Settings can turn this off.

### Limits

- OpenAlex gives anonymous users a small shared allowance (about 100 requests a day per network, each up to 200
  results) and slows free searches when it is busy. Each keyword costs one request for its wordings, a search with
  many translations up to three, and saving all results one per 200. Without a key it also pages through only the
  first 10,000 results of a query. Visitors can add a free OpenAlex key under Settings (ten times the allowance, and
  cursor paging to the last result); it stays in their browser.
- Semantic Scholar does not accept API keys sent from web pages, so it is asked anonymously; when it is busy, fewer
  extra PDFs are found.
- Many publishers do not let browsers download their PDFs. Those stay as links in the "Files" sheet, unless a file
  relay fetches them (below). In a test in November 2026, a relay fetched 325 of 560 open-access PDFs that a browser
  could not download. Elsevier (ScienceDirect), Wiley, SAGE, Taylor & Francis, MDPI, De Gruyter and Cairn refused it,
  and some open archives (HAL, OpenEdition) send a relay on Cloudflare a web page instead of the PDF; those PDFs stay
  as links. The "Files" sheet says why each one was not saved.
- Names in other languages come from Wikidata and from machine translation; the back-translation check catches many
  but not all poor translations. Check them before relying on them, for example in a systematic review.
- The English translations of titles and abstracts are rough, more so from Chinese, Japanese and Korean, and the check
  catches made-up translations, not every wrong word ("stosunek", attitude, can come out as "ratio"). Use them to see
  what a study is about, not to include or exclude it.
- OSF and figshare files cannot be copied into Drive by a browser alone; the "Files" sheet has their download links,
  or a file relay copies them (below).

## File relay (optional)

OSF, figshare and many publishers do not let web pages download their files. A file relay,
[`docs/relay/worker.js`](docs/relay/worker.js), is a small Cloudflare Worker that fetches such a file and passes it
straight to the page, keeping nothing; it answers only the sites listed in its `ORIGINS`. It fetches:

- OSF and figshare files, from their download addresses, following them only to the storage those sites use;
- open-access PDFs from any other public site, and only PDFs, so it cannot be used to read web pages. When a link
  leads to an article's page instead, it follows the PDF link the page gives (`citation_pdf_url`, the tag publishers
  add for Google Scholar; also Open Journal Systems' download links and DSpace 7 file addresses), at most two pages deep.
  It identifies itself in its user agent and does not try to get past the checks some publishers use to let only
  browsers in; those PDFs stay as links.

Research Finder tries every PDF in the browser first and asks the relay only for those the browser may not download.
Each visitor decides whether to use a relay: under Settings, "File relay", they paste its address and choose Check.
The address stays in their browser. A relay running the first version of this code fetches only OSF and figshare
files (Check says so); replacing its code with the current file and deploying it again adds the PDFs.

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
translation of the terms), `translate.js` (English for results in other languages: which language a title is in,
the translation and its check), `sources.js` (OpenAlex, DataCite, Zenodo, Harvard Dataverse, OSF, OpenAIRE, files to save), `drive.js`
(Google sign-in and the folder structure), `main.js` (the search page), `landing.js` (the tabs of the front page) and
`util.js`. The front page's worked example ("trust in science") is written into `docs/index.html` with the numbers
of a real search; run it again and update them when they age. Module imports carry a version
(`?v=33`); change it in every file at once when publishing changes, so that browsers do not mix old and new modules.

## Creator

Research Finder is made by **Maciej Siemiątkowski**, researcher at the Faculty of Psychology, University of Warsaw.
Questions, ideas or problems: [maciej.siemiatkowski@psych.uw.edu.pl](mailto:maciej.siemiatkowski@psych.uw.edu.pl), or
open an issue in this repository.

To cite it: Siemiątkowski, M. (2026). *Research Finder* [Computer software].
https://msiemiatkowski.github.io/research-finder/
