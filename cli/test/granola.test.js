import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldersIn, meetingNote, planIngest, projectNote, slugFor, transcriptNote } from '../src/connectors/granola.js';

const lecture = {
  id: '12490d11-9c3c-4fb6-834c-0e2f85148dfc',
  title: 'Random forest models: bagging, feature sampling, and variable importance',
  meetingAt: '2026-10-30T09:22:29.078-04:00',
  updatedAt: '2026-10-30T10:08:55.277Z',
  url: 'https://notes.granola.ai/d/12490d11-9c3c-4fb6-834c-0e2f85148dfc',
  folders: [{ id: '0c89d3f0-1931-46fc-915e-27c515a46142', title: 'CSE 2600' }],
  summary: '# Trees, Bagging, and Random Forests\n\n- Single trees underfit early\n',
  transcript: 'Microphone: Yeah, I get all the questions from this side.',
};

test('the slug sorts by date and survives a long punctuated title', () => {
  assert.equal(
    slugFor(lecture),
    '2026-10-30-random-forest-models-bagging-feature-sampling-and-variable'
  );
  assert.equal(slugFor({ title: 'x' }), 'undated-x');
  assert.equal(slugFor({ meetingAt: '2026-01-02T00:00:00Z', title: '!!!' }), '2026-01-02-untitled');
  // Truncation never ends mid-word and never leaves a trailing hyphen.
  const long = slugFor({ meetingAt: '2026-01-02T00:00:00Z', title: 'a'.repeat(80) });
  assert.doesNotMatch(long, /-$/);
});

test('a meeting note links its project, its source and its transcript', () => {
  const note = meetingNote(lecture);
  assert.equal(note.relPath, 'meetings/2026-10-30-random-forest-models-bagging-feature-sampling-and-variable.md');
  assert.equal(note.fields.project, 'CSE 2600');
  assert.equal(note.fields.granola_updated_at, lecture.updatedAt);
  assert.equal(note.fields.has_transcript, true);
  assert.match(note.body, /\[\[CSE 2600\]\]/);
  assert.match(note.body, /\[Granola\]\(https:\/\/notes\.granola\.ai/);
  assert.match(note.body, /\|transcript\]\]/);
  assert.match(note.body, /# Trees, Bagging, and Random Forests/);
});

test('a meeting with no folder and no transcript still produces a valid note', () => {
  const note = meetingNote({ id: 'x', title: 'Solo note', meetingAt: '2026-10-30T00:00:00Z' });
  assert.equal(note.fields.project, undefined);
  assert.equal(note.fields.has_transcript, false);
  assert.doesNotMatch(note.body, /\[\[/);
});

test('the transcript is a separate note that links back, not an inlined wall of text', () => {
  const summary = meetingNote(lecture);
  const transcript = transcriptNote(lecture);
  assert.match(transcript.relPath, /^meetings\/transcripts\//);
  assert.equal(transcript.fields.of, summary.relPath);
  assert.equal(transcript.fields.chars, lecture.transcript.length);
  assert.doesNotMatch(summary.body, /Microphone:/, 'the readable note stays readable');
});

test('folders are deduplicated across meetings and become stub project notes', () => {
  const second = { ...lecture, id: 'other', title: 'Resampling', folders: lecture.folders };
  assert.deepEqual(foldersIn([lecture, second]).map((f) => f.title), ['CSE 2600']);
  const note = projectNote(lecture.folders[0]);
  assert.equal(note.relPath, 'projects/CSE 2600.md');
  // A stub on purpose: Obsidian computes backlinks, so an index written here
  // would only go stale.
  assert.doesNotMatch(note.body, /Random forest/);
});

test('an unchanged meeting is skipped, so re-ingest does not churn the vault', () => {
  const note = meetingNote(lecture);
  const existing = new Map([
    [note.relPath, lecture.updatedAt],
    [transcriptNote(lecture).relPath, lecture.updatedAt],
    ['projects/CSE 2600.md', undefined],
  ]);
  const { writes, skipped } = planIngest([lecture], existing);
  assert.deepEqual(writes, []);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), [
    'project note exists',
    'unchanged upstream',
    'unchanged upstream',
  ]);
});

test('a regenerated summary is re-ingested as an update, not kept at the first draft', () => {
  const note = meetingNote(lecture);
  // Granola rewrote this lecture's summary 45 minutes after creating it.
  const existing = new Map([[note.relPath, '2026-10-30T09:22:29.078Z']]);
  const { writes } = planIngest([lecture], existing);
  const updated = writes.find((w) => w.relPath === note.relPath);
  assert.equal(updated.isUpdate, true);
  assert.equal(updated.fields.granola_updated_at, lecture.updatedAt);
});

test('a fresh vault gets the project note, the summary and the transcript', () => {
  const { writes, skipped } = planIngest([lecture]);
  assert.deepEqual(writes.map((w) => w.relPath), [
    'projects/CSE 2600.md',
    'meetings/2026-10-30-random-forest-models-bagging-feature-sampling-and-variable.md',
    'meetings/transcripts/2026-10-30-random-forest-models-bagging-feature-sampling-and-variable-transcript.md',
  ]);
  assert.deepEqual(skipped, []);
});

test('private notes are kept above the generated summary, never dropped', () => {
  const note = meetingNote({ ...lecture, privateNotes: 'Survey? for activities in charteroaks' });
  assert.equal(note.fields.has_private_notes, true);
  assert.match(note.body, /## My notes\n\nSurvey\? for activities in charteroaks/);
  // His words come before Granola's.
  assert.ok(note.body.indexOf('## My notes') < note.body.indexOf('# Trees, Bagging'));
});

test('a note with no private notes gets no empty section', () => {
  const note = meetingNote(lecture);
  assert.equal(note.fields.has_private_notes, false);
  assert.doesNotMatch(note.body, /## My notes/);
});
