import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireUser, requireAdmin, verifyPassword, bearerToken, hashToken } from '../auth.js';
import { sendJson, serveFile, readBody } from '../http.js';
import { appendLog, storageLimitBytes, storageUsed } from '../config.js';
import { audit } from '../db.js';
import { nowISO, safeJoin, relFrom, fileKind, walkFiles, isTextName } from '../util.js';
import {
  buildBackup,
  buildZip,
  checkSharePassword,
  commentList,
  emptyTrash,
  hashSharePassword,
  indexFile,
  listTrash,
  metaFor,
  moveMeta,
  moveToTrash,
  publicFileEntry,
  removeSearch,
  restoreTrash,
  restoreVersion,
  runRules,
  saveVersion,
  searchIndexed,
  setMeta,
  shareActive,
  usageForOwner,
  versionFile,
  versionsFor,
  zipItems
} from '../storage.js';
import { newSecret, otpauthUrl, verifyCode, backupCodes, hashBackup } from '../totp.js';
import { accessFor, assertAccess } from '../access.js';

const zipJobs = new Map();
const MAX_CHUNK = 64 * 1024 * 1024;

function pruneZipJobs() {
  for (const [token, job] of zipJobs) {
    if (job.expires < Date.now()) {
      fs.rmSync(job.file, { force: true });
      zipJobs.delete(token);
    }
  }
}

function exist(paths, rel) {
  try {
    return fs.statSync(safeJoin(paths.filesDir, rel));
  } catch {
    return null;
  }
}

function entryOut(paths, db, rel) {
  const full = safeJoin(paths.filesDir, rel);
  const stat = fs.statSync(full);
  return {
    name: path.basename(full),
    path: relFrom(paths.filesDir, full),
    dir: stat.isDirectory(),
    size: stat.isDirectory() ? null : stat.size,
    mtime: stat.mtime.toISOString(),
    kind: stat.isDirectory() ? 'folder' : fileKind(path.basename(full)),
    ...metaFor(db, relFrom(paths.filesDir, full))
  };
}

function canSee(ctx, user, rel) {
  if (!user) return false;
  return true;
}

function icsEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsCalendar(events, name = 'CoolCloud') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CoolCloud//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEscape(name)}`];
  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.uid || `cc-${event.id}@coolcloud`}`);
    lines.push(`DTSTAMP:${icsDate(event.created_at || nowISO())}`);
    lines.push(`DTSTART:${icsDate(event.start_at)}`);
    lines.push(`DTEND:${icsDate(event.end_at)}`);
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
    if (event.notes) lines.push(`DESCRIPTION:${icsEscape(event.notes)}`);
    if (event.recurrence) lines.push(`RRULE:${event.recurrence}`);
    if (event.reminder_min) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${Number(event.reminder_min)}M`, `DESCRIPTION:${icsEscape(event.title)}`, 'END:VALARM');
    if (event.attendees) for (const address of String(event.attendees).split(/[,;\s]+/).filter(Boolean)) lines.push(`ATTENDEE:mailto:${address}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function parseIcs(text) {
  const events = [];
  const blocks = String(text || '').split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const get = (key) => {
      const line = lines.find((item) => item.startsWith(`${key}:`) || item.startsWith(`${key};`));
      return line ? line.slice(line.indexOf(':') + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').trim() : '';
    };
    const start = get('DTSTART');
    const end = get('DTEND') || start;
    const title = get('SUMMARY');
    if (!title || !start) continue;
    const parse = (value) => {
      const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?/.exec(value);
      if (!match) return null;
      return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0))).toISOString();
    };
    const startAt = parse(start);
    if (!startAt) continue;
    events.push({ title, startAt, endAt: parse(end) || startAt, location: get('LOCATION'), notes: get('DESCRIPTION'), recurrence: get('RRULE') });
  }
  return events;
}

export function registerStudio(router) {
  /* ------------------------------- file meta ------------------------------ */
  router.get('/api/files/favorites', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db.prepare('SELECT * FROM file_meta WHERE favorite = 1 ORDER BY updated_at DESC LIMIT 200').all();
    const favorites = [];
    for (const row of rows) {
      try {
        favorites.push(entryOut(ctx.paths, ctx.db, row.path));
      } catch {
        /* a deleted favorite is skipped */
      }
    }
    sendJson(ctx.res, 200, { favorites: favorites.filter((entry) => canSee(ctx, user, entry.path)) });
  });

  router.get('/api/files/meta', async (ctx) => {
    requireUser(ctx);
    const rel = String(ctx.query.get('path') || '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    sendJson(ctx.res, 200, metaFor(ctx.db, rel));
  });

  router.patch('/api/files/meta', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = String(body.path || '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    if (!exist(ctx.paths, rel)) return sendJson(ctx.res, 404, { error: 'Not found' });
    sendJson(ctx.res, 200, setMeta(ctx.db, rel, body, user.id));
  });

  /* --------------------------------- trash -------------------------------- */
  router.get('/api/files/trash', async (ctx) => {
    const user = requireUser(ctx);
    const items = listTrash(ctx.db).filter((item) => accessFor(ctx.db, user, item.original).allowed);
    sendJson(ctx.res, 200, { items });
  });

  router.post('/api/files/trash/restore', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const row = ctx.db.prepare('SELECT original_path FROM trash WHERE id = ?').get(Number(body.id));
    if (row) {
      try {
        assertAccess(ctx.db, user, row.original_path, { write: true });
      } catch (err) {
        return sendJson(ctx.res, err.status || 403, { error: err.message });
      }
    }
    try {
      const result = restoreTrash(ctx.paths, ctx.db, body.id);
      audit(ctx.db, user.id, 'trash.restore', result.path);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, err.status || 400, { error: err.message });
    }
  });

  router.delete('/api/files/trash', async (ctx) => {
    const user = requireUser(ctx);
    const removed = emptyTrash(ctx.paths, ctx.db);
    audit(ctx.db, user.id, 'trash.empty', String(removed));
    sendJson(ctx.res, 200, { ok: true, removed });
  });

  router.delete('/api/files/trash/:id', async (ctx) => {
    const user = requireUser(ctx);
    const removed = emptyTrash(ctx.paths, ctx.db, ctx.params.id);
    audit(ctx.db, user.id, 'trash.purge', ctx.params.id);
    sendJson(ctx.res, 200, { ok: true, removed });
  });

  /* ------------------------------- versions ------------------------------- */
  router.get('/api/files/version', async (ctx) => {
    const user = requireUser(ctx);
    const rel = String(ctx.query.get('path') || '');
    try {
      assertAccess(ctx.db, user, rel);
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const name = String(ctx.query.get('name') || '');
    const full = safeJoin(ctx.paths.filesDir, rel);
    const file = versionFile(full, name);
    if (!fs.existsSync(file)) return sendJson(ctx.res, 404, { error: 'Version not found' });
    sendJson(ctx.res, 200, { path: rel, name, content: fs.readFileSync(file, 'utf8'), size: fs.statSync(file).size });
  });

  router.post('/api/files/version/restore', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = String(body.path || '');
    const name = String(body.name || '');
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (!fs.existsSync(full)) return sendJson(ctx.res, 404, { error: 'File not found' });
    try {
      restoreVersion(full, name);
      indexFile(ctx.db, full, rel);
      audit(ctx.db, user.id, 'file.version.restore', `${rel} ${name}`);
      sendJson(ctx.res, 200, { ok: true, mtime: fs.statSync(full).mtime.toISOString() });
    } catch (err) {
      sendJson(ctx.res, err.status || 400, { error: err.message });
    }
  });

  /* ---------------------------------- zip --------------------------------- */
  router.post('/api/files/zip', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean).slice(0, 200) : [];
    if (!paths.length) return sendJson(ctx.res, 400, { error: 'Choose at least one item' });
    try {
      for (const rel of paths) assertAccess(ctx.db, user, rel);
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    pruneZipJobs();
    const token = crypto.randomBytes(18).toString('base64url');
    const file = path.join(ctx.paths.tempDir, `zip-${token}.zip`);
    fs.mkdirSync(ctx.paths.tempDir, { recursive: true });
    try {
      const items = zipItems(ctx.paths, paths).filter((item) => accessFor(ctx.db, user, relFrom(ctx.paths.filesDir, item.full)).allowed);
      if (!items.length) return sendJson(ctx.res, 404, { error: 'Nothing to download' });
      await buildZip(file, items);
      zipJobs.set(token, { file, owner: user.id, expires: Date.now() + 10 * 60000, name: `coolcloud-${Date.now()}.zip` });
      sendJson(ctx.res, 200, { token, url: `/api/files/zip/${token}`, files: items.length });
    } catch (err) {
      fs.rmSync(file, { force: true });
      sendJson(ctx.res, 500, { error: `Could not build the archive: ${err.message}` });
    }
  });

  router.get('/api/files/zip/:token', async (ctx) => {
    const user = requireUser(ctx);
    const job = zipJobs.get(ctx.params.token);
    if (!job || job.owner !== user.id || job.expires < Date.now()) return sendJson(ctx.res, 404, { error: 'That archive expired. Create it again.' });
    serveFile(ctx.req, ctx.res, job.file, { download: true, contentType: 'application/zip' });
  });

  /* ------------------------------- duplicates ----------------------------- */
  router.get('/api/files/duplicates', async (ctx) => {
    const user = requireUser(ctx);
    const files = walkFiles(ctx.paths.filesDir, { maxFiles: 8000, skipDirs: new Set(['.cc-history']) }).filter((full) =>
      accessFor(ctx.db, user, relFrom(ctx.paths.filesDir, full)).allowed
    );
    const bySize = new Map();
    for (const full of files) {
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size === 0) continue;
        if (!bySize.has(stat.size)) bySize.set(stat.size, []);
        bySize.get(stat.size).push(full);
      } catch {
        /* ignore */
      }
    }
    const groups = [];
    for (const list of bySize.values()) {
      if (list.length < 2) continue;
      const byHash = new Map();
      for (const full of list) {
        try {
          const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          if (!byHash.has(hash)) byHash.set(hash, []);
          byHash.get(hash).push(full);
        } catch {
          /* ignore */
        }
      }
      for (const [hash, same] of byHash) {
        if (same.length < 2) continue;
        groups.push({
          hash,
          size: fs.statSync(same[0]).size,
          files: same.map((full) => ({ name: path.basename(full), path: relFrom(ctx.paths.filesDir, full) }))
        });
      }
      if (groups.length >= 40) break;
    }
    sendJson(ctx.res, 200, { groups, wasted: groups.reduce((sum, group) => sum + group.size * (group.files.length - 1), 0) });
  });

  /* -------------------------------- uploads ------------------------------- */
  router.post('/api/files/uploads', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = String(body.path || '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A destination path is required' });
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    if (body.resumeId) {
      const existing = ctx.db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(String(body.resumeId), user.id);
      if (existing) {
        const received = fs.existsSync(existing.temp) ? fs.statSync(existing.temp).size : 0;
        return sendJson(ctx.res, 200, { id: existing.id, path: existing.path, received, expected: existing.expected });
      }
    }
    const limit = storageLimitBytes(ctx.cfg);
    if (limit && storageUsed(ctx.paths) >= limit) return sendJson(ctx.res, 507, { error: 'This server has reached its storage limit' });
    const id = crypto.randomBytes(18).toString('base64url');
    const temp = path.join(ctx.paths.uploadsDir, `${id}.part`);
    fs.mkdirSync(ctx.paths.uploadsDir, { recursive: true });
    fs.writeFileSync(temp, '');
    ctx.db.prepare('INSERT INTO uploads (id, path, temp, user_id, expected, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      rel,
      temp,
      user.id,
      body.size ? Number(body.size) : null,
      nowISO()
    );
    sendJson(ctx.res, 200, { id, path: rel, received: 0, expected: body.size ? Number(body.size) : null });
  });

  router.put('/api/files/uploads/:id', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(ctx.params.id, user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Upload not found' });
    try {
      assertAccess(ctx.db, user, row.path, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const offset = Number(ctx.query.get('offset') || 0);
    const current = fs.existsSync(row.temp) ? fs.statSync(row.temp).size : 0;
    if (offset !== current) return sendJson(ctx.res, 409, { error: 'Chunk offset mismatch', received: current });
    const chunks = [];
    let size = current;
    let tooLarge = false;
    await new Promise((resolve, reject) => {
      ctx.req.on('data', (chunk) => {
        size += chunk.length;
        if (chunk.length > MAX_CHUNK || size > 4 * 1024 ** 3) {
          tooLarge = true;
          ctx.req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      ctx.req.on('end', resolve);
      ctx.req.on('error', reject);
    }).catch(() => {});
    if (tooLarge) return sendJson(ctx.res, 413, { error: 'That chunk is too large' });
    const buffer = Buffer.concat(chunks);
    fs.appendFileSync(row.temp, buffer);
    const received = fs.statSync(row.temp).size;
    sendJson(ctx.res, 200, { id: row.id, received, expected: row.expected });
  });

  router.post('/api/files/uploads/:id/complete', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(ctx.params.id, user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Upload not found' });
    if (!fs.existsSync(row.temp)) {
      ctx.db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
      return sendJson(ctx.res, 404, { error: 'Upload data is gone. Start again.' });
    }
    const size = fs.statSync(row.temp).size;
    if (row.expected && size !== row.expected) return sendJson(ctx.res, 400, { error: `Upload is incomplete (${size} of ${row.expected} bytes)` });
    const body = await ctx.json().catch(() => ({}));
    const rel = row.path;
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return sendJson(ctx.res, 400, { error: 'A folder already exists at that path' });
    const limit = storageLimitBytes(ctx.cfg);
    if (limit && storageUsed(ctx.paths) + size > limit) {
      fs.rmSync(row.temp, { force: true });
      ctx.db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
      return sendJson(ctx.res, 507, { error: 'This upload would exceed the server storage limit' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full) && body.replace === false) return sendJson(ctx.res, 409, { error: 'That file already exists' });
    if (fs.existsSync(full)) saveVersion(full);
    fs.renameSync(row.temp, full);
    ctx.db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    setMeta(ctx.db, rel, { ownerId: user.id }, user.id);
    indexFile(ctx.db, full, rel);
    runRules(ctx, 'file.upload', { userId: user.id, path: rel, name: path.basename(rel) });
    audit(ctx.db, user.id, 'file.upload', rel);
    sendJson(ctx.res, 200, { ok: true, path: rel, size });
  });

  /* --------------------------------- shares ------------------------------- */
  router.get('/api/files/shares', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db.prepare('SELECT * FROM shares WHERE created_by = ? ORDER BY created_at DESC LIMIT 100').all(user.id);
    sendJson(ctx.res, 200, {
      shares: rows.map((row) => ({
        token: row.token,
        path: row.path,
        kind: row.kind,
        expiresAt: row.expires_at,
        allowUpload: Boolean(row.allow_upload),
        hasPassword: Boolean(row.password_hash),
        url: `${ctx.cfg.publicUrl || ''}/share.html?t=${row.token}`
      }))
    });
  });

  router.post('/api/files/share', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = String(body.path || '');
    try {
      assertAccess(ctx.db, user, rel, { manage: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const stat = exist(ctx.paths, rel);
    if (!stat) return sendJson(ctx.res, 404, { error: 'Choose a file or folder first' });
    const token = crypto.randomBytes(18).toString('base64url');
    const days = Number(body.expiresDays || 0);
    const expires = days > 0 ? new Date(Date.now() + Math.min(365, days) * 86400000).toISOString() : null;
    ctx.db.prepare(
      'INSERT INTO shares (token, path, kind, password_hash, expires_at, allow_upload, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(token, rel, stat.isDirectory() ? 'folder' : 'file', hashSharePassword(body.password), expires, body.allowUpload ? 1 : 0, user.id, nowISO());
    audit(ctx.db, user.id, 'share.create', rel);
    sendJson(ctx.res, 200, { token, url: `/share.html?t=${token}` });
  });

  router.delete('/api/files/share/:token', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM shares WHERE token = ? AND created_by = ?').run(ctx.params.token, user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* public share routes (token is the credential) */
  const shareRow = (ctx) => ctx.db.prepare('SELECT * FROM shares WHERE token = ?').get(ctx.params.token);
  const shareAllowed = (ctx, row) => {
    if (!row || !shareActive(row)) return false;
    return checkSharePassword(ctx.query.get('password') || '', row.password_hash);
  };

  router.get('/api/public/share/:token', async (ctx) => {
    const row = shareRow(ctx);
    if (!row || !shareActive(row)) return sendJson(ctx.res, 404, { error: 'This link has expired or was removed' });
    if (row.password_hash && !ctx.query.get('password')) return sendJson(ctx.res, 401, { passwordRequired: true });
    if (!shareAllowed(ctx, row)) return sendJson(ctx.res, 403, { error: 'That password is not correct' });
    try {
      const rel = String(ctx.query.get('path') || row.path);
      if (row.kind !== 'folder' && rel !== row.path) return sendJson(ctx.res, 403, { error: 'Not part of this share' });
      if (row.kind === 'folder' && rel !== row.path && !rel.startsWith(`${row.path.replace(/\/$/, '')}/`)) {
        return sendJson(ctx.res, 403, { error: 'Not part of this share' });
      }
      const entry = publicFileEntry(ctx.paths, ctx.db, rel);
      if (entry.dir) {
        const full = safeJoin(ctx.paths.filesDir, rel);
        entry.entries = fs.readdirSync(full, { withFileTypes: true }).filter((item) => !item.name.startsWith('.')).map((item) => publicFileEntry(ctx.paths, ctx.db, `${rel}/${item.name}`));
      }
      sendJson(ctx.res, 200, { share: { token: row.token, kind: row.kind, allowUpload: Boolean(row.allow_upload), expiresAt: row.expires_at }, entry });
    } catch {
      sendJson(ctx.res, 404, { error: 'The shared item is gone' });
    }
  });

  router.get('/api/public/share/:token/raw', async (ctx) => {
    const row = shareRow(ctx);
    if (!shareAllowed(ctx, row)) return sendJson(ctx.res, 403, { error: 'This link is locked' });
    const rel = ctx.query.get('path') || row.path;
    if (row.kind !== 'folder' && rel !== row.path) return sendJson(ctx.res, 403, { error: 'Not part of this share' });
    if (row.kind === 'folder' && !rel.startsWith(`${row.path}/`)) return sendJson(ctx.res, 403, { error: 'Not part of this share' });
    serveFile(ctx.req, ctx.res, safeJoin(ctx.paths.filesDir, rel), { download: ctx.query.get('download') === '1' });
  });

  router.post('/api/public/share/:token/upload', async (ctx) => {
    const row = shareRow(ctx);
    if (!shareAllowed(ctx, row) || !row.allow_upload) return sendJson(ctx.res, 403, { error: 'Uploads are not allowed on this link' });
    const name = String(ctx.query.get('name') || '').replace(/[\\/]/g, '').trim().slice(0, 180);
    if (!name) return sendJson(ctx.res, 400, { error: 'A file name is required' });
    const folder = row.kind === 'folder' ? row.path : path.dirname(row.path);
    const full = safeJoin(ctx.paths.filesDir, `${folder}/${name}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const temp = `${full}.uploading-${Date.now()}`;
    try {
      await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(temp);
        ctx.req.pipe(stream);
        stream.on('finish', resolve);
        stream.on('error', reject);
      });
      fs.renameSync(temp, full);
      sendJson(ctx.res, 200, { ok: true, name });
    } catch (err) {
      fs.rmSync(temp, { force: true });
      sendJson(ctx.res, 500, { error: err.message });
    }
  });

  /* -------------------------------- comments ------------------------------ */
  router.get('/api/files/comments', async (ctx) => {
    const user = requireUser(ctx);
    const rel = String(ctx.query.get('path') || '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    try {
      assertAccess(ctx.db, user, rel);
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    sendJson(ctx.res, 200, { comments: commentList(ctx.db, rel) });
  });

  router.post('/api/files/comments', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = String(body.path || '');
    const text = String(body.body || '').trim().slice(0, 4000);
    if (!rel || !text) return sendJson(ctx.res, 400, { error: 'Write a comment first' });
    try {
      assertAccess(ctx.db, user, rel, { comment: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    if (!exist(ctx.paths, rel)) return sendJson(ctx.res, 404, { error: 'File not found' });
    ctx.db.prepare('INSERT INTO comments (path, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(rel, user.id, text, nowISO());
    sendJson(ctx.res, 200, { comments: commentList(ctx.db, rel) });
  });

  router.delete('/api/files/comments/:id', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(ctx.params.id));
    if (!row) return sendJson(ctx.res, 404, { error: 'Comment not found' });
    if (row.user_id !== user.id && user.role !== 'admin') return sendJson(ctx.res, 403, { error: 'You can only remove your own comments' });
    ctx.db.prepare('DELETE FROM comments WHERE id = ?').run(row.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* --------------------------------- rules -------------------------------- */
  router.get('/api/rules', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db.prepare('SELECT * FROM rules WHERE owner_id = ? ORDER BY id DESC').all(user.id);
    sendJson(ctx.res, 200, {
      rules: rows.map((row) => ({ id: row.id, name: row.name, event: row.event, match: JSON.parse(row.match || '{}'), action: row.action, value: row.value, enabled: Boolean(row.enabled) }))
    });
  });

  router.post('/api/rules', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const allowedEvents = new Set(['file.upload', 'file.delete', 'task.created', 'task.completed', 'event.created']);
    const allowedActions = new Set(['notify', 'move', 'copy', 'task', 'tag']);
    if (!allowedEvents.has(body.event)) return sendJson(ctx.res, 400, { error: 'Pick a trigger' });
    if (!allowedActions.has(body.action)) return sendJson(ctx.res, 400, { error: 'Pick an action' });
    const name = String(body.name || 'Automation').trim().slice(0, 100);
    const match = body.match && typeof body.match === 'object' ? body.match : {};
    const info = ctx.db.prepare('INSERT INTO rules (owner_id, name, event, match, action, value, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      user.id,
      name,
      body.event,
      JSON.stringify(match),
      body.action,
      String(body.value || '').slice(0, 400),
      body.enabled === false ? 0 : 1,
      nowISO()
    );
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.patch('/api/rules/:id', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.db.prepare('SELECT * FROM rules WHERE id = ? AND owner_id = ?').get(Number(ctx.params.id), user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Automation not found' });
    const body = await ctx.json();
    ctx.db.prepare('UPDATE rules SET name = ?, enabled = ?, value = ? WHERE id = ?').run(
      body.name !== undefined ? String(body.name).slice(0, 100) : row.name,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : row.enabled,
      body.value !== undefined ? String(body.value).slice(0, 400) : row.value,
      row.id
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/rules/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM rules WHERE id = ? AND owner_id = ?').run(Number(ctx.params.id), user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* ------------------------------- calendar ------------------------------- */
  router.get('/api/calendar/export.ics', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db.prepare('SELECT * FROM events WHERE owner_id = ? ORDER BY start_at ASC').all(user.id);
    const body = icsCalendar(rows, ctx.cfg.name);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="coolcloud-calendar.ics"',
      'Cache-Control': 'no-store'
    });
    ctx.res.end(body);
  });

  router.get('/api/calendar/:id/ics', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.db.prepare('SELECT * FROM events WHERE id = ? AND owner_id = ?').get(Number(ctx.params.id), user.id);
    if (!row) return sendJson(ctx.res, 404, { error: 'Event not found' });
    ctx.res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="event-${row.id}.ics"` });
    ctx.res.end(icsCalendar([row], row.title));
  });

  router.post('/api/calendar/import.ics', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json(5 * 1024 * 1024);
    const events = parseIcs(body.text);
    let imported = 0;
    for (const event of events.slice(0, 500)) {
      ctx.db.prepare(
        'INSERT INTO events (owner_id, calendar, title, start_at, end_at, all_day, location, notes, color, created_at, recurrence, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(user.id, 'Imported', event.title.slice(0, 200), event.startAt, event.endAt, 0, event.location.slice(0, 200), event.notes.slice(0, 4000), 'blue', nowISO(), event.recurrence.slice(0, 200), `cc-${crypto.randomUUID()}@coolcloud`);
      imported++;
    }
    sendJson(ctx.res, 200, { ok: true, imported });
  });

  /* -------------------------------- assistant ----------------------------- */
  router.get('/api/assistant/context', async (ctx) => {
    const user = requireUser(ctx);
    const recent = walkFiles(ctx.paths.filesDir, { maxFiles: 800, skipDirs: new Set(['.cc-history']) })
      .map((full) => {
        try {
          const stat = fs.statSync(full);
          return { path: relFrom(ctx.paths.filesDir, full), size: stat.size, mtime: stat.mtime.toISOString() };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, 40);
    const tasks = ctx.db.prepare('SELECT title, due, priority, list FROM tasks WHERE owner_id = ? AND done = 0 ORDER BY due IS NULL, due ASC LIMIT 20').all(user.id);
    const events = ctx.db.prepare('SELECT title, start_at FROM events WHERE owner_id = ? AND end_at >= ? ORDER BY start_at ASC LIMIT 20').all(user.id, nowISO());
    sendJson(ctx.res, 200, { recentFiles: recent, tasks, events });
  });

  router.post('/api/assistant/search', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const q = String(body.q || '').slice(0, 200);
    sendJson(ctx.res, 200, { results: searchIndexed(ctx.db, q, 30) });
  });

  /* -------------------------------- security ------------------------------ */
  router.get('/api/security', async (ctx) => {
    const user = requireUser(ctx);
    const totp = ctx.db.prepare('SELECT * FROM totp WHERE user_id = ?').get(user.id);
    const current = bearerToken(ctx.req);
    const sessions = ctx.db
      .prepare('SELECT token_hash, created_at, expires_at, label, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(user.id, nowISO())
      .map((row) => ({
        id: row.token_hash,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        label: row.label,
        ip: row.ip,
        current: current ? row.token_hash === hashToken(current) : false
      }));
    sendJson(ctx.res, 200, { totp: { enabled: Boolean(totp?.enabled), hasSetup: Boolean(totp) }, sessions });
  });

  router.post('/api/security/totp/setup', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    if (!verifyPassword(String(body.password || ''), user.pass_hash)) return sendJson(ctx.res, 400, { error: 'Your current password is incorrect' });
    const existing = ctx.db.prepare('SELECT * FROM totp WHERE user_id = ?').get(user.id);
    if (existing?.enabled) return sendJson(ctx.res, 400, { error: 'Two-factor authentication is already on' });
    const secret = newSecret();
    const codes = backupCodes();
    const hashes = JSON.stringify(codes.map(hashBackup));
    ctx.db.prepare(
      `INSERT INTO totp (user_id, secret, enabled, backup_codes, created_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, backup_codes = excluded.backup_codes, created_at = excluded.created_at`
    ).run(user.id, secret, hashes, nowISO());
    sendJson(ctx.res, 200, {
      secret,
      otpauth: otpauthUrl(secret, user.username, ctx.cfg.name || 'CoolCloud'),
      backupCodes: codes
    });
  });

  router.post('/api/security/totp/enable', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const row = ctx.db.prepare('SELECT * FROM totp WHERE user_id = ?').get(user.id);
    if (!row) return sendJson(ctx.res, 400, { error: 'Start setup first' });
    if (!verifyCode(row.secret, body.code)) return sendJson(ctx.res, 400, { error: 'That code did not match. Check the clock on your device.' });
    ctx.db.prepare('UPDATE totp SET enabled = 1 WHERE user_id = ?').run(user.id);
    audit(ctx.db, user.id, 'totp.enabled', '', ctx.ip());
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/security/totp/disable', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    if (!verifyPassword(String(body.password || ''), user.pass_hash)) return sendJson(ctx.res, 400, { error: 'Your current password is incorrect' });
    const row = ctx.db.prepare('SELECT * FROM totp WHERE user_id = ?').get(user.id);
    if (row?.enabled && !verifyCode(row.secret, body.code)) {
      const used = String(body.code || '').replace(/\s/g, '').toUpperCase();
      const hashes = JSON.parse(row.backup_codes || '[]');
      const hash = hashBackup(used);
      if (!hashes.includes(hash)) return sendJson(ctx.res, 400, { error: 'Enter a current authenticator or backup code' });
      ctx.db.prepare('UPDATE totp SET backup_codes = ? WHERE user_id = ?').run(JSON.stringify(hashes.filter((item) => item !== hash)), user.id);
    }
    ctx.db.prepare('DELETE FROM totp WHERE user_id = ?').run(user.id);
    audit(ctx.db, user.id, 'totp.disabled', '', ctx.ip());
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/security/sessions/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash = ?').run(user.id, ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* ------------------------------- app data ------------------------------- */
  router.get('/api/apps/:id/grants', async (ctx) => {
    const user = requireUser(ctx);
    const app = ctx.db.prepare('SELECT id, name, permissions FROM apps WHERE id = ? AND enabled = 1').get(ctx.params.id);
    if (!app) return sendJson(ctx.res, 404, { error: 'App not found' });
    const row = ctx.db.prepare('SELECT scopes, granted_at FROM app_grants WHERE app_id = ? AND user_id = ?').get(app.id, user.id);
    sendJson(ctx.res, 200, {
      permissions: app.permissions ? app.permissions.split(',').filter(Boolean) : [],
      scopes: row?.scopes ? row.scopes.split(',').filter(Boolean) : [],
      grantedAt: row?.granted_at || null
    });
  });

  router.post('/api/apps/:id/grants', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const app = ctx.db.prepare('SELECT id, permissions FROM apps WHERE id = ? AND enabled = 1').get(ctx.params.id);
    if (!app) return sendJson(ctx.res, 404, { error: 'App not found' });
    const allowed = new Set(app.permissions ? app.permissions.split(',').filter(Boolean) : []);
    const requested = Array.isArray(body.scopes) ? body.scopes.map(String).filter((scope) => allowed.has(scope)) : [];
    const scopes = [...new Set(requested)].sort();
    ctx.db.prepare(
      `INSERT INTO app_grants (app_id, user_id, scopes, granted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id, user_id) DO UPDATE SET scopes = excluded.scopes, granted_at = excluded.granted_at`
    ).run(app.id, user.id, scopes.join(','), nowISO());
    sendJson(ctx.res, 200, { ok: true, scopes });
  });

  router.delete('/api/apps/:id/grants', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM app_grants WHERE app_id = ? AND user_id = ?').run(ctx.params.id, user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/apps/:id/storage', async (ctx) => {
    const user = requireUser(ctx);
    const app = ctx.db.prepare('SELECT id, permissions FROM apps WHERE id = ? AND enabled = 1').get(ctx.params.id);
    if (!app) return sendJson(ctx.res, 404, { error: 'App not found' });
    const grant = ctx.db.prepare('SELECT scopes FROM app_grants WHERE app_id = ? AND user_id = ?').get(app.id, user.id);
    if ((app.permissions || '').split(',').includes('storage') && !String(grant?.scopes || '').split(',').includes('storage')) {
      return sendJson(ctx.res, 403, { error: 'This app needs storage permission', consentRequired: true });
    }
    const rows = ctx.db.prepare('SELECT key, value FROM app_storage WHERE app_id = ? AND user_id = ? ORDER BY key').all(ctx.params.id, user.id);
    sendJson(ctx.res, 200, { data: Object.fromEntries(rows.map((row) => [row.key, row.value])) });
  });

  router.put('/api/apps/:id/storage', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const app = ctx.db.prepare('SELECT id FROM apps WHERE id = ? AND enabled = 1').get(ctx.params.id);
    if (!app) return sendJson(ctx.res, 404, { error: 'App not found' });
    const grant = ctx.db.prepare('SELECT scopes FROM app_grants WHERE app_id = ? AND user_id = ?').get(app.id, user.id);
    const permissions = ctx.db.prepare('SELECT permissions FROM apps WHERE id = ?').get(app.id)?.permissions || '';
    if (permissions.split(',').includes('storage') && !String(grant?.scopes || '').split(',').includes('storage')) {
      return sendJson(ctx.res, 403, { error: 'This app needs storage permission', consentRequired: true });
    }
    const key = String(body.key || '').trim();
    if (!key) return sendJson(ctx.res, 400, { error: 'A key is required' });
    ctx.db.prepare(
      `INSERT INTO app_storage (app_id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id, user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(app.id, user.id, key.slice(0, 120), String(body.value ?? '').slice(0, 200000), nowISO());
    sendJson(ctx.res, 200, { ok: true });
  });

  /* --------------------------------- admin -------------------------------- */
  router.get('/api/admin/backup', async (ctx) => {
    const admin = requireAdmin(ctx);
    const file = path.join(ctx.paths.tempDir, `backup-${Date.now()}.zip`);
    fs.mkdirSync(ctx.paths.tempDir, { recursive: true });
    try {
      await buildBackup(ctx, file);
      audit(ctx.db, admin.id, 'backup.created', path.basename(file));
      serveFile(ctx.req, ctx.res, file, { download: true, contentType: 'application/zip' });
    } catch (err) {
      fs.rmSync(file, { force: true });
      sendJson(ctx.res, 500, { error: `Backup failed: ${err.message}` });
    }
  });

  router.get('/api/admin/audit', async (ctx) => {
    requireAdmin(ctx);
    const clauses = [];
    const values = [];
    const action = String(ctx.query.get('action') || '').trim();
    const actor = String(ctx.query.get('actor') || '').trim();
    if (action) {
      clauses.push('action LIKE ?');
      values.push(`%${action}%`);
    }
    if (actor) {
      clauses.push('(actor_id = ? OR detail LIKE ?)');
      values.push(Number(actor) || -1, `%${actor}%`);
    }
    const limit = Math.min(500, Math.max(10, Number(ctx.query.get('limit') || 100)));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = ctx.db.prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ?`).all(...values, limit);
    sendJson(ctx.res, 200, {
      items: rows.map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, detail: row.detail, ip: row.ip, createdAt: row.created_at }))
    });
  });

  router.get('/api/admin/storage', async (ctx) => {
    requireAdmin(ctx);
    const users = ctx.db.prepare('SELECT id, username, display_name, quota_mb FROM users ORDER BY display_name').all();
    sendJson(ctx.res, 200, {
      users: users.map((row) => ({
        id: row.id,
        name: row.display_name,
        username: row.username,
        quotaMb: row.quota_mb,
        used: usageForOwner(ctx.db, ctx.paths, row.id)
      }))
    });
  });
}