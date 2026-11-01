# Research Finder

Find the studies and the data behind them, in 40 languages, and keep everything organized in your Google Drive.

**https://msiemiatkowski.github.io/research-finder/**

## What makes it different

- **Datasets, not only papers.** Studies from [OpenAlex](https://openalex.org) (about 270 million works from every
  field) and datasets from [DataCite](https://datacite.org), [Zenodo](https://zenodo.org) and
  [Harvard Dataverse](https://dataverse.harvard.edu), with their open data files.
- **Organized in your Google Drive.** Each saved search becomes one folder:

  ```
  Research Finder/
    <keywords> — <date and time>/
      Results          Google Sheet: one row per result, the same columns for every source,
                       with links to the files saved for it
      Search details   Google Doc: keywords, every term and translation used, filters, the exact queries,
                       what was saved and what could not be
      Papers/          the open PDFs, named author_year_title
      Datasets/        one folder per dataset with its open data files
  ```

- **Found in every language.** Each keyword is expanded with its synonyms and translated into 39 other languages
  ([Wikidata](https://www.wikidata.org)), and OpenAlex shows which keywords the studies on that topic use, with counts.
- **Repeatable and reportable.** Every term can be switched on or off; the search details, the Boolean search string,
  the CSV export and the same search in Google Scholar, PubMed, BASE or OpenAlex make a search easy to report and repeat.
- **Private.** A static site: no server, no account, no tracking. The browser talks to the services directly, and
  Google Drive access is limited to the files the app creates (`drive.file`).

## How it works

1. **Terms.** For each comma-separated keyword the app looks for a Wikidata item with exactly that name (or that
   synonym), skipping publications and people, and takes its English synonyms and its names in other languages
   (synonyms that are only part of the name, which are broader, are left out). It also asks OpenAlex for the keywords
   most used by the studies found for the keyword (`group_by=keywords.id`) and offers them as suggestions and related
   topics.
2. **Search.** The terms become one Boolean query: OR within a keyword, AND (or OR) between keywords. Queries are
   shortened to what each service accepts (OpenAlex: 1,500 characters; Zenodo and Dataverse fail on long queries),
   keeping your words and the English synonyms first, then translations into the languages with the most research.
3. **Saving.** The results go into a Google Sheet. For studies, the app also asks Semantic Scholar (once, by DOI) for
   open versions of the papers, such as arXiv preprints, and saves the PDFs the browser may download. For datasets it
   lists the open files of Zenodo and Harvard Dataverse records (also Zenodo DOIs found through DataCite) and saves
   them, up to 50 MB per file and 500 MB per search.

### Limits

- OpenAlex gives anonymous users a small shared allowance (about 100 searches a day per network) and slows free
  searches when it is busy. Visitors can add a free OpenAlex key under Settings; it stays in their browser.
- Semantic Scholar does not accept API keys sent from web pages, so it is asked anonymously; when it is busy, fewer
  extra PDFs are found.
- Many publishers do not let browsers download their PDFs. Those stay as links in the sheet.
- Names in other languages come from Wikidata; check them before relying on them, for example in a systematic review.

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

The app is plain JavaScript modules (`docs/js/`): `terms.js` (keywords, Wikidata, OpenAlex keyword statistics),
`sources.js` (OpenAlex, DataCite, Zenodo, Harvard Dataverse, files to save), `drive.js` (Google sign-in and the
folder structure), `main.js` (the page) and `util.js`.
