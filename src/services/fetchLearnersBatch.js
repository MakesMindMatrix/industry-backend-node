'use strict';

/**
 * Batch + parallel fetch of learners from external API.
 * Architecture: qualification filtering (program-trackers) → batch fetch learners.
 * Uses Strapi REST API format (qs library) for filters, populate, pagination.
 */

const { learnersByDocumentId } = require('../lib/strapiQuery');

const BASE_URL = (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');

/** Chunk size per request (Strapi/HTTP URL length limits). */
const CHUNK_SIZE = 50;

/** Max parallel requests to avoid overwhelming external API. */
const MAX_PARALLEL = 5;

/**
 * Fetch one chunk of learners by documentIds.
 * @param {string[]} documentIds - Up to CHUNK_SIZE ids
 * @param {object} [opts] - Options: populateUser (bool)
 * @returns {Promise<Array>} Raw learner objects from API
 */
async function fetchLearnersChunk(documentIds, opts = {}) {
  if (!Array.isArray(documentIds) || documentIds.length === 0) return [];
  const query = learnersByDocumentId(documentIds, {
    populateUser: opts.populateUser,
    page: 1,
    pageSize: Math.max(documentIds.length, 100),
  });
  const url = `${BASE_URL}/api/learners?${query}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    console.warn('[fetchLearnersBatch] chunk failed', err?.message);
    return [];
  }
}

/**
 * Run chunks in parallel with concurrency limit.
 * @param {Array<{ ids: string[] }>} chunks
 * @param {Function} fetchFn
 * @param {number} maxParallel
 * @returns {Promise<Array>}
 */
async function runChunksInParallel(chunks, fetchFn, maxParallel = MAX_PARALLEL) {
  const results = [];
  for (let i = 0; i < chunks.length; i += maxParallel) {
    const batch = chunks.slice(i, i + maxParallel);
    const batchResults = await Promise.all(batch.map((chunk) => fetchFn(chunk.ids)));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Fetch learners by document IDs using batch + parallel requests.
 * Qualification filtering should be done first (e.g. program-trackers complete > 35).
 *
 * @param {string[]} documentIds - Qualified document IDs
 * @param {object} [opts] - Options: populateUser (bool), chunkSize (number), maxParallel (number)
 * @returns {Promise<Array>} Array of learner objects (raw from API; may include attributes)
 */
async function fetchLearnersByDocumentIdsBatch(documentIds, opts = {}) {
  if (!Array.isArray(documentIds) || documentIds.length === 0) return [];
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const maxParallel = opts.maxParallel ?? MAX_PARALLEL;
  const chunks = [];
  for (let i = 0; i < documentIds.length; i += chunkSize) {
    chunks.push({ ids: documentIds.slice(i, i + chunkSize) });
  }
  const allChunkResults = await runChunksInParallel(
    chunks,
    (ids) => fetchLearnersChunk(ids, { populateUser: opts.populateUser }),
    maxParallel
  );
  const flat = allChunkResults.flat();
  return flat;
}

/**
 * Normalize learner from Strapi response (handles attributes nesting).
 * @param {object} raw
 * @returns {object}
 */
function normalizeLearner(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const attrs = raw.attributes || raw;
  const pickRelation = (r) => {
    if (!r) return r;
    if (r?.data?.attributes) return { name: r.data.attributes.name, id: r.data.id };
    if (typeof r?.name === 'string' || typeof r?.id !== 'undefined') return r;
    return r;
  };
  return {
    id: raw.id ?? attrs.id,
    documentId: raw.documentId ?? attrs.documentId,
    name: raw.name ?? attrs.name,
    user_category: raw.user_category ?? attrs.user_category,
    education_level: raw.education_level ?? attrs.education_level,
    specialisation: raw.specialisation ?? attrs.specialisation,
    master_college: pickRelation(raw.master_college ?? attrs.master_college),
    university: pickRelation(raw.university ?? attrs.university),
    branch: pickRelation(raw.branch ?? attrs.branch),
    career_aspiration: pickRelation(raw.career_aspiration ?? attrs.career_aspiration),
    career_interests: raw.career_interests ?? attrs.career_interests,
    user: raw.user ?? attrs.user,
  };
}

/**
 * Fetch learners and return normalized, keyed by documentId for easy lookup.
 * @param {string[]} documentIds
 * @param {object} [opts]
 * @returns {Promise<Map<string, object>>} documentId -> normalized learner
 */
async function fetchLearnersMapByDocumentIds(documentIds, opts = {}) {
  const raw = await fetchLearnersByDocumentIdsBatch(documentIds, opts);
  const map = new Map();
  for (const item of raw) {
    const normalized = normalizeLearner(item);
    const docId = normalized.documentId ?? (normalized.id != null ? String(normalized.id) : null);
    if (docId && !map.has(docId)) {
      map.set(docId, normalized);
    }
  }
  return map;
}

/**
 * Fetch learners and return array in same order as documentIds (missing = null).
 * @param {string[]} documentIds
 * @param {object} [opts]
 * @returns {Promise<Array<object|null>>}
 */
async function fetchLearnersByDocumentIdsOrdered(documentIds, opts = {}) {
  const map = await fetchLearnersMapByDocumentIds(documentIds, opts);
  return documentIds.map((id) => map.get(id) ?? null);
}

module.exports = {
  fetchLearnersByDocumentIdsBatch,
  fetchLearnersMapByDocumentIds,
  fetchLearnersByDocumentIdsOrdered,
  normalizeLearner,
  CHUNK_SIZE,
  MAX_PARALLEL,
  BASE_URL,
};
