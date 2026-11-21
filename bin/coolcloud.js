#!/usr/bin/env node
/**
 * CoolCloud CLI
 *   coolcloud --install            interactive setup
 *   coolcloud --start              run the server in this instance
 *   coolcloud --login              connect this CLI to a server
 *   coolcloud --install dev:app    install an app
 *   coolcloud --config edit        edit config.json
 *   coolcloud --users add sam      manage accounts (admin)
 *   coolcloud --doc edit notes.md  create or edit a document with nano/vim
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const HOME_CONFIG = path.join(os.homedir(), '.coolcloud', 'cli.json');

const color = (() => {
  const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    teal: wrap('38;5;37'),
    green: wrap('38;5;78'),
    amber: wrap('38;5;179'),
    red: wrap('38;5;167'),
    muted: wrap('90')
  };
})();

const CF = `\x1b[38;5;37m`;
const R = '\x1b[0m';
const paint = (text) => (process.stdout.isTTY ? `${CF}${text}${R}` : text);

const BANNER = `
   ██████╗ ██████╗
  ██╔════╝██╔════╝
  ██║     ██║
  ██║     ██║
  ╚██████╗╚██████╗
   ╚═════╝ ╚═════╝`;

/* -------------------------------- helpers -------------------------------- */

let rl = null;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

async function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return fallback;
  const suffix = fallback ? color.muted(` (${fallback})`) : '';
  return new Promise((resolve) => {
    getRl().question(`${question}${suffix}: `, (answer) => resolve(String(answer).trim() || fallback));
  });
}

async function askHidden(question) {
  if (!process.stdin.isTTY) return '';
  closeRl();
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let buffer = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(buffer);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(1);
        }
        if (char === '\u007f' || char === '\b') {
          buffer = buffer.slice(0, -1);
        } else if (char >= ' ') {
          buffer += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question, fallback = false) {
  const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'}`, '')).toLowerCase();
  if (!answer) return fallback;
  return answer === 'y' || answer === 'yes';
}

function commandExists(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return probe.status === 0;
}

