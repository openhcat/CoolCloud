import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog, ensureInstanceDirs, instancePaths, loadConfig } from './config.js';
import { notify, openDb } from './db.js';
import { ensureAppCatalog, seedOfficialRegistry, syncApps } from './apps.js';
import { Router, isSameOrigin, readJson, sendJson, serveFile } from './http.js';
import { userFromRequest } from './auth.js';
import { registerAuth } from './api/auth.js';
import { registerFiles } from './api/files.js';
import { registerWorkspace } from './api/workspace.js';
import { registerMail } from './api/mail.js';
import { registerAdmin } from './api/admin.js';
import { attachConnect, registerExtras } from './api/extras.js';
import { registerPublicForms, serveFormPage } from './forms.js';
import { servePublishedSite } from './sitebuilder.js';
import { registerOffice } from './api/office.js';
import { registerStudio } from './api/studio.js';
import { registerTeams } from './api/teams.js';
import { indexTree, pruneTrash } from './storage.js';
import { nowISO } from './util.js';
import { handleWopi, wopiSecret } from './wopi.js';
import { ensureOffice } from './office.js';

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CC_CONFIG
  ? path.resolve(process.env.CC_CONFIG)
  : path.join(process.cwd(), 'config.json');

if (!fs.existsSync(configPath)) {
  console.error(`\n  No config.json found at ${configPath}`);
  console.error('  Run:  coolcloud --install\n');
  process.exit(1);
}

const cfg = loadConfig(configPath);
const paths = instancePaths(configPath);
ensureInstanceDirs(paths);
const db = openDb(paths.dataDir);
const WEB_ROOT = fs.existsSync(path.join(paths.root, 'web')) ? path.join(paths.root, 'web') : path.join(BUNDLE_ROOT, 'web');

/* Apps are not bundled with the platform: the catalogue is pulled from the
   official registry into <instance>/apps, then every manifest is registered. */
const CATALOG_DIR = path.join(paths.root, 'apps');
try {
  const catalog = await ensureAppCatalog(CATALOG_DIR, cfg);
  if (catalog.source === 'registry') console.log(`  App catalogue: pulled ${catalog.apps} manifests from the registry`);
} catch (err) {
  console.error(`  App catalogue: ${err.message}`);
  console.error('  Apps already installed stay available; the catalogue sync will retry on the next start.');
}
syncApps(db, CATALOG_DIR, paths.appsDir, cfg);
pruneTrash(paths, db, 30);
indexTree(db, paths);
seedOfficialRegistry(db, cfg).catch(() => {
  /* the store keeps its cached copy when the registry is offline */
});

const state = {
  db,
  paths,
  bundleRoot: BUNDLE_ROOT,
  root: paths.root,
  router: new Router()
};
Object.defineProperty(state, 'cfg', { get: () => cfg });

registerAuth(state.router);
registerFiles(state.router);
registerWorkspace(state.router);
registerMail(state.router);
registerAdmin(state.router);
registerOffice(state.router);
registerStudio(state.router);
registerTeams(state.router);
registerExtras(state.router);
registerPublicForms(state.router);

/* ------------------------------ static files ----------------------------- */

function serveAsset(req, res, filePath, cache = 'no-cache') {
  serveFile(req, res, filePath, { cache });
}

function appAssetPath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] !== 'app-assets' || parts.length < 3) return null;
  const [, developer, name, ...rest] = parts;
  const base = path.join(paths.appsDir, developer, name);
  const target = rest.length ? path.resolve(base, rest.join('/')) : path.join(base, 'web', 'index.html');
  if (!target.startsWith(path.resolve(base) + path.sep) && target !== path.resolve(base)) return null;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return target;
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/health') {
    sendJson(res, 200, { ok: true, name: cfg.name, version: 1, uptime: Math.round(process.uptime()) });
    return true;
  }

  if (pathname.startsWith('/app-assets/')) {
    const asset = appAssetPath(pathname);
    if (!asset) {
      sendJson(res, 404, { error: 'App asset not found' });
      return true;
    }
    serveAsset(req, res, asset, 'private, max-age=30');
    return true;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.includes('..')) {
    sendJson(res, 400, { error: 'Bad path' });
    return true;
  }
  const full = path.resolve(WEB_ROOT, relative);
  if (!full.startsWith(path.resolve(WEB_ROOT) + path.sep)) {
    sendJson(res, 400, { error: 'Bad path' });
    return true;
  }
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const cache = relative.startsWith('vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    serveAsset(req, res, full, cache);
    return true;
  }

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');
  if (acceptsHtml && !path.extname(relative)) {
    serveAsset(req, res, path.join(WEB_ROOT, 'index.html'), 'no-cache');
    return true;
  }
  sendJson(res, 404, { error: 'Not found' });
  return true;
}

