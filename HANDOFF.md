# CGP Inventory（Stocky Track Dev）完整交接文档

> 最后核对：2026-07-31  
> 代码基线：`main` / `6ac9b11 fix: keep inventory history authoritative`  
> 当前阶段：开发中，真实库存记录模式进入验收，整体进度约 95%

本文档用于把项目完整交给下一位开发者或 AI。它记录当前产品目标、已上线功能、真实数据口径、系统架构、数据库、API、部署、测试、开发演进、已知限制和下一步计划。

如本文档与旧设计稿冲突，以以下优先级判断：

1. 当前 `main` 分支代码；
2. 本文档；
3. `README.md`、`TEST_PLAN.md`、`PROGRESS.md`；
4. `DEVELOPMENT_PLAN.md` 中仍未过时的长期计划。

`DEVELOPMENT_PLAN.md` 保留了项目最初的 Stocky 替代规划，因此其中有些功能只是计划或预建表结构，不能视为已经上线。

---

## 1. 项目身份与资源

| 项目 | 内容 |
|---|---|
| 显示名 | Inventory / CGP Inventory |
| Shopify App 名称 | Stocky Track Dev |
| 项目 slug | `inventory` |
| 分类 | Shopify App |
| 本地路径 | `~/Vibe Coding Dev/Shopify App/inventory-app` |
| GitHub | https://github.com/biglookshan-ai/Stocky-Track-Dev.git |
| 默认分支 | `main` |
| 生产托管 | Railway |
| 已知生产域名 | `https://stocky-track-dev-production.up.railway.app` |
| Shopify 店铺 | `cinegearpro.myshopify.com` |
| App handle | `stocky-track-dev` |
| Node 版本 | Node.js 18+ |
| 数据库 | Railway PostgreSQL |
| 附件存储 | Railway Volume，生产挂载到 `/data` |

项目进度的真源是根目录 `PROGRESS.md`。每完成一段开发，应更新进度并使用 Conventional Commits 提交、推送。

严禁把 `.env`、Admin token、App Secret、数据库密码或任何密钥提交到 Git。

---

## 2. 产品目标

这个 App 用于替代即将停止服务的 Stocky，并把库存数据长期保存在 CineGearPro 自己的系统中。

当前产品重点不是采购系统或复杂 ERP，而是：

- 如实保存 Shopify 商品的库存变化；
- 清楚显示谁、哪个 App、哪张订单或调拨单造成了变化；
- 按 Barcode 快速找到商品；
- 长期保留超过 Shopify 商品页 180 天展示窗口的历史；
- 安全地创建人工库存调整，并保留编号、人员、备注和证据附件；
- 区分下单占用、真实出货、退货、采购入库，形成后续补货计划的数据基础。

### 当前最重要的数据原则

1. **Shopify 是当前库存真值。** `current_levels` 只缓存 Shopify 返回的当前数量。
2. **修改记录只保存真实操作。** 来源只能是 ShopifyQL、Webhook 或本 App 已成功提交的调整。
3. **快照是检查点，不是业务操作。** 每日快照不能虚构操作人、原因、时间或修改记录。
4. **账本 append-only。** 已发生的真实数量变化不覆盖、不删除；正式记录通过外部 change ID 幂等合并。
5. **不向用户展示技术不确定性。** 旧版“库存有差异 / 需要复核”是本地推算产生的内部噪音，已经从 UI 和新数据流程中移除。
6. **不把下单当成销售完成。** Available 被占用代表需求；只有履约导致 On hand 减少才算真实销售出库。

---

## 3. 当前已上线功能

### 3.1 首页

首页提供：

- 商品 / Barcode 总数入口；
- 修改记录总数入口；
- 本地已保存历史范围；
- 系统状态入口；
- 实时接收、每日库存刷新和历史同步状态；
- 最近 3 天修改的商品；
- 最近商品列表每页 10 个，支持上一页 / 下一页；
- 商品标题下紧凑显示 Barcode、SKU、Brand，Barcode 加粗；
- 每条最近商品显示 Activity、Created by、Location、Available、Last change。

首页不再显示“库存有差异”或人工复核列表。

### 3.2 商品列表

商品列表支持：

- 搜索 Barcode、标题、SKU、Brand；
- Barcode 作为第一识别字段；
- Brand 筛选；
- Shopify Collection 筛选；
- 按 Collection 默认顺序显示；
- 按名称、Brand、Available 高低、最近库存修改时间排序；
- 显示 Unavailable、Committed、Available、On hand、Incoming；
- 显示最近库存变化和最近修改时间；
- 分页；
- 点击进入商品详情。

商品列表读取 `current_levels` 的 Shopify 当前值，不使用本地推算库存。

### 3.3 商品详情

商品详情包括：

- 商品名称；
- Barcode、SKU、Brand、售价和成本；
- Shopify 前台商品按钮；
- Shopify Admin 商品按钮；
- 全仓总计概览；
- 各仓库存状态卡；
- Unavailable 组成说明；
- Available / On hand / Committed / Incoming 动态阶梯趋势；
- 仓位筛选；
- 最近 30 / 90 / 180 天或全部历史范围；
- 鼠标悬停查看 Activity、仓位和该次变化；
- 分页历史修改记录；
- 单一“历史修改记录”，不再同时出现“最近记录”和“历史记录”两套重复表。

