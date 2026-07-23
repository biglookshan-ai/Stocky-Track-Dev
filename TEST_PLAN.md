# CGP Inventory · P0/P1 人工验收

本轮测试目标是确认“库存数字可信”和“修改记录可追溯”。先在测试 SKU 上操作，
每次修改后最多等待 5 分钟；测试完成后把库存改回原值。

## 1. 初始化检查

1. 从 Shopify 后台打开 **Stocky Track Dev**。
2. 在「状态」页确认商品变体数量大于 0、Webhook 待处理为 0。
3. 点击「注册 Webhooks」，确认 9 个 topic 全部成功。
4. 点击「同步最近 180 天调整历史」，等待状态显示完成。
5. 点击「立即跑一次快照/对账」。

通过标准：页面无红色错误；Webhook 待处理最终回到 0。

## 2. 当前库存状态对比

1. 在「商品」页搜索 `PK3112`。
2. 打开商品详情，同时在 Shopify 商品页打开同一 SKU 的 Adjustment history。
3. 选择相同仓位（External Warehouse）。
4. 对比不可用、已承诺、可用、在手、在途。

通过标准：CGP Inventory 与 Shopify 的当前数量完全一致，特别是 On hand 不再显示旧值。

## 3. 历史记录对比

在 Shopify Adjustment history 中任选 3 条记录，与 CGP Inventory 的「库存修改记录」逐项比较：

- 日期
- Activity / 原因
- Created by（员工或 App）
- Unavailable / Committed / Available / On hand / Incoming
- 仓位和引用单据

通过标准：3 条记录的操作者、原因和变动量一致。

## 4. 新事件实时测试

1. 记录测试 SKU 当前 Available 和 On hand。
2. 在 Shopify 后台对 External Warehouse 做一次 `+1` Correction，写清测试备注。
3. 等待最多 5 分钟并刷新 CGP Inventory 商品详情。
4. 确认新记录出现，Created by 是实际员工，Available / On hand 都增加 1。
5. 再做一次 `-1` Correction 恢复原库存，并确认第二条记录出现。

通过标准：两次操作各出现一次、没有重复，最终库存恢复原值。

## 5. 结果反馈

若发现差异，请截图 Shopify 与 CGP Inventory 的同一条记录，并提供：

- SKU
- 仓位
- 操作时间
- 哪一列不一致

