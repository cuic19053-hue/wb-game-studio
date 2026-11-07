/**
 * Game wall: one offline HTML page with a tile per built game. Click a tile to
 * play it full-window under a slim bar; Esc returns. Builds are packed
 * unchanged, and 3D games share a single inlined copy of three.js.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const THREE_RE = /<script id="wb-three-runtime">([\s\S]*?)<\/script>/u

export class WallError extends Error {
  constructor(message, code = 'WALL') { super(message); this.code = code }
}

export async function scanGames(root, depth = 4, limit = 80) {
  const found = []
  async function walk(dir, level) {
    if (level > depth || found.length >= limit) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    if (entries.some((e) => e.name === 'game.json')) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
        const artifact = join(dir, 'dist', 'index.html')
        const versionsFile = join(dir, '.studio', 'versions.json')
        const cover = join(dir, '.studio', 'cover.jpg')
        let versions = 0
        let updatedAt = 0
        try { versions = JSON.parse(await readFile(versionsFile, 'utf8')).length } catch { /* none */ }
        try { updatedAt = (await stat(artifact)).mtimeMs } catch { /* none */ }
        found.push({
          dir: relative(root, dir) || '.',
          absDir: dir,
          title: manifest.title || '(untitled)',
          kind: (manifest.runtime || []).includes('three') ? '3D' : '2D',
          template: manifest.template,
          built: existsSync(artifact),
          artifact,
          versions,
          updatedAt,
          cover: existsSync(cover) ? cover : null,
        })
      } catch { /* skip broken projects */ }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      await walk(join(dir, entry.name), level + 1)
    }
  }
  await walk(root, 0)
  return found
}

