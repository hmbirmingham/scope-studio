import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ResearchError } from './text.js';

// PDF text through poppler's pdftotext. It runs on the user's own library
// files, never on anything a model wrote, with a fixed argument list (no
// shell), a time limit and a cap on what it may print. The page range and
// the path are the only variable arguments: the page numbers are integers
// checked here and the path is absolute, so neither can be read as an option.

export const PDF_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxPages: 300,
  timeoutMs: 60_000,
};

function run(command, args, { timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxOutputBytes, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }))
    );
  });
}

// `command` and `recorded` are seams for tests: a missing command exercises
// the tool-unavailable path, and `recorded` maps a PDF path to text that
// pdftotext printed earlier, for machines without poppler.
export function createPdfText({ command = 'pdftotext', recorded = null, limits = PDF_LIMITS } = {}) {
  let availability = null;

  async function status() {
    if (recorded) return { available: true, recorded: true, version: 'recorded' };
    if (!availability) {
      availability = run(command, ['-v'], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
        .then(({ stdout, stderr }) => ({ available: true, version: (`${stderr}${stdout}`.match(/pdftotext version (\S+)/) ?? [])[1] ?? 'unknown' }))
        .catch((err) => {
          // Old poppler exits 99 for -v but still printed its version.
          if (err.code !== 'ENOENT' && /pdftotext version/.test(`${err.stderr ?? ''}`)) return { available: true, version: (err.stderr.match(/pdftotext version (\S+)/) ?? [])[1] };
          return { available: false, reason: err.code === 'ENOENT' ? `${command} is not installed` : `${command} did not run: ${err.message}` };
        });
    }
    return availability;
  }

  // The text of each page, in order (pdftotext separates pages with a form
  // feed). `firstPage`/`lastPage` narrow it to a range; the returned pages
  // then start at firstPage.
  async function pages(path, { firstPage = 1, lastPage = null } = {}) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new ResearchError('invalid_path', 'a PDF path must be absolute');
    if (!Number.isInteger(firstPage) || firstPage < 1) throw new ResearchError('invalid_page', 'pages start at 1');
    const last = lastPage == null ? firstPage + limits.maxPages - 1 : lastPage;
    if (!Number.isInteger(last) || last < firstPage) throw new ResearchError('invalid_page', 'lastPage must not come before firstPage');

    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new ResearchError('pdf_missing', `${path} is not a file`);
    if (info.size > limits.maxFileBytes) throw new ResearchError('pdf_too_large', `${path} is larger than ${limits.maxFileBytes} bytes`);

    let text;
    if (recorded) {
      const file = recorded[path];
      if (!file) throw new ResearchError('pdf_unreadable', `no recorded text for ${path}`);
      const all = (await readFile(file, 'utf8')).split('\f');
      text = all.slice(firstPage - 1, last).join('\f');
    } else {
      const state = await status();
      if (!state.available) throw new ResearchError('pdftotext_unavailable', state.reason);
      try {
        ({ stdout: text } = await run(command, ['-enc', 'UTF-8', '-q', '-f', String(firstPage), '-l', String(last), path, '-'], limits));
      } catch (err) {
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new ResearchError('pdf_too_large', `pdftotext printed more than ${limits.maxOutputBytes} bytes for ${path}`);
        if (err.killed) throw new ResearchError('pdf_timeout', `pdftotext took longer than ${limits.timeoutMs} ms on ${path}`);
        throw new ResearchError('pdf_unreadable', `pdftotext could not read ${path}: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
      }
    }
    const out = text.split('\f');
    // pdftotext ends the last page with a form feed, leaving one empty entry.
    if (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
    return out;
  }

  return { status, pages };
}

export const defaultPdfText = createPdfText();
