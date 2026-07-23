# CineGearPro Inventory App — 完整开发计划

> 自研库存管理 app，替代 Stocky（2026-08-31 关停），核心壁垒是**全生命周期库存账本**。
> 制定日期：2026-07-10（距 Stocky 关停 53 天）
> 基于 2026-07-10 对 Stocky 的逐页实地盘点（见 memory: project_inventory_app）。

---

## 1. 项目目标

1. **8月31日前**无缝承接团队的日常库存操作（调整审计为主），Stocky 关停当天零中断切换。
2. 建立 Shopify API 提供不了的**全生命周期库存账本**：每个 SKU 从上架至今的每一次变动（谁、何时、为何、变了多少、变成多少），永久保存、任意区间可查——对比 Stocky 只有 90 天曲线、Shopify admin 只留 180 天调整历史。
3. 在此之上做增量价值：虚拟库存管理、缺货损失分析、库存估值、Lark 推送、与 back-in-stock 需求信号联动。

**非目标**（明确不做）：完整 PO 采购系统（4年只开过1张测试单，真需要时用 Shopify 原生 PO）、供应商档案（Stocky 里是空的）、Transfers（原生已覆盖）、Email templates / Tax rates / Dymo 标签打印、复杂预测参数体系。

---

## 2. 功能清单

### P1 核心（必须在 8/31 前上线）

| # | 功能 | 说明 |
|---|------|------|
| F1 | **全周期账本** | append-only 流水表：every 变动一行（delta、变动后数量、来源、原因、员工、备注、时间）。三层采集：webhook 实时层 → 归因层 → 日快照层（详见 §4） |
| F2 | **调整模块** | 照搬 Stocky 工作流：建调整单（多行 SKU，扫码/搜索添加）→ 每行旧量/明确的 ± 方向与变化量/新量 → 原因（下拉）+ 员工 + 详细备注 + 图片/视频/文件证据 → 提交写 Shopify → 行级审计记录。列表页可按原因/员工/日期/SKU 筛选，CSV 导出 |
| F3 | **原因代码管理** | 预置现有 11 种（Manual adjustment / -Manual invoice / Manual Stock count / Virtual stock adjustment / -Demo Stock / Demo / +Return restock / -Staff purchase / -Damaged / -Resend order / Stocktake），可增删、统计使用量 |
| F4 | **虚拟库存（一等公民）** | 独立实体而非纯备注：给变体设虚拟库存数（关联到 bundle 产品和原因），全局清单页可见当前所有"虚拟库存在外"的 SKU，一键撤销（生成反向调整）。解决现在靠中文备注人肉追踪的痛点 |
| F5 | **变体详情页** | 全周期库存+销量双曲线（任意日期区间缩放）、SKU/条码/价格/成本/各仓可用量/虚拟库存标记、该变体的完整账本流水 |
| F6 | **历史导入** | Stocky Adjustments CSV（2022-06 至今 ~2200 单）+ Stock on hand History CSV 导入账本，新 app 上线即自带 4 年历史 |
| F7 | **员工身份** | 从 App Bridge session token 取 Shopify admin 用户身份自动记录操作人；映射表（kay/Ling/yan/Emily…） |

### P2 重要（8/31 前尽量，9月初完成也可接受）

| # | 功能 | 说明 |
|---|------|------|
| F8 | **盘点（轻量版）** | 建盘点单（按仓/按 vendor 圈范围）→ 手机浏览器扫码计数（BarcodeDetector API，fallback 手输条码）→ Scan/Search/Missed 三视图 → 差异表 → 一键生成调整单 → 完成后锁定 + CSV。支持多人同时扫（按行 upsert） |
| F9 | **本地产品 + Bundles** | 承接 Stocky 的 `#` 前缀内部产品（约30+个不在 Shopify 的散件/组件，有真实库存）；bundle↔组件 BOM 关系表，bundle 可组装/拆散（生成成对调整） |
| F10 | **Low stock 仪表盘** | 按销速估算耗尽天数，低库存清单 |
| F11 | **Lost revenue 仪表盘** | 按 vendor：缺货 SKU 数、估算损失（缺货天数×销速×单价）、潜在收入——采购决策依据，原生 Shopify 没有 |

### P3 增值（9月起从容做）