function pickEditor(explicit) {
  const candidates = [explicit, process.env.VISUAL, process.env.EDITOR, process.platform === 'win32' ? 'notepad' : 'nano', 'nano', 'vim', 'vi', 'notepad'];
  for (const candidate of candidates.filter(Boolean)) {
    if (commandExists(candidate.split(' ')[0])) return candidate;
  }
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

function runEditor(file, explicit) {
  const editor = pickEditor(explicit);
  const parts = editor.split(/\s+/);
  const result = spawnSync(parts[0], [...parts.slice(1), file], { stdio: 'inherit' });
  return { editor, ok: result.status === 0 };
}

function printBanner() {
  console.log(paint(BANNER));
  console.log('');
}

function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/* ------------------------------- animation ------------------------------- */

const ICONS = [
  { top: '╭──────╮', mid: '│  ▤   │', bottom: '╰──────╯', label: 'Files' },
  { top: '╭──────╮', mid: '│  ▦   │', bottom: '╰──────╯', label: 'Calendar' },
  { top: '╭──────╮', mid: '│  ✉   │', bottom: '╰──────╯', label: 'Mail' },
  { top: '╭──────╮', mid: '│  ◉   │', bottom: '╰──────╯', label: 'Contacts' },
  { top: '╭──────╮', mid: '│  ✎   │', bottom: '╰──────╯', label: 'Editor' },
  { top: '╭──────╮', mid: '│  ✓   │', bottom: '╰──────╯', label: 'Tasks' },
  { top: '╭──────╮', mid: '│  ◍   │', bottom: '╰──────╯', label: 'Connect' },
  { top: '╭──────╮', mid: '│  ▶   │', bottom: '╰──────╯', label: 'Media' },
  { top: '╭──────╮', mid: '│  ✦   │', bottom: '╰──────╯', label: 'Assistant' }
];

const STAGES = [
  'Linking Files',
  'Preparing Calendar',
  'Connecting Mail',
  'Indexing Contacts',
  'Wiring Editor',
  'Syncing Tasks',
  'Seeding Connect',
  'Scanning Media',
  'Finishing up'
];

function drawFrame(frame, progress, width) {
  const active = frame % ICONS.length;
  const rows = [[], [], []];
  ICONS.forEach((item, index) => {
    const glyphs = [item.top, item.mid, item.bottom];
    glyphs.forEach((glyph, row) => {
      rows[row].push(index === active ? paint(color.bold(glyph)) : color.dim(glyph));
    });
  });
  const labels = ICONS.map((item, index) => (index === active ? color.teal(item.label.padEnd(8)) : color.muted(item.label.padEnd(8))));
  const marker = ICONS.map((_, index) => (index === active ? color.teal('   ▲    ') : '        '));

  const filled = Math.round((progress / 100) * width);
  const bar = `${color.green('█'.repeat(filled))}${color.muted('░'.repeat(Math.max(0, width - filled)))}`;
  const stage = STAGES[Math.min(STAGES.length - 1, Math.floor((progress / 100) * STAGES.length))];

  return [
    '',
    `  ${rows[0].join(' ')}`,
    `  ${rows[1].join(' ')}`,
    `  ${rows[2].join(' ')}`,
    `  ${labels.join(' ')}`,
    `  ${marker.join(' ')}`,
    '',
    `  ${bar} ${String(Math.round(progress)).padStart(3)}%   ${color.muted(stage)}`,
    ''
  ];
}

async function playAnimation() {
  if (!process.stdout.isTTY) {
    console.log('  Preparing your CoolCloud instance…');
    return;
  }
  const width = 44;
  let frame = 0;
  let printed = 0;
  process.stdout.write('\x1b[?25l');
  const total = 46;
  for (frame = 0; frame <= total; frame++) {
    const progress = Math.min(100, Math.round((frame / total) * 100));
    const lines = drawFrame(frame, progress, width);
    if (printed) process.stdout.write(`\x1b[${printed}A`);
    for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`);
    printed = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 55));
  }
  process.stdout.write('\x1b[?25h');
}

/* --------------------------------- install ------------------------------- */

function copyTree(source, destination, skipAbsolute) {
  fs.mkdirSync(destination, { recursive: true });
  const skipNames = new Set(['node_modules', 'data', 'instance', '.git', '.freebuff', 'config.json', 'package-lock.json', '.env']);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const src = path.join(source, entry.name);
    const resolvedSrc = path.resolve(src);
    if (skipAbsolute && (resolvedSrc === skipAbsolute || resolvedSrc.startsWith(skipAbsolute + path.sep))) continue;
    // Never copy the destination into itself (installing inside the checkout).
    if (path.resolve(destination).startsWith(resolvedSrc + path.sep)) continue;
    fs.cpSync(src, path.join(destination, entry.name), {
      recursive: true,
      filter: (item) => {
        const relative = path.relative(source, item);
        if (!relative) return true;
        return !relative.split(path.sep).some((part) => skipNames.has(part));
      }
    });
  }
}

async function cmdInstall(opts) {
  const nonInteractive = Boolean(opts.yes) || !process.stdin.isTTY;

  printBanner();
  console.log(`  ${color.bold('Welcome to CoolCloud')}`);
  console.log(color.muted('  Your own cloud: files, calendar, mail, contacts, editor and tasks.'));
  console.log('');

  let dir = String(opts.dir || path.join(os.homedir(), 'coolcloud'));
  if (!nonInteractive) {
    dir = await ask('  Where should CoolCloud live?', dir);
  }
  dir = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (fs.existsSync(path.join(dir, 'config.json'))) {
    console.error(color.red(`\n  ${dir} already contains a CoolCloud instance.`));
    console.error('  Choose another directory or remove the existing config.json.\n');
    process.exit(1);
  }

  let storageMode = 'unlimited';
  let totalGb = null;
  if (opts.storage && opts.storage !== 'unlimited') {
    storageMode = 'limited';
    totalGb = Math.max(1, Number(opts.storage) || 100);
  } else if (!nonInteractive && opts.storage === undefined) {
    const answer = (await ask('  Storage to allow — a size in GB, or u for Unlimited', 'u')).toLowerCase();
    if (answer !== 'u' && answer !== 'unlimited' && Number(answer) > 0) {
      storageMode = 'limited';
      totalGb = Math.max(1, Number(answer));
    }
  }

  let maxUsers = Number(opts.users || 0);
  if (!nonInteractive && !opts.users) {
    const answer = (await ask('  How many accounts may this server hold? Number or u for Unlimited', 'u')).toLowerCase();
    maxUsers = answer === 'u' || answer === 'unlimited' ? 0 : Math.max(1, Number(answer) || 0);
  }

  let orgName = String(opts.org || '').trim();
  let orgDomain = String(opts['org-domain'] || '').trim();
  if (!nonInteractive && !opts.org) {
    console.log('');
    console.log(`  ${color.bold('Organization')}`);
    console.log(color.muted('  Who is this cloud for? It labels the instance and the sign-in screen.'));
    console.log('');
    orgName = await ask('  Organization name', orgName || 'My organization');
    orgDomain = await ask('  Organization domain (optional)', orgDomain);
  }

  const adminUser = String(opts['admin-user'] || 'admin');
  let adminName = String(opts['admin-name'] || 'Administrator');
  let adminEmail = String(opts['admin-email'] || '');
  let adminPass = String(opts['admin-pass'] || process.env.CC_ADMIN_PASSWORD || '');

  if (!nonInteractive) {
    console.log('');
    console.log(`  ${color.bold('The first administrator')}`);
    console.log(color.muted('  You can add everyone else from Admin → Users, or with the CLI.'));
    console.log('');
    const user = await ask('  Admin username', adminUser);
    const name = await ask('  Display name', adminName);
    const email = await ask('  Email (optional)', '');
    adminPass = await askHidden('  Password (8+ characters)');
    const again = await askHidden('  Password again');
    if (adminPass !== again) {
      console.error(color.red('\n  Those passwords do not match. Nothing was installed.\n'));
      process.exit(1);
    }
    Object.assign(opts, { 'admin-user': user, 'admin-name': name, 'admin-email': email });
    adminName = name;
    adminEmail = email;
  }
  if (!adminPass || adminPass.length < 8) {
    console.error(color.red('\n  The admin password must be at least 8 characters.'));
    console.error('  Re-run with --admin-pass=… or run the installer in a terminal.\n');
    process.exit(1);
  }

  let essentials = opts.essentials === 'yes' || opts.essentials === 'y' || opts.essentials === true;
  if (opts.essentials === 'no' || opts.essentials === 'n') essentials = false;
  else if (!nonInteractive && opts.essentials === undefined) {
    console.log('');
    console.log(`  ${color.bold('Extras')}`);
    essentials = await confirm('  Install the Essentials Pack? Connect, Media and Assistant (beta)', false);
  }

  let withCli = opts.cli === 'yes' || opts.cli === true;
  if (opts.cli === 'no' || opts.cli === 'n') withCli = false;
  else if (!nonInteractive && opts.cli === undefined) {
    withCli = await confirm('  Install the optional CLI on this machine?', true);
  }

  let port = Number(opts.port || 8080);
  if (!nonInteractive && !opts.port) port = Number(await ask('  Port for the web interface', String(port))) || 8080;

  if (!nonInteractive) {
    console.log('');
    console.log(`  ${color.bold('Ready to install')}`);
    console.log(`  ${color.muted('Location ')} ${dir}`);
    console.log(`  ${color.muted('Org      ')} ${orgName || 'My organization'}`);
    console.log(`  ${color.muted('Storage  ')} ${storageMode === 'unlimited' ? 'Unlimited' : `${totalGb} GB`}`);
    console.log(`  ${color.muted('Accounts ')} ${maxUsers || 'Unlimited'}`);
    console.log(`  ${color.muted('Admin    ')} ${opts['admin-user'] || adminUser}`);
    console.log(`  ${color.muted('Extras   ')} ${essentials ? 'Essentials Pack' : 'Core apps only'}`);
    console.log(`  ${color.muted('CLI      ')} ${withCli ? 'Installed' : 'Not installed'}`);
    console.log('');
    if (!(await confirm('  Install now?', true))) {
      console.log('\n  Cancelled. Nothing was written.\n');
      return;
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  copyTree(ROOT, dir, path.resolve(dir));

  const { DEFAULT_CONFIG, saveConfig, ensureInstanceDirs, instancePaths } = await import('../server/config.js');
  const { openDb } = await import('../server/db.js');
  const { hashPassword } = await import('../server/auth.js');
  const { syncApps } = await import('../server/apps.js');

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.name = 'CoolCloud';
  cfg.port = port;
  cfg.publicUrl = `http://localhost:${port}`;
  cfg.installPath = dir;
  cfg.installedAt = new Date().toISOString();
  cfg.organization = { name: orgName || 'My organization', domain: orgDomain };
  // A default wordmark for the welcome screen unless one is set later.
  cfg.branding.logoWord = String(opts.word || 'Cloud').slice(0, 12);
  cfg.storage =
    storageMode === 'limited'
      ? { mode: 'limited', totalGb, defaultUserQuotaMb: null }
      : { mode: 'unlimited', totalGb: null, defaultUserQuotaMb: null };
  cfg.limits = { maxUsers: maxUsers || 0 };
  cfg.apps.essentialsInstalled = essentials;
  cfg.features.connect = essentials;
  cfg.features.media = essentials;
  cfg.features.assistant = essentials;

  const configPath = path.join(dir, 'config.json');
  saveConfig(configPath, cfg);
  const paths = instancePaths(configPath);
  ensureInstanceDirs(paths);
  const db = openDb(paths.dataDir);

  db.prepare(
    'INSERT INTO users (username, display_name, email, pass_hash, role, quota_mb, prefs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(adminUser.toLowerCase(), adminName, adminEmail, hashPassword(adminPass), 'admin', null, '{}', new Date().toISOString());

  const appDir = path.join(dir, 'apps');
  syncApps(db, fs.existsSync(appDir) ? appDir : path.join(ROOT, 'apps'), paths.appsDir, cfg);

  // starter folders
  for (const folder of ['Documents', 'Projects', 'Media']) {
    fs.mkdirSync(path.join(paths.filesDir, folder), { recursive: true });
  }
  fs.writeFileSync(
    path.join(paths.filesDir, 'Documents', 'welcome.md'),
    `# Welcome to CoolCloud\n\nThis file lives on your server in ${paths.filesDir}.\n\n- **Files** is the shared drive for everyone on this instance.\n- **Editor** opens anything text, and office documents open in your connected office server.\n- **Tasks**, **Calendar** and **Contacts** are per-account.\n- **Mail** connects to your own SMTP and IMAP servers.\n\nAdmins can install more apps from Admin → App Store.\n`
  );

  // launchers
  const shLauncher = path.join(dir, 'coolcloud');
  fs.writeFileSync(
    shLauncher,
    `#!/usr/bin/env bash\ncd "$(dirname "$0")" && exec node bin/coolcloud.js "$@"\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dir, 'coolcloud.cmd'),
    `@echo off\r\ncd /d "%~dp0"\r\nnode "bin\\coolcloud.js" %*\r\n`
  );
  fs.writeFileSync(
    path.join(dir, 'start.sh'),
    `#!/usr/bin/env bash\ncd "$(dirname "$0")" && exec node bin/coolcloud.js --start\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(dir, 'start.cmd'), `@echo off\r\ncd /d "%~dp0"\r\nnode "bin\\coolcloud.js" --start\r\n`);

  // optional CLI
  if (withCli) {
    installCli(dir);
  }

  await playAnimation();

  const cleanup = nonInteractive ? true : await confirm('  Delete unnecessary setup files (RECOMMENDED)', true);

  console.log('');
  console.log(`  ${color.bold(color.teal('Welcome to CoolCloud'))}`);
  console.log('');
  console.log(`  ${cleanup ? color.teal('[x]') : '[ ]'} Delete unnecessary setup files ${color.muted('(RECOMMENDED)')}`);
  console.log(`  ${'[ ]'} Start CoolCloud now ${color.muted('(OPTIONAL)')}`);
  console.log('');
  console.log(`  ${color.muted('Instance ')} ${dir}`);
  console.log(`  ${color.muted('Org      ')} ${cfg.organization.name}`);
  console.log(`  ${color.muted('Open     ')} http://localhost:${port}`);
  console.log(`  ${color.muted('Sign in  ')} ${opts['admin-user'] || adminUser} / your password`);
  console.log(`  ${color.muted('Start    ')} cd ${dir} && ${process.platform === 'win32' ? 'start.cmd' : './start.sh'}`);
  if (withCli) console.log(`  ${color.muted('CLI      ')} coolcloud --login`);
  console.log('');

  if (cleanup) {
    fs.rmSync(path.join(dir, 'scripts'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, '.setup.json'), { force: true });
    if (!withCli) fs.rmSync(path.join(dir, 'cc-cli'), { recursive: true, force: true });
  }

  const startNow = nonInteractive ? opts.start === 'yes' || opts.start === true : await confirm('  Start CoolCloud now?', false);
  if (startNow) {
    console.log(color.muted('\n  Starting…'));
    await startServer(dir);
  } else {
    closeRl();
    console.log(color.muted('  When you are ready: ') + `cd ${dir} && ${process.platform === 'win32' ? 'start.cmd' : './start.sh'}`);
    console.log('');
  }
}

function installCli(instanceDir) {
  const cliSource = path.join(instanceDir, 'cc-cli', 'coolcloud.py');
  if (!fs.existsSync(cliSource)) return;
  if (process.platform === 'win32') {
    const binDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CoolCloud');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'coolcloud.cmd'),
      `@echo off\r\npython "${cliSource}" %*\r\n`
    );
    console.log(color.muted(`  CLI launcher written to ${path.join(binDir, 'coolcloud.cmd')}`));
    console.log(color.muted('  Add that folder to PATH to run "coolcloud" from anywhere.'));
  } else {
    const localBin = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    const target = path.join(localBin, 'coolcloud');
    fs.writeFileSync(target, `#!/usr/bin/env bash\nexec python3 "${cliSource}" "$@"\n`, { mode: 0o755 });
    console.log(color.muted(`  CLI launcher written to ${target}`));
  }
}

/* ---------------------------------- start -------------------------------- */

function resolveConfigPath(opts) {
  if (opts.configPath) return path.resolve(opts.configPath);
  if (process.env.CC_CONFIG) return path.resolve(process.env.CC_CONFIG);
  if (opts.dir) return path.join(path.resolve(opts.dir), 'config.json');
  return path.join(process.cwd(), 'config.json');
}

async function startServer(dirOrUndefined) {
  const base = dirOrUndefined ? path.resolve(dirOrUndefined) : process.cwd();
  const configPath = path.join(base, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(color.red(`\n  No config.json in ${base}`));
    console.error('  Run the installer first: coolcloud --install\n');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const serverFile = path.join(base, 'server', 'index.js');
  const child = spawn(process.execPath, [serverFile], {
    cwd: base,
    env: { ...process.env, CC_CONFIG: configPath },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  const url = `http://localhost:${cfg.port || 8080}`;
  process.stdout.write(color.muted('  Waiting for CoolCloud'));
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(color.muted('.'));
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) {
        process.stdout.write('\n');
        console.log(color.teal(`\n  CoolCloud is running at ${url}\n`));
        return;
      }
    } catch {
      /* keep waiting */
    }
  }
  process.stdout.write('\n');
  console.error(color.amber(`  CoolCloud did not answer at ${url}. Check data/logs/error.log.`));
}

/* -------------------------------- remote CLI ------------------------------ */

function loadCliConfig() {
  try {
    return JSON.parse(fs.readFileSync(HOME_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function saveCliConfig(data) {
  fs.mkdirSync(path.dirname(HOME_CONFIG), { recursive: true });
  fs.writeFileSync(HOME_CONFIG, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function remote(config, endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`${config.server}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `Request failed (${response.status})`);
  }
  return data;
}

async function cmdLogin(opts) {
  printBanner();
  const saved = loadCliConfig();
  const server = String(opts.server || (await ask('  Server URL', saved?.server || 'http://localhost:8080'))).replace(/\/+$/, '');
  const username = String(opts.user || (await ask('  Username', saved?.user?.username || '')));
  const password = String(opts.password || (await askHidden('  Password')));
  if (!username || !password) {
    console.error(color.red('\n  Username and password are required.\n'));
    process.exit(1);
  }
  const response = await fetch(`${server}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15000)
  }).catch(() => null);
  if (!response) {
    console.error(color.red(`\n  Cannot reach ${server}. Is the server running?\n`));
    process.exit(1);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(color.red(`\n  ${data.error || 'Sign in failed'}\n`));
    process.exit(1);
  }
  saveCliConfig({ server, token: data.token, user: data.user, savedAt: new Date().toISOString() });
  closeRl();
  console.log('');
  console.log(`  ${color.green('Signed in')} as ${color.bold(data.user.name || data.user.username)} (${data.user.role})`);
  console.log(`  Server: ${server}`);
  console.log(color.muted('\n  Try: coolcloud --status   or   coolcloud --install dev:app\n'));
}

function requireCliConfig() {
  const config = loadCliConfig();
  if (!config?.token) {
    console.error(color.red('\n  This CLI is not signed in. Run: coolcloud --login\n'));
    process.exit(1);
  }
  return config;
}

function formatTable(rows, headers) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)));
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ');
  console.log(`  ${color.muted(line(headers))}`);
  console.log(`  ${color.muted(widths.map((width) => '─'.repeat(width)).join('  '))}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

async function cmdStatus(opts) {
  const config = requireCliConfig();
  try {
    if (config.user?.role === 'admin') {
      const data = await remote(config, '/api/admin/overview');
      console.log('');
      console.log(`  ${color.bold(data.server.name)} · ${config.server}`);
      console.log('');
      console.log(`  ${color.muted('Users     ')} ${data.counts.users} (${data.counts.admins} admin)`);
      console.log(`  ${color.muted('Sessions  ')} ${data.counts.sessions}`);
      console.log(`  ${color.muted('Storage   ')} ${humanBytes(data.storage.used)} / ${data.storage.limit ? humanBytes(data.storage.limit) : 'unlimited'}`);
      console.log(`  ${color.muted('Uptime    ')} ${Math.floor(data.server.uptime / 60)} min`);
      console.log(`  ${color.muted('Node      ')} ${data.server.node} on ${data.server.platform}`);
      console.log(`  ${color.muted('Apps      ')} ${data.counts.enabledApps} enabled of ${data.counts.apps}`);
      console.log('');
      return;
    }
    const session = await remote(config, '/api/auth/session');
    console.log(`\n  ${color.bold(session.user.name)} · ${config.server}\n`);
    console.log(`  ${color.muted('Role  ')} ${session.user.role}`);
    console.log(`  ${color.muted('Apps  ')} ${session.apps.map((app) => app.name).join(', ')}\n`);
  } catch (err) {
    console.error(color.red(`\n  ${err.message}\n`));
    process.exit(1);
  }
}

async function cmdInstallApp(opts) {
  const reference = typeof opts.install === 'string' ? opts.install : opts._[0];
  const config = requireCliConfig();
  const type = String(opts.type || '').toLowerCase() === 'widget' ? 'widget' : '';
  if (!reference) {
    console.error('\n  Usage: coolcloud --install developer:app [dir=./folder] [!type=widget]\n');
    process.exit(1);
  }
  if (config.user?.role !== 'admin') {
    console.error(color.red('\n  Only administrators can install apps.\n'));
    process.exit(1);
  }
  try {
    const installed = await remote(config, '/api/admin/apps');
    const found = installed.apps.find((app) => app.id === reference || app.id === `cc:${reference}`);
    const result = opts.dir
      ? await remote(config, '/api/admin/apps/install', {
          method: 'POST',
          body: { dir: path.resolve(String(opts.dir)), type }
        })
      : found
      ? { app: found, already: true }
      : await remote(config, '/api/admin/store/install', { method: 'POST', body: { id: reference, type } });
    if (result.already) {
      console.log(`\n  ${color.amber(result.app.name)} is already installed${result.app.builtin ? ' (core app)' : ''}.\n`);
    } else {
      const label = result.app.type === 'widget' ? 'widget' : 'app';
      console.log(`\n  ${color.green('Installed')} ${color.bold(result.app.name)} ${color.muted(`(${label})`)} (${result.app.id})\n`);
    }
  } catch (err) {
    console.error(color.red(`\n  ${err.message}\n`));
    if (/registry/i.test(err.message)) {
      console.error(color.muted('  Add the app’s registry in Admin → App Store, or install from a folder with dir=…\n'));
    }
    process.exit(1);
  }
}

async function cmdConfig(opts) {
  const sub = typeof opts.config === 'string' ? opts.config : 'show';
  const configPath = resolveConfigPath(opts);
  if (sub === 'path') {
    console.log(configPath);
    return;
  }
  if (!fs.existsSync(configPath)) {
    console.error(color.red(`\n  No config.json at ${configPath}`));
    console.error(color.muted('  Run this inside an instance, or pass --dir=/path/to/instance.\n'));
    process.exit(1);
  }
  if (sub === 'show') {
    console.log(fs.readFileSync(configPath, 'utf8'));
    return;
  }
  if (sub === 'edit') {
    const { editor, ok } = runEditor(configPath, opts._[0]);
    console.log(color.muted(`  Edited with ${editor}${ok ? '' : ' (exit code was non-zero)'}`));
    return;
  }
  console.error(`\n  Unknown config action "${sub}". Try: show, edit, path\n`);
  process.exit(1);
}

async function cmdUsers(opts) {
  const config = requireCliConfig();
  if (config.user?.role !== 'admin') {
    console.error(color.red('\n  Administrator access required.\n'));
    process.exit(1);
  }
  const sub = typeof opts.users === 'string' ? opts.users : 'list';
  const arg = opts._[0];
  try {
    if (sub === 'list') {
      const data = await remote(config, '/api/admin/users');
      if (!data.users.length) return console.log('\n  No users yet.\n');
      formatTable(
        data.users.map((user) => [user.username, user.name, user.role, user.active ? 'yes' : 'no', user.sessions]),
        ['USERNAME', 'NAME', 'ROLE', 'ACTIVE', 'SESSIONS']
      );
      console.log('');
      return;
    }
    if (sub === 'add') {
      if (!arg) throw new Error('Usage: coolcloud --users add <username> password=… name="…"');
      const password = String(opts.password || (await askHidden('  Password for the new account')));
      await remote(config, '/api/admin/users', {
        method: 'POST',
        body: {
          username: arg,
          password,
          name: opts.name || arg,
          email: opts.email || '',
          role: opts.role === 'admin' ? 'admin' : 'user',
          quotaMb: opts.quota ? Number(opts.quota) : null
        }
      });
      console.log(`\n  ${color.green('Created')} ${arg}${opts.role === 'admin' ? ' as administrator' : ''}\n`);
      return;
    }
    const users = (await remote(config, '/api/admin/users')).users;
    const target = users.find((user) => user.username.toLowerCase() === String(arg || '').toLowerCase());
    if (!target) throw new Error(`No account named "${arg || ''}"`);
    if (sub === 'remove') {
      await remote(config, `/api/admin/users/${target.id}`, { method: 'DELETE' });
      console.log(`\n  ${color.green('Removed')} ${target.username}\n`);
      return;
    }
    if (sub === 'passwd') {
      const password = String(opts.password || (await askHidden(`  New password for ${target.username}`)));
      await remote(config, `/api/admin/users/${target.id}`, { method: 'PATCH', body: { password } });
      console.log(`\n  ${color.green('Password changed')} for ${target.username}. Their sessions were revoked.\n`);
      return;
    }
    if (sub === 'disable' || sub === 'enable') {
      await remote(config, `/api/admin/users/${target.id}`, { method: 'PATCH', body: { active: sub === 'enable' } });
      console.log(`\n  ${target.username} ${sub}d.\n`);
      return;
    }
    throw new Error('Usage: coolcloud --users list|add|remove|passwd|disable|enable');
  } catch (err) {
    console.error(color.red(`\n  ${err.message}\n`));
    process.exit(1);
  }
}

async function cmdDoc(opts) {
  const config = requireCliConfig();
  const sub = typeof opts.doc === 'string' ? opts.doc : 'list';
  const target = opts._[0];
  try {
    if (sub === 'list') {
      const data = await remote(config, `/api/files?path=${encodeURIComponent(opts._[0] || '')}`);
      console.log('');
      if (!data.entries.length) console.log(color.muted('  (empty folder)'));
      for (const entry of data.entries) {
        console.log(`  ${entry.dir ? '▸' : '·'} ${entry.path}${entry.dir ? '/' : ''}`);
      }
      console.log('');
      return;
    }
    if (!target) throw new Error('Usage: coolcloud --doc new|edit|cat|rm <path>');
    if (sub === 'new') {
      await remote(config, '/api/files/text', { method: 'PUT', body: { path: target, content: '' } });
      console.log(`\n  ${color.green('Created')} ${target}\n`);
      return;
    }
    if (sub === 'cat') {
      const file = await remote(config, `/api/files/text?path=${encodeURIComponent(target)}`);
      console.log(file.content);
      return;
    }
    if (sub === 'rm') {
      await remote(config, `/api/files?path=${encodeURIComponent(target)}`, { method: 'DELETE' });
      console.log(`\n  ${color.green('Deleted')} ${target}\n`);
      return;
    }
    if (sub === 'edit') {
      const file = await remote(config, `/api/files/text?path=${encodeURIComponent(target)}`);
      const temp = path.join(os.tmpdir(), `coolcloud-${path.basename(target)}`);
      fs.writeFileSync(temp, file.content, 'utf8');
      const { editor, ok } = runEditor(temp, opts.editor);
      if (!ok) {
        console.log(color.amber(`\n  ${editor} exited with an error; nothing uploaded.\n`));
        return;
      }
      const content = fs.readFileSync(temp, 'utf8');
      fs.rmSync(temp, { force: true });
      if (content === file.content) {
        console.log(color.muted('\n  No changes.\n'));
        return;
      }
      await remote(config, '/api/files/text', { method: 'PUT', body: { path: target, content } });
      console.log(`\n  ${color.green('Saved')} ${target}\n`);
      return;
    }
    throw new Error('Usage: coolcloud --doc new|edit|cat|rm <path>');
  } catch (err) {
    console.error(color.red(`\n  ${err.message}\n`));
    process.exit(1);
  }
}

/* ---------------------------------- help --------------------------------- */

function printHelp() {
  printBanner();
  console.log(`  ${color.bold('CoolCloud')} ${color.muted(`v${VERSION}`)} — self-hosted collaboration suite\n`);
  console.log(`  ${color.bold('Install and run')}`);
  console.log('    coolcloud --install                 Set up a new instance in this computer');
  console.log('    coolcloud --start                   Start the instance in the current folder');
      console.log('    coolcloud --install dev:app         Install an app from a configured registry');
    console.log('    coolcloud --install dev:app dir=.   Install an app from a folder');
    console.log('    coolcloud --install dev:app !type=widget   Install it as a home widget');
  console.log('');
  console.log(`  ${color.bold('Remote server')}`);
  console.log('    coolcloud --login                   Sign this CLI in to a server');
  console.log('    coolcloud --status                  Server health and your account');
  console.log('    coolcloud --logout                  Forget the saved session');
  console.log('');
  console.log(`  ${color.bold('Accounts (admin)')}`);
  console.log('    coolcloud --users list');
  console.log('    coolcloud --users add sam password=… name="Sam Lee" role=admin');
  console.log('    coolcloud --users passwd sam');
  console.log('    coolcloud --users disable sam');
  console.log('    coolcloud --users remove sam');
  console.log('');
  console.log(`  ${color.bold('Documents')}`);
  console.log('    coolcloud --doc list [folder]       List Files');
  console.log('    coolcloud --doc new notes.md        Create a document');
  console.log('    coolcloud --doc edit notes.md       Edit with nano, vim or notepad');
  console.log('    coolcloud --doc cat notes.md');
  console.log('    coolcloud --doc rm notes.md');
  console.log('');
  console.log(`  ${color.bold('Configuration')}`);
  console.log('    coolcloud --config edit [editor]    Open config.json in your editor');
  console.log('    coolcloud --config show');
  console.log('    coolcloud --config path');
  console.log('');
  console.log(`  ${color.bold('Options')}`);
  console.log('    --dir=<path>       Point a command at an instance folder');
  console.log('    --server=<url>     Server for --login');
      console.log('    --yes              Non-interactive install (use with flags)');
    console.log('    --org="Acme"       Organization name during --install');
  console.log('    --help, --version');
  console.log('');
  console.log(`  ${color.muted('Docs: docs/CLI.txt, docs/HOSTING.txt, docs/BUILDING-APPS.txt')}`);
  console.log('');
}

function parseArgs(args) {
  const opts = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('!')) {
      // "!type=widget" style modifiers for --install.
      const [key, ...rest] = arg.slice(1).split('=');
      if (key) opts[key] = rest.length ? rest.join('=') : true;
    } else if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      if (rest.length) opts[key] = rest.join('=');
      else if (args[index + 1] && !args[index + 1].startsWith('--') && !args[index + 1].includes('=')) {
        opts[key] = args[++index];
      } else opts[key] = true;
    } else if (arg.includes('=') && !arg.startsWith('=')) {
      const [key, ...rest] = arg.split('=');
      opts[key] = rest.join('=');
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.version || opts.v) {
    console.log(VERSION);
    return;
  }
  if (opts.help || opts.h || (!process.argv.slice(2).length && !process.stdin.isTTY)) {
    printHelp();
    return;
  }
  if (opts.logout) {
    fs.rmSync(HOME_CONFIG, { force: true });
    console.log(color.muted('  CLI session cleared.'));
    return;
  }
  if (opts.install !== undefined) {
    if (typeof opts.install === 'string') return cmdInstallApp(opts);
    return cmdInstall(opts);
  }
  if (opts.start) return startServer(opts.dir);
  if (opts.login) return cmdLogin(opts);
  if (opts.status) return cmdStatus(opts);
  if (opts.config !== undefined) return cmdConfig(opts);
  if (opts.users !== undefined) return cmdUsers(opts);
  if (opts.doc !== undefined) return cmdDoc(opts);
  if (!process.argv.slice(2).length) return printHelp();

  console.error(color.red(`\n  Unknown command: ${process.argv.slice(2).join(' ')}`));
  console.error(color.muted('  Run coolcloud --help for the list.\n'));
  process.exit(1);
}

main()
  .catch((err) => {
    console.error(color.red(`\n  ${err.message}\n`));
    process.exit(1);
  })
  .finally(() => closeRl());
