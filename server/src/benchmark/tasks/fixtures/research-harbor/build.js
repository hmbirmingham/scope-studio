// Rebuilds this fixture's PDFs, Better BibTeX export and recorded pdftotext
// output from the text below. A maintenance script only; the benchmark reads
// the files it writes.
//
//   node src/benchmark/tasks/fixtures/research-harbor/build.js
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf } from '../../../../../test/fixtures/research/build.js';

const here = dirname(fileURLToPath(import.meta.url));

// Five invented papers on one invented benchmark (Harbor). One holds the
// answer (Kelp, 7.4% in Table 2); two are near misses: a lower number on a
// different benchmark, and an abstract that rounds down.
export const PAPERS = [
  {
    key: 'HARB0001', citekey: 'ito2020harbor', title: 'The Harbor Benchmark for Noisy Speech', authors: [['Kenji', 'Ito']], date: '2020', doi: '10.5555/harbor.0001',
    abstract: 'We introduce Harbor, a benchmark of transcribed speech recorded in noisy ports, and report baseline word error rates.',
    pages: [
      ['The Harbor Benchmark for Noisy Speech', 'Kenji Ito', 'Harbor holds 120 hours of speech recorded on docks and ships.', 'Every system is scored by word error rate on the Harbor test set.'],
      ['3 Baselines', 'Table 1: Word error rate on the Harbor benchmark.', 'Hidden Markov baseline 14.2', 'Recurrent baseline 11.6', 'Lower is better.'],
    ],
  },
  {
    key: 'TIDE0002', citekey: 'novak2021tidal', title: 'Tidal: Convolutional Acoustic Models for Noisy Speech', authors: [['Eva', 'Novak']], date: '2021', doi: '10.5555/harbor.0002',
    abstract: 'Tidal stacks dilated convolutions to model long acoustic context in noisy recordings.',
    pages: [
      ['Tidal: Convolutional Acoustic Models for Noisy Speech', 'Eva Novak', 'Tidal uses dilated convolutions over log-mel features.'],
      ['5 Results', 'Table 3: Word error rate on the Harbor benchmark.', 'Recurrent baseline 11.6', 'Tidal 9.8'],
    ],
  },
  {
    key: 'KELP0003', citekey: 'osei2022kelp', title: 'Kelp: Streaming Transformers for Speech in Noise', authors: [['Ama', 'Osei'], ['Luis', 'Ortega']], date: '2022', doi: '10.5555/harbor.0003',
    abstract: 'Kelp is a streaming transformer with a noise-aware front end.',
    pages: [
      ['Kelp: Streaming Transformers for Speech in Noise', 'Ama Osei and Luis Ortega', 'Kelp attends over a sliding window of 64 frames.'],
      ['4 Experiments', 'Table 2: Word error rate on the Harbor benchmark.', 'Tidal 9.8', 'Kelp 7.4'],
    ],
  },
  {
    key: 'REEF0004', citekey: 'park2022reef', title: 'Reef: Data Augmentation for Noisy Speech', authors: [['Ji-woo', 'Park']], date: '2022', doi: '10.5555/harbor.0004',
    abstract: 'Reef mixes recorded engine and wind noise into training audio.',
    pages: [
      ['Reef: Data Augmentation for Noisy Speech', 'Ji-woo Park', 'Reef adds noise from 40 recorded sources during training.'],
      ['6 Results', 'Table 4: Word error rate.', 'Reef on the Harbor benchmark 8.1', 'Reef on the Lagoon benchmark 6.9'],
    ],
  },
  {
    key: 'DRFT0005', citekey: 'silva2023drift', title: 'Drift: Self-Training at Scale for Speech', authors: [['Rita', 'Silva']], date: '2023', doi: '10.5555/harbor.0005',
    abstract: 'Drift self-trains on unlabelled audio and approaches a 7% word error rate on noisy benchmarks.',
    pages: [
      ['Drift: Self-Training at Scale for Speech', 'Rita Silva', 'Drift labels 10,000 hours of audio with its own earlier model.'],
      ['5 Evaluation', 'Table 2: Word error rate on the Harbor benchmark.', 'Drift 7.9', 'Drift without self-training 10.3'],
    ],
  },
];

export const ANSWER = { method: 'Kelp', citekey: 'osei2022kelp', table: 'Table 2' };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const items = PAPERS.map((paper) => {
    writeFileSync(join(here, 'pdfs', `${paper.citekey}.pdf`), makePdf(paper.pages));
    return {
      itemType: 'journalArticle',
      itemKey: paper.key,
      citationKey: paper.citekey,
      title: paper.title,
      abstractNote: paper.abstract,
      date: paper.date,
      DOI: paper.doi,
      creators: paper.authors.map(([firstName, lastName]) => ({ firstName, lastName, creatorType: 'author' })),
      attachments: [{ itemKey: `${paper.key.slice(0, 4)}PDF${paper.key.slice(-1)}`, path: `pdfs/${paper.citekey}.pdf`, contentType: 'application/pdf' }],
      notes: [],
      relations: {},
    };
  });
  writeFileSync(join(here, 'library.json'), `${JSON.stringify({ config: { label: 'BetterBibTeX JSON' }, items }, null, 2)}\n`);
  for (const paper of PAPERS) {
    const text = execFileSync('pdftotext', ['-enc', 'UTF-8', '-q', join(here, 'pdfs', `${paper.citekey}.pdf`), '-'], { encoding: 'utf8' });
    writeFileSync(join(here, 'pdftotext', `${paper.citekey}.txt`), text);
  }
  console.log(`wrote ${PAPERS.length} papers to ${here}`);
}
