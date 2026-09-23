import { randomUUID } from 'node:crypto';

// Ingesting a repository takes minutes — fetching trees, chunking, embedding —
// so it cannot sit on a request. Jobs run in the background and the client
// polls for progress. State is per-process and in memory, which suits the
// desktop target; ingestion is idempotent, so a lost job is re-runnable.
const MAX_JOBS = 50;
const TTL_MS = 60 * 60 * 1000;

const jobs = new Map();

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt < cutoff) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

export function runningJobFor(ownerId) {
  for (const job of jobs.values()) {
    if (job.ownerId === ownerId && job.state === 'running') return job;
  }
  return null;
}

// `run` receives a reporter; whatever it passes is merged into the job's
// progress, so the shape stays the caller's business.
export function startJob(ownerId, kind, run) {
  const job = {
    id: randomUUID(),
    ownerId,
    kind,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    progress: {},
    summary: null,
    error: null,
  };
  jobs.set(job.id, job);
  prune();

  const report = (progress) => {
    job.progress = { ...job.progress, ...progress };
  };

  // Deliberately not awaited: the request returns the job id immediately.
  Promise.resolve()
    .then(() => run(report))
    .then((summary) => {
      job.summary = summary;
      job.state = 'done';
    })
    .catch((err) => {
      job.error = err.message;
      job.state = 'failed';
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return job;
}

export function getJob(ownerId, id) {
  const job = jobs.get(id);
  return job && job.ownerId === ownerId ? job : null;
}

export function presentJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    progress: job.progress,
    summary: job.summary,
    error: job.error,
  };
}

export function resetJobs() {
  jobs.clear();
}
