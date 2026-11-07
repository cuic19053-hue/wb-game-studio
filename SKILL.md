---
name: wb-game-studio
description: 用一句话生成可在 WorkBuddy 里直接试玩的小游戏，支持 2D 收集躲避与 3D 体素两套模板、自定义美术、版本回滚，并导出单个离线 HTML 文件。当用户要求「做个小游戏 / 生成游戏 / 一句话做游戏 / 把游戏导出成 HTML / 改一下刚才那个游戏」时使用。也适用于用游戏做教学演示、课堂案例或内容素材。This skill should be used when the user asks for a small playable game from a plain-language description, or wants to build, customize, preview, version or export an existing game project.
agent_created: true
version: 0.1.0
license: MIT
---

# WorkBuddy Game Studio

一句话描述 → 生成可玩小游戏 → 结果区「网页」页签直接试玩 → 换美术 / 改规则 → 导出单个离线 HTML。
纯 Node 标准库实现，零第三方运行时依赖，不需要 DSH、不需要 API key、不需要联网。

## 铁律

1. **所有脚本命令必须以 `env -u NODE_OPTIONS` 开头**。本机 WorkBuddy 沙箱给 Node 注入的 shim 会拦截「新建目录」，并把拒绝伪装成 `EEXIST: file already exists, mkdir ...`。不去掉这个变量，`create` / `build` 建 `dist/`、`.studio/` 时会莫名失败。
2. **游戏必须离线自包含**。构建产物带 `default-src 'none'` 的 CSP，禁止任何网络请求。素材只能在构建前落盘并内联成 data URL，不要在 `game.js` 里写 CDN、`fetch`、`import()`。
3. **不要手写整套游戏**。永远从模板 `create` 起步，再改 `game.json` 的 `rules` 和 `game.js` 的局部逻辑。模板已实现画布、循环、计分、碰撞、界面和 `window.__gameState()` 契约。
4. **预览走结果区**：把 `dist/index.html` 作为 HTML 产物打开，用户可在右侧内置浏览器里直接玩、可刷新。

## 路径与命令

仓库/技能根目录记为 `S`：在 git 仓库里就是仓库根（`S="$(pwd)"`）；装成 WorkBuddy 技能后通常是 `~/.workbuddy/skills/wb-game-studio`。脚本 `S/scripts/studio.mjs` 通过自身位置定位 `assets/`，两种位置都能直接运行。
所有命令输出一个 JSON 对象；失败时 `ok:false` 并带 `error` / `code`。

```sh
S="$(pwd)"   # 仓库根；若已装成技能，改成 ~/.workbuddy/skills/wb-game-studio
STUDIO="$S/scripts/studio.mjs"

# 1. 新建项目（2D 默认；3D 用 --template voxel）
env -u NODE_OPTIONS node "$STUDIO" create --dir "$PWD/games/fox-lantern" \
  --template collector --title "月夜狐·提灯" \
  --rules '{"duration":60,"hearts":3,"enemySpeed":150}' \
  --slots '{"hero":{"label":"小狐狸"},"enemy":{"label":"荆棘怪"},"pickup":{"label":"灯笼"}}'

# 2. 构建成单文件 HTML（每次改动后都要重跑）
env -u NODE_OPTIONS node "$STUDIO" build --dir "$PWD/games/fox-lantern" --note "首版"

# 3. 导出交付文件（默认 <项目>/<标题>-offline.html）
env -u NODE_OPTIONS node "$STUDIO" export --dir "$PWD/games/fox-lantern"

# 其它
env -u NODE_OPTIONS node "$STUDIO" list --root "$PWD/games"
env -u NODE_OPTIONS node "$STUDIO" versions --dir "$PWD/games/fox-lantern"
env -u NODE_OPTIONS node "$STUDIO" restore --dir "$PWD/games/fox-lantern" --id <12位构建号>
```

