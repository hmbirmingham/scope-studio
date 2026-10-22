// The short note beside an answer's sources: how its context was assembled,
// and whether a script's output was kept back from a cloud answer. Saying so
// matters: the answer did not see the output, and the user should know why.
export function routingNote(routing) {
  const reuse = routing?.contextReused ? 'same context' : routing?.prefilled ? 'prefilled' : null;
  const output = routing?.runOutput === 'withheld' ? 'script output kept on this machine' : null;
  return [reuse, output].filter(Boolean);
}
