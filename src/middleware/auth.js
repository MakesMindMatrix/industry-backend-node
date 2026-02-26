const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const API_TOKEN = process.env.API_TOKEN?.trim();
const API_TOKEN_USER_ID = process.env.API_TOKEN_USER_ID ? parseInt(process.env.API_TOKEN_USER_ID, 10) : null;

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const parts = auth.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

async function resolveUserForApiToken() {
  if (!API_TOKEN_USER_ID) return null;
  const res = await pool.query(
    'SELECT id, email, username FROM users WHERE id = $1',
    [API_TOKEN_USER_ID]
  );
  return res.rows[0] || null;
}

async function authMiddleware(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: { message: 'Not authenticated' } });
  }

  if (API_TOKEN && token === API_TOKEN) {
    const user = await resolveUserForApiToken();
    if (user) {
      req.user = user;
      return next();
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded?.id != null ? Number(decoded.id) : NaN;
    if (Number.isNaN(userId)) return res.status(401).json({ error: { message: 'Invalid token' } });
    const res = await pool.query(
      'SELECT id, email, username FROM users WHERE id = $1',
      [userId]
    );
    const user = res.rows[0];
    if (!user) return res.status(401).json({ error: { message: 'User not found' } });
    req.user = user;
    next();
  } catch (_) {
    return res.status(401).json({ error: { message: 'Session expired' } });
  }
}

async function optionalAuthMiddleware(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return next();
  if (API_TOKEN && token === API_TOKEN) {
    const user = await resolveUserForApiToken();
    if (user) req.user = user;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded?.id != null ? Number(decoded.id) : NaN;
    if (!Number.isNaN(userId)) {
      const res = await pool.query(
        'SELECT id, email, username FROM users WHERE id = $1',
        [userId]
      );
      if (res.rows[0]) req.user = res.rows[0];
    }
  } catch (_) {}
  next();
}

module.exports = { authMiddleware, optionalAuthMiddleware, getBearerToken, JWT_SECRET };
