const TZ = 'Asia/Tokyo';

function getTzParts(date, timeZone = TZ) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day)
  };
}

function datePartsToString(parts) {
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(parts, deltaDays) {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day);
  const next = new Date(base + deltaDays * 24 * 60 * 60 * 1000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
}

function parseDateString(dateStr) {
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(dateStr);
  if (!match) {
    return null;
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

function compareDateParts(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function isBetween(date, start, end) {
  return compareDateParts(date, start) >= 0 && compareDateParts(date, end) <= 0;
}

function getIsoWeekRange(parts) {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day);
  const weekday = new Date(base).getUTCDay();
  const offset = (weekday + 6) % 7;
  const start = addDays(parts, -offset);
  const end = addDays(start, 6);
  return { start, end };
}

function getMonthRange(parts) {
  const start = { year: parts.year, month: parts.month, day: 1 };
  const nextMonth = parts.month === 12
    ? { year: parts.year + 1, month: 1, day: 1 }
    : { year: parts.year, month: parts.month + 1, day: 1 };
  const end = addDays(nextMonth, -1);
  return { start, end };
}

function getYearRange(parts) {
  return {
    start: { year: parts.year, month: 1, day: 1 },
    end: { year: parts.year, month: 12, day: 31 }
  };
}

module.exports = {
  TZ,
  getTzParts,
  datePartsToString,
  addDays,
  parseDateString,
  compareDateParts,
  isBetween,
  getIsoWeekRange,
  getMonthRange,
  getYearRange
};
