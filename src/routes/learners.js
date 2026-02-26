const express = require('express');
const router = express.Router();

const baseUrl = process.env.EXTERNAL_LEARNERS_API_URL || 'https://api-dev.mindmatrix.io';

function safeQueryString(queryString) {
  if (!queryString || typeof queryString !== 'string') {
    return 'populate=*&pagination[page]=1&pagination[pageSize]=25';
  }
  const params = new URLSearchParams(queryString);
  const page = params.get('page') || '1';
  const pageSize = params.get('pageSize') || '25';
  const populate = params.get('populate') || '*';
  return `populate=${encodeURIComponent(populate)}&pagination[page]=${encodeURIComponent(page)}&pagination[pageSize]=${encodeURIComponent(pageSize)}`;
}

// GET /api/learners
router.get('/', async (req, res) => {
  try {
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
    const safe = safeQueryString(queryString);
    const url = `${baseUrl}/api/learners?${safe}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch learners from external API' });
  }
});

module.exports = router;
