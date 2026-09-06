// Stable v1 fingerprint math shared by the legacy engine and experience retrieval.
export function fnv1a(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map();
export function vector(label, dimensions = 4096) {
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('dimensions must be a positive integer');
  const key = `${dimensions}\0${label}`;
  if (cache.has(key)) return cache.get(key);
  const rng = mulberry32(fnv1a(label)), out = new Int8Array(dimensions);
  for (let i = 0; i < dimensions; i++) out[i] = rng() < 0.5 ? -1 : 1;
  cache.set(key, out);
  return out;
}

export function dot(a, b) {
  if (a.length !== b.length) throw new Error('vectors must have equal dimensions');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export const norm = value => Math.sqrt(dot(value, value));

export function bundle(labels, dimensions = 512) {
  const out = new Float64Array(dimensions);
  for (const label of labels) {
    const v = vector(label, dimensions);
    for (let i = 0; i < dimensions; i++) out[i] += v[i];
  }
  return out;
}

export function cosine(a, b) {
  const denominator = norm(a) * norm(b);
  return denominator ? dot(a, b) / denominator : 0;
}
