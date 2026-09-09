// 极简 WebSocket 服务端实现（零依赖）
// 支持：文本帧、ping/pong、close、64-bit 长度（大 payload，如截图）
"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function decodeFrame(buf) {
  if (buf.length < 2) return { need: 2 - buf.length };
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return { need: 4 - buf.length };
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return { need: 10 - buf.length };
    const big = buf.readBigUInt64BE(2);
    len = Number(big);
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return { need: offset + 4 - buf.length };
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return { need: offset + len - buf.length };
  let payload = buf.slice(offset, offset + len);
  if (masked && maskKey) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
    payload = unmasked;
  }
  return { fin, opcode, payload, consumed: offset + len };
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this._closeEmitted = false;
    socket.on("data", (chunk) => this._onData(chunk));
    // close 与 error 可能同时触发；保证只 emit 一次 close，且始终有 error handler
    socket.on("close", () => this._finish());
    socket.on("error", (e) => {
      // ECONNRESET / EPIPE 等：记录后走 close 路径，不抛 uncaughtException
      this.emit("wserror", e);
      this._finish();
    });
  }

  // 幂等：close 只 emit 一次。避免重复 reject / 重复广播。
  _finish() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* noop */ }
    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit("close");
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (frame.need !== undefined) break; // 等更多数据
      this.buffer = this.buffer.slice(frame.consumed);
      this._handleFrame(frame);
      if (this.closed) break;
    }
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case 0x0: // continuation
      case 0x1: // text
        this.emit("message", frame.payload.toString("utf8"));
        break;
      case 0x8: // close
        try { this.socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch (e) { /* noop */ }
        this._finish();
        break;
      case 0x9: // ping
        try { this.socket.write(encodeFrame(0xa, frame.payload)); } catch (e) { /* noop */ }
        break;
      case 0xa: // pong
        break;
      default:
        break;
    }
  }

  sendText(text) {
    if (this.closed) return false;
    const sock = this.socket;
    // 已销毁/不可写时直接 finish，避免 afterWriteDispatched 的 EPIPE 走 uncaughtException
    if (!sock || sock.destroyed || !sock.writable) { this._finish(); return false; }
    try {
      const ok = sock.write(encodeFrame(0x1, text), (err) => {
        if (err) this._finish();
      });
      if (ok === false) { /* backpressure，无所谓 */ }
      return true;
    } catch (e) {
      this._finish();
      return false;
    }
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  close() {
    if (this.closed) return;
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      try { this.socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch (e) { /* noop */ }
    }
    this._finish();
  }
}

// 在 http.Server 上挂 WebSocket 升级处理
// routes: [{ path, token, onConnection(ws) }]
function attachWsServer(server, routes) {
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => { /* 连接异常（如 ECONNRESET）不拖垮整个服务 */ });
    const url = new URL(req.url, "http://localhost");
    const route = routes.find((r) => r.path === url.pathname);
    if (!route) {
      socket.destroy();
      return;
    }
    if (route.token) {
      const given = url.searchParams.get("token") || "";
      if (given !== route.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    if (head && head.length) socket.unshift(head);
    const ws = new WSConnection(socket);
    route.onConnection(ws);
  });
}

module.exports = { attachWsServer, WSConnection, encodeFrame, decodeFrame };
