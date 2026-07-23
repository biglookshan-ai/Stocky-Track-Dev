# 进度 · Inventory

- **状态**: 开发中 · P0/P1 库存审计进入真实店验收
- **进度**: 55%
- **一句话**: 已部署并接入真实商品目录；本轮补齐 8 个 Shopify 库存状态、修复 On hand 对账，并实现带员工/App、原因和引用单据的商品级调整历史。
- **分类**: Shopify App

## 🔨 进行中
- P0/P1 真实店验收：注册并验证 9 个 Webhooks、回填 180 天调整历史、抽查 Shopify 与本地多状态数量

## ⏭ 下一步
- P2：Stocky 风格调整单（仓位、多 SKU、原因、员工、备注、归档、CSV）
- P3：Stocky 历史导入 + 虚拟库存
- P4：Low stock / Lost revenue / Best sellers + 轻量盘点

## 🏁 最近完成
- P1 商品级库存修改记录：ShopifyQL 事件同步、员工/App/原因/引用归因、Admin 风格多状态历史表
- P0 多状态准确性：Available / On hand / Committed / Incoming / Reserved / Damaged / Safety stock / Quality control 全量同步和逐项快照修复
- 商品页默认加载前 100 个，避免首次进入误显示“无结果”
- M0 三层账本骨架(2026-07):webhook HMAC 验证 + 原始幂等落库 + 后台处理、账本 append-only + current_levels 基线、归因匹配、每日快照 + 漂移自愈、商品目录同步(全量+增量)
- 迁移表结构全部建好(含 M2/M3 的调整/盘点/虚拟库存/BOM)
