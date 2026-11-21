import { appendLog } from './config.js';

export function attachLog(paths, message) {
  appendLog(paths.errorLog, message);
}

export function accessLog(paths, message) {
  appendLog(paths.accessLog, message);
}
