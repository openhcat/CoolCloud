import crypto from 'node:crypto';
import { sendJson } from './http.js';
import { nowISO } from './util.js';
import { appendLog } from './config.js';

/**
 * Public form pages for the cc:forms app.
 *
 * The app keeps form definitions in its own app storage; this module finds a
 * form by its public token and appends responses to the owner's storage. It
 * also renders /f/<token>, a page that works without a CoolCloud session.
 */

const APP = 'cc:forms';
const TOKEN = /^[A-Za-z0-9_-]{12,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RESPONSES = 500;
const WINDOW = 10 * 60 * 1000;
const LIMIT = 15;
const attempts = new Map();

/* Enterprise stores app data encrypted; Community stores it as JSON. */
let vault = null;
try {
  vault = await import('./vault.js');
} catch {
  vault = null;
}
const readValue = (value) => (vault && value ? vault.open(value) : String(value ?? ''));
const writeValue = (value) => (vault ? vault.seal(value) : value);

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function findForm(db, token) {
  let rows;
  try {
    rows = db.prepare("SELECT user_id, value FROM app_storage WHERE app_id = ? AND key = 'state'").all(APP);
  } catch {
    return null;
  }
  for (const row of rows) {
    let state;
    try {
      state = JSON.parse(readValue(row.value) || '{}');
    } catch {
      continue;
    }
    const form = (state.forms || []).find((item) => item && item.token === token);
    if (form) return { userId: row.user_id, form };
  }
  return null;
}

function rateOk(token, ip) {
  const key = `${token}|${ip}`;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((time) => now - time < WINDOW);
  if (list.length >= LIMIT) return false;
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) attempts.clear();
  return true;
}

