'use strict';

/**
 * Fetch learners directly from /api/learners with populate.
 * No program-trackers - simple direct fetch, random selection.
 * Used by: See AI matches, Our Students, Talent Push.
 */

const BASE_URL = (process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io').replace(/\/$/, '');
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function shuffle(arr) {
  if (!Array.isArray(arr) || arr.length <= 1) return arr;
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeLearner(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const attrs = raw.attributes || raw;
  const pickRelation = (r) => {
    if (!r) return r;
    if (r?.data?.attributes) {
      const a = r.data.attributes;
      return { name: a.name, title: a.title, id: r.data.id };
    }
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
 * Fetch all learners from API with populate=*, paginated.
 * @param {number} [maxTotal] - Max total learners to fetch (default 500)
 * @returns {Promise<Array>} Normalized learner objects
 */
async function fetchAllLearners(maxTotal = 500) {
  const results = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && results.length < maxTotal) {
    const url = `${BASE_URL}/api/learners?populate=*&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const json = await res.json().catch(() => ({}));
      const data = Array.isArray(json.data) ? json.data : [];
      const meta = json.meta?.pagination || {};
      const pageCount = meta.pageCount ?? 1;

      for (const item of data) {
        results.push(normalizeLearner(item));
        if (results.length >= maxTotal) break;
      }

      hasMore = page < pageCount && results.length < maxTotal;
      page += 1;
    } catch (err) {
      console.warn('[fetchLearnersDirect] fetch failed', err?.message);
      break;
    }
  }

  return results;
}

/**
 * Get learners for AI match: fetch all, shuffle, take vacancies*10 (random sample sent to AI).
 * Display top n*5; this returns up to n*10 for AI to score.
 * @param {number} vacancies - Number of vacancies (default 1)
 * @returns {Promise<Array>} Up to vacancies*10 learners (for AI); caller displays top vacancies*5
 */
async function getLearnersForMatch(vacancies = 1) {
  const all = await fetchAllLearners(500);
  const shuffled = shuffle(all);
  const take = Math.max(10, Math.min(500, vacancies * 10));
  return shuffled.slice(0, take);
}

/**
 * Get learners for Our Students: fetch all, shuffle, return.
 * @param {number} [limit] - Max to return (default 500)
 * @returns {Promise<Array>}
 */
async function getLearnersForOurStudents(limit = 500) {
  const all = await fetchAllLearners(limit);
  return shuffle(all);
}

/**
 * Get learners for Talent Push: fetch all, shuffle, take sample.
 * @param {number} sampleSize - How many to take (default 20)
 * @returns {Promise<Array>}
 */
async function getLearnersForTalentPush(sampleSize = 20) {
  const all = await fetchAllLearners(500);
  const shuffled = shuffle(all);
  return shuffled.slice(0, sampleSize);
}

module.exports = {
  fetchAllLearners,
  getLearnersForMatch,
  getLearnersForOurStudents,
  getLearnersForTalentPush,
  shuffle,
  normalizeLearner,
};
