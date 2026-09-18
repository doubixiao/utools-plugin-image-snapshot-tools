// 贴图窗口页面逻辑
const imgEl = document.getElementById('img')

let dragging = false
let startX = 0
let startY = 0

window.pinService.onData((data) => {
  imgEl.style.backgroundImage = `url(${data.dataURL})`
})

// 拖拽移动：不用 CSS app-region（在 Windows 上会吞掉滚轮事件），改为手动跟踪鼠标位移
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  if (e.target && e.target.closest('.bar')) return // 关闭按钮不参与拖拽
  dragging = true
  startX = e.screenX
  startY = e.screenY
  window.pinService.dragStart(startX, startY)
  try {
    document.body.setPointerCapture(e.pointerId)
  } catch (err) {
    // 忽略指针捕获失败
  }
})

window.addEventListener('pointermove', (e) => {
  if (!dragging) return
  window.pinService.dragMove(e.screenX, e.screenY)
})

window.addEventListener('pointerup', () => {
  if (!dragging) return
  dragging = false
  window.pinService.dragEnd()
})

// 滚轮缩放
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    window.pinService.zoom(factor, e.clientX, e.clientY)
  },
  { passive: false }
)

// 关闭：悬浮 ✕ 按钮 / 右键 / Esc
document.getElementById('btn-close').addEventListener('click', () => window.pinService.close())
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pinService.close()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pinService.close()
})
