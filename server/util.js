import fs from 'node:fs';
import path from 'node:path';

export const nowISO = () => new Date().toISOString();

export function splitList(value) {
  if (!value) return [];
  return String(value).split(/[,;\s]+/).filter(Boolean);
}

/** Resolve a user-supplied relative path inside a base directory, rejecting escapes. */
export function safeJoin(base, rel = '') {
  const cleaned = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const root = path.resolve(base);
  const full = path.resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + path.sep)) {
    const err = new Error('Path is outside the workspace');
    err.code = 'EPATH';
    err.status = 400;
    throw err;
  }
  return full;
}

export function relFrom(base, full) {
  return path.relative(base, full).split(path.sep).join('/');
}

export function humanBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'css', 'scss',
  'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bash',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql', 'csv', 'tsv', 'log', 'svg', 'dockerfile'
]);

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic']);
export const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv']);
export const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
export const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);

export function extOf(name = '') {
  const base = name.toLowerCase();
  if (base === 'dockerfile' || base === '.env' || base === 'makefile') return base.replace('.', '');
  const i = base.lastIndexOf('.');
  return i === -1 ? '' : base.slice(i + 1);
}

export function isTextName(name) {
  const ext = extOf(name);
  return TEXT_EXT.has(ext) || ext === '';
}

export function fileKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'zip' || ext === 'tar' || ext === 'gz' || ext === '7z' || ext === 'rar') return 'archive';
  if (isTextName(name)) return 'text';
  return 'file';
}

export const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
};

export function mimeFor(file) {
  return MIME[extOf(file)] || 'application/octet-stream';
}

export function walkFiles(dir, { maxFiles = 6000, maxDepth = 12, skipDirs = new Set(['node_modules', '.git', 'data']), filter = null } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const visit = (current, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        if (!filter || filter(full, entry.name)) out.push(full);
      }
    }
  };
  visit(dir, 0);
  return out;
}

export function dirSize(dir, { maxFiles = 40000 } = {}) {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length && count < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          count++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

export function slugify(value, fallback = 'item') {
  return (
    String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || fallback
  );
}

export function jsonParseSafe(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function colorFromString(value = '') {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}
