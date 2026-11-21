import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendLog, saveConfig } from './config.js';
import { sendJson, serveFile } from './http.js';
import { OFFICE_EXT, extOf, safeJoin } from './util.js';
import { officeAnswers, officeUrlFor, wopiHostFor } from './office.js';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_PUT = 250 * 1024 * 1024;
const locks = new Map();
const openedTokens = new Map();

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function fileIdFor(rel) {
  return Buffer.from(String(rel), 'utf8').toString('base64url');
}

export function relFromFileId(id) {
  try {
    return Buffer.from(String(id), 'base64url').toString('utf8');
  } catch {
    throw fail(400, 'Bad file id');
  }
}

/** Persist a signing secret the first time WOPI is used. */
export function wopiSecret(cfg, configPath) {
  if (cfg.editor?.wopiSecret) return cfg.editor.wopiSecret;
  cfg.editor.wopiSecret = crypto.randomBytes(32).toString('hex');
  if (configPath) saveConfig(configPath, cfg);
  return cfg.editor.wopiSecret;
}

export function makeWopiToken(secret, rel, userId) {
  const payload = Buffer.from(
    JSON.stringify({ p: rel, u: userId, e: Date.now() + TOKEN_TTL_MS, n: crypto.randomBytes(6).toString('hex') }),
    'utf8'
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function readWopiToken(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.p !== 'string' || !data.e || Date.now() > data.e) return null;
    return data;
  } catch {
    return null;
  }
}

/** URL the office container uses to reach CoolCloud's WOPI host. */
export function wopiBaseFor(cfg) {
  const officeUrl = cfg.editor?.officeUrl || '';
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(officeUrl);
  if (local) return `http://${wopiHostFor(cfg)}:${cfg.port}`;
  return (cfg.publicUrl || `http://localhost:${cfg.port}`).replace(/\/+$/, '');
}

export function officeSessionUrl(cfg, rel, userId) {
  const secret = wopiSecret(cfg);
  const token = makeWopiToken(secret, rel, userId);
  const wopiSrc = `${wopiBaseFor(cfg)}/wopi/files/${fileIdFor(rel)}`;
  const base = officeUrlFor('collabora', cfg.editor?.officeUrl);
  return `${base}/browser/dist/cool.html?WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${encodeURIComponent(token)}&lang=en&permission=edit`;
}

