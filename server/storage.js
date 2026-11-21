import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeJoin, nowISO, walkFiles, relFrom, fileKind, isTextName } from './util.js';

const HISTORY = '.cc-history';
const MAX_INDEX_BYTES = 512 * 1024;

/* ------------------------------- metadata -------------------------------- */

export function metaFor(db, rel) {
  const row = db.prepare('SELECT * FROM file_meta WHERE path = ?').get(String(rel || ''));
  return row
    ? { ownerId: row.owner_id, favorite: Boolean(row.favorite), tags: row.tags || '', createdAt: row.created_at, updatedAt: row.updated_at }
    : { ownerId: null, favorite: false, tags: '', createdAt: null, updatedAt: null };
}

export function setMeta(db, rel, patch = {}, ownerId = null) {
  const current = metaFor(db, rel);
  const favorite = patch.favorite !== undefined ? (patch.favorite ? 1 : 0) : current.favorite ? 1 : 0;
  const tags = patch.tags !== undefined ? String(patch.tags).slice(0, 300) : current.tags;
  const owner = patch.ownerId !== undefined ? patch.ownerId : current.ownerId ?? ownerId;
  db.prepare(
    `INSERT INTO file_meta (path, owner_id, favorite, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET owner_id = excluded.owner_id, favorite = excluded.favorite, tags = excluded.tags, updated_at = excluded.updated_at`
  ).run(String(rel), owner || null, favorite, tags, current.createdAt || nowISO(), nowISO());
  return metaFor(db, rel);
}

export function moveMeta(db, from, to) {
  const prefix = `${from}/`;
  const rows = db.prepare('SELECT path FROM file_meta WHERE path = ? OR path LIKE ?').all(from, `${prefix}%`);
  for (const row of rows) {
    const next = row.path === from ? to : `${to}/${row.path.slice(prefix.length)}`;
    db.prepare('UPDATE file_meta SET path = ?, updated_at = ? WHERE path = ?').run(next, nowISO(), row.path);
  }
}

export function removeMeta(db, rel) {
  db.prepare('DELETE FROM file_meta WHERE path = ? OR path LIKE ?').run(rel, `${rel}/%`);
  db.prepare('DELETE FROM comments WHERE path = ? OR path LIKE ?').run(rel, `${rel}/%`);
}

export function usageForOwner(db, paths, userId) {
  if (!userId) return 0;
  const rows = db.prepare('SELECT path FROM file_meta WHERE owner_id = ?').all(userId);
  let total = 0;
  for (const row of rows) {
    try {
      const full = safeJoin(paths.filesDir, row.path);
      const stat = fs.statSync(full);
      if (stat.isFile()) total += stat.size;
      else total += dirBytes(full);
    } catch {
      /* a stale metadata row does not break the quota check */
    }
  }
  return total;
}

