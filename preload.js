// 截图工具 preload：指令注册 + 贴图窗口管理 + 截图历史（按日期目录整理/自动清理）
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { ipcRenderer, nativeImage } = require('electron')

// ---------- 插件指令 ----------
// screenshot：进入即开始新截图；history：直接打开历史列表，不触发截图。
// 进入意图写入全局变量（postMessage 在页面未加载完成时会丢失，页面加载后从此读取）
window.exports = {
  screenshot: {
    mode: 'none',
    args: {
      enter: () => {
        window.__enterIntent = 'screenshot'
        window.postMessage({ type: 'shot-enter' }, '*')
      }
    }
  },
  history: {
    mode: 'none',
    args: {
      enter: () => {
        window.__enterIntent = 'history'
        window.postMessage({ type: 'show-history' }, '*')
      }
    }
  }
}

// ---------- 贴图窗口管理 ----------
const PAD = 10 // 贴图窗口四周留白（用于显示边框阴影）
const MIN_K = 0.05
const MAX_K = 5
const pins = new Map() // id -> { win, id, baseW, baseH, k, x, y, drag }
let pinSeq = 0

if (!globalThis.__pinIpcReady) {
  globalThis.__pinIpcReady = true

  // 滚轮缩放：以鼠标位置为锚点调整窗口大小与位置
  ipcRenderer.on('pin:zoom', (event, payload) => {
    const pin = payload && pins.get(payload.id)
    if (!pin) return
    const next = Math.min(MAX_K, Math.max(MIN_K, pin.k * payload.factor))
    const ax = pin.x + payload.cx
    const ay = pin.y + payload.cy
    const ix = payload.cx - PAD
    const iy = payload.cy - PAD
    const w = Math.max(24, Math.round(pin.baseW * next))
    const h = Math.max(24, Math.round(pin.baseH * next))
    const nx = Math.round(ax - PAD - ix * (next / pin.k))
    const ny = Math.round(ay - PAD - iy * (next / pin.k))
    pin.k = next
    pin.x = nx
    pin.y = ny
    try {
      pin.win.setBounds({ x: nx, y: ny, width: w + PAD * 2, height: h + PAD * 2 })
    } catch (err) {
      console.error('贴图缩放失败:', err)
    }
  })

  // 拖拽移动
  ipcRenderer.on('pin:drag-start', (event, payload) => {
    const pin = payload && pins.get(payload.id)
    if (!pin) return
    pin.drag = { sx: payload.sx, sy: payload.sy, bx: pin.x, by: pin.y }
  })
  ipcRenderer.on('pin:drag-move', (event, payload) => {
    const pin = payload && pins.get(payload.id)
    if (!pin || !pin.drag) return
    const nx = Math.round(pin.drag.bx + (payload.sx - pin.drag.sx))
    const ny = Math.round(pin.drag.by + (payload.sy - pin.drag.sy))
    pin.x = nx
    pin.y = ny
    try {
      pin.win.setPosition(nx, ny)
    } catch (err) {
      console.error('贴图移动失败:', err)
    }
  })
  ipcRenderer.on('pin:drag-end', (event, payload) => {
    const pin = payload && pins.get(payload.id)
    if (pin) pin.drag = null
  })

  // 关闭贴图
  ipcRenderer.on('pin:close', (event, payload) => {
    const pin = payload && pins.get(payload.id)
    if (!pin) return
    try {
      pin.win.close()
    } catch (err) {
      // 窗口可能已关闭
    }
    pins.delete(pin.id)
  })
}

// ---------- 截图历史（保存到用户「图片」目录下，按日期子目录整理） ----------
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']
const HISTORY_DIR_NAME = '截图历史'

function historyDir() {
  return path.join(utools.getPath('pictures'), HISTORY_DIR_NAME)
}

