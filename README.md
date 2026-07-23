# inventory-app — CGP Inventory（Stocky 替代）

CineGearPro 自研库存管理 app。核心是**全生命周期库存账本**：
webhook 实时层（自算 delta）→ 归因层（订单/退款匹配 + 后续 ShopifyQL 对账）→
每日快照层（对账自愈）。完整计划见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 架构（M0 + M1 已实现）

- `src/server.js` — Express 入口 + 调度器（webhook 5s / 归因 2min / ShopifyQL 5min / 快照每日）
- `src/auth-embedded.js` — App Bridge session token → token exchange（同 search-panel）
- `src/webhooks.js` — HMAC 验证 → 原始落库（幂等）→ 后台处理；订阅注册
- `src/ledger.js` — 账本写入（append-only）+ current_levels 基线
- `src/attribution.js` — 待归因流水 ↔ 订单/退款匹配
- `src/inventory-history.js` — ShopifyQL 调整历史同步；员工/App/原因/引用/库存状态归并
- `src/snapshot.js` — 每日全量拉取 = 快照 + 漂移对账自愈
- `src/catalog.js` — 商品目录同步及 8 个 Shopify 库存状态基线
- `migrations/` — 全部表结构（含 M2/M3 的调整/盘点/虚拟库存/BOM，先建好）

当前业务界面支持 Brand、Collection、Available 和最近库存修改时间筛选/排序；
商品详情提供 Shopify 前台/后台入口、英文库存状态和长期保存的分页历史；首页可查看
最近 3 天修改商品（每页 10 个），并进入系统状态页复核对账差异。商品信息以 Barcode
为第一识别字段、SKU 为辅助字段；全店每条修改事件均可展开查看涉及商品、仓位和各库存
状态变化，多商品事件也会列出完整明细。

## 部署（Railway）

1. Dev Dashboard 建 app：embedded=true、managed install、Custom distribution → cinegearpro
   Scopes: `read_products, read_locations, write_inventory, read_orders, read_reports`
2. Railway: 新项目 → Deploy from GitHub → 加 **Postgres** 插件 → 加 **Volume** 挂 `/data`
3. 环境变量：见 `.env.example`（`APP_URL` 填 Railway 域名；`DATABASE_URL` 由 Railway 注入）
4. Dev Dashboard 把 App URL 指向 Railway 域名 → 商店安装 → 从 Shopify 后台打开 app
5. 应用内「首页 → 维护工具」依次运行：**同步商品目录** → **重新注册实时接收**
6. 在维护工具运行一次「同步 Shopify 最近 180 天」
7. 之后账本自动记录；每 5 分钟补充完整归因，每日 03:00 UTC 快照对账（`SNAPSHOT_HOUR` 可调）

首次 180 天历史回填会受 ShopifyQL 分钟配额限制并在后台断点续传；默认每次查询间隔
16 秒（`SHOPIFYQL_PACE_MS` 可调），最近记录优先写入。进程部署或重启后会从数据库游标
自动续跑；已写入本地的记录长期保留，因此随着应用运行可查询超过 180 天的历史。
首次同步以前的 Stocky 历史不会自动出现，需要通过后续的 Stocky CSV 导入补齐。

## 本地开发

```bash
npm install
cp .env.example .env   # 填 API key/secret
npm run dev            # 需要本地 Postgres：DATABASE_URL=postgres://localhost/inventory
npm test               # 纯逻辑单元测试（无需数据库）
```

## M0 验收清单

- [ ] 初始同步完成（~9500 变体，首页显示数量）
- [ ] Webhooks 全部注册成功（9 个 topic）
- [ ] 团队在 Stocky/POS 里的真实操作出现在修改记录（Created by 和引用单据正确）
- [ ] 连续 3 天快照 driftHealed = 0（或漂移可解释）
- [ ] /healthz 返回 ok 且 backlog 不增长
- [ ] 抽查商品的 Available / On hand / Committed / Incoming 与 Shopify 一致
- [ ] 商品修改记录中的 Activity / Created by / 各状态变化与 Shopify 一致

详细人工验收步骤见 [TEST_PLAN.md](TEST_PLAN.md)。

## 关键设计约定（改代码前必读）

- **账本 append-only**：业务字段绝不 UPDATE；修正靠追加 reconciliation 行。
- **我们自己的写操作**（M2 调整等）先更 current_levels + 直写账本，webhook 回声
  算出 delta=0 自然跳过；竞态由每日快照自愈。
- **webhook 只落库就返回 200**，一切处理在后台 tick（appproxy 教训）。
- **ShopifyQL 是审计主数据源**：webhook 负责低延迟触发；ShopifyQL 负责员工/App、原因、引用单据和多状态归因，并按外部 change ID 幂等去重。
- **快照逐项自愈**：每日核对 8 个库存状态，任何漂移都追加 reconciliation 行并生成告警。
- **业务记录与技术账本分离**：UI 按一次修改事件合并显示并分页；底层逐状态账本继续
  append-only 保存，不作为日常操作界面暴露。
- inventory mutations 必须带幂等 key（2026-04 强制）：`shopify.js → idempotencyKey()`。