function target(ctx, url) {
  const match = /^\/wopi\/files\/([^/]+)(\/contents)?\/?$/.exec(url.pathname);
  if (!match) throw fail(404, 'Not a WOPI endpoint');
  const id = match[1];
  const secret = wopiSecret(ctx.cfg, ctx.paths.configPath);
  const payload = readWopiToken(secret, url.searchParams.get('access_token'));
  if (!payload) throw fail(401, 'Invalid or expired WOPI token');
  const rel = relFromFileId(id);
  if (payload.p !== rel) throw fail(403, 'Token does not match this file');
  const user = ctx.db.prepare('SELECT id, username, display_name, active FROM users WHERE id = ?').get(payload.u);
  if (!user || !user.active) throw fail(401, 'The account for this token is gone');
  const full = safeJoin(ctx.paths.filesDir, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw fail(404, 'File not found');
  if (!OFFICE_EXT.has(extOf(path.basename(full)))) throw fail(415, 'Not an office document');
  const token = String(url.searchParams.get('access_token') || '');
  if (!openedTokens.has(token)) {
    openedTokens.set(token, Date.now());
    appendLog(ctx.paths.accessLog, `wopi: ${user.username} opened ${rel}`);
    if (openedTokens.size > 500) {
      const cutoff = Date.now() - TOKEN_TTL_MS;
      for (const [key, at] of openedTokens) if (at < cutoff) openedTokens.delete(key);
    }
  }
  return { rel, full, user, contents: Boolean(match[2]) };
}

function lockOf(rel) {
  const lock = locks.get(rel);
  if (!lock) return null;
  if (lock.expires < Date.now()) {
    locks.delete(rel);
    return null;
  }
  return lock;
}

function lockHeader(res, lock) {
  if (lock) res.setHeader('X-WOPI-Lock', lock.value);
  else res.setHeader('X-WOPI-Lock', '');
}

function handleLock(ctx, file, req, res) {
  const override = String(req.headers['x-wopi-override'] || '').toUpperCase();
  const requested = String(req.headers['x-wopi-lock'] || '');
  const existing = lockOf(file.rel);

  if (override === 'GET_LOCK') {
    lockHeader(res, existing);
    return sendJson(res, 200, { ok: true });
  }
  if (override === 'UNLOCK') {
    if (existing && existing.value !== requested) {
      lockHeader(res, existing);
      return sendJson(res, 409, { error: 'Lock mismatch' });
    }
    locks.delete(file.rel);
    lockHeader(res, null);
    return sendJson(res, 200, { ok: true });
  }
  if (override === 'REFRESH_LOCK') {
    if (!existing || existing.value !== requested) {
      lockHeader(res, existing);
      return sendJson(res, 409, { error: 'Lock mismatch' });
    }
    existing.expires = Date.now() + 30 * 60 * 1000;
    lockHeader(res, existing);
    return sendJson(res, 200, { ok: true });
  }
  if (override === 'LOCK') {
    if (existing && existing.value !== requested) {
      lockHeader(res, existing);
      return sendJson(res, 409, { error: 'Already locked' });
    }
    const lock = { value: requested, expires: Date.now() + 30 * 60 * 1000 };
    locks.set(file.rel, lock);
    lockHeader(res, lock);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 501, { error: `Unsupported WOPI override: ${override || 'none'}` });
}

export async function handleWopi(ctx, url) {
  const { req, res } = ctx;
  let file;
  try {
    file = target(ctx, url);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  const override = String(req.headers['x-wopi-override'] || '').toUpperCase();

  if ((req.method === 'GET' || req.method === 'HEAD') && file.contents) {
    res.setHeader('Cache-Control', 'no-store');
    serveFile(req, res, file.full, { cache: 'no-store' });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && !file.contents) {
    const stat = fs.statSync(file.full);
    sendJson(res, 200, {
      BaseFileName: path.basename(file.full),
      Size: stat.size,
      Version: String(Math.floor(stat.mtimeMs)),
      OwnerId: 'coolcloud',
      UserId: String(file.user.id),
      UserFriendlyName: file.user.display_name || file.user.username,
      UserCanWrite: true,
      UserCanNotWriteRelative: true,
      SupportsUpdate: true,
      SupportsLocks: true,
      SupportsGetLock: true,
      LastModifiedTime: stat.mtime.toISOString(),
      PostMessageOrigin: (ctx.cfg.publicUrl || `http://localhost:${ctx.cfg.port}`).replace(/\/+$/, '')
    });
    return;
  }

  if (req.method === 'POST' && !file.contents) {
    handleLock(ctx, file, req, res);
    return;
  }

  if (req.method === 'POST' && file.contents) {
    const lock = lockOf(file.rel);
    const lockGiven = String(req.headers['x-wopi-lock'] || '');
    if (lock && lockGiven && lock.value !== lockGiven) {
      lockHeader(res, lock);
      sendJson(res, 409, { error: 'Lock mismatch' });
      return;
    }
    const temp = `${file.full}.wopi-${Date.now()}`;
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(temp);
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_PUT) reject(fail(413, 'Document is too large to save'));
        });
        req.on('error', reject);
        stream.on('error', reject);
        stream.on('finish', resolve);
        req.pipe(stream);
      });
      fs.renameSync(temp, file.full);
      const stat = fs.statSync(file.full);
      appendLog(ctx.paths.accessLog, `wopi: ${file.user.username} saved ${file.rel} (${size} bytes)`);
      res.setHeader('X-WOPI-ItemVersion', String(Math.floor(stat.mtimeMs)));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      fs.rmSync(temp, { force: true });
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed', override: override || undefined });
}

/** Shape returned by /api/office/session for the editor and viewer. */
export async function officeSession(ctx, rel) {
  const provider = ctx.cfg.editor?.officeProvider || 'none';
  if (provider === 'none') return { provider, ready: false, embed: false, reason: 'Office editing is turned off' };

  if (provider !== 'collabora') {
    const url = officeUrlFor(provider, ctx.cfg.editor?.officeUrl);
    return { provider, ready: Boolean(url), embed: false, url, reason: 'This provider opens in its own window' };
  }

  const url = officeUrlFor('collabora', ctx.cfg.editor?.officeUrl);
  const ready = await officeAnswers(url, 1500);
  if (!ready) {
    return { provider, ready: false, embed: true, starting: true, url, reason: 'Starting the office server' };
  }
  return { provider, ready: true, embed: true, url: officeSessionUrl(ctx.cfg, rel, ctx.user.id) };
}
