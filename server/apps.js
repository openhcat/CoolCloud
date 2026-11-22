import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { nowISO, slugify, safeJoin } from './util.js';
import { OFFICIAL_REGISTRY } from './config.js';

export const registryUrl = (cfg) => String(cfg?.appstore?.official || cfg?.appstore?.registries?.[0] || OFFICIAL_REGISTRY);

/** https://github.com/o/r(.git) + main -> https://raw.githubusercontent.com/o/r/main/ */
export function rawBase(repo, branch = 'main') {
  const match = String(repo || '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return '';
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch || 'main'}/`;
}

export async function fetchRegistry(url, timeout = 15000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { Accept: 'application/json', 'User-Agent': 'CoolCloud-registry' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.apps)) throw new Error('That JSON has no "apps" array');
  /* Registry entries may inherit the repository and branch from the registry
     itself, so every consumer sees a complete entry. */
  payload.apps = payload.apps.map((app) => ({
    ...app,
    repo: app.repo || payload.repo,
    branch: app.branch || payload.branch || 'main'
  }));
  return payload;
}

/** Safe relative path for a downloaded package file. */
function packagePath(relative) {
  const clean = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some((part) => part === '..' || part === '')) {
    throw Object.assign(new Error(`Unsafe package path: ${relative}`), { status: 400 });
  }
  return clean;
}

/**
 * Download an app package listed in a registry into a temporary folder.
 * Only the files named in the entry are fetched, so the installer never
 * has to trust anything beyond the manifest and its entry point.
 */
async function downloadPackage(entry, timeout = 20000) {
  const base = rawBase(entry.repo, entry.branch);
  if (!base) throw Object.assign(new Error('This registry entry has no GitHub repository to download from'), { status: 400 });
  const folder = String(entry.path || '.').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const files = Array.isArray(entry.files) && entry.files.length ? entry.files : ['manifest.json'];
  const temp = fs.mkdtempSync(path.join(process.cwd(), '.cc-pkg-'));
  try {
    for (const file of files) {
      const relative = packagePath(file);
      const url = `${base}${folder && folder !== '.' ? `${folder}/` : ''}${relative}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'CoolCloud-registry' }
      });
      if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 4 * 1024 * 1024) throw new Error(`${relative} is too large`);
      const target = path.join(temp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }
    return temp;
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw Object.assign(new Error(`Could not download the app package: ${err.message}`), { status: 400 });
  }
}

/** Install the app described by one registry entry. */
export async function installRegistryApp(db, instanceAppsDir, entry, { type = '' } = {}) {
  if (!entry || !entry.id) throw Object.assign(new Error('A registry app needs an id'), { status: 400 });
  let temp = '';
  try {
    if (Array.isArray(entry.files) && entry.files.length) {
      temp = await downloadPackage(entry);
      const manifest = readManifest(temp);
      if (!manifest) throw Object.assign(new Error('The downloaded package has no valid manifest.json'), { status: 400 });
      const installed = copyAppFolder(db, instanceAppsDir, temp, { type });
      return installed;
    }
    const repo = entry.repo;
    if (!repo) throw Object.assign(new Error('That registry entry has no repository'), { status: 400 });
    if (entry.path && entry.path !== '.') {
      temp = await cloneToTemp(repo, entry.branch);
      const source = safeJoin(temp, entry.path);
      const installed = copyAppFolder(db, instanceAppsDir, source, { type });
      return installed;
    }
    return cloneApp(db, instanceAppsDir, repo, { branch: entry.branch, type });
  } finally {
    if (temp && fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

function cloneToTemp(gitUrl, branch = '') {
  const temp = fs.mkdtempSync(path.join(process.cwd(), '.cc-clone-'));
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(gitUrl, temp);
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw Object.assign(new Error(`git clone failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`), { status: 400 });
  }
  return temp;
}

/**
 * Pull the core manifests out of the official registry so a new install has
 * its app catalogue without keeping any app folder in the source repository.
 */
export async function ensureAppCatalog(catalogDir, cfg, { force = false } = {}) {
  const hasCatalog = () => {
    try {
      return fs.readdirSync(catalogDir, { withFileTypes: true }).some((entry) => {
        if (!entry.isDirectory()) return false;
        return fs.existsSync(path.join(catalogDir, entry.name, 'manifest.json'));
      });
    } catch {
      return false;
    }
  };

  if (!force && hasCatalog()) return { source: 'cache', apps: 0, payload: null };

  const payload = await fetchRegistry(registryUrl(cfg));
  const wanted = payload.apps.filter((app) => app && app.id && (app.runtime === 'core' || app.builtin));
  if (!wanted.length) throw new Error('The registry lists no core apps');

  fs.mkdirSync(catalogDir, { recursive: true });
  let written = 0;
  for (const app of wanted) {
    const name = slugify(String(app.id).split(':')[1] || app.name, 'app');
    const target = path.join(catalogDir, name);
    try {
      const temp = await downloadPackage({ ...app, files: ['manifest.json'] });
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(path.join(temp, 'manifest.json'), path.join(target, 'manifest.json'));
      fs.rmSync(temp, { recursive: true, force: true });
      written += 1;
    } catch (err) {
      // Keep any manifest already on disk; a single failed download must not
      // wipe the rest of the catalogue.
      if (!fs.existsSync(path.join(target, 'manifest.json'))) {
        console.error(`  App catalogue: ${app.id} — ${err.message}`);
      }
    }
  }
  if (!written) throw new Error('Could not download any app manifest');
  return { source: 'registry', apps: written, payload };
}

/** Make the official registry the default row in the store. */
export async function seedOfficialRegistry(db, cfg, { force = false } = {}) {
  const url = registryUrl(cfg);
  const existing = db.prepare('SELECT url FROM registries WHERE url = ?').get(url);
  if (existing && !force) return { url, cached: true };
  const payload = await fetchRegistry(url);
  db.prepare(
    `INSERT INTO registries (url, name, payload, fetched_at, error) VALUES (?, ?, ?, ?, '')
     ON CONFLICT(url) DO UPDATE SET name = excluded.name, payload = excluded.payload, fetched_at = excluded.fetched_at, error = ''`
  ).run(url, String(payload.name || 'Official CoolCloud App Registry').slice(0, 80), JSON.stringify(payload), nowISO());
  return { url, cached: false, apps: payload.apps.length };
}

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
