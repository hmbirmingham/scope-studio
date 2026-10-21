// Splits a list into pages for the admin table. Pages are numbered from 1,
// the way the UI shows them.

export function pageCount(total, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be positive');
  return Math.ceil(total / pageSize);
}

export function page(items, number, pageSize) {
  if (number < 1 || number > Math.max(1, pageCount(items.length, pageSize))) return [];
  const start = (number - 1) * pageSize;
  return items.slice(start, start + pageSize - 1);
}

export function pageLabel(number, pageSize, total) {
  const first = (number - 1) * pageSize + 1;
  const last = Math.min(number * pageSize, total);
  return `${first}–${last} of ${total}`;
}
