import { requireUser } from '../auth.js';
import { sendJson } from '../http.js';
import { fetchInbox, fetchMessage, sendMail } from '../mailer.js';
import { nowISO } from '../util.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function accountRow(db, userId) {
  return db.prepare('SELECT * FROM mail_accounts WHERE user_id = ?').get(userId) || null;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return fallback;
  }
}

function mask(config) {
  return {
    host: config.host || '',
    port: config.port || '',
    secure: config.secure !== false,
    user: config.user || '',
    from: config.from || config.user || '',
    hasPassword: Boolean(config.pass)
  };
}

export function registerMail(router) {
  router.get('/api/mail', async (ctx) => {
    const user = requireUser(ctx);
    const row = accountRow(ctx.db, user.id);
    const smtp = parseJson(row?.smtp);
    const imap = parseJson(row?.imap);
    const sent = ctx.db
      .prepare('SELECT id, to_addr, cc_addr, subject, status, error, sent_at FROM mail_sent WHERE user_id = ? ORDER BY id DESC LIMIT 25')
      .all(user.id);
    sendJson(ctx.res, 200, {
      smtp: mask(smtp),
      imap: mask(imap),
      configured: Boolean(smtp.host),
      imapConfigured: Boolean(imap.host),
      sent: sent.map((item) => ({
        id: item.id,
        to: item.to_addr,
        cc: item.cc_addr,
        subject: item.subject,
        status: item.status,
        error: item.error,
        sentAt: item.sent_at
      }))
    });
  });

  router.put('/api/mail', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const row = accountRow(ctx.db, user.id);
    const existingSmtp = parseJson(row?.smtp);
    const existingImap = parseJson(row?.imap);
    const incomingSmtp = body.smtp || {};
    const incomingImap = body.imap || {};
    const smtp = {
      host: String(incomingSmtp.host ?? existingSmtp.host ?? '').trim(),
      port: Number(incomingSmtp.port ?? existingSmtp.port ?? 587) || 587,
      secure: incomingSmtp.secure !== undefined ? Boolean(incomingSmtp.secure) : existingSmtp.secure !== false,
      user: String(incomingSmtp.user ?? existingSmtp.user ?? '').trim(),
      pass: incomingSmtp.pass ? String(incomingSmtp.pass) : existingSmtp.pass || '',
      from: String(incomingSmtp.from ?? existingSmtp.from ?? '').trim()
    };
    const imap = {
      host: String(incomingImap.host ?? existingImap.host ?? '').trim(),
      port: Number(incomingImap.port ?? existingImap.port ?? 993) || 993,
      secure: incomingImap.secure !== undefined ? Boolean(incomingImap.secure) : existingImap.secure !== false,
      user: String(incomingImap.user ?? existingImap.user ?? '').trim(),
      pass: incomingImap.pass ? String(incomingImap.pass) : existingImap.pass || '',
      from: ''
    };
    ctx.db
      .prepare(
        `INSERT INTO mail_accounts (user_id, smtp, imap, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET smtp = excluded.smtp, imap = excluded.imap, updated_at = excluded.updated_at`
      )
      .run(user.id, JSON.stringify(smtp), JSON.stringify(imap), nowISO());
    sendJson(ctx.res, 200, { ok: true, smtp: mask(smtp), imap: mask(imap) });
  });

  router.post('/api/mail/send', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json(12 * 1024 * 1024);
    const row = accountRow(ctx.db, user.id);
    const smtp = parseJson(row?.smtp);
    if (!smtp.host) return sendJson(ctx.res, 400, { error: 'Connect an SMTP server first' });
    const to = String(body.to || '')
      .split(/[,;]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const cc = String(body.cc || '')
      .split(/[,;]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!to.length) return sendJson(ctx.res, 400, { error: 'Add at least one recipient' });
    if ([...to, ...cc].some((address) => !EMAIL.test(address))) {
      return sendJson(ctx.res, 400, { error: 'One of the addresses is not valid' });
    }
    if (!smtp.from && !smtp.user) return sendJson(ctx.res, 400, { error: 'Set a sender address' });
    const subject = String(body.subject || '(no subject)').slice(0, 300);
    const text = String(body.text || '').slice(0, 500000);
    const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
      .slice(0, 5)
      .map((item) => ({
        name: String(item?.name || 'attachment').replace(/[\\/]/g, '').slice(0, 160),
        type: String(item?.type || 'application/octet-stream').slice(0, 100),
        data: String(item?.data || '').replace(/^data:[^;]+;base64,/, '')
      }))
      .filter((item) => item.data && item.data.length <= 5 * 1024 * 1024 * 1.4);
    try {
      await sendMail(smtp, { to, cc, subject, text, attachments });
      ctx.db
        .prepare('INSERT INTO mail_sent (user_id, to_addr, cc_addr, subject, body, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, to.join(', '), cc.join(', '), subject, text, 'sent', '', nowISO());
      if (body.draftId) ctx.db.prepare('DELETE FROM mail_drafts WHERE id = ? AND user_id = ?').run(Number(body.draftId), user.id);
      sendJson(ctx.res, 200, { ok: true });
    } catch (err) {
      ctx.db
        .prepare('INSERT INTO mail_sent (user_id, to_addr, cc_addr, subject, body, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, to.join(', '), cc.join(', '), subject, text, 'failed', String(err.message).slice(0, 500), nowISO());
      sendJson(ctx.res, 502, { error: err.message });
    }
  });

  router.get('/api/mail/inbox', async (ctx) => {
    const user = requireUser(ctx);
    const row = accountRow(ctx.db, user.id);
    const imap = parseJson(row?.imap);
    if (!imap.host) return sendJson(ctx.res, 400, { error: 'Connect an IMAP server first' });
    try {
      const result = await fetchInbox(imap, { limit: Number(ctx.query.get('limit') || 20) });
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, 502, { error: err.message });
    }
  });

  router.get('/api/mail/message', async (ctx) => {
    const user = requireUser(ctx);
    const row = accountRow(ctx.db, user.id);
    const imap = parseJson(row?.imap);
    if (!imap.host) return sendJson(ctx.res, 400, { error: 'Connect an IMAP server first' });
    try {
      const result = await fetchMessage(imap, Number(ctx.query.get('uid')));
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, 502, { error: err.message });
    }
  });

  router.delete('/api/mail/sent/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM mail_sent WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), user.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/mail/drafts', async (ctx) => {
    const user = requireUser(ctx);
    const rows = ctx.db
      .prepare('SELECT id, to_addr, cc_addr, subject, body, updated_at FROM mail_drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50')
      .all(user.id);
    sendJson(ctx.res, 200, {
      drafts: rows.map((row) => ({ id: row.id, to: row.to_addr, cc: row.cc_addr, subject: row.subject, text: row.body, updatedAt: row.updated_at }))
    });
  });

  router.post('/api/mail/drafts', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const values = [
      String(body.to || '').slice(0, 1000),
      String(body.cc || '').slice(0, 1000),
      String(body.subject || '').slice(0, 300),
      String(body.text || '').slice(0, 500000),
      nowISO()
    ];
    if (body.id) {
      const existing = ctx.db.prepare('SELECT id FROM mail_drafts WHERE id = ? AND user_id = ?').get(Number(body.id), user.id);
      if (existing) {
        ctx.db.prepare('UPDATE mail_drafts SET to_addr = ?, cc_addr = ?, subject = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(...values, existing.id, user.id);
        return sendJson(ctx.res, 200, { id: existing.id });
      }
    }
    const info = ctx.db
      .prepare('INSERT INTO mail_drafts (user_id, to_addr, cc_addr, subject, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, ...values);
    sendJson(ctx.res, 200, { id: Number(info.lastInsertRowid) });
  });

  router.delete('/api/mail/drafts/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.db.prepare('DELETE FROM mail_drafts WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), user.id);
    sendJson(ctx.res, 200, { ok: true });
  });
}
