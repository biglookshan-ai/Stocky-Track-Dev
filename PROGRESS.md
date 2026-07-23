# 进度 · Inventory

- **状态**: 开发中 · P2 库存调整进入安全验收
- **进度**: 86%
- **一句话**: Stocky 风格库存调整已完成 Draft、Barcode 搜索、多商品明细、原因/员工、并发保护、幂等提交、归档与 CSV，等待受控 SKU 写入验收。
- **分类**: Shopify App

## 🔨 进行中
- P2 受控验收：先检查 Draft 全流程，再选择测试 SKU 做 `+1 / -1` 回滚，核对 Shopify Adjustment history、修改记录和最终库存
- P1 持续验收：等待 180 天历史回填完成，抽查 Barcode、事件详情、Collection、前后台链接、订单/员工/App 归因和多状态数量

## ⏭ 下一步
- P2.1：根据真实调整验收反馈优化扫码连续录入和错误提示
- P3：Stocky 历史导入 + 虚拟库存
- P4：Low stock / Lost revenue / Best sellers + 轻量盘点

## 🏁 最近完成
- 新增「库存调整」工作区：列表筛选、状态、原因、员工、仓位、商品数、合计变化及详情
- 新建/编辑 Draft 支持 Barcode、SKU、标题和 Brand 搜索，多商品增减及 Before / Change / After 预览
- 提交 Shopify 前二次确认并重新读取当前 Available；使用 `changeFromQuantity` 阻止覆盖并发修改
- Shopify 2026-04 mutation 使用持久幂等键；网络状态未知可安全重试，成功后锁定为 Applied
- Adjustment reasons 支持方向和启停，员工 user ID 可映射显示名；调整单支持归档与筛选后 CSV 导出
- 本地即时记录只确认本次 Available 写入，其余库存状态等待 Shopify Webhook / ShopifyQL 真值回传，避免重复推算
- 新增调整输入、原因映射、并发 mutation input 与 CSV 转义单元测试
- 商品列表将 Barcode、SKU、Brand 合并到标题下方，腾出空间集中展示 Unavailable、Committed、Available、On hand、Incoming
- 首页与告警中的商品编号统一为无标签紧凑格式，仅 Barcode 加粗
- 修改记录的商品文字/变体数量整体可点击进入详情，仅保留箭头提示
- 移除标题副标题之间的负边距，统一页面标题、卡片标题和说明文字的垂直间距
- 首页最近 3 天修改商品固定每页 10 个并支持翻页，避免长列表挤占首页
- 全店修改记录的每次事件均可打开详情；多商品事件会展开到商品、Barcode、SKU、仓位和各库存状态变化
- 商品列表、商品详情、首页最近修改与告警统一以 Barcode 为第一识别字段，SKU 作为辅助信息
- 全站字号、表格行距、卡片留白和宽表布局统一收紧，减少拥挤换行
- 商品列表支持 Brand 和 Collection 筛选、Shopify Collection 默认顺序，以及 Available、品牌、名称、最近库存修改时间排序
- 商品列表补充当前 Available、最近修改时间和最近库存变化；详情页增加前台商品与 Shopify Admin 按钮
- 商品详情合并为单一「历史修改记录」，库存状态统一使用 Shopify 英文名称
- 首页各概览卡可跳转，新增最近 3 天修改商品；系统状态页可查看对账差异、打开 Shopify 调整并标记已复核
- 历史同步状态区分进行中、暂停和完成，并显示可解释的进度
- 信息架构重构：首页只展示商品、修改记录、历史范围和系统健康；技术队列与维护工具折叠并补充解释
- 商品修改记录支持全量分页和仓位筛选；Activity 使用 Shopify 风格英文名称
- 订单引用可直接打开 Shopify Admin；Created by 明确区分 Staff / App / System
- 历史回填支持部署中断后自动续跑，重任务锁改为进程退出自动释放的 Postgres advisory lock
- P1 商品级库存修改记录：ShopifyQL 事件同步、员工/App/原因/引用归因、Admin 风格多状态历史表
- P0 多状态准确性：Available / On hand / Committed / Incoming / Reserved / Damaged / Safety stock / Quality control 全量同步和逐项快照修复
- 商品页默认加载前 100 个，避免首次进入误显示“无结果”
- M0 三层账本骨架(2026-07):webhook HMAC 验证 + 原始幂等落库 + 后台处理、账本 append-only + current_levels 基线、归因匹配、每日快照 + 漂移自愈、商品目录同步(全量+增量)
- 迁移表结构全部建好(含 M2/M3 的调整/盘点/虚拟库存/BOM)
