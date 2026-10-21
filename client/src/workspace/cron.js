// Cron schedules for recurring tasks, client side: presets, a human-readable
// preview and the next few run times. Five fields in UTC, the same dialect as
// server/src/workspace/cron.js, which stays the authority: the form previews
// here and the server's 400 (with its cron error) is what decides.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

export const CRON_PRESETS = [
  { id: 'every15', label: 'Every 15 minutes', expression: '*/15 * * * *' },
  { id: 'hourly', label: 'Every hour', expression: '0 * * * *' },
  { id: 'daily', label: 'Every day at 09:00', expression: '0 9 * * *' },
  { id: 'weekdays', label: 'Weekdays at 09:00', expression: '0 9 * * 1-5' },
  { id: 'weekly', label: 'Mondays at 09:00', expression: '0 9 * * 1' },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SEARCH_LIMIT_MINUTES = 8 * 366 * 24 * 60;

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`invalid ${name} "${part}"`);
    const [, whole, from, to, stepText] = match;
    const step = stepText ? Number(stepText) : 1;
    let start = min;
    let end = max;
    if (whole !== '*') {
      start = Number(from);
      end = to !== undefined ? Number(to) : stepText ? max : start;
    }
    if (step < 1 || start < min || end > max || start > end) throw new Error(`invalid ${name} "${part}"`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression) {
  if (typeof expression !== 'string') throw new Error('a schedule must be a string');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('a schedule needs five fields: minute hour day-of-month month day-of-week');
  const [minutes, hours, days, months, weekdays] = parts.map((part, i) => parseField(part, FIELDS[i]));
  if (weekdays.has(7)) weekdays.add(0);
  return { parts, minutes, hours, days, months, weekdays, dayRestricted: !parts[2].startsWith('*'), weekdayRestricted: !parts[4].startsWith('*') };
}

function dayMatches(cron, date) {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const dayOk = cron.days.has(date.getUTCDate());
  const weekdayOk = cron.weekdays.has(date.getUTCDay());
  if (cron.dayRestricted && cron.weekdayRestricted) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

// The next `count` times strictly after `from`, as Dates. Throws on a bad
// expression; returns fewer (or none) for a schedule that rarely or never fires.
// The preview runs on every keystroke, so a day or hour that cannot match is
// skipped whole rather than walked a minute at a time.
export function nextRuns(expression, from = new Date(), count = 3) {
  const cron = parseCron(expression);
  const out = [];
  const end = from.getTime() + SEARCH_LIMIT_MINUTES * 60_000;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  while (cursor.getTime() <= end && out.length < count) {
    if (!dayMatches(cron, cursor)) {
      cursor.setUTCHours(24, 0, 0, 0);
    } else if (!cron.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
    } else {
      if (cron.minutes.has(cursor.getUTCMinutes())) out.push(new Date(cursor.getTime()));
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
  }
  return out;
}

// `null` when the expression is usable, else the reason in the server's words.
export function cronError(expression) {
  try {
    if (nextRuns(expression, new Date(Date.UTC(2000, 0, 1)), 1).length === 0) return 'this schedule never matches a date';
    return null;
  } catch (error) {
    return error.message;
  }
}

const pad = (value) => String(value).padStart(2, '0');
const isEvery = (part) => part === '*';
const isSingle = (part) => /^\d+$/.test(part);

function listWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function dayOfWeekWords(part) {
  if (part === '1-5') return 'Monday through Friday';
  if (part === '0,6' || part === '6,0') return 'Saturday and Sunday';
  const range = /^(\d)-(\d)$/.exec(part);
  if (range) return `${DAY_NAMES[Number(range[1])]} through ${DAY_NAMES[Number(range[2])]}`;
  if (/^\d(,\d)*$/.test(part)) return listWords(part.split(',').map((day) => DAY_NAMES[Number(day)]));
  return `day-of-week ${part}`;
}

function timeWords(minutePart, hourPart) {
  if (isSingle(minutePart) && isSingle(hourPart)) return `at ${pad(hourPart)}:${pad(minutePart)} UTC`;
  if (isSingle(minutePart) && /^\d+(,\d+)+$/.test(hourPart)) {
    return `at ${listWords(hourPart.split(',').map((hour) => `${pad(hour)}:${pad(minutePart)}`))} UTC`;
  }
  const minuteStep = /^\*\/(\d+)$/.exec(minutePart);
  if (minuteStep && isEvery(hourPart)) return `every ${minuteStep[1]} minutes`;
  if (isEvery(minutePart) && isEvery(hourPart)) return 'every minute';
  if (isSingle(minutePart) && isEvery(hourPart)) {
    return Number(minutePart) === 0 ? 'every hour, on the hour' : `every hour at ${pad(minutePart)} minutes past`;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hourPart);
  if (isSingle(minutePart) && hourStep) return `every ${hourStep[1]} hours at ${pad(minutePart)} minutes past`;
  return `at minute ${minutePart} of hour ${hourPart} (UTC)`;
}

// A sentence a person can check at a glance ("Every day at 09:00 UTC"), or
// null when the expression does not parse.
export function describeCron(expression) {
  let cron;
  try {
    cron = parseCron(expression);
  } catch {
    return null;
  }
  const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = cron.parts;
  const time = timeWords(minutePart, hourPart);
  const qualifiers = [];
  if (!isEvery(dayPart)) qualifiers.push(isSingle(dayPart) ? `on day ${dayPart} of the month` : `on days ${dayPart} of the month`);
  if (!isEvery(weekdayPart)) qualifiers.push(`${cron.dayRestricted ? 'or ' : ''}on ${dayOfWeekWords(weekdayPart)}`);
  if (!isEvery(monthPart)) {
    qualifiers.push(isSingle(monthPart) ? `in ${MONTH_NAMES[Number(monthPart)]}` : `in months ${monthPart}`);
  }
  const daily = qualifiers.length === 0 && (isSingle(hourPart) || /^\d+(,\d+)+$/.test(hourPart)) && isSingle(minutePart);
  const sentence = daily ? `every day ${time}` : [time, ...qualifiers].join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
