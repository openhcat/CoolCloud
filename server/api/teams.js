import fs from 'node:fs';
import path from 'node:path';
import { requireUser, requireAdmin } from '../auth.js';
import { sendJson } from '../http.js';
import { audit, notify } from '../db.js';
import { accessFor, normalizePath, normalizeRole, nearestAcl } from '../access.js';
import { nowISO, safeJoin } from '../util.js';

function publicTeam(db, row) {
  const members = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.active
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY u.display_name`
    )
    .all(row.id);
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    members: members
      .filter((member) => member.active)
      .map((member) => ({
        id: member.id,
        username: member.username,
        name: member.display_name || member.username
      })),
    inactiveMembers: members.filter((member) => !member.active).length
  };
}

function teamRow(db, id) {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(id));
}

function canManageTeam(user, team) {
  return Boolean(team && (user.role === 'admin' || Number(team.owner_id) === Number(user.id)));
}

function canUseTeam(db, user, teamId) {
  const team = teamRow(db, teamId);
  if (!team) return null;
  if (user.role === 'admin' || Number(team.owner_id) === Number(user.id)) return team;
  const member = db.prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, user.id);
  return member ? team : null;
}

function aclPayload(db, user, rel) {
  const acl = db.prepare('SELECT * FROM file_acl WHERE path = ?').get(rel);
  const access = accessFor(db, user, rel);
  if (!acl) {
    return { path: rel, restricted: false, canManage: access.canManage, users: [], teams: [], shares: [], requests: [] };
  }
  const users = db
    .prepare(
      `SELECT g.user_id, g.can_write, g.role, g.expires_at, u.username, u.display_name, u.active
       FROM file_acl_users g JOIN users u ON u.id = g.user_id
       WHERE g.path = ? ORDER BY u.display_name COLLATE NOCASE`
    )
    .all(rel);
  const teams = db
    .prepare(
      `SELECT g.team_id, g.can_write, g.role, g.expires_at, t.name
       FROM file_acl_teams g JOIN teams t ON t.id = g.team_id
       WHERE g.path = ? ORDER BY t.name COLLATE NOCASE`
    )
    .all(rel);
  const manage = access.canManage;
  const sharePrefix = rel ? `${rel}/%` : '%';
  const shares = manage
    ? db
        .prepare('SELECT token, path, expires_at, allow_upload FROM shares WHERE path = ? OR path LIKE ? ORDER BY created_at DESC LIMIT 50')
        .all(rel, sharePrefix)
    : [];
  const requests = manage
    ? db
        .prepare(
          `SELECT r.*, u.username, u.display_name
           FROM file_acl_requests r JOIN users u ON u.id = r.user_id
           WHERE r.path = ? AND r.status = 'pending' ORDER BY r.id ASC`
        )
        .all(rel)
    : [];
  return {
    path: rel,
    restricted: true,
    ownerId: acl.owner_id,
    canManage: manage,
    users: users.map((row) => ({
      id: row.user_id,
      username: row.username,
      name: row.display_name || row.username,
      canWrite: Boolean(row.can_write),
      role: normalizeRole(row.role, row.can_write ? 'editor' : 'viewer'),
      expiresAt: row.expires_at || '',
      inactive: !row.active
    })),
    teams: teams.map((row) => ({
      id: row.team_id,
      name: row.name,
      canWrite: Boolean(row.can_write),
      role: normalizeRole(row.role, row.can_write ? 'editor' : 'viewer'),
      expiresAt: row.expires_at || ''
    })),
    shares: shares.map((row) => ({
      token: row.token,
      path: row.path,
      expiresAt: row.expires_at || '',
      allowUpload: Boolean(row.allow_upload)
    })),
    requests: requests.map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.display_name || row.username,
      username: row.username,
      note: row.note,
      createdAt: row.created_at
    }))
  };
}

function teamMemberIds(db, teamId) {
  return db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(Number(teamId)).map((row) => Number(row.user_id));
}

function notifyAccess(db, rel, user, oldUsers, oldTeams, newUsers, newTeams) {
  const oldUserMap = new Map(oldUsers.map((row) => [Number(row.user_id), normalizeRole(row.role, row.can_write ? 'editor' : 'viewer')]));
  const oldTeamMap = new Map(oldTeams.map((row) => [Number(row.team_id), normalizeRole(row.role, row.can_write ? 'editor' : 'viewer')]));
  const nextUsers = new Set(newUsers.map((row) => Number(row.id)));
  const nextTeams = new Set(newTeams.map((row) => Number(row.id)));
  const label = rel || 'Files';
  for (const grant of newUsers) {
    if (Number(grant.id) === Number(user.id)) continue;
    const before = oldUserMap.get(Number(grant.id));
    if (before !== grant.role) {
      notify(db, grant.id, {
        kind: 'share',
        title: before ? 'Folder access changed' : 'Folder shared with you',
        body: `${label} · ${grant.role}`,
        link: `#/cc:files?path=${encodeURIComponent(rel)}`,
        actorId: user.id
      });
    }
  }
  for (const [userId, role] of oldUserMap) {
    if (!nextUsers.has(userId)) {
      notify(db, userId, {
        kind: 'share',
        title: 'Folder access removed',
        body: `${label} is no longer shared with you`,
        actorId: user.id
      });
    }
  }
  for (const grant of newTeams) {
    const before = oldTeamMap.get(Number(grant.id));
    if (before === grant.role) continue;
    for (const userId of teamMemberIds(db, grant.id)) {
      if (Number(userId) === Number(user.id)) continue;
      notify(db, userId, {
        kind: 'share',
        title: before ? 'Team folder access changed' : 'Folder shared with your team',
        body: `${label} · ${grant.role}`,
        link: `#/cc:files?path=${encodeURIComponent(rel)}`,
        actorId: user.id
      });
    }
  }
  for (const [teamId] of oldTeamMap) {
    if (nextTeams.has(teamId)) continue;
    for (const userId of teamMemberIds(db, teamId)) {
      notify(db, userId, {
        kind: 'share',
        title: 'Team folder access removed',
        body: `${label} is no longer shared with your team`,
        actorId: user.id
      });
    }
  }
}

