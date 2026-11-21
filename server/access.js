/**
 * Opt-in folder access control.
 *
 * Files remain workspace-wide unless a folder (or file) has a row in
 * file_acl. The nearest ACL walking up the path wins, so restricting a folder
 * automatically covers everything inside it.
 *
 * Roles: viewer < commenter < editor < manager.
 */

export const ROLES = ['viewer', 'commenter', 'editor', 'manager'];
const RANK = { viewer: 0, commenter: 1, editor: 2, manager: 3 };

export function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function normalizeRole(value, fallback = 'viewer') {
  const role = String(value || '').toLowerCase();
  return ROLES.includes(role) ? role : fallback;
}

export function roleForGrant(row) {
  if (!row) return '';
  if (row.role && ROLES.includes(row.role)) return row.role;
  return row.can_write ? 'editor' : 'viewer';
}

function activeGrant(row, now = new Date().toISOString()) {
  return row && (!row.expires_at || row.expires_at > now);
}

export function nearestAcl(db, rel) {
  let current = normalizePath(rel);
  for (;;) {
    const row = db.prepare('SELECT * FROM file_acl WHERE path = ?').get(current);
    if (row) return row;
    if (!current) return null;
    const index = current.lastIndexOf('/');
    current = index === -1 ? '' : current.slice(0, index);
  }
}

export function accessFor(db, user, rel) {
  if (!user) {
    return { allowed: false, role: '', canWrite: false, canComment: false, canManage: false, restricted: true, acl: null };
  }
  if (user.role === 'admin') {
    return { allowed: true, role: 'manager', canWrite: true, canComment: true, canManage: true, restricted: false, acl: null };
  }
  const acl = nearestAcl(db, rel);
  if (!acl) {
    return { allowed: true, role: 'manager', canWrite: true, canComment: true, canManage: true, restricted: false, acl: null };
  }
  if (Number(acl.owner_id) === Number(user.id)) {
    return { allowed: true, role: 'manager', canWrite: true, canComment: true, canManage: true, restricted: true, acl, owner: true };
  }
  const now = new Date().toISOString();
  const userGrant = db.prepare('SELECT * FROM file_acl_users WHERE path = ? AND user_id = ?').get(acl.path, user.id);
  const teamGrants = db
    .prepare(
      `SELECT g.* FROM file_acl_teams g
       JOIN team_members m ON m.team_id = g.team_id
       WHERE g.path = ? AND m.user_id = ?`
    )
    .all(acl.path, user.id);
  const grants = [userGrant, ...teamGrants].filter((row) => activeGrant(row, now));
  const role = grants.map(roleForGrant).sort((a, b) => RANK[b] - RANK[a])[0] || '';
  const allowed = Boolean(role);
  return {
    allowed,
    role,
    canWrite: allowed && RANK[role] >= RANK.editor,
    canComment: allowed && RANK[role] >= RANK.commenter,
    canManage: allowed && RANK[role] >= RANK.manager,
    restricted: true,
    acl,
    owner: false
  };
}

export function assertAccess(db, user, rel, { write = false, comment = false, manage = false } = {}) {
  const access = accessFor(db, user, rel);
  if (!access.allowed) {
    throw Object.assign(new Error('This folder is restricted. Ask its owner for access.'), {
      status: 403,
      code: 'folder-restricted'
    });
  }
  if (write && !access.canWrite) {
    throw Object.assign(new Error('You have read-only access to this folder.'), { status: 403, code: 'folder-readonly' });
  }
  if (comment && !access.canComment) {
    throw Object.assign(new Error('You need comment access to do that.'), { status: 403, code: 'folder-comment' });
  }
  if (manage && !access.canManage) {
    throw Object.assign(new Error('You need manager access to do that.'), { status: 403, code: 'folder-manage' });
  }
  return access;
}

export function accessSummary(db, user, rel) {
  const access = accessFor(db, user, rel);
  if (!access.restricted) return { restricted: false };
  const owner = db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(access.acl.owner_id);
  return {
    restricted: true,
    role: access.role,
    owner: owner?.display_name || owner?.username || 'Folder owner'
  };
}

export function canManageAccess(db, user, rel) {
  return accessFor(db, user, rel).canManage;
}

export function visiblePath(db, user, rel) {
  return accessFor(db, user, rel).allowed;
}

export function parentPath(rel) {
  const parts = normalizePath(rel).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}
