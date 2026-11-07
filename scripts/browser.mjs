/**
 * Zero-dependency Chrome DevTools Protocol driver.
 *
 * Node 22+ ships a global WebSocket, so playtests, sprite inspection and
 * screenshots need neither playwright nor puppeteer. The user's own Chrome
 * or Edge is launched headless with a throw-away profile.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'

export class BrowserError extends Error {
  constructor(message, code = 'BROWSER') { super(message); this.code = code }
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
  throw new BrowserError('找不到 Chrome / Edge。可设置 CHROME_PATH 指向浏览器可执行文件。', 'NO_BROWSER')
}

function httpJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { reject(new BrowserError(`无法解析 DevTools 响应: ${body.slice(0, 120)}`)) }
      })
    })
    req.on('error', (error) => reject(new BrowserError(`DevTools 请求失败: ${error.message}`)))
    req.end()
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id)
        clearTimeout(timer)
        this.pending.delete(message.id)
        if (message.error) reject(new BrowserError(`${message.error.message} (${message.error.code ?? ''})`))
        else resolve(message.result)
      } else if (message.method) {
        for (const fn of this.listeners.get(message.method) || []) fn(message.params || {})
        for (const fn of this.listeners.get('*') || []) fn(message)
      }
    })
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserError(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
    return () => {
      const list = this.listeners.get(method) || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    }
  }

  waitFor(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new BrowserError(`等待 ${method} 超时`)) }, timeoutMs)
      const off = this.on(method, (params) => { clearTimeout(timer); off(); resolve(params) })
    })
  }

  close() { try { this.ws.close() } catch { /* already closed */ } }
}

/**
 * Launch headless Chrome and return a session:
 *   goto(file), eval(expr), key(...), shot(...), inspectImage(dataUrl), errors, close()
 */
export async function launchBrowser({ width = 960, height = 640, timeoutMs = 25000 } = {}) {
  if (typeof WebSocket !== 'function') throw new BrowserError('自动试玩需要 Node 22+（内置 WebSocket）', 'NO_WEBSOCKET')
  const chrome = findChrome()
  const profile = await mkdtemp(join(tmpdir(), 'wb-cdp-'))
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--disable-dev-shm-usage', '--hide-scrollbars', '--no-first-run',
    `--window-size=${width},${height}`, `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ]
  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const abort = async (error) => {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError(`Chrome 启动超时: ${stderr.slice(-300)}`)), timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/u)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.on('error', (error) => { clearTimeout(timer); reject(new BrowserError(`无法启动 Chrome: ${error.message}`)) })
    child.on('exit', (code) => { clearTimeout(timer); reject(new BrowserError(`Chrome 退出 (${code}): ${stderr.slice(-300)}`)) })
  }).catch(abort)

  let resolvedPort = port
  if (!resolvedPort) {
    try {
      const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
      resolvedPort = Number(active.split('\n')[0])
    } catch { await abort(new BrowserError('无法取得 DevTools 端口')) }
  }

  let targets
  try { targets = await httpJson(`http://127.0.0.1:${resolvedPort}/json/list`) }
  catch (error) { await abort(error) }
  let page = targets.find((t) => t.type === 'page')
  if (!page) {
    try { page = await httpJson(`http://127.0.0.1:${resolvedPort}/json/new?about:blank`, 'PUT') }
    catch (error) { await abort(error) }
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new BrowserError('连接 DevTools WebSocket 失败')), { once: true })
      setTimeout(() => reject(new BrowserError('连接 DevTools WebSocket 超时')), 10000)
    })
  } catch (error) { await abort(error) }

  const cdp = new Cdp(ws)
  const errors = []
  cdp.on('Runtime.exceptionThrown', (p) => {
    errors.push(String(p.exceptionDetails?.text || p.exceptionDetails?.exception?.description || 'unknown exception').slice(0, 300))
  })
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') errors.push(String(p.entry.text || '').slice(0, 300))
  })
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') errors.push(p.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) || 'console error')
  })

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  return {
    cdp,
    errors,
    async goto(file) {
      const url = String(file).startsWith('file:') ? String(file) : pathToFileURL(String(file)).href
      const loaded = cdp.waitFor('Page.loadEventFired', 20000)
      await cdp.send('Page.navigate', { url })
      await loaded
      await new Promise((r) => setTimeout(r, 250))
    },
    async eval(expression, awaitPromise = false) {
      const result = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise, userGesture: true,
      })
      if (result.exceptionDetails) {
        throw new BrowserError(String(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'eval failed'))
      }
      return result.result?.value
    },
    async key({ code, key, vk }) {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    },
    async shot({ format = 'png', quality } = {}) {
      const params = { format, captureBeyondViewport: false }
      if (format === 'jpeg') params.quality = quality ?? 80
      const result = await cdp.send('Page.captureScreenshot', params, 30000)
      return Buffer.from(result.data, 'base64')
    },
    async inspectImage(dataUrl, size = 256, keyOutBackground = true) {
      const expression = `(async () => {
        const S = ${size};
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await img.decode();
        const c = document.createElement('canvas'); c.width = S; c.height = S;
        const x = c.getContext('2d'); x.clearRect(0,0,S,S);
        const scale = Math.min(S/img.width, S/img.height);
        const w = img.width*scale, h = img.height*scale;
        x.drawImage(img, (S-w)/2, (S-h)/2, w, h);
        const image = x.getImageData(0,0,S,S);
        const px = image.data;
        const ratio = () => { let t=0; for (let i=3;i<px.length;i+=4) if (px[i] < 16) t++; return t/(px.length/4); };
        const before = ratio();
        let backgroundRemoved = false;
        if (${Boolean(keyOutBackground)} && before < 0.15) {
          const corners = [[0,0],[S-1,0],[0,S-1],[S-1,S-1]];
          let r=0,g=0,b=0;
          for (const [cx,cy] of corners) { const i=(cy*S+cx)*4; r+=px[i]; g+=px[i+1]; b+=px[i+2]; }
          r/=4; g/=4; b/=4;
          if ((r+g+b)/3 > 190) {
            for (let i=0;i<px.length;i+=4) {
              if (Math.abs(px[i]-r)<38 && Math.abs(px[i+1]-g)<38 && Math.abs(px[i+2]-b)<38) px[i+3]=0;
            }
            x.putImageData(image,0,0);
            backgroundRemoved = true;
          }
        }
        return {
          width: img.width, height: img.height,
          transparentRatio: ratio(),
          backgroundRemoved,
          fitted: c.toDataURL('image/png'),
        };
      })()`
      return this.eval(expression, true)
    },
    async close() {
      cdp.close()
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      await rm(profile, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export const KEYS = {
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Space: { code: 'Space', key: ' ', vk: 32 },
  Enter: { code: 'Enter', key: 'Enter', vk: 13 },
}
