import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

/** Buffered line reader shared by the SMTP client. */
class LineClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\r\n')) >= 0) {
        this.lines.push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 2);
      }
      this.pump();
    });
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
  }

  finish() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()(null);
  }

  pump() {
    while (this.waiters.length && this.lines.length) {
      this.waiters.shift()(this.lines.shift());
    }
  }

  readLine(timeout = 20000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async readReply(timeout = 20000) {
    const first = await this.readLine(timeout);
    if (first === null) throw new Error('The mail server did not answer in time');
    const code = first.slice(0, 3);
    const lines = [first];
    if (first[3] === '-') {
      for (;;) {
        const line = await this.readLine(timeout);
        if (line === null) break;
        lines.push(line);
        if (line.startsWith(`${code} `)) break;
      }
    }
    return { code: Number(code), lines };
  }
}

function connectSocket(host, port, secure, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, timeout);
    const done = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.once(secure ? 'secureConnect' : 'connect', done);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Cannot reach ${host}:${port} — ${err.message}`));
    });
  });
}

function escapeHeader(value) {
  const clean = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function buildMessage({ from, to, cc, subject, text, attachments = [] }) {
  const boundary = `cc-${crypto.randomUUID()}`;
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : null,
    `Subject: ${escapeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@coolcloud>`,
    'MIME-Version: 1.0'
  ].filter(Boolean);
  const encode = (value) => Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${encode(text)}`;
  }
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encode(text)}`
  ];
  for (const attachment of attachments) {
    const name = String(attachment.name || 'attachment').replace(/[\r\n"]/g, '_');
    parts.push(
      `--${boundary}\r\nContent-Type: ${attachment.type || 'application/octet-stream'}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${String(attachment.data || '').replace(/(.{1,76})/g, '$1\r\n')}`
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/**
 * Send one message through a user-supplied SMTP server.
 * smtp: { host, port, secure, user, pass, from }
 */
export async function sendMail(smtp, message) {
  if (!smtp || !smtp.host) throw new Error('No SMTP server configured');
  const port = Number(smtp.port || (smtp.secure ? 465 : 587));
  let socket = await connectSocket(smtp.host, port, Boolean(smtp.secure));
  let client = new LineClient(socket);
  let greeting = await client.readReply();
  if (greeting.code !== 220) throw new Error(`SMTP refused the connection: ${greeting.lines.join(' ')}`);

  const command = async (line, expect) => {
    socket.write(`${line}\r\n`);
    const reply = await client.readReply();
    if (expect && reply.code !== expect) {
      throw new Error(`SMTP ${line.split(' ')[0]} failed (${reply.code}): ${reply.lines.join(' ')}`);
    }
    return reply;
  };

  const hostname = os.hostname().replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost';
  let ehlo = await command(`EHLO ${hostname}`, 250);
  let capabilities = ehlo.lines.join('\n').toUpperCase();

  if (!smtp.secure && capabilities.includes('STARTTLS')) {
    socket.write('STARTTLS\r\n');
    const reply = await client.readReply();
    if (reply.code !== 220) throw new Error(`STARTTLS refused: ${reply.lines.join(' ')}`);
    socket = await new Promise((resolve, reject) => {
      const upgraded = tls.connect({ socket, servername: smtp.host, rejectUnauthorized: false }, () => resolve(upgraded));
      upgraded.once('error', reject);
    });
    client = new LineClient(socket);
    ehlo = await command(`EHLO ${hostname}`, 250);
    capabilities = ehlo.lines.join('\n').toUpperCase();
  }

  if (smtp.user) {
    if (!capabilities.includes('AUTH')) {
      // Some servers still accept AUTH; try and report their answer.
    }
    socket.write('AUTH LOGIN\r\n');
    const authStart = await client.readReply();
    if (authStart.code !== 334) {
      const plain = Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass || ''}`, 'utf8').toString('base64');
      await command(`AUTH PLAIN ${plain}`, 235);
    } else {
      await command(Buffer.from(smtp.user, 'utf8').toString('base64'), 334);
      await command(Buffer.from(smtp.pass || '', 'utf8').toString('base64'), 235);
    }
  }

  const from = message.from || smtp.from || smtp.user;
  const to = [].concat(message.to || []).filter(Boolean);
  const cc = [].concat(message.cc || []).filter(Boolean);
  if (!from) throw new Error('No sender address configured');
  if (!to.length) throw new Error('Add at least one recipient');

  await command(`MAIL FROM:<${from}>`, 250);
  for (const rcpt of [...to, ...cc]) {
    await command(`RCPT TO:<${rcpt}>`, 250);
  }
  await command('DATA', 354);
  const payload = buildMessage({ from, to, cc, subject: message.subject || '', text: message.text || '', attachments: message.attachments || [] });
  socket.write(`${payload.replace(/^\./gm, '..')}\r\n.\r\n`);
  const accepted = await client.readReply();
  if (accepted.code !== 250) throw new Error(`Message rejected: ${accepted.lines.join(' ')}`);
  socket.write('QUIT\r\n');
  socket.end();
  return { accepted: [...to, ...cc], from };
}

/* ------------------------------------------------------------------ */
/* IMAP reading (best effort, tolerant parser)                         */
/* ------------------------------------------------------------------ */

class RawClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.pump();
    });
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
  }
  finish() {
    this.closed = true;
    this.pump();
  }
  pump() {
    if (this.pending) {
      const { check, resolve } = this.pending;
      const value = check();
      if (value !== undefined) {
        this.pending = null;
        resolve(value);
      }
    }
  }
  waitFor(check) {
    const value = check();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => {
      this.pending = { check, resolve };
    });
  }
  readReply() {
    return this.waitFor(() => {
      const match = /(\r\n)?([A-Za-z0-9]+) (OK|NO|BAD)([^\r\n]*)\r\n/.exec(this.buffer);
      const tagged = /^([A-Za-z0-9]+) (OK|NO|BAD)/m.exec(this.buffer);
      if (tagged) {
        const consumed = tagged.index + tagged[0].length;
        const head = this.buffer.slice(0, consumed);
        this.buffer = this.buffer.slice(consumed);
        return { raw: head, status: tagged[2] };
      }
      return undefined;
    });
  }
  readUntilTag(tag, timeout = 20000) {
    return this.waitFor(() => {
      const regex = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)(\\r\\n)?`);
      const match = regex.exec(this.buffer);
      if (match) {
        const end = match.index + match[0].length;
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        return { raw, status: match[2] };
      }
      return undefined;
    }, timeout);
  }
}

function quoteImap(value) {
  return `"${String(value || '').replace(/(["\\])/g, '\\$1')}"`;
}

function decodeHeaderValue(value) {
  return String(value || '')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'))
    .replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, q) => Buffer.from(q.replace(/_/g, ' '), 'utf8').toString('utf8'))
    .replace(/\r\n\s+/g, ' ')
    .trim();
}

async function imapConnect(imap) {
  if (!imap || !imap.host) throw new Error('No IMAP server configured');
  const port = Number(imap.port || (imap.secure === false ? 143 : 993));
  const socket = await connectSocket(imap.host, port, imap.secure !== false);
  let client = new RawClient(socket);
  const greeting = await client.readReply();
  if (!greeting || !/OK/i.test(greeting.raw)) throw new Error('IMAP server did not greet us');
  let counter = 0;
  const next = () => `a${++counter}`;
  let tag = next();
  socket.write(`${tag} LOGIN ${quoteImap(imap.user)} ${quoteImap(imap.pass)}\r\n`);
  let reply = await client.readUntilTag(tag);
  if (reply.status !== 'OK') throw new Error(`IMAP login failed: ${reply.raw.split('\r\n').pop()}`);
  tag = next();
  socket.write(`${tag} SELECT INBOX\r\n`);
  reply = await client.readUntilTag(tag);
  if (reply.status !== 'OK') throw new Error('Cannot open INBOX');
  return { socket, client, next, tag };
}

function parseHeaderBlock(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match) out[match[1].toLowerCase()] = match[2];
  }
  return out;
}

/** Fetch the newest messages in INBOX (headers only). */
export async function fetchInbox(imap, { limit = 20 } = {}) {
  const { socket, client, next } = await imapConnect(imap);
  try {
    const searchTag = next();
    socket.write(`${searchTag} UID SEARCH ALL\r\n`);
    const search = await client.readUntilTag(searchTag);
    const uids = (search.raw.match(/\b\d+\b/g) || []).map(Number).filter((n) => n > 0);
    const wanted = uids.slice(-Math.max(1, Math.min(50, Number(limit) || 20)));
    if (!wanted.length) return { messages: [] };
    const fetchTag = next();
    socket.write(
      `${fetchTag} UID FETCH ${wanted.join(',')} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])\r\n`
    );
    const fetched = await client.readUntilTag(fetchTag);
    const messages = [];
    const blocks = fetched.raw.split(/\* \d+ FETCH /).slice(1);
    for (const block of blocks) {
      const uid = /\bUID (\d+)/.exec(block);
      if (!uid) continue;
      const flags = /\bFLAGS \(([^)]*)\)/.exec(block);
      const literal = /\{(\d+)\}\r\n/.exec(block);
      let headers = {};
      if (literal) {
        const start = literal.index + literal[0].length;
        headers = parseHeaderBlock(block.slice(start, start + Number(literal[1])));
      }
      messages.push({
        uid: Number(uid[1]),
        from: decodeHeaderValue(headers.from || ''),
        to: decodeHeaderValue(headers.to || ''),
        subject: decodeHeaderValue(headers.subject || '(no subject)'),
        date: headers.date || '',
        seen: Boolean(flags && /\\Seen/i.test(flags[1]))
      });
    }
    messages.reverse();
    return { messages };
  } finally {
    const tag = next();
    try {
      socket.write(`${tag} LOGOUT\r\n`);
      socket.end();
    } catch {
      /* ignore */
    }
  }
}

/** Fetch one message body by UID. */
export async function fetchMessage(imap, uid) {
  const { socket, client, next } = await imapConnect(imap);
  try {
    const tag = next();
    socket.write(`${tag} UID FETCH ${Number(uid)} (BODY.PEEK[TEXT])\r\n`);
    const fetched = await client.readUntilTag(tag);
    const literal = /\{(\d+)\}\r\n/.exec(fetched.raw);
    if (!literal) return { text: '' };
    const start = literal.index + literal[0].length;
    const raw = fetched.raw.slice(start, start + Number(literal[1]));
    const cleaned = raw
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: cleaned.slice(0, 100000) };
  } finally {
    const tag = next();
    try {
      socket.write(`${tag} LOGOUT\r\n`);
      socket.end();
    } catch {
      /* ignore */
    }
  }
}
