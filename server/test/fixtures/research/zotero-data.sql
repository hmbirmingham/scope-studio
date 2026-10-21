-- A tiny library: three papers (two with a PDF), a child note, a related-item
-- relation, an item in the trash and an attachment whose file is missing.
-- Every title, author, DOI and sentence is invented for this fixture; the DOIs
-- use Crossref's 10.5555 test prefix.
INSERT INTO version VALUES ('userdata', 120);
INSERT INTO libraries VALUES (1, 'user', 1);
INSERT INTO itemTypes VALUES (1, 'note'), (2, 'attachment'), (3, 'journalArticle'), (4, 'conferencePaper');
INSERT INTO fields VALUES (1, 'title'), (2, 'abstractNote'), (3, 'date'), (4, 'DOI'), (5, 'extra'), (6, 'citationKey'), (7, 'publicationTitle');
INSERT INTO creatorTypes VALUES (1, 'author'), (2, 'editor');

INSERT INTO items (itemID, itemTypeID, libraryID, key) VALUES
  (1, 4, 1, 'AAAA1111'),
  (2, 3, 1, 'BBBB2222'),
  (3, 3, 1, 'CCCC3333'),
  (4, 2, 1, 'PDFA1111'),
  (5, 2, 1, 'PDFB2222'),
  (6, 1, 1, 'NOTE1111'),
  (7, 3, 1, 'TRASH999'),
  (8, 2, 1, 'GONE3333');

INSERT INTO itemDataValues VALUES
  (1, 'Sparse Attention for Long Documents'),
  (2, 'We study sparse attention patterns that let a transformer read documents of one hundred thousand tokens.'),
  (3, '2021-06-14'),
  (4, '10.5555/fixture.0001'),
  (5, 'Recurrent Memory for Streaming Text'),
  (6, 'A recurrent memory lets a model read an unbounded stream of text with constant memory.'),
  (7, '2019'),
  (8, 'https://doi.org/10.5555/FIXTURE.0002'),
  (9, 'Citation Key: lee2019recurrent'),
  (10, 'A Survey of Efficient Transformers'),
  (11, 'We survey methods that make attention cheaper for long inputs, including sparse attention and recurrent memory.'),
  (12, '2022-01'),
  (13, 'doe2021sparse'),
  (14, 'An Item In The Trash'),
  (15, 'Journal of Fixture Studies');

INSERT INTO itemData VALUES
  (1, 1, 1), (1, 2, 2), (1, 3, 3), (1, 4, 4), (1, 6, 13),
  (2, 1, 5), (2, 2, 6), (2, 3, 7), (2, 4, 8), (2, 5, 9), (2, 7, 15),
  (3, 1, 10), (3, 2, 11), (3, 3, 12),
  (7, 1, 14);

INSERT INTO creators VALUES (1, 'Jane', 'Doe', 0), (2, 'Rex', 'Roe', 0), (3, 'Min', 'Lee', 0), (4, 'Ana', 'Kim', 0), (5, '', 'Fixture Editors', 1);
INSERT INTO itemCreators VALUES (1, 1, 1, 0), (1, 2, 1, 1), (2, 3, 1, 0), (3, 4, 1, 0), (3, 5, 2, 1);

INSERT INTO itemAttachments VALUES
  (4, 1, 0, 'application/pdf', 'storage:doe2021sparse.pdf'),
  (5, 2, 0, 'application/pdf', 'storage:lee2019recurrent.pdf'),
  (8, 3, 0, 'application/pdf', 'storage:missing.pdf');

INSERT INTO itemNotes VALUES (6, 1, '<div><p>Key result: <b>18.2</b> perplexity on LongText &amp; linear cost.</p></div>', 'Key result');

INSERT INTO deletedItems (itemID) VALUES (7);

INSERT INTO relationPredicates VALUES (1, 'dc:relation'), (2, 'owl:sameAs');
INSERT INTO itemRelations VALUES
  (3, 1, 'http://zotero.org/users/local/abcdEFGH/items/AAAA1111'),
  (3, 1, 'http://zotero.org/users/local/abcdEFGH/items/BBBB2222'),
  (3, 2, 'http://zotero.org/groups/1/items/ZZZZ0000');
