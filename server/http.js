import fs from 'node:fs';
import path from 'node:path';
import { mimeFor } from './util.js';

export const MAX_JSON = 2 * 1024 * 1024;

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sendJson(res, status, data, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(text);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

export function readBody(req, max = MAX_JSON) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, max = MAX_JSON) {
  const body = await readBody(req, max);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function splitParts(p) {
  return p.split('/').filter(Boolean);
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, parts: splitParts(pattern), handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  patch(p, h) {
    return this.add('PATCH', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  match(method, pathname) {
    const parts = splitParts(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const pattern = route.parts[i];
        if (pattern.startsWith(':')) {
          try {
            params[pattern.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        } else if (pattern !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

export function serveFile(req, res, filePath, { download = false, cache = 'no-cache', contentType = null } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }
  const type = contentType || mimeFor(filePath);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString()
  };
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath).replace(/"/g, '')}"`;
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      let start = match[1] === '' ? null : Number(match[1]);
      let end = match[2] === '' ? null : Number(match[2]);
      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      }
      start = start ?? 0;
      end = end === null || end >= stat.size ? stat.size - 1 : end;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

export function routeStatic(urlPath, webDir) {
  const cleaned = urlPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;
  const full = path.resolve(webDir, cleaned);
  if (!full.startsWith(path.resolve(webDir) + path.sep)) return null;
  return full;
}

export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isLocalNetwork(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const lan = ip.match(/^172\.(\d+)\./);
  if (lan && Number(lan[1]) >= 16 && Number(lan[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
}

export function ipOf(req) {
  const remote = (req.socket.remoteAddress || '').replace('::ffff:', '');
  // Trust a forwarding header only when the request came from this machine or
  // the local network (a reverse proxy). Trusting it from any client would let
  // a caller spoof their IP, bypassing sign-in throttling and polluting logs.
  const forwarded = req.headers['x-forwarded-for'];
  if (isLocalNetwork(remote) && typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return remote;
}
