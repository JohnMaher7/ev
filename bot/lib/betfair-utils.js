function roundToBetfairTick(price) {
  const bands = [
    { max: 2.0, step: 0.01 },
    { max: 3.0, step: 0.02 },
    { max: 4.0, step: 0.05 },
    { max: 6.0, step: 0.1 },
    { max: 10.0, step: 0.2 },
    { max: 20.0, step: 0.5 },
    { max: 30.0, step: 1.0 },
    { max: 50.0, step: 2.0 },
    { max: 100.0, step: 5.0 },
    { max: 1000.0, step: 10.0 },
  ];

  const clamped = Math.max(1.01, Math.min(price, 1000));
  const band = bands.find((b) => clamped <= b.max) || bands[bands.length - 1];
  const ticks = Math.round((clamped - 1.0) / band.step);
  const rounded = 1.0 + ticks * band.step;
  return Number(rounded.toFixed(2));
}

function levenshteinDistance(a = '', b = '') {
  const rows = b.length + 1;
  const cols = a.length + 1;
  const track = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < cols; i += 1) track[0][i] = i;
  for (let j = 0; j < rows; j += 1) track[j][0] = j;

  for (let j = 1; j < rows; j += 1) {
    for (let i = 1; i < cols; i += 1) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1,
        track[j - 1][i] + 1,
        track[j - 1][i - 1] + indicator,
      );
    }
  }
  return track[rows - 1][cols - 1];
}

function normalizeName(raw = '') {
  return raw
    .toLowerCase()
    .replace(/\b(fc|ifk|sc|fk|afc|ac|u19|u20|u21|u23|women)\b/g, '')
    .replace(/ v /g, ' vs ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function findBestMatch(sourceName, potentialMatches = [], { logger = console, similarityThreshold = 0.8 } = {}) {
  if (!sourceName || !potentialMatches.length) return null;

  const sourceNorm = normalizeName(sourceName);
  let bestMatch = null;
  let lowestDistance = Infinity;

  for (const matchName of potentialMatches) {
    if (!matchName) continue;
    const matchNorm = normalizeName(matchName);
    const distance = levenshteinDistance(sourceNorm, matchNorm);
    if (distance < lowestDistance) {
      lowestDistance = distance;
      bestMatch = matchName;
    }
  }

  if (!bestMatch) return null;

  const longest = Math.max(sourceNorm.length, normalizeName(bestMatch).length);
  const similarity = longest > 0 ? (longest - lowestDistance) / longest : 0;

  if (similarity >= similarityThreshold) {
    logger?.log?.(`[bot] Fuzzy match success: "${sourceName}" -> "${bestMatch}" (Score: ${similarity.toFixed(2)})`);
    return bestMatch;
  }

  logger?.warn?.(`[bot] Fuzzy match failed for: "${sourceName}". Best attempt: "${bestMatch}" (Score: ${similarity.toFixed(2)})`);
  return null;
}

module.exports = {
  roundToBetfairTick,
  levenshteinDistance,
  findBestMatch,
};


