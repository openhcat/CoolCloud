import { createSession, destroySession, hashPassword, hashToken, publicUser, requireUser, verifyPassword, bearerToken } from '../auth.js';
import { consumePending, createPending, hashBackup, verifyCode } from '../totp.js';
import { audit } from '../db.js';
import { ipOf, sendJson } from '../http.js';
import { listApps } from '../apps.js';
import { nowISO } from '../util.js';

const attempts = new Map();
const RATE_WINDOW = 5 * 60 * 1000;
const RATE_LIMIT = 20;

// Only failed sign-ins count. Checking the limit must not itself increment it,
// otherwise a user who signs in successfully 20 times gets locked out.
function loginAllowed(ip) {
  const record = attempts.get(ip);
  if (!record) return true;
  if (Date.now() - record.first > RATE_WINDOW) {
    attempts.delete(ip);
    return true;
  }
  return record.count < RATE_LIMIT;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  if (attempts.size > 2000) {
    for (const [key, record] of attempts) {
      if (now - record.first > RATE_WINDOW) attempts.delete(key);
    }
  }
  const record = attempts.get(ip);
  if (!record || now - record.first > RATE_WINDOW) attempts.set(ip, { count: 1, first: now });
  else record.count += 1;
}

function cookieHeader(token, days, secure) {
  return `cc_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${days * 86400}${
    secure ? '; Secure' : ''
  }`;
}

