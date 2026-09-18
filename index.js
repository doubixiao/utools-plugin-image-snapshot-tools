// 截图工具主界面逻辑
const $ = (sel) => document.querySelector(sel)

// ---------- 结果视图 ----------
const viewResult = $('#view-result')
const viewHistory = $('#view-history')
const preview = $('#preview')
const stage = $('#stage')
const wrap = $('#wrap')
const imgEl = $('#img')
const canvas = $('#canvas')
const ctx = canvas.getContext('2d')
const placeholder = $('#placeholder')
const phStatus = $('#ph-status')
const hint = $('#hint')
const actionbar = $('#actionbar')
const drawbar = $('#drawbar')
const toastEl = $('#toast')

// ---------- 历史视图 ----------
const histCount = $('#hist-count')
const histGrid = $('#hist-grid')
const cfgDays = $('#cfg-days')

// ---------- 设置视图 ----------
const viewSettings = $('#view-settings')

// ---------- 全屏查看器 ----------
const viewer = $('#viewer')
const viewerImg = $('#viewer-img')
const viewerName = $('#viewer-name')

// ---------- OCR 识别 ----------
const ocrView = $('#ocr-view')
const ocrText = $('#ocr-text')
const ocrCopyBtn = $('#ocr-copy')
let ocrAborted = false
let ocrResultText = ''
let ocrRunning = false // 识别进行中
let ocrPendingView = false // 有识别结果尚未查看

// 强制布局撑满窗口（内联样式兜底，不依赖 CSS 是否被正确加载/缓存）
function enforceLayout() {
  const h = window.innerHeight + 'px'
  document.documentElement.style.height = h
  document.body.style.height = h
  document.body.style.position = 'fixed'
  document.body.style.top = '0'
  document.body.style.right = '0'
  document.body.style.bottom = '0'
  document.body.style.left = '0'
  document.body.style.display = 'flex'
  document.body.style.flexDirection = 'column'
}
enforceLayout()
window.addEventListener('resize', () => {
  enforceLayout()
  // setExpendHeight 异步生效：窗口变化后按新尺寸重排图片与框线
  if (original && natW && natH) {
    layoutImage()
    updateCanvasSize()
    draw()
  }
})

const COLORS = ['#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#ffffff']

let original = null // 原始截图 dataURL
let natW = 0 // 图片自然尺寸
let natH = 0
let fitScale = 1 // 预览缩放比例
let rects = [] // 框线列表（自然尺寸坐标）
let drawMode = false
let color = COLORS[0]
let drawing = null
let capturing = false
let lastCaptureEnd = 0
let toastTimer = null

// 历史与查看器状态
const imageCache = new Map() // path -> dataURL
let viewerItem = null
let viewerScale = 1
let viewerTx = 0
let viewerTy = 0
let vDragging = false
let vLastX = 0
let vLastY = 0

// ---------- 视图切换与窗口高度适配 ----------
// uTools 主窗口高度不会随内容自动收缩。body 是 fixed 全高布局，
// scrollHeight 恒等于窗口高度，不能用；这里按视图显式计算目标高度
const HD_H = 44 // 顶部栏
const BAR_H = 60 // 底部操作栏
const IMG_PAD = 28 // 预览区四周留白
const MIN_WIN_H = 300
const MAX_WIN_H = 1000

function setWindowHeight(h) {
  if (typeof utools === 'undefined' || !utools.setExpendHeight) return
  const target = Math.max(MIN_WIN_H, Math.min(MAX_WIN_H, Math.round(h)))
  try {
    utools.setExpendHeight(target)
  } catch (err) {
    // 分离窗口等不支持时忽略
  }
}

// 结果视图：头部 + 图片展示高（不放大、上限 456）+ 留白 + 操作栏
function fitResultHeight() {
  let imgH = 180 // 等待/提示状态的默认高度
  if (original && natW && natH) {
    const availW = Math.max(100, window.innerWidth - IMG_PAD)
    imgH = Math.min(natH, Math.round((natH / natW) * availW), 456)
  }
  setWindowHeight(HD_H + imgH + IMG_PAD + BAR_H)
}

// 历史视图：头部 + 标题行 + 网格内容高（上限 640，超出内部滚动）
function fitHistoryHeight() {
  const head = document.querySelector('.hist-head')
  const headH = head ? head.getBoundingClientRect().height : 41
  setWindowHeight(HD_H + headH + Math.min(histGrid.scrollHeight + 26, 640))
}

