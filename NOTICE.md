# 第三方声明与来源

## 上游项目（MIT）

- **ZSeven-W/dsh-game-studio** — https://github.com/ZSeven-W/dsh-game-studio
- 原始版权：Copyright (c) 2026 ZSeven—W，MIT License
- 本项目是它的**平台移植与精简重写**，不是 git fork。沿用部分：
  - `assets/templates/collector/`、`assets/templates/voxel/` 两套游戏模板与默认 SVG 素材（界面文案已中文化）
  - `game.json` 的项目格式、`window.GAME` / `__gameState()` / `__renderSlots()` 契约
  - 把代码与素材内联成带 CSP 的单个 HTML 的打包思路
- 未沿用：DSH 运行时与工具注册层、React 侧边栏 UI、`package.json` / TypeScript / esbuild 构建体系、OpenAI 与 Codex 出图、花费审批、自动试玩、游戏墙、局域网分享。
- `scripts/studio.mjs` 是为本项目重写的零依赖实现。

上游模板精灵与体素模型为其原创；模板目录里的 `dev.html` / `smoke.py` 是上游开发辅助文件，不参与构建，也不会被复制进游戏项目。

## three.js（MIT）

- **three.js r160.1** — https://threejs.org — MIT License
- 文件：`assets/vendor/three.min.js`（UMD 构建）
- Copyright 2010-2025 three.js authors
- 选择 r160.1 而非上游的 0.187.0，是因为 0.187 起官方不再提供可直接内联的 UMD 构建；3D 模板只用到基础几何、材质、精灵与渲染器 API，r160.1 完全覆盖。
- 3D 游戏导出时会把这份文件内联进 HTML，因此**分发成品时同样需保留 MIT 声明**。

## 示例与截图

- `examples/` 下的两个游戏由本工具从模板生成，游戏逻辑沿用上游模板（MIT）。
- `docs/screenshots/` 为本地无头 Chrome 实测截图。

## 许可证

本项目整体采用 MIT，完整条款见 [LICENSE](LICENSE)。上述第三方组件的版权与许可声明在此一并保留。
