---
name: wb-game-studio
description: 用一句话生成可在 WorkBuddy 里直接试玩的小游戏：2D/3D 模板、自动试玩、AI 美术候选与替换、版本回滚、横竖屏与中英界面、游戏墙、局域网分享，最终导出单个离线 HTML。当用户要求「做个小游戏 / 生成游戏 / 一句话做游戏 / 自动试玩一下 / 换个角色图 / 看看我的游戏 / 导出 HTML / 回到上一版」时使用。也适用于用游戏做教学演示、课堂案例或内容素材。This skill should be used when the user asks for a small playable game from a plain-language description, or wants to build, playtest, restyle, preview, version, share or export an existing game project.
agent_created: true
version: 0.2.0
license: MIT
---

# WorkBuddy Game Studio

一句话描述 → 生成可玩的 2D / 3D 游戏 → 自动试玩验证 → 换 AI 美术 → 在结果区直接玩 → 导出单个离线 HTML / 游戏墙 / 临时分享链接。
核心 CLI 只用 Node 标准库；浏览器相关能力用本机 Chrome/Edge 的 DevTools 协议驱动，**不需要 npm 包、不需要 API key**。

## 铁律

1. **所有脚本命令必须以 `env -u NODE_OPTIONS` 开头**。WorkBuddy 沙箱给 Node 注入的 shim 会拦截「新建目录」，并把拒绝伪装成 `EEXIST: mkdir ...`。
2. **游戏必须离线自包含**。产物带 `default-src 'none'` CSP，禁止任何网络请求。素材只能构建前落盘并内联成 data URL，不要在 `game.js` 里写 CDN、`fetch`、`import()`。
3. **不要手写整套游戏**。永远从模板 `create` 起步，再改 `game.json` 的 `rules` 和 `game.js` 的局部逻辑；模板已实现循环、计分、碰撞、界面和 `window.__gameState()` 契约。
4. **预览走结果区**：把 `dist/index.html` 作为 HTML 产物打开，可在右侧内置浏览器直接玩、可刷新。
5. **AI 美术生成会额外消耗积分**（每张约 5–10 积分）。用内置图像生成前，先告知用户；用户没要求换美术时不要主动生成。
6. **OpenAI 出图必须走审批**：`asset generate --provider openai` 默认只返回花费卡片，加 `--yes` 才真正发请求。绝不替用户跳过审批。

## 路径与命令

仓库/技能根目录记为 `S`：在 git 仓库里是仓库根（`S="$(pwd)"`）；装成 WorkBuddy 技能后通常是 `~/.workbuddy/skills/wb-game-studio`。脚本靠自身位置定位 `assets/`，两种位置都能直接运行。

```sh
S="$(pwd)"   # 仓库根；若已装成技能，改成 ~/.workbuddy/skills/wb-game-studio
STUDIO="$S/scripts/studio.mjs"
```

所有命令输出一个 JSON 对象；失败时 `ok:false` + `error` / `code`，退出码 1。

| 命令 | 作用 | 主要参数 |
|---|---|---|
| `create` | 从模板新建项目 | `--dir`、`--template collector\|voxel`、`--title`、`--rules JSON`、`--slots JSON`、`--orientation portrait\|landscape`、`--lang zh\|en`、`--force` |
| `build` | 构建单文件 HTML + 版本快照 | `--dir`、`--note` |
| `playtest` | 无头浏览器自动试玩，报告阶段/分数/生命/fps/错误 + 截图封面 | `--dir`、`--seconds`、`--portrait`、`--characters` |
| `asset generate` | 生成编号美术候选（三通道 + 花费审批） | `--dir`、`--slot`、`--provider builtin\|openai\|codex\|auto`、`--count 1-4`、`--prompt`、`--reference`、`--yes` |
| `asset stage` | 把任意来源图片投放成候选（自动去背+缩放） | `--dir`、`--slot`、`--file`、`--label`、`--source` |
| `asset list` | 列出某槽位的编号候选 | `--dir`、`--slot`（可省） |
| `asset apply` | 按编号应用候选并自动重建 | `--dir`、`--slot`、`--number` |
| `asset revert` | 回退某槽位到上一张图并自动重建 | `--dir`、`--slot` |
| `versions` / `restore` | 版本历史 / 回滚代码+规则+美术 | `--dir`、`--id` |
| `export` | 导出单文件离线 HTML 并校验无外链 | `--dir`、`--out` |
| `share` | 临时只读局域网链接 + 二维码 + 自动到期 | `--dir`、`--seconds`、`--port`、`--no-wait` |
| `list` | 列出工作区所有游戏 | `--root` |
| `wall` / `export-wall` | 生成离线游戏墙（过滤/排序/点击试玩） | `--root`、`--filter 2d\|3d\|all`、`--sort recent\|versions\|name`、`--out`、`--title` |
| `locale` | 查看可用界面语言 | — |

## 工作流（逐闸门推进）

**G1 · 解析需求 → create**
从一句话提取主角、收集物、障碍、场景、胜负条件、时限。出现「3D / 体素 / 立方体 / 岛屿」用 `voxel`，否则 `collector`。
胜负条件翻译成 `rules`：`duration`、`hearts`、`heroSpeed`、`enemySpeed`、`enemySpawnEvery`、`maxEnemies`、`maxPickups`、`shield.enabled` 等。
`--slots` 的 `label` 用**用户原话里的中文角色名**；手机竖屏用 `--orientation portrait`，英文界面用 `--lang en`。

