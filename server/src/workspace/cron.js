// Five-field cron schedules for recurring tasks, evaluated in UTC
// (minute hour day-of-month month day-of-week). Supports `*`, values, ranges,
// lists and steps (`*/15`, `1-5`, `0,30`, `10-50/10`). Day-of-week accepts 0-7
// with both 0 and 7 meaning Sunday. As in classic cron, when both day fields
// are restricted a day matches if either one does; a field that starts with
// `*` (including `*/2`) counts as unrestricted, so then both must match.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

// Far enough to find any valid schedule (Feb 29 recurs within 8 years), short
// enough that an impossible one ("31 2 *") fails quickly instead of spinning.
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
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayRestricted: !parts[2].startsWith('*'),
    weekdayRestricted: !parts[4].startsWith('*'),
  };
}

// A schedule that parses but can never fire ("0 0 31 2 *") is refused too,
// so a saved task always has a next run.
export function validateCron(expression) {
  try {
    if (nextRunAt(expression, new Date(Date.UTC(2000, 0, 1))) === null) return 'this schedule never matches a date';
    return null;
  } catch (err) {
    return err.message;
  }
}

function dayMatches(cron, date) {
  const byDay = cron.days.has(date.getUTCDate());
  const byWeekday = cron.weekdays.has(date.getUTCDay());
  if (cron.dayRestricted && cron.weekdayRestricted) return byDay || byWeekday;
  // A plain `*` holds every value, so this is "the other field decides" for
  // `*` and "both apply" for a stepped `*/n`.
  return byDay && byWeekday;
}

// The first minute strictly after `after` that matches, or null if none does.
export function nextRunAt(expression, after = new Date()) {
  const cron = parseCron(expression);
  const time = new Date(after.getTime());
  time.setUTCSeconds(0, 0);
  time.setUTCMinutes(time.getUTCMinutes() + 1);

  for (let checked = 0; checked < SEARCH_LIMIT_MINUTES; ) {
    if (!cron.months.has(time.getUTCMonth() + 1) || !dayMatches(cron, time)) {
      const minutesLeftInDay = 24 * 60 - (time.getUTCHours() * 60 + time.getUTCMinutes());
      time.setUTCHours(24, 0, 0, 0);
      checked += minutesLeftInDay;
      continue;
    }
    if (!cron.hours.has(time.getUTCHours())) {
      const minutesLeftInHour = 60 - time.getUTCMinutes();
      time.setUTCMinutes(60, 0, 0);
      checked += minutesLeftInHour;
      continue;
    }
    if (cron.minutes.has(time.getUTCMinutes())) return time;
    time.setUTCMinutes(time.getUTCMinutes() + 1);
    checked += 1;
  }
  return null;
}