/* ------------------------------ API handling ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  try {
    if (url.pathname.startsWith('/wopi/')) {
      await handleWopi(
        {
          req,
          res,
          db,
          paths,
          get cfg() {
            return cfg;
          }
        },
        url
      );
      return;
    }

    if (url.pathname.startsWith('/s/')) {
      await servePublishedSite({ req, res, url, db, cfg });
      return;
    }

    if (url.pathname.startsWith('/f/')) {
      await serveFormPage({ req, res, url, db });
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      if (handleStatic(req, res, url)) return;
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
      sendJson(res, 403, { error: 'Cross-origin request blocked' });
      return;
    }

    const match = state.router.match(req.method, url.pathname);
    if (!match) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const ctx = {
      req,
      res,
      url,
      query: url.searchParams,
      params: match.params,
      db,
      paths,
      bundleRoot: BUNDLE_ROOT,
      root: paths.root,
      get cfg() {
        return cfg;
      },
      set cfg(next) {
        Object.assign(cfg, next);
      },
      user: userFromRequest(db, req),
      json: (max) => readJson(req, max),
      ip: () => req.headers['x-forwarded-for'] || req.socket.remoteAddress
    };
    await match.handler(ctx);
    if (!res.writableEnded) sendJson(res, 204, {});
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      appendLog(paths.errorLog, `${req.method} ${url.pathname} — ${err.stack || err.message}`);
    }
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error' });
    else res.end();
  }
});

attachConnect(server, state);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${cfg.port} is already in use. Change "port" in ${paths.configPath} or stop the other process.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(Number(cfg.port), cfg.host, () => {
  const host = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log('');
  console.log('   ██████╗ ██████╗');
  console.log('  ██╔════╝██╔════╝');
  console.log('  ██║     ██║');
  console.log('  ██║     ██║');
  console.log('  ╚██████╗╚██████╗');
  console.log('   ╚═════╝ ╚═════╝');
  console.log('');
  console.log(`  CoolCloud is running at http://${host}:${cfg.port}`);
  console.log(`  Instance: ${paths.root}`);
  console.log(`  Data:     ${paths.dataDir}`);
  console.log('');

  wopiSecret(cfg, paths.configPath);
  setInterval(() => {
    const now = Date.now();
    const candidates = db
      .prepare('SELECT * FROM events WHERE reminder_min > 0 AND reminder_sent = 0 AND start_at > ?')
      .all(new Date(now).toISOString());
    const due = candidates.filter((event) => {
      const start = new Date(event.start_at).getTime();
      return start - Number(event.reminder_min) * 60000 <= now + 60000;
    });
    for (const event of due) {
      notify(db, event.owner_id, {
        kind: 'notice',
        title: event.title,
        body: event.location ? `Starts soon · ${event.location}` : 'Starts soon',
        link: 'cc:calendar'
      });
      db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').run(event.id);
    }
  }, 60000).unref();
  if (cfg.editor?.officeProvider === 'collabora' && cfg.editor?.autoHost !== false) {
    ensureOffice(paths, cfg, (line) => console.log(`  ${line}`)).then((result) => {
      if (!result.ready && result.needsDocker) {
        console.log('  Office: Docker is not available, so office documents open as downloads.');
      }
    });
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} received, closing CoolCloud…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
