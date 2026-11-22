import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, requireAdmin, publicUser, verifyPassword } from '../auth.js';
import { audit, countUsers } from '../db.js';
import { ipOf, sendJson } from '../http.js';
import { brandingUnlocked, REGISTRY_HOME, saveConfig, storageLimitBytes, storageUsed } from '../config.js';
import {
  cloneApp,
  copyAppFolder,
  fetchRegistry,
  installRegistryApp,
  listApps,
  readManifest,
  removeApp,
  seedOfficialRegistry,
  syncApps
} from '../apps.js';
import { officeAnswers, officeRunning, officeUrlFor, OFFICE_PROVIDERS, provisionOffice, removeOffice } from '../office.js';
import { nowISO, safeJoin, slugify } from '../util.js';

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LOGO_DATA = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/** Accept "cool.example.com", "https://cool.example.com/" or a ddns host. */
function normalizeUrl(value) {
  let text = String(value || '').trim().slice(0, 300);
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    url.hash = '';
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return text;
  }
}

function sanitizeBranding(input, current) {
  const base = current && typeof current === 'object' ? current : {};
  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const logo = String(input.logo ?? base.logo ?? '');
  const next = {
    logoWord:
      text(input.logoWord ?? base.logoWord ?? 'Cloud', 12).replace(/[<>"&]/g, '') || 'Cloud',
    accent: HEX_COLOR.test(String(input.accent ?? '')) ? String(input.accent).toLowerCase() : base.accent || '#0b5fb0',
    logo: !logo ? '' : LOGO_DATA.test(logo) && logo.length <= 150000 ? logo : base.logo || ''
  };
  return next;
}

function tail(file, lines = 100) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - 256 * 1024);
    const text = fs.readFileSync(file, { encoding: 'utf8', start, end: stat.size });
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function userRow(row) {
  const sessions = row.sessions || 0;
  return { ...publicUser(row), active: Boolean(row.active), sessions };
}

export function registerAdmin(router) {
  /* ------------------------------- overview ------------------------------- */
  router.get('/api/admin/overview', async (ctx) => {
    requireAdmin(ctx);
    const mem = process.memoryUsage();
    const limit = storageLimitBytes(ctx.cfg);
    const used = storageUsed(ctx.paths);
    const dbFile = path.join(ctx.paths.dataDir, 'db.sqlite');
    let dbSize = 0;
    try {
      dbSize = fs.statSync(dbFile).size;
    } catch {
      dbSize = 0;
    }
    sendJson(ctx.res, 200, {
      server: {
        name: ctx.cfg.name,
        node: process.version,
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpus: os.cpus().length,
        load: os.loadavg().map((value) => Number(value.toFixed(2))),
        uptime: process.uptime(),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal
        }
      },
      counts: {
        users: countUsers(ctx.db),
        activeUsers: ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n,
        admins: ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n,
        sessions: ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(nowISO()).n,
        apps: ctx.db.prepare('SELECT COUNT(*) AS n FROM apps').get().n,
        enabledApps: ctx.db.prepare('SELECT COUNT(*) AS n FROM apps WHERE enabled = 1').get().n
      },
      storage: {
        used,
        limit,
        mode: ctx.cfg.storage.mode,
        totalGb: ctx.cfg.storage.totalGb,
        userQuotaMb: ctx.cfg.storage.defaultUserQuotaMb,
        dbSize
      },
      config: ctx.cfg,
      errors: tail(ctx.paths.errorLog, 40),
      audit: ctx.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 25').all()
    });
  });

  router.get('/api/admin/system-file', async (ctx) => {
    requireAdmin(ctx);
    const rel = String(ctx.query.get('path') || '');
    const base = ctx.query.get('root') === 'instance' ? ctx.paths.root : ctx.bundleRoot;
    const full = safeJoin(base, rel);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error('Not a file');
      if (stat.size > 2 * 1024 * 1024) return sendJson(ctx.res, 413, { error: 'File is too large to preview' });
      const content = fs.readFileSync(full, 'utf8');
      sendJson(ctx.res, 200, { path: rel, content });
    } catch {
      sendJson(ctx.res, 404, { error: 'File not found' });
    }
  });

  router.get('/api/admin/logs', async (ctx) => {
    requireAdmin(ctx);
    const which = ctx.query.get('file') === 'access' ? ctx.paths.accessLog : ctx.paths.errorLog;
    sendJson(ctx.res, 200, { file: which, lines: Number(ctx.query.get('lines') || 200), text: tail(which, Number(ctx.query.get('lines') || 200)) });
  });

  /* -------------------------------- config -------------------------------- */
  router.patch('/api/admin/config', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await ctx.json();
    const next = structuredClone(ctx.cfg);
    const unlocked = brandingUnlocked(next);
    if (body.name !== undefined && !unlocked) {
      return sendJson(ctx.res, 403, {
        error: 'Renaming the product is part of CoolCloud Enterprise. Community keeps the CoolCloud name and mark.',
        code: 'edition'
      });
    }
    if (body.branding && typeof body.branding === 'object' && !unlocked) {
      const current = next.branding || {};
      const changesMark =
        (body.branding.logoWord !== undefined && String(body.branding.logoWord) !== String(current.logoWord || '')) ||
        (body.branding.logo !== undefined && String(body.branding.logo || '') !== String(current.logo || ''));
      if (changesMark) {
        return sendJson(ctx.res, 403, {
          error: 'Custom wordmarks and logos are part of CoolCloud Enterprise. Community keeps the CoolCloud mark.',
          code: 'edition'
        });
      }
    }
    if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 60) || 'CoolCloud';
    if (body.publicUrl !== undefined) next.publicUrl = normalizeUrl(body.publicUrl) || next.publicUrl;
    if (body.branding && typeof body.branding === 'object') {
      next.branding = sanitizeBranding(body.branding, next.branding);
    }
    if (body.storage) {
      const mode = body.storage.mode === 'limited' ? 'limited' : 'unlimited';
      next.storage.mode = mode;
      next.storage.totalGb = mode === 'limited' ? Math.max(1, Number(body.storage.totalGb) || 1) : null;
      if (body.storage.defaultUserQuotaMb !== undefined) {
        next.storage.defaultUserQuotaMb = body.storage.defaultUserQuotaMb ? Number(body.storage.defaultUserQuotaMb) : null;
      }
    }
    if (body.limits && body.limits.maxUsers !== undefined) next.limits.maxUsers = Math.max(0, Number(body.limits.maxUsers) || 0);
    if (body.organization && typeof body.organization === 'object') {
      next.organization = {
        name: String(body.organization.name ?? next.organization?.name ?? '').trim().slice(0, 80),
        domain: String(body.organization.domain ?? next.organization?.domain ?? '')
          .trim()
          .toLowerCase()
          .slice(0, 120)
      };
    }
    if (body.features) next.features = { ...next.features, ...body.features };
    if (body.editor) next.editor = { ...next.editor, ...body.editor };
    if (body.mail) next.mail = { ...next.mail, ...body.mail };
    if (body.security) next.security = { ...next.security, ...body.security };
    if (Array.isArray(body.apps?.disabled)) next.apps.disabled = body.apps.disabled.map(String);
    if (body.apps?.essentialsInstalled !== undefined) {
      next.apps.essentialsInstalled = Boolean(body.apps.essentialsInstalled);
      for (const name of next.apps.essentials || []) next.features[name] = next.apps.essentialsInstalled;
    }
    ctx.cfg = next;
    saveConfig(ctx.paths.configPath, next);
    syncApps(ctx.db, path.join(ctx.paths.root, 'apps'), ctx.paths.appsDir, next);
    audit(ctx.db, admin.id, 'config.updated', Object.keys(body).join(','), ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true, config: next });
  });

  /* --------------------------------- users -------------------------------- */
  router.get('/api/admin/users', async (ctx) => {
    requireAdmin(ctx);
    const rows = ctx.db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
         FROM users u ORDER BY u.id ASC`
      )
      .all(nowISO());
    sendJson(ctx.res, 200, { users: rows.map(userRow) });
  });

  router.post('/api/admin/users', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await ctx.json();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME.test(username)) return sendJson(ctx.res, 400, { error: 'Use 3-32 letters, numbers, dots, dashes or underscores' });
    if (password.length < 8) return sendJson(ctx.res, 400, { error: 'Use a password with at least 8 characters' });
    const max = Number(ctx.cfg.limits?.maxUsers || 0);
    if (max && countUsers(ctx.db) >= max) return sendJson(ctx.res, 403, { error: `This server is limited to ${max} accounts` });
    if (ctx.db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(username.toLowerCase())) {
      return sendJson(ctx.res, 409, { error: 'That username is taken' });
    }
    const role = body.role === 'admin' ? 'admin' : 'user';
    const quota = body.quotaMb ? Number(body.quotaMb) : ctx.cfg.storage?.defaultUserQuotaMb || null;
    const info = ctx.db
      .prepare('INSERT INTO users (username, display_name, email, pass_hash, role, quota_mb, prefs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        username,
        String(body.name || username).slice(0, 80),
        String(body.email || '').slice(0, 160),
        hashPassword(password),
        role,
        quota,
        '{}',
        nowISO()
      );
    audit(ctx.db, admin.id, 'user.created', username, ipOf(ctx.req));
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.patch('/api/admin/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return sendJson(ctx.res, 404, { error: 'User not found' });
    const body = await ctx.json();
    if (row.id === admin.id && body.role && body.role !== 'admin') {
      return sendJson(ctx.res, 400, { error: 'You cannot remove your own administrator role' });
    }
    if (row.role === 'admin' && body.role === 'user') {
      const admins = ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
      if (admins <= 1) return sendJson(ctx.res, 400, { error: 'Keep at least one administrator' });
    }
    if (body.password) {
      if (String(body.password).length < 8) return sendJson(ctx.res, 400, { error: 'Use a password with at least 8 characters' });
      ctx.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    ctx.db
      .prepare('UPDATE users SET display_name = ?, email = ?, role = ?, active = ?, quota_mb = ? WHERE id = ?')
      .run(
        body.name !== undefined ? String(body.name).slice(0, 80) : row.display_name,
        body.email !== undefined ? String(body.email).slice(0, 160) : row.email,
        body.role === 'admin' || body.role === 'user' ? body.role : row.role,
        body.active !== undefined ? (body.active ? 1 : 0) : row.active,
        body.quotaMb !== undefined ? (body.quotaMb ? Number(body.quotaMb) : null) : row.quota_mb,
        id
      );
    audit(ctx.db, admin.id, 'user.updated', row.username, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/admin/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return sendJson(ctx.res, 404, { error: 'User not found' });
    if (row.id === admin.id) return sendJson(ctx.res, 400, { error: 'You cannot delete your own account' });
    if (row.role === 'admin') {
      const admins = ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
      if (admins <= 1) return sendJson(ctx.res, 400, { error: 'Keep at least one administrator' });
    }
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(ctx.db, admin.id, 'user.deleted', row.username, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/admin/users/:id/revoke', async (ctx) => {
    requireAdmin(ctx);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(ctx.params.id));
    sendJson(ctx.res, 200, { ok: true });
  });

  /* --------------------------------- apps --------------------------------- */
  router.get('/api/admin/apps', async (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { apps: listApps(ctx.db, { includeDisabled: true }) });
  });

  router.post('/api/admin/apps/:id/toggle', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = ctx.params.id;
    const body = await ctx.json();
    const row = ctx.db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
    if (!row) return sendJson(ctx.res, 404, { error: 'App not found' });
    const enabled = Boolean(body.enabled);
    ctx.db.prepare('UPDATE apps SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const next = structuredClone(ctx.cfg);
    const short = id.includes(':') ? id.split(':')[1] : id;
    next.apps.disabled = new Set(next.apps.disabled || []);
    if (enabled) next.apps.disabled.delete(id);
    else next.apps.disabled.add(id);
    next.apps.disabled = [...next.apps.disabled];
    if (['connect', 'media', 'assistant'].includes(short)) next.features[short] = enabled;
    ctx.cfg = next;
    saveConfig(ctx.paths.configPath, next);
    audit(ctx.db, admin.id, 'app.toggled', `${id}=${enabled}`, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/admin/apps/install', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await ctx.json();
    let app;
    const type = body.type === 'widget' ? 'widget' : body.type === 'app' ? 'app' : '';
    if (body.dir) {
      const source = safeJoin(path.dirname(body.dir) === body.dir ? body.dir : body.dir, '');
      app = copyAppFolder(ctx.db, ctx.paths.appsDir, source, { type });
    } else if (body.git) {
      app = cloneApp(ctx.db, ctx.paths.appsDir, body.git, { branch: body.branch, type });
    } else {
      return sendJson(ctx.res, 400, { error: 'Provide a folder (dir) or a git URL' });
    }
    audit(ctx.db, admin.id, 'app.installed', app.id, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true, app });
  });

  router.delete('/api/admin/apps/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    removeApp(ctx.db, ctx.paths.appsDir, ctx.params.id);
    audit(ctx.db, admin.id, 'app.removed', ctx.params.id, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/admin/app-manifest', async (ctx) => {
    requireAdmin(ctx);
    const dir = safeJoin(ctx.bundleRoot, ctx.query.get('dir') || '');
    const manifest = readManifest(dir);
    sendJson(ctx.res, manifest ? 200 : 404, manifest ? { manifest } : { error: 'No manifest found' });
  });

  /* -------------------------------- store --------------------------------- */
  router.get('/api/admin/store', async (ctx) => {
    requireAdmin(ctx);
    const rows = ctx.db.prepare('SELECT * FROM registries ORDER BY fetched_at DESC').all();
    const installed = new Map(listApps(ctx.db, { includeDisabled: true }).map((app) => [app.id, app]));
    const official = String(ctx.cfg.appstore?.official || '');
    const categories = new Set();
    let publishGuide = `${REGISTRY_HOME}publish.html`;
    const registries = rows.map((row) => {
      let payload = {};
      try {
        payload = JSON.parse(row.payload || '{}');
      } catch {
        payload = {};
      }
      for (const name of payload.categories || []) if (name) categories.add(String(name));
      const apps = payload.apps || [];
      for (const app of apps) if (app.category) categories.add(String(app.category));
      if (row.url === official && payload.publishGuide) publishGuide = String(payload.publishGuide);
      return {
        url: row.url,
        name: row.name,
        error: row.error,
        fetchedAt: row.fetched_at,
        official: row.url === official,
        homepage: payload.homepage || '',
        categories: payload.categories || [],
        apps: apps.map((app) => ({
          ...app,
          enterpriseOnly: Boolean(app.enterprise),
          contact: app.contact || 'https://coolcloud.odoo.com/contactus',
          installed: installed.has(app.id),
          enabled: installed.get(app.id)?.enabled || false
        }))
      };
    });
    sendJson(ctx.res, 200, {
      registries,
      installed: [...installed.values()],
      categories: [...categories].sort(),
      official,
      edition: ctx.cfg.edition || 'community',
      registryHome: REGISTRY_HOME,
      publishGuide
    });
  });

  router.post('/api/admin/store/refresh', async (ctx) => {
    const admin = requireAdmin(ctx);
    const rows = ctx.db.prepare('SELECT * FROM registries').all();
    let updated = 0;
    for (const row of rows) {
      try {
        const payload = await fetchRegistry(row.url);
        ctx.db
          .prepare('UPDATE registries SET name = ?, payload = ?, fetched_at = ?, error = ? WHERE url = ?')
          .run(String(payload.name || row.name).slice(0, 80), JSON.stringify(payload), nowISO(), '', row.url);
        updated += 1;
      } catch (err) {
        ctx.db
          .prepare('UPDATE registries SET error = ?, fetched_at = ? WHERE url = ?')
          .run(String(err.message || 'Could not refresh').slice(0, 300), nowISO(), row.url);
      }
    }
    audit(ctx.db, admin.id, 'registry.refreshed', `${rows.length} registries`, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true, updated, total: rows.length });
  });

  router.post('/api/admin/store/registries', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await ctx.json();
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return sendJson(ctx.res, 400, { error: 'Registry URL must start with http:// or https://' });
    let payload;
    try {
      payload = await fetchRegistry(url, 12000);
    } catch (err) {
      return sendJson(ctx.res, 400, { error: `Could not read that registry: ${err.message}` });
    }
    const invalid = payload.apps.find((app) => !app || !app.id || !app.name || !(app.repo || payload.repo));
    if (invalid) return sendJson(ctx.res, 400, { error: 'Every app needs id, name and a repo (on the app or the registry)' });
    payload.apps = payload.apps.map((app) => ({
      ...app,
      repo: app.repo || payload.repo,
      branch: app.branch || payload.branch || 'main'
    }));
    ctx.db
      .prepare(
        `INSERT INTO registries (url, name, payload, fetched_at, error) VALUES (?, ?, ?, ?, '')
         ON CONFLICT(url) DO UPDATE SET name = excluded.name, payload = excluded.payload, fetched_at = excluded.fetched_at, error = ''`
      )
      .run(url, String(payload.name || new URL(url).hostname).slice(0, 80), JSON.stringify(payload), nowISO());
    audit(ctx.db, admin.id, 'registry.added', url, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ok: true, apps: payload.apps.length });
  });

  router.delete('/api/admin/store/registries', async (ctx) => {
    requireAdmin(ctx);
    const url = ctx.query.get('url');
    ctx.db.prepare('DELETE FROM registries WHERE url = ?').run(String(url || ''));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/admin/store/install', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await ctx.json();
    if (body.git) {
      const type = body.type === 'widget' ? 'widget' : body.type === 'app' ? 'app' : '';
      try {
        const app = cloneApp(ctx.db, ctx.paths.appsDir, body.git, { branch: body.branch, type });
        audit(ctx.db, admin.id, 'store.install', `${app.id} <- ${body.git}`, ipOf(ctx.req));
        sendJson(ctx.res, 200, { ok: true, app });
      } catch (err) {
        sendJson(ctx.res, err.status || 500, { error: err.message });
      }
      return;
    }

    const wanted = String(body.id || '');
    let entry = null;
    const rows = ctx.db.prepare('SELECT * FROM registries').all();
    for (const row of rows) {
      let payload = {};
      try {
        payload = JSON.parse(row.payload || '{}');
      } catch {
        continue;
      }
      const found = (payload.apps || []).find((app) => app.id === wanted);
      if (found) {
        entry = { repo: found.repo || payload.repo, branch: found.branch || payload.branch, ...found };
        break;
      }
    }
    if (!entry) {
      return sendJson(ctx.res, 400, {
        error: 'That app is not in any registry. Refresh the store, or install from a folder or git URL instead.'
      });
    }
    if (entry.enterprise) {
      return sendJson(ctx.res, 400, {
        error: `That app is Enterprise only. Get Enterprise for more apps: ${entry.contact || 'https://coolcloud.odoo.com/contactus'}`,
        code: 'enterprise',
        contact: entry.contact || 'https://coolcloud.odoo.com/contactus'
      });
    }
    const type =
      body.type === 'widget' || body.type === 'app' ? body.type : entry.type === 'widget' ? 'widget' : '';
    try {
      const app = await installRegistryApp(ctx.db, ctx.paths.appsDir, entry, { type });
      audit(ctx.db, admin.id, 'store.install', `${entry.id} <- ${entry.repo || 'registry'}`, ipOf(ctx.req));
      sendJson(ctx.res, 200, { ok: true, app });
    } catch (err) {
      sendJson(ctx.res, err.status || 500, { error: err.message });
    }
  });

  /* -------------------------------- office -------------------------------- */
  router.get('/api/admin/office', async (ctx) => {
    requireAdmin(ctx);
    const container = ctx.cfg.editor?.officeContainer || 'coolcloud-office';
    const url = officeUrlFor(ctx.cfg.editor?.officeProvider || 'none', ctx.cfg.editor?.officeUrl);
    const running = ctx.cfg.editor?.officeProvider === 'collabora' ? await officeRunning(container) : false;
    const ready = url && ctx.cfg.editor?.officeProvider === 'collabora' ? await officeAnswers(url, 1500) : false;
    sendJson(ctx.res, 200, {
      provider: ctx.cfg.editor?.officeProvider || 'none',
      url,
      container,
      autoHost: ctx.cfg.editor?.autoHost !== false,
      running,
      ready,
      providers: OFFICE_PROVIDERS
    });
  });

  router.post('/api/admin/office/provision', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await ctx.json();
    const provider = String(body.provider || 'collabora');
    const result = await provisionOffice(
      ctx.paths,
      provider,
      ctx.cfg.editor?.officeContainer || 'coolcloud-office',
      ctx.cfg
    );
    if (result.ok) {
      const next = structuredClone(ctx.cfg);
      next.editor.officeProvider = provider;
      next.editor.officeUrl = result.url || officeUrlFor(provider);
      next.editor.autoHost = true;
      ctx.cfg = next;
      saveConfig(ctx.paths.configPath, next);
      audit(ctx.db, admin.id, 'office.provisioned', provider, ipOf(ctx.req));
    }
    sendJson(ctx.res, result.ok ? 200 : 502, { ...result, providers: OFFICE_PROVIDERS });
  });

  router.delete('/api/admin/office', async (ctx) => {
    const admin = requireAdmin(ctx);
    const container = ctx.cfg.editor?.officeContainer || 'coolcloud-office';
    const result = await removeOffice(ctx.paths, ctx.cfg, container);
    const next = structuredClone(ctx.cfg);
    next.editor.officeProvider = 'none';
    next.editor.officeUrl = '';
    next.editor.autoHost = false;
    ctx.cfg = next;
    saveConfig(ctx.paths.configPath, next);
    audit(ctx.db, admin.id, 'office.removed', container, ipOf(ctx.req));
    sendJson(ctx.res, 200, { ...result, provider: 'none' });
  });
}