| # | 功能 | 说明 |
|---|------|------|
| F12 | 库存估值报表 | Stock on hand Current/History、按当前/平均成本、总货值曲线 |
| F13 | ABC 分级 + Best sellers | |
| F14 | Lark 推送 | 低库存日报、缺货损失周报、异常变动告警（如单日大额负调整） |
| F15 | 订货提示（简版） | 销速 × 交期 → 建议补货量清单（不做完整预测参数体系） |
| F16 | BIS 联动 | back-in-stock 登记量作为缺货需求信号并入 F11/F15 |
| F17 | 数据卫生工具 | vendor 大小写重复检测、负库存清单 |

---

## 3. 技术栈

完全照搬 search-panel / promo-manager 的成熟骨架，团队（Claude）已验证过的模式：

| 层 | 选型 | 理由 |
|---|------|------|
| 后端 | **Node 18+ / Express**，`type: module`，零框架 | 与 search-panel 一致，无构建步骤 |
| 数据库 | **PostgreSQL**（Railway 托管） | 账本是核心资产，必须是真数据库；pg 直连不用 ORM |
| 前端 | **原生 JS SPA**（public/index.html + app.js + style.css），Shopify **App Bridge v4**（CDN script）+ Polaris 风格 CSS（手写，不引 React） | 与现有 app 一致；盘点页做移动优先响应式 |
| 认证 | App Bridge **session token → OAuth token exchange**（managed install，无 redirect 流程），离线 token 存库供 webhook/cron 使用 | search-panel 的 auth-embedded.js 直接复用 |
| Shopify API | **GraphQL Admin API 2026-04**（注意 2026-04 起 inventoryAdjustQuantities 等 mutation 强制幂等 key） | |
| 托管 | **Railway**：web 服务 + Postgres 插件 + Volume（/data，token 持久化） | 同 search-panel |
| 定时任务 | 进程内 setInterval + 数据库锁（单实例够用）；快照/对账每日跑 | 不引额外队列，webhook 处理用"先写库、后台归因"模式（appproxy 备忘录的教训：外部调用放后台） |
| 条码扫描 | 浏览器 BarcodeDetector API（Chrome/安卓支持好），fallback：USB 扫码枪当键盘输入 | 复用 BIS 的条码经验 |

**Shopify app 配置**（Dev Dashboard 新建，参考 legacy custom app 停用备忘）：
- embedded: true，managed install，Custom distribution → cinegearpro.myshopify.com
- Scopes：`read_products, read_locations, write_inventory, read_orders, read_reports`
  （write_inventory 隐含 read；read_orders 用于归因销售/退款；read_reports 用于 ShopifyQL 对账）
- Webhooks（GraphQL Admin API 订阅，HMAC 验证）：
  `inventory_levels/update`、`inventory_items/update`、`products/update`、`products/delete`、`locations/create|update`、`orders/create`、`refunds/create`

---

## 4. 系统架构：三层账本

```
                       ┌──────────────────────────────────────────────┐
 Shopify ──webhook──▶  │ ① 实时层  ingest.js                          │
 (inventory_levels/    │  收到即写 webhook_events(原始payload,去重)   │
  update, orders,      │  delta = 新available − ledger最后已知值       │
  refunds, products)   │  写 inventory_ledger(source=unknown)          │
                       └──────────────┬───────────────────────────────┘
                                      ▼
                       ┌──────────────────────────────────────────────┐
                       │ ② 归因层  attribution.js (后台任务,每2分钟)  │
                       │  unknown 条目 ↔ 同时间窗事件关联:             │
                       │   ·本app调整/盘点(referenceDocumentUri精确匹配)│
                       │   ·orders/create → sale  ·refunds → return    │
                       │  每晚 ShopifyQL inventory_adjustment_history  │
                       │  对账,补齐外部app/admin手动操作的 staff/reason │
                       └──────────────┬───────────────────────────────┘
                                      ▼
                       ┌──────────────────────────────────────────────┐
                       │ ③ 快照层  snapshot.js (每日 03:00 UTC)        │
                       │  全量 variant×location 的 available/on_hand/  │
                       │  cost 写 daily_snapshots(增量式:只存有变化行, │
                       │  每月1日存全量基线) + 与账本推算值对账,        │
                       │  漂移>0 记 reconcile_alerts                   │
                       └──────────────────────────────────────────────┘
```

