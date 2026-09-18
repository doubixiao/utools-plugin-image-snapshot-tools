// 本地测试：验证 preload.js 中截图历史服务的逻辑（日期目录/迁移/清理/配置）
// 用法：node scripts/test-history.js
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('module')

// 打桩 electron 与 utools
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-history-test-'))
const pictures = path.join(tmpRoot, 'Pictures')
fs.mkdirSync(pictures, { recursive: true })

const origLoad = Module._load
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return {
      ipcRenderer: { on: () => {} },
      nativeImage: {
        createFromDataURL: () => ({ isEmpty: () => true }),
        createFromPath: () => ({ isEmpty: () => true, resize: () => ({ toDataURL: () => '' }) })
      }
    }
  }
  return origLoad.call(this, request, ...args)
}

global.utools = { getPath: () => pictures }
global.window = global

process.chdir(path.join(__dirname, '..'))
require(path.join(__dirname, '..', 'preload.js'))
const h = window.services.history

const p = (n) => String(n).padStart(2, '0')
const today = `${new Date().getFullYear()}-${p(new Date().getMonth() + 1)}-${p(new Date().getDate())}`

let failed = 0
function check(cond, msg) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg)
  if (!cond) failed++
}

const dataURL = 'data:image/png;base64,' + Buffer.from('fake-image-bytes').toString('base64')

// 1. 自动保存 → 应进入当天日期目录
const p1 = h.save(dataURL)
check(p1.includes(path.join('截图历史', today)), `save 进入日期目录: ${p1}`)

// 2. 列表分组，组名应为今天
const groups = h.list()
check(groups.length === 1 && groups[0].date === today && groups[0].items.length === 1, 'list 按日期分组且内容正确')

// 3. 老版本根目录散落文件应按文件时间迁移进日期目录（刚创建 → 迁移到今天）
const legacy = path.join(pictures, '截图历史', '截图_20240101_000000.png')
fs.writeFileSync(legacy, Buffer.from('old'))
h.list()
check(!fs.existsSync(legacy), '根目录旧截图已迁移')
const todayDir = path.join(pictures, '截图历史', today)
check(fs.existsSync(todayDir) && fs.readdirSync(todayDir).length === 2, '旧截图并入今天的日期目录')

// 4. 配置默认 30 天，读写往返正常，OCR 配置合并不互相覆盖
check(h.getConfig().retentionDays === 30 && !!h.getConfig().ocr, '默认保留 30 天且含 OCR 默认配置')
h.setConfig({ retentionDays: 7 })
check(h.getConfig().retentionDays === 7, 'setConfig/getConfig 往返正常')
h.setConfig({ ocr: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' } })
const cfgMerge = h.getConfig()
check(cfgMerge.retentionDays === 7 && cfgMerge.ocr && cfgMerge.ocr.model === 'm', 'setConfig 合并且保留原有字段')

// 5. cleanup(0) 不删除
check(h.cleanup(0) === 0, '保留天数 0 时不清理')

// 6. 清理过期：把迁移的旧图与 2024 目录里的图都改成 10 天前，保留 7 天应被删除
const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
const migratedFile = path.join(todayDir, '截图_20240101_000000.png')
fs.utimesSync(migratedFile, past, past)
const oldDir = path.join(pictures, '截图历史', '2024-01-01')
fs.mkdirSync(oldDir, { recursive: true })
const oldFile = path.join(oldDir, '截图_20240102_000000.png')
fs.writeFileSync(oldFile, Buffer.from('old'))
fs.utimesSync(oldFile, past, past)
const removed = h.cleanup(7)
check(removed === 2, `清理 2 张过期（实际 ${removed}）`)
check(!fs.existsSync(oldFile) && !fs.existsSync(migratedFile), '过期截图被清理')
check(!fs.existsSync(oldDir), '空日期目录被自动删除')
check(fs.existsSync(p1), '未过期截图保留')

// 7. 删除单张 + 当天目录清空后自动删除
h.remove(p1)
check(!fs.existsSync(p1), 'remove 删除文件')
check(!fs.existsSync(todayDir), '删除后空日期目录被移除')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
console.log('临时目录:', tmpRoot)
fs.rmSync(tmpRoot, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)