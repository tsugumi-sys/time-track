# Git Commit–Driven Time Tracking with LLM Tag Normalization — Design Doc

## 1. Goal

Build a lightweight time-tracking system that:

* Records time logs via **Git commit messages**.
* Uses **GitHub Actions** to parse new logs and append them into a durable store.
* Generates **weekly / monthly / yearly** summaries with **tables + charts**.
* Publishes a report site via **GitHub Pages**.
* Uses an LLM (Gemini) to handle **tag normalization** (aliasing / spelling variations), while tags are maintained as a **predefined master list**.

Non-goals (initially):

* User authentication, multi-user attribution, billing
* Real-time UI edits (everything flows through git commits)
* Predictive analytics

---

## 2. High-level Architecture

**Source of truth**

* Daily JSON files: `data/YYYY-MM-DD.json`

**Generated artifacts**

* `public/assets/report.json` (aggregated, chart-ready data)
* `public/index.html` (report UI)
* `README.md` (high-level summaries + link to site)

**CI pipeline**

1. Push to `main`
2. Action reads new commits since last run
3. Extracts `time:` lines (time logs)
4. Resolves date (`today`, `yesterday`, or explicit date)
5. Normalizes tags:

   * rule-based alias matching first
   * LLM normalization only if needed
6. Writes/updates `data/YYYY-MM-DD.json`
7. Builds aggregates and report artifacts
8. Deploys to GitHub Pages

Recommended: keep `data/` and `README.md` on `main`, deploy `public/` to `gh-pages`.

---

## 3. User Workflow

### Writing logs

You log time by adding one or more `time:` lines in a commit message:

Examples:

```
time: today 2h #work #backend implement webhook retries
time: yesterday 1.5h #study read papers about retrieval
time: 2026-01-01 45m #youtube edit short clip
```

Only lines starting with `time:` are parsed; the rest of the commit message is ignored.

### Viewing reports

* README shows quick summaries (This week / month / year).
* GitHub Pages hosts the full dashboard (tables + charts).

---

## 4. Tag System

### 4.1 Master tags (predefined)

You requested these to always exist:

* Work (本業)
* SideProject (副業)
* Girlfriend (彼女)
* Friends (友達)
* YouTube
* Study (勉強)

Implementation: store canonical tags in English, keep Japanese labels for display.

Recommended canonical keys:

* `work`
* `side_project`
* `girlfriend`
* `friends`
* `youtube`
* `study`

### 4.2 Additional “nice to have” tags (suggested)

These are optional but useful for breakdown:

* `health`
* `family`
* `household`
* `admin`
* `travel`
* `hobby`
* `reading`
* `writing`

You can start with only the required six, and add more later without changing the data model.

---

## 5. Tag Master File Format

Store in `tags.yaml`:

```yaml
version: 1
timezone: Asia/Tokyo

tags:
  work:
    display:
      en: Work
      ja: 本業
    aliases:
      - honngyou
      - mainjob
      - 本業
      - 仕事
  side_project:
    display:
      en: Side Project
      ja: 副業
    aliases:
      - sidejob
      - 副業
      - 個人開発
  girlfriend:
    display:
      en: Girlfriend
      ja: 彼女
    aliases:
      - gf
      - 彼女
  friends:
    display:
      en: Friends
      ja: 友達
    aliases:
      - friend
      - 友達
  youtube:
    display:
      en: YouTube
      ja: YouTube
    aliases:
      - yt
      - YouTube
  study:
    display:
      en: Study
      ja: 勉強
    aliases:
      - learning
      - 勉強
      - study
```

Notes:

* Canonical keys are stable (used for aggregation).
* Aliases include Japanese input and common shorthand.
* Aliases matching is case-insensitive and punctuation-normalized.

---

## 6. Commit Log Parsing Spec

### 6.1 Grammar (one line)

```
time: <date> <duration> <tags...> <note...>
```

* `<date>`:

  * `today` | `yesterday` | `YYYY-MM-DD`
* `<duration>`:

  * `Nh` (e.g., `2h`, `1.5h`)
  * `Nm` (e.g., `45m`, `90m`) → converted to hours
* `<tags...>`:

  * tokens starting with `#` (e.g., `#work #backend`)
  * at least one tag recommended, but not required
* `<note...>`:

  * the rest of the line

### 6.2 Date resolution

* Set Action env `TZ=Asia/Tokyo`.
* For each commit, use its commit timestamp and interpret `today/yesterday` in JST.

### 6.3 Record identity (dedupe)

