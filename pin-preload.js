// 贴图窗口 preload：与主窗口通信（缩放、关闭）
const { ipcRenderer } = require('electron')

let pinId = null

window.pinService = {
  // 接收主窗口发来的图片数据
  onData(cb) {
    ipcRenderer.on('pin:data', (event, data) => {
      pinId = data.id
      cb(data)
    })
  },
  // 滚轮缩放：factor 缩放系数，(cx, cy) 为鼠标在窗口内的位置
  zoom(factor, cx, cy) {
    if (!pinId) return
    utools.sendToParent('pin:zoom', { id: pinId, factor, cx, cy })
  },
  // 拖拽移动：screenX/screenY 为鼠标的屏幕坐标
  dragStart(sx, sy) {
    if (!pinId) return
    utools.sendToParent('pin:drag-start', { id: pinId, sx, sy })
  },
  dragMove(sx, sy) {
    if (!pinId) return
    utools.sendToParent('pin:drag-move', { id: pinId, sx, sy })
  },
  dragEnd() {
    if (!pinId) return
    utools.sendToParent('pin:drag-end', { id: pinId })
  },
  // 关闭贴图
  close() {
    if (!pinId) return
    utools.sendToParent('pin:close', { id: pinId })
  }
}
