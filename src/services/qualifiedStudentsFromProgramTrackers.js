'use strict';

const { programTrackersByCompletion } = require('../lib/strapiQuery');

const BASE_URL = (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');
const PAGE_SIZE = 100;
const MIN_COMPLETION_PERCENT = 0;

/**
 * Extract documentId from a program-tracker record.
 * Handles: (1) documentId on record/attributes (flat schema), (2) user relation (nested).
 */
function getDocumentIdFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const attrs = record.attributes ?? record;
  let docId = record.documentId ?? attrs.documentId;
  if (!docId) {
    const user = record.user ?? attrs.user;
    if (user) {
      const data = user.data ?? user;
      const uAttrs = data?.attributes ?? data ?? user.attributes ?? user;
      docId = uAttrs?.documentId ?? user.documentId ?? user.data?.attributes?.documentId ?? user.attributes?.documentId;
    }
  }
  return typeof docId === 'string' && docId.trim() ? docId.trim() : null;
}

/**
 * Get complete_percentage from a program-tracker record.
 * Handles Strapi v4/v5: record.attributes.complete_percentage
 */
function getCompletePercentageFromRecord(record) {
  if (!record || typeof record !== 'object') return 0;
  const attrs = record.attributes ?? record;
  const pct = attrs.complete_percentage ?? record.complete_percentage;
  const n = Number(pct);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch program-trackers where complete_percentage >= MIN_COMPLETION_PERCENT.
 * Paginates through all pages, deduplicates by user.documentId.
 * Returns unique document IDs of students who have at least one enrolled program with completion >= 0%.
 * Uses Strapi REST API format (qs) for filters, populate, pagination.
 *
 * @param {number} [limit] - Optional max document IDs to return (for match pool limiting)
 * @returns {Promise<{ documentIds: string[], stats?: Array<{ documentId: string, maxCompletion: number }> }>}
 */
async function getQualifiedDocumentIdsFromProgramTrackers(limit) {
  const studentsMap = new Map(); // documentId -> maxCompletion
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const query = programTrackersByCompletion(MIN_COMPLETION_PERCENT, { page, pageSize: PAGE_SIZE });
    const url = `${BASE_URL}/api/program-trackers?${query}`;

    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      console.warn('[qualifiedStudentsFromProgramTrackers] fetch failed', err?.message);
      break;
    }

    const json = await res.json().catch(() => ({}));
    const data = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
    const meta = json.meta?.pagination || {};
    if (!res.ok && data.length === 0) {
      console.warn('[qualifiedStudentsFromProgramTrackers] API error', res.status, json?.error?.message || json?.message || '');
    }
    const pageCount = meta.pageCount ?? 1;

    for (const record of data) {
      const documentId = getDocumentIdFromRecord(record);
      const pct = getCompletePercentageFromRecord(record);
      if (documentId) {
        const existing = studentsMap.get(documentId) ?? 0;
        if (pct > existing) studentsMap.set(documentId, pct);
      }
    }

    hasMore = page < pageCount;
    page += 1;
  }

  let documentIds = Array.from(studentsMap.keys());
  if (typeof limit === 'number' && limit > 0) {
    documentIds = documentIds.slice(0, limit);
  }

  const stats = documentIds.map((docId) => ({
    documentId: docId,
    maxCompletion: studentsMap.get(docId) ?? 0,
  }));

  return { documentIds, stats };
}

module.exports = {
  getQualifiedDocumentIdsFromProgramTrackers,
  MIN_COMPLETION_PERCENT,
  BASE_URL,
};
