# inventory-app — CGP Inventory（Stocky 替代）

CineGearPro 自研库存管理 app。核心是**全生命周期库存账本**：
webhook 实时层（自算 delta）→ 归因层（订单/退款匹配 + 后续 ShopifyQL 对账）→
每日快照层（对账自愈）。完整计划见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 架构（M0 已实现）

- `src/server.js` — Express 入口 + 调度器（webhook 5s / 归因 2min / 快照每日）
- `src/auth-embedded.js` — App Bridge session token → token exchange（同 search-panel）
- `src/webhooks.js` — HMAC 验证 → 原始落库（幂等）→ 后台处理；订阅注册
- `src/ledger.js` — 账本写入（append-only）+ current_levels 基线
- `src/attribution.js` — 待归因流水 ↔ 订单/退款匹配
- `src/snapshot.js` — 每日全量拉取 = 快照 + 漂移对账自愈
- `src/catalog.js` — 商品目录同步（初始全量 + webhook 增量）
- `migrations/` — 全部表结构（含 M2/M3 的调整/盘点/虚拟库存/BOM，先建好）

## 部署（Railway）

1. Dev Dashboard 建 app：embedded=true、managed install、Custom distribution → cinegearpro
   Scopes: `read_products, read_locations, write_inventory, read_orders, read_reports`
2. Railway: 新项目 → Deploy from GitHub → 加 **Postgres** 插件 → 加 **Volume** 挂 `/data`
3. 环境变量：见 `.env.example`（`APP_URL` 填 Railway 域名；`DATABASE_URL` 由 Railway 注入）
4. Dev Dashboard 把 App URL 指向 Railway 域名 → 商店安装 → 从 Shopify 后台打开 app
5. 应用内「状态」页依次点：**① 全量同步商品目录** → **② 注册 Webhooks**
6. 之后账本自动记录；每日 03:00 UTC 快照对账（`SNAPSHOT_HOUR` 可调）

## 本地开发

```bash
npm install
cp .env.example .env   # 填 API key/secret
npm run dev            # 需要本地 Postgres：DATABASE_URL=postgres://localhost/inventory
npm test               # 纯逻辑单元测试（无需数据库）
```

## M0 验收清单

- [ ] 初始同步完成（~9500 变体，状态页显示数量）
- [ ] Webhooks 全部注册成功（9 个 topic）
- [ ] 团队在 Stocky/POS 里的真实操作出现在账本流水（来源=待归因/销售）
- [ ] 连续 3 天快照 driftHealed = 0（或漂移可解释）
- [ ] /healthz 返回 ok 且 backlog 不增长

## 关键设计约定（改代码前必读）

- **账本 append-only**：业务字段绝不 UPDATE；修正靠追加 reconciliation 行。
- **我们自己的写操作**（M2 调整等）先更 current_levels + 直写账本，webhook 回声
  算出 delta=0 自然跳过；竞态由每日快照自愈。
- **webhook 只落库就返回 200**，一切处理在后台 tick（appproxy 教训）。
- inventory mutations 必须带幂等 key（2026-04 强制）：`shopify.js → idempotencyKey()`。
