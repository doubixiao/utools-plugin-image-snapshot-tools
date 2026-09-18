// 本地测试：验证 preload.js 中 OCR 接口调用的请求构造与响应解析
// 用法：node scripts/test-ocr.js
const http = require('node:http')
const Module = require('module')

let failed = 0
function check(cond, msg) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg)
  if (!cond) failed++
}

// 打桩 electron 与 utools
const origLoad = Module._load
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return { ipcRenderer: { on: () => {} }, nativeImage: {} }
  }
  return origLoad.call(this, request, ...args)
}
global.utools = { getPath: () => process.env.TEMP || '/tmp' }
global.window = global
require('../preload.js')

// 模拟 OpenAI 兼容接口
const server = http.createServer((req, res) => {
  if (req.url === '/v1/chat/completions' && req.headers.authorization === 'Bearer good-key') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      server.lastBody = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 20 |' } }]
        })
      )
    })
    return
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'invalid key' } }))
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const dataURL = 'data:image/png;base64,' + Buffer.from('fake').toString('base64')

  try {
    // 正确 key：返回 Markdown 文本
    const text = await window.services.ocr.recognize(dataURL, {
      baseUrl,
      apiKey: 'good-key',
      model: 'test-vl'
    })
    check(text.includes('| 姓名 | 年龄 |'), '正确响应解析出 Markdown 文本')

    const req = server.lastBody
    check(req && req.model === 'test-vl', '请求携带模型名')
    const content = req && req.messages && req.messages[0] && req.messages[0].content
    check(
      Array.isArray(content) &&
        content.some((p) => p.type === 'image_url' && p.image_url && p.image_url.url === dataURL) &&
        content.some((p) => p.type === 'text' && p.text.includes('Markdown')),
      '请求包含图片与 Markdown 提示词'
    )

    // 错误 key：应抛出带状态码的错误
    let errMsg = ''
    try {
      await window.services.ocr.recognize(dataURL, { baseUrl, apiKey: 'bad-key', model: 'test-vl' })
    } catch (err) {
      errMsg = err.message
    }
    check(errMsg.includes('401'), `错误响应带状态码（${errMsg}）`)

    // 未配置：直接报错
    let emptyErr = ''
    try {
      await window.services.ocr.recognize(dataURL, {})
    } catch (err) {
      emptyErr = err.message
    }
    check(emptyErr.includes('未配置'), '未配置时报错')
  } catch (err) {
    check(false, '测试异常：' + err.message)
  }

  server.close()
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
})