function ensureHistoryDir() {
  const dir = historyDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function isImage(name) {
  return IMG_EXTS.includes(path.extname(name).toLowerCase())
}

function dateFolder(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---------- OCR：调用 OpenAI 兼容的多模态大模型接口 ----------
const OCR_PROMPT = [
  '请识别图片中的所有文字，并按照原图的结构与排版输出：',
  '- 如果存在表格，请使用 Markdown 表格格式输出；',
  '- 保留标题层级、列表、段落结构，使用 Markdown 语法；',
  '- 代码、公式等内容原样保留；',
  '- 只输出识别结果，不要添加任何解释或补充说明。'
].join('\n')

function httpPostJson(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (err) {
      reject(new Error('无效的 API 地址'))
      return
    }
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
        timeout: timeoutMs
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(text)
          } else {
            reject(new Error(`接口返回 ${res.statusCode}：${text.slice(0, 300)}`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// 老版本直接存放在根目录的截图，迁移到对应日期子目录
function migrateLegacy() {
  const dir = ensureHistoryDir()
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name)
    let st
    try {
      st = fs.statSync(filePath)
    } catch (err) {
      continue
    }
    if (!st.isFile() || !isImage(name)) continue
    const sub = path.join(dir, dateFolder(new Date(st.mtimeMs)))
    fs.mkdirSync(sub, { recursive: true })
    let target = path.join(sub, name)
    let i = 1
    while (fs.existsSync(target)) {
      target = path.join(sub, path.basename(name, path.extname(name)) + '_' + i + path.extname(name))
      i++
    }
    try {
      fs.renameSync(filePath, target)
    } catch (err) {
      // 迁移失败不影响使用
    }
  }
}

// 删除已经成为空目录的日期子目录
function removeEmptyDateFolders() {
  const dir = historyDir()
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    try {
      if (fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) {
        fs.rmdirSync(p)
      }
    } catch (err) {
      // 忽略
    }
  }
}

// ---------- 暴露给页面的服务 ----------
window.services = {
  // 把图片固定到屏幕上（返回贴图窗口 id，失败返回 0）
  pinImage(dataURL) {
    try {
      const img = nativeImage.createFromDataURL(dataURL)
      if (img.isEmpty()) return 0
      const { width, height } = img.getSize()

      // 初始缩放：不超过主屏工作区的 85%
      const wa = utools.getPrimaryDisplay().workArea
      const k = Math.min(1, (wa.width * 0.85) / width, (wa.height * 0.85) / height)
      const w = Math.max(40, Math.round(width * k))
      const h = Math.max(40, Math.round(height * k))

      // 在鼠标所在显示器上，以鼠标位置为中心放置，多张错开
      const id = ++pinSeq
      const cursor = utools.getCursorScreenPoint()
      const dwa = utools.getDisplayNearestPoint(cursor).workArea
      const cascade = ((id - 1) % 6) * 32
      let x = Math.round(cursor.x - w / 2 + cascade)
      let y = Math.round(cursor.y - h / 2 + cascade)
      x = Math.min(Math.max(x, dwa.x + 4), dwa.x + dwa.width - w - 4)
      y = Math.min(Math.max(y, dwa.y + 4), dwa.y + dwa.height - h - 4)

      const win = utools.createBrowserWindow('pin.html', {
        x,
        y,
        width: w + PAD * 2,
        height: h + PAD * 2,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        roundedCorners: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closeable: true,
        webPreferences: { preload: 'pin-preload.js' }
      }, () => {
        try {
          win.webContents.send('pin:data', { id, dataURL })
        } catch (err) {
          console.error('发送贴图数据失败:', err)
        }
        try { win.setAlwaysOnTop(true) } catch (err) { /* 忽略 */ }
        try { win.showInactive() } catch (err) { try { win.show() } catch (e2) { /* 忽略 */ } }
      })
      if (!win) return 0

      pins.set(id, { win, id, baseW: width, baseH: height, k, x, y, drag: null })
      return id
    } catch (err) {
      console.error('创建贴图失败:', err)
      return 0
    }
  },

  // 把 dataURL 图片写入指定本地路径（另存为）
  writeFile(filePath, dataURL) {
    const buf = Buffer.from(dataURL.split(',')[1], 'base64')
    fs.writeFileSync(filePath, buf)
    return true
  },

  // OCR 文字识别：调用 OpenAI 兼容的多模态大模型接口，返回 Markdown 文本
  ocr: {
    recognize(dataURL, cfg) {
      const baseUrl = String((cfg && cfg.baseUrl) || '').trim().replace(/\/+$/, '')
      const apiKey = String((cfg && cfg.apiKey) || '').trim()
      const model = String((cfg && cfg.model) || '').trim()
      if (!baseUrl || !apiKey || !model) throw new Error('未配置 OCR 接口（API 地址 / Key / 模型）')
      const payload = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataURL } }
            ]
          }
        ]
      }
      return httpPostJson(baseUrl + '/chat/completions', { Authorization: 'Bearer ' + apiKey }, JSON.stringify(payload), 120000).then((resp) => {
        let data
        try {
          data = JSON.parse(resp)
        } catch (err) {
          throw new Error('接口返回非 JSON：' + resp.slice(0, 200))
        }
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
        if (typeof content !== 'string' || !content) {
          throw new Error('接口返回内容为空：' + JSON.stringify(data).slice(0, 300))
        }
        return content
      })
    }
  },

  // 截图历史服务
  history: {
    // 自动保存截图到当天日期目录，返回文件路径
    save(dataURL) {
      const dir = ensureHistoryDir()
      const sub = path.join(dir, dateFolder(new Date()))
      fs.mkdirSync(sub, { recursive: true })
      const base = `截图_${stamp(new Date())}`
      let name = `${base}.png`
      let filePath = path.join(sub, name)
      let i = 1
      while (fs.existsSync(filePath)) {
        name = `${base}_${i}.png`
        filePath = path.join(sub, name)
        i++
      }
      fs.writeFileSync(filePath, Buffer.from(dataURL.split(',')[1], 'base64'))
      return filePath
    },

    // 列出历史截图，按日期分组（yyyy-MM-dd）倒序，返回 [{ date, items: [...] }]
    list() {
      const dir = ensureHistoryDir()
      migrateLegacy()
      const groups = new Map()
      for (const folder of fs.readdirSync(dir)) {
        const sub = path.join(dir, folder)
        let isDir = false
        try {
          isDir = fs.statSync(sub).isDirectory()
        } catch (err) {
          continue
        }
        if (!isDir) continue
        const items = []
        for (const name of fs.readdirSync(sub)) {
          if (!isImage(name)) continue
          const filePath = path.join(sub, name)
          try {
            const st = fs.statSync(filePath)
            const img = nativeImage.createFromPath(filePath)
            items.push({
              path: filePath,
              name,
              mtime: st.mtimeMs,
              size: st.size,
              thumb: img.isEmpty() ? '' : img.resize({ width: 320 }).toDataURL()
            })
          } catch (err) {
            // 跳过无法读取的文件
          }
        }
        if (items.length) groups.set(folder, items)
      }
      return [...groups.entries()]
        .map(([date, items]) => ({
          date,
          items: items.sort((a, b) => b.mtime - a.mtime)
        }))
        .sort((a, b) => (a.date < b.date ? 1 : -1))
    },

    // 读取图片为 dataURL（用于全屏查看）
    read(filePath) {
      return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64')
    },

    // 删除一张历史截图，若日期目录已空则一并删除
    remove(filePath) {
      fs.unlinkSync(filePath)
      try {
        const parent = path.dirname(filePath)
        if (parent !== historyDir() && fs.readdirSync(parent).length === 0) {
          fs.rmdirSync(parent)
        }
      } catch (err) {
        // 忽略
      }
      return true
    },

    // 清理过期截图（保留 days 天，days<=0 表示不清理），返回删除数量
    cleanup(days) {
      if (!days || days <= 0) return 0
      const dir = ensureHistoryDir()
      migrateLegacy()
      const deadline = Date.now() - days * 24 * 60 * 60 * 1000
      let removed = 0
      for (const folder of fs.readdirSync(dir)) {
        const sub = path.join(dir, folder)
        let isDir = false
        try {
          isDir = fs.statSync(sub).isDirectory()
        } catch (err) {
          continue
        }
        if (!isDir) continue
        for (const name of fs.readdirSync(sub)) {
          if (!isImage(name)) continue
          const filePath = path.join(sub, name)
          try {
            if (fs.statSync(filePath).mtimeMs < deadline) {
              fs.unlinkSync(filePath)
              removed++
            }
          } catch (err) {
            // 跳过
          }
        }
      }
      removeEmptyDateFolders()
      return removed
    },

    // 读取设置（默认保留 30 天，OCR 未配置）
    getConfig() {
      const dir = ensureHistoryDir()
      const defaults = { retentionDays: 30, ocr: { baseUrl: '', apiKey: '', model: '' } }
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
        return Object.assign({}, defaults, cfg)
      } catch (err) {
        return defaults
      }
    },

    // 保存设置（与已有配置合并，避免覆盖其他字段）
    setConfig(cfg) {
      const dir = ensureHistoryDir()
      const cfgPath = path.join(dir, 'config.json')
      let existing = {}
      try {
        existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      } catch (err) {
        // 首次写入
      }
      fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, existing, cfg), null, 2))
      return true
    },

    // 在文件管理器中显示该文件
    openFolder(filePath) {
      utools.shellShowItemInFolder(filePath)
    },

    // 历史目录路径
    dir() {
      return ensureHistoryDir()
    }
  }
}