const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const YAML = require("yaml");

const CACHE_PATH = path.join(process.cwd(), ".cache", "normalize.json");
const SUGGESTIONS_PATH = path.join(process.cwd(), "tags.suggestions.yaml");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (error) {
    console.warn("Failed to read normalize cache:", error.message);
    return {};
  }
}

function saveCache(cache) {
  ensureDir(path.dirname(CACHE_PATH));
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function loadSuggestions() {
  if (!fs.existsSync(SUGGESTIONS_PATH)) {
    return { version: 1, suggestions: {} };
  }
  try {
    return YAML.parse(fs.readFileSync(SUGGESTIONS_PATH, "utf8")) ||
      { version: 1, suggestions: {} };
  } catch (error) {
    console.warn("Failed to read tag suggestions:", error.message);
    return { version: 1, suggestions: {} };
  }
}

function saveSuggestions(data) {
  fs.writeFileSync(SUGGESTIONS_PATH, YAML.stringify(data), "utf8");
}

function appendSuggestions(existing, newSuggestions) {
  if (!newSuggestions || typeof newSuggestions !== "object") return;
  const suggestions = existing.suggestions || {};
  for (const [key, values] of Object.entries(newSuggestions)) {
    if (!Array.isArray(values)) continue;
    const set = new Set(suggestions[key] || []);
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        set.add(value.trim());
      }
    }
    suggestions[key] = Array.from(set);
  }
  existing.suggestions = suggestions;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`Gemini HTTP ${res.statusCode}: ${raw}`));
          }
          resolve(raw);
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function buildPrompt({ canonical, rawTags, note }) {
  return [
    "Return strict JSON only.",
    'Schema: {"primary":"<canonical>","secondary":["<canonical>"],"confidence":0-1,"new_alias_suggestions":{}}.',
    `Canonical tags: ${JSON.stringify(canonical)}.`,
    `Raw tags: ${JSON.stringify(rawTags)}.`,
    `Note: ${JSON.stringify(note || "")}.`,
  ].join(" ");
}

function parseGeminiResponse(raw) {
  const parsed = JSON.parse(raw);
  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini response missing text");
  }
  return JSON.parse(text);
}

function sanitizeResult(result, canonical) {
  if (!result || typeof result !== "object") return null;
  const { primary, secondary, confidence, new_alias_suggestions } = result;
  if (!canonical.includes(primary)) return null;
  const cleanSecondary = Array.isArray(secondary)
    ? secondary.filter((tag) => canonical.includes(tag) && tag !== primary)
    : [];
  const cleanConfidence =
    typeof confidence === "number" && confidence >= 0 && confidence <= 1
      ? confidence
      : 0;
  return {
    primary,
    secondary: cleanSecondary,
    confidence: cleanConfidence,
    new_alias_suggestions,
  };
}

async function normalizeWithGemini({ canonical, rawTags, note, model }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: buildPrompt({ canonical, rawTags, note }) }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const raw = await postJson(url, payload);
  return parseGeminiResponse(raw);
}

async function normalizeTagsLLM({ canonical, rawTags, note }) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const cacheKey = JSON.stringify({ rawTags, note });
  const cache = loadCache();
  if (cache[cacheKey]) {
    return cache[cacheKey];
  }

  const rawResult = await normalizeWithGemini({
    canonical,
    rawTags,
    note,
    model,
  });
  const sanitized = sanitizeResult(rawResult, canonical);
  if (!sanitized) {
    return null;
  }

  cache[cacheKey] = sanitized;
  saveCache(cache);

  const suggestions = loadSuggestions();
  appendSuggestions(suggestions, sanitized.new_alias_suggestions);
  saveSuggestions(suggestions);

  return sanitized;
}

module.exports = {
  normalizeTagsLLM,
};
