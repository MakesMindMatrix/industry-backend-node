'use strict';

/**
 * Build Strapi REST API query strings using qs library.
 * Ensures filters, populate, pagination match Strapi v4/v5 format.
 * @see https://docs.strapi.io/dev-docs/api/rest/parameters
 * @see https://docs.strapi.io/dev-docs/api/rest/filters
 */

const qs = require('qs');

const QS_OPTS = { encodeValuesOnly: true };

/**
 * Build query string for Strapi API.
 * @param {object} params - { filters?, populate?, fields?, pagination?, sort? }
 * @returns {string}
 */
function buildQuery(params) {
  const clean = {};
  if (params.filters && Object.keys(params.filters).length > 0) {
    clean.filters = params.filters;
  }
  if (params.populate !== undefined) {
    clean.populate = params.populate;
  }
  if (params.fields && (Array.isArray(params.fields) ? params.fields.length : Object.keys(params.fields).length) > 0) {
    clean.fields = params.fields;
  }
  if (params.pagination && (params.pagination.page || params.pagination.pageSize)) {
    clean.pagination = params.pagination;
  }
  if (params.sort && (Array.isArray(params.sort) ? params.sort.length : Object.keys(params.sort).length) > 0) {
    clean.sort = params.sort;
  }
  if (Object.keys(clean).length === 0) return '';
  return qs.stringify(clean, QS_OPTS);
}

/**
 * Learners: filter by documentId ($eq or $in).
 * @param {string|string[]} documentIds - Single id or array for $in
 * @param {object} [opts] - { populateUser, page, pageSize }
 */
function learnersByDocumentId(documentIds, opts = {}) {
  const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
  const filters = ids.length === 1
    ? { documentId: { $eq: ids[0] } }
    : { documentId: { $in: ids } };
  const populate = opts.populateUser
    ? { user: { fields: ['email', 'username'] } }
    : '*';
  return buildQuery({
    filters,
    populate,
    pagination: {
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? Math.max(ids.length, 100),
    },
  });
}

/**
 * Program-trackers: filter by complete_percentage >= value.
 * @param {number} minCompletion - e.g. 35
 * @param {object} [opts] - { page, pageSize }
 */
function programTrackersByCompletion(minCompletion, opts = {}) {
  return buildQuery({
    filters: {
      complete_percentage: { $gte: minCompletion },
    },
    fields: ['complete_percentage'],
    populate: {
      user: { fields: ['documentId', 'username', 'email'] },
      program: { fields: ['title'] },
    },
    pagination: {
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? 100,
    },
  });
}

/**
 * Learners: for filter options sync (colleges, branches, etc.).
 */
function learnersForFilterSync(page = 1, pageSize = 100) {
  return buildQuery({
    populate: {
      master_college: { fields: ['name'] },
      branch: { fields: ['name'] },
      university: { fields: ['name'] },
    },
    fields: ['specialisation', 'education_level'],
    pagination: { page, pageSize },
  });
}

module.exports = {
  buildQuery,
  learnersByDocumentId,
  programTrackersByCompletion,
  learnersForFilterSync,
  QS_OPTS,
};
