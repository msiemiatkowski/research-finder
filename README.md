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
  queries and counts for the PRISMA flow diagram and the search appendix (PRISMA 2020 items 6 and 7). Studies that
  were retracted, withdrawn, corrected or given an expression of concern are flagged (Crossref, with the Retraction
  Watch database); OpenAlex's study-design tags (randomized controlled trial, observational study, systematic review,
  meta-analysis, study protocol and others) are shown and can be filtered on; and studies with replication attempts
  in the FORRT Replication Database list them with their outcomes. Review tools start from "your studies" (added
  from the results or pasted): they check the search against them (relative recall, and why each miss happened),
  search their citations backward and forward, find studies similar to them ("More like these"), and list the works
  the results cite most that the search misses; "Search details" adds the PRISMA-S items, a methods paragraph and the
  automated steps to report, next to a pre-filled PRISMA 2020 flow diagram. A saved search can be run again with the
  same queries, adding only the new records to its folder (MECIR C37 asks for searches less than 12 months old). The
  tab "Registered studies" searches ClinicalTrials.gov with the same English terms (status, phase, participants,
  posted results, linked publications), and studies on the websites of hijacked journals are flagged.
- **Literature reviews.** How many studies each keyword has, existing reviews (Review filter), the most cited and the
  newest work, related phrases and the topics most often studied with yours, every abstract in one sheet, references
  in more than 2,700 citation styles, RIS, BibTeX and CSL-JSON files for reference managers, COinS for the Zotero
  Connector, "Send to Zotero" with the visitor's own key, and links through the visitor's own library (OpenURL link
  resolver or proxy) to paywalled studies.
- **Secondary data analysis.** DataCite, Zenodo, Harvard Dataverse, OSF and OpenAIRE at once, with the open data
  files saved into one Drive folder per dataset and a sheet listing every file.