A record is uniquely identified by:

* commit SHA + line number (`sha:<sha>:<index>`)

This prevents double-import if Actions rerun.

---

## 7. Data Model

### 7.1 Daily file: `data/YYYY-MM-DD.json`

```json
{
  "date": "2026-01-01",
  "timezone": "Asia/Tokyo",
  "entries": [
    {
      "id": "sha:abcd1234:0",
      "at": "2026-01-01T10:12:33+09:00",
      "hours": 2.0,

      "raw": {
        "date_token": "today",
        "duration_token": "2h",
        "tags": ["work", "backend"],
        "note": "implement webhook retries"
      },

      "normalized": {
        "primary": "work",
        "secondary": ["study"],
        "confidence": 0.86,
        "method": "alias|llm|fallback"
      },

      "source": {
        "repo": "owner/name",
        "commit": "abcd1234"
      }
    }
  ]
}
```

### 7.2 Aggregated report JSON: `public/assets/report.json`

Contains:

* totals for week/month/year
* breakdown by primary tag
* timeseries (daily totals) for charts

Example top-level shape:

```json
{
  "generated_at": "2026-01-01T10:30:00+09:00",
  "timezone": "Asia/Tokyo",
  "periods": {
    "week": { "start": "2025-12-29", "end": "2026-01-04" },
    "month": { "start": "2026-01-01", "end": "2026-01-31" },
    "year": { "start": "2026-01-01", "end": "2026-12-31" }
  },
  "totals": {
    "week": 12.5,
    "month": 12.5,
    "year": 12.5
  },
  "by_primary": {
    "week": { "work": 6.0, "study": 4.5, "youtube": 2.0 },
    "month": { "work": 6.0, "study": 4.5, "youtube": 2.0 },
    "year": { "work": 6.0, "study": 4.5, "youtube": 2.0 }
  },
  "daily_series": [
    { "date": "2026-01-01", "total": 3.5, "work": 2.0, "study": 1.5 }
  ]
}
```

---

## 8. Tag Normalization Strategy (Alias + LLM)

### 8.1 Two-stage normalization

**Stage A — deterministic**

* If a raw tag matches a canonical key, accept.
* Else if it matches any alias, map to canonical.
* If at least one canonical tag results, choose primary by:

  1. first tag in the line (after normalization), else
  2. most frequent tag in last N days (optional)

**Stage B — LLM only when needed**
Trigger LLM when:

* no tags provided, or
* tags provided but none match master list after alias resolution, or
* multiple plausible matches (optional rule)

### 8.2 LLM constraints (important)

To avoid tag explosion:

* LLM must select from **existing canonical tag keys** only.
* LLM output must be strict JSON.
* If LLM returns an unknown tag key → reject and use fallback `uncategorized` or `work`? (recommended: `uncategorized`).

### 8.2.1 Gemini integration details

Use Gemini via the Google Generative Language API.

Required env:

* `GEMINI_API_KEY`
* Optional: `GEMINI_MODEL` (default `gemini-2.5-flash`)

Endpoint (REST):

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=$GEMINI_API_KEY
```

Recommended request fields:

* `temperature: 0`
* `response_mime_type: "application/json"`
* `generationConfig.maxOutputTokens: 256`

Example payload (conceptual):

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Return strict JSON only. Schema: {\"primary\":\"<canonical>\",\"secondary\":[\"<canonical>\"],\"confidence\":0-1,\"new_alias_suggestions\":{}}. Canonical tags: [\"work\", \"side_project\", \"girlfriend\", \"friends\", \"youtube\", \"study\", \"uncategorized\"]. Raw tags: [\"yt\"]. Note: \"edit short clip\"."
        }
      ]
    }
  ]
}
```

Parsing rules:

* Reject non-JSON output.
* Reject any tag not in the canonical list.
* If rejected, fall back to deterministic alias rules or `uncategorized`.

### 8.3 LLM prompt contract (conceptual)

Input includes:

* master canonical tag list
* raw tags + note text
* optional “recently used tags” for bias

Output schema:

```json
{
  "primary": "<one of canonical keys>",
  "secondary": ["<canonical keys>"],
  "confidence": 0.0-1.0,
  "new_alias_suggestions": {
    "<canonical key>": ["rawTag1", "rawTag2"]
  }
}
```

### 8.4 Alias suggestion workflow

Do not auto-mutate `tags.yaml` in CI.
Instead:

* append to `tags.suggestions.yaml` (or open an Issue/PR)
* you periodically review and merge

---

