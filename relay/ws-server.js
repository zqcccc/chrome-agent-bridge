// 极简 WebSocket 服务端实现（零依赖）
// 支持：文本帧、二进制帧、分片消息（按 FIN 组装）、ping/pong、close、64-bit 长度（大 payload，如截图）
//
// 历史坑（v0.3.11 修复）：continuation 帧被当成独立消息 emit，于是分片传输的一条 JSON
// 被上层拆成 `{"ok":` 和 `true}` 两条，两边 JSON.parse 都失败 → **静默丢弃**。
// 上层只看到「扩展没响应」，排查方向完全跑偏。现在按 RFC 6455 组装到 FIN 才交付。
"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// 上限（均可用环境变量覆盖，测试里会调小以稳定复现）：
// 单条消息（含所有分片累计）最大 16MB —— 与 host.js 的 native frame 上限保持一致，
// 避免「native 通道拒绝、WS 通道接受」这种通道间不一致。
const MAX_MESSAGE_BYTES = Number(process.env.WS_MAX_MESSAGE_BYTES) || 16 * 1024 * 1024;
// 单条消息最多允许的分片数：防止「无数个 1 字节分片」把内存/CPU 拖死。
const MAX_FRAGMENTS = Number(process.env.WS_MAX_FRAGMENTS) || 4096;
// 发送侧背压硬上限：排队未 flush 的字节超过它就直接断开慢消费者。
// 原实现明确忽略 write() 的 false 返回值（"backpressure，无所谓"），慢连接会把
// host 的内存吃光（截图广播尤其危险）。
const MAX_BUFFERED_BYTES = Number(process.env.WS_MAX_BUFFERED_BYTES) || 8 * 1024 * 1024;
// 协议错误一律关闭连接（RFC 6455 §5.4）；_protocolErrors 仅作计数/诊断用。

const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const KNOWN_OPCODES = new Set(Object.values(OPCODE));

// 关闭码（RFC 6455 §7.4.1）
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_BIG = 1009;
const CLOSE_TRY_AGAIN = 1013;

/**
 * 解析一个帧。返回三选一：
 *   { need }                        —— 数据不够，等更多字节
 *   { error: { code, reason } }     —— 协议错误，调用方应关闭连接
 *   { fin, opcode, masked, payload, consumed }
 * 注意：masked 只如实上报，是否强制要求由调用方决定（服务端必须要求客户端 mask）。
 */
function decodeFrame(buf, opts = {}) {
  const maxMessageBytes = opts.maxMessageBytes || MAX_MESSAGE_BYTES;
  if (buf.length < 2) return { need: 2 - buf.length };
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  // RSV1-3 必须为 0：我们没有协商任何扩展（permessage-deflate 等）。
  // 原实现直接忽略这三位，遇到压缩帧会把 deflate 数据当 JSON 解析 → 静默丢弃。
  if ((b0 & 0x70) !== 0) return { error: { code: CLOSE_PROTOCOL_ERROR, reason: "RSV bits must be 0 (no extension negotiated)" } };
  const opcode = b0 & 0x0f;
  if (!KNOWN_OPCODES.has(opcode)) return { error: { code: CLOSE_PROTOCOL_ERROR, reason: `unknown opcode ${opcode}` } };
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
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { error: { code: CLOSE_TOO_BIG, reason: "frame length overflow" } };
    len = Number(big);
    offset = 10;
  }
  const isControl = (opcode & 0x8) !== 0;
  // 控制帧必须 FIN=1 且 payload ≤125，且不得分片（RFC 6455 §5.5）。
  if (isControl && (!fin || len > 125)) return { error: { code: CLOSE_PROTOCOL_ERROR, reason: "invalid control frame" } };
  // 先按声明长度拒绝超大帧，避免为「声称 1GB」的帧一直攒缓冲。
  if (len > maxMessageBytes) return { error: { code: CLOSE_TOO_BIG, reason: `frame too large (${len} > ${maxMessageBytes})` } };
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
  return { fin, opcode, masked, payload, consumed: offset + len };
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

