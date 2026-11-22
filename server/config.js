import fs from 'node:fs';
import path from 'node:path';

/** The registry the installer and App Store pull apps from. */
export const OFFICIAL_REGISTRY = 'https://raw.githubusercontent.com/openhcat/cc-appregistry/main/registry.json';
export const REGISTRY_HOME = 'https://openhcat.github.io/cc-appregistry/';
export const WEBSITE = 'https://coolcloud.odoo.com';

/** The product release, from package.json (config.version is the config schema). */
export const RELEASE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** 'community' unless the tree carries an EDITION file that says enterprise. */
function readEdition() {
  try {
    const text = fs.readFileSync(new URL('../EDITION', import.meta.url), 'utf8').trim().toLowerCase();
    return text === 'enterprise' ? 'enterprise' : 'community';
  } catch {
    return 'community';
  }
}

export const EDITION = readEdition();

/** Community is branded CoolCloud; custom names and logos belong to Enterprise. */
export function brandingUnlocked(cfg = {}) {
  return (cfg.edition || EDITION) === 'enterprise';
}

export const DEFAULT_CONFIG = {
  version: 2,
  edition: EDITION,
  name: 'CoolCloud',
  website: WEBSITE,
  host: '0.0.0.0',
  port: 8080,
  publicUrl: 'http://localhost:8080',
  installPath: '',
  installedAt: '',
  organization: {
    name: '',
    domain: ''
  },
  branding: {
    logoWord: 'Cloud',
    accent: '#0b5fb0',
    logo: ''
  },
  storage: { mode: 'unlimited', totalGb: null, defaultUserQuotaMb: null },
  limits: { maxUsers: 0 },
  apps: {
    core: ['files', 'calendar', 'mail', 'contacts', 'editor', 'tasks'],
    essentials: ['connect', 'media', 'assistant', 'crm', 'finance', 'projects', 'studio'],
    essentialsInstalled: false,
    disabled: []
  },
  appstore: {
    official: OFFICIAL_REGISTRY,
    registries: [OFFICIAL_REGISTRY]
  },
  editor: {
    text: true,
    officeProvider: 'collabora',
    officeUrl: '',
    officeContainer: 'coolcloud-office',
    autoHost: true,
    wopiHost: '',
    wopiSecret: ''
  },
  mail: { allowUserSmtp: true, allowUserImap: true },
  features: {
    search: true,
    appstore: true,
    assistant: false,
    connect: false,
    media: false,
    crm: false,
    finance: false,
    projects: false,
    studio: false
  },
  security: { sessionDays: 14, allowSignups: false, trustProxy: true }
};

function merge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra;
  if (typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  if (typeof extra !== 'object' || extra === null) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

export function loadConfig(configPath) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read config: ${err.message}`);
  }
  return merge(structuredClone(DEFAULT_CONFIG), raw);
}

export function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, configPath);
}

export function instancePaths(configPath) {
  const root = path.dirname(path.resolve(configPath));
  return {
    root,
    configPath: path.resolve(configPath),
    dataDir: path.join(root, 'data'),
    filesDir: path.join(root, 'data', 'files'),
    mediaDir: path.join(root, 'data', 'media'),
    appsDir: path.join(root, 'data', 'apps'),
    trashDir: path.join(root, 'data', 'trash'),
    uploadsDir: path.join(root, 'data', 'uploads'),
    tempDir: path.join(root, 'data', 'tmp'),
    officeDir: path.join(root, 'data', 'office'),
    logDir: path.join(root, 'data', 'logs'),
    errorLog: path.join(root, 'data', 'logs', 'error.log'),
    accessLog: path.join(root, 'data', 'logs', 'access.log')
  };
}

export function ensureInstanceDirs(paths) {
  for (const dir of [paths.dataDir, paths.filesDir, paths.mediaDir, paths.appsDir, paths.trashDir, paths.uploadsDir, paths.tempDir, paths.officeDir, paths.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never throw */
  }
}

/** Bytes currently stored in the instance data directory. */
export function storageUsed(paths) {
  let total = 0;
  const stack = [paths.dataDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

export function storageLimitBytes(cfg) {
  if (!cfg.storage || cfg.storage.mode !== 'limited' || !cfg.storage.totalGb) return null;
  return Math.round(Number(cfg.storage.totalGb) * 1024 ** 3);
}