// 设置视图：头部 + 两个卡片的自然高度之和
function fitSettingsHeight() {
  const body = document.querySelector('.settings-body')
  if (!body) return setWindowHeight(MIN_WIN_H)
  let h = 28 // 上下 padding
  const kids = Array.from(body.children).filter((c) => !c.classList.contains('hidden'))
  kids.forEach((c) => (h += c.getBoundingClientRect().height))
  h += 12 * Math.max(0, kids.length - 1) // 卡片间距
  setWindowHeight(HD_H + h)
}

function switchView(name) {
  viewResult.classList.toggle('hidden', name !== 'result')
  viewHistory.classList.toggle('hidden', name !== 'history')
  viewSettings.classList.toggle('hidden', name !== 'settings')
  if (name === 'history') {
    loadHistory()
    requestAnimationFrame(fitHistoryHeight)
  } else if (name === 'settings') {
    loadConfigIntoUI()
    requestAnimationFrame(fitSettingsHeight)
  } else {
    fitResultHeight()
  }
}

// ---------- 截图 ----------
// 所有触发入口统一经过 requestCapture 防抖聚合（300ms 后只触发一次），
// 避免窗口尚未就绪时过早调用 screenCapture 导致回调丢失。
// force=true 表示用户显式操作（重新截图按钮），不受"刚完成截图"的抑制窗口限制
let captureTimer = null
let captureWatchdog = null
const RECENT_CAPTURE_MS = 2500

function requestCapture(force) {
  if (captureTimer) return
  if (capturing || window.__capturing) return // 截图进行中，忽略联动触发
  // OCR 进行中或有未查看的识别结果：不自动截图，保留现场等用户回来
  if (!force && (ocrRunning || ocrPendingView)) return
  if (!force && Date.now() - lastCaptureEnd < RECENT_CAPTURE_MS) return // 刚截完，忽略联动触发
  console.log('[截图] 触发（' + (force ? '手动' : '自动') + '）')
  captureTimer = setTimeout(() => {
    captureTimer = null
    doCapture()
  }, force ? 0 : 300)
}

function doCapture() {
  if (capturing || window.__capturing) return
  console.log('[截图] 开始调用 screenCapture')
  capturing = true
  window.__capturing = true
  // 新截图开始：清除上一次的 OCR 现场
  ocrAborted = true
  ocrRunning = false
  ocrPendingView = false
  ocrView.classList.add('hidden')
  closeViewer()
  switchView('result')
  stage.classList.add('hidden')
  actionbar.classList.add('hidden')
  drawbar.classList.add('hidden')
  placeholder.classList.remove('hidden')
  phStatus.textContent = '📷 正在启动截图…'
  try {
    utools.screenCapture((image) => {
      clearTimeout(captureWatchdog)
      clearTimeout(captureTimer) // 取消可能已排队的重复截图
      captureTimer = null
      console.log('[截图] 回调:', image ? '已截图' : '已取消')
      capturing = false
      window.__capturing = false
      lastCaptureEnd = Date.now()
      if (!image) {
        // 取消截图：进入历史列表
        switchView('history')
        return
      }
      setImage(image)
      autoSave(image)
    })
    // 看门狗：回调长时间未触发（调用未生效）时自动复位，并给出手动重试引导
    clearTimeout(captureWatchdog)
    captureWatchdog = setTimeout(() => {
      console.log('[截图] 回调超时，自动复位')
      capturing = false
      window.__capturing = false
      lastCaptureEnd = Date.now()
      clearTimeout(captureTimer)
      captureTimer = null
      phStatus.textContent = '截图未响应，请点击下方「开始截图」按钮重试'
      toast('截图未响应，请重试')
    }, 15000)
  } catch (err) {
    clearTimeout(captureWatchdog)
    console.log('[截图] 调用异常:', err)
    capturing = false
    window.__capturing = false
    phStatus.textContent = '截图失败：' + err.message
  }
}

// 每次截图自动保存到本地历史目录
function autoSave(image) {
  try {
    const svc = window.services && window.services.history
    if (!svc) return
    svc.save(image)
    toast('已自动保存到截图历史')
    try {
      svc.cleanup(svc.getConfig().retentionDays)
    } catch (err) {
      // 清理失败不影响使用
    }
  } catch (err) {
    console.error('自动保存失败:', err)
  }
}

