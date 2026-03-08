const express = require('express');
const router = express.Router();

const baseUrl = process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io';

// Pass through incoming query string; ensure defaults for populate and pagination so external API works
function buildProxyQueryString(queryString) {
  if (!queryString || typeof queryString !== 'string') {
    return 'populate=*&pagination[page]=1&pagination[pageSize]=25';
  }
  const params = new URLSearchParams(queryString);
  if (!params.has('populate')) params.set('populate', '*');
  if (!params.has('pagination[page]')) params.set('pagination[page]', '1');
  if (!params.has('pagination[pageSize]')) params.set('pagination[pageSize]', '25');
  return params.toString();
}

// GET /api/learners
router.get('/', async (req, res) => {
  try {
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
    const qs = buildProxyQueryString(queryString);
    const url = `${baseUrl}/api/learners?${qs}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch learners from external API' });
  }
});

module.exports = router;
