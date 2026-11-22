import { sendJson } from './http.js';

/**
 * Public pages published by the cc:sitebuilder app.
 *
 * A site is one JSON document in the app's storage. /s/<token> renders it with
 * no session, so the page can be shared like any other website. Enterprise
 * pages also carry the live-chat widget when the owner enabled it.
 */

const APP = 'cc:sitebuilder';
const TOKEN = /^[A-Za-z0-9_-]{12,64}$/;

let vault = null;
try {
  vault = await import('./vault.js');
} catch {
  vault = null;
}
const readValue = (value) => (vault && value ? vault.open(value) : String(value ?? ''));

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const safeHref = (value) => {
  const text = String(value || '').trim();
  return /^(https?:\/\/|mailto:|tel:|\/)/i.test(text) ? text : '#';
};

function findSite(db, token) {
  let rows;
  try {
    rows = db.prepare("SELECT value FROM app_storage WHERE app_id = ? AND key = 'state'").all(APP);
  } catch {
    return null;
  }
  for (const row of rows) {
    let site;
    try {
      site = JSON.parse(readValue(row.value) || '{}');
    } catch {
      continue;
    }
    if (site && site.token === token) return site;
  }
  return null;
}

function blockHtml(block) {
  const align = ['left', 'center', 'right'].includes(block.align) ? block.align : 'left';
  const style = `text-align:${align}`;
  switch (block.type) {
    case 'heading':
      return `<section class="block" style="${style}"><h1>${escapeHtml(block.text || 'A clear headline')}</h1>${
        block.sub ? `<p class="lead">${escapeHtml(block.sub)}</p>` : ''
      }${block.label ? `<a class="cta" href="${escapeHtml(safeHref(block.href))}">${escapeHtml(block.label)}</a>` : ''}</section>`;
    case 'text':
      return `<section class="block" style="${style}"><p class="copy">${escapeHtml(block.text || '').replace(/\n/g, '<br />')}</p></section>`;
    case 'image':
      return block.src
        ? `<section class="block" style="${style}"><img src="${escapeHtml(safeHref(block.src))}" alt="${escapeHtml(block.alt || '')}" loading="lazy" /></section>`
        : '';
    case 'button':
      return `<section class="block" style="${style}"><a class="cta" href="${escapeHtml(safeHref(block.href))}">${escapeHtml(block.label || 'Learn more')}</a></section>`;
    case 'divider':
      return '<section class="block"><hr /></section>';
    case 'spacer':
      return '<section class="block spacer" aria-hidden="true"></section>';
    default:
      return '';
  }
}

function chatWidget(token) {
  return `<div class="cc-chat" id="cc-chat">
    <button class="cc-chat-toggle" id="cc-chat-toggle" type="button" aria-label="Open live chat"><i class="fa-regular fa-comments"></i></button>
    <div class="cc-chat-panel" id="cc-chat-panel" hidden>
      <header><b>Live chat</b><button type="button" id="cc-chat-close" aria-label="Close chat">×</button></header>
      <div class="cc-chat-log" id="cc-chat-log"><p class="cc-chat-hint">Tell us how we can help. We reply here and by email.</p></div>
      <form id="cc-chat-form">
        <input name="name" placeholder="Your name" required maxlength="120" />
        <input name="email" type="email" placeholder="Email" required maxlength="180" />
        <textarea name="message" rows="3" placeholder="How can we help?" required maxlength="2000"></textarea>
        <button type="submit">Send</button>
      </form>
    </div>
  </div>
  <script>
    (function () {
      var token = ${JSON.stringify(token)};
      var ticketId = sessionStorage.getItem('cc-chat-' + token) || '';
      var panel = document.getElementById('cc-chat-panel');
      var log = document.getElementById('cc-chat-log');
      var form = document.getElementById('cc-chat-form');
      function open(show) {
        panel.hidden = !show;
        document.getElementById('cc-chat-toggle').style.display = show ? 'none' : '';
      }
      document.getElementById('cc-chat-toggle').addEventListener('click', function () { open(true); });
      document.getElementById('cc-chat-close').addEventListener('click', function () { open(false); });
      function bubble(text, mine) {
        var node = document.createElement('p');
        node.className = 'cc-chat-msg' + (mine ? ' mine' : '');
        node.textContent = text;
        log.appendChild(node);
        log.scrollTop = log.scrollHeight;
      }
      async function poll() {
        if (!ticketId) return;
        try {
          var response = await fetch('/api/public/sitechat/' + encodeURIComponent(token) + '/' + encodeURIComponent(ticketId), { cache: 'no-store' });
          if (!response.ok) return;
          var data = await response.json();
          log.querySelectorAll('.cc-chat-msg.agent').forEach(function (node) { node.remove(); });
          (data.messages || []).forEach(function (message) { bubble(message.text, false); });
        } catch (error) {
          /* the next poll retries */
        }
      }
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        var data = Object.fromEntries(new FormData(form).entries());
        try {
          var response = await fetch('/api/public/sitechat/' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          var result = await response.json().catch(function () { return {}; });
          if (!response.ok) throw new Error(result.error || 'Could not send');
          ticketId = result.ticketId;
          sessionStorage.setItem('cc-chat-' + token, ticketId);
          bubble(data.message, true);
          form.reset();
          form.hidden = true;
          poll();
          setInterval(poll, 5000);
        } catch (error) {
          bubble(error.message, false);
        }
      });
      if (ticketId) { open(true); form.hidden = true; poll(); setInterval(poll, 5000); }
    })();
  </script>`;
}