库存趋势使用“当前 Shopify 数量 + 已保存真实事件反向重建”。如果没有足够历史，显示空状态，不绘制误导性直线。

旧版 `reconciliation` 技术修正行被排除在趋势之外。

### 3.4 修改记录

全店修改记录按一次 Shopify InventoryAdjustmentGroup 合并显示，支持：

- 日期、Activity、Created by、Product、Location、Reference；
- 按商品、Barcode、SKU、订单、调整编号搜索；
- 按员工或 App 搜索；
- 按来源筛选；
- 按日期范围筛选；
- 分页；
- 点击商品文字、变体数量或箭头进入事件详情；
- 多商品事件展开全部商品和仓位；
- 显示 Unavailable、Committed、Available、On hand、Incoming 的 delta 和 after；
- Shopify 没返回某状态时显示“未提供”，不能把缺失值当作 0；
- Order / Transfer 引用可打开 Shopify Admin。

Activity 保留 Shopify 英文命名，例如：

- `Purchased`
- `Order Edited`
- `Order fulfilled`
- `Shipment Marked As In Transit`
- `Shipment Received`
- `Transfer Updated`
- `Manually adjusted`
- `Inventory updated`

### 3.5 修改记录详情

每个事件详情显示：

- Date；
- Activity；
- Created by；
- Staff / App / System 类型；
- Reference；
- Order / Transfer 的准确编号、状态和 Admin 链接；
- Order 客户名称（权限和订单访问窗口允许时）；
- 全部涉及商品；
- Barcode、SKU；
- 仓位；
- 各库存状态变化；
- 如果来自本 App 调整，显示调整编号、登录账号、实际记录员工、经手员工和 Notes。

### 3.6 全局搜索

顶栏搜索覆盖：

- 商品标题；
- Barcode；
- SKU；
- Brand；
- 员工；
- App；
- 本地调整编号；
- Shopify Order；
- Shopify Transfer；
- 修改记录。

搜索结果按商品、库存调整、人员和修改记录分组。

### 3.7 库存调整

已上线 Stocky 风格的多商品调整 Draft 工作流。

#### Draft

- 选择仓位；
- 选择 Adjustment reason；
- 按 Barcode、SKU、标题、Brand 搜索商品；
- 多商品添加；
- 使用明确的 `+` / `−` 方向；
- 输入正整数数量；
- 自动计算 Before / Change / After；
- 保存 Draft 不改变 Shopify；
- 支持编辑、归档和 CSV 导出。

#### 人员追踪

每张调整可区分：

- Shopify 登录账号：谁登录并执行 App；
- 实际记录员工：谁在系统里录入这张单；
- 经手员工：谁实际拿走、放回或处理了商品，可多人；
- 本地员工：可不绑定 Shopify 账号；
- 员工编号：`employee_code`。

每张新调整单使用稳定编号：

`ADJ-YYYYMM-xxxxx`

#### Notes 和附件

- Notes 最长 10,000 字；
- 每张 Draft 最多 20 个附件；
- 单文件最大 50 MB；
- 支持图片、视频、PDF 和常见办公文件；
- 拒绝危险脚本和可执行文件；
- 元数据保存在 Postgres；
- 文件保存在 `DATA_DIR/adjustment-attachments`；
- 附件仅认证员工可读取。

#### 提交 Shopify

- 提交前二次确认；
- 提交前重新读取 Shopify 当前 Available；
- 使用 `changeFromQuantity` 做 compare-and-set，避免覆盖并发修改；
- 使用持久幂等键，网络结果未知时可以安全重试；
- 成功后调整单锁定为 Applied；
- 本地只立即确认本次 Available 写入；
- On hand 等其他状态等待 Shopify Webhook / ShopifyQL 正式回传；
- 不根据本地假设补写其他库存状态。

### 3.8 销售历史

商品详情的销售历史支持：

- 最近 7 天；
- 最近 30 天；
- 最近 3 个月；
- 最近半年；
- 最近一年；
- 全部本地记录。

显示指标：

- 下单数量；
- 已出货销量；
- 待出货；
- 取消 / 释放；
- 退货入库；
- 净销售量；
- 采购入库；
- 周均已出货；
- 预计可售天数；
- 周期图；
- 关联订单 / 客户 / Activity 明细。

口径：

| 业务 | 判定 |
|---|---|
| 下单需求 | Order 导致 Available 减少，On hand 不变 |
| 真实销售出库 | `Order fulfilled` 等订单履约导致 On hand 减少 |
| 取消 / 释放 | Order 导致 Available 增加，On hand 不变 |
| 待出货 | 同一订单的下单 − 已出货 − 已释放 |
| 退货 | 订单 / Refund / Return 导致 On hand 增加 |
| 采购入库 | `Purchase order received` 导致 On hand 增加 |
| 不计销量 | 内部调拨、人工调整、App 修正、单纯库存校正 |

周均销量和预计可售天数只使用真实净出货，不使用下单占用。

### 3.9 系统状态与维护工具

系统状态页显示：

- 实时接收队列；
- Webhook 最近接收和处理时间；
- Webhook 错误数；
- 库存信息补全数量；
- Shopify 当前库存刷新状态；
- 最近 180 天历史同步状态和进度；
- 数据记录原则；
- 折叠的维护工具。

维护工具：

- 同步商品目录；
- 重新注册实时接收；
- 刷新 Shopify 当前库存；
- 同步 Shopify 最近 180 天。