function inlineSafe(text) {
  return text.replace(/<\/(script)/giu, '<\\/$1').replace(/<!--/gu, '<\\!--')
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function sortGames(games, sort) {
  const copy = [...games]
  if (sort === 'name') copy.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  else if (sort === 'versions') copy.sort((a, b) => b.versions - a.versions || b.updatedAt - a.updatedAt)
  else copy.sort((a, b) => b.updatedAt - a.updatedAt)
  return copy
}

export async function buildWall({ root, filter = 'all', sort = 'recent', out, title = 'My games' }) {
  const all = await scanGames(root)
  const filtered = sortGames(
    all.filter((g) => filter === 'all' || g.kind.toLowerCase() === filter.toLowerCase()),
    sort,
  )
  const included = []
  const excluded = []
  let sharedThree = null
  for (const game of filtered) {
    if (!game.built) { excluded.push({ ...game, reason: 'not built' }); continue }
    let html = await readFile(game.artifact, 'utf8')
    let needsThree = false
    const match = html.match(THREE_RE)
    if (match) {
      if (sharedThree === null) sharedThree = match[0]
      html = html.replace(THREE_RE, '')
      needsThree = true
    }
    let cover = null
    if (game.cover) {
      try { cover = `data:image/jpeg;base64,${(await readFile(game.cover)).toString('base64')}` } catch { /* optional */ }
    }
    included.push({
      id: game.dir.replace(/[^\p{L}\p{N}]/gu, '-') || 'game',
      title: game.title,
      kind: game.kind,
      dir: game.dir,
      versions: game.versions,
      html,
      needsThree,
      cover,
    })
  }

  const data = { title, filter, sort, three: sharedThree, games: included }
  const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0e1220;--surface:#171c2e;--line:rgba(255,255,255,.08);--text:#eef1f8;--muted:#8d97ad;--accent:#ffc65c}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(1200px 500px at 50% -10%,#232a52 0%,transparent 70%),var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{max-width:1120px;margin:0 auto;padding:44px 28px 8px}
h1{font-size:30px;font-weight:700;letter-spacing:.01em;margin:0 0 6px;background:linear-gradient(90deg,#fff,var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
.meta{color:var(--muted);font-size:13.5px}
main{max-width:1120px;margin:0 auto;padding:24px 28px 56px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:22px}
button.tile{position:relative;padding:0;border:1px solid var(--line);border-radius:16px;background:var(--surface);overflow:hidden;cursor:pointer;text-align:left;font:inherit;color:inherit;box-shadow:0 6px 20px rgba(0,0,0,.28);transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease}
button.tile:hover,button.tile:focus-visible{transform:translateY(-5px);box-shadow:0 14px 34px rgba(0,0,0,.45);border-color:rgba(255,198,92,.45);outline:none}
.cover{position:relative;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1d2550,#e58a6a);color:#fff;font-size:40px;font-weight:700;overflow:hidden}
.cover img{width:100%;height:100%;object-fit:cover;transition:transform .45s ease}
button.tile:hover .cover img{transform:scale(1.06)}
.cover::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(14,18,32,.75))}
.play{position:absolute;z-index:1;right:12px;bottom:12px;padding:5px 13px;border-radius:999px;background:linear-gradient(180deg,#ffe08a,#f2a93b);color:#3a2410;font-size:12.5px;font-weight:700;opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s}
button.tile:hover .play,button.tile:focus-visible .play{opacity:1;transform:none}
.info{padding:14px 16px 18px}
.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;border-radius:999px;padding:2px 9px;color:#9fd0ff;background:rgba(80,150,255,.16)}
.tag.k3{color:#ffcf8a;background:rgba(255,170,60,.16)}
.name{display:block;font-size:16px;font-weight:650;margin:9px 0 3px}
.sub{font-size:12.5px;color:var(--muted)}
#stage{position:fixed;inset:0;background:#000;display:none;flex-direction:column;z-index:10}
#bar{height:44px;flex:none;background:rgba(14,18,32,.96);border-bottom:1px solid var(--line);color:var(--text);display:flex;align-items:center;gap:14px;padding:0 16px;font-size:13.5px}
#bar button{background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:4px 14px;cursor:pointer;font:inherit;transition:background .15s}
#bar button:hover{background:rgba(255,255,255,.14)}
#now{font-weight:600}
#frame{flex:1;width:100%;border:0;background:#000}
.empty{padding:60px 20px;color:var(--muted);text-align:center}
@media (max-width:520px){header{padding:30px 18px 4px}main{padding:18px}h1{font-size:24px}.grid{gap:16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><div class="meta">${included.length} 个游戏${filter === 'all' ? '' : ' · 仅 ' + escapeHtml(filter.toUpperCase())} · ${({ recent: '按最近更新', versions: '按版本数', name: '按名称' })[sort] || escapeHtml(sort)} · 单文件离线，点击卡片即可试玩</div></header>
<main><div class="grid" id="grid"></div><div class="empty" id="empty" hidden>没有可展示的游戏，先跑 build。</div></main>
<div id="stage"><div id="bar"><button id="back">← 返回 (Esc)</button><span id="now"></span></div><iframe id="frame" title="game"></iframe></div>
<script id="wall-data" type="application/json">${inlineSafe(JSON.stringify(data))}</script>
<script>
var DATA=JSON.parse(document.getElementById('wall-data').textContent);
var grid=document.getElementById('grid');
if(!DATA.games.length)document.getElementById('empty').hidden=false;
DATA.games.forEach(function(g){
  var b=document.createElement('button');b.className='tile';
  var cover=g.cover?'<img alt="" src="'+g.cover+'">':escape(g.title.slice(0,1));
  b.innerHTML='<div class="cover">'+cover+'<span class="play">▶ 试玩</span></div><div class="info"><span class="tag'+(g.kind==='3D'?' k3':'')+'">'+g.kind+'</span><span class="name">'+escape(g.title)+'</span><span class="sub">'+escape(g.dir)+' · '+g.versions+' 个版本</span></div>';b.setAttribute('aria-label','试玩 '+g.title);
  b.onclick=function(){open(g)};grid.appendChild(b);
});
function escape(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function open(g){
  var html=(g.needsThree&&DATA.three?DATA.three:'')+g.html;
  document.getElementById('now').textContent=g.title;
  document.getElementById('frame').srcdoc=html;
  document.getElementById('stage').style.display='flex';
}
function back(){document.getElementById('stage').style.display='none';document.getElementById('frame').srcdoc=''}
document.getElementById('back').onclick=back;
document.addEventListener('keydown',function(e){if(e.key==='Escape')back()});
</script></body></html>
`
  await writeFile(out, page)
  return {
    ok: true, command: 'wall', out,
    bytes: Buffer.byteLength(page),
    filter, sort,
    included: included.length,
    excluded,
    sharedThree: sharedThree !== null,
    games: included.map((g) => ({ title: g.title, kind: g.kind, dir: g.dir, versions: g.versions })),
  }
}
