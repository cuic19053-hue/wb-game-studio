# Game contract（模板与构建产物之间的约定）

改动 `game.js` 时必须保持这些接口存在，否则预览和后续自动试玩会失效。

## 页面注入的 `window.GAME`

`build` 会在 `game.js` 之前内联一段脚本：

```js
window.GAME = {
  title: "月夜狐·提灯",
  rules: { /* game.json 的 rules 原样传入，自由格式 */ },
  slots: {
    hero:   { tile: false, custom: false },
    enemy:  { tile: false, custom: false },
    pickup: { tile: false, custom: false },
    background: { tile: true, custom: false }
  },
  assets: { hero: "data:image/svg+xml;base64,...", /* 每个槽位一张内联图 */ }
};
```

- `rules` 自由格式：任何键都会原样传进游戏，模板用 `resolveRules(GAME.rules, DEFAULTS)` 合并默认值。新增规则只需在 `game.json` 加键，并在 `game.js` 里读它。
- `slots[].custom` 由构建脚本自动判定：素材文件与模板原文件哈希不同即为 `true`。模板据此决定用代码画的角色还是用户的图片。直接覆盖 `assets/*.svg` 即可，无需登记。
- `slots[].tile` 来自 `game.json` 的 `tile`，背景/地面类素材设 `true`。
- `assets` 全是 data URL，由 CSP 的 `img-src data: blob:` 允许。

## `window.__gameState()`

返回当前局面，供自动试玩与验收读取。2D collector 模板返回：

```js
{
  phase,        // 例如 ready / playing / won / lost
  time, score, hearts, shield,
  hero:    { x, y },
  enemies: [{ x, y }],
  pickups: [{ x, y }],
  world:   { w, h },
  fps
}
```

3D voxel 模板额外带 `paused` / `best` / `renderer` 等字段；WebGL 不可用时返回 `{ phase: 'error', score: 0, renderer: 'none' }`，可用于快速判断 3D 是否跑起来。

## `window.__renderSlots(size)`

把代码画的角色渲染成缩略图，供游戏墙/封面使用。保持模板里的 `renderSlots` 实现即可。

## `window.__autoplay(state)`（可选）

方向键驱动的游戏由外部模拟按键即可；三消、推箱子、卡牌、音游、瞄准类等非方向键玩法，应自行实现这个函数，按 `state` 返回下一步输入，让自动试玩能跑真实循环。最小闭环不强制要求。

## 页面环境

- 一个 `<canvas id="game" tabindex="0">`，body 全屏黑底，canvas 铺满视口。
- CSP：`default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'`。
- **禁止** `fetch` / `XMLHttpRequest` / `<script src>` / `<link href>` / 动态 `import()` / CDN 字体。所有资源必须构建前内联。
- 3D 项目在 `game.js` 之前额外内联 `assets/vendor/three.min.js`，页面提供全局 `window.THREE`（three.js r160.1 UMD，MIT）。
- 模板会向 `window.parent.postMessage` 汇报错误与渲染缩略图；独立打开时父窗口就是自己，不影响运行。

## 人生模拟（lifesim）模板

文字选择 + 养成类游戏（五年级一路到高考）。它也遵守上面的契约：

- `window.__gameState()` 返回 `{ phase, stage, grade, gradeName, term, age, stats, score, ending, school, retaken, fps }`。`phase` 为 `title → playing → won`；`stage` 是细分阶段（`allocate` 安排时间 / `event` 事件选择 / `report` 学期结算 / `exam` 考试 / `retake` 复读选择 / `ending` 结局）；`score` 是高考分，`ending` 含 `uni`、`tier`（`top/key/ben/zhuan`）、`dreamOk`、`title`。
- `window.__autoplay()` 每次调用会自动推进若干步（均衡安排时间、选第一个选项），试玩因此能在几秒内从标题走到结局。
- 规则（`game.json` 的 `rules`）：`name`、`startGrade`（1–12）、`dream`、`dreamScore`、`hobby`、`slotsPerTerm`、`difficulty`、`seed`、`retake`。`seed` 非 0 时每次人生完全相同，方便复现。
- 页面用 DOM 绘制界面，`<canvas id="game">` 只作动态背景；仅有中文界面（`--lang en` 不会翻译）。
- 自己加事件：复制 `game.js` 里 `EVENTS` 的一项，改 `title` / `text` / 选项 `fx`（属性变化）/ `res`（结果文字）。数值平衡由 `test/lifesim.mjs` 守护：改完请跑 `node --test test/lifesim.mjs`。

## 模板差异

| | collector（2D） | voxel（3D） | lifesim（文字养成） |
|---|---|---|---|
| 渲染 | Canvas 2D 俯视 | three.js WebGL 体素世界 | DOM 界面 + Canvas 动态背景 |
| 运行环境 | 无 | `runtime: ["three"]` | 无 |
| 规则示例 | `heroSpeed: 320`、`enemySpeed: 120`、`heroSize: 76` | `heroSpeed: 6.5`、`worldSize: 34`、`palette` 配色 | `startGrade: 5`、`dream`、`hobby`、`difficulty` |
| 背景槽 | `background.svg`，`tile: true` | `ground.svg`，`tile: true` + `texture: true` | 无（只有 `hero` 槽） |
| 产物体积 | 小（几十 KB） | 约 700 KB（内联 three.js） | 小（约 60 KB） |
