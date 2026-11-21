import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 2 * 1024 * 1024;

export class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.user = null;
    this.rooms = new Set();
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on('error', () => this.terminate());
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    });
  }

  readFrame() {
    if (this.buffer.length < 2) return null;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const fin = Boolean(b0 & 0x80);
    const opcode = b0 & 0x0f;
    const masked = Boolean(b1 & 0x80);
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      length = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (length > MAX_FRAME) {
      this.close(1009, 'Message too large');
      return null;
    }
    const maskOffset = masked ? 4 : 0;
    if (this.buffer.length < offset + maskOffset + length) return null;
    const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(this.buffer.subarray(offset + maskOffset, offset + maskOffset + length));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buffer = this.buffer.subarray(offset + maskOffset + length);
    return { fin, opcode, payload };
  }

  parse() {
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === 0x8) {
        this.close(1000, '');
        return;
      }
      if (frame.opcode === 0x9) {
        this.sendFrame(0xa, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const data = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          try {
            this.emit('message', JSON.parse(data));
          } catch {
            this.emit('message', data);
          }
        }
      }
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, data]));
    } catch {
      this.terminate();
    }
  }

  send(value) {
    this.sendFrame(0x1, typeof value === 'string' ? value : JSON.stringify(value));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.sendFrame(0x8, payload);
    this.closed = true;
    this.socket.end();
    this.emit('close');
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }
}

/**
 * Minimal RFC 6455 server. `verify(req, url)` returns a user row or null.
 */
export function attachWebSocket(server, { path: wsPath = '/ws', verify, onConnection }) {
  server.on('upgrade', (req, socket) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let user = null;
    try {
      user = verify(req, url);
    } catch {
      user = null;
    }
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const connection = new WSConnection(socket);
    connection.user = user;
    if (onConnection) onConnection(connection, req, url);
  });
}
