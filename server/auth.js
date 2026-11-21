import crypto from 'node:crypto';
import { parseCookies } from './http.js';
import { nowISO } from './util.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const derived = crypto.scryptSync(String(password), salt, hash.length / 2, {
      N: Number(N),
      r: Number(r),
      p: Number(p)
    });
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId, { days = 14, label = 'web', ip = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, label, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    nowISO(),
    expires,
    label,
    ip
  );
  return { token, expires };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function bearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const cookies = parseCookies(req);
  return cookies.cc_session || null;
}

export function userFromRequest(db, req) {
  const token = bearerToken(req);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(hashToken(token), nowISO());
  return row || null;
}

export function publicUser(row) {
  if (!row) return null;
  let prefs = {};
  try {
    prefs = JSON.parse(row.prefs || '{}');
  } catch {
    prefs = {};
  }
  return {
    id: row.id,
    username: row.username,
    name: row.display_name,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    quotaMb: row.quota_mb,
    prefs,
    createdAt: row.created_at,
    lastLogin: row.last_login
  };
}

export function requireUser(ctx) {
  if (!ctx.user) {
    const err = new Error('Sign in to continue');
    err.status = 401;
    throw err;
  }
  return ctx.user;
}

export function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') {
    const err = new Error('Administrator access required');
    err.status = 403;
    throw err;
  }
  return user;
}
