// Builds the research fixtures from source, so nothing here is an opaque
// binary: the two PDFs are written by hand-assembled PDF syntax below, and the
// Zotero-shaped library is created from zotero-schema.sql and zotero-data.sql.
//
//   node test/fixtures/research/build.js        rewrites pdfs/*.pdf
//
// Tests call buildLibrary() to lay out a throwaway Zotero data directory
// (zotero.sqlite plus storage/<attachment key>/<file>.pdf).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

// The text of each page, line by line. Sentences the tests quote are kept on
// one line so pdftotext returns them intact.
export const PAPERS = {
  doe2021sparse: [
    [
      'Sparse Attention for Long Documents',
      'Jane Doe and Rex Roe',
      'Abstract. We study sparse attention patterns that let a transformer read',
      'documents of one hundred thousand tokens.',
      '1 Introduction',
      'Dense attention compares every token with every other token.',
      'Its cost grows quadratically with the length of the input.',
      'Attention cost grows linearly with length in our design.',
    ],
    [
      '4 Results',
      'Our sparse model reaches a perplexity of 18.2 on the LongText benchmark.',
      'The dense baseline reaches a perplexity of 21.7 on the same benchmark.',
      'The model was trained on 8 GPUs for 3 days.',
      'Table 2 reports the error on the LongText benchmark for every method.',
    ],
  ],
  lee2019recurrent: [
    [
      'Recurrent Memory for Streaming Text',
      'Min Lee',
      'Abstract. A recurrent memory lets a model read an unbounded stream of text',
      'with constant memory.',
      '1 Method',
      'The memory holds 512 slots that are updated after every segment.',
    ],
    [
      '3 Results',
      'On the LongText benchmark the recurrent memory reaches a perplexity of 19.5.',
      'Training took 2 days on 4 GPUs.',
    ],
  ],
};

function escapePdfText(text) {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

// A minimal PDF 1.4: one Helvetica font, one content stream per page, and a
// cross-reference table with exact byte offsets so strict readers accept it.
export function makePdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesId = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '72 740 Td'];
    for (const line of lines) ops.push(`(${escapePdfText(line)}) Tj T*`);
    ops.push('ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const pdfPath = (citekey) => join(FIXTURE_DIR, 'pdfs', `${citekey}.pdf`);
export const recordedTextPath = (citekey) => join(FIXTURE_DIR, 'pdftotext', `${citekey}.txt`);
export const betterBibtexPath = join(FIXTURE_DIR, 'better-bibtex.json');

// Lays out a Zotero data directory in `dir`: the library database and the
// storage folder Zotero keeps attachments in. The attachment GONE3333 is
// deliberately left without its file.
export function buildLibrary(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'zotero.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(readFileSync(join(FIXTURE_DIR, 'zotero-schema.sql'), 'utf8'));
    db.exec(readFileSync(join(FIXTURE_DIR, 'zotero-data.sql'), 'utf8'));
  } finally {
    db.close();
  }
  for (const [key, citekey] of [['PDFA1111', 'doe2021sparse'], ['PDFB2222', 'lee2019recurrent']]) {
    mkdirSync(join(dir, 'storage', key), { recursive: true });
    copyFileSync(pdfPath(citekey), join(dir, 'storage', key, `${citekey}.pdf`));
  }
  return { dir, sqlite: file, storage: join(dir, 'storage') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [citekey, pages] of Object.entries(PAPERS)) writeFileSync(pdfPath(citekey), makePdf(pages));
  console.log(`wrote ${Object.keys(PAPERS).length} PDFs to ${join(FIXTURE_DIR, 'pdfs')}`);
}