function publicRequest(row) {
  return {
    id: row.id,
    path: row.path,
    name: row.name || row.display_name || row.username || '',
    username: row.username || '',
    note: row.note || '',
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || ''
  };
}

export function registerTeams(router) {
  router.get('/api/directory', async (ctx) => {
    requireUser(ctx);
    const rows = ctx.db
      .prepare('SELECT id, username, display_name FROM users WHERE active = 1 ORDER BY display_name COLLATE NOCASE')
      .all();
    sendJson(ctx.res, 200, {
      people: rows.map((row) => ({ id: row.id, username: row.username, name: row.display_name || row.username }))
    });
  });

  router.get('/api/teams', async (ctx) => {
    const user = requireUser(ctx);
    const rows =
      user.role === 'admin'
        ? ctx.db.prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE').all()
        : ctx.db
            .prepare(
              `SELECT DISTINCT t.* FROM teams t
               LEFT JOIN team_members m ON m.team_id = t.id
               WHERE t.owner_id = ? OR m.user_id = ?
               ORDER BY t.name COLLATE NOCASE`
            )
            .all(user.id, user.id);
    sendJson(ctx.res, 200, { teams: rows.map((row) => publicTeam(ctx.db, row)) });
  });

  router.post('/api/teams', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return sendJson(ctx.res, 400, { error: 'Give the team a name' });
    const duplicate = ctx.db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?) AND owner_id = ?').get(name, user.id);
    if (duplicate) return sendJson(ctx.res, 409, { error: 'You already have a team with that name' });
    const info = ctx.db.prepare('INSERT INTO teams (name, owner_id, created_at) VALUES (?, ?, ?)').run(name, user.id, nowISO());
    const id = Number(info.lastInsertRowid);
    ctx.db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, added_at) VALUES (?, ?, ?)').run(id, user.id, nowISO());
    audit(ctx.db, user.id, 'team.create', name, ctx.ip());
    sendJson(ctx.res, 200, { team: publicTeam(ctx.db, teamRow(ctx.db, id)) });
  });

  router.delete('/api/teams/:id', async (ctx) => {
    const user = requireUser(ctx);
    const team = teamRow(ctx.db, ctx.params.id);
    if (!team) return sendJson(ctx.res, 404, { error: 'Team not found' });
    if (!canManageTeam(user, team)) return sendJson(ctx.res, 403, { error: 'Only the team owner can delete it' });
    ctx.db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
    audit(ctx.db, user.id, 'team.delete', team.name, ctx.ip());
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/teams/:id/members', async (ctx) => {
    const user = requireUser(ctx);
    const team = teamRow(ctx.db, ctx.params.id);
    if (!team) return sendJson(ctx.res, 404, { error: 'Team not found' });
    if (!canManageTeam(user, team)) return sendJson(ctx.res, 403, { error: 'Only the team owner can add members' });
    const body = await ctx.json();
    const ids = Array.isArray(body.userIds) ? body.userIds : body.userId ? [body.userId] : [];
    const added = [];
    for (const raw of ids.slice(0, 200)) {
      const member = ctx.db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(Number(raw));
      if (!member) continue;
      ctx.db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, added_at) VALUES (?, ?, ?)').run(team.id, member.id, nowISO());
      added.push(member.id);
    }
    if (!ids.length && body.username) {
      const member = ctx.db.prepare('SELECT id FROM users WHERE username = ? AND active = 1').get(String(body.username));
      if (member) {
        ctx.db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, added_at) VALUES (?, ?, ?)').run(team.id, member.id, nowISO());
        added.push(member.id);
      }
    }
    if (!added.length) return sendJson(ctx.res, 404, { error: 'Choose an active account' });
    sendJson(ctx.res, 200, { team: publicTeam(ctx.db, teamRow(ctx.db, team.id)) });
  });

  router.delete('/api/teams/:id/members/:userId', async (ctx) => {
    const user = requireUser(ctx);
    const team = teamRow(ctx.db, ctx.params.id);
    if (!team) return sendJson(ctx.res, 404, { error: 'Team not found' });
    const target = Number(ctx.params.userId);
    if (!canManageTeam(user, team) && target !== Number(user.id)) {
      return sendJson(ctx.res, 403, { error: 'Only the team owner can remove members' });
    }
    if (target === Number(team.owner_id)) return sendJson(ctx.res, 400, { error: 'The owner cannot be removed' });
    ctx.db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, target);
    sendJson(ctx.res, 200, { team: publicTeam(ctx.db, teamRow(ctx.db, team.id)) });
  });

  router.get('/api/files/acl', async (ctx) => {
    const user = requireUser(ctx);
    const rel = normalizePath(ctx.query.get('path') || '');
    const access = accessFor(ctx.db, user, rel);
    if (!access.allowed) return sendJson(ctx.res, 403, { error: 'This folder is restricted' });
    if (!fs.existsSync(safeJoin(ctx.paths.filesDir, rel))) return sendJson(ctx.res, 404, { error: 'Folder not found' });
    sendJson(ctx.res, 200, aclPayload(ctx.db, user, rel));
  });

  router.put('/api/files/acl', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = normalizePath(body.path || '');
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (!fs.existsSync(full)) return sendJson(ctx.res, 404, { error: 'Folder not found' });
    if (!fs.statSync(full).isDirectory()) return sendJson(ctx.res, 400, { error: 'Access rules apply to folders' });
    const current = ctx.db.prepare('SELECT * FROM file_acl WHERE path = ?').get(rel);
    const access = accessFor(ctx.db, user, rel);
    if (!access.canManage) return sendJson(ctx.res, 403, { error: 'You need manager access to change this folder' });
    if (current && user.role !== 'admin' && Number(current.owner_id) !== Number(user.id) && access.role !== 'manager') {
      return sendJson(ctx.res, 403, { error: 'Only the folder owner or a manager can change access' });
    }
    if (body.restricted === false) {
      ctx.db.prepare('DELETE FROM file_acl WHERE path = ?').run(rel);
      audit(ctx.db, user.id, 'acl.open', rel || '/', ctx.ip());
      return sendJson(ctx.res, 200, { ok: true, restricted: false });
    }

    const requestedUsers = Array.isArray(body.users) ? body.users : [];
    const requestedTeams = Array.isArray(body.teams) ? body.teams : [];
    const nextUsers = [];
    for (const item of requestedUsers.slice(0, 100)) {
      const id = Number(item?.id);
      if (!id || nextUsers.some((row) => row.id === id)) continue;
      const exists = ctx.db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(id);
      if (!exists) continue;
      const expiresAt = item.expiresAt && !Number.isNaN(Date.parse(item.expiresAt)) ? new Date(item.expiresAt).toISOString() : '';
      const role = normalizeRole(item.role, item.canWrite ? 'editor' : 'viewer');
      nextUsers.push({ id, role, canWrite: role === 'editor' || role === 'manager' ? 1 : 0, expiresAt });
    }
    const nextTeams = [];
    for (const item of requestedTeams.slice(0, 50)) {
      const id = Number(item?.id);
      if (!id || nextTeams.some((row) => row.id === id)) continue;
      if (!canUseTeam(ctx.db, user, id)) continue;
      const expiresAt = item.expiresAt && !Number.isNaN(Date.parse(item.expiresAt)) ? new Date(item.expiresAt).toISOString() : '';
      const role = normalizeRole(item.role, item.canWrite ? 'editor' : 'viewer');
      nextTeams.push({ id, role, canWrite: role === 'editor' || role === 'manager' ? 1 : 0, expiresAt });
    }

    const oldUsers = ctx.db.prepare('SELECT user_id, role, can_write FROM file_acl_users WHERE path = ?').all(rel);
    const oldTeams = ctx.db.prepare('SELECT team_id, role, can_write FROM file_acl_teams WHERE path = ?').all(rel);
    ctx.db
      .prepare(
        `INSERT INTO file_acl (path, owner_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET owner_id = file_acl.owner_id`
      )
      .run(rel, current?.owner_id || user.id, current?.created_at || nowISO());
    ctx.db.prepare('DELETE FROM file_acl_users WHERE path = ?').run(rel);
    ctx.db.prepare('DELETE FROM file_acl_teams WHERE path = ?').run(rel);
    for (const item of nextUsers) {
      ctx.db
        .prepare('INSERT INTO file_acl_users (path, user_id, can_write, role, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(rel, item.id, item.canWrite, item.role, item.expiresAt);
    }
    for (const item of nextTeams) {
      ctx.db
        .prepare('INSERT INTO file_acl_teams (path, team_id, can_write, role, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(rel, item.id, item.canWrite, item.role, item.expiresAt);
    }
    notifyAccess(ctx.db, rel, user, oldUsers, oldTeams, nextUsers, nextTeams);
    audit(ctx.db, user.id, 'acl.restrict', rel || '/', ctx.ip());
    sendJson(ctx.res, 200, { ok: true, restricted: true, users: nextUsers.length, teams: nextTeams.length });
  });

  router.get('/api/files/shared-with-me', async (ctx) => {
    const user = requireUser(ctx);
    const rank = { viewer: 0, commenter: 1, editor: 2, manager: 3 };
    const direct = ctx.db
      .prepare(
        `SELECT g.path, g.role, g.can_write, g.expires_at, u.display_name, u.username, '' AS team_name
         FROM file_acl_users g JOIN file_acl a ON a.path = g.path JOIN users u ON u.id = a.owner_id
         WHERE g.user_id = ? AND a.owner_id <> ?`
      )
      .all(user.id, user.id);
    const teamRows = ctx.db
      .prepare(
        `SELECT g.path, g.role, g.can_write, g.expires_at, u.display_name, u.username, t.name AS team_name
         FROM file_acl_teams g
         JOIN team_members m ON m.team_id = g.team_id
         JOIN file_acl a ON a.path = g.path
         JOIN teams t ON t.id = g.team_id
         JOIN users u ON u.id = a.owner_id
         WHERE m.user_id = ? AND a.owner_id <> ?`
      )
      .all(user.id, user.id);
    const merged = new Map();
    for (const row of [...direct, ...teamRows]) {
      if (row.expires_at && row.expires_at <= nowISO()) continue;
      const role = normalizeRole(row.role, row.can_write ? 'editor' : 'viewer');
      const before = merged.get(row.path);
      if (!before || rank[role] > rank[before.role]) merged.set(row.path, { ...row, role });
      else if (!before.team_name && row.team_name) merged.set(row.path, { ...before, team_name: row.team_name });
    }
    const items = [];
    for (const row of merged.values()) {
      let stat;
      try {
        stat = fs.statSync(safeJoin(ctx.paths.filesDir, row.path));
      } catch {
        continue;
      }
      items.push({
        path: row.path,
        name: path.basename(row.path) || 'Files',
        dir: stat.isDirectory(),
        role: normalizeRole(row.role, row.can_write ? 'editor' : 'viewer'),
        owner: row.display_name || row.username,
        team: row.team_name || '',
        expiresAt: row.expires_at || ''
      });
    }
    sendJson(ctx.res, 200, { items });
  });

  router.post('/api/files/acl/request', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const rel = normalizePath(body.path || '');
    if (!fs.existsSync(safeJoin(ctx.paths.filesDir, rel))) return sendJson(ctx.res, 404, { error: 'Folder not found' });
    const access = accessFor(ctx.db, user, rel);
    if (access.allowed) return sendJson(ctx.res, 400, { error: 'You already have access' });
    const acl = nearestAcl(ctx.db, rel);
    if (!acl) return sendJson(ctx.res, 400, { error: 'This folder is not restricted' });
    const existing = ctx.db
      .prepare("SELECT id FROM file_acl_requests WHERE path = ? AND user_id = ? AND status = 'pending'")
      .get(acl.path, user.id);
    if (existing) return sendJson(ctx.res, 409, { error: 'Your request is already waiting for a response' });
    const note = String(body.note || '').slice(0, 500);
    const info = ctx.db
      .prepare('INSERT INTO file_acl_requests (path, user_id, note, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(acl.path, user.id, note, 'pending', nowISO());
    notify(ctx.db, acl.owner_id, {
      kind: 'share',
      title: 'Folder access requested',
      body: `${user.display_name || user.username} asked for access to ${acl.path || 'Files'}`,
      link: `#/cc:files?path=${encodeURIComponent(acl.path)}`,
      actorId: user.id
    });
    audit(ctx.db, user.id, 'acl.request', acl.path || '/', ctx.ip());
    sendJson(ctx.res, 200, { ok: true, id: Number(info.lastInsertRowid) });
  });

  router.get('/api/files/acl/requests', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db
      .prepare(
        `SELECT r.*, u.username, u.display_name FROM file_acl_requests r
         JOIN users u ON u.id = r.user_id
         WHERE (r.user_id = ? OR EXISTS (
           SELECT 1 FROM file_acl a WHERE a.path = r.path AND (a.owner_id = ? OR ? = 'admin')
         )) AND r.status = 'pending'
         ORDER BY r.id DESC LIMIT 100`
      )
      .all(user.id, user.id, user.role);
    sendJson(ctx.res, 200, { requests: rows.map(publicRequest) });
  });

  router.post('/api/files/acl/requests/:id/resolve', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const request = ctx.db.prepare('SELECT * FROM file_acl_requests WHERE id = ?').get(Number(ctx.params.id));
    if (!request) return sendJson(ctx.res, 404, { error: 'Request not found' });
    const access = accessFor(ctx.db, user, request.path);
    if (!access.canManage) return sendJson(ctx.res, 403, { error: 'Only a folder manager can answer this' });
    const approve = body.approve !== false;
    const role = normalizeRole(body.role, 'viewer');
    if (approve) {
      const nextRole = normalizeRole(role, 'viewer');
      ctx.db
        .prepare(
          `INSERT INTO file_acl_users (path, user_id, can_write, role, expires_at) VALUES (?, ?, ?, ?, '')
           ON CONFLICT(path, user_id) DO UPDATE SET role = excluded.role, can_write = excluded.can_write, expires_at = ''`
        )
        .run(request.path, request.user_id, nextRole === 'editor' || nextRole === 'manager' ? 1 : 0, nextRole);
      notify(ctx.db, request.user_id, {
        kind: 'share',
        title: 'Folder access approved',
        body: `${request.path || 'Files'} · ${nextRole}`,
        link: `#/cc:files?path=${encodeURIComponent(request.path)}`,
        actorId: user.id
      });
    } else {
      notify(ctx.db, request.user_id, {
        kind: 'share',
        title: 'Folder access request declined',
        body: request.path || 'Files',
        actorId: user.id
      });
    }
    ctx.db
      .prepare('UPDATE file_acl_requests SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', nowISO(), user.id, request.id);
    audit(ctx.db, user.id, approve ? 'acl.request.approve' : 'acl.request.reject', request.path || '/', ctx.ip());
    sendJson(ctx.res, 200, { ok: true, status: approve ? 'approved' : 'rejected' });
  });

  router.get('/api/admin/teams', async (ctx) => {
    requireAdmin(ctx);
    const teams = ctx.db
      .prepare(
        `SELECT t.*, u.display_name AS owner_name, u.username AS owner_username
         FROM teams t JOIN users u ON u.id = t.owner_id ORDER BY t.name COLLATE NOCASE`
      )
      .all();
    sendJson(ctx.res, 200, {
      teams: teams.map((team) => {
        const payload = publicTeam(ctx.db, team);
        const grants = ctx.db
          .prepare(
            `SELECT g.path, g.role, g.can_write, g.expires_at, a.owner_id
             FROM file_acl_teams g JOIN file_acl a ON a.path = g.path
             WHERE g.team_id = ? ORDER BY g.path`
          )
          .all(team.id);
        return {
          ...payload,
          owner: team.owner_name || team.owner_username,
          grants: grants.map((grant) => ({
            path: grant.path,
            role: normalizeRole(grant.role, grant.can_write ? 'editor' : 'viewer'),
            expiresAt: grant.expires_at || ''
          }))
        };
      })
    });
  });

  router.post('/api/admin/teams/:id/cleanup', async (ctx) => {
    const admin = requireAdmin(ctx);
    const removed = ctx.db
      .prepare(
        `DELETE FROM team_members WHERE team_id = ? AND user_id NOT IN (SELECT id FROM users WHERE active = 1)`
      )
      .run(Number(ctx.params.id)).changes;
    audit(ctx.db, admin.id, 'team.cleanup', `${ctx.params.id}: ${removed}`, ctx.ip());
    sendJson(ctx.res, 200, { ok: true, removed: Number(removed || 0) });
  });
}