`create` 选项：`--dir`（必填）、`--template collector|voxel`、`--title`、`--rules JSON`、`--slots JSON`、`--orientation portrait|landscape`、`--force`。
`--rules` / `--slots` 是深合并，只传要改的字段即可；`--slots` 里把某个槽设为 `null` 可删除它。

## 工作流（按顺序做完，不要跳步）

**第 1 步 · 解析需求**
从用户一句话里提取：主角、收集物、障碍/敌人、场景、胜负条件、时限。
判断 2D 还是 3D：描述里出现「3D / 体素 / 立方体 / 岛屿」用 `voxel`，否则 `collector`。
把胜负条件翻译成 `rules`：`duration`（秒）、`hearts`、`heroSpeed`、`enemySpeed`、`enemySpawnEvery`、`maxEnemies`、`maxPickups`、`shield.enabled` 等。
`--slots` 里的 `label` 用**用户原话里的中文角色名**，别用模板默认的 Hero/Enemy。

**第 2 步 · create + 定制**
跑 `create`。然后用文件编辑工具改 `game.js` 中需要变化的部分（角色造型、关卡、屏幕、特殊规则），改完务必保持 `window.__gameState()` 与 `window.__renderSlots()` 存在，契约见 `references/game-contract.md`。
只改必要的局部，不要重写整个模板。

**第 3 步 · build + 预览**
跑 `build`，把返回的 `artifact`（`dist/index.html`）作为 HTML 产物打开预览。
检查返回的 `bytes`（应远小于 24 MB）、`runtime` 和 `customSlots`。

**第 4 步 · 换美术（可选，用户要求时才做）**
用内置图像生成产出图片，保存为项目 `assets/<slot>.png`，再改 `game.json` 里该槽的 `file` 指向它，最后重新 `build`。
**不需要任何额外标记命令**：`build` 会自动比对素材与模板原文件的哈希，不同就把该槽标成 `custom: true`，模板随即用图片替代代码画的角色。
直接覆盖原 `assets/hero.svg` 也有效。槽位尺寸参考 `game.json` 的 `size`，角色图要透明底。

**第 5 步 · 交付**
跑 `export`，确认返回 `offline: true`（表示没有外链脚本/样式/图片）。把生成的 `-offline.html` 交给用户。
需要给别人玩时，用「发布为应用」把这个 HTML 发成公网链接；本地也能直接用任意浏览器打开。

## 项目结构

```
<游戏目录>/
├── game.json        # title / template / slots / rules / runtime / orientation
├── game.js          # 游戏代码，改这里
├── assets/          # 每个美术槽位的图 + ASSETS.json 来源记录
├── dist/index.html  # 当前构建，单文件离线，预览用这个
└── .studio/         # versions.json + 每次构建的快照
```

## 约束与排查

| 现象 | 原因 / 处理 |
|---|---|
| `EEXIST ... mkdir` | 没加 `env -u NODE_OPTIONS` |
| `MISSING_RUNTIME` | 3D 项目找不到 `assets/vendor/three.min.js`（three.js r160.1 UMD，MIT） |
| `MISSING_ASSET` | `game.json` 里某个 slot 的 `file` 路径不存在，或换了图片却忘了改 `file` |
| 角色还是代码画的 | 新图片没覆盖成功 / 与模板原文件完全相同，检查 `build` 返回的 `customSlots` |
| 预览空白 | 打开的是 `game.js` 或 `dev.html`，不是 `dist/index.html` |
| 想回到上一版 | `versions` 拿构建号 → `restore --id ...`（会同时恢复代码、规则、美术并自动重建） |

3D 模板依赖技能内置的 three.js UMD 构建；导出文件里 three.js 已被内联，不访问网络。
游戏代码里的 `window.__gameState()` 供后续自动试玩使用；非方向键玩法可额外实现 `window.__autoplay(state)`。
素材与代码协议见 `NOTICE.md`，模板与代码原始出处为 MIT 协议的 `ZSeven-W/dsh-game-studio`。