关键设计决策：
- **webhook 只给新值不给 delta**（无 reason/操作人），所以 delta 自算 + 归因后补——这是整个系统最核心的机制。
- **本 app 发起的写操作**（调整/盘点/虚拟库存）走 `inventoryAdjustQuantities`，带 `reason` + `referenceDocumentUri`（指向我们的调整单 URL），Shopify 侧和账本双边都有完整审计；webhook 回流时靠 referenceDocumentUri 识别为自己，不重复记账。
- **幂等**：webhook 按 `X-Shopify-Webhook-Id` 去重；mutation 用 2026-04 的幂等 key；导入按 (来源,单号,行号) 唯一约束。
- **快照是自愈机制**：webhook 万一漏（服务重启/Shopify 重试耗尽），日快照对账会发现账本推算值 ≠ 实际值，插入一条 `reconciliation` 修正行并告警，账本永远收敛到真实。

---

## 5. 数据库 Schema（核心表）

```sql
-- 身份与基础
shops(id, shop_domain, offline_token_enc, installed_at)
staff(id, shopify_user_id, display_name, role)        -- kay/Ling/yan… role: admin|member
locations(id, shopify_gid, name, active)
items(id, source, shopify_variant_gid, shopify_inventory_item_gid,
      product_title, variant_title, sku, barcode, vendor, price, unit_cost,
      tracked, status, created_at)                     -- source: shopify|local(# 内部产品)

-- ① 账本（核心资产，append-only，绝不 UPDATE 业务字段）
inventory_ledger(id, item_id, location_id, state,      -- state: available|on_hand
      delta, qty_after, occurred_at, recorded_at,
      source_type,                                     -- sale|refund|adjustment|stocktake|bundle_op|
                                                       -- transfer|external_app|admin_manual|import|
                                                       -- reconciliation|unknown
      source_ref,                                      -- 订单号/调整单id/webhook id…
      reason_code, staff_id, notes,
      attribution, attributed_at)                      -- pending|matched|shopifyql|manual
  -- 索引: (item_id, location_id, occurred_at); 按月分区
webhook_events(id, webhook_id UNIQUE, topic, payload jsonb, received_at, processed_at)

-- ③ 快照
daily_snapshots(snap_date, item_id, location_id, available, on_hand, incoming,
      unit_cost, PRIMARY KEY(snap_date,item_id,location_id))  -- 增量存储+月度全量基线
reconcile_alerts(id, snap_date, item_id, location_id, expected, actual, resolved)

-- 调整
adjustment_reasons(id, name, direction, active, position)
adjustments(id, number, reason_id, staff_id, notes, status,   -- draft|applied|archived
      applied_at, created_at)
adjustment_lines(adjustment_id, item_id, location_id, qty_before, delta, qty_after, unit_cost)

-- 虚拟库存
virtual_stock(id, item_id, location_id, qty, bundle_item_id, reason, notes,
      status,                                          -- active|reverted
      created_by, created_at, apply_adjustment_id, revert_adjustment_id)

-- 盘点
stocktakes(id, number, name, location_id, scope_filter, status,  -- open|counting|completed
      created_by, created_at, completed_at, adjustment_id)
stocktake_lines(stocktake_id, item_id, expected_qty, counted_qty,
      counted_by, counted_at, UNIQUE(stocktake_id,item_id))     -- upsert 支持多人同扫

-- Bundles / 本地产品
bundle_components(bundle_item_id, component_item_id, qty)

-- 运维
sync_state(key, value jsonb)                           -- cursor、上次对账时间等
```

数据量评估：~8000 SKU × 3 仓。日快照增量存储（只存变化行，日常约几百行/天，月初全量 2.4 万行），账本每天几十~几百行。Postgres 毫无压力，按月分区留好十年余量。

---

## 6. 后端模块划分（src/）