/** 构造 close 帧：2 字节大端状态码 + 可选原因（UTF-8，≤123 字节）。 */
function closeFrame(code, reason) {
  const r = Buffer.from(String(reason || "").slice(0, 123), "utf8");
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  return encodeFrame(OPCODE.CLOSE, payload);
}

class WSConnection extends EventEmitter {
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this._closeEmitted = false;
    // 分片组装状态：{ opcode, chunks, size, count }
    this._frag = null;
    this._protocolErrors = 0;
    this._buffered = 0;             // 已排队但尚未 flush 的发送字节数
    this._closeSent = false;
    this.maxMessageBytes = opts.maxMessageBytes || MAX_MESSAGE_BYTES;
    this.maxBufferedBytes = opts.maxBufferedBytes || MAX_BUFFERED_BYTES;
    this.maxFragments = opts.maxFragments || MAX_FRAGMENTS;
    // 服务端默认要求客户端 mask（RFC 6455 §5.1）。测试里会用 requireMask:false 放宽。
    this.requireMask = opts.requireMask !== false;
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
    this._frag = null;
    this.buffer = Buffer.alloc(0);
    try { this.socket.destroy(); } catch (e) { /* noop */ }
    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit("close");
    }
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = decodeFrame(this.buffer, { maxMessageBytes: this.maxMessageBytes });
      if (frame.need !== undefined) {
        // 帧头都没凑齐时也可能已经在攒一个超大的分片消息：这里兜一层总缓冲上限
        if (this.buffer.length > this.maxMessageBytes + 14) return this._protocolError(CLOSE_TOO_BIG, "inbound buffer overflow");
        return;
      }
      if (frame.error) return this._protocolError(frame.error.code, frame.error.reason);
      this.buffer = this.buffer.slice(frame.consumed);
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** 交付一条**完整**消息（分片已按 FIN 组装）。 */
  _deliver(opcode, payload) {
    if (opcode === OPCODE.TEXT) this.emit("message", payload.toString("utf8"));
    else this.emit("binary", payload);
    this.emit("frame", { opcode, payload });
  }

  _handleFrame(frame) {
    // 服务端必须要求客户端 mask（RFC 6455 §5.1）。这是**立即致命**的：不能容忍几次，
    // 因为 unmasked 客户端几乎必然是「手写协议实现」，它后续的帧同样不可信。
    if (this.requireMask && !frame.masked) {
      this.emit("protocolerror", { code: CLOSE_PROTOCOL_ERROR, reason: "client frames must be masked", count: 1 });
      this._sendClose(CLOSE_PROTOCOL_ERROR, "client frames must be masked");
      return this._finish();
    }
    switch (frame.opcode) {
      case OPCODE.CONT: {
        // continuation 必须前有分片起点
        if (!this._frag) return this._protocolError(CLOSE_PROTOCOL_ERROR, "unexpected continuation frame");
        this._frag.chunks.push(frame.payload);
        this._frag.size += frame.payload.length;
        this._frag.count += 1;
        if (this._frag.size > this.maxMessageBytes) return this._protocolError(CLOSE_TOO_BIG, "fragmented message too large");
        if (this._frag.count > this.maxFragments) return this._protocolError(CLOSE_TOO_BIG, "too many fragments");
        if (frame.fin) {
          const f = this._frag;
          this._frag = null;
          this._deliver(f.opcode, Buffer.concat(f.chunks, f.size));
        }
        break;
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        // 分片未结束时不得插入新的数据帧（控制帧可以，见下）
        if (this._frag) return this._protocolError(CLOSE_PROTOCOL_ERROR, "new data frame while fragmented message in progress");
        if (!frame.fin) {
          if (frame.payload.length > this.maxMessageBytes) return this._protocolError(CLOSE_TOO_BIG, "fragmented message too large");
          this._frag = { opcode: frame.opcode, chunks: [frame.payload], size: frame.payload.length, count: 1 };
          break;
        }
        this._deliver(frame.opcode, frame.payload);
        break;
      }
      case OPCODE.CLOSE: {
        // 回显对端关闭码（无 payload 时用 1000）。不解析对端原因文本，避免回显不可信内容。
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0x03e8;
        this._sendClose(code, "");
        this._finish();
        break;
      }
      case OPCODE.PING:
        // 控制帧可以插在分片中间：这里只回 pong，不动 _frag
        this._write(encodeFrame(OPCODE.PONG, frame.payload));
        break;
      case OPCODE.PONG:
        this.emit("pong", frame.payload);
        break;
      default:
        return this._protocolError(CLOSE_PROTOCOL_ERROR, `unhandled opcode ${frame.opcode}`);
    }
  }

  /**
   * 协议错误：记一次，然后**关闭连接**。
   *
   * 为什么立即关闭而不是容忍几次：RFC 6455 §5.4 要求收到协议错误后关闭连接
   * （Fail the WebSocket Connection）。继续用同一个流也靠不住——帧边界已经失去
   * 同步，后面解析出的都是垃圾。以前这些帧被静默忽略，表现为「连上了但从不响应」。
   */
  _protocolError(code, reason) {
    this._protocolErrors += 1;
    this.emit("protocolerror", { code, reason, count: this._protocolErrors });
    this._sendClose(code, reason);
    this._finish();
  }

  _sendClose(code, reason) {
    if (this._closeSent) return;
    this._closeSent = true;
    try { this.socket.write(closeFrame(code, reason)); } catch (e) { /* noop */ }
  }

  /**
   * 带背压记账的写入。返回 false 表示连接已被判定为不可用/慢消费者。
   * 原实现忽略 write() 的返回值，慢连接会把待发送字节无限堆在 host 内存里。
   */
  _write(data, cb) {
    if (this.closed) return false;
    const sock = this.socket;
    if (!sock || sock.destroyed || !sock.writable) { this._finish(); return false; }
    this._buffered += data.length;
    if (this._buffered > this.maxBufferedBytes) {
      // 慢消费者：不无限缓冲，直接断开（1013 = Try Again Later）。断开是可见事实，
      // 比静默丢消息或吃光内存都诚实。
      this._protocolError(CLOSE_TRY_AGAIN, "send buffer overflow (slow consumer)");
      this._sendClose(CLOSE_TRY_AGAIN, "send buffer overflow");
      this._finish();
      return false;
    }
    try {
      sock.write(data, (err) => {
        this._buffered -= data.length;
        if (this._buffered < 0) this._buffered = 0;
        if (err) this._finish();
      });
      return true;
    } catch (e) {
      this._buffered -= data.length;
      this._finish();
      return false;
    }
  }

  sendText(text) {
    return this._write(encodeFrame(OPCODE.TEXT, text));
  }

  sendBinary(buf) {
    return this._write(encodeFrame(OPCODE.BINARY, buf));
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj));
  }

  /** 待发送（已排队未 flush）字节数，供 /status 与测试观察背压。 */
  get bufferedBytes() { return this._buffered; }

  close(code = 0x03e8, reason = "") {
    if (this.closed) return;
    this._sendClose(code, reason);
    this._finish();
  }
}

// 在 http.Server 上挂 WebSocket 升级处理
// routes: [{ path, token, onConnection(ws, req), requireMask?, maxMessageBytes? }]
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
    const ws = new WSConnection(socket, {
      requireMask: route.requireMask !== false,
      maxMessageBytes: route.maxMessageBytes,
      maxBufferedBytes: route.maxBufferedBytes,
      maxFragments: route.maxFragments,
    });
    route.onConnection(ws, req);
  });
}

module.exports = {
  attachWsServer, WSConnection, encodeFrame, decodeFrame, closeFrame,
  OPCODE, MAX_MESSAGE_BYTES, MAX_FRAGMENTS, MAX_BUFFERED_BYTES,
};
