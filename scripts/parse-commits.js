const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  TZ,
  getTzParts,
  datePartsToString,
  addDays,
  parseDateString
} = require('./lib/date');
const { loadTags, normalizeTags } = require('./lib/tags');
const { normalizeTagsLLM } = require('./normalize-tags');

const DATA_DIR = path.join(process.cwd(), 'data');
const ERRORS_PATH = path.join(DATA_DIR, '_errors.json');

function parseDuration(token) {
  const match = /^(\d+(?:\.\d+)?)(h|hr|hour|hours|m|min|mins|minute|minutes)$/i.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value)) return null;
  const isHours = unit === 'h' || unit === 'hr' || unit === 'hour' || unit === 'hours';
  return isHours ? value : value / 60;
}

function resolveDateToken(token, commitDate, timeZone) {
  if (!token) return null;
  if (token === 'today') {
    return datePartsToString(getTzParts(commitDate, timeZone));
  }
  if (token === 'yesterday') {
    const parts = getTzParts(commitDate, timeZone);
    return datePartsToString(addDays(parts, -1));
  }
  const parsed = parseDateString(token);
  return parsed ? datePartsToString(parsed) : null;
}

function getRepoName() {
  try {
    const remote = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    return remote || 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

function loadJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function recordError(errors, details) {
  errors.push(details);
  console.log(`Parse error: ${details.reason} (${details.commit}) ${details.line}`);
}

function parseCommitLog() {
  const format = '%H%x1f%aI%x1f%B%x1e';
  const output = execSync(`git log --pretty=format:${format}`, { encoding: 'utf8' });
  return output
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, dateStr, body] = chunk.split('\x1f');
      return { sha, dateStr, body: body || '' };
    });
}

function parseTimeLine(line) {
  const trimmed = line.trim();
  if (!/^time:\s*/i.test(trimmed)) return null;
  const body = trimmed.replace(/^time:\s*/i, '');
  const tokens = body.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { error: 'missing date or duration' };

  const [dateTokenRaw, durationToken] = tokens;
  const dateToken = dateTokenRaw.toLowerCase();
  const rest = tokens.slice(2);
  const rawTags = [];
  const noteParts = [];
  for (const token of rest) {
    if (token.startsWith('#')) {
      rawTags.push(token.slice(1));
    } else {
      noteParts.push(token);
    }
  }

  return {
    dateToken,
    durationToken,
    rawTags,
    note: noteParts.join(' ')
  };
}

async function main() {
  const tagIndex = loadTags();
  const timeZone = tagIndex.timezone || TZ;
  const repo = getRepoName();
  const llmEnabled = String(process.env.LLM_ENABLED || '').toLowerCase() === 'true';
  let addedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const errors = loadJsonIfExists(ERRORS_PATH, []);
  const commits = parseCommitLog();

  for (const commit of commits) {
    const commitDate = new Date(commit.dateStr);
    const lines = commit.body.split(/\r?\n/);
    let timeLineIndex = 0;

    for (const line of lines) {
      const parsed = parseTimeLine(line);
      if (!parsed) continue;

      const id = `sha:${commit.sha}:${timeLineIndex}`;
      timeLineIndex += 1;

      const dateString = resolveDateToken(parsed.dateToken, commitDate, timeZone);
      const hours = parseDuration(parsed.durationToken);
      if (!dateString || hours === null) {
        recordError(errors, {
          id,
          commit: commit.sha,
          line,
          reason: 'invalid date or duration'
        });
        errorCount += 1;
        continue;
      }

      const normalizedTags = normalizeTags(parsed.rawTags, tagIndex);
      let primary = normalizedTags[0] || 'uncategorized';
      let secondary = normalizedTags.slice(1);
      let confidence = normalizedTags.length > 0 ? 1.0 : 0.0;
      let method = normalizedTags.length > 0 ? 'alias' : 'fallback';

      if (normalizedTags.length === 0 && llmEnabled) {
        try {
          const llmResult = await normalizeTagsLLM({
            canonical: tagIndex.canonical,
            rawTags: parsed.rawTags,
            note: parsed.note
          });
          if (llmResult) {
            primary = llmResult.primary;
            secondary = llmResult.secondary || [];
            confidence = llmResult.confidence || 0;
            method = 'llm';
          }
        } catch (error) {
          console.warn('LLM normalization failed:', error.message);
          recordError(errors, {
            id,
            commit: commit.sha,
            line,
            reason: `llm_error:${error.message}`
          });
        }
      }

      const dailyPath = path.join(DATA_DIR, `${dateString}.json`);
      const daily = loadJsonIfExists(dailyPath, {
        date: dateString,
        timezone: timeZone,
        entries: []
      });

      if (daily.entries.some((entry) => entry.id === id)) {
        skippedCount += 1;
        continue;
      }

      daily.entries.push({
        id,
        at: commit.dateStr,
        hours,
        raw: {
          date_token: parsed.dateToken,
          duration_token: parsed.durationToken,
          tags: parsed.rawTags,
          note: parsed.note
        },
        normalized: {
          primary,
          secondary,
          confidence,
          method
        },
        source: {
          repo,
          commit: commit.sha
        }
      });

      writeJson(dailyPath, daily);
      addedCount += 1;
      console.log(
        `Added ${id} ${dateString} ${hours}h primary=${primary} tags=${parsed.rawTags.join(',')}`
      );
    }
  }

  writeJson(ERRORS_PATH, errors);
  console.log(`Parse complete: added=${addedCount} skipped=${skippedCount} errors=${errorCount}`);
}

main();