这些按钮用于安装、恢复和人工排障，正常使用不应反复点击。

---

## 4. 已废弃或尚未完成的功能

### 4.1 已废弃：库存差异复核

旧版本曾把本地推算值与 Shopify 快照比较，并生成：

- “库存有差异”；
- “需要复核”；
- `reconciliation` 账本行；
- `reconcile_alerts` 人工确认列表。

这会让 Shopify 已经正确的库存看起来“不确定”。从 migration `008_archive_reconcile_alerts.sql` 起：

- 所有旧提醒统一标记为 resolved；
- 快照不再生成告警；
- 快照不再生成账本行；
- UI 不再读取或显示复核列表；
- 趋势排除旧 `reconciliation` 行；
- 不会修改 Shopify 库存。

`/api/alerts` 和 `/api/alerts/:id/resolve` 目前仅为滚动部署兼容留在后端，属于 dormant legacy API。除非专门做清理迁移，否则不要恢复到 UI。

### 4.2 尚未上线

以下有些已有数据库表，但没有完整业务模块或 UI：

- 中英文界面切换（默认中文的 i18n）；
- Stocky CSV 历史导入；
- 轻量盘点；
- 本地 `#` 产品完整工作流；
- Bundle / BOM 组装拆散；
- 虚拟库存完整页面；
- Low stock 仪表盘；
- Lost revenue 仪表盘；
- Best sellers / ABC；
- 自动补货规则和补货建议；
- 库存估值报表；
- Lark 通知；
- BIS 缺货需求联动。

不能因为 `migrations/001_init.sql` 已经存在 `virtual_stock`、`stocktakes`、`bundle_components` 表，就声称这些功能已经完成。

---

## 5. 系统架构

技术栈：

- Node.js 18+；
- Express 4；
- 原生 JavaScript SPA；
- Shopify App Bridge v4；
- PostgreSQL，直接使用 `pg`；
- Shopify GraphQL Admin API `2026-04`；
- Railway Web + Postgres + Volume；
- 无 React、无 ORM、无前端构建步骤。

### 5.1 三层数据链路

```text
Shopify inventory webhook
        │
        ▼
webhook_events（HMAC 验证、原始 payload、webhook ID 幂等）
        │  后台每 5 秒处理
        ▼
inventory_ledger provisional rows + current_levels
        │
        ├── attribution（每 2 分钟，订单 / Refund 初步匹配）
        │
        └── ShopifyQL inventory history（webhook 触发 60s 防抖 + 5 分钟兜底，回看最近 2 天）
                │
                ▼
        inventory_events + 正式 ledger changes
        补齐 Activity / Staff / App / Reference / 各状态
                │
                ▼
        事件触发合并 provisional 占位，避免重复记录

每日 Shopify 全量读取
        │
        ├── current_levels：直接刷新 Shopify 当前值
        └── daily_snapshots：变化检查点 / 每月 1 日全量基线
             不创建修改记录、不创建告警
```

### 5.2 为什么同时使用 Webhook 和 ShopifyQL

Webhook 的优点是快，但库存 Webhook 主要给当前值，不完整提供：

- 操作人；
- App；
- Activity；
- Order / Transfer 引用；
- 完整多状态变化。

因此 Webhook 只用于：秒级刷新当前库存数字、并作为内部占位记录等待正式流水。**2026-07-31 起：所有面向用户的记录列表/详情/趋势/最近变动只显示正式记录**（`formalEvent` 谓词排除 `webhook:%` 占位事件）；占位纯内部核对用，界面上不存在「补全中」状态。一笔修改在官方流水回传后（通常几分钟）以一条完整记录出现。

ShopifyQL 是审计主数据源，Webhook 是低延迟触发源。

### 5.3 当前库存与历史的区别

- 当前库存：永远取 Shopify 最新值，写入 `current_levels`；
- 修改历史：只取真实事件，写入 `inventory_events` + `inventory_ledger`；
- 快照：保存当前状态检查点，不伪装成修改事件；
- 历史不完整不能影响当前库存准确性；
- 当前库存准确也不代表 ShopifyQL 旧历史已全部回填。

---

## 6. 后台调度

调度器位于 `src/server.js`。

| 周期 | 任务 | 说明 |
|---|---|---|
| 每 5 秒 | `processPending()` | 处理未完成 Webhook；有新事件时触发 provisional 合并 |
| 每 2 分钟 | `runAttribution()` | 尝试按订单 / Refund 归因 pending ledger |
| webhook 触发（60s 防抖）+ 5 分钟兜底 | `runHistorySync(days: 2)` | ShopifyQL 回看最近 2 天；库存 webhook 到达后尽快拉取正式流水 |
| 每分钟检查 | 每日 Snapshot | 到 `SNAPSHOT_HOUR` UTC 后每天只运行一次 |
| 部署启动 | provisional 合并 | 清理正式记录已经存在的重复占位 |
| 部署启动 | 历史恢复 | 如果 180 天回填中断，从数据库 cursor 续跑 |

固定每 30 秒的“信息补全扫描”已经移除。现在只有真实 Webhook 处理完成时才触发占位合并；空闲时不会反复查询。

重任务使用 PostgreSQL advisory lock `shopify-heavy`，避免历史回填、快照等任务并发消耗 Shopify API 配额。