- **Cross-cultural research.** Studies published in other languages, such as validation studies of adapted
  questionnaires in national journals; filter by the language of the study. "Versions of a questionnaire" searches a
  scale's name (and its acronym, untranslated) with eight method words ("validation", "adaptation", "psychometric
  properties", "factor structure", "reliability", "measurement invariance", "translation", "version") in 39
  languages, optionally only studies citing the original paper (`cites:`). The tab "Regional databases" searches LA
  Referencia, DOAJ and (with the visitor's own application ID) CiNii Research, and Datasets can be limited to
  questionnaires and scales (GESIS ZIS and ZPID PsychArchives in DataCite). An overview counts all the results by
  the countries of their authors, the share with an author in the Global South, language, year, type and journal,
  and each bar filters the results (for example to studies with an author in one country). Their titles come with an automatic
  English translation in [brackets], and an abstract translates with one click, for a first look at what a study is
  about.

## What is saved

Each saved search becomes one folder in the visitor's own Google Drive:

```
Research Finder/
  <keywords> — <date and time>/
    Results          Google Sheet: one row per result with its abstract, the same columns for every source,
                     with links to the files saved for it, each study's design tag, retractions and
                     corrections, and replications, and the English of titles in other languages
                     (automatic translation)
    Results.ris      the same results for Zotero, EndNote, Mendeley, Rayyan, Covidence or ASReview
    Files            Google Sheet: every file found, with its download link, and whether it was saved
                     (and if not, why)
    Search details   Google Doc: keywords, every term and translation used, filters, the exact queries,
                     what was saved and what could not be, the checks on the studies, the PRISMA-S
                     items, a methods paragraph and the automated steps to report
    PRISMA flow diagram.svg
                     the PRISMA 2020 flow diagram with the numbers of the search filled in
    Research Finder search.json
                     the search (exact queries, terms, filters) and the identifiers of the results saved,
                     so that the search can be run again
    Papers/          a search for studies: the open PDFs that could be fetched, named author_year_title
    Datasets/        a search for datasets: one folder per dataset with its open data files
    New results <date and time>, .ris, (files)
                     each time the search is run again: only the records the folder did not have
```

Settings > "Earlier saves" lists the searches saved in the folder. "Run it again and add what is new" runs a save's
exact queries again with the same filters (from "Research Finder search.json"; for saves made before 12 November 2026,
from the queries in its "Search details" and the filters in its link), collects all the results, and adds only those
the folder did not have (matched by DOI, OpenAlex ID and link, or title and year for older saves) as "New results",
with their open files; it notes the run in "Search details" (records found, new, no longer found, and the studies
saved before that Crossref now marks as retracted, withdrawn or with an expression of concern) and updates the
record. A calendar file (`.ics`) can remind the visitor every month for a year; its link (`#earlier`) opens Earlier
saves. Files a save did not copy (a site that does not let browsers download them, a size limit, an interruption) can
also be added later: it reads a save's "Files" sheet, tries those files again (through a file relay where one helps),
puts the new ones into the save's own folders and updates "Files", the "Saved in Drive" column of "Results" and
"Search details".

The results shown can also be exported without Drive, as CSV, RIS, BibTeX or CSL-JSON, or as a reference list in
any citation style. The site is private by design: a static page
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
   is tried again, written as a sentence or not, then after the word for "title" in its language ("Titel: ..."), which
   stops machine translation from making up a sentence for many short titles; one that still fails is not shown. Titles are sent to MinT by language,
   16 to a request, and remembered in the browser. A save, and a CSV or RIS export, translates the titles of all its
   results (up to 2,000 a save) into the column "Title in English (automatic translation)" of "Results" and the CSV,
   and into a note (N1) in the RIS file that says it is an automatic translation; "Search details" counts them.
   Settings can turn this off.
7. **Checks on studies.** Every study shows the design OpenAlex tags automatically from its title, journal and
   abstract (`study_designs`: randomized controlled trial, clinical trial, observational study, case report,
   systematic review, meta-analysis, study protocol), and the filter "Study design" searches by it. The DOIs of the
   studies shown are sent to Crossref, 100 to a request and one request a second, for their update notices (which
   include the Retraction Watch database): retracted, partly retracted, withdrawn or removed studies are flagged, and
   so are expressions of concern and corrections, with the date and a link to the notice. Where Crossref has no
   notice, OpenAlex's own `is_retracted` flag is used (it sometimes marks a correction, so Crossref's answer wins).
   Studies listed as originals in the FORRT Replication Database (FReD) show their replications and reproductions with
   the outcomes FReD records; the site keeps a compact copy of FReD's data in `docs/data/replications.json`. A save,
   and a CSV or RIS export, puts all three into the columns "Study design (automatic tag)", "Retraction or
   correction" and "Replications (FReD)" and into notes (N1) in the RIS file, and "Search details" counts them.
   Settings can turn the Crossref check off.
8. **Review tools.** "Check your search" looks up pasted DOIs, PubMed IDs or OpenAlex IDs of studies the search should
   find (OpenAlex filters `doi:`, `pmid:`, `openalex:`, 100 to a request at 1 credit), then runs each part of the
   search restricted to those works (`filter=openalex:…` with the same filters, a search: 10 credits per part per 100
   works) and reports relative recall with a 95% Wilson interval; for each study it misses it gives the probable
   reason, worked out on the page from its title and abstract (a keyword with none of its terms present, a filter, no
   abstract in OpenAlex). "Citation search" takes the same kind of list and collects the works they cite
   (`referenced_works`, resolved 100 to a request) and the works citing them (`cites:`, newest first, up to 2,000,
   200 to a request), each once, with how each is linked to the starting studies; it can be exported or saved to Drive
   with a "Search details" that reports it as the TARCiS statement asks. "What your results cite most" reads the
   references of the 200 best-matching results of each part of the search, counts the works they cite, and checks
   whether the search finds the 50 cited most. "More like these" takes the same kind of list and puts together the
   works OpenAlex lists as related to each (`related_works`: up to ten, by embedding similarity of title, abstract and
   venue since October 2026), ranks them by how many of the starting studies they are like, optionally goes one step
   further, and checks which ones the search finds. The list ("your studies") is kept in the browser; "☆ Add to your
   studies" under each result adds to it, and Review tools › Your studies lists, cites, exports or saves it. A check
   of the search, a citation search and a similar-studies search of the same visit are written into "Search details"
   when the search is saved.
