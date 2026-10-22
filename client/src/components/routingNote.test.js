import { describe, expect, it } from 'vitest';
import { routingNote } from './routingNote.js';

describe('routingNote', () => {
  it('says how the context was assembled', () => {
    expect(routingNote({ contextReused: true })).toEqual(['same context']);
    expect(routingNote({ prefilled: true })).toEqual(['prefilled']);
    expect(routingNote({})).toEqual([]);
    expect(routingNote(undefined)).toEqual([]);
  });

  it('says when a cloud answer did not see a script run in the conversation', () => {
    expect(routingNote({ contextReused: true, runOutput: 'withheld' })).toEqual([
      'same context',
      'script output kept on this machine',
    ]);
    expect(routingNote({ contextReused: true, runOutput: 'included' })).toEqual(['same context']);
  });
});
