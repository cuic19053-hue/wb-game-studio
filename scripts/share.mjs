/**
 * Temporary read-only LAN share with a QR code in the sidebar-style panel.
 * Only GET/HEAD is served, only the built game HTML, on a timer that closes
 * the server automatically. No files are written outside the project.
 */
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const qrcode = require('../assets/vendor/qrcode.js')

export class ShareError extends Error {
  constructor(message, code = 'SHARE') { super(message); this.code = code }
}

function lanAddress() {
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && !name.startsWith('utun')) return item.address
    }
  }
  return '127.0.0.1'
}

function qrSvg(text, border = 4, scale = 6) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const size = (count + border * 2) * scale
  const rects = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        rects.push(`<rect x="${(col + border) * scale}" y="${(row + border) * scale}" width="${scale}" height="${scale}"/>`)
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#111">${rects.join('')}</g></svg>`
}

export async function startShare({ dir, artifact, seconds = 1800, port = 0, host = '0.0.0.0' }) {
  let html
  try { html = await readFile(artifact, 'utf8') }
  catch { throw new ShareError('还没有 dist/index.html，请先 build', 'NOT_BUILT') }
  const token = randomBytes(5).toString('hex')
  const ip = lanAddress()
  const deadline = Date.now() + Math.max(1, seconds) * 1000
  let connectionCount = 0

  const server = createServer((req, res) => {
    connectionCount += 1
    if (Date.now() > deadline) { res.writeHead(410).end('Link expired'); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('Read only'); return }
    const path = (req.url || '/').split('?')[0]
    if (path !== '/' && path !== '/index.html') { res.writeHead(404).end('Not found'); return }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : html)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port
  const url = `http://${ip}:${actualPort}/?t=${token}`
  const svg = qrSvg(url)
  const qrFile = join(dir, '.studio', 'share-qr.svg')
  await writeFile(qrFile, svg)

  let timer = null
  const close = () => new Promise((resolve) => {
    if (timer) clearTimeout(timer)
    server.close(() => resolve())
  })
  timer = setTimeout(() => { close().catch(() => {}) }, Math.max(1, seconds) * 1000)
  timer.unref?.()

  return {
    ok: true,
    command: 'share',
    url,
    localUrl: `http://127.0.0.1:${actualPort}/?t=${token}`,
    qr: qrFile,
    qrSvg: svg,
    expiresAt: new Date(deadline).toISOString(),
    seconds,
    readOnly: true,
    pid: process.pid,
    connections: () => connectionCount,
    close,
    wait: () => new Promise((resolve) => {
      const check = setInterval(() => {
        if (Date.now() >= deadline) { clearInterval(check); resolve({ connections: connectionCount }) }
      }, 250)
    }),
  }
}