```sh
env -u NODE_OPTIONS node "$STUDIO" create --dir "$PWD/games/fox" --template collector \
  --title "月夜狐·提灯" --rules '{"duration":60,"hearts":3}' \
  --slots '{"hero":{"label":"小狐狸"},"enemy":{"label":"荆棘怪"},"pickup":{"label":"灯笼"}}'
```

**G2 · 定制 → build → 预览**
改 `game.js` 局部（角色造型、关卡、屏幕、特殊规则），保持 `window.__gameState()` / `window.__renderSlots()` 存在（契约见 `references/game-contract.md`）。
`build` 后把返回的 `artifact` 作为 HTML 产物打开预览。检查 `bytes`、`runtime`、`customSlots`、`orientation`、`lang`。

**G3 · 自动试玩验收**

```sh
env -u NODE_OPTIONS node "$STUDIO" playtest --dir "$PWD/games/fox" --seconds 8 --characters
```

看 `phases`（title→playing→won/lost）、`bestScore`、`fps`、`errorCount`、`screenshot`、`cover`。
3D 首次 WebGL 初始化可能要 3–4 秒，脚本会等 `__gameState` 就绪再计时。
非方向键玩法（三消、卡牌、音游、瞄准）自己实现 `window.__autoplay(state)`，试玩会改用它驱动真实循环。
`errorCount > 0` 或 `phases` 卡在 title 时，先修游戏再继续。

**G4 · AI 美术（用户要求时才做）**

推荐通道是 **WorkBuddy 内置图像生成 → `asset stage`**：

1. 告知用户积分消耗，用内置图像生成出图：提示词要求透明底、居中、无文字，`background: transparent`，`1024x1024`。
2. `asset stage --slot hero --file <图片>`：自动检查透明底、抠掉浅色背景、缩放到槽位尺寸、编成编号候选。返回 `transparentRatio` 与 `warning`。
3. `asset list` 看候选编号 → `asset apply --number N`：写入素材、更新 `game.json`、**自动重建**，返回的 `rebuilt.customSlots` 应包含该槽位。
4. 预览确认；不满意用 `asset revert --slot hero` 回退（自动重建）。

另两条通道：
- `asset generate --provider openai --count 2 --prompt "..."`：先返回花费审批卡（服务/张数/预估费用），确认后加 `--yes` 才真发请求；支持 `--reference` 参考图、`--model`、`--base-url`、`--credential`。
- `asset generate --provider codex`：调用本机已登录的 Codex CLI，计入 Codex 套餐，不需要 API key。
- `--provider auto`（默认）：有 `OPENAI_API_KEY` 用 OpenAI，否则返回 builtin 交接说明（CLI 不访问宿主模型，**绝不伪造生成结果**）。

**G5 · 交付（按需选）**

```sh
env -u NODE_OPTIONS node "$STUDIO" export      --dir "$PWD/games/fox"          # 单个离线 HTML
env -u NODE_OPTIONS node "$STUDIO" share       --dir "$PWD/games/fox" --seconds 1800  # 手机扫码试玩
env -u NODE_OPTIONS node "$STUDIO" export-wall --root "$PWD/games" --filter all --sort recent --out wall.html
```

`share` 会打印 URL + 二维码 SVG 路径并保持进程（用后台任务运行；到期自动关闭，只读、POST 返回 405）。
游戏墙把当前筛选/排序下的游戏打包成一个离线页，点击全窗口试玩、Esc 返回；多个 3D 游戏共享一份 three.js。
需要公网链接时用「发布为应用」。

## 项目结构

```
<游戏目录>/
├── game.json                 # title / template / slots / rules / runtime / orientation / lang
├── game.js                   # 游戏代码，改这里
├── assets/                   # 每个美术槽位的图 + ASSETS.json
├── dist/index.html           # 当前构建，单文件离线
└── .studio/
    ├── versions.json         # 版本历史
    ├── versions/<id>/        # 每次构建的快照
    ├── candidates/<slot>/    # 编号美术候选 + candidates.json
    ├── asset-backups/        # 应用前的原图，供 revert
    ├── playtests/<id>/       # 报告、截图、角色特写
    ├── cover.jpg             # 游戏墙封面
    ├── playtest.json         # 最近一次试玩报告
    └── share-qr.svg          # 最近一次分享二维码
```

## 约束与排查

| 现象 | 原因 / 处理 |
|---|---|
| `EEXIST ... mkdir` | 没加 `env -u NODE_OPTIONS` |
| `NO_BROWSER` / `NO_WEBSOCKET` | 自动试玩与图片检查需要本机 Chrome/Edge + Node 22+；可设 `CHROME_PATH` |
| `MISSING_RUNTIME` | 3D 找不到 `assets/vendor/three.min.js` |
| `MISSING_ASSET` | 换图后忘了改 `game.json` 里该槽的 `file`，或 `asset revert` 的备份缺失 |
| 角色还是代码画的 | 看 `build` 的 `customSlots`；素材与模板原文件一致就不会标记 custom |
| 候选有白框 | `asset stage` 会自动抠浅色背景；深色背景请换透明底图 |
| 预览空白 | 打开的是 `game.js` / `dev.html`，不是 `dist/index.html` |
| `share` 卡住对话 | 这是长驻服务，用后台任务运行或加 `--seconds` 短时限 |
| 想回到上一版 | `versions` 取构建号 → `restore --id ...`（代码/规则/美术一起恢复并自动重建） |

安全：产物在带 CSP 的沙箱页面里，禁止联网；API key 只从环境变量读取，不写进项目、日志或工具结果；分享链接只读、限时、仅局域网。
许可：MIT，见 `NOTICE.md`；上游为 `ZSeven-W/dsh-game-studio`，three.js 与 qrcode-generator 的声明一并保留。
