import crypto from 'node:crypto';
import { nowISO } from './util.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function codeFor(secret, counter = Math.floor(Date.now() / 30000)) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

export function verifyCode(secret, code) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean) || !secret) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let offset = -1; offset <= 1; offset++) {
    if (codeFor(secret, counter + offset) === clean) return true;
  }
  return false;
}

export function otpauthUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function backupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function hashBackup(code) {
  return crypto.createHash('sha256').update(String(code).replace(/\s/g, '').toUpperCase()).digest('hex');
}

export function createPending(db, userId, ip = '') {
  const token = crypto.randomBytes(24).toString('base64url');
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM pending_logins WHERE expires_at < ?').run(nowISO());
  db.prepare('INSERT INTO pending_logins (token, user_id, expires_at, ip) VALUES (?, ?, ?, ?)').run(
    hashed,
    userId,
    new Date(Date.now() + 5 * 60000).toISOString(),
    ip
  );
  return token;
}

export function consumePending(db, token) {
  const hashed = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const row = db.prepare('SELECT * FROM pending_logins WHERE token = ? AND expires_at > ?').get(hashed, nowISO());
  if (!row) return null;
  db.prepare('DELETE FROM pending_logins WHERE token = ?').run(hashed);
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(row.user_id) || null;
}