import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bearerToken, hashPassword, hashToken, requireUser } from '../auth.js';
import { getPreference, notify, setPreference } from '../db.js';
import { ipOf, sendJson } from '../http.js';
import { attachWebSocket } from '../ws.js';
import { listApps } from '../apps.js';
import { IMAGE_EXT, VIDEO_EXT, extOf, fileKind, isTextName, nowISO, relFrom, safeJoin, walkFiles } from '../util.js';
import { attachLog } from '../log.js';
import { searchIndexed } from '../storage.js';
import { visiblePath } from '../access.js';

const weatherCache = new Map();

function textSnippet(file, needle) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512 * 1024) return '';
    const text = fs.readFileSync(file, 'utf8');
    const index = text.toLowerCase().indexOf(needle);
    if (index === -1) return '';
    const start = Math.max(0, index - 60);
    return text.slice(start, index + needle.length + 90).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function safeRoom(value) {
  const room = String(value || 'general').replace(/[^\w\- ]/g, '').trim().slice(0, 40);
  return room || 'general';
}

/** Direct messages are rooms named dm-<lowId>-<highId>. */
function dmMembers(room) {
  const match = /^dm-(\d+)-(\d+)$/.exec(room);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function canUseRoom(room, userId) {
  const pair = dmMembers(room);
  return !pair || pair.includes(Number(userId));
}

/** Readable temporary password for an account created from an invite. */
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (const byte of randomBytes(9)) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 3)}-${out.slice(3, 6)}-${out.slice(6)}`;
}

export function registerExtras(router) {
  /* ------------------------------- bootstrap ------------------------------ */
  router.get('/api/apps', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, { apps: listApps(ctx.db) });
  });

  router.get('/api/editor', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, {
      text: true,
      provider: ctx.cfg.editor?.officeProvider || 'none',
      url: ctx.cfg.editor?.officeUrl || '',
      container: ctx.cfg.editor?.officeContainer || 'coolcloud-office'
    });
  });

  /* -------------------------------- search -------------------------------- */
  router.get('/api/search', async (ctx) => {
    const user = requireUser(ctx);
    const q = String(ctx.query.get('q') || '').trim();
    const scope = String(ctx.query.get('scope') || 'all');
    if (q.length < 2) return sendJson(ctx.res, 200, { query: q, files: [], system: [], people: [], events: [], tasks: [], apps: [] });
    const needle = q.toLowerCase();

    const files = [];
    const seenFiles = new Set();
    if (scope === 'all' || scope === 'files') {
      for (const hit of searchIndexed(ctx.db, q, 40)) {
        if (files.length >= 40) break;
        if (seenFiles.has(hit.path)) continue;
        if (!visiblePath(ctx.db, user, hit.path)) continue;
        seenFiles.add(hit.path);
        files.push({ name: hit.name, path: hit.path, kind: fileKind(hit.name), hit: 'content', snippet: hit.snippet });
      }
      const all = walkFiles(ctx.paths.filesDir, { maxFiles: 5000 });
      for (const full of all) {
        if (files.length >= 40) break;
        const name = path.basename(full);
        if (name.startsWith('.')) continue;
        const rel = relFrom(ctx.paths.filesDir, full);
        if (seenFiles.has(rel)) continue;
        if (!visiblePath(ctx.db, user, rel)) continue;
        if (name.toLowerCase().includes(needle) || rel.toLowerCase().includes(needle)) {
          seenFiles.add(rel);
          files.push({ name, path: rel, kind: fileKind(name), hit: 'name' });
          continue;
        }
        if (isTextName(name)) {
          const snippet = textSnippet(full, needle);
          if (snippet) {
            seenFiles.add(rel);
            files.push({ name, path: rel, kind: fileKind(name), hit: 'content', snippet });
          }
        }
      }
    }

    const tags = [];
    if (scope === 'all' || scope === 'files' || scope === 'tags') {
      const rows = ctx.db.prepare('SELECT path, tags FROM file_meta WHERE lower(tags) LIKE ? LIMIT 20').all(`%${needle}%`);
      for (const row of rows) {
        if (seenFiles.has(row.path)) continue;
        const name = path.basename(row.path);
        tags.push({ name, path: row.path, kind: fileKind(name), tags: row.tags });
      }
    }

    const mail = [];
    if (scope === 'all' || scope === 'mail') {
      const rows = ctx.db
        .prepare("SELECT id, subject, to_addr, body, sent_at, status FROM mail_sent WHERE user_id = ? AND (lower(subject) LIKE ? OR lower(body) LIKE ? OR lower(to_addr) LIKE ?) ORDER BY id DESC LIMIT 10")
        .all(user.id, `%${needle}%`, `%${needle}%`, `%${needle}%`);
      for (const row of rows) mail.push({ id: row.id, subject: row.subject, to: row.to_addr, status: row.status, sentAt: row.sent_at });
    }

    const people = [];
    if (scope === 'all' || scope === 'people') {
      const rows = ctx.db
        .prepare(
          "SELECT * FROM contacts WHERE owner_id = ? AND (lower(first_name || ' ' || last_name) LIKE ? OR lower(email) LIKE ? OR lower(organization) LIKE ?) LIMIT 8"
        )
        .all(user.id, `%${needle}%`, `%${needle}%`, `%${needle}%`);
      for (const row of rows) people.push({ id: row.id, name: `${row.first_name} ${row.last_name}`.trim(), email: row.email, organization: row.organization });
    }

    const events = [];
    if (scope === 'all' || scope === 'calendar') {
      const rows = ctx.db
        .prepare("SELECT * FROM events WHERE owner_id = ? AND (lower(title) LIKE ? OR lower(notes) LIKE ?) ORDER BY start_at DESC LIMIT 8")
        .all(user.id, `%${needle}%`, `%${needle}%`);
      for (const row of rows) events.push({ id: row.id, title: row.title, start: row.start_at, color: row.color });
    }

    const tasks = [];
    if (scope === 'all' || scope === 'tasks') {
      const rows = ctx.db
        .prepare("SELECT * FROM tasks WHERE owner_id = ? AND lower(title) LIKE ? ORDER BY done ASC LIMIT 8")
        .all(user.id, `%${needle}%`);
      for (const row of rows) tasks.push({ id: row.id, title: row.title, done: Boolean(row.done), due: row.due });
    }

    const system = [];
    if (user.role === 'admin' && (scope === 'all' || scope === 'system')) {
      const skip = new Set(['node_modules', '.git', 'data', 'vendor', '.freebuff']);
      const candidates = walkFiles(ctx.bundleRoot, { maxFiles: 2500, maxDepth: 6, skipDirs: skip, filter: (full, name) => isTextName(name) || name.endsWith('.json') || name === 'Dockerfile' });
      for (const full of candidates) {
        if (system.length >= 20) break;
        const name = path.basename(full);
        const rel = relFrom(ctx.bundleRoot, full);
        if (name.toLowerCase().includes(needle) || rel.toLowerCase().includes(needle)) {
          system.push({ name, path: rel, root: 'bundle', kind: "system", gl: 'server' });
          continue;
        }
        const snippet = textSnippet(full, needle);
        if (snippet) system.push({ name, path: rel, root: 'bundle', kind: 'system', snippet });
      }
      for (const candidate of ['config.json']) {
        const full = path.join(ctx.paths.root, candidate);
        if (!fs.existsSync(full)) continue;
        if (candidate.includes(needle) || textSnippet(full, needle)) {
          system.push({ name: candidate, path: candidate, root: 'instance', kind: 'config' });
        }
      }
    }

    const apps = [];
    if (scope === 'all') {
      const rows = ctx.db.prepare('SELECT * FROM apps WHERE enabled = 1').all();
      for (const row of rows) {
        if (row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)) {
          apps.push({ id: row.id, name: row.name, icon: row.icon });
        }
      }
    }

    sendJson(ctx.res, 200, { query: q, files, tags, system, people, events, tasks, mail, apps, isAdmin: user.role === 'admin' });
  });

  /* ------------------------------- dashboard ------------------------------ */
  router.get('/api/dashboard', async (ctx) => {
    const user = requireUser(ctx);
    const files = walkFiles(ctx.paths.filesDir, { maxFiles: 2500 });
    const withStat = files
      .filter((full) => !full.includes(`${path.sep}.cc-history${path.sep}`))
      .filter((full) => visiblePath(ctx.db, user, relFrom(ctx.paths.filesDir, full)))
      .map((full) => {
        try {
          const stat = fs.statSync(full);
          return { full, name: path.basename(full), size: stat.size, mtime: stat.mtime, kind: fileKind(path.basename(full)) };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const today = ctx.db
      .prepare('SELECT * FROM events WHERE owner_id = ? AND start_at < ? AND end_at >= ? ORDER BY start_at ASC LIMIT 6')
      .all(user.id, dayEnd.toISOString(), dayStart.toISOString());

    const openTasks = ctx.db
      .prepare("SELECT * FROM tasks WHERE owner_id = ? AND done = 0 ORDER BY due IS NULL, due ASC LIMIT 6")
      .all(user.id);
    const taskCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND done = 0').get(user.id).n;
    const sentCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM mail_sent WHERE user_id = ?').get(user.id).n;
    const mailRow = ctx.db.prepare('SELECT smtp FROM mail_accounts WHERE user_id = ?').get(user.id);
    let mailConfigured = false;
    try {
      mailConfigured = Boolean(JSON.parse(mailRow?.smtp || '{}').host);
    } catch {
      mailConfigured = false;
    }

    const media = withStat.filter((item) => item.kind === 'image' || item.kind === 'video').slice(0, 10);
    sendJson(ctx.res, 200, {
      recentFiles: withStat.slice(0, 7).map((item) => ({
        name: item.name,
        path: relFrom(ctx.paths.filesDir, item.full),
        kind: item.kind,
        size: item.size,
        mtime: item.mtime.toISOString()
      })),
      media: media.map((item) => ({
        name: item.name,
        path: relFrom(ctx.paths.filesDir, item.full),
        kind: item.kind
      })),
      today: today.map((row) => ({ id: row.id, title: row.title, start: row.start_at, end: row.end_at, allDay: Boolean(row.all_day), color: row.color, location: row.location })),
      tasks: openTasks.map((row) => ({ id: row.id, title: row.title, due: row.due, priority: row.priority, list: row.list })),
      counts: {
        files: withStat.length,
        media: withStat.filter((item) => item.kind === 'image' || item.kind === 'video').length,
        tasksOpen: taskCount,
        sent: sentCount,
        contacts: ctx.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE owner_id = ?').get(user.id).n,
        users: ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n
      },
      mail: { configured: mailConfigured, sent: sentCount },
      storage: {
        mode: ctx.cfg.storage.mode,
        totalGb: ctx.cfg.storage.totalGb,
        bytes: withStat.reduce((sum, item) => sum + item.size, 0)
      },
      now: nowISO()
    });
  });

  /* -------------------------------- weather ------------------------------- */
  router.get('/api/weather', async (ctx) => {
    requireUser(ctx);
    const lat = Number(ctx.query.get('lat'));
    const lon = Number(ctx.query.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJson(ctx.res, 400, { error: 'Coordinates required' });
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return sendJson(ctx.res, 200, cached.data);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const data = {
        temperature: json.current?.temperature_2m ?? null,
        code: json.current?.weather_code ?? null,
        wind: json.current?.wind_speed_10m ?? null,
        high: json.daily?.temperature_2m_max?.[0] ?? null,
        low: json.daily?.temperature_2m_min?.[0] ?? null,
        units: json.current_units?.temperature_2m || '°C'
      };
      weatherCache.set(key, { at: Date.now(), data });
      sendJson(ctx.res, 200, data);
    } catch (err) {
      attachLog(ctx.paths, `weather lookup failed: ${err.message}`);
      sendJson(ctx.res, 200, { unavailable: true });
    }
  });

  /* --------------------------------- media -------------------------------- */
  router.get('/api/media', async (ctx) => {
    const user = requireUser(ctx);
    const limit = Math.min(300, Number(ctx.query.get('limit') || 120));
    const type = String(ctx.query.get('type') || 'all');
    const files = walkFiles(ctx.paths.filesDir, { maxFiles: 4000 })
      .filter((full) => !full.includes(`${path.sep}.cc-history${path.sep}`))
      .filter((full) => visiblePath(ctx.db, user, relFrom(ctx.paths.filesDir, full)))
      .map((full) => {
        try {
          const stat = fs.statSync(full);
          return {
            name: path.basename(full),
            path: relFrom(ctx.paths.filesDir, full),
            kind: fileKind(path.basename(full)),
            size: stat.size,
            mtime: stat.mtime.toISOString()
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((item) => {
        if (type === 'images') return item.kind === 'image';
        if (type === 'videos') return item.kind === 'video';
        return item.kind === 'image' || item.kind === 'video';
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
      .slice(0, limit);
    sendJson(ctx.res, 200, { media: files });
  });

  /* ------------------------------- assistant ------------------------------ */
  router.get('/api/assistant', async (ctx) => {
    const user = requireUser(ctx);
    const prefs = getPreference(ctx.db, user.id, 'assistant', {});
    sendJson(ctx.res, 200, {
      configured: Boolean(prefs.apiKey && prefs.baseUrl && prefs.model),
      baseUrl: prefs.baseUrl || 'https://api.openai.com/v1',
      model: prefs.model || 'gpt-4o-mini',
      hasKey: Boolean(prefs.apiKey)
    });
  });

  router.put('/api/assistant', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const current = getPreference(ctx.db, user.id, 'assistant', {});
    const baseUrl = String(body.baseUrl ?? current.baseUrl ?? '').trim().replace(/\/+$/, '');
    const model = String(body.model ?? current.model ?? 'gpt-4o-mini').trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return sendJson(ctx.res, 400, { error: 'Base URL must start with http:// or https://' });
    const apiKey = body.apiKey ? String(body.apiKey) : current.apiKey || '';
    setPreference(ctx.db, user.id, 'assistant', { baseUrl, model, apiKey });
    sendJson(ctx.res, 200, { ok: true, configured: Boolean(apiKey && baseUrl && model) });
  });

  router.post('/api/assistant/chat', async (ctx) => {
    const user = requireUser(ctx);
    const prefs = getPreference(ctx.db, user.id, 'assistant', {});
    if (!prefs.apiKey || !prefs.baseUrl) return sendJson(ctx.res, 400, { error: 'Add an API key in Assistant settings first' });
    const body = await ctx.json(1000000);
    const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
    if (!messages.length) return sendJson(ctx.res, 400, { error: 'Say something first' });
    const sanitized = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 12000) }));
    const workspace = String(body.context || '').slice(0, 8000);
    const context = [
      {
        role: 'system',
        content:
          'You are the CoolCloud assistant, running inside a self-hosted collaboration suite. Be concise and practical. The user is ' +
          user.display_name +
          '.' +
          (workspace ? `\n\nWorkspace context the user chose to share:\n${workspace}` : '')
      },
      ...sanitized
    ];
    let upstream;
    try {
      upstream = await fetch(`${prefs.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prefs.apiKey}` },
        body: JSON.stringify({ model: body.model || prefs.model, messages: context, stream: true }),
        signal: AbortSignal.timeout(120000)
      });
    } catch (err) {
      return sendJson(ctx.res, 502, { error: `Could not reach the assistant provider: ${err.message}` });
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return sendJson(ctx.res, 502, { error: `Provider returned ${upstream.status}: ${detail.slice(0, 300)}` });
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    try {
      for await (const chunk of upstream.body) {
        ctx.res.write(chunk);
      }
    } catch (err) {
      ctx.res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    ctx.res.end();
  });

  /* --------------------------------- connect ------------------------------- */
  router.get('/api/connect/rooms', async (ctx) => {
    requireUser(ctx);
    const rows = ctx.db
      .prepare('SELECT room, COUNT(*) AS messages, MAX(created_at) AS last_at FROM connect_messages GROUP BY room ORDER BY last_at DESC')
      .all();
    sendJson(ctx.res, 200, { rooms: rows });
  });

  router.get('/api/connect/messages', async (ctx) => {
    const user = requireUser(ctx);
    const room = safeRoom(ctx.query.get('room'));
    if (!canUseRoom(room, user.id)) return sendJson(ctx.res, 403, { error: 'That conversation is not yours' });
    const rows = ctx.db.prepare('SELECT * FROM connect_messages WHERE room = ? ORDER BY id DESC LIMIT 80').all(room);
    sendJson(ctx.res, 200, {
      room,
      messages: rows.reverse().map((row) => ({
        id: row.id,
        room: row.room,
        senderId: row.sender_id,
        senderName: row.sender_name,
        body: row.body,
        createdAt: row.created_at
      }))
    });
  });

  router.post('/api/connect/messages', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const room = safeRoom(body.room);
    const payload = String(body.body || '').slice(0, 20000);
    if (!payload) return sendJson(ctx.res, 400, { error: 'Empty message' });
    if (!canUseRoom(room, user.id)) return sendJson(ctx.res, 403, { error: 'That conversation is not yours' });
    const info = ctx.db
      .prepare('INSERT INTO connect_messages (room, sender_id, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(room, user.id, user.display_name, payload, nowISO());
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.get('/api/connect/people', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db
      .prepare("SELECT id, username, display_name, role FROM users WHERE active = 1 AND id != ? ORDER BY display_name COLLATE NOCASE")
      .all(user.id);
    sendJson(ctx.res, 200, {
      people: rows.map((row) => ({ id: row.id, name: row.display_name, username: row.username, role: row.role }))
    });
  });

  /* ------------------------------ activity feed ---------------------------- */
  router.get('/api/notifications', async (ctx) => {
    const user = requireUser(ctx);
    const limit = Math.min(50, Math.max(1, Number(ctx.query.get('limit') || 30)));
    const rows = ctx.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(user.id, limit);
    const unread = ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(user.id).n;
    sendJson(ctx.res, 200, {
      unread,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        link: row.link,
        read: Boolean(row.read),
        createdAt: row.created_at,
        actorId: row.actor_id
      }))
    });
  });

  router.post('/api/notifications/read', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    if (body.all) {
      ctx.db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
    } else if (Array.isArray(body.ids) && body.ids.length) {
      const ids = body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 100);
      const statement = ctx.db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?');
      for (const id of ids) statement.run(user.id, id);
    }
    const unread = ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(user.id).n;
    sendJson(ctx.res, 200, { ok: true, unread });
  });

  router.delete('/api/notifications/:id', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db.prepare('DELETE FROM notifications WHERE user_id = ? AND id = ?').run(user.id, Number(ctx.params.id));
    sendJson(ctx.res, 200, { ok: true, removed: rows.changes });
  });

  /* -------------------------------- invites -------------------------------- */
  router.post('/api/connect/invite', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const room = safeRoom(body.room);
    if (!canUseRoom(room, user.id)) return sendJson(ctx.res, 403, { error: 'You cannot invite people here' });
    const username = String(body.username || '').trim().toLowerCase();
    if (!username) return sendJson(ctx.res, 400, { error: 'Enter a username' });

    let target = ctx.db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(username);
    let created = null;

    if (!target) {
      if (user.role !== 'admin') {
        return sendJson(ctx.res, 404, {
          error: 'No member with that username yet. An administrator can create the account from this dialog.'
        });
      }
      const password = tempPassword();
      const info = ctx.db
        .prepare('INSERT INTO users (username, display_name, email, pass_hash, role, quota_mb, prefs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          username,
          String(body.name || username).trim().slice(0, 80) || username,
          String(body.email || '').trim().slice(0, 160),
          hashPassword(password),
          'user',
          ctx.cfg.storage?.defaultUserQuotaMb || null,
          '{}',
          nowISO()
        );
      target = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
      created = { username: target.username, password };
    }

    if (Number(target.id) === Number(user.id)) return sendJson(ctx.res, 400, { error: 'You are already here' });
    if (!target.active) return sendJson(ctx.res, 400, { error: 'That account is disabled' });

    const isDirect = Boolean(dmMembers(room));
    const label = isDirect ? 'a direct message' : `#${room}`;
    notify(ctx.db, target.id, {
      kind: 'invite',
      title: `${user.display_name} invited you to ${label}`,
      body: isDirect
        ? 'Open Connect to reply. Calls ring in the app.'
        : 'Open the channel to read the history and say hello.',
      link: `cc:connect?room=${encodeURIComponent(room)}`,
      actorId: user.id
    });

    ctx.db
      .prepare('INSERT INTO connect_messages (room, sender_id, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(room, 0, 'system', `${user.display_name} invited ${target.display_name}`, nowISO());

    sendJson(ctx.res, 200, {
      ok: true,
      room,
      created,
      user: {
        id: target.id,
        name: target.display_name,
        username: target.username
      }
    });
  });
}

