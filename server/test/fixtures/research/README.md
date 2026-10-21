# Research fixtures

Source: written for Scope Studio's research plug-in tests. Every paper title,
author, DOI, abstract and sentence here is invented; the DOIs use Crossref's
`10.5555` test prefix and resolve to nothing real.

Licence: CC0 1.0 (public domain dedication). No third-party files are included.

| File | What it is |
|---|---|
| `zotero-schema.sql` | The subset of Zotero's `zotero.sqlite` schema the ingest reads, with Zotero's own table and column names. |
| `zotero-data.sql` | A three-paper library: two PDF attachments, a child note, `dc:relation` links, an item in the trash and an attachment whose file is missing. |
| `better-bibtex.json` | The same library as a Better BibTeX JSON export, plus a standalone note. Attachment paths are relative to this folder. |
| `pdfs/*.pdf` | Two two-page PDFs written by `build.js` from the text in `PAPERS` (hand-assembled PDF 1.4, Helvetica). |
| `pdftotext/*.txt` | What `pdftotext -enc UTF-8` (poppler 24.02) printed for each PDF, so tests can run the ingest where poppler is not installed. |
| `build.js` | Rebuilds the PDFs (`node test/fixtures/research/build.js`) and lays out a throwaway Zotero data directory for tests (`buildLibrary(dir)`). |
