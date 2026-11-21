import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowISO } from './util.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  quota_mb INTEGER,
  prefs TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar TEXT NOT NULL DEFAULT 'Personal',
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'teal',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  list TEXT NOT NULL DEFAULT 'Inbox',
  done INTEGER NOT NULL DEFAULT 0,
  due TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS mail_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_addr TEXT NOT NULL DEFAULT '',
  cc_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  smtp TEXT NOT NULL DEFAULT '{}',
  imap TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS connect_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  sender_id INTEGER NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  developer TEXT NOT NULL DEFAULT 'cc',
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'fa-solid fa-cube',
  accent TEXT NOT NULL DEFAULT 'teal',
  source TEXT NOT NULL DEFAULT 'repo',
  dir TEXT NOT NULL DEFAULT '',
  entry TEXT NOT NULL DEFAULT 'web/index.html',
  type TEXT NOT NULL DEFAULT 'app',
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registries (
  url TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'notice',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_meta (
  path TEXT PRIMARY KEY,
  owner_id INTEGER,
  favorite INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_path TEXT NOT NULL,
  trash_name TEXT NOT NULL UNIQUE,
  owner_id INTEGER,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  password_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  allow_upload INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  match TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_storage (
  app_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, user_id, key)
);

CREATE TABLE IF NOT EXISTS app_grants (
  app_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  granted_at TEXT NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS file_acl (
  path TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_acl_users (
  path TEXT NOT NULL REFERENCES file_acl(path) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_write INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'viewer',
  expires_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (path, user_id)
);

CREATE TABLE IF NOT EXISTS file_acl_teams (
  path TEXT NOT NULL REFERENCES file_acl(path) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  can_write INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'viewer',
  expires_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (path, team_id)
);

CREATE TABLE IF NOT EXISTS file_acl_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  temp TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  expected INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_index (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS totp (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  backup_codes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_logins (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mail_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_addr TEXT NOT NULL DEFAULT '',
  cc_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(path UNINDEXED, name, body);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_events_owner_start ON events(owner_id, start_at);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_connect_room ON connect_messages(room, id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, id);
CREATE INDEX IF NOT EXISTS idx_file_meta_owner ON file_meta(owner_id);
CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash(deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path, id);
CREATE INDEX IF NOT EXISTS idx_rules_owner ON rules(owner_id, enabled);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_user ON mail_drafts(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_file_acl_owner ON file_acl(owner_id);
CREATE INDEX IF NOT EXISTS idx_file_acl_requests_path ON file_acl_requests(path, status);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'));
  db.exec(SCHEMA);
  // Instances created before widgets existed get the column added in place.
  try {
    const columns = db.prepare('PRAGMA table_info(apps)').all().map((column) => column.name);
    if (!columns.includes('type')) db.exec("ALTER TABLE apps ADD COLUMN type TEXT NOT NULL DEFAULT 'app'");
  } catch {
    /* an old driver without table_info keeps working without widgets */
  }
  migrate(db);
  return db;
}

function ensureColumn(db, table, name, definition) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  } catch {
    /* an old driver keeps working without the new column */
  }
}

/** In-place additions for 1.x instances. Never drop or rewrite existing data. */
function migrate(db) {
  ensureColumn(db, 'tasks', 'recurrence', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'tasks', 'parent_id', 'INTEGER');
  ensureColumn(db, 'tasks', 'tags', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'events', 'recurrence', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'events', 'reminder_min', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'events', 'reminder_sent', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'events', 'attendees', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'events', 'uid', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'mail_sent', 'attachments', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'apps', 'permissions', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'apps', 'manifest_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'apps', 'signed_by', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'file_acl_users', 'role', "TEXT NOT NULL DEFAULT 'viewer'");
  ensureColumn(db, 'file_acl_users', 'expires_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'file_acl_teams', 'role', "TEXT NOT NULL DEFAULT 'viewer'");
  ensureColumn(db, 'file_acl_teams', 'expires_at', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE file_acl_users SET role = 'editor' WHERE can_write = 1 AND role = 'viewer'");
  db.exec("UPDATE file_acl_teams SET role = 'editor' WHERE can_write = 1 AND role = 'viewer'");
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_uid ON events(uid)');
  } catch {
    /* indexes are an optimization */
  }
}

export function audit(db, actorId, action, detail = '', ip = '') {
  try {
    db.prepare('INSERT INTO audit (actor_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)').run(
      actorId || null,
      action,
      String(detail).slice(0, 2000),
      ip || '',
      nowISO()
    );
  } catch {
    /* auditing must never break a request */
  }
}

export function getPreference(db, userId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM preferences WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setPreference(db, userId, key, value) {
  db.prepare(
    'INSERT INTO preferences (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value'
  ).run(userId, key, JSON.stringify(value));
}

/** Queue an in-app Activity entry for one account. */
export function notify(db, userId, { kind = 'notice', title, body = '', link = '', actorId = null } = {}) {
  try {
    db.prepare(
      'INSERT INTO notifications (user_id, actor_id, kind, title, body, link, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(
      Number(userId),
      actorId ? Number(actorId) : null,
      String(kind).slice(0, 24),
      String(title || 'Notice').slice(0, 160),
      String(body || '').slice(0, 600),
      String(link || '').slice(0, 300),
      nowISO()
    );
  } catch {
    /* notifications must never break a request */
  }
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
