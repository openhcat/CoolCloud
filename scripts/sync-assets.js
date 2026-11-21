#!/usr/bin/env node
/**
 * Vendors Font Awesome and Inter into web/vendor so a CoolCloud
 * instance needs no CDN and works on a private network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(ROOT, 'web', 'vendor');

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

const faRoot = path.join(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free');
let ok = true;
if (fs.existsSync(faRoot)) {
  fs.mkdirSync(path.join(vendor, 'fa', 'css'), { recursive: true });
  fs.copyFileSync(path.join(faRoot, 'css', 'all.min.css'), path.join(vendor, 'fa', 'css', 'all.min.css'));
  copyDir(path.join(faRoot, 'webfonts'), path.join(vendor, 'fa', 'webfonts'));
  console.log('Font Awesome -> web/vendor/fa');
} else {
  console.warn('Font Awesome is not installed (npm install @fortawesome/fontawesome-free)');
  ok = false;
}

const interRoot = path.join(ROOT, 'node_modules', '@fontsource-variable', 'inter', 'files');
if (fs.existsSync(interRoot)) {
  const files = fs.readdirSync(interRoot).filter((name) => name.endsWith('.woff2'));
  copyDir(interRoot, path.join(vendor, 'fonts', 'files'));
  const pick =
    files.find((name) => /^inter-latin-wght-normal\.woff2$/.test(name)) ||
    files.find((name) => name.includes('latin') && name.includes('wght') && name.includes('normal')) ||
    files[0];
  const css = `/* Inter Variable, vendored locally. */
@font-face {
  font-family: 'Inter Variable';
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url('./files/${pick}') format('woff2');
}
`;
  fs.mkdirSync(path.join(vendor, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(vendor, 'fonts', 'inter.css'), css);
  console.log(`Inter -> web/vendor/fonts (${pick})`);
} else {
  console.warn('Inter is not installed (npm install @fontsource-variable/inter)');
  ok = false;
}

process.exit(ok ? 0 : 0);
