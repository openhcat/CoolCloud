import fs from 'node:fs';
import { requireUser } from '../auth.js';
import { sendJson } from '../http.js';
import { OFFICE_EXT, extOf, safeJoin } from '../util.js';
import { ensureOffice } from '../office.js';
import { officeSession } from '../wopi.js';

export function registerOffice(router) {
  router.get('/api/office/session', async (ctx) => {
    const user = requireUser(ctx);
    const rel = String(ctx.query.get('path') || '');
    if (!rel) return sendJson(ctx.res, 400, { error: 'A path is required' });
    const full = safeJoin(ctx.paths.filesDir, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return sendJson(ctx.res, 404, { error: 'File not found' });
    }
    if (!OFFICE_EXT.has(extOf(rel))) {
      return sendJson(ctx.res, 415, { error: 'That is not an office document' });
    }

    const session = await officeSession({ ...ctx, user }, rel);
    if (!session.ready && session.provider === 'collabora' && session.starting) {
      ensureOffice(ctx.paths, ctx.cfg, (line) => console.log(`  ${line}`)).catch(() => {});
    }
    sendJson(ctx.res, 200, session);
  });
}
