# Research Finder

Find the studies and the data behind them, in 40 languages, and keep everything organized in your Google Drive.

**https://msiemiatkowski.github.io/research-finder/**

## What makes it different

- **Datasets, not only papers.** Studies from [OpenAlex](https://openalex.org) (about 270 million works from every
  field) and datasets from [DataCite](https://datacite.org), [Zenodo](https://zenodo.org),
  [Harvard Dataverse](https://dataverse.harvard.edu), [OSF](https://osf.io) and [OpenAIRE](https://www.openaire.eu),
  with their open data files.
- **Organized in your Google Drive.** Each saved search becomes one folder:

  ```
  Research Finder/
    <keywords> — <date and time>/
      Results          Google Sheet: one row per result, the same columns for every source,
                       with links to the files saved for it
      Files            Google Sheet: every file found, with its download link, and whether it was saved
                       (and if not, why)
      Search details   Google Doc: keywords, every term and translation used, filters, the exact queries,
                       what was saved and what could not be
      Papers/          the open PDFs, named author_year_title
      Datasets/        one folder per dataset with its open data files
  ```

- **Every wording, in every language.** Each keyword is expanded with the other wordings studies use for it, read
  from the studies themselves, and with its synonyms ([Wikidata](https://www.wikidata.org)); every term is then
  translated into 39 other languages.
- **Repeatable and reportable.** Every term can be switched on or off; the search details, the Boolean search string,
  the CSV export and the same search in Google Scholar, PubMed, BASE or OpenAlex make a search easy to report and repeat.
- **Private.** A static site: no server, no account, no tracking. The browser talks to the services directly, and
  Google Drive access is limited to the files the app creates (`drive.file`).

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
5. **Saving.** The results go into a Google Sheet, every file found into a second one. For studies, the app also asks
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
- OSF and figshare files cannot be copied into Drive by a browser; the "Files" sheet has their download links.

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
(`?v=23`); change it in every file at once when publishing changes, so that browsers do not mix old and new modules.

## Creator

Research Finder is made by **Maciej Siemiątkowski**, researcher at the Faculty of Psychology, University of Warsaw.
Questions, ideas or problems: [maciej.siemiatkowski@psych.uw.edu.pl](mailto:maciej.siemiatkowski@psych.uw.edu.pl), or
open an issue in this repository.
