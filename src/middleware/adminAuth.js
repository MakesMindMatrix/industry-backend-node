const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-change-me';

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const parts = auth.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

async function adminAuthMiddleware(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: { message: 'Admin authentication required' } });
  }
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (decoded.role !== 'admin' && !decoded.adminId) {
      return res.status(403).json({ error: { message: 'Not an admin token' } });
    }
    const res = await pool.query(
      'SELECT id, email FROM admin_users WHERE id = $1',
      [decoded.adminId ?? decoded.id]
    );
    const admin = res.rows[0];
    if (!admin) return res.status(401).json({ error: { message: 'Admin not found' } });
    req.admin = admin;
    next();
  } catch (_) {
    return res.status(401).json({ error: { message: 'Invalid or expired admin token' } });
  }
}

module.exports = { adminAuthMiddleware, ADMIN_JWT_SECRET };