function page(site, token, cfg) {
  const theme = site.theme || {};
  const accent = /^#[0-9a-f]{3,8}$/i.test(String(theme.accent || '')) ? theme.accent : '#0b5fb0';
  const background = /^#[0-9a-f]{3,8}$/i.test(String(theme.background || '')) ? theme.background : '#ffffff';
  const chat = cfg && cfg.edition === 'enterprise' && site.chat && site.chat.enabled;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(site.title || 'Website')}</title>
    <meta name="description" content="${escapeHtml(site.description || '')}" />
    <link rel="stylesheet" href="/vendor/fa/css/all.min.css" />
    <link rel="stylesheet" href="/vendor/fonts/inter.css" />
    <style>
      :root { --accent: ${accent}; }
      * { box-sizing: border-box; }
      body { margin: 0; background: ${background}; color: #16202b; font-family: Inter, system-ui, sans-serif; line-height: 1.6; }
      .wrap { max-width: 880px; margin: 0 auto; padding: 56px 22px 80px; }
      .block { margin: 0 0 26px; }
      h1 { font-size: clamp(30px, 5vw, 48px); line-height: 1.1; letter-spacing: -0.03em; margin: 0 0 12px; }
      .lead { font-size: clamp(16px, 2.2vw, 20px); color: #4a5a6a; margin: 0 auto 20px; max-width: 620px; }
      .copy { font-size: 16px; max-width: 680px; margin: 0 auto; white-space: normal; }
      .cta { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; padding: 12px 20px; border-radius: 10px; }
      .cta:hover { filter: brightness(1.08); }
      img { max-width: 100%; height: auto; border-radius: 14px; display: inline-block; }
      hr { border: 0; border-top: 1px solid #e3e8ee; margin: 10px 0; }
      .spacer { height: 40px; }
      footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e3e8ee; color: #7a8898; font-size: 12px; text-align: center; }
      .cc-chat { position: fixed; right: 18px; bottom: 18px; z-index: 50; font-family: Inter, system-ui, sans-serif; }
      .cc-chat-toggle { width: 54px; height: 54px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; font-size: 20px; cursor: pointer; box-shadow: 0 12px 30px rgba(9, 30, 52, 0.25); }
      .cc-chat-panel { width: min(340px, calc(100vw - 36px)); background: #fff; border: 1px solid #dfe5ec; border-radius: 14px; box-shadow: 0 18px 44px rgba(9, 30, 52, 0.24); overflow: hidden; }
      .cc-chat-panel header { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; background: var(--accent); color: #fff; font-size: 13px; }
      .cc-chat-panel header button { border: 0; background: none; color: #fff; font-size: 20px; cursor: pointer; line-height: 1; }
      .cc-chat-log { max-height: 220px; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
      .cc-chat-hint { margin: 0; color: #7a8898; font-size: 12px; }
      .cc-chat-msg { margin: 0; font-size: 12.5px; background: #f2f5f8; border-radius: 8px; padding: 7px 10px; }
      .cc-chat-msg.mine { background: var(--accent); color: #fff; align-self: flex-end; }
      .cc-chat-panel form { display: flex; flex-direction: column; gap: 7px; padding: 0 14px 14px; }
      .cc-chat-panel input, .cc-chat-panel textarea { border: 1px solid #dfe5ec; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 12.5px; }
      .cc-chat-panel form button { border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; padding: 9px; cursor: pointer; }
    </style>
  </head>
  <body>
    <main class="wrap">
      ${(Array.isArray(site.blocks) ? site.blocks : []).map(blockHtml).join('\n')}
      <footer>${escapeHtml(site.footer || cfg?.name || 'CoolCloud')}</footer>
    </main>
    ${chat ? chatWidget(token) : ''}
  </body>
</html>`;
}

export async function servePublishedSite({ req, res, url, db, cfg }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  const token = decodeURIComponent(url.pathname.replace(/^\/s\/?/, '')).replace(/\/+$/, '');
  const site = TOKEN.test(token) ? findSite(db, token) : null;
  if (!site) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:system-ui;padding:40px">This site has not been published.</p>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(page(site, token, cfg));
}