## 9. Report Generation

### 9.1 Period definitions

* Week: ISO week in JST (Mon–Sun) or “last 7 days”

  * Recommend: ISO week for consistency
* Month: calendar month in JST
* Year: calendar year in JST

### 9.2 Output surfaces

* `README.md`: summary tables (top tags, totals)
* `public/index.html`: interactive dashboard

  * Period selector (Week/Month/Year)
  * Breakdown table (tag → hours)
  * Charts:

    * bar: hours by tag
    * line: daily totals
    * optional stacked bar: tags across days

---

## 10. GitHub Actions Design

### 10.1 Triggers

* on `push` to `main`
* optionally on `workflow_dispatch`

### 10.2 Steps

1. Checkout
2. Setup Node
3. `node scripts/parse-commits.ts`
4. `node scripts/build-report.ts`
5. Commit updated `data/` + `README.md` back to `main` (optional)
6. Deploy `public/` to GitHub Pages (`gh-pages`)

### 10.3 Secrets / config

* `GEMINI_API_KEY` as GitHub secret
* Optional `GEMINI_MODEL` (default `gemini-2.5-flash`)
* `TZ=Asia/Tokyo`
* Optional: `LLM_ENABLED=true/false`

---

## 11. Error Handling & Safety

* If parsing fails for a line, store it in `data/_errors.json` with commit sha + line content.
* If LLM call fails:

  * fallback to deterministic result if possible
  * else assign `uncategorized`
* Ensure idempotency:

  * never import the same `(sha, lineIndex)` twice

---

## 12. Privacy / Security Notes

* Everything is committed into a GitHub repo.
* Do not log sensitive personal notes in commit messages if the repo is public.
* If using Gemini API in Actions, content is sent to an external service; keep prompts minimal and avoid secrets.

---

## 13. Implementation Plan (MVP)

### Phase 1 — No LLM, alias-only

* Implement parser → daily JSON
* Implement aggregator → report.json
* Implement README update
* Implement GitHub Pages deploy

### Phase 2 — Add LLM normalization

* Add LLM step only for unresolved tags
* Add cache (`.cache/normalize.json`) keyed by `(rawTags + note)`
* Add suggestions file

### Phase 3 — UI polish

* Filters, search, drill-down to daily entries
* Export CSV

---

## 15. Execution Steps (Checklist)

1. Initialize repo structure
   * Add `tags.yaml` (required tags + aliases)
   * Create `data/`, `public/`, `public/assets/`, `scripts/`
2. Implement parser (`scripts/parse-commits.ts`)
   * Read commits since last run
   * Parse `time:` lines and normalize duration/date
   * Apply alias-only tag normalization
   * Write `data/YYYY-MM-DD.json` with idempotent IDs
   * Log parse errors to `data/_errors.json`
3. Implement aggregator (`scripts/build-report.ts`)
   * Load all daily JSON files
   * Build `public/assets/report.json`
   * Update `README.md` summary table
4. Add Gemini normalization (`scripts/normalize-tags.ts`)
   * Call `gemini-2.5-flash` via REST API
   * Enforce strict JSON output and canonical tags only
   * Add cache for `(rawTags + note)` and append suggestions
5. Wire GitHub Actions
   * Run parser + aggregator on push to `main`
   * Enable `LLM_ENABLED` and `GEMINI_API_KEY`
   * Commit `data/` and `README.md` updates back to `main`
   * Deploy `public/` to `gh-pages`
6. Build minimal UI (`public/index.html`)
   * Period selector + totals + charts
   * Load `public/assets/report.json`
7. Validate end-to-end
   * Create sample commits with `time:` lines
   * Confirm daily files, report JSON, and Pages render
8. Iterate
   * Add new tags/aliases via `tags.suggestions.yaml`
   * Improve charts, filters, and export

---

## 14. Open Decisions (defaults recommended)

* Primary tag selection: **first normalized tag in the line**
* Week definition: **ISO week (Mon–Sun) in JST**
* Unknown tags: map to **`uncategorized`** (optional extra canonical tag)
* “Multiple tags” handling: aggregate by **primary only** initially

---

If you want, next I can produce a concrete repo template:

* `tags.yaml` with your required tags + sensible extras
* `scripts/parse-commits.ts` + `scripts/build-report.ts`
* `public/index.html` (Chart.js)
* `.github/workflows/time-log.yml` (TZ fixed, gh-pages deploy, Gemini optional)

…and keep it designed so you can start with alias-only and later flip on Gemini with one secret + flag.
