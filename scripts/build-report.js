const fs = require("fs");
const path = require("path");
const {
  TZ,
  getTzParts,
  datePartsToString,
  parseDateString,
  isBetween,
  getIsoWeekRange,
  getMonthRange,
  getYearRange,
} = require("./lib/date");
const { loadTags } = require("./lib/tags");

const DATA_DIR = path.join(process.cwd(), "data");
const PUBLIC_DIR = path.join(process.cwd(), "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const REPORT_PATH = path.join(ASSETS_DIR, "report.json");
const README_PATH = path.join(process.cwd(), "README.md");

function loadDailyFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const files = fs.readdirSync(DATA_DIR)
    .filter(
      (file) =>
        file.endsWith(".json") && file !== "_errors.json" && file !== "_state.json"
    )
    .sort();
  return files.map((file) => {
    const fullPath = path.join(DATA_DIR, file);
    const raw = fs.readFileSync(fullPath, "utf8");
    return JSON.parse(raw);
  });
}

function sumEntries(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((total, entry) => total + entry.hours, 0);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function buildDailySeries(dailies) {
  const series = [];
  for (const daily of dailies) {
    const total = sumEntries(daily.entries);
    const row = { date: daily.date, total };
    for (const entry of daily.entries || []) {
      const primary = entry.normalized?.primary
        ? entry.normalized.primary
        : "uncategorized";
      row[primary] = (row[primary] || 0) + entry.hours;
    }
    series.push(row);
  }
  return series;
}

function buildTotalsByPeriod(dailies, periodRange) {
  const totals = {};
  for (const daily of dailies) {
    const parts = parseDateString(daily.date);
    if (!parts || !isBetween(parts, periodRange.start, periodRange.end)) {
      continue;
    }
    for (const entry of daily.entries) {
      const primary = entry.normalized?.primary
        ? entry.normalized.primary
        : "uncategorized";
      totals[primary] = (totals[primary] || 0) + entry.hours;
    }
  }
  return totals;
}

function sumTotals(totals) {
  return Object.values(totals).reduce((sum, value) => sum + value, 0);
}

function buildEntryList(dailies) {
  const entries = [];
  for (const daily of dailies) {
    for (const entry of daily.entries || []) {
      entries.push({
        date: daily.date,
        at: entry.at,
        hours: entry.hours,
        primary: entry.normalized?.primary ? entry.normalized.primary : "uncategorized",
        tags: entry.raw?.tags || [],
        tag_meta: entry.raw?.tag_meta || {},
        note: entry.raw?.note || "",
      });
    }
  }
  return entries.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function buildReadme(report) {
  const defaultHeader = [
    "# Time Tracker",
    "",
    "## Setup",
    "",
    "### Required secrets",
    "",
    "- `GEMINI_API_KEY` (Gemini API key for normalization)",
    "- Optional `GEMINI_MODEL` (default `gemini-2.5-flash`)",
    "- Optional `LLM_ENABLED` (`true`/`false`, default `false`)",
    "",
    "### GitHub Pages",
    "",
    "1. In repo settings, enable GitHub Pages.",
    "2. Set source to `gh-pages` branch.",
    "3. Wait for the workflow to deploy `public/`.",
  ];

  let headerLines = defaultHeader;
  if (fs.existsSync(README_PATH)) {
    const existing = fs.readFileSync(README_PATH, "utf8");
    const marker = "## Latest summary";
    const index = existing.indexOf(marker);
    if (index !== -1) {
      headerLines = existing.slice(0, index).trimEnd().split("\n");
    }
  }

  const lines = [];
  lines.push(...headerLines);
  lines.push("");
  lines.push("## Latest summary");
  lines.push("");
  lines.push(`Generated at: ${report.generated_at}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Period | Total hours |");
  lines.push("| --- | --- |");
  lines.push(`| Week | ${report.totals.week.toFixed(2)} |`);
  lines.push(`| Month | ${report.totals.month.toFixed(2)} |`);
  lines.push(`| Year | ${report.totals.year.toFixed(2)} |`);
  lines.push("");
  lines.push("## Top Tags (Week)");
  lines.push("");
  lines.push("| Tag | Hours |");
  lines.push("| --- | --- |");

  const topWeek = Object.entries(report.by_primary.week)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topWeek.length === 0) {
    lines.push("| (none) | 0 |");
  } else {
    for (const [tag, hours] of topWeek) {
      lines.push(`| ${tag} | ${hours.toFixed(2)} |`);
    }
  }
  lines.push("");

  fs.writeFileSync(README_PATH, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const tagIndex = loadTags();
  const timeZone = tagIndex.timezone || TZ;
  const now = new Date();
  const nowParts = getTzParts(now, timeZone);

  const weekRange = getIsoWeekRange(nowParts);
  const monthRange = getMonthRange(nowParts);
  const yearRange = getYearRange(nowParts);

  const dailies = loadDailyFiles();
  const dailySeries = buildDailySeries(dailies);

  const byWeek = buildTotalsByPeriod(dailies, weekRange);
  const byMonth = buildTotalsByPeriod(dailies, monthRange);
  const byYear = buildTotalsByPeriod(dailies, yearRange);
  const entries = buildEntryList(dailies);

  const report = {
    generated_at: now.toISOString(),
    timezone: timeZone,
    periods: {
      week: {
        start: datePartsToString(weekRange.start),
        end: datePartsToString(weekRange.end),
      },
      month: {
        start: datePartsToString(monthRange.start),
        end: datePartsToString(monthRange.end),
      },
      year: {
        start: datePartsToString(yearRange.start),
        end: datePartsToString(yearRange.end),
      },
    },
    totals: {
      week: sumTotals(byWeek),
      month: sumTotals(byMonth),
      year: sumTotals(byYear),
    },
    by_primary: {
      week: byWeek,
      month: byMonth,
      year: byYear,
    },
    daily_series: dailySeries,
    entries,
  };

  ensureDir(ASSETS_DIR);
  writeJson(REPORT_PATH, report);
  buildReadme(report);
}

main();
