# CGP Inventory · P0/P1/P2 人工验收

本轮测试目标是确认“商品容易找到”“库存数字可信”和“修改记录可追溯”。先在测试 SKU 上操作，
每次修改后最多等待 5 分钟；测试完成后把库存改回原值。

## 1. 初始化检查

1. 从 Shopify 后台打开 **Stocky Track Dev**。
2. 在「首页」确认商品数量大于 0，并能看到「最近 3 天修改的商品」。
3. 确认最近修改商品每页最多 10 个；当总数超过 10 个时，使用「下一页」「上一页」检查翻页。
4. 点击「系统状态」或「查看详情」，确认可以进入系统状态页，并确认实时接收队列最终为 0。
5. 如果有对账提醒，打开一条商品并确认可以跳转到 Shopify；核对后点击「标记已复核」。
6. 展开「维护工具」，点击「重新注册实时接收」，确认 9 个 topic 全部成功。
7. 历史同步若显示百分比，代表仍在后台进行，不影响查看已同步的数据；等待其最终显示完成。
8. 点击「立即核对库存」。

通过标准：页面无红色错误；Webhook 待处理最终回到 0。

## 2. 商品查找与排序

1. 打开「商品」，确认默认按最近库存修改时间从新到旧排列。
2. 分别测试 Brand、Collection 下拉筛选。
3. 分别测试 Available 高到低/低到高、Brand A–Z、商品名称 A–Z。
4. 使用 Barcode 搜索一个已知商品，确认 Barcode、SKU、Brand 紧凑显示在商品标题下方，Barcode 加粗且三者不显示字段标签。
5. 对比商品列表的 Unavailable、Committed、Available、On hand、Incoming 与 Shopify 当前库存。
6. 打开商品，分别点击「查看前台商品」和「打开 Shopify 后台」。

通过标准：筛选结果正确；翻页可用；编号与五个库存状态和 Shopify 一致；两个按钮打开同一商品的正确页面。未发布商品允许显示「前台未发布」。

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

然后打开全店「修改记录」：

1. 点击任意一条记录的商品文字、商品变体数量或右侧箭头。
2. 确认详情包含操作时间、Activity、Created by、Reference，以及商品、Barcode、SKU、仓位和各库存状态变化。
3. 选择一条显示多个商品变体的 Transfer / Order 事件，确认详情列出了所有涉及商品，而不是只显示数量。

通过标准：每条事件均可打开；多商品明细完整；商品链接可进入对应商品详情。

## 5. 新事件实时测试

1. 记录测试 SKU 当前 Available 和 On hand。
2. 在 Shopify 后台对 External Warehouse 做一次 `+1` Correction，写清测试备注。
3. 等待最多 5 分钟并刷新 CGP Inventory 商品详情。
4. 确认新记录出现，Created by 是实际员工，Available / On hand 都增加 1。
5. 再做一次 `-1` Correction 恢复原库存，并确认第二条记录出现。
6. 回到首页，确认测试商品出现在「最近 3 天修改的商品」。

通过标准：两次操作各出现一次、没有重复，最终库存恢复原值，首页能看到最新商品。

## 6. P2 库存调整（先 Draft，后受控写入）

### 6.1 不改库存的安全检查

1. 打开「库存调整」，确认可以按状态、Adjustment reason、员工筛选，并可导出 CSV。
2. 展开「Adjustment reasons 与员工名称」，确认预置原因存在；把当前测试账号的 user ID 改为真实姓名并保存。
3. 点击「新建调整」，选择仓位和 `Manual adjustment`。
4. 扫描或输入测试商品 Barcode，确认结果同时显示商品、Barcode、SKU、Brand 和当前 Available。
5. 添加两个商品，分别输入 `+1`、`-1`，确认 After 计算正确。
6. 保存 Draft，打开详情后再进入编辑，确认内容完整；此阶段 Shopify 库存必须完全不变。
7. 归档这张测试 Draft。

通过标准：Draft 可创建、编辑、查看、归档；Barcode 查找准确；保存 Draft 不改变 Shopify。

### 6.2 真实写入（仅使用可回滚的测试 SKU）

1. 选择一个明确允许测试、当前没有订单或其他 App 同步的 SKU，记录仓位和 Available 原值。
2. 新建单商品 Draft，Reason 选 `Manual adjustment`，Notes 写 `CGP Inventory UAT +1`，Change 填 `+1`。
3. 详情页核对 Before / Change / After 后点击「提交到 Shopify」，在二次确认中再次核对。
4. 打开 Shopify 商品库存和 Adjustment history，确认 Available 增加 1，来源、原因和引用可追溯。
5. 在本应用「修改记录」和商品详情确认对应事件只出现一次。
6. 新建第二张调整把同一 SKU `-1` 恢复，Notes 写 `CGP Inventory UAT rollback`。
7. 再次核对 Shopify 和本应用，确认最终 Available 回到原值，首页最近修改商品出现该 SKU。

通过标准：两张调整都只应用一次，Created by / 原因 / 引用正确，最终库存恢复原值。

### 6.3 并发保护

1. 建立一张 `+1` Draft，但不要提交。
2. 先在 Shopify 后台手动改变同一 SKU 的 Available。
3. 回到旧 Draft 点击提交。

通过标准：应用提交前会读取最新库存并更新本次 Before / After；若 Shopify 在最后校验时又被并发修改，
mutation 必须停止而不能覆盖他人的新数量。网络状态未知时页面显示“安全重试”，重试不得重复调整。

## 7. 结果反馈

若发现差异，请截图 Shopify 与 CGP Inventory 的同一条记录，并提供：

- SKU
- Barcode
- 仓位
- 操作时间
- 哪一列不一致
