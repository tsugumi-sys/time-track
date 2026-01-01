const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

function normalizeToken(token) {
  return token
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function loadTags(tagsPath = path.join(process.cwd(), "tags.yaml")) {
  const raw = fs.readFileSync(tagsPath, "utf8");
  const parsed = YAML.parse(raw);
  const tags = parsed?.tags ? parsed.tags : {};
  const canonical = Object.keys(tags);
  const aliasMap = new Map();

  for (const key of canonical) {
    const normalizedKey = normalizeToken(key);
    if (normalizedKey) {
      aliasMap.set(normalizedKey, key);
    }
    const aliases = Array.isArray(tags[key].aliases) ? tags[key].aliases : [];
    for (const alias of aliases) {
      const normalized = normalizeToken(String(alias));
      if (normalized && !aliasMap.has(normalized)) {
        aliasMap.set(normalized, key);
      }
    }
  }

  return {
    timezone: parsed?.timezone ? parsed.timezone : "Asia/Tokyo",
    canonical,
    aliasMap,
    display: tags,
  };
}

function normalizeTags(rawTags, tagIndex) {
  const normalized = [];
  for (const raw of rawTags) {
    const normalizedKey = normalizeToken(raw);
    if (!normalizedKey) continue;
    const match = tagIndex.aliasMap.get(normalizedKey);
    if (match && !normalized.includes(match)) {
      normalized.push(match);
    }
  }
  return normalized;
}

module.exports = {
  loadTags,
  normalizeTags,
  normalizeToken,
};
