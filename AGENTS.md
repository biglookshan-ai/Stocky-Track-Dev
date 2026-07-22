# AGENTS.md — Inventory

> 本文件是给 **任何 AI 开发工具**(Claude Code / Cursor / 外部 agent)进入本项目时**先读**的规范。遵守它,开发成果才能被开发中枢正确收录、进度才看得到。

## 项目身份
- 显示名:**Inventory**
- slug:`inventory`
- 分类:Shopify App
- 本地路径:`~/Vibe Coding Dev/Shopify App/inventory-app`
- GitHub:https://github.com/biglookshan-ai/Stocky-Track-Dev.git
- 开发中枢(Apps Hub):`~/Vibe Coding Dev/Lark App/cinegearpro-apps-hub`;全项目总清单:`~/Vibe Coding Dev/PROJECTS.md`

## 开发规范(必须遵守)
1. **提交信息用 Conventional Commits**:`feat: …` / `fix: …` / `docs: …` / `refactor:` / `perf:` / `chore:` / `test:`;破坏性改动加 `!`(如 `feat!: …`)。**中枢靠提交前缀自动定版本号 + 生成 changelog —— 不守规版本和日志就乱。**
2. **绝不提交密钥**:`.env`、token、`*.key` 一律 gitignore,不入库、不外发。
3. 改了架构/技术栈 → 顺手更新本项目 `DOC.md`(若有)或 README。

## 开发完怎么反馈进度(重要)
做完一段,**更新本 repo 根目录的 `PROGRESS.md`**(它就是进度真源):
- `- **状态**:` / `- **进度**:<百分比>` / `- **一句话**:`
- `## 🔨 进行中` / `## ⏭ 下一步` / `## 🏁 最近完成`
然后按规范 commit + push。**中枢会自动从本 repo 读 `PROGRESS.md` 聚合,你无需碰中枢目录。**

## 怎么查看整体进度
- 中枢本地面板:hub 里 `node scripts/serve.js` → http://localhost:4787
- 飞书:知识库「App Doc」+ 多维表 Tasks / Versions
- 全项目一览:`~/Vibe Coding Dev/PROJECTS.md`

## 多 AI 协作
- 多个 AI 工具可能同时在不同项目/文件工作,**看到多出来的文件是正常的**。
- 「谁在做什么」登记在飞书任务板,避免撞车;跨项目大改动先在中枢开个任务。
