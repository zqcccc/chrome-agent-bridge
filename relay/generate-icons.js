// 生成扩展图标（纯 Node，零依赖：手写 PNG 编码）
// 图案：品牌蓝圆角方块 + 白色桥接符号（两个圆点 + 连接弧线）
"use strict";
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y * size + x];
      const off = y * (size * 4 + 1) + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 绘制 ----
function draw(size) {
  const px = [];
  const s = size;
  const bg = [47, 84, 235, 255];      // #2f54eb
  const white = [255, 255, 255, 255];
  const radius = s * 0.22;
  const inR = (x, y, cx, cy, r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;

  // 圆角矩形背景
  const inRoundRect = (x, y) => {
    const w = s, h = s;
    if (x >= radius && x < w - radius) return y >= 0 && y < h;
    if (y >= radius && y < h - radius) return x >= 0 && x < w;
    // 四角
    const corners = [
      [radius, radius], [w - 1 - radius, radius],
      [radius, h - 1 - radius], [w - 1 - radius, h - 1 - radius],
    ];
    return corners.some(([cx, cy]) => inR(x, y, cx, cy, radius));
  };

  // 桥接符号：两个圆点 + 顶部弧线
  const dotR = s * 0.075;
  const dotY = s * 0.66;
  const dx = s * 0.225;
  const cy1 = s * 0.42;
  const arcR = s * 0.30;
  const arcW = Math.max(1.5, s * 0.055);

  const onDot = (x, y) => inR(x, y, s * 0.5 - dx, dotY, dotR) || inR(x, y, s * 0.5 + dx, dotY, dotR);
  const onArc = (x, y) => {
    const d = Math.hypot(x - s * 0.5, y - cy1);
    return Math.abs(d - arcR) <= arcW && y <= cy1 + 2 && x >= s * 0.5 - arcR - 2 && x <= s * 0.5 + arcR + 2;
  };

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (!inRoundRect(x, y)) { px.push([0, 0, 0, 0]); continue; }
      if (onDot(x, y) || onArc(x, y)) px.push(white);
      else px.push(bg);
    }
  }
  return px;
}

const outDir = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), encodePNG(size, draw(size)));
  console.log(`icon${size}.png written`);
}