Railway 部署时新旧容器可能短暂重叠。如果历史任务锁被旧容器占用，启动恢复会每 15 秒重试，直到获得锁。

---

## 7. 历史范围与数据保留

### Shopify 历史回填

- 首次手动同步最多读取 Shopify 最近 180 天库存历史；
- 默认查询间隔 `SHOPIFYQL_PACE_MS=16000`；
- 每批最多 7 天；
- 行数过多时自动拆分时间窗口；
- 后台保存 cursor；
- 部署或重启后断点续传；
- 开始旧历史前优先补最近 2 天；
- 重复运行按 Shopify change ID 幂等；
- 本地保存的历史不会因为超过 180 天而删除。

因此：

- App 持续运行后，可以看到超过 180 天的本地累计历史；
- 首次安装以前超过 Shopify 可查询范围的历史不会自动出现；
- 更早 Stocky 历史需要未来的 Stocky CSV 导入功能；
- 订单客户等详情通常受 Shopify 60 天订单访问窗口限制；如需更早数据，需要申请 `read_all_orders`。

### 数据保留

- `inventory_ledger`：长期保留；
- `inventory_events`：长期保留；
- `webhook_events`：当前没有自动清理策略；
- `daily_snapshots`：变化行 + 每月 1 日全量基线；
- `reference_documents`：15 分钟缓存刷新；
- 调整附件：依赖 Railway Volume，必须备份；
- 旧 `reconcile_alerts`：保留但全部归档。

---

## 8. 数据库模型

迁移在服务启动时按文件名顺序自动执行，并记录在 `schema_migrations`。

### 8.1 迁移列表

| 文件 | 作用 |
|---|---|
| `001_init.sql` | 商店、员工、仓位、商品、current levels、账本、Webhook、快照、调整、虚拟库存、盘点、BOM、sync state |
| `002_inventory_audit.sql` | 8 个库存状态、Inventory Event 父记录、ShopifyQL 审计字段 |
| `003_history_pagination.sql` | 商品历史分页索引 |
| `004_adjustment_workflow.sql` | 调整幂等、引用、错误和归档字段 |
| `005_adjustment_attachments.sql` | 调整附件元数据 |
| `006_traceable_operations.sql` | 员工编号、调整显示编号、参与人员、Order / Transfer 缓存 |
| `007_shop_tokens.sql` | Postgres 加密离线 token |
| `008_archive_reconcile_alerts.sql` | 归档旧库存差异告警 |

### 8.2 核心表

#### `shops`

- 店铺域名；
- AES-256-GCM 加密的 offline token；
- token 更新时间。

#### `staff`

- Shopify user ID；
- 本地员工编号；
- 显示名；
- admin / member；
- active。

#### `locations`

- Shopify Location GID；
- 仓位名称；
- active。

#### `items`

- Shopify variant / product / inventory item GID；
- 商品与变体标题；
- SKU；
- Barcode；
- Vendor / Brand；
- 售价、成本；
- tracked；
- active / archived / deleted；
- source 为 `shopify` 或未来使用的 `local`。

#### `current_levels`

每个商品 × 仓位最新 Shopify 当前值：

- available；
- on_hand；
- committed；
- incoming；
- reserved；
- damaged；
- safety_stock；
- quality_control。

这是缓存，不是历史账本。

#### `inventory_events`

一次 Shopify InventoryAdjustmentGroup 的父记录：

- Shopify group GID；
- occurred time；
- Activity / reason；
- App；
- Staff；
- Reference URI / type / ID；
- source type；
- 原始数据。

#### `inventory_ledger`

一次事件中的商品 × 仓位 × state 变化：

- delta；
- qty_after；
- occurred_at；
- source_type；
- event_id；
- external_change_id；
- actor / app；
- reference；
- attribution。

正式 Shopify 行通过 `external_change_id` 唯一约束幂等。

#### `webhook_events`

- Webhook ID 唯一；
- topic；
- shop；
- 原始 JSON；
- received / processed 时间；
- error。

Webhook 处理失败时保留未处理状态，后续 5 秒 tick 会继续重试。

#### `daily_snapshots`

- 日期；
- 商品；
- 仓位；
- 8 个库存状态；
- unit cost。

日常只保存有变化行，每月 1 日保存完整基线。

#### 调整相关

- `adjustment_reasons`
- `adjustments`
- `adjustment_lines`
- `adjustment_participants`
- `adjustment_attachments`

#### `reference_documents`

缓存 Order / Transfer：

- 可读编号；
- 客户；
- 状态；
- Admin URL；
- 起点 / 终点等 details；
- fetch error。

#### `sync_state`

保存：

- 初始目录同步；
- Snapshot 进度；
- 历史增量 cursor；
- 180 天 backfill cursor；
- Webhook 注册结果；
- 最后成功 / 错误时间。

---

## 9. 后端模块

