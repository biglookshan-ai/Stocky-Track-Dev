# 进度 · Inventory

- **状态**: 开发中 · M0 骨架完成 · 未部署
- **进度**: 40%
- **一句话**: CGP Inventory —— 替代 Stocky 的自研库存 app,核心是**全生命周期库存账本**(webhook 实时层自算 delta → 归因层匹配订单/退款 → 每日快照层对账自愈)。M0 骨架已实现,待部署 Railway 接真实数据。
- **分类**: Shopify App

## 🔨 进行中
- M0 → 部署:装到 cinegearpro、全量同步商品目录、注册 webhooks,接真实库存事件跑三层账本

## ⏭ 下一步
- 部署 Railway(Postgres + Volume 挂 /data)+ Dev Dashboard 建 app + 装店
- M1:ShopifyQL 报表对账
- M2/M3:手动调整(带审计)、盘点、虚拟库存、BOM(表结构已先建好)

## 🏁 最近完成
- M0 三层账本骨架(2026-07):webhook HMAC 验证 + 原始幂等落库 + 后台处理、账本 append-only + current_levels 基线、归因匹配、每日快照 + 漂移自愈、商品目录同步(全量+增量)
- 迁移表结构全部建好(含 M2/M3 的调整/盘点/虚拟库存/BOM)