window.addEventListener('DOMContentLoaded', () => {
  buildColors()
  // 启动时自动清理过期截图
  try {
    const svc = window.services && window.services.history
    if (svc) svc.cleanup(svc.getConfig().retentionDays)
  } catch (err) {
    // 忽略
  }
  // 兜底触发：preload 的 enter 消息若在页面加载完成前发出会丢失，
  // 此时从全局变量读取进入意图——history 进入则只打开历史列表，不截图
  setTimeout(() => {
    if (window.__enterIntent === 'history') {
      enterHistoryView()
      return
    }
    requestCapture()
  }, 300)
})

window.addEventListener('message', (e) => {
  if (!e.data) return
  if (e.data.type === 'shot-enter') {
    window.__enterIntent = 'screenshot'
    requestCapture()
  } else if (e.data.type === 'show-history') {
    // 「截图历史」指令：直接打开历史列表，不触发截图
    enterHistoryView()
  }
})

// 插件窗口重新显示时：优先恢复 OCR 现场，否则按常规逻辑开始新截图
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  // 本轮进入意图是查看历史：不触发截图
  if (window.__enterIntent === 'history') return
  if (ocrRunning || ocrPendingView) {
    if (!ocrView.classList.contains('hidden')) return // 结果层还开着，无需处理
    // 重新打开识别结果层
    ocrView.classList.remove('hidden')
    if (ocrRunning) ocrText.textContent = '正在识别图片中的文字，请稍候…'
    return
  }
  requestCapture()
})

// 进入历史视图（供指令与按钮共用）
function enterHistoryView() {
  closeViewer()
  ocrAborted = true
  ocrView.classList.add('hidden')
  switchView('history')
}

function setImage(dataURL) {
  original = dataURL
  rects = []
  drawMode = false
  drawing = null
  const img = new Image()
  img.onload = () => {
    natW = img.naturalWidth
    natH = img.naturalHeight
    wrap.style.width = ''
    wrap.style.height = ''
    layoutImage()
    imgEl.src = dataURL
    stage.classList.remove('hidden')
    placeholder.classList.add('hidden')
    actionbar.classList.remove('hidden')
    drawbar.classList.add('hidden')
    hint.classList.add('hidden')
    updateCanvasSize()
    draw()
    // 先按图片理想高度收缩窗口；窗口 resize 后由监听器重排图片
    fitResultHeight()
    layoutImage()
    updateCanvasSize()
    draw()
  }
  img.src = dataURL
}

function layoutImage() {
  const pad = 28
  const availW = preview.clientWidth - pad
  const availH = preview.clientHeight - pad
  fitScale = Math.min(1, availW / natW, availH / natH)
  wrap.style.width = Math.max(1, Math.round(natW * fitScale)) + 'px'
  wrap.style.height = Math.max(1, Math.round(natH * fitScale)) + 'px'
}

function updateCanvasSize() {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(natW * fitScale * dpr))
  canvas.height = Math.max(1, Math.round(natH * fitScale * dpr))
  canvas.style.width = wrap.style.width
  canvas.style.height = wrap.style.height
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

// ---------- 框图绘制 ----------
function enterDrawMode() {
  if (!original) return
  drawMode = true
  actionbar.classList.add('hidden')
  drawbar.classList.remove('hidden')
  hint.classList.remove('hidden')
  canvas.classList.add('drawing')
  draw()
}

function exitDrawMode() {
  drawMode = false
  drawing = null
  drawbar.classList.add('hidden')
  actionbar.classList.remove('hidden')
  hint.classList.add('hidden')
  canvas.classList.remove('drawing')
  draw()
}

function draw() {
  ctx.clearRect(0, 0, natW * fitScale, natH * fitScale)
  // 已完成的框线始终显示；拖拽中的框只在框图模式下显示
  if (!rects.length && !(drawMode && drawing)) return
  const lw = Math.max(2, (natW / 400) * fitScale)
  ctx.lineWidth = lw
  rects.forEach(strokeRect)
  if (drawMode && drawing) {
    strokeRect({
      x: Math.min(drawing.x0, drawing.x1),
      y: Math.min(drawing.y0, drawing.y1),
      w: Math.abs(drawing.x1 - drawing.x0),
      h: Math.abs(drawing.y1 - drawing.y0),
      color
    })
  }
}

function strokeRect(r) {
  ctx.strokeStyle = r.color
  ctx.strokeRect(r.x * fitScale, r.y * fitScale, r.w * fitScale, r.h * fitScale)
}

function toLocal(e) {
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max)
}

