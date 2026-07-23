# 进度 · Inventory

- **状态**: 开发中 · P1 修改记录进入真实店验收
- **进度**: 60%
- **一句话**: 修改记录已从技术账本重构为业务事件：支持全历史分页、英文 Activity、员工/App 归因、订单链接和清晰的首页系统说明。
- **分类**: Shopify App

## 🔨 进行中
- P1 真实店验收：完成 180 天历史回填，抽查订单链接、员工/App 归因和多状态数量

## ⏭ 下一步
- P2：Stocky 风格调整单（仓位、多 SKU、原因、员工、备注、归档、CSV）
- P3：Stocky 历史导入 + 虚拟库存
- P4：Low stock / Lost revenue / Best sellers + 轻量盘点

## 🏁 最近完成
- 信息架构重构：首页只展示商品、修改记录、历史范围和系统健康；技术队列与维护工具折叠并补充解释
- 商品修改记录拆为最近/历史两部分，支持全量分页和仓位筛选；Activity 使用 Shopify 风格英文名称
- 订单引用可直接打开 Shopify Admin；Created by 明确区分 Staff / App / System
- 历史回填支持部署中断后自动续跑，重任务锁改为进程退出自动释放的 Postgres advisory lock
- P1 商品级库存修改记录：ShopifyQL 事件同步、员工/App/原因/引用归因、Admin 风格多状态历史表
- P0 多状态准确性：Available / On hand / Committed / Incoming / Reserved / Damaged / Safety stock / Quality control 全量同步和逐项快照修复
- 商品页默认加载前 100 个，避免首次进入误显示“无结果”
- M0 三层账本骨架(2026-07):webhook HMAC 验证 + 原始幂等落库 + 后台处理、账本 append-only + current_levels 基线、归因匹配、每日快照 + 漂移自愈、商品目录同步(全量+增量)
- 迁移表结构全部建好(含 M2/M3 的调整/盘点/虚拟库存/BOM)