| 文件 | 职责 |
|---|---|
| `src/server.js` | Express、API、查询、调度器、恢复任务 |
| `src/db.js` | PostgreSQL pool、迁移、sync state、advisory lock |
| `src/auth-embedded.js` | App Bridge session JWT 验证、token exchange、登录员工解析 |
| `src/token-store.js` | offline token AES-256-GCM 加密、Postgres 持久化、Volume 缓存 |
| `src/shopify.js` | GraphQL client、限流重试、幂等 key |
| `src/catalog.js` | Location / Variant / 8 状态目录同步 |
| `src/webhooks.js` | HMAC、原始落库、后台处理、订阅注册 |
| `src/ledger.js` | current level 更新、delta 计算、append-only ledger |
| `src/attribution.js` | Webhook provisional 与 Order / Refund 初步归因 |
| `src/inventory-history.js` | ShopifyQL、正式事件入库、断点续传、占位合并 |
| `src/snapshot.js` | Shopify 当前库存权威刷新、增量快照 |
| `src/inventory-trend.js` | 从当前值和真实 delta 重建阶梯趋势 |
| `src/sales-history.js` | 销售生命周期分类、汇总和周期序列 |
| `src/references.js` | Order / Transfer 解析、缓存和 Admin 链接 |
| `src/adjustment-core.js` | 调整纯逻辑校验、reason 映射、GraphQL input、CSV |
| `src/adjustments.js` | Draft CRUD、人员、提交、幂等重试、归档、CSV |
| `src/adjustment-attachments.js` | 附件类型、大小、文件存储和访问 |

---

## 10. 前端结构

前端是 `public/` 下的原生 JS SPA：

| 文件 | 作用 |
|---|---|
| `public/index.html` | App Bridge 加载、导航、根容器 |
| `public/app.js` | Hash router、页面、API 调用、图表和交互 |
| `public/style.css` | Polaris 风格布局、嵌入式宽表和响应式样式 |
| `public/session-client.js` | Session token 获取、401 刷新、并发刷新去重 |

Hash 路由：

- `#/dashboard`
- `#/items`
- `#/items/:id`
- `#/history`
- `#/history/:id`
- `#/adjustments`
- `#/adjustments/new`
- `#/adjustments/:id`
- `#/adjustments/:id/edit`
- `#/system`
- `#/search?q=...`

Session token 过期处理：

- 所有前台 API、CSV、附件预览、上传统一走 session client；
- 401 时刷新 token 并安全重试；
- 最多重试两次；
- 并发 401 共用一次刷新；
- 不应再要求用户手动刷新整个页面处理 `session token expired`。

目前界面默认中文，但 Activity 和 Shopify inventory state 保留英文；完整中英文切换尚未实现。

---

## 11. API 清单

### 公共端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/`、`/index.html` | Embedded SPA |
| GET | `/api/config` | App Bridge API key / API version |
| POST | `/webhooks` | Shopify Webhook，内部 HMAC 验证 |
| GET | `/healthz` | Railway / 监控健康状态 |

### 认证端点