function fieldHtml(field) {
  const id = `f_${String(field.id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const name = escapeHtml(field.id);
  const label = escapeHtml(field.label || 'Question');
  const required = field.required ? ' required' : '';
  const req = field.required ? '<span class="req">*</span>' : '';
  let control = '';
  if (field.type === 'textarea') {
    control = `<textarea class="input" id="${id}" name="${name}" rows="4"${required}></textarea>`;
  } else if (field.type === 'select') {
    const options = (field.options || [])
      .map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
      .join('');
    control = `<select class="select" id="${id}" name="${name}"${required}><option value="">Choose…</option>${options}</select>`;
  } else if (field.type === 'checkbox') {
    return `<label class="check"><input type="checkbox" id="${id}" name="${name}" data-id="${name}" /> <span>${label}</span>${req}</label>`;
  } else {
    const type = field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : 'text';
    control = `<input class="input" id="${id}" name="${name}" type="${type}"${required} />`;
  }
  return `<div class="field"><label class="label" for="${id}">${label} ${req}</label>${control}</div>`;
}

function page(title, body, status = 200) {
  return {
    status,
    html: `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/vendor/fa/css/all.min.css" />
    <link rel="stylesheet" href="/vendor/fonts/inter.css" />
    <link rel="stylesheet" href="/css/tokens.css" />
    <link rel="stylesheet" href="/css/base.css" />
    <link rel="stylesheet" href="/css/components.css" />
    <style>
      body { background: var(--bg); min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 40px 18px; }
      .form-card { width: min(600px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 26px 26px 22px; box-shadow: var(--shadow-sm); }
      .form-card h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }
      .form-card .sub { margin: 0 0 20px; color: var(--text-3); font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
      .form-card .field { margin-bottom: 14px; }
      .req { color: var(--danger); }
      .check { display: flex; gap: 9px; align-items: flex-start; font-size: 13px; margin-bottom: 14px; }
      .foot { display: flex; align-items: center; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
      .brandline { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-3); margin-top: 18px; }
      .brandline i { color: var(--accent); }
      .done { text-align: center; padding: 30px 8px; }
      .done i { font-size: 34px; color: var(--ok); margin-bottom: 10px; }
      .done h1 { margin: 0 0 6px; }
      .done p { color: var(--text-3); margin: 0; font-size: 13px; }
    </style>
  </head>
  <body>${body}</body>
</html>`
  };
}

function renderPage(form, token) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const body = `<main class="form-card">
    <h1>${escapeHtml(form.title || 'Form')}</h1>
    ${form.description ? `<p class="sub">${escapeHtml(form.description)}</p>` : ''}
    <form id="public-form" novalidate>
      ${fields.map(fieldHtml).join('\n')}
      <p class="form-error" id="form-error" style="display:none;color:var(--danger);font-size:12.5px;margin:10px 0 0"></p>
      <div class="foot">
        <button class="btn primary" type="submit" id="submit">Submit</button>
        <span class="hint" id="hint"></span>
      </div>
    </form>
    <div class="brandline"><i class="fa-solid fa-cloud"></i> Powered by CoolCloud</div>
  </main>
  <script>
    (function () {
      var scheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = scheme;
      var form = document.getElementById('public-form');
      var error = document.getElementById('form-error');
      var button = document.getElementById('submit');
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        error.style.display = 'none';
        var values = {};
        form.querySelectorAll('[data-id]').forEach(function (input) {
          values[input.dataset.id] = input.type === 'checkbox' ? input.checked : input.value;
        });
        button.disabled = true;
        button.textContent = 'Sending…';
        try {
          var response = await fetch('/api/public/forms/${token}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: values })
          });
          var data = await response.json().catch(function () { return {}; });
          if (!response.ok) throw new Error(data.error || 'Could not send the form');
          document.querySelector('.form-card').innerHTML =
            '<div class="done"><i class="fa-solid fa-circle-check"></i><h1>Thank you</h1><p>Your response was sent.</p></div>';
        } catch (err) {
          error.textContent = err.message;
          error.style.display = 'block';
          button.disabled = false;
          button.textContent = 'Submit';
        }
      });
    })();
  </script>`;
  return page(form.title || 'Form', body).html;
}

export async function serveFormPage({ req, res, url, db }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  const token = decodeURIComponent(url.pathname.replace(/^\/f\/?/, '')).replace(/\/+$/, '');
  const found = TOKEN.test(token) ? findForm(db, token) : null;
  let result;
  if (!found) {
    result = page(
      'Form unavailable',
      `<main class="form-card"><div class="done"><i class="fa-solid fa-link-slash" style="color:var(--text-3)"></i>
        <h1>This form is closed</h1><p>The link may have expired or the form was removed.</p></div>
        <div class="brandline"><i class="fa-solid fa-cloud"></i> Powered by CoolCloud</div></main>`,
      404
    );
  } else {
    result = { status: 200, html: renderPage(found.form, token) };
  }
  res.writeHead(result.status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(result.html);
}

export function registerPublicForms(router) {
  router.post('/api/public/forms/:token', async (ctx) => {
    const token = String(ctx.params.token || '');
    if (!TOKEN.test(token)) return sendJson(ctx.res, 404, { error: 'This form is closed' });
    const ip = String(ctx.req.headers['x-forwarded-for'] || ctx.req.socket.remoteAddress || '').split(',')[0].trim();
    if (!rateOk(token, ip)) return sendJson(ctx.res, 429, { error: 'Too many submissions. Wait a few minutes.' });

    const found = findForm(ctx.db, token);
    if (!found) return sendJson(ctx.res, 404, { error: 'This form is closed' });
    const payload = await ctx.json(64 * 1024);
    const values = payload && typeof payload.values === 'object' && payload.values ? payload.values : {};
    const fields = Array.isArray(found.form.fields) ? found.form.fields : [];
    if (!fields.length) return sendJson(ctx.res, 400, { error: 'This form has no questions yet' });

    const clean = {};
    for (const field of fields) {
      if (!field || !field.id) continue;
      if (field.type === 'checkbox') {
        clean[field.id] = Boolean(values[field.id]);
        continue;
      }
      const text = String(values[field.id] ?? '').trim().slice(0, 2000);
      if (field.required && !text) {
        return sendJson(ctx.res, 400, { error: `${field.label || 'A question'} is required` });
      }
      if (text && field.type === 'email' && !EMAIL.test(text)) {
        return sendJson(ctx.res, 400, { error: 'Enter a valid email address' });
      }
      if (text && field.type === 'number' && !Number.isFinite(Number(text))) {
        return sendJson(ctx.res, 400, { error: `${field.label || 'A question'} must be a number` });
      }
      if (text && field.type === 'select' && !(field.options || []).includes(text)) {
        return sendJson(ctx.res, 400, { error: `Choose one of the options for ${field.label || 'a question'}` });
      }
      clean[field.id] = text;
    }

    const key = `responses-${found.form.id}`;
    const row = ctx.db
      .prepare('SELECT value FROM app_storage WHERE app_id = ? AND user_id = ? AND key = ?')
      .get(APP, found.userId, key);
    let state = { items: [] };
    if (row) {
      try {
        state = JSON.parse(readValue(row.value) || '{}');
      } catch {
        state = { items: [] };
      }
    }
    if (!Array.isArray(state.items)) state.items = [];
    if (state.items.length >= MAX_RESPONSES) {
      return sendJson(ctx.res, 429, { error: 'This form is not accepting more responses' });
    }
    state.items.push({ id: crypto.randomUUID(), at: nowISO(), values: clean });
    const value = writeValue(JSON.stringify(state));
    if (Buffer.byteLength(value) > 190 * 1024) {
      return sendJson(ctx.res, 507, { error: 'This form is full' });
    }
    if (row) {
      ctx.db
        .prepare('UPDATE app_storage SET value = ?, updated_at = ? WHERE app_id = ? AND user_id = ? AND key = ?')
        .run(value, nowISO(), APP, found.userId, key);
    } else {
      ctx.db
        .prepare('INSERT INTO app_storage (app_id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(APP, found.userId, key, value, nowISO());
    }
    appendLog(ctx.paths.accessLog, `forms: response for ${found.form.id}`);
    sendJson(ctx.res, 200, { ok: true });
  });
}
