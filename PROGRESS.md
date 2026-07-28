# 进度 · Inventory

- **状态**: 开发中 · 可追溯库存操作进入验收
- **进度**: 93%
- **一句话**: 实时修改记录、三类员工身份、稳定调整编号、全局搜索及 Order/Transfer 详情已完成，等待重新授权后做真实库存验收。
- **分类**: Shopify App

## 🔨 进行中
- P2 受控验收：更新 Shopify scopes 并重新授权，核对实时 webhook、三类人员、调整编号、附件及测试 SKU `+1 / -1` 回滚
- P1 持续验收：抽查全局搜索、修改记录筛选、Order 客户、Transfer 编号/状态和多状态数量

## ⏭ 下一步
- P2.1：销售历史数据模型与周/月/3月/半年/年度统计，形成补货建议基础
- P2.2：中英文界面切换（默认中文）与真实调整验收反馈
- P3：Stocky 历史导入 + 虚拟库存
- P4：Low stock / Lost revenue / Best sellers + 轻量盘点

## 🏁 最近完成
- 修复历史补全重试时「已有正式记录 + 后到 Webhook 占位记录」触发唯一键冲突的问题，并覆盖 Shopify 额外库存状态的重复占位合并
- 部署恢复历史回填前强制幂等重扫最近 2 天，确保旧游标之前遗留的「库存信息补全中」也会被再次处理
- 日常 ShopifyQL 增量回看窗口由 2 分钟扩大到 30 分钟，防止报表延迟导致新 Webhook 占位记录被跳过
- 180 天 ShopifyQL 回填从逐日查询优化为最多 7 天一批、超量自动拆分，显著减少限流等待次数
- 手动回填和部署恢复会先补最近记录，再继续旧历史，避免「库存信息补全中」被长任务持续阻塞
- 历史同步进度补充当前回填日期与悬浮说明，明确百分比按批次跳动而非逐行增长
- 将用户难懂的「归因处理中 / 对账提醒 / 需要复核」统一改为「库存信息补全 / 库存有差异」，并增加鼠标悬停与键盘聚焦说明
- 差异说明明确本应用只校正本地记录、不修改 Shopify 库存；确认按钮改为更直观的「标记已确认」
- 实时接收注册会强制刷新离线 token、读取当前安装实际 scopes，并在页面精确列出待授权权限，不再只显示失败事件数量
- 补齐 Fulfillment Webhook 所需 `read_fulfillments`，并将 Order / Fulfillment / Transfer / Shipment topic 映射到各自权限
- 修复 Shopify 2026-04 不支持 `INVENTORY_TRANSFERS_UPDATED` 导致整批 Webhook 注册中断的问题，改用受支持的 Add/Remove items 事件
- Webhook 改为逐项注册和核心/扩展分级；单个调拨、运输事件缺少权限或版本不支持时，不再阻断库存核心实时接收
- webhook 库存变化先即时生成 Pending attribution 可见记录，ShopifyQL 后续原位补齐来源，避免最新记录长期停在旧日期
- 新调整单采用 `ADJ-YYYYMM-xxxxx` 稳定编号，区分 Shopify 登录账号、实际记录员工和多位经手员工
- 员工资料支持员工编号与不绑定 Shopify 账号的本地员工，人员可在调整详情和 CSV 中长期保留
- 顶栏全局搜索覆盖商品、Barcode、SKU、Brand、人员、调整编号、Order/Transfer；修改记录新增人员、来源和日期筛选
- Order 引用补充订单名称、客户、财务/履约状态和 Admin 链接；Transfer 补充准确编号、状态、起点/终点与链接
- 健康状态补充 webhook 最近接收/处理时间和错误数，实时性不再只用笼统文字表示
- 调整数量改为明确的 `− / +` 方向按钮和正整数数量，按 Before 自动计算 After；reason 可锁定允许方向
- Notes 升级为 10,000 字多行说明；Draft 支持图片、视频、PDF 与常用文件附件，每个 50 MB、每单 20 个
- 附件保存到 Railway `/data` Volume、元数据保存到 Postgres，仅认证员工可访问，危险脚本/可执行类型被拒绝
- 修改记录详情将缺失状态显示为「未提供」而非 `—`，说明其不等于 0，并展示 Shopify 返回的其他库存状态
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
