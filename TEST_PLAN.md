# CGP Inventory · P0/P1 人工验收

本轮测试目标是确认“商品容易找到”“库存数字可信”和“修改记录可追溯”。先在测试 SKU 上操作，
每次修改后最多等待 5 分钟；测试完成后把库存改回原值。

## 1. 初始化检查

1. 从 Shopify 后台打开 **Stocky Track Dev**。
2. 在「首页」确认商品数量大于 0，并能看到「最近 3 天修改的商品」。
3. 点击「系统状态」或「查看详情」，确认可以进入系统状态页，并确认实时接收队列最终为 0。
4. 如果有对账提醒，打开一条商品并确认可以跳转到 Shopify；核对后点击「标记已复核」。
5. 展开「维护工具」，点击「重新注册实时接收」，确认 9 个 topic 全部成功。
6. 历史同步若显示百分比，代表仍在后台进行，不影响查看已同步的数据；等待其最终显示完成。
7. 点击「立即核对库存」。

通过标准：页面无红色错误；Webhook 待处理最终回到 0。

## 2. 商品查找与排序

1. 打开「商品」，确认默认按最近库存修改时间从新到旧排列。
2. 分别测试 Brand、Collection 下拉筛选。
3. 分别测试 Available 高到低/低到高、Brand A–Z、商品名称 A–Z。
4. 搜索 `PK3112`，确认列表显示 Available、最近库存修改和最近修改时间。
5. 打开商品，分别点击「查看前台商品」和「打开 Shopify 后台」。

通过标准：筛选结果正确；翻页可用；两个按钮打开同一商品的正确页面。未发布商品允许显示「前台未发布」。

## 3. 当前库存状态对比

1. 在「商品」页搜索 `PK3112`。
2. 打开商品详情，同时在 Shopify 商品页打开同一 SKU 的 Adjustment history。
3. 选择相同仓位（External Warehouse）。
4. 对比 Unavailable、Committed、Available、On hand、Incoming。

通过标准：CGP Inventory 与 Shopify 的当前数量完全一致，特别是 On hand 不再显示旧值。

## 4. 历史记录对比

商品详情应只有一套「历史修改记录」。在 Shopify Adjustment history 中任选 3 条记录逐项比较：

- 日期
- Activity / 原因
- Created by（员工或 App）
- Unavailable / Committed / Available / On hand / Incoming
- 仓位和引用单据

通过标准：3 条记录的操作者、原因和变动量一致。

## 5. 新事件实时测试

1. 记录测试 SKU 当前 Available 和 On hand。
2. 在 Shopify 后台对 External Warehouse 做一次 `+1` Correction，写清测试备注。
3. 等待最多 5 分钟并刷新 CGP Inventory 商品详情。
4. 确认新记录出现，Created by 是实际员工，Available / On hand 都增加 1。
5. 再做一次 `-1` Correction 恢复原库存，并确认第二条记录出现。
6. 回到首页，确认测试商品出现在「最近 3 天修改的商品」。

通过标准：两次操作各出现一次、没有重复，最终库存恢复原值，首页能看到最新商品。

## 6. 结果反馈

若发现差异，请截图 Shopify 与 CGP Inventory 的同一条记录，并提供：

- SKU
- 仓位
- 操作时间
- 哪一列不一致