```
server.js            Express 入口、静态资源、路由挂载
auth-embedded.js     ← search-panel 复用：session token 验证 + token exchange
shopify.js           GraphQL client（限流重试、幂等key、成本追踪）
db.js                pg 连接池 + migrate（启动时跑 migrations/*.sql）
webhooks.js          HMAC 验证 → webhook_events 落库（同步返回200，处理全在后台）
ledger.js            账本写入（delta 计算、幂等、对账修正行）
attribution.js       归因任务（订单/退款/自家单据匹配 + 每晚 ShopifyQL 对账）
snapshot.js          日快照 + 漂移检测
catalog.js           products/variants/locations 同步（全量初始化 + webhook 增量）
adjustments.js       调整单 CRUD + 应用（inventoryAdjustQuantities）
virtualstock.js      虚拟库存 设置/撤销
stocktakes.js        盘点单 + 扫码计数 API
bundles.js           BOM + 组装/拆散
reports.js           曲线数据、low stock、lost revenue、估值、CSV 导出
import-stocky.js     Stocky CSV 导入（调整历史/库存快照/# 产品）
lark.js              (P3) 飞书推送
```

前端页面（public/，hash 路由单页）：
`#/dashboard`（low stock / lost revenue / 最近调整）、`#/items`+`#/items/:id`（变体详情+全周期曲线，Chart.js 或手写 SVG）、`#/adjustments`+新建/详情、`#/virtual-stock`、`#/stocktakes`+扫码页（移动优先）、`#/reports/*`、`#/settings`（原因管理/员工映射/导入）。

---

## 7. 开发步骤与时间线（倒排 8/31）

### M0 · 骨架 + 数据开录（7/10 – 7/16）★ 最高优先级
> 目标：**账本先跑起来**。每晚一天，历史就少一天。

1. 老板管理员账号导出 Stocky 数据：Adjustments report CSV（全量）、Stock on hand Current+History CSV、Products/# 产品清单、Preferences 截图存档；尝试取 Stocky API key 做补充备份
2. Dev Dashboard 建 app（embedded、managed install、custom distribution、上述 scopes）
3. 仓库初始化：复制 search-panel 骨架 → auth、db、migrations
4. Railway：web + Postgres + Volume，环境变量
5. catalog 全量同步（products/variants/locations → items 表）
6. webhooks.js + ledger.js：inventory_levels/update 开始进账本（此时全部 unknown 也没关系）
7. snapshot.js 日快照上线
8. **验收：连续 3 天，快照对账零漂移或漂移可解释；账本记录到真实变动（团队在 Stocky 里的日常调整会以 external_app 形式进账本）**

### M1 · 归因 + 只读 UI（7/17 – 7/27）
1. attribution.js：orders/refunds webhook 关联销售/退货；ShopifyQL 每晚对账补 reason/staff（验证 read_reports + shopifyqlQuery 在本店可用性——**M1 第一天就验**，不可用则降级为"订单归因+其余标 external"）
2. import-stocky.js：4 年调整历史 + 快照历史入库（source_type=import）
3. UI：dashboard 骨架、items 列表/详情、全周期曲线（导入的历史+新账本拼接）、账本流水页
4. 验收：变体详情页能看到 2022 至今的完整曲线；随机抽 20 条 Stocky 调整记录与账本核对一致

### M2 · 调整模块（7/28 – 8/12）★ 团队切换的关键
1. 原因管理（预置 11 种）+ 员工映射
2. 调整单：建单（扫码/搜索加行、明确 ± 方向、实时显示当前量和新量、备注与证据附件）→ 应用（写 Shopify，幂等，失败重试/部分失败处理）→ 锁定 → 列表/筛选/CSV
3. 虚拟库存页：设置/清单/一键撤销
4. **8/11 起团队试用**：新调整在新 app 做，Stocky 只读对照；收集 kay/Ling 反馈迭代
5. 验收：kay 用新 app 完成一整天的真实调整无卡点；Shopify 侧 adjustment history 显示的 reason/来源正确

### M3 · 盘点 + Bundles + 仪表盘（8/13 – 8/24）
1. 盘点：建单→手机扫码（BarcodeDetector + 扫码枪 fallback）→Missed→差异→生成调整
2. 本地产品导入 + bundle BOM + 组装/拆散操作
3. low stock / lost revenue 仪表盘
4. 验收：在店里用手机对一个货架做真实小盘点走通全流程

### M4 · 平行验证 + 切换（8/25 – 8/31）
1. 双系统对照一周：新 app 账本 vs Stocky 调整记录逐日核对
2. Stocky 最终全量导出（所有 CSV 再导一遍存档到 Railway volume + 本地）
3. 8/31 前：团队全员切换，Stocky 留只读
4. 上线值守：对账告警接 Lark（提前把 F14 的告警部分做了）

