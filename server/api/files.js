import fs from 'node:fs';
import path from 'node:path';
import { requireUser } from '../auth.js';
import { sendJson, serveFile, readBody } from '../http.js';
import { fileKind, isTextName, relFrom, safeJoin, nowISO, walkFiles } from '../util.js';
import { appendLog, storageLimitBytes, storageUsed } from '../config.js';
import { indexFile, metaFor, moveMeta, moveToTrash, removeMeta, removeSearch, runRules, saveVersion, setMeta, usageForOwner, versionsFor } from '../storage.js';
import { accessSummary, assertAccess, parentPath, visiblePath } from '../access.js';
import { DOCUMENT_KINDS, newDocument } from '../documents.js';

let usageCache = { at: 0, bytes: 0 };

function usedBytes(paths, force = false) {
  if (force || Date.now() - usageCache.at > 30000) {
    usageCache = { at: Date.now(), bytes: storageUsed(paths) };
  }
  return usageCache.bytes;
}

function entryOf(filesDir, full, db = null) {
  const stat = fs.statSync(full);
  const rel = relFrom(filesDir, full);
  return {
    name: path.basename(full),
    path: rel,
    dir: stat.isDirectory(),
    size: stat.isDirectory() ? null : stat.size,
    mtime: stat.mtime.toISOString(),
    kind: stat.isDirectory() ? 'folder' : fileKind(path.basename(full)),
    ...metaFor(db, rel)
  };
}

