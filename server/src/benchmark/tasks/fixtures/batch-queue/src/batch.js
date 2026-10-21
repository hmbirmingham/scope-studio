// Runs jobs one at a time, in order, and collects their results. Jobs talk to
// a rate-limited service, so they must never overlap.

export async function runInOrder(items, job) {
  const results = [];
  items.forEach(async (item) => {
    results.push(await job(item));
  });
  return results;
}

export async function runBatches(items, size, job) {
  const out = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    out.push(await runInOrder(batch, job));
  }
  return out;
}
