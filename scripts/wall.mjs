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
:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;background:#f7f8fa;color:#1c1f23;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{padding:22px 28px;background:#fff;border-bottom:1px solid #e4e7ec;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
h1{font-size:19px;font-weight:600;margin:0}
.meta{color:#7b8491;font-size:13px}
main{max-width:1100px;margin:0 auto;padding:28px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px}
button.tile{padding:0;border:1px solid #e4e7ec;border-radius:12px;background:#fff;overflow:hidden;cursor:pointer;text-align:left;font:inherit;color:inherit;transition:transform .15s}
button.tile:hover{transform:translateY(-3px)}
.cover{height:150px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1d2550,#e58a6a);color:#fff;font-size:34px;font-weight:600;overflow:hidden}
.cover img{width:100%;height:100%;object-fit:cover}
.info{padding:12px 14px 16px}
.tag{font-size:11px;color:#185fa5;background:#e6f1fb;border-radius:5px;padding:2px 7px}
.name{display:block;font-size:15px;font-weight:600;margin:8px 0 4px}
.sub{font-size:12px;color:#7b8491}
#stage{position:fixed;inset:0;background:#000;display:none;flex-direction:column;z-index:10}
#bar{height:38px;flex:none;background:#14171c;color:#e7ebf0;display:flex;align-items:center;gap:14px;padding:0 14px;font-size:13px}
#bar button{background:transparent;border:1px solid #4b5563;color:#e7ebf0;border-radius:6px;padding:3px 10px;cursor:pointer}
#frame{flex:1;width:100%;border:0;background:#000}
.empty{padding:40px;color:#7b8491;text-align:center}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><span class="meta">${included.length} 个游戏 · 筛选 ${escapeHtml(filter)} · 排序 ${escapeHtml(sort)} · 单文件离线</span></header>
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
  b.innerHTML='<div class="cover">'+cover+'</div><div class="info"><span class="tag">'+g.kind+'</span><span class="name">'+escape(g.title)+'</span><span class="sub">'+escape(g.dir)+' · '+g.versions+' 个版本</span></div>';
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
