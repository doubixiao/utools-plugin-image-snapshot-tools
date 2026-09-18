// 分析截图布局：解码 PNG，输出行主色与区域分布，定位空白区域
const fs = require('node:fs')
const zlib = require('node:zlib')

const file = process.argv[2]
const buf = fs.readFileSync(file)
let pos = 8
const idat = []
let w = 0
let h = 0
let colorType = 0
let bitDepth = 0
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos)
  const type = buf.toString('ascii', pos + 4, pos + 8)
  const data = buf.slice(pos + 8, pos + 8 + len)
  if (type === 'IHDR') {
    w = data.readUInt32BE(0)
    h = data.readUInt32BE(4)
    bitDepth = data[8]
    colorType = data[9]
  }
  if (type === 'IDAT') idat.push(data)
  pos += 12 + len
}
if ((colorType !== 6 && colorType !== 2) || bitDepth !== 8) {
  console.error('不支持的 PNG 格式: colorType=' + colorType + ' bitDepth=' + bitDepth)
  process.exit(1)
}
const bpp = colorType === 6 ? 4 : 3
console.log('尺寸:', w + 'x' + h, '| 每像素', bpp, '字节')

const raw = zlib.inflateSync(Buffer.concat(idat))
const stride = w * bpp
let prev = Buffer.alloc(stride)
let rp = 0
const img = Buffer.alloc(h * stride)

for (let y = 0; y < h; y++) {
  const filter = raw[rp++]
  const cur = Buffer.alloc(stride)
  raw.copy(cur, 0, rp, rp + stride)
  rp += stride
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0
    const b = prev[i]
    const c = i >= bpp ? prev[i - bpp] : 0
    let v = cur[i]
    if (filter === 1) v += a
    else if (filter === 2) v += b
    else if (filter === 3) v += (a + b) >> 1
    else if (filter === 4) {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    cur[i] = v & 255
  }
  cur.copy(img, y * stride)
  prev = cur
}

function px(x, y) {
  const o = y * stride + x * bpp
  return [img[o], img[o + 1], img[o + 2]]
}

// 1) 指定行采样：每行统计出现次数最多的 6 种颜色
console.log('\n-- 行颜色采样 --')
const sampleRows = [0, 20, 45, 70, 150, 300, 450, 560, 620, 650, 675]
sampleRows.forEach((y) => {
  if (y >= h) return
  const counts = new Map()
  for (let x = 0; x < w; x += 3) {
    const c = px(x, y).join(',')
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  console.log('y=' + y + ': ' + top.map(([c, n]) => `rgb(${c})×${n}`).join('  '))
})

// 2) 垂直区域划分：以 8px 为单位判断整行主色
console.log('\n-- 垂直区域 --')
function classifyRow(y) {
  const counts = new Map()
  for (let x = 0; x < w; x += 3) {
    const c = px(x, y).join(',')
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const [r, g, b] = top[0].split(',').map(Number)
  const ratio = top[1] / (w / 3)
  const pure = ratio > 0.9
  if (!pure) return 'M'
  if (r >= 250 && g >= 250 && b >= 250) return 'W' // 白
  if (Math.abs(r - 247) <= 3 && Math.abs(g - 248) <= 3 && Math.abs(b - 250) <= 3) return 'B' // #f7f8fa
  if (Math.abs(r - 251) <= 2 && Math.abs(g - 251) <= 2 && Math.abs(b - 252) <= 2) return 'A' // #fbfbfc
  if (Math.abs(r - 236) <= 3 && Math.abs(g - 238) <= 3 && Math.abs(b - 241) <= 3) return 'C' // #eceef1
  return 'X'
}
let last = null
let startY = 0
for (let y = 0; y < h; y += 8) {
  const k = classifyRow(y)
  if (k !== last) {
    if (last !== null) console.log(`y ${startY}-${Math.min(y, h)}: ${last}`)
    last = k
    startY = y
  }
}
console.log(`y ${startY}-${h}: ${last}`)
console.log('图例: W=白色  B=#f7f8fa页面底色  A/C=棋盘格  M=混合内容(文字/按钮/图片)  X=其他纯色')