canvas.addEventListener('mousedown', (e) => {
  if (!drawMode) return
  const p = toLocal(e)
  drawing = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
  draw()
})

window.addEventListener('mousemove', (e) => {
  if (!drawing) return
  const p = toLocal(e)
  drawing.x1 = clamp(p.x, 0, natW * fitScale)
  drawing.y1 = clamp(p.y, 0, natH * fitScale)
  draw()
})

window.addEventListener('mouseup', () => {
  if (!drawing) return
  const r = {
    x: Math.min(drawing.x0, drawing.x1) / fitScale,
    y: Math.min(drawing.y0, drawing.y1) / fitScale,
    w: Math.abs(drawing.x1 - drawing.x0) / fitScale,
    h: Math.abs(drawing.y1 - drawing.y0) / fitScale,
    color
  }
  if (r.w >= 4 / fitScale || r.h >= 4 / fitScale) rects.push(r)
  drawing = null
  draw()
})

function buildColors() {
  const box = $('#colors')
  COLORS.forEach((c) => {
    const btn = document.createElement('button')
    btn.className = 'color'
    btn.style.background = c
    btn.dataset.color = c
    if (c === color) btn.classList.add('active')
    btn.addEventListener('click', () => {
      color = c
      box.querySelectorAll('.color').forEach((b) => b.classList.toggle('active', b === btn))
    })
    box.appendChild(btn)
  })
}

// ---------- 图片合成 ----------
function loadNatural(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataURL
  })
}

async function composeDataURL() {
  if (!rects.length) return original
  const im = await loadNatural(original)
  const c = document.createElement('canvas')
  c.width = im.naturalWidth
  c.height = im.naturalHeight
  const cx = c.getContext('2d')
  cx.drawImage(im, 0, 0)
  const lw = Math.max(3, c.width / 400)
  cx.lineWidth = lw
  rects.forEach((r) => {
    cx.strokeStyle = r.color
    cx.strokeRect(r.x, r.y, r.w, r.h)
  })
  return c.toDataURL('image/png')
}

async function toJpeg(dataURL) {
  const im = await loadNatural(dataURL)
  const c = document.createElement('canvas')
  c.width = im.naturalWidth
  c.height = im.naturalHeight
  c.getContext('2d').drawImage(im, 0, 0)
  return c.toDataURL('image/jpeg', 0.95)
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---------- 结果视图的四个快捷操作 ----------
$('#btn-recapture').addEventListener('click', () => requestCapture(true))
$('#btn-ph-capture').addEventListener('click', () => requestCapture(true))
$('#btn-history').addEventListener('click', enterHistoryView)
$('#btn-settings').addEventListener('click', () => switchView('settings'))
$('#btn-draw').addEventListener('click', enterDrawMode)
$('#btn-done').addEventListener('click', exitDrawMode)
$('#btn-undo').addEventListener('click', () => {
  rects.pop()
  draw()
})
$('#btn-clear').addEventListener('click', () => {
  rects = []
  draw()
})

// 贴图
$('#btn-pin').addEventListener('click', async () => {
  const image = await composeDataURL()
  let ok = false
  if (window.services && window.services.pinImage) {
    ok = window.services.pinImage(image) > 0
  }
  if (ok) {
    toast('已贴图：拖拽移动 · 滚轮缩放 · 右键关闭')
  } else {
    toast('贴图失败，请打开控制台查看错误日志')
  }
})

// 复制
$('#btn-copy').addEventListener('click', async () => {
  const image = await composeDataURL()
  const ok = utools.copyImage(image)
  toast(ok ? '已复制到剪贴板，可直接粘贴' : '复制失败，请重试')
})

// OCR 文字识别：调用多模态大模型识别文字，表格输出 Markdown 表格
$('#btn-ocr').addEventListener('click', async () => {
  if (!original) return
  const svc = window.services && window.services.ocr
  if (!svc) {
    toast('OCR 服务不可用')
    return
  }
  let cfg = {}
  try {
    cfg = (window.services.history.getConfig().ocr) || {}
  } catch (err) {
    // 配置读取失败按未配置处理
  }
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    toast('请先在「⚙ 设置」页配置 OCR 接口（地址 / Key / 模型）')
    switchView('settings')
    return
  }
  ocrAborted = false
  ocrResultText = ''
  ocrRunning = true
  ocrPendingView = false
  ocrText.textContent = '正在识别图片中的文字，请稍候…'
  ocrCopyBtn.disabled = true
  ocrView.classList.remove('hidden')
  try {
    const image = await prepareOcrImage(original)
    const text = await window.services.ocr.recognize(image, cfg)
    if (ocrAborted) return
    ocrRunning = false
    ocrPendingView = true
    ocrResultText = text
    ocrText.textContent = text || '（未识别到文字）'
    ocrCopyBtn.disabled = false
  } catch (err) {
    if (ocrAborted) return
    ocrRunning = false
    ocrPendingView = true
    ocrResultText = ''
    ocrText.textContent = '识别失败：' + (err && err.message ? err.message : String(err))
    ocrCopyBtn.disabled = true
  }
})