9. **Reporting.** "Search details" also has the 16 PRISMA-S items, filled in where Research Finder knows the answer
   and marked [to complete] where it does not, a methods paragraph to adapt, and the automated steps a review should
   disclose (term suggestions, machine translation, ranking, design tags, deduplication). Each save adds "PRISMA flow
   diagram.svg", the PRISMA 2020 flow diagram for new reviews with the records the search found filled in, the
   duplicates within the search when all results were saved, and the records from a citation search of the same visit;
   every other box is left as (n = …). Export › PRISMA 2020 flow diagram gives the same diagram without a save.
10. **References and library links.** "Cite" formats a reference with the DOI Foundation's citation formatter
   (`citation.doi.org/format`, CSL styles, about four requests a second, cached for the visit); a record without a DOI
   gets an APA reference made from OpenAlex's data, with names split heuristically. Export adds BibTeX and CSL-JSON
   next to RIS (all with volume, issue, pages, ISSN and publisher from OpenAlex's `biblio` and source), and every
   result carries a COinS span (OpenURL Z39.88-2004) for the Zotero Connector. Under Settings, a visitor can add their
   library's OpenURL link resolver (a pasted Alma, SFX or Google Scholar library link is cut down to the library's own
   parameters) and proxy prefix (EZproxy `login?url=`, OpenAthens, or a template with `{url}`); each study then links
   to "Find it at my library" and "Through my library". Nothing is fetched for these links.
11. **Overview.** One OpenAlex request per part of the search, with `group_bys` (a search: 10 credits, whatever the
   number of groupings), counts all the results by `publication_year`, `type`, `language`, `authorships.countries`,
   `authorships.institutions.is_global_south` (true when at least one author's institution is in the Global South),
   `primary_location.source.id` and `open_access.is_oa`; the parts' counts are added. Bars set the filters, including
   two the overview adds: authors' countries (`authorships.countries:`) and the Global South
   (`authorships.institutions.is_global_south:true`). A saved search's "Search details" gets the overview of the visit.
12. **Registered studies.** ClinicalTrials.gov's API (version 2, CORS-open, keyless, no published rate limit; requests
   start about 0.8 s apart): `query.term` with the English terms as one Boolean query (up to 1,800 characters), filters
   on overall status, start date and study type (`filter.advanced` with `AREA[StartDate]RANGE[…]`, `AREA[StudyType]`),
   `aggFilters=results:with`, token paging, 1,000 a request when saving. Records carry status, phase, study type,
   participants, dates, conditions, interventions, countries, the PMIDs of linked publications and other IDs, in their
   own sheet columns; the PRISMA diagram counts them under "Registers". Studies whose abstracts give an NCT or ISRCTN
   number link to the registry.
13. **Regional databases.** LA Referencia's VuFind API (`lookfor` with `type=AllFields`, the English, Spanish and
   Portuguese terms up to 1,400 characters, `filter[]=publishDate:"[a TO b]"`, `sort=year`), DOAJ's article search
   (the query in the address, all languages, shortened until the encoded address is at most 1,800 characters, as longer
   ones get HTTP 502; `bibjson.year:[a TO b]`; about two requests a second) and CiNii Research's OpenSearch (`articles`,
   Japanese and English terms, `from`/`until`, only with an `appid` the visitor adds). Records are interleaved and kept
   once by DOI, or by title and year; the counts per database go into the PRISMA diagram. A keyword can carry other
   names after " | " (an acronym in capitals is not translated), and the keyword `[validation or adaptation]` is the
   bundle of method words, translated by MinT without the study-wording step. Datasets' filter "Questionnaires and
   scales only" asks DataCite alone for `prefix:10.6102 OR (prefix:10.23668 AND types.resourceType:test)`.