function uniquePath(full) {
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  if (!fs.existsSync(full)) return full;
  for (let index = 1; index < 500; index++) {
    const stamp = index === 1 ? ' copy' : ` copy ${index}`;
    const candidate = path.join(dir, `${base}${stamp}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} copy ${Date.now()}${ext}`);
}

function listFolders(root, limit = 600) {
  const out = [];
  const walk = (full, depth) => {
    if (out.length >= limit || depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = path.join(full, entry.name);
      out.push({ path: relFrom(root, child), name: entry.name, depth });
      walk(child, depth + 1);
      if (out.length >= limit) return;
    }
  };
  walk(root, 0);
  return out;
}

function resolveDir(ctx, rel) {
  const full = safeJoin(ctx.paths.filesDir, rel || '');
  if (!fs.existsSync(full)) {
    if (rel) throw Object.assign(new Error('Folder not found'), { status: 404 });
    fs.mkdirSync(full, { recursive: true });
  }
  return full;
}

export function registerFiles(router) {
  router.get('/api/files', async (ctx) => {
    const user = requireUser(ctx);
    const rel = ctx.query.get('path') || '';
    try {
      assertAccess(ctx.db, user, rel);
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = resolveDir(ctx, rel);
    if (!fs.statSync(full).isDirectory()) return sendJson(ctx.res, 400, { error: 'Not a folder' });
    const entries = fs
      .readdirSync(full, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => entryOf(ctx.paths.filesDir, path.join(full, entry.name), ctx.db))
      .filter((entry) => visiblePath(ctx.db, user, entry.path))
      .map((entry) => ({ ...entry, access: accessSummary(ctx.db, user, entry.path) }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const parts = rel.split('/').filter(Boolean);
    const breadcrumbs = [{ name: 'Files', path: '' }];
    parts.forEach((part, index) => {
      breadcrumbs.push({ name: part, path: parts.slice(0, index + 1).join('/') });
    });
    sendJson(ctx.res, 200, { path: rel, entries, breadcrumbs });
  });

  router.put('/api/files', async (ctx) => {
    const user = requireUser(ctx);
    const rel = ctx.query.get('path');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A destination path is required' });
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const limit = storageLimitBytes(ctx.cfg);
    if (limit && usedBytes(ctx.paths) >= limit) {
      return sendJson(ctx.res, 507, { error: 'This server has reached its storage limit' });
    }
    const quota = user.quota_mb ? Number(user.quota_mb) * 1024 * 1024 : 0;
    if (quota && usageForOwner(ctx.db, ctx.paths, user.id) >= quota) {
      return sendJson(ctx.res, 507, { error: 'Your personal storage quota is full' });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      return sendJson(ctx.res, 400, { error: 'A folder already exists at that path' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const temp = `${full}.uploading-${Date.now()}`;
    try {
      const bytes = await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(temp);
        let size = 0;
        ctx.req.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 ** 3) {
            reject(Object.assign(new Error('File is too large'), { status: 413 }));
            ctx.req.destroy();
          }
        });
        ctx.req.on('error', reject);
        ctx.req.pipe(stream);
        stream.on('finish', () => resolve(size));
        stream.on('error', reject);
      });
      if (limit && usedBytes(ctx.paths) + bytes > limit) {
        fs.rmSync(temp, { force: true });
        return sendJson(ctx.res, 507, { error: 'This upload would exceed the server storage limit' });
      }
      if (quota && usageForOwner(ctx.db, ctx.paths, user.id) + bytes > quota) {
        fs.rmSync(temp, { force: true });
        return sendJson(ctx.res, 507, { error: 'This upload would exceed your personal storage quota' });
      }
      if (fs.existsSync(full)) saveVersion(full);
      fs.renameSync(temp, full);
      usageCache.at = 0;
      setMeta(ctx.db, rel, { ownerId: user.id }, user.id);
      indexFile(ctx.db, full, rel);
      runRules(ctx, 'file.upload', { userId: user.id, path: rel, name: path.basename(rel) });
      const stat = fs.statSync(full);
      sendJson(ctx.res, 200, {
        file: { name: path.basename(full), path: relFrom(ctx.paths.filesDir, full), size: stat.size, mtime: stat.mtime.toISOString() }
      });
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  });

  router.post('/api/files/folder', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = String(body.path || '').replace(/\/+$/, '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'Folder name is required' });
    try {
      assertAccess(ctx.db, user, parentPath(rel), { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (fs.existsSync(full)) return sendJson(ctx.res, 409, { error: 'That name is taken' });
    fs.mkdirSync(full, { recursive: true });
    sendJson(ctx.res, 200, { path: rel, ok: true });
  });

  router.get('/api/files/folders', async (ctx) => {
    const user = requireUser(ctx);
    const folders = listFolders(ctx.paths.filesDir).filter((folder) => visiblePath(ctx.db, user, folder.path));
    sendJson(ctx.res, 200, { folders });
  });

  router.post('/api/files/copy', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const fromRel = String(body.from || '');
    const toRel = String(body.to || '');
    if (!fromRel) return sendJson(ctx.res, 400, { error: 'A source path is required' });
    if (!toRel) return sendJson(ctx.res, 400, { error: 'A destination path is required' });
    try {
      assertAccess(ctx.db, user, fromRel);
      assertAccess(ctx.db, user, toRel, { write: true });
      assertAccess(ctx.db, user, parentPath(toRel), { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const from = safeJoin(ctx.paths.filesDir, fromRel);
    if (from === path.resolve(ctx.paths.filesDir)) return sendJson(ctx.res, 400, { error: 'Cannot copy the Files root' });
    if (!fs.existsSync(from)) return sendJson(ctx.res, 404, { error: 'Source not found' });
    let requested = safeJoin(ctx.paths.filesDir, toRel);
    if (fs.existsSync(requested) && fs.statSync(requested).isDirectory() && requested !== from) {
      requested = path.join(requested, path.basename(from));
    }
    if (requested.startsWith(from + path.sep)) {
      return sendJson(ctx.res, 400, { error: 'Cannot copy a folder inside itself' });
    }
    const target = uniquePath(requested);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(from, target, { recursive: true, errorOnExist: true, force: false });
    usageCache.at = 0;
    const limit = storageLimitBytes(ctx.cfg);
    if (limit && storageUsed(ctx.paths) > limit) {
      fs.rmSync(target, { recursive: true, force: true });
      usageCache.at = 0;
      return sendJson(ctx.res, 507, { error: 'That copy would exceed the server storage limit' });
    }
    const targetRel = relFrom(ctx.paths.filesDir, target);
    setMeta(ctx.db, targetRel, { ownerId: user.id }, user.id);
    if (fs.statSync(target).isFile()) indexFile(ctx.db, target, targetRel);
    sendJson(ctx.res, 200, { ok: true, path: targetRel });
  });

  router.post('/api/files/move', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const fromRel = String(body.from || '');
    const toRel = String(body.to || '');
    if (!fromRel) return sendJson(ctx.res, 400, { error: 'A source path is required' });
    if (!toRel) return sendJson(ctx.res, 400, { error: 'A destination path is required' });
    try {
      assertAccess(ctx.db, user, fromRel, { write: true });
      assertAccess(ctx.db, user, toRel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const from = safeJoin(ctx.paths.filesDir, fromRel);
    const to = safeJoin(ctx.paths.filesDir, toRel);
    const root = path.resolve(ctx.paths.filesDir);
    if (from === root) return sendJson(ctx.res, 400, { error: 'Cannot move the Files root' });
    if (to === root) return sendJson(ctx.res, 400, { error: 'Choose a name for the moved item' });
    if (!fs.existsSync(from)) return sendJson(ctx.res, 404, { error: 'Source not found' });
    if (from === to) return sendJson(ctx.res, 200, { ok: true, path: relFrom(ctx.paths.filesDir, to) });
    if (to.startsWith(from + path.sep)) return sendJson(ctx.res, 400, { error: 'Cannot move a folder inside itself' });
    // Windows treats differently-cased paths as the same file, so allow those.
    const caseOnlyRename = process.platform === 'win32' && from.toLowerCase() === to.toLowerCase();
    if (!caseOnlyRename && fs.existsSync(to)) {
      return sendJson(ctx.res, 409, { error: 'A file or folder with that name already exists' });
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      return sendJson(ctx.res, 409, { error: 'Could not move that item. Check the name and try again.' });
    }
    const destination = relFrom(ctx.paths.filesDir, to);
    moveMeta(ctx.db, fromRel, destination);
    removeSearch(ctx.db, fromRel);
    if (fs.statSync(to).isFile()) indexFile(ctx.db, to, destination);
    else {
      const moved = walkFiles(to, { maxFiles: 500, skipDirs: new Set(['.cc-history']) });
      for (const child of moved) indexFile(ctx.db, child, relFrom(ctx.paths.filesDir, child));
    }
    usageCache.at = 0;
    sendJson(ctx.res, 200, { ok: true, path: destination });
  });

  router.delete('/api/files', async (ctx) => {
    const user = requireUser(ctx);
    const rel = ctx.query.get('path');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    if (!fs.existsSync(safeJoin(ctx.paths.filesDir, rel))) return sendJson(ctx.res, 404, { error: 'Not found' });
    moveToTrash(ctx.paths, ctx.db, rel, user.id);
    usageCache.at = 0;
    runRules(ctx, 'file.delete', { userId: user.id, path: rel, name: path.basename(rel) });
    appendLog(ctx.paths.accessLog, `${user.username} moved ${rel} to trash`);
    sendJson(ctx.res, 200, { ok: true, trashed: true });
  });

  router.get('/api/files/raw', async (ctx) => {
    const user = requireUser(ctx);
    const rel = ctx.query.get('path');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    try {
      assertAccess(ctx.db, user, rel);
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    serveFile(ctx.req, ctx.res, full, {
      download: ctx.query.get('download') === '1',
      cache: 'private, max-age=60'
    });
  });

  router.get('/api/files/text', async (ctx) => {
    const user = requireUser(ctx);
    const rel = ctx.query.get('path');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    try {
      assertAccess(ctx.db, user, rel);
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (!fs.existsSync(full)) return sendJson(ctx.res, 404, { error: 'Not found' });
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return sendJson(ctx.res, 400, { error: 'That is a folder' });
    if (!isTextName(path.basename(full))) return sendJson(ctx.res, 415, { error: 'This file is not text' });
    if (stat.size > 5 * 1024 * 1024) return sendJson(ctx.res, 413, { error: 'File is larger than 5 MB' });
    sendJson(ctx.res, 200, {
      path: rel,
      content: fs.readFileSync(full, 'utf8'),
      mtime: stat.mtime.toISOString(),
      size: stat.size
    });
  });

  router.put('/api/files/text', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json(8 * 1024 * 1024);
    const rel = String(body.path || '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    if (typeof body.content !== 'string') return sendJson(ctx.res, 400, { error: 'Content must be text' });
    const full = safeJoin(ctx.paths.filesDir, rel);
    // Creation flows pass create:true so they never clobber an existing file.
    if (body.create && fs.existsSync(full)) {
      return sendJson(ctx.res, 409, { error: 'A file with that name already exists' });
    }
    const limit = storageLimitBytes(ctx.cfg);
    const existing = fs.existsSync(full) && fs.statSync(full).isFile() ? fs.statSync(full).size : 0;
    const next = Buffer.byteLength(body.content, 'utf8');
    if (limit && usedBytes(ctx.paths) + Math.max(0, next - existing) > limit) {
      return sendJson(ctx.res, 507, { error: 'This save would exceed the server storage limit' });
    }
    const quota = user.quota_mb ? Number(user.quota_mb) * 1024 * 1024 : 0;
    if (quota && usageForOwner(ctx.db, ctx.paths, user.id) + Math.max(0, next - existing) > quota) {
      return sendJson(ctx.res, 507, { error: 'This save would exceed your personal storage quota' });
    }
    const x = safeJoin(ctx.paths.filesDir, rel);
    fs.mkdirSync(path.dirname(x), { recursive: true });
    saveVersion(x);
    fs.writeFileSync(x, body.content, 'utf8');
    usageCache.at = 0;
    setMeta(ctx.db, rel, { ownerId: user.id }, user.id);
    indexFile(ctx.db, x, rel);
    if (body.create) runRules(ctx, 'file.upload', { userId: user.id, path: rel, name: path.basename(rel) });
    sendJson(ctx.res, 200, { ok: true, mtime: fs.statSync(x).mtime.toISOString() });
  });

  /* Empty Writer, Calc, Impress and text files for the Files app. */
  router.post('/api/files/new', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const kind = String(body.kind || '').toLowerCase();
    const spec = DOCUMENT_KINDS[kind];
    if (!spec) return sendJson(ctx.res, 400, { error: 'Choose a document type' });
    const rel = String(body.path || '').trim();
    if (!rel) return sendJson(ctx.res, 400, { error: 'A file name is required' });
    if (path.extname(rel).toLowerCase() !== spec.ext) {
      return sendJson(ctx.res, 400, { error: `Use a ${spec.ext} file name for a ${spec.label.toLowerCase()}` });
    }
    try {
      assertAccess(ctx.db, user, rel, { write: true });
    } catch (err) {
      return sendJson(ctx.res, err.status || 403, { error: err.message });
    }
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (fs.existsSync(full)) return sendJson(ctx.res, 409, { error: 'A file with that name already exists' });

    const document = newDocument(kind);
    const size = document.buffer.length;
    const limit = storageLimitBytes(ctx.cfg);
    if (limit && usedBytes(ctx.paths) + size > limit) {
      return sendJson(ctx.res, 507, { error: 'This server has reached its storage limit' });
    }
    const quota = user.quota_mb ? Number(user.quota_mb) * 1024 * 1024 : 0;
    if (quota && usageForOwner(ctx.db, ctx.paths, user.id) + size > quota) {
      return sendJson(ctx.res, 507, { error: 'Your personal storage quota is full' });
    }

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, document.buffer);
    usageCache.at = 0;
    setMeta(ctx.db, rel, { ownerId: user.id }, user.id);
    indexFile(ctx.db, full, rel);
    runRules(ctx, 'file.upload', { userId: user.id, path: rel, name: path.basename(rel) });
    appendLog(ctx.paths.accessLog, `${user.username} created ${rel}`);
    sendJson(ctx.res, 200, { ok: true, path: rel, kind, label: spec.label });
  });

  router.get('/api/files/versions', async (ctx) => {
    requireUser(ctx);
    const rel = ctx.query.get('path');
    const full = safeJoin(ctx.paths.filesDir, String(rel || ''));
    sendJson(ctx.res, 200, { versions: versionsFor(full) });
  });
}