// 缩小图片以减小请求体积
async function prepareOcrImage(dataURL) {
  const im = await loadNatural(dataURL)
  const maxSide = 1600
  const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight))
  if (k >= 1) return dataURL
  const c = document.createElement('canvas')
  c.width = Math.round(im.naturalWidth * k)
  c.height = Math.round(im.naturalHeight * k)
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.85)
}

// 另存为
async function saveImage() {
  const dataURL = await composeDataURL()
  const defaultPath = `${utools.getPath('pictures')}/截图_${stamp(new Date())}.png`
  const target = await Promise.resolve(
    utools.showSaveDialog({
      title: '另存为',
      defaultPath,
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }
      ]
    })
  )
  if (!target) return
  try {
    const out = /\.jpe?g$/i.test(target) ? await toJpeg(dataURL) : dataURL
    window.services.writeFile(target, out)
    toast('已保存')
    utools.showNotification(`截图已保存到：${target}`)
  } catch (err) {
    toast(`保存失败：${err.message}`)
  }
}

$('#btn-save').addEventListener('click', saveImage)

// ---------- 历史记录（按日期分组展示） ----------
function loadHistory() {
  const svc = window.services && window.services.history
  if (!svc) {
    histGrid.innerHTML = '<div class="hist-empty">历史服务不可用</div>'
    return
  }
  try {
    const groups = svc.list() // [{ date: 'yyyy-MM-dd', items: [...] }]
    const total = groups.reduce((n, g) => n + g.items.length, 0)
    histCount.textContent = `共 ${total} 张`
    histGrid.innerHTML = ''
    if (!total) {
      histGrid.innerHTML = '<div class="hist-empty">暂无截图记录，点击右上角「重新截图」开始</div>'
      return
    }
    groups.forEach((group) => {
      const title = document.createElement('div')
      title.className = 'hist-group-title'
      title.textContent = `${group.date}（${group.items.length} 张）`
      histGrid.appendChild(title)
      group.items.forEach((item) => {
        const card = document.createElement('div')
        card.className = 'hist-item'
        card.title = `${item.name}\n${formatSize(item.size)} · ${formatTime(item.mtime)}`
        const thumb = document.createElement('img')
        thumb.src = item.thumb || ''
        thumb.draggable = false
        const name = document.createElement('div')
        name.className = 'hist-name'
        name.textContent = formatTime(item.mtime).split(' ')[1] // 仅显示时分秒
        card.appendChild(thumb)
        card.appendChild(name)
        card.addEventListener('click', () => openViewer(item))
        histGrid.appendChild(card)
      })
    })
  } catch (err) {
    histGrid.innerHTML = '<div class="hist-empty">读取历史失败：' + err.message + '</div>'
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(2) + ' MB'
}

function formatTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ---------- 自动清理设置 ----------
function loadConfigIntoUI() {
  try {
    const cfg = window.services.history.getConfig()
    cfgDays.value = cfg.retentionDays
    const ocr = cfg.ocr || {}
    $('#ocr-base').value = ocr.baseUrl || ''
    $('#ocr-key').value = ocr.apiKey || ''
    $('#ocr-model').value = ocr.model || ''
  } catch (err) {
    cfgDays.value = 30
  }
}

$('#cfg-save').addEventListener('click', () => {
  try {
    const days = Math.max(0, parseInt(cfgDays.value, 10) || 0)
    window.services.history.setConfig({ retentionDays: days })
    const removed = window.services.history.cleanup(days)
    toast(days > 0 ? `设置已保存（保留 ${days} 天），清理 ${removed} 张过期截图` : '设置已保存（永久保留）')
  } catch (err) {
    toast('保存设置失败：' + err.message)
  }
})

$('#btn-cleanup').addEventListener('click', () => {
  try {
    const days = Math.max(0, parseInt(cfgDays.value, 10) || 0)
    const removed = window.services.history.cleanup(days)
    toast(`已清理 ${removed} 张过期截图`)
    loadHistory()
    requestAnimationFrame(fitHistoryHeight)
  } catch (err) {
    toast('清理失败：' + err.message)
  }
})

$('#ocr-save').addEventListener('click', () => {
  try {
    window.services.history.setConfig({
      ocr: {
        baseUrl: $('#ocr-base').value.trim(),
        apiKey: $('#ocr-key').value.trim(),
        model: $('#ocr-model').value.trim()
      }
    })
    toast('OCR 设置已保存')
  } catch (err) {
    toast('保存 OCR 设置失败：' + err.message)
  }
})

// ---------- 全屏查看器 ----------
async function openViewer(item) {
  viewerItem = item
  viewerName.textContent = `${item.name}（${formatSize(item.size)}）`
  let url = imageCache.get(item.path)
  if (!url) {
    try {
      url = window.services.history.read(item.path)
      imageCache.set(item.path, url)
    } catch (err) {
      toast('读取图片失败：' + err.message)
      return
    }
  }
  viewerImg.src = url
  resetViewerTransform()
  viewer.classList.remove('hidden')
}

function resetViewerTransform() {
  viewerScale = 1
  viewerTx = 0
  viewerTy = 0
  applyViewerTransform()
}

function applyViewerTransform() {
  viewerImg.style.transform = `translate(${viewerTx}px, ${viewerTy}px) scale(${viewerScale})`
}

function closeViewer() {
  viewer.classList.add('hidden')
  viewerItem = null
}

// 滚轮缩放
viewerImg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    viewerScale = Math.min(5, Math.max(0.2, viewerScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
    applyViewerTransform()
  },
  { passive: false }
)

// 拖拽平移
viewerImg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  vDragging = true
  vLastX = e.clientX
  vLastY = e.clientY
  try {
    viewerImg.setPointerCapture(e.pointerId)
  } catch (err) {
    // 忽略
  }
})