export function attachConnect(server, ctx) {
  const rooms = new Map();

  const members = (room) => {
    const set = rooms.get(room) || new Set();
    return [...set].filter((conn) => !conn.closed);
  };

  const broadcast = (room, payload, except = null) => {
    for (const conn of members(room)) {
      if (conn === except) continue;
      try {
        conn.send(payload);
      } catch {
        /* ignore */
      }
    }
  };

  const roster = (room) => {
    const seen = new Map();
    for (const conn of members(room)) seen.set(conn.user.id, conn.user.display_name);
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  };

  const presence = (room) => broadcast(room, { type: 'presence', room, members: roster(room) });

  attachWebSocket(server, {
    path: '/ws',
    verify: (req, url) => {
      if (!ctx.cfg.features?.connect) return null;
      const token = url.searchParams.get('token') || bearerToken(req);
      if (!token) return null;
      return (
        ctx.db
          .prepare('SELECT * FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1')
          .get(hashToken(token), nowISO()) || null
      );
    },
    onConnection: (conn) => {
      const initial = 'general';
      conn.rooms = new Set([initial]);
      if (!rooms.has(initial)) rooms.set(initial, new Set());
      rooms.get(initial).add(conn);
      conn.send({ type: 'ready', user: { id: conn.user.id, name: conn.user.display_name }, room: initial });
      const history = ctx.db.prepare('SELECT * FROM connect_messages WHERE room = ? ORDER BY id DESC LIMIT 60').all(initial).reverse();
      conn.send({
        type: 'history',
        room: initial,
        messages: history.map((row) => ({
          id: row.id,
          senderId: row.sender_id,
          senderName: row.sender_name,
          body: row.body,
          createdAt: row.created_at
        }))
      });
      presence(initial);

      const joinRoom = (room) => {
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(conn);
        conn.rooms.add(room);
        const rows = ctx.db.prepare('SELECT * FROM connect_messages WHERE room = ? ORDER BY id DESC LIMIT 60').all(room).reverse();
        conn.send({
          type: 'history',
          room,
          messages: rows.map((row) => ({
            id: row.id,
            senderId: row.sender_id,
            senderName: row.sender_name,
            body: row.body,
            createdAt: row.created_at
          }))
        });
        presence(room);
      };

      conn.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'join') {
          const room = safeRoom(msg.room);
          if (!canUseRoom(room, conn.user.id)) {
            conn.send({ type: 'error', room, error: 'That conversation is not yours' });
            return;
          }
          joinRoom(room);
          return;
        }
        if (msg.type === 'leave') {
          const room = safeRoom(msg.room);
          conn.rooms.delete(room);
          rooms.get(room)?.delete(conn);
          presence(room);
          return;
        }
        if (msg.type === 'message') {
          const room = safeRoom(msg.room);
          if (!canUseRoom(room, conn.user.id)) return;
          if (!conn.rooms.has(room)) joinRoom(room);
          const payload = String(msg.body || '').slice(0, 20000);
          if (!payload) return;
          const info = ctx.db
            .prepare('INSERT INTO connect_messages (room, sender_id, sender_name, body, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(room, conn.user.id, conn.user.display_name, payload, nowISO());
          const out = {
            type: 'message',
            id: Number(info.lastInsertRowid),
            room,
            senderId: conn.user.id,
            senderName: conn.user.display_name,
            body: payload,
            createdAt: nowISO()
          };
          for (const member of members(room)) member.send(out);
          return;
        }
        if (msg.type === 'typing') {
          const room = safeRoom(msg.room);
          broadcast(room, { type: 'typing', room, senderId: conn.user.id, senderName: conn.user.display_name }, conn);
          return;
        }
        if (msg.type === 'signal') {
          const room = safeRoom(msg.room);
          const target = Number(msg.to);
          for (const member of members(room)) {
            if (member.user.id === target) {
              member.send({ type: 'signal', room, from: conn.user.id, fromName: conn.user.display_name, data: msg.data });
            }
          }
        }
      });

      conn.on('close', () => {
        for (const room of conn.rooms) {
          rooms.get(room)?.delete(conn);
          presence(room);
        }
      });
    }
  });

  const heartbeat = setInterval(() => {
    for (const set of rooms.values()) {
      for (const conn of set) {
        if (conn.closed) set.delete(conn);
        else conn.ping();
      }
    }
  }, 30000);
  server.on('close', () => clearInterval(heartbeat));
}
