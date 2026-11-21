import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { nowISO, slugify, safeJoin } from './util.js';

export function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  let manifest;
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!manifest || !manifest.id || !manifest.name) return null;
  const [maybeDev, maybeName] = String(manifest.id).split(':');
  const developer = String(manifest.developer || maybeDev || 'cc').toLowerCase();
  const name = String(manifest.name);
  return {
    id: String(manifest.id),
    name,
    developer,
    shortName: slugify(maybeName || name),
    version: String(manifest.version || '1.0.0'),
    description: String(manifest.description || ''),
    icon: String(manifest.icon || 'fa-solid fa-cube'),
    accent: String(manifest.accent || 'teal'),
    entry: String(manifest.entry || 'web/index.html'),
    type: manifest.type === 'widget' ? 'widget' : 'app',
    builtin: Boolean(manifest.builtin),
    permissions: Array.isArray(manifest.permissions)
      ? manifest.permissions.map(String).map((scope) => scope.slice(0, 40)).slice(0, 20)
      : [],
    signedBy: String(manifest.signedBy || manifest.author || '').slice(0, 120),
    manifestHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24),
    dir
  };
}

/** Remember an explicit install type in the manifest so later syncs keep it. */
function persistType(dir, type) {
  if (!type) return;
  try {
    const file = path.join(dir, 'manifest.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.type = type === 'widget' ? 'widget' : 'app';
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  } catch {
    /* the database still carries the type for this install */
  }
}

function upsertApp(db, app, { builtin = false, source = 'repo', enabled = true } = {}) {
  db.prepare(
    `INSERT INTO apps (id, name, developer, version, description, icon, accent, source, dir, entry, type, builtin, enabled, installed_at, permissions, manifest_hash, signed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       description = excluded.description,
       icon = excluded.icon,
       accent = excluded.accent,
       dir = excluded.dir,
       entry = excluded.entry,
       type = excluded.type,
       source = excluded.source,
       permissions = excluded.permissions,
       manifest_hash = excluded.manifest_hash,
       signed_by = excluded.signed_by`
  ).run(
    app.id,
    app.name,
    app.developer,
    app.version,
    app.description,
    app.icon,
    app.accent,
    source,
    app.dir,
    app.entry,
    app.type === 'widget' ? 'widget' : 'app',
    builtin ? 1 : 0,
    enabled ? 1 : 0,
    nowISO(),
    (app.permissions || []).join(','),
    app.manifestHash || '',
    app.signedBy || ''
  );
}

/** Register the bundled apps and any app found in the instance apps folder. */
export function syncApps(db, bundleAppsDir, instanceAppsDir, cfg) {
  const disabled = new Set(cfg.apps?.disabled || []);
  const essentialsInstalled = Boolean(cfg.apps?.essentialsInstalled);

  if (fs.existsSync(bundleAppsDir)) {
    for (const entry of fs.readdirSync(bundleAppsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readManifest(path.join(bundleAppsDir, entry.name));
      if (!manifest) continue;
      const isEssential = (cfg.apps?.essentials || []).includes(manifest.id.replace(/^cc:/, ''));
      const enabled = !disabled.has(manifest.id) && (!isEssential || essentialsInstalled);
      upsertApp(db, { ...manifest, builtin: true }, { builtin: true, source: 'bundle', enabled });
      db.prepare('UPDATE apps SET builtin = 1 WHERE id = ?').run(manifest.id);
    }
  }

  if (fs.existsSync(instanceAppsDir)) {
    for (const dev of fs.readdirSync(instanceAppsDir, { withFileTypes: true })) {
      if (!dev.isDirectory()) continue;
      for (const appDir of fs.readdirSync(path.join(instanceAppsDir, dev.name), { withFileTypes: true })) {
        if (!appDir.isDirectory()) continue;
        const full = path.join(instanceAppsDir, dev.name, appDir.name);
        const manifest = readManifest(full);
        if (!manifest) continue;
        const existing = db.prepare('SELECT enabled FROM apps WHERE id = ?').get(manifest.id);
        upsertApp(db, manifest, { source: 'instance', enabled: existing ? Boolean(existing.enabled) : true });
      }
    }
  }
}

export function listApps(db, { includeDisabled = false } = {}) {
  const rows = db.prepare('SELECT * FROM apps ORDER BY builtin DESC, name ASC').all();
  return rows
    .filter((row) => includeDisabled || row.enabled)
    .map((row) => ({
      id: row.id,
      name: row.name,
      developer: row.developer,
      version: row.version,
      description: row.description,
      icon: row.icon,
      accent: row.accent,
      kind: row.builtin ? 'builtin' : 'external',
      enabled: Boolean(row.enabled),
      source: row.source,
      entry: row.entry,
      type: row.type === 'widget' ? 'widget' : 'app',
      installedAt: row.installed_at,
      permissions: row.permissions ? row.permissions.split(',').filter(Boolean) : [],
      signedBy: row.signed_by || '',
      manifestHash: row.manifest_hash || '',
      shortName: row.id.includes(':') ? row.id.split(':')[1] : row.id
    }));
}

export function copyAppFolder(db, instanceAppsDir, sourceDir, { type = '' } = {}) {
  const manifest = readManifest(sourceDir);
  if (!manifest) throw Object.assign(new Error('That folder has no valid manifest.json'), { status: 400 });
  if (type) manifest.type = type === 'widget' ? 'widget' : 'app';
  const target = safeJoin(instanceAppsDir, `${slugify(manifest.developer, 'cc')}/${slugify(manifest.id.split(':')[1] || manifest.name, 'app')}`);
  if (path.resolve(sourceDir) !== path.resolve(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(sourceDir, target, { recursive: true });
  }
  persistType(target, type);
  const installed = readManifest(target);
  if (type) installed.type = type === 'widget' ? 'widget' : 'app';
  upsertApp(db, installed, { source: 'instance', enabled: true });
  db.prepare('UPDATE apps SET enabled = 1 WHERE id = ?').run(installed.id);
  return installed;
}

export function cloneApp(db, instanceAppsDir, gitUrl, { branch = '', type = '' } = {}) {
  if (!/^https?:\/\/|^git@/.test(String(gitUrl))) {
    throw Object.assign(new Error('Only http(s) or ssh git URLs can be installed'), { status: 400 });
  }
  const temp = path.join(instanceAppsDir, `.clone-${Date.now()}`);
  fs.mkdirSync(instanceAppsDir, { recursive: true });
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(gitUrl, temp);
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw Object.assign(new Error(`git clone failed: ${(result.stderr || result.stdout || '').slice(0, 500)}`), { status: 400 });
  }
  try {
    const manifest = readManifest(temp);
    if (!manifest) throw Object.assign(new Error('The repository has no valid manifest.json'), { status: 400 });
    if (type) manifest.type = type === 'widget' ? 'widget' : 'app';
    const target = safeJoin(instanceAppsDir, `${slugify(manifest.developer)}/${slugify(manifest.id.split(':')[1] || manifest.name)}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(temp, target);
    persistType(target, type);
    const installed = readManifest(target);
    if (type) installed.type = type === 'widget' ? 'widget' : 'app';
    upsertApp(db, installed, { source: 'git', enabled: true });
    db.prepare('UPDATE apps SET enabled = 1 WHERE id = ?').run(installed.id);
    return installed;
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function removeApp(db, instanceAppsDir, id) {
  const row = db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('App not found'), { status: 404 });
  if (row.builtin) throw Object.assign(new Error('Built-in apps cannot be removed. Disable them instead.'), { status: 400 });
  const dir = row.dir || safeJoin(instanceAppsDir, `${row.developer}/${slugify(row.id.split(':')[1] || row.name)}`);
  if (path.resolve(dir).startsWith(path.resolve(instanceAppsDir)) && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.prepare('DELETE FROM apps WHERE id = ?').run(id);
}