window.addEventListener('pointermove', (e) => {
  if (!vDragging) return
  viewerTx += e.clientX - vLastX
  viewerTy += e.clientY - vLastY
  vLastX = e.clientX
  vLastY = e.clientY
  applyViewerTransform()
})

window.addEventListener('pointerup', () => {
  vDragging = false
})

$('#v-copy').addEventListener('click', () => {
  if (!viewerItem) return
  const url = imageCache.get(viewerItem.path)
  toast(url && utools.copyImage(url) ? '已复制到剪贴板' : '复制失败')
})

$('#v-pin').addEventListener('click', () => {
  if (!viewerItem) return
  const url = imageCache.get(viewerItem.path)
  if (!url) return
  const ok = window.services.pinImage(url) > 0
  toast(ok ? '已贴图' : '贴图失败，请查看控制台日志')
})

$('#v-open').addEventListener('click', () => {
  if (viewerItem) window.services.history.openFolder(viewerItem.path)
})

$('#v-delete').addEventListener('click', () => {
  if (!viewerItem) return
  try {
    window.services.history.remove(viewerItem.path)
    imageCache.delete(viewerItem.path)
    toast('已删除')
    closeViewer()
    loadHistory()
    requestAnimationFrame(fitHistoryHeight)
  } catch (err) {
    toast('删除失败：' + err.message)
  }
})

$('#v-close').addEventListener('click', closeViewer)

// ---------- OCR 结果操作 ----------
$('#ocr-copy').addEventListener('click', () => {
  if (!ocrResultText) return
  try {
    const ok = utools.copyText(ocrResultText)
    toast(ok === false ? '复制失败' : '已复制识别结果')
  } catch (err) {
    toast('复制失败：' + err.message)
  }
})

$('#ocr-close').addEventListener('click', () => {
  ocrAborted = true
  ocrPendingView = false // 结果已查看，恢复自动截图
  ocrView.classList.add('hidden')
})

// ---------- Toast 与快捷键 ----------
function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000)
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!ocrView.classList.contains('hidden')) {
    ocrAborted = true
    ocrView.classList.add('hidden')
    return
  }
  if (!viewer.classList.contains('hidden')) {
    closeViewer()
    return
  }
  if (!ocrView.classList.contains('hidden')) {
    ocrAborted = true
    ocrPendingView = false
    ocrView.classList.add('hidden')
    return
  }
  if (drawMode) {
    exitDrawMode()
    return
  }
  utools.outPlugin()
})