function dirBytes(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirBytes(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

/* --------------------------------- trash --------------------------------- */

export function moveToTrash(paths, db, rel, ownerId = null) {
  const full = safeJoin(paths.filesDir, rel);
  if (!fs.existsSync(full)) throw Object.assign(new Error('Not found'), { status: 404 });
  if (path.resolve(full) === path.resolve(paths.filesDir)) throw Object.assign(new Error('Cannot delete the Files root'), { status: 400 });
  fs.mkdirSync(paths.trashDir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(full)}`;
  fs.renameSync(full, path.join(paths.trashDir, name));
  db.prepare('INSERT INTO trash (original_path, trash_name, owner_id, deleted_at) VALUES (?, ?, ?, ?)').run(rel, name, ownerId || null, nowISO());
  removeMeta(db, rel);
  removeSearch(db, rel);
  return { name, original: rel };
}

export function listTrash(db) {
  return db.prepare('SELECT * FROM trash ORDER BY id DESC').all().map((row) => ({
    id: row.id,
    original: row.original_path,
    name: path.basename(row.original_path),
    deletedAt: row.deleted_at,
    ownerId: row.owner_id
  }));
}

export function restoreTrash(paths, db, id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('Trash item not found'), { status: 404 });
  const source = path.join(paths.trashDir, row.trash_name);
  if (!fs.existsSync(source)) {
    db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
    throw Object.assign(new Error('The stored copy is missing'), { status: 404 });
  }
  const target = safeJoin(paths.filesDir, row.original_path);
  if (fs.existsSync(target)) throw Object.assign(new Error('An item with that name already exists'), { status: 409 });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  db.prepare('DELETE FROM trash WHERE id = ?').run(row.id);
  return { path: row.original_path };
}

export function emptyTrash(paths, db, id = null) {
  const rows = id
    ? db.prepare('SELECT * FROM trash WHERE id = ?').all(Number(id))
    : db.prepare('SELECT * FROM trash').all();
  for (const row of rows) fs.rmSync(path.join(paths.trashDir, row.trash_name), { recursive: true, force: true });
  if (id) db.prepare('DELETE FROM trash WHERE id = ?').run(Number(id));
  else db.prepare('DELETE FROM trash').run();
  return rows.length;
}

export function pruneTrash(paths, db, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare('SELECT * FROM trash WHERE deleted_at < ?').all(cutoff);
  for (const row of rows) fs.rmSync(path.join(paths.trashDir, row.trash_name), { recursive: true, force: true });
  if (rows.length) db.prepare('DELETE FROM trash WHERE deleted_at < ?').run(cutoff);
}

/* -------------------------------- versions ------------------------------- */

export function versionsFor(full) {
  const dir = path.join(path.dirname(full), HISTORY);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(full);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith('.bak'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, at: stat.mtime.toISOString(), size: stat.size };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
}

export function saveVersion(full) {
  try {
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
    const dir = path.join(path.dirname(full), HISTORY);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = nowISO().replace(/[:.]/g, '-');
    fs.copyFileSync(full, path.join(dir, `${path.basename(full)}.${stamp}.bak`));
    const files = fs.readdirSync(dir).filter((name) => name.startsWith(`${path.basename(full)}.`)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 20))) fs.rmSync(path.join(dir, old), { force: true });
  } catch {
    /* versioning must never block a save */
  }
}

export function versionFile(full, name) {
  const base = path.basename(full);
  if (!name || !name.startsWith(`${base}.`) || !name.endsWith('.bak') || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('Invalid version'), { status: 400 });
  }
  return path.join(path.dirname(full), HISTORY, name);
}

export function restoreVersion(full, name) {
  const source = versionFile(full, name);
  if (!fs.existsSync(source)) throw Object.assign(new Error('Version not found'), { status: 404 });
  saveVersion(full);
  fs.copyFileSync(source, full);
}

/* --------------------------------- shares -------------------------------- */

export function hashSharePassword(password) {
  if (!password) return '';
  const salt = crypto.randomBytes(12).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function checkSharePassword(password, stored) {
  if (!stored) return true;
  try {
    const [, salt, hash] = String(stored).split('$');
    const derived = crypto.scryptSync(String(password || ''), salt, 32);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived);
  } catch {
    return false;
  }
}

export function shareActive(row) {
  return row && (!row.expires_at || row.expires_at > nowISO());
}

/* --------------------------------- comments ------------------------------ */

export function commentList(db, rel) {
  return db
    .prepare(
      `SELECT c.*, u.display_name, u.username FROM comments c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.path = ? ORDER BY c.id ASC LIMIT 200`
    )
    .all(rel)
    .map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      userId: row.user_id,
      name: row.display_name || row.username || 'Someone'
    }));
}

/* ---------------------------------- rules -------------------------------- */

export function parseMatch(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ruleMatches(rule, payload) {
  const match = parseMatch(rule.match);
  if (match.pathPrefix && !String(payload.path || '').startsWith(String(match.pathPrefix))) return false;
  if (match.nameContains && !String(payload.path || '').toLowerCase().includes(String(match.nameContains).toLowerCase())) return false;
  if (match.list && String(payload.list || '') !== String(match.list)) return false;
  return true;
}

/** Execute a user's enabled rules for one event. Never throws into the caller. */
export function runRules(ctx, event, payload = {}) {
  const owner = Number(payload.userId || ctx.user?.id || 0);
  if (!owner) return;
  let rules = [];
  try {
    rules = ctx.db.prepare('SELECT * FROM rules WHERE owner_id = ? AND event = ? AND enabled = 1 ORDER BY id ASC').all(owner, event);
  } catch {
    return;
  }
  for (const rule of rules) {
    if (!ruleMatches(rule, payload)) continue;
    try {
      const target = String(rule.value || '').slice(0, 400);
      if (rule.action === 'notify') {
        ctx.db
          .prepare('INSERT INTO notifications (user_id, actor_id, kind, title, body, link, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
          .run(owner, null, 'notice', rule.name, target || `Rule ran for ${payload.path || event}`, payload.path ? `cc:files?path=${encodeURIComponent(path.dirname(payload.path))}` : '', nowISO());
      } else if (rule.action === 'move' && payload.path && target) {
        const from = safeJoin(ctx.paths.filesDir, payload.path);
        const to = safeJoin(ctx.paths.filesDir, `${target.replace(/\/+$/, '')}/${path.basename(payload.path)}`);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(from, to);
          moveMeta(ctx.db, payload.path, relFrom(ctx.paths.filesDir, to));
        }
      } else if (rule.action === 'copy' && payload.path && target) {
        const from = safeJoin(ctx.paths.filesDir, payload.path);
        const base = path.join(safeJoin(ctx.paths.filesDir, target), path.basename(payload.path));
        let to = base;
        for (let i = 1; fs.existsSync(to) && i < 99; i++) to = `${base.replace(/(\.[^.]+)?$/, (ext) => ` (${i})${ext}`)}`;
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.cpSync(from, to, { recursive: true });
        }
      } else if (rule.action === 'task' && target) {
        ctx.db
          .prepare('INSERT INTO tasks (owner_id, title, notes, list, due, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(owner, target.slice(0, 200), `Created by automation “${rule.name}”`, 'Inbox', null, 'normal', nowISO());
      } else if (rule.action === 'tag' && payload.path && target) {
        const meta = metaFor(ctx.db, payload.path);
        const tags = new Set(String(meta.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean));
        for (const tag of target.split(',')) if (tag.trim()) tags.add(tag.trim().slice(0, 40));
        setMeta(ctx.db, payload.path, { tags: [...tags].join(', ') });
      }
    } catch {
      /* one bad rule must not break an upload or a save */
    }
  }
}

/* -------------------------------- search --------------------------------- */

export function removeSearch(db, rel) {
  try {
    db.prepare('DELETE FROM search_fts WHERE path = ?').run(rel);
    db.prepare('DELETE FROM search_index WHERE path = ?').run(rel);
  } catch {
    /* index is optional */
  }
}

export function indexFile(db, full, rel) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES || !isTextName(path.basename(full))) return;
    const body = fs.readFileSync(full, 'utf8').replace(/\u0000/g, ' ');
    const name = path.basename(full);
    removeSearch(db, rel);
    db.prepare('INSERT INTO search_index (path, name, body, updated_at) VALUES (?, ?, ?, ?)').run(rel, name, body, nowISO());
    db.prepare('INSERT INTO search_fts (path, name, body) VALUES (?, ?, ?)').run(rel, name, body);
  } catch {
    /* unreadable files are simply not indexed */
  }
}

export function indexTree(db, paths, { maxFiles = 2000 } = {}) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM search_index').get().n;
  if (existing > 50) return existing;
  const files = walkFiles(paths.filesDir, { maxFiles, skipDirs: new Set(['.cc-history']) });
  for (const full of files) indexFile(db, full, relFrom(paths.filesDir, full));
  return files.length;
}

export function searchIndexed(db, query, limit = 40) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const rows = db
      .prepare(
        `SELECT path, name, snippet(search_fts, 2, '<mark>', '</mark>', '…', 18) AS snippet
         FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(`${q.replace(/["*:^()-]/g, ' ')}*`, Math.min(80, limit));
    return rows.map((row) => ({ path: row.path, name: row.name, snippet: String(row.snippet || '').replace(/<\/?mark>/g, '') }));
  } catch {
    return [];
  }
}

/* ----------------------------------- zip --------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Build a ZIP on disk without external dependencies. Files are stored (no deflate). */
export async function buildZip(target, items) {
  const handle = await fs.promises.open(target, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const item of items) {
      let stat;
      try {
        stat = fs.statSync(item.full);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const name = Buffer.from(item.name.replace(/\\/g, '/'), 'utf8');
      const { time, day } = dosTime(stat.mtime);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(day, 12);
      header.writeUInt32LE(0, 14);
      header.writeUInt32LE(0, 18);
      header.writeUInt32LE(0, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      const localOffset = offset;
      await handle.write(header, 0, 30, offset);
      offset += 30;
      await handle.write(name, 0, name.length, offset);
      offset += name.length;
      let crc = 0;
      let size = 0;
      if (stat.size) {
        const stream = fs.createReadStream(item.full);
        for await (const chunk of stream) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          await handle.write(chunk, 0, chunk.length, offset);
          offset += chunk.length;
        }
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await handle.write(descriptor, 0, 16, offset);
      offset += 16;
      central.push({ name, time, day, crc, size, offset: localOffset });
    }
    const centralStart = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.day, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);
      await handle.write(header, 0, 46, offset);
      offset += 46;
      await handle.write(entry.name, 0, entry.name.length, offset);
      offset += entry.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await handle.write(end, 0, 22, offset);
    offset += 22;
  } finally {
    await handle.close();
  }
  return offset;
}

export function zipItems(paths, rels) {
  const items = [];
  for (const rel of rels) {
    const full = safeJoin(paths.filesDir, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const base = rel.replace(/\/+$/, '');
      for (const child of walkFiles(full, { maxFiles: 5000, skipDirs: new Set([HISTORY]) })) {
        items.push({ name: `${path.basename(base)}/${relFrom(full, child)}`, full: child });
      }
    } else {
      items.push({ name: path.basename(full), full });
    }
  }
  return items;
}

/* ------------------------------- app scopes ------------------------------ */

export function appStorageGet(db, appId, userId) {
  const rows = db.prepare('SELECT key, value FROM app_storage WHERE app_id = ? AND user_id = ? ORDER BY key').all(appId, userId);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function appStorageSet(db, appId, userId, key, value) {
  db.prepare(
    `INSERT INTO app_storage (app_id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(appId, userId, String(key).slice(0, 120), String(value).slice(0, 200000), nowISO());
}

/* -------------------------------- backups -------------------------------- */

export async function buildBackup(ctx, target) {
  try {
    ctx.db.exec('PRAGMA wal_checkpoint(FULL)');
  } catch {
    /* the copy is still useful */
  }
  const items = [];
  const dataDir = ctx.paths.dataDir;
  for (const name of ['db.sqlite', 'config.json']) {
    const full = name === 'config.json' ? ctx.paths.configPath : path.join(dataDir, name);
    if (fs.existsSync(full)) items.push({ name, full });
  }
  for (const full of walkFiles(ctx.paths.filesDir, { maxFiles: 20000, skipDirs: new Set([HISTORY]) })) {
    items.push({ name: `files/${relFrom(ctx.paths.filesDir, full)}`, full });
  }
  await buildZip(target, items);
  return items.length;
}

/* ---------------------------------- misc --------------------------------- */

export function publicFileEntry(paths, db, rel) {
  const full = safeJoin(paths.filesDir, rel);
  const stat = fs.statSync(full);
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