14. **Journals and Zotero.** OpenAlex's `is_in_doaj` gives a DOAJ badge linking to the journal's DOAJ page. Retraction
   Watch's Hijacked Journal Checker (a Google Sheet read through `gviz/tq?tqx=out:csv`, kept a day in the browser)
   gives the web addresses of fake copies of real journals; a study whose landing page or PDF is on one is flagged
   (the shared ISSN alone is not used, as the copies take it from the real journal). "Send to Zotero" checks the
   visitor's key (`/keys/current`), makes a collection and posts the records 50 to a request with a write token,
   keeping only the fields Zotero lists for each item type (`/itemTypeFields`); the key stays in sessionStorage unless
   the visitor asks to remember it.

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
- OpenAlex's design tags are precise (at least 96% right, randomized controlled trials 99%, by its own benchmark) but
  miss many studies, and a study without an abstract is never tagged: the filter finds studies, it should not be
  used to leave any out of a review. Designs outside the seven, such as qualitative studies, have no tag.
- Retraction flags cover studies with Crossref DOIs and notices that publishers or Retraction Watch recorded; a study
  without a flag can still be flawed. FReD lists about 2,600 findings, most of them from psychology, so a study it
  does not list may still have been replicated.
- OSF and figshare files cannot be copied into Drive by a browser alone; the "Files" sheet has their download links,
  or a file relay copies them (below).
- Running a saved search again collects all its results, so it costs as many OpenAlex requests as saving all of them;
  without a key a large search may stop early (then what it got is added and the next run adds the rest). New records
  are newly retrieved, not necessarily newly published. OpenAlex recomputes its similar works from time to time, so
  "More like these" can give other studies later.
- The overview's counts are OpenAlex's: a study two parts of a search find counts twice, countries are those of the
  authors' institutions (not of the samples), and OpenAlex's language labels overstate English.
- The regional databases overlap with OpenAlex by an unmeasured amount, DOAJ's relevance ranking is loose for short
  acronyms, and CiNii Research is searched only with the visitor's own application ID, as CiNii asks.
- ClinicalTrials.gov is searched in English only, and other registries (WHO ICTRP, ISRCTN, EU CTR) are not searched,
  only linked. The hijacked-journal list has confirmed cases only and comes from a Google Sheet without stated terms of
  use, read as it is published; its layout could change.
- Formatted references come from the metadata registered with each DOI: titles sometimes lack their subtitle, and
  italics are not kept. OpenAlex does not say which part of a name is the family name, so references made without a
  DOI, and BibTeX and CSL-JSON names, may split some names wrongly.

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
the translation and its check), `sources.js` (OpenAlex, DataCite, Zenodo, Harvard Dataverse, OSF, OpenAIRE, ClinicalTrials.gov, LA Referencia, DOAJ, CiNii Research, files to save), `checks.js`
(study designs, retractions and corrections from Crossref, replications from FReD, DOAJ and hijacked journals), `review.js` (checking the search
against known studies, citation searching, similar studies, your studies, what the results cite, the PRISMA flow
diagram), `cite.js` (library links, COinS, BibTeX, CSL-JSON, formatted references), `zotero.js` (Send to Zotero),
`drive.js` (Google sign-in, the
folder structure, adding new results to a save), `main.js` (the search page), `landing.js` (the tabs of the front page) and
`util.js`. The front page's worked example ("trust in science") is written into `docs/index.html` with the numbers
of a real search; run it again and update them when they age. Module imports carry a version
(`?v=39`); change it in every file at once when publishing changes, so that browsers do not mix old and new modules.

The replications come from the [FORRT Replication Database](https://forrt.org/replication-hub/) (FReD; data
CC BY 4.0), which FORRT rebuilds every week. `python3 tools/replications.py` downloads its current data and rewrites
`docs/data/replications.json`, the compact copy the site uses (about 450 KB, 140 KB compressed); run it from time to
time and publish the file.

## Creator

Research Finder is made by **Maciej Siemiątkowski**, researcher at the Faculty of Psychology, University of Warsaw.
Questions, ideas or problems: [maciej.siemiatkowski@psych.uw.edu.pl](mailto:maciej.siemiatkowski@psych.uw.edu.pl), or
open an issue in this repository.

To cite it: Siemiątkowski, M. (2026). *Research Finder* [Computer software].
https://msiemiatkowski.github.io/research-finder/