export function registerAuth(router) {
  /* Public: the sign-in screen needs the instance name and logo. */
  router.get('/api/branding', async (ctx) => {
    sendJson(ctx.res, 200, {
      name: ctx.cfg.name,
      edition: ctx.cfg.edition || 'community',
      website: ctx.cfg.website || 'https://coolcloud.odoo.com',
      organization: ctx.cfg.organization || {},
      branding: ctx.cfg.branding || {},
      version: ctx.cfg.version
    });
  });

  router.post('/api/auth/login', async (ctx) => {
    const ip = ipOf(ctx.req);
    if (!loginAllowed(ip)) return sendJson(ctx.res, 429, { error: 'Too many attempts. Wait a few minutes.' });
    const body = await ctx.json();
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const row = ctx.db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(username);
    if (!row || !verifyPassword(password, row.pass_hash)) {
      noteLoginFailure(ip);
      audit(ctx.db, row?.id || null, 'login.failed', `username=${username}`, ip);
      return sendJson(ctx.res, 401, { error: 'That username and password do not match' });
    }
    if (!row.active) {
      noteLoginFailure(ip);
      audit(ctx.db, row.id, 'login.disabled', `username=${username}`, ip);
      return sendJson(ctx.res, 403, { error: 'This account is disabled' });
    }
    attempts.delete(ip);
    const totp = ctx.db.prepare('SELECT * FROM totp WHERE user_id = ? AND enabled = 1').get(row.id);
    if (totp) {
      const pending = createPending(ctx.db, row.id, ip);
      audit(ctx.db, row.id, 'login.totp', 'password accepted, code required', ip);
      return sendJson(ctx.res, 200, { totpRequired: true, pending });
    }
    const days = Number(ctx.cfg.security?.sessionDays || 14);
    const { token } = createSession(ctx.db, row.id, { days, label: 'web', ip });
    const loginAt = nowISO();
    ctx.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(loginAt, row.id);
    row.last_login = loginAt;
    audit(ctx.db, row.id, 'login', 'web', ip);
    const secure = String(ctx.req.headers['x-forwarded-proto'] || '').includes('https');
    sendJson(
      ctx.res,
      200,
      { user: publicUser(row), token },
      { 'Set-Cookie': cookieHeader(token, days, secure) }
    );
  });

  router.post('/api/auth/totp', async (ctx) => {
    const ip = ipOf(ctx.req);
    if (!loginAllowed(ip)) return sendJson(ctx.res, 429, { error: 'Too many attempts. Wait a few minutes.' });
    const body = await ctx.json();
    const row = consumePending(ctx.db, body.pending);
    if (!row) return sendJson(ctx.res, 401, { error: 'That sign-in expired. Start again.' });
    const totp = ctx.db.prepare('SELECT * FROM totp WHERE user_id = ? AND enabled = 1').get(row.id);
    if (!totp) return sendJson(ctx.res, 400, { error: 'Two-factor is no longer enabled. Sign in again.' });
    let ok = verifyCode(totp.secret, body.code);
    if (!ok) {
      const code = String(body.code || '').replace(/\s/g, '').toUpperCase();
      const hashes = JSON.parse(totp.backup_codes || '[]');
      const hash = hashBackup(code);
      if (hashes.includes(hash)) {
        ctx.db.prepare('UPDATE totp SET backup_codes = ? WHERE user_id = ?').run(JSON.stringify(hashes.filter((item) => item !== hash)), row.id);
        ok = true;
        audit(ctx.db, row.id, 'login.backupcode', '', ip);
      }
    }
    if (!ok) {
      noteLoginFailure(ip);
      audit(ctx.db, row.id, 'login.totp.failed', '', ip);
      return sendJson(ctx.res, 401, { error: 'That code is not correct' });
    }
    attempts.delete(ip);
    const days = Number(ctx.cfg.security?.sessionDays || 14);
    const { token } = createSession(ctx.db, row.id, { days, label: 'web', ip });
    const loginAt = nowISO();
    ctx.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(loginAt, row.id);
    row.last_login = loginAt;
    audit(ctx.db, row.id, 'login', 'web+totp', ip);
    const secure = String(ctx.req.headers['x-forwarded-proto'] || '').includes('https');
    sendJson(ctx.res, 200, { user: publicUser(row), token }, { 'Set-Cookie': cookieHeader(token, days, secure) });
  });

  router.post('/api/auth/logout', async (ctx) => {
    destroySession(ctx.db, bearerToken(ctx.req));
    sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': 'cc_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict' });
  });

  router.get('/api/auth/session', async (ctx) => {
    if (!ctx.user) return sendJson(ctx.res, 401, { error: 'Not signed in' });
    const apps = listApps(ctx.db);
    sendJson(ctx.res, 200, {
      user: publicUser(ctx.user),
      apps,
      server: {
        name: ctx.cfg.name,
        edition: ctx.cfg.edition || 'community',
        website: ctx.cfg.website || 'https://coolcloud.odoo.com',
        branding: ctx.cfg.branding || {},
        publicUrl: ctx.cfg.publicUrl,
        organization: ctx.cfg.organization || {},
        storage: ctx.cfg.storage,
        features: ctx.cfg.features,
        editor: ctx.cfg.editor,
        appstore: ctx.cfg.appstore || {},
        version: ctx.cfg.version
      }
    });
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    if (!verifyPassword(String(body.current || ''), user.pass_hash)) {
      return sendJson(ctx.res, 400, { error: 'Current password is incorrect' });
    }
    const next = String(body.next || '');
    if (next.length < 8) return sendJson(ctx.res, 400, { error: 'Use at least 8 characters' });
    ctx.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    // Changing a password signs out every other session, but keeps this one.
    const currentToken = bearerToken(ctx.req);
    if (currentToken) {
      ctx.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(user.id, hashToken(currentToken));
    }
    audit(ctx.db, user.id, 'password.changed', '', ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.patch('/api/me', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : user.display_name;
    const email = body.email !== undefined ? String(body.email).trim().slice(0, 160) : user.email;
    let prefs = {};
    try {
      prefs = JSON.parse(user.prefs || '{}');
    } catch {
      prefs = {};
    }
    if (body.prefs && typeof body.prefs === 'object') prefs = { ...prefs, ...body.prefs };
    ctx.db
      .prepare('UPDATE users SET display_name = ?, email = ?, prefs = ? WHERE id = ?')
      .run(name || user.username, email, JSON.stringify(prefs), user.id);
    const fresh = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(ctx.res, 200, { user: publicUser(fresh) });
  });
}