以下均要求 `Authorization: Bearer <App Bridge session token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 首页和系统状态 |
| GET | `/api/recent-items` | 最近 3 天商品 |
| POST | `/api/setup/sync` | 全量同步商品目录 |
| GET/POST | `/api/setup/webhooks` | 查询 / 注册 Webhook |
| POST | `/api/jobs/snapshot` | 立即刷新 Shopify 当前库存 |
| POST | `/api/jobs/attribution` | 立即运行归因 |
| POST | `/api/jobs/history` | 运行历史增量或 180 天回填 |
| GET | `/api/item-options` | Brand / Collection 等商品筛选选项 |
| GET | `/api/items` | 商品列表 |
| GET | `/api/items/:id` | 商品详情和各仓库存 |
| GET | `/api/items/:id/trend` | 商品库存趋势 |
| GET | `/api/items/:id/sales` | 商品销售生命周期 |
| GET | `/api/items/:id/history` | 商品分页修改历史 |
| GET | `/api/history` | 全店修改记录 |
| GET | `/api/history/:id` | 一次修改事件详情 |
| GET | `/api/search` | 全局搜索 |
| GET | `/api/adjustment-options` | 原因、仓位、员工、当前登录信息 |
| GET | `/api/adjustment-items` | 调整商品搜索 |
| GET | `/api/adjustments` | 调整单列表 |
| POST | `/api/adjustments` | 新建 Draft |
| GET | `/api/adjustments/:id` | 调整详情 |
| PUT | `/api/adjustments/:id` | 编辑 Draft |
| POST | `/api/adjustments/:id/apply` | 提交 Shopify |
| POST | `/api/adjustments/:id/archive` | 归档 |
| GET | `/api/adjustments.csv` | CSV 导出 |
| POST | `/api/adjustments/:id/attachments` | 上传附件 |
| GET | `/api/adjustments/:id/attachments/:attachmentId` | 查看 / 下载附件 |
| DELETE | `/api/adjustments/:id/attachments/:attachmentId` | 删除 Draft 附件 |
| POST/PATCH | `/api/adjustment-reasons...` | 原因管理 |
| POST/PATCH | `/api/staff...` | 员工管理 |
| GET | `/api/alerts` | 旧兼容接口，不应接回 UI |
| POST | `/api/alerts/:id/resolve` | 旧兼容接口，不应接回 UI |

---

## 12. Shopify 权限与 Webhook

### Scopes

```text
read_products
read_locations
write_inventory
read_orders
read_reports
read_fulfillments
read_inventory_transfers
read_inventory_shipments
read_inventory_shipments_received_items
```

可选：

```text
read_all_orders
```

修改 scopes 后必须在 Shopify 重新授权 / 安装，再重新注册实时接收。

### 核心 Webhooks

- `INVENTORY_LEVELS_UPDATE`
- `INVENTORY_ITEMS_UPDATE`
- `PRODUCTS_CREATE`
- `PRODUCTS_UPDATE`
- `PRODUCTS_DELETE`
- `LOCATIONS_CREATE`
- `LOCATIONS_UPDATE`

### 扩展 Webhooks

- Orders create / updated / cancelled；
- Fulfillments create / update；
- Refunds create；
- Inventory Transfers add / remove items、cancel、complete、ready to ship、update quantities；
- Inventory Shipments create、mark in transit、receive items、update quantities。

注册逻辑逐 topic 隔离失败。某个可选 topic 因权限或 API 版本失败，不能阻断核心库存 topic。

Shopify API `2026-04` 不支持旧的 `INVENTORY_TRANSFERS_UPDATED` topic；不要重新加回。

---

## 13. 环境变量

以 `.env.example` 为准：

| 变量 | 必须 | 说明 |
|---|---|---|
| `SHOPIFY_API_KEY` | 是 | Dev Dashboard Client ID |
| `SHOPIFY_API_SECRET` | 是 | JWT/HMAC/token 加密密钥 |
| `SHOPIFY_API_VERSION` | 是 | 当前 `2026-04` |
| `SHOP` | 后台任务需要 | `cinegearpro.myshopify.com` |
| `APP_URL` | Webhook 注册需要 | Railway 公网 URL |
| `DATABASE_URL` | 是 | Railway Postgres 自动注入 |
| `DATA_DIR` | 生产附件需要 | `/data` |
| `SNAPSHOT_HOUR` | 否 | 默认 UTC 03:00 |
| `SHOPIFYQL_PACE_MS` | 否 | 默认 16000 ms |
| `PORT` | Railway 注入 | 默认 3000 |
| `PGSSLMODE` | 视数据库而定 | `require` 时启用 SSL |
| `SHOPIFY_ADMIN_TOKEN` | 仅调试 | 固定 token 覆盖 token exchange，不建议生产长期设置 |
| `SHOPIFY_APP_HANDLE` | 否 | 默认 `stocky-track-dev` |

`SHOPIFY_API_SECRET` 同时用于解密数据库中的 offline token。更换 Secret 后，旧 ciphertext 无法解密，必须重新从 Embedded App 触发 token exchange。

---

## 14. 本地开发

```bash
cd "/Users/chillmungc/Vibe Coding Dev/Shopify App/inventory-app"
npm install
cp .env.example .env
# 填入 Shopify credentials 和本地 PostgreSQL DATABASE_URL
npm run dev
```

生产方式启动：

```bash
npm start
```

测试：

```bash
npm test
```

当前测试为 Node 内置 `node:test`，不依赖数据库，覆盖 49 个测试。

主要覆盖：

- 调整输入、人员、编号、附件和 CSV；
- HMAC 和 Webhook 注册隔离；
- attribution；
- ShopifyQL query、分批、归因和事件合并；
- inventory trend；
- sales lifecycle；
- Order / Transfer reference；
- session token 过期恢复；
- offline token 加密。

当前没有完整 Postgres 集成测试和浏览器 E2E。所有写库存流程仍需按 `TEST_PLAN.md` 在可回滚 SKU 上做 UAT。

---

## 15. Railway 部署与首次初始化

### Railway 资源

必须存在：

- Web service；
- PostgreSQL plugin；
- Volume 挂载 `/data`；
- GitHub main 分支自动部署；
- `/healthz` 健康检查。

### 首次安装 / scopes 更新后

1. 从 Shopify Admin 打开 App，让 session token exchange 保存 offline token；
2. 首页 → 系统状态 → 维护工具；
3. 运行“同步商品目录”；
4. 运行“重新注册实时接收”；
5. 检查核心 topic 全部成功；
6. 运行“刷新 Shopify 当前库存”；
7. 运行“同步 Shopify 最近 180 天”；
8. 等待后台回填完成；
9. 对照 Shopify 抽查商品库存和历史。

### 部署后验证

```text
GET /healthz
```

应确认：

- `ok: true`；
- webhook backlog 最终回到 0；
- errors 没有持续增长；
- last webhook received / processed 正常；
- last snapshot 存在；
- pending attribution 不持续积压。

然后在 Embedded App 检查：

- 首页无红色错误；
- 系统状态显示“Shopify 当前库存”；
- 不出现“库存有差异”；
- 最近 3 天商品会更新；
- 新 Shopify 库存操作先出现，再在最多约 5 分钟内补齐 Staff / App / Reference；
- 同一操作不重复。

---

## 16. 开发过程与重要决策

### 2026-07-21：M0 骨架

- 建立 Express / Postgres / Embedded Auth；
- 商品目录同步；
- Webhook 原始落库；
- append-only ledger；
- attribution；
- daily snapshot；
- 最小 UI。

### 2026-07-23：商品历史和 UI 主体

- ShopifyQL Inventory Adjustment history；
- 历史同步限流、分批和断点恢复；
- 商品和全店修改记录；
- 多商品事件详情；
- Brand / Collection / 排序；
- 首页最近商品；
- 商品详情前台 / 后台入口；
- Barcode-first 紧凑布局；
- 安全库存调整 Draft；
- 附件与调整数量方向。

### 2026-07-28：可追溯性和同步可靠性

- 调整编号；
- 登录账号 / 记录员工 / 经手员工；
- 全局搜索；
- Order 客户和状态；
- Transfer 准确编号和状态；
- Webhook scopes 诊断；
- 修复不支持的 Transfer topic；
- ShopifyQL 7 天批次和自适应拆分；
- 最近 2 天优先 replay；
- Railway 部署锁重试；
- provisional 与正式历史合并；
- offline token 加密存 Postgres。

### 2026-07-30：库存趋势、会话和销售历史

- 商品库存详情重新设计；
- 阶梯趋势，按事件而非每日净变化；
- current value + ledger 反向重建；
- session token 过期自动刷新；
- 销售历史；
- 区分下单、出货、待出货、取消、退货、采购入库；
- 修复已归因 provisional 无法自动合并。

### 2026-07-31：回归真实库存记录

- 确认用户只需要真实库存变化；
- 移除“库存有差异”UI；
- 归档 119 条旧内部告警；
- 快照直接刷新 Shopify 当前真值；
- 快照不再生成业务 ledger；
- 趋势排除旧 reconciliation；
- 占位清理从固定轮询改为事件触发。

### 已解决的关键事故 / 教训

1. **Webhook 注册整批失败**：不支持的 topic 导致注册中断。现在逐 topic 隔离，核心 / 扩展分级。
2. **历史同步长期 3%**：逐日查询太慢。现在最多 7 天一批、超量拆分、16 秒 pace、断点续传。
3. **信息补全长期不结束**：ShopifyQL 延迟或正式行在 cursor 之前。现在回看 2 天、部署优先 replay、事件后合并。
4. **Railway 部署后后台停摆**：offline token 只存在本地容器。现在加密保存在 Postgres。
5. **session token expired**：页面停留后 API 401。现在前端自动刷新、并发去重、有限重试。
6. **库存图表平线或误导斜线**：只看稀疏 Snapshot / 每日净变化。现在按每次真实操作画阶梯线。
7. **订单很多但销售为 0**：旧口径只统计履约。现在同时显示下单需求和真实出货，并保持补货指标只用真实出货。
8. **技术差异看起来像库存错误**：本地推算产生 119 条复核。现在彻底采用 Shopify 当前真值，不再生成用户告警。

---

## 17. 测试与验收重点

完整人工步骤见 `TEST_PLAN.md`。接手后优先做以下抽查。

### P0：只读真实性

1. 随机选择 3 个商品和相同仓位；
2. 对比 Shopify 与 App 的 5 个主库存状态；
3. 对比 3 条 Adjustment history；
4. 检查 Activity、Created by、delta、after、reference；
5. 检查负库存、多仓、Incoming 商品；
6. 确认没有“库存有差异”复核流程。

### P1：实时记录

1. 测试 SKU 在 Shopify `+1`；
2. 约 10 秒后应看到 provisional；
3. 最多等待 5 分钟补齐；
4. 不应出现重复；
5. 再 `-1` 恢复原值。

### P2：调整写入

1. 先只测试 Draft；
2. 验证编号、人员、Notes、附件；
3. 确认 Draft 不改 Shopify；
4. 在明确测试 SKU 上提交 `+1`；
5. 检查 Shopify 和 App；
6. 新建 `-1` 调整恢复；
7. 验证并发保护和安全重试。

### 销售历史

- 找一个最近已出货订单商品；
- 找一个下单但未出货商品；
- 找一个取消 / 编辑订单；
- 找一个退货；
- 找一个采购入库；
- 检查是否被正确分类；
- 检查调拨和人工调整没有进入销量。

---

## 18. 已知限制与风险

### 数据限制

- 首次 ShopifyQL 历史最多 180 天；
- 首次同步以前更旧的 Stocky 历史尚未导入；
- 60 天以前订单客户信息可能因 scope 缺失不可读；
- ShopifyQL 有分钟配额，首次回填需要较长时间；
- ShopifyQL 相比 Webhook 延迟几分钟，因此一笔修改的记录会晚几分钟出现在列表（当前库存数字不受影响，秒级实时）；界面不显示任何未补全的临时记录；
- 部分 Shopify 工作流不会返回所有库存 state，必须显示“未提供”，不能写成 0。

### 运维限制

- 进程内定时器假设单一活跃服务实例；
- PostgreSQL advisory lock 防止重任务冲突，但没有独立作业队列；
- poisoned Webhook 会每 5 秒重试，错误不会自动进入 dead-letter；
- `webhook_events` 暂无保留 / 归档策略；
- 附件备份取决于 Railway Volume；
- 没有数据库恢复演练脚本；
- 没有完整 E2E 和生产监控告警。

### 产品限制

- 完整 i18n 未做；
- 销售分类依赖 Shopify Activity / Reference / state delta 组合，新增 Shopify Activity 时需要补规则和测试；
- 补货建议目前只有基础统计，没有正式规则引擎；
- Stocky import、盘点、虚拟库存、Bundles 尚未完成。

---

## 19. 故障排查

### 页面显示 `session token expired`

正常情况下前端会自动恢复。如果仍出现：

1. 确认所有请求走 `public/session-client.js`；
2. 检查是否有新代码直接使用裸 `fetch('/api/...')`；
3. 检查 App Bridge 是否能返回 token；
4. 查看 401 response 是否带 `needsAuth: true`；
5. 运行 session-client tests。

### 实时记录没有新增

1. 看 `/healthz` 的 last webhook received；
2. 看 webhook backlog / errors；
3. 系统状态重新查询注册结果；
4. 确认 `INVENTORY_LEVELS_UPDATE` 已注册；
5. 确认 offline token 可从 Postgres 解密；
6. 检查未知 inventory item 是否需要重跑 catalog sync。

### “库存信息补全中”长期存在

1. 确认历史增量任务在运行（webhook 触发 + 5 分钟兜底）；
2. 检查 `inventory_history_sync` error；
3. 检查 `SHOPIFYQL_PACE_MS`；
4. 确认 `read_reports` scope；
5. 手动运行最近历史 sync；
6. 不要恢复固定 30 秒全表扫描；
7. 检查正式记录和 provisional 的 item、location、state、delta、时间窗是否能匹配。

### 180 天同步进度不动

1. 看 `inventory_history_backfill` 的 cursor、running、error；
2. 确认是否被 `shopify-heavy` 锁挡住；
3. Railway 新旧容器重叠时等待 15 秒重试；
4. 查看 ShopifyQL 限流；
5. 不要同时点击多次重任务按钮。

### 当前库存与 Shopify 不一致

1. 先确认同一商品、同一 variant、同一 location、同一 state；
2. 运行“刷新 Shopify 当前库存”；
3. 检查 `current_levels.updated_at`；
4. 检查 catalog 中 inventory item / location GID；
5. 不要创建 reconciliation 业务行；
6. 当前值直接以 Shopify 结果覆盖本地缓存。

### Order / Transfer 编号不准确

1. 检查 reference URI / type / ID；
2. 检查 `reference_documents.fetch_error`；
3. 检查对应 scope；
4. 清楚区分 Shopify internal ID 与 display name；
5. 客户数据缺失时确认是否超出订单访问窗口。

### 调整附件部署后丢失

1. 确认 `DATA_DIR=/data`；
2. 确认 Railway Volume 正确挂载；
3. 检查数据库元数据是否仍在；
4. 不要把附件写到容器临时文件系统。

---

## 20. 下一步开发顺序

当前 `PROGRESS.md` 约定的近期计划：

### P2.2

1. 中英文切换，默认中文；
2. 测试补货规则；
3. 逐页优化现有界面；
4. 继续验收销售历史和调整写入。

### P2.1 / P3

1. 把销售历史基础指标升级为补货建议；
2. Stocky CSV 导入；
3. 虚拟库存；
4. 轻量盘点；
5. 本地产品 / BOM。

### P4

1. Low stock；
2. Lost revenue；
3. Best sellers；
4. 数据卫生和轻量告警。

建议在新增功能前先完成当前 P0 / P1 / P2 UAT。库存系统最重要的是数据可信，不能用新功能掩盖未验收的数据口径。

---

## 21. 接手开发规则

1. 先读 `AGENTS.md`、本文档、`PROGRESS.md` 和 `TEST_PLAN.md`；
2. 运行 `git status`，保留其他 AI / 用户未提交的改动；
3. 不修改账本真实性原则；
4. 不恢复本地库存差异告警；
5. 不把 Snapshot 写成业务记录；
6. 不把下单占用算作真实出货；
7. 所有库存 mutation 必须幂等；
8. 所有写库存流程必须有 Before / Change / After 和并发校验；
9. 新 Activity / 销售分类必须补单元测试；
10. 新 API 必须使用 session token；
11. 新前端请求必须走统一 session client；
12. 新附件类型必须经过白名单和大小校验；
13. 架构变化同步更新 README / HANDOFF / DEVELOPMENT_PLAN；
14. 每段完成后更新 `PROGRESS.md`；
15. Commit 使用 Conventional Commits；
16. 测试通过后推送 `main`，并在线验证 Railway 部署。

---

## 22. 交接检查清单

接手者应确认：

- [ ] 能访问 GitHub repo；
- [ ] 能访问 Shopify Dev Dashboard；
- [ ] 能从 Shopify Admin 打开 Embedded App；
- [ ] 能访问 Railway 项目和日志；
- [ ] Railway 已连接 Postgres；
- [ ] Railway `/data` Volume 存在；
- [ ] 所需环境变量存在，但没有复制到文档或 Git；
- [ ] `/healthz` 正常；
- [ ] 核心 Webhook 已注册；
- [ ] offline token 已写入 Postgres；
- [ ] 商品目录同步完成；
- [ ] Shopify 当前库存刷新成功；
- [ ] 180 天历史回填完成或正在正常推进；
- [ ] `npm test` 全部通过；
- [ ] 当前库存与 Shopify 抽查一致；
- [ ] 新操作没有重复修改记录；
- [ ] “库存有差异”不再出现；
- [ ] Draft 不改变 Shopify；
- [ ] 测试调整可以 `+1 / -1` 完整回滚；
- [ ] 附件在重新部署后仍可访问；
- [ ] 已理解历史范围和 `read_all_orders` 限制。

---

## 23. 关联文档

- `README.md`：项目简介、部署和关键约定；
- `PROGRESS.md`：当前进度真源；
- `TEST_PLAN.md`：人工验收步骤；
- `DEVELOPMENT_PLAN.md`：原始长期规划和未来路线；
- `AGENTS.md`：开发规范和 Apps Hub 协作规则；
- `.env.example`：环境变量模板；
- `migrations/`：真实数据库演进；
- `test/`：当前自动化规则定义。

这份文档不保存任何密钥、token、数据库连接串或客户隐私数据。
