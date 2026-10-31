// Granola holds lecture notes, not meetings. Every note in this corpus lists one
// participant and has empty private notes: Hynes records a class and Granola
// writes the summary. So this connector does not mine for action items, owners
// or decisions the way meeting-notes tooling usually does — on course material
// that extraction returns nothing. It maps a summary to a note, a folder to a
// project, and leaves the concepts to be linked later.
//
// Transport is deliberately not here. Granola is an MCP server behind OAuth,
// and `scope` becomes its own MCP client in phase 1; until then the payloads
// arrive as a JSON file. The transform is the part worth testing, and it does
// not change when the transport does.

/** A filename-safe slug: date first so the directory sorts chronologically. */
export function slugFor({ meetingAt, title }) {
  const date = (meetingAt ?? '').slice(0, 10) || 'undated';
  const words = (title ?? 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  // Truncate on a word boundary. A blind slice produced names like
  // "...-feature-sampling-and-variable-i", which is a worse filename than a
  // slightly shorter one.
  let name = words;
  if (name.length > 60) {
    const cut = name.slice(0, 60);
    const lastWord = cut.lastIndexOf('-');
    name = lastWord > 0 ? cut.slice(0, lastWord) : cut;
  }
  return `${date}-${name.replace(/-$/, '') || 'untitled'}`;
}

/**
 * The vault note for one Granola meeting.
 *
 * `granolaUpdatedAt` is carried in the frontmatter because Granola regenerates
 * a summary after the fact — one lecture here was written at 9:22 and rewritten
 * at 10:08. Without it the ingest would keep the worse first draft forever.
 */
export function meetingNote(meeting) {
  const slug = slugFor(meeting);
  const folder = meeting.folders?.[0]?.title ?? null;
  const hasTranscript = typeof meeting.transcript === 'string' && meeting.transcript.trim() !== '';

  const header = [
    folder ? `[[${folder}]]` : null,
    meeting.url ? `[Granola](${meeting.url})` : null,
    hasTranscript ? `[[${slug}-transcript|transcript]]` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Private notes are the only part of a Granola note the user typed himself,
  // so they go above the generated summary and are never dropped. Most notes
  // have none; the ones that do are the highest-signal lines in the corpus.
  const mine = (meeting.privateNotes ?? '').trim();
  const body = [
    `# ${meeting.title}`,
    '',
    header,
    '',
    ...(mine ? ['## My notes', '', mine, ''] : []),
    (meeting.summary ?? '').trim(),
  ]
    .join('\n')
    .trimEnd();

  return {
    relPath: `meetings/${slug}.md`,
    fields: {
      type: 'granola-meeting',
      granola_id: meeting.id,
      granola_updated_at: meeting.updatedAt ?? undefined,
      meeting_at: meeting.meetingAt ?? undefined,
      title: meeting.title,
      project: folder ?? undefined,
      url: meeting.url ?? undefined,
      has_transcript: hasTranscript,
      has_private_notes: mine !== '',
    },
    body,
  };
}

/**
 * The transcript as its own note. A lecture transcript runs ~27k characters —
 * roughly 7k tokens — so inlining it would swamp any retrieval budget and make
 * the readable note unreadable. It lives beside the summary and is linked from
 * it, chunked for embedding later.
 */
export function transcriptNote(meeting) {
  const slug = slugFor(meeting);
  return {
    relPath: `meetings/transcripts/${slug}-transcript.md`,
    fields: {
      type: 'granola-transcript',
      granola_id: meeting.id,
      granola_updated_at: meeting.updatedAt ?? undefined,
      meeting_at: meeting.meetingAt ?? undefined,
      title: `${meeting.title} — transcript`,
      of: `meetings/${slug}.md`,
      chars: meeting.transcript.length,
    },
    body: [`# ${meeting.title} — transcript`, '', `[[${slug}|summary]]`, '', meeting.transcript.trim()].join('\n'),
  };
}

/**
 * A stub note per Granola folder. Deliberately a stub: Obsidian computes
 * backlinks, so listing the meetings here would duplicate an index the tool
 * already maintains and then let it go stale.
 */
export function projectNote(folder) {
  return {
    relPath: `projects/${folder.title}.md`,
    fields: {
      type: 'project',
      source: 'granola-folder',
      granola_folder_id: folder.id,
      title: folder.title,
    },
    body: [`# ${folder.title}`, '', 'Meetings and notes linking here collect below as backlinks.'].join('\n'),
  };
}

/** Every distinct folder across the payload, in first-seen order. */
export function foldersIn(meetings) {
  const seen = new Map();
  for (const meeting of meetings) {
    for (const folder of meeting.folders ?? []) {
      if (folder?.title && !seen.has(folder.id ?? folder.title)) seen.set(folder.id ?? folder.title, folder);
    }
  }
  return [...seen.values()];
}

/**
 * What the ingest would write, and what it would leave alone.
 * `existing` maps relPath to the granola_updated_at already in the vault.
 * @returns {{writes: Array, skipped: Array}}
 */
export function planIngest(meetings, existing = new Map()) {
  const writes = [];
  const skipped = [];

  const consider = (note, meeting) => {
    const previous = existing.get(note.relPath);
    // Unchanged upstream means nothing to write: re-writing would churn the
    // vault's git history and could clobber a hand edit for no new content.
    if (previous !== undefined && previous === (meeting.updatedAt ?? undefined)) {
      skipped.push({ relPath: note.relPath, reason: 'unchanged upstream' });
      return;
    }
    writes.push({ ...note, isUpdate: previous !== undefined });
  };

  for (const folder of foldersIn(meetings)) {
    const note = projectNote(folder);
    if (existing.has(note.relPath)) skipped.push({ relPath: note.relPath, reason: 'project note exists' });
    else writes.push({ ...note, isUpdate: false });
  }
  for (const meeting of meetings) {
    consider(meetingNote(meeting), meeting);
    if (typeof meeting.transcript === 'string' && meeting.transcript.trim() !== '') {
      consider(transcriptNote(meeting), meeting);
    }
  }
  return { writes, skipped };
}