### P3 · 9 月起
估值报表 → ABC → Lark 日报 → 订货提示 → BIS 联动 → 数据卫生工具

---

## 8. 测试策略

| 层 | 内容 | 方式 |
|---|------|------|
| 单元 | delta 计算、归因匹配规则、bundle 可组装数、盘点差异生成、CSV 解析 | node:test（零依赖），核心逻辑函数纯化便于测试 |
| Webhook | HMAC 验签、重复投递幂等（同 webhook_id 重放）、乱序到达（旧值后到不得回滚账本）、payload fixture 回放 | 保存真实 payload 做 fixtures，`node --test` 回放 |
| 集成 | GraphQL mutation 幂等 key、限流(429)重试、token 过期刷新 | 对 dev store 跑；shopify.js 做可注入 mock |
| **对账（最重要）** | 账本推算值 vs Shopify 实际值每日自动对账，这本身就是常驻测试；漂移即告警 | snapshot.js 内建，M0 起生效 |
| 导入 | Stocky CSV 全量导入后行数/汇总核对（如 Manual adjustment 应为 1173 条）、重复导入幂等 | 导入脚本自带校验报告 |
| UAT | kay/Ling 真实业务试用（M2 的 8/11-8/24 平行期即 UAT）；手机盘点在店内实测 | 反馈直接迭代 |
| 环境 | 先装 Partner dev store 走通增删改；prod 店 M0 起只读采集（无写风险），写操作（M2）先在 dev store 全量验证后才对 prod 放开 | |

不追求覆盖率数字，追求三条硬保证：**账本不丢（对账自愈）、不重（幂等）、调整写入不出错（dev store 先验 + 平行期人工核对）**。

---

## 9. 部署与运维

- Railway：web（Node）+ Postgres 插件 + Volume /data；`SHOPIFY_API_KEY/SECRET/API_VERSION=2026-04/DATABASE_URL/DATA_DIR`
- 迁移：启动时自动跑 migrations/（与 promo-manager 同模式）
- 备份：Railway PG 自动备份 + 每周 pg_dump 到 Volume + 每月手动下载本地（账本是核心资产）
- 监控：/healthz（webhook 积压量、上次快照时间、未归因条数）；对账告警 → Lark webhook
- 安全：offline token 加密存储；员工操作全部记账；调整应用需确认弹窗；无对外公开端点（App Proxy 不需要）

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|------|------|
| ShopifyQL `inventory_adjustment_history` 在本店计划不可用 | 外部操作归因缺 staff/reason | M1 第一天验证；降级方案：订单/退款/自家操作已覆盖绝大多数，其余标 external_app（Stocky 期间的操作本来就能从导出 CSV 补） |
| 8/31 前开发延期 | 团队没工具用 | 功能砍法已预留：F8 盘点、F9 bundles 可 9 月补（团队 4 年没盘点）；**唯一不可延期的是 F1+F2（账本+调整）** |
| webhook 漏收 | 账本缺行 | 日快照对账自愈 + reconciliation 修正行 + 告警 |
| 写库存出 bug（多扣/少扣） | 真实库存错乱 | 写操作只走一个函数出口；dev store 全量验证；平行期人工核对；每笔有 referenceDocumentUri 可追溯可反向 |
| 2026-04 API 幂等 key 强制、行为差异 | mutation 失败 | shopify.js 统一生成 UUID 幂等 key，pin 2026-04 版本，升级前读 changelog |
| Stocky 提前限制导出 | 历史丢失 | **本周就导**（M0 第 1 项），不等开发 |

---

## 11. 本周立即行动（2026-07-10 ~ 07-13）

1. ☐ 老板账号导出 Stocky 全部 CSV（§7 M0-1 清单）→ 存本地 + 云端两份
2. ☐ Dev Dashboard 建 app、拿 Client ID/Secret
3. ☐ Railway 开项目（web + Postgres + Volume）
4. ☐ 复制 search-panel 骨架，跑通嵌入式认证
5. ☐ catalog 同步 + webhook 落账本 + 日快照上线 → **数据开录**
