// 生成插件 logo.png（256x256，纯 Node 实现，无需第三方依赖）
// 用法：node scripts/gen-logo.js
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 256 // 输出尺寸
const SS = 4 // 4x 超采样抗锯齿
const W = SIZE * SS
const px = Buffer.alloc(W * W * 4)

function fillRoundRect(x, y, w, h, r, top, bottom) {
  const cx = x + w / 2
  const cy = y + h / 2
  const hw = w / 2
  const hh = h / 2
  const rr = Math.min(r, hw, hh)
  for (let iy = y; iy < y + h; iy++) {
    const t = (iy - y) / h
    const cr = Math.round(top[0] + (bottom[0] - top[0]) * t)
    const cg = Math.round(top[1] + (bottom[1] - top[1]) * t)
    const cb = Math.round(top[2] + (bottom[2] - top[2]) * t)
    for (let ix = x; ix < x + w; ix++) {
      const dx = Math.max(Math.abs(ix - cx) - (hw - rr), 0)
      const dy = Math.max(Math.abs(iy - cy) - (hh - rr), 0)
      if (dx * dx + dy * dy <= rr * rr) {
        const o = (iy * W + ix) * 4
        px[o] = cr
        px[o + 1] = cg
        px[o + 2] = cb
        px[o + 3] = 255
      }
    }
  }
}

function fillRect(x, y, w, h, rgba) {
  for (let iy = y; iy < y + h; iy++) {
    for (let ix = x; ix < x + w; ix++) {
      const o = (iy * W + ix) * 4
      px[o] = rgba[0]
      px[o + 1] = rgba[1]
      px[o + 2] = rgba[2]
      px[o + 3] = rgba[3]
    }
  }
}

function fillRing(cx, cy, r, thick, rgba) {
  const half = thick / 2
  for (let iy = Math.floor(cy - r - half); iy <= Math.ceil(cy + r + half); iy++) {
    for (let ix = Math.floor(cx - r - half); ix <= Math.ceil(cx + r + half); ix++) {
      const d = Math.hypot(ix - cx, iy - cy)
      if (Math.abs(d - r) <= half) {
        const o = (iy * W + ix) * 4
        px[o] = rgba[0]
        px[o + 1] = rgba[1]
        px[o + 2] = rgba[2]
        px[o + 3] = rgba[3]
      }
    }
  }
}

const s = (v) => v * SS
const WHITE = [255, 255, 255, 255]
const TOP = [0x4e, 0x8c, 0xff]
const BOTTOM = [0x2b, 0x5b, 0xe6]

// 1. 蓝色渐变圆角方形背景
fillRoundRect(s(20), s(24), s(216), s(216), s(52), TOP, BOTTOM)

// 2. 四角白色"取景框"角标
const inset = s(34)
const arm = s(46)
const thick = s(13)
// 左上
fillRect(inset, inset, arm, thick, WHITE)
fillRect(inset, inset, thick, arm, WHITE)
// 右上
fillRect(s(256) - inset - arm, inset, arm, thick, WHITE)
fillRect(s(256) - inset - thick, inset, thick, arm, WHITE)
// 左下
fillRect(inset, s(256) - inset - thick, arm, thick, WHITE)
fillRect(inset, s(256) - inset - arm, thick, arm, WHITE)
// 右下
fillRect(s(256) - inset - arm, s(256) - inset - thick, arm, thick, WHITE)
fillRect(s(256) - inset - thick, s(256) - inset - arm, thick, arm, WHITE)

// 3. 中心快门圆环
fillRing(s(128), s(132), s(28), s(9), WHITE)

// 4. 超采样降采样
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const o = ((y * SS + dy) * W + x * SS + dx) * 4
        r += px[o]
        g += px[o + 1]
        b += px[o + 2]
        a += px[o + 3]
      }
    }
    const n = SS * SS
    const o = (y * SIZE + x) * 4
    out[o] = Math.round(r / n)
    out[o + 1] = Math.round(g / n)
    out[o + 2] = Math.round(b / n)
    out[o + 3] = Math.round(a / n)
  }
}

// ---------- PNG 编码 ----------
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function pngEncode(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const target = path.join(__dirname, '..', 'logo.png')
fs.writeFileSync(target, pngEncode(SIZE, SIZE, out))
console.log('written:', target, `${out.length / 1024}KB raw`)
