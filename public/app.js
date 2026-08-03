// Embedded SPA: business-facing inventory audit with technical health tucked
// behind an explicit system-status section.
// App Bridge (CDN) provides window.shopify.idToken() for session tokens.

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

// Navigation generation: every route change bumps it so async work started by a
// previous view can bail out instead of writing into a DOM that no longer
// exists. $w() is the write-safe selector — when the target is gone (the user
// navigated away mid-request) it returns a detached node, so the stale write is
// harmless instead of throwing "Cannot set properties of null", which used to
// surface as an error page and made clicks feel unresponsive.
let navGeneration = 0;
const currentNav = () => navGeneration;
const isCurrent = (gen) => gen === navGeneration;
const $w = (sel) => $(sel) || document.createElement('div');

const sessionClient = window.InventorySessionClient.create({
  getToken: async () => {
    try { return await window.shopify.idToken(); }
    catch { throw new Error('请从 Shopify 后台打开本应用（App Bridge 未初始化）'); }
  },
  fetchImpl: window.fetch.bind(window),
});
const authenticatedFetch = sessionClient.fetch;

async function api(path, opts = {}) {
  const res = await authenticatedFetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Shopify 登录会话暂时无法自动恢复，请稍后再试。');
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  return j;
}

async function apiDownload(path, filename) {
  const res = await authenticatedFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(res.status === 401 ? 'Shopify 登录会话暂时无法自动恢复，请稍后再试。' : body.error || `HTTP ${res.status}`);
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function apiBlob(path) {
  const res = await authenticatedFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(res.status === 401 ? 'Shopify 登录会话暂时无法自动恢复，请稍后再试。' : body.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

async function apiUploadAttachment(adjustmentId, file) {
  const res = await authenticatedFetch(`/adjustments/${adjustmentId}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Shopify 登录会话暂时无法自动恢复，请稍后再试。' : body.error || `HTTP ${res.status}`);
  }
  return body.attachment;
}

const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};
let mediaObjectUrls = [];
const clearMediaObjectUrls = () => {
  mediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaObjectUrls = [];
};
const attachmentListHtml = (attachments = [], editable = false) => attachments.length
  ? `<div class="attachment-list">${attachments.map((attachment) => {
    const media = attachment.content_type.startsWith('image/');
    return `<div class="attachment-item">
      ${media ? `<div class="attachment-preview" data-attachment-preview="${attachment.id}"></div>` : '<span class="attachment-file-icon">📎</span>'}
      <div class="attachment-meta">
        <button class="attachment-open" data-attachment-open="${attachment.id}" data-filename="${esc(attachment.original_name)}" data-content-type="${esc(attachment.content_type)}">${esc(attachment.original_name)}</button>
        <span>${esc(formatBytes(attachment.size_bytes))}${attachment.uploaded_by_name ? ` · ${esc(attachment.uploaded_by_name)}` : ''}</span>
      </div>
      ${editable ? `<button class="secondary small-button attachment-delete" data-attachment-delete="${attachment.id}">移除</button>` : ''}
    </div>`;
  }).join('')}</div>`
  : '<p class="muted compact">暂无附件。</p>';

async function wireAttachmentActions(adjustmentId, attachments = []) {
  document.querySelectorAll('[data-attachment-open]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const blob = await apiBlob(`/adjustments/${adjustmentId}/attachments/${button.dataset.attachmentOpen}`);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        if (/^(image|video)\//.test(button.dataset.contentType) || button.dataset.contentType === 'application/pdf') {
          window.open(link.href, '_blank', 'noopener');
          setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
        } else {
          link.download = button.dataset.filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }
      } catch (error) { alert(`下载失败：${error.message}`); }
      finally { button.disabled = false; }
    };
  });
  await Promise.all(attachments.filter((attachment) => attachment.content_type.startsWith('image/')).map(async (attachment) => {
    const host = document.querySelector(`[data-attachment-preview="${attachment.id}"]`);
    if (!host) return;
    try {
      const blob = await apiBlob(`/adjustments/${adjustmentId}/attachments/${attachment.id}`);
      const url = URL.createObjectURL(blob);
      mediaObjectUrls.push(url);
      host.innerHTML = `<img src="${url}" alt="${esc(attachment.original_name)}">`;
    } catch { host.innerHTML = '<span class="muted small">预览不可用</span>'; }
  }));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '—';
// Compact list format: date on the first line, time small underneath, so the
// column never wraps mid-number.
const fmtDateCompact = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  const date = `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
  const time = t.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return `${date}<div class="muted xsmall">${time}</div>`;
};
const STATUS_HELP = {
  completion: '修改记录只显示 Shopify 官方流水中的正式记录（含操作人/App/原因/单据）。这里是数量已变动、但官方流水还没回传的笔数——通常几分钟内回传并自动入账，期间不会显示任何不完整的记录。',
  currentInventory: '库存数字是实时的（变动信号一到就更新）。这里显示的是每天凌晨把全店所有商品与 Shopify 逐一核对的完成时间，是二次保险，不代表数字停留在该时刻。',
  history: '历史同步先补最近记录，再按每批最多 7 天向前读取；数据超过 Shopify 单次上限时会自动拆分。进度会按批次跳动，并非逐行增加。',
};
const infoTip = (text) => `<span class="info-tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tooltip="${esc(text)}">?</span>`;

const SOURCE_LABEL = {
  sale: 'Sale', refund: 'Return', adjustment: 'Adjustment', stocktake: 'Stocktake',
  import: 'Historical import', reconciliation: 'Reconciliation', external_app: 'App',
  admin_manual: 'Staff', order: 'Order', transfer: 'Transfer',
  unknown: '等待官方流水', bundle_op: 'Bundle',
};
const srcBadge = (s) => `<span class="badge ${esc(s)}">${SOURCE_LABEL[s] || esc(s)}</span>`;
const ACTIVITY_LABEL = {
  manual_adjustment: 'Manually adjusted',
  manually_adjusted: 'Manually adjusted',
  order_fulfilled: 'Order fulfilled',
  purchase: 'Purchased',
  purchase_order_received: 'Purchase order received',
  correction: 'Inventory correction',
  inventory_correction: 'Inventory correction',
  count: 'Inventory manually counted',
  inventory_count: 'Inventory manually counted',
  inventory_updated: 'Inventory updated',
  received: 'Inventory received',
  return_restock: 'Items restocked',
  damaged: 'Damaged',
  theft_or_loss: 'Theft or loss',
  promotion_or_donation: 'Promotion or donation',
  data_correction: 'Data correction',
  transfer_created: 'Transfer created',
  removed_from_location: 'Removed from location',
  reservation_created: 'Reservation created',
  reservation_updated: 'Reservation updated',
  reservation_deleted: 'Reservation deleted',
  other: 'Other',
};
const activityLabel = (value) => {
  const key = String(value || 'other').trim().toLowerCase();
  return ACTIVITY_LABEL[key]
    || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
};
const signed = (n) => `${Number(n) > 0 ? '+' : ''}${Number(n)}`;
const historyCell = (change) => {
  if (!change || change.qty_after === null) return '<td class="num muted">—</td>';
  const delta = Number(change.delta || 0);
  return `<td class="num"><span class="${delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'muted'}">(${signed(delta)})</span> ${change.qty_after}</td>`;
};
const actorCell = (row) => {
  const name = row.created_by || row.staff_name || row.app_name || 'Shopify';
  const kind = row.staff_name ? 'Staff' : row.app_name ? 'App' : 'System';
  return `${esc(name)}<div class="muted small">${kind}</div>`;
};
const gidParts = (uri) => {
  const match = String(uri || '').match(/^gid:\/\/shopify\/([^/]+)\/(.+)$/i);
  return match ? { type: match[1], id: match[2] } : null;
};
const referenceCell = (row, shopHandle) => {
  // A manual adjustment (imported or app-created) links to its detail page,
  // labelled with the SAME number the list/detail pages show (display_number).
  if (row.adjustment_id) {
    return `<a href="#/adjustments/${row.adjustment_id}">调整单 ${adjustmentNumber(row.adjustment_number, row.adjustment_display_number)}</a>`;
  }
  const ref = gidParts(row.reference_document_uri);
  const type = row.reference_document_type || ref?.type;
  const id = row.reference_document_id || ref?.id;
  if (!type && !id) return '<span class="muted">—</span>';
  const labels = {
    Order: 'Order', PurchaseOrder: 'Purchase order',
    Transfer: 'Transfer', InventoryTransfer: 'Transfer', Adjustment: 'Adjustment',
  };
  const label = labels[type] || String(type || 'Reference').replace(/([a-z])([A-Z])/g, '$1 $2');
  const fallbackUrl = type === 'Order' && id && shopHandle
    ? `https://admin.shopify.com/store/${encodeURIComponent(shopHandle)}/orders/${encodeURIComponent(id)}`
    : null;
  const url = row.reference_admin_url || fallbackUrl;
  const title = row.reference_name || `${label}${id ? ` #${id}` : ''}`;
  const details = [
    row.reference_customer_name,
    row.reference_status,
  ].filter(Boolean).map((value) => esc(value)).join(' · ');
  return `${url
    ? `<a class="reference-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(title)} ↗</a>`
    : esc(title)}${details ? `<div class="muted small">${details}</div>` : ''}`;
};
const eventRows = (rows, shopHandle) => rows.map((event) => `<tr>
  <td>${fmtDate(event.occurred_at)}</td>
  <td><span class="activity">${esc(activityLabel(event.activity))}</span><div>${srcBadge(event.source_type)}</div></td>
  <td>${actorCell(event)}</td>
  ${historyCell(event.changes.unavailable)}
  ${historyCell(event.changes.committed)}
  ${historyCell(event.changes.available)}
  ${historyCell(event.changes.on_hand)}
  ${historyCell(event.changes.incoming)}
  <td>${esc(event.location)}<div class="small">${referenceCell(event, shopHandle)}</div></td>
</tr>`).join('');
const historyTable = (rows, shopHandle, empty = '暂无修改记录') => `
  <div class="table-scroll"><table class="history-table">
    <thead><tr><th>Date</th><th>Activity</th><th>Created by</th>
      <th class="num">Unavailable</th><th class="num">Committed</th>
      <th class="num">Available</th><th class="num">On hand</th>
      <th class="num">Incoming</th><th>Location / reference</th></tr></thead>
    <tbody>${eventRows(rows, shopHandle) || `<tr><td colspan="9" class="muted">${empty}</td></tr>`}</tbody>
  </table></div>`;
const productName = (row) => `${esc(row.product_title)}${row.variant_title && row.variant_title !== 'Default Title' ? ` / ${esc(row.variant_title)}` : ''}`;
const primaryCode = (row) => row.barcode || '—';
const codeMeta = (row) => `<div class="product-code"><strong>${esc(row.barcode || '—')}</strong>${row.sku ? `<span>${esc(row.sku)}</span>` : ''}${row.vendor ? `<span>${esc(row.vendor)}</span>` : ''}</div>`;
const stockValue = (value) => value === null || value === undefined ? '<span class="muted">—</span>' : esc(value);
const changeValue = (delta, after) => {
  if (delta === null || delta === undefined) return '<span class="muted">—</span>';
  const n = Number(delta);
  const value = after === null || after === undefined ? '' : ` ${after}`;
  return `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted'}">(${signed(n)})</span>${value}`;
};
const historyDetailValue = (delta, after) => {
  if (delta === null || delta === undefined) return '<span class="not-provided">未提供</span>';
  return changeValue(delta, after);
};
const INVENTORY_STATE_LABEL = {
  available: 'Available', on_hand: 'On hand', unavailable: 'Unavailable',
  committed: 'Committed', incoming: 'Incoming', in_transit: 'In transit',
  reserved: 'Reserved', damaged: 'Damaged', safety_stock: 'Safety stock',
};
const rawStateSummary = (row) => {
  const standard = new Set(['available', 'on_hand', 'unavailable', 'committed', 'incoming']);
  const changes = Array.isArray(row.state_changes) ? row.state_changes.filter((change) => !standard.has(change.state)) : [];
  if (!changes.length) return '';
  return `<div class="raw-state-list">${changes.map((change) =>
    `${esc(INVENTORY_STATE_LABEL[change.state] || activityLabel(change.state))} ${signed(change.delta)}${change.qty_after === null ? '' : ` → ${esc(change.qty_after)}`}`
  ).join(' · ')}</div>`;
};
const lastInventoryChange = (row) => {
  const available = row.available_delta;
  const onHand = row.on_hand_delta;
  if (available !== null && available !== undefined) return `Available ${signed(available)}`;
  if (onHand !== null && onHand !== undefined) return `On hand ${signed(onHand)}`;
  return 'Inventory updated';
};
const backfillPercent = (state) => {
  if (!state?.running || !state.start || !state.cursor) return null;
  const start = +new Date(state.start);
  const cursor = +new Date(state.cursor);
  const end = Date.now();
  if (![start, cursor, end].every(Number.isFinite) || end <= start) return null;
  return Math.max(1, Math.min(99, Math.round((end - cursor) / (end - start) * 100)));
};
const missingWebhookScopes = (state) => {
  if (state?.missingScopes?.length) return state.missingScopes;
  return [...new Set((state?.results || [])
    .filter((result) => !result.ok && result.requiredScope)
    .map((result) => result.requiredScope))];
};

// ---- views ----

async function viewDashboard() {
  const [s, initialRecent] = await Promise.all([
    api('/status'),
    api('/recent-items?page=1&limit=10'),
  ]);
  const sync = s.initialSync;
  const snap = s.lastSnapshot;
  const history = s.historySync;
  const backfill = s.historyBackfill;
  const backfillPct = backfillPercent(backfill);
  const historyStatus = backfill?.running
    ? { text: '历史同步中', className: 'running' }
    : backfill?.error
      ? { text: '历史同步已暂停', className: 'warning' }
      : { text: '自动运行中', className: 'success' };
  const webhookMissingScopes = missingWebhookScopes(s.webhooksRegistered);
  const hasAttention = s.webhookBacklog > 20 || s.webhookErrors > 0
    || s.pendingAttribution > 100;
  const coverage = s.events.first ? `${new Date(s.events.first).toLocaleDateString('zh-CN')} 至今` : '尚无记录';
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>库存概览</h1><p class="muted">查看商品、修改记录和数据同步状态。</p></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>最近 3 天库存变动</h2><p class="muted compact">每个商品显示最近一次库存修改。</p></div><a class="subtle-link" href="#/history">查看全部修改记录 →</a></div>
      <div class="table-scroll"><table class="recent-products"><thead><tr><th>商品</th><th>Activity</th><th>Created by</th><th>Location</th><th class="num">Available</th><th>Last change</th></tr></thead>
      <tbody id="recent-products-body">${initialRecent.rows.map((row) => `<tr>
        <td><a class="item-link" href="#/items/${row.id}">${productName(row)}</a>${codeMeta(row)}</td>
        <td>${esc(activityLabel(row.activity))}<div>${srcBadge(row.source_type)}</div></td>
        <td>${actorCell(row)}</td><td>${esc(row.locations)}</td>
        <td class="num">${row.total_available}</td>
        <td>${esc(lastInventoryChange(row))}<div class="muted small">${fmtDate(row.occurred_at)}</div></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">最近 3 天没有库存修改</td></tr>'}</tbody></table></div>
      <div id="recent-products-pagination" class="pagination"></div>
    </div>
    <div class="grid overview-grid">
      <a class="stat stat-link" href="#/items"><div class="n">${s.items.n}</div><div class="l">商品 / Barcode</div><div class="hint">查看商品与各仓库存</div></a>
      <a class="stat stat-link" href="#/history"><div class="n">${s.events.n}</div><div class="l">修改记录</div><div class="hint">按一次操作合并显示</div></a>
      <a class="stat stat-link" href="#/history"><div class="n range">${coverage}</div><div class="l">已保存的历史范围</div><div class="hint">点击查看历史修改记录</div></a>
      <a class="stat stat-link ${hasAttention ? 'warn' : 'ok'}" href="#/system"><div class="n">${hasAttention ? '需查看' : '正常'}</div><div class="l">系统状态</div><div class="hint">${hasAttention ? '有同步状态需要查看' : '实时记录与 Shopify 当前库存正常'}</div></a>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>数据同步</h2><p class="muted compact">数字实时；记录等 Shopify 官方流水确认后入账；每天凌晨全量核对。</p></div>
        <div class="heading-actions"><a class="subtle-link" href="#/system">查看详情 →</a>
          <span class="status-pill ${historyStatus.className}">${historyStatus.text}</span>
        </div>
      </div>
      <div class="sync-list">
        <div><strong>① 库存数字（实时）</strong><div class="muted">变动信号${s.webhooksRegistered ? '通道正常' : '未启用'}，最近一次 ${fmtDate(s.webhookState?.last_inventory_at || s.webhookState?.last_received_at)} 已即时更新数字。</div></div>
        <div><strong>② 修改记录（官方流水）</strong><div class="muted">已入账至 ${fmtDate(s.events?.last)}${s.pendingAttribution ? `；${s.pendingAttribution} 笔变动已收到信号、等待 Shopify 官方确认后入账` : '，暂无待确认变动'}。</div></div>
        <div><strong>③ 每日全量核对</strong><div class="muted">${snap ? `凌晨 ${fmtDate(snap.finishedAt || snap.snapDate)} 已把全店库存与 Shopify 逐一核对。` : '尚未完成首次核对。'}</div></div>
        <div><strong>历史记录</strong><div class="muted">${backfill?.running
          ? `正在进行${backfillPct ? `（约 ${backfillPct}%）` : ''}，已读取 ${backfill.fetched || 0} 行${backfill.cursor ? `，已回填到 ${fmtDate(backfill.cursor)}` : ''}；不影响当前页面使用。`
          : backfill?.error ? `同步已暂停：${esc(backfill.error)}`
          : backfill?.finishedAt ? `最近 180 天已同步完成（${fmtDate(backfill.finishedAt)}）。` : '尚未同步 Shopify 最近 180 天。'}</div></div>
      </div>
    </div>
    <details class="card system-details">
      <summary>系统状态说明</summary>
      <div class="health-grid">
        <div><strong>实时接收队列：${s.webhookBacklog}</strong><p>Shopify 已发送、应用尚未处理的事件。处理错误 ${s.webhookErrors || 0} 条；通常两者都应为 0。</p></div>
        <div><strong class="status-label">等待官方流水：${s.pendingAttribution} ${infoTip(STATUS_HELP.completion)}</strong><p>数量已实时更新；记录待 Shopify 官方流水回传后入账（通常几分钟）。</p></div>
        <div><strong class="status-label">Shopify 当前库存 ${infoTip(STATUS_HELP.currentInventory)}</strong><p>当前数量直接采用 Shopify 真值；快照不会生成推算告警。</p></div>
      </div>
    </details>
    <details class="card system-details">
      <summary>维护工具</summary>
      <div class="row">
        <button id="btn-sync">同步商品目录</button>
        <span class="muted">${sync ? (sync.done ? `✅ 已完成：${sync.count} 个变体（${fmtDate(sync.finishedAt)}）` : sync.error ? `❌ 失败：${esc(sync.error)}` : `⏳ 进行中… ${sync.count || 0} 个变体`) : '未运行'}</span>
      </div>
      <div class="row">
        <button id="btn-webhooks">重新注册实时接收</button>
        <span class="muted">${s.webhooksRegistered?.error
          ? `❌ ${esc(s.webhooksRegistered.error)}`
          : s.webhooksRegistered
            ? s.webhooksRegistered.results?.some((r) => !r.ok)
              ? s.webhooksRegistered.results.some((r) => !r.ok && !r.optional)
                ? `❌ 核心实时接收注册失败（${s.webhooksRegistered.results.filter((r) => !r.ok && !r.optional).map((r) => esc(r.topic)).join('、')}）`
                : webhookMissingScopes.length
                  ? `⚠️ 核心已注册；待授权：${webhookMissingScopes.map(esc).join('、')}`
                  : `⚠️ 核心已注册；${s.webhooksRegistered.results.filter((r) => !r.ok).length} 个扩展事件未注册`
              : `✅ 已注册（${fmtDate(s.webhooksRegistered.at)}）`
            : '未注册'}</span>
      </div>
      <div class="row">
        <button id="btn-snapshot" class="secondary">刷新 Shopify 当前库存</button>
        <span class="muted">${s.snapshotError?.error
          ? `❌ ${esc(s.snapshotError.error)}`
          : snap ? `上次刷新 ${snap.snapDate}：保存 ${snap.snapshotRows} 条变化快照` : '尚未刷新'}</span>
      </div>
      <div class="row">
        <button id="btn-history" class="secondary">同步 Shopify 最近 180 天</button>
        <span class="muted">${backfill ? backfill.running ? `⏳ 历史回填中… 已读取 ${backfill.fetched || 0} 行` : backfill.error ? `❌ ${esc(backfill.error)}` : `历史回填完成 ${fmtDate(backfill.finishedAt)}：新增 ${backfill.inserted || 0}` : '尚未回填'}
        ${history?.finishedAt ? ` · 信息补全 ${fmtDate(history.finishedAt)}` : ''}</span>
      </div>
      <div class="row" style="align-items:flex-start;flex-direction:column;gap:6px">
        <strong>导入 Stocky 历史调整（CSV）</strong>
        <div class="row">
          <input type="file" id="stocky-csv" accept=".csv,text/csv">
          <button id="btn-stocky-dry" class="secondary">① 预检（只分析不写入）</button>
          <button id="btn-stocky-commit" disabled>② 确认导入</button>
          <button id="btn-stocky-undo" class="secondary" style="color:var(--red)">撤销导入</button>
        </div>
        <div class="muted small">撤销会删除导入的 STK 单和历史记录、并把回填的操作人/备注清回原样（不动 Shopify 原有数据）；撤销后可重新导入。</div>
        <div id="stocky-report" class="muted small"></div>
      </div>
      <p class="muted compact">这些工具仅用于安装、恢复或手动刷新；日常使用无需点击。</p>
    </details>
    <div class="notice"><strong>历史范围说明：</strong>Shopify 商品 Adjustment history 页面提供最近 180 天。本应用会永久保存已经采集或导入的记录；要补齐更早的 Stocky 历史，需要后续导入 Stocky 导出文件。</div>`;
  let recentPage = 1;
  const renderRecent = (result) => {
    $w('#recent-products-body').innerHTML = result.rows.map((row) => `<tr>
      <td><a class="item-link" href="#/items/${row.id}">${productName(row)}</a>${codeMeta(row)}</td>
      <td>${esc(activityLabel(row.activity))}<div>${srcBadge(row.source_type)}</div></td>
      <td>${actorCell(row)}</td><td>${esc(row.locations)}</td>
      <td class="num">${row.total_available}</td>
      <td>${esc(lastInventoryChange(row))}<div class="muted small">${fmtDate(row.occurred_at)}</div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">最近 3 天没有库存修改</td></tr>';
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    $w('#recent-products-pagination').innerHTML = result.total > result.pageSize ? `
      <button id="recent-prev" class="secondary" ${recentPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${recentPage} / ${pages} 页 · 每页 10 个商品</span>
      <button id="recent-next" class="secondary" ${recentPage >= pages ? 'disabled' : ''}>下一页</button>` : '';
    if ($('#recent-prev')) $('#recent-prev').onclick = async () => {
      recentPage--;
      renderRecent(await api(`/recent-items?page=${recentPage}&limit=10`));
    };
    if ($('#recent-next')) $('#recent-next').onclick = async () => {
      recentPage++;
      renderRecent(await api(`/recent-items?page=${recentPage}&limit=10`));
    };
  };
  renderRecent(initialRecent);
  const guard = (fn) => async (e) => {
    e.target.disabled = true;
    try { await fn(e); }
    catch (err) { alert(`操作失败：${err.message}`); e.target.disabled = false; }
  };
  $('#btn-sync').onclick = guard(async () => { await api('/setup/sync', { method: 'POST' }); setTimeout(viewDashboard, 1500); });
  $('#btn-webhooks').onclick = guard(async () => {
    const state = await api('/setup/webhooks', { method: 'POST' });
    const { results } = state;
    const failed = results.filter((r) => !r.ok);
    const coreFailed = failed.filter((r) => !r.optional);
    const missingScopes = missingWebhookScopes(state);
    if (coreFailed.length) {
      alert(`核心实时接收注册失败：\n${coreFailed.map((f) => f.topic).join('\n')}`);
    } else if (failed.length) {
      alert(`核心库存实时接收已注册。\n${missingScopes.length
        ? `当前安装缺少扩展权限：\n${missingScopes.join('\n')}\n\n请在 Shopify App 配置中加入这些 scopes、保存后重新打开 App 批准权限，再点击本按钮。`
        : `另有 ${failed.length} 个扩展事件未注册，不影响库存数量的实时记录。`}`);
    }
    viewDashboard();
  });
  $('#btn-snapshot').onclick = guard(async (e) => {
    e.target.textContent = '快照运行中…（可能几分钟）';
    try { await api('/jobs/snapshot', { method: 'POST' }); } finally { viewDashboard(); }
  });
  $('#btn-history').onclick = guard(async () => {
    await api('/jobs/history?days=180', { method: 'POST' });
    setTimeout(viewDashboard, 1500);
  });

  // Stocky legacy CSV import: dry-run report first, explicit second click to commit.
  const stockyReport = (r, committed) => `
    <div class="notice" style="margin-top:6px">
      ${committed ? `<strong>✅ 导入完成：</strong>新增 ${committed.adjustmentsCreated} 张调整单（库存调整工作区，编号 STK-xxxx）、${committed.eventsInserted} 个修改记录事件、${committed.linesInserted} 行账本明细、${committed.itemsCreated} 个本地商品。<br>` : ''}
      <strong>预检报告</strong>（CSV ${r.totalCsvRows} 行）<br>
      · 将导入：<strong>${r.eventsToImport}</strong> 张调整单（进「库存调整」工作区，保留原编号/原因/调整人/备注）/ ${r.linesToImport} 行（${r.dateRange ? `${r.dateRange.first.slice(0, 10)} → ${r.dateRange.last.slice(0, 10)}` : '—'}）<br>
      · 跳过（${r.coverageStart ? r.coverageStart.slice(0, 10) : '—'} 起已有正式记录）：${r.skippedAlreadyCovered.groups} 单 / ${r.skippedAlreadyCovered.rows} 行<br>
      · 跳过（Stocky 中未执行 not_adjusted/failed）：${r.skippedNotAdjustedRows} 行；缺日期单：${r.missingDateGroups.length}；缺条码行：${r.missingBarcodeRows}<br>
      · 将新建本地商品（Stocky 内部 # 产品）：${r.localItemsToCreate} 个${r.localItemSamples.length ? `，如 ${r.localItemSamples.slice(0, 3).map((s) => esc(s.product)).join('、')}` : ''}<br>
      · 将新建员工：${r.newStaff.length ? r.newStaff.map(esc).join('、') : '无'}；新建仓位：${r.newLocations.length ? r.newLocations.map(esc).join('、') : '无'}；新建历史原因（不进新建下拉）：${r.newReasons?.length ? r.newReasons.map(esc).join('、') : '无'}<br>
      ${r.coveredMapping ? `· 重叠期（已有正式记录）：${r.coveredMapping.matched} 单匹配成功→回填操作人/备注到现有记录；${r.coveredMapping.unmatched} 单未匹配、${r.coveredMapping.ambiguous} 单有歧义（这些只建 STK 档案、不动现有记录）<br>` : ''}      · 原因分布：${r.reasons.slice(0, 6).map(([n, c]) => `${esc(n)}×${c}`).join('、')}${r.reasons.length > 6 ? '…' : ''}
      ${r.duplicateBarcodesInCatalog.length ? `<br>· ⚠️ 目录中重复条码（取第一个匹配）：${r.duplicateBarcodesInCatalog.slice(0, 5).map(esc).join('、')}` : ''}
    </div>`;
  const readStockyFile = () => new Promise((resolve, reject) => {
    const f = $('#stocky-csv').files[0];
    if (!f) return reject(new Error('请先选择 Stocky 导出的 CSV 文件'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(f);
  });
  $('#btn-stocky-dry').onclick = guard(async (e) => {
    const text = await readStockyFile();
    $w('#stocky-report').innerHTML = '预检中…';
    const { report } = await api('/import/stocky?mode=dry-run', {
      method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' },
    });
    $w('#stocky-report').innerHTML = stockyReport(report);
    $('#btn-stocky-commit').disabled = false;
    e.target.disabled = false;
  });
  $('#btn-stocky-commit').onclick = guard(async (e) => {
    if (!confirm('确认把预检通过的 Stocky 历史调整写入账本？（幂等，可重复执行）')) { e.target.disabled = false; return; }
    const text = await readStockyFile();
    $w('#stocky-report').innerHTML = '导入中…（几十秒）';
    const result = await api('/import/stocky?mode=commit', {
      method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' },
    });
    $w('#stocky-report').innerHTML = stockyReport(result.report, result);
  });
  $('#btn-stocky-undo').onclick = guard(async (e) => {
    if (!confirm('撤销 Stocky 导入？将删除所有 STK 调整单和导入的历史记录，并把回填的操作人/备注清回原样。此操作可逆——之后可重新导入。')) { e.target.disabled = false; return; }
    $w('#stocky-report').innerHTML = '撤销中…';
    const r = await api('/import/stocky/undo', { method: 'POST' });
    $w('#stocky-report').innerHTML = `<div class="notice">✅ 已撤销：删除 ${r.deletedAdjustments} 张 STK 单、${r.deletedEvents} 个历史事件、${r.deletedLedgerRows} 行明细；回退 ${r.revertedBackfillRows} 行回填；删除 ${r.deletedLocalItems} 个本地商品。可重新导入。</div>`;
    e.target.disabled = false;
  });
}

async function viewLocalItems() {
  app.innerHTML = '<div class="card">加载中…</div>';
  const render = async (term = '') => {
    const { rows, total } = await api(`/local-items?q=${encodeURIComponent(term)}`);
    app.innerHTML = `
      <div class="page-heading"><div><h1>Shopify 已删除产品（${total}）</h1><p class="muted">这些产品在导入时按 Barcode 和 SKU 都在当前 Shopify 目录里找不到——基本是这几年停产/下架、已从 Shopify 删除的旧品，以及 Stocky 内部 # 组件。系统保留它们，只为不丢失其历史调整记录。</p></div><a class="back-link" href="#/items">← 返回商品</a></div>
      <div class="card">
        <div class="row"><input type="search" id="local-q" value="${esc(term)}" placeholder="搜索标题 / Barcode / SKU…"><button id="local-search" class="secondary">搜索</button></div>
        <div class="table-scroll"><table>
          <thead><tr><th>商品</th><th>规格</th><th>Barcode</th><th>SKU</th><th class="num">调整单数</th><th>出现在（点击跳转）</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><a class="item-link" href="#/items/${r.id}">${esc(r.product_title || '(无标题)')}</a></td>
            <td>${variantLabel(r) || '<span class="muted">—</span>'}</td>
            <td><strong>${esc(r.barcode || '—')}</strong></td><td>${esc(r.sku || '—')}</td>
            <td class="num">${r.adjustment_count}</td>
            <td class="small">${(r.adjustments || []).map((a) => `<a href="#/adjustments/${a.id}">${esc(String(a.no || '').replace(/^STK-/, '#'))}</a>`).join('、')}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">没有已删除产品</td></tr>'}</tbody>
        </table></div>
        ${total > rows.length ? `<p class="muted small">显示前 ${rows.length} 个（共 ${total}），用搜索缩小范围。</p>` : ''}
      </div>`;
    $('#local-search').onclick = () => render($('#local-q').value);
    $('#local-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') render($('#local-q').value); });
  };
  await render();
}

async function viewItems() {
  const options = await api('/item-options');
  let page = 1;
  app.innerHTML = `
    <div class="page-heading"><div><h1>产品列表</h1><p class="muted">按 Brand、Collection、库存或最近修改时间查找商品。</p></div>
      <div class="button-group"><a class="button secondary" href="#/local-items">Shopify 已删除产品</a></div></div>
    <div class="card">
      <div class="filter-grid">
        <input type="search" id="q" placeholder="搜索 Barcode / 标题 / SKU / 品牌…">
        <select id="vendor-filter"><option value="">全部 Brand</option>${options.vendors.map((vendor) => `<option value="${esc(vendor)}">${esc(vendor)}</option>`).join('')}</select>
        <select id="collection-filter"><option value="">全部 Collection</option>${options.collections.map((collection) => `<option value="${esc(collection.id)}">${esc(collection.title)}</option>`).join('')}</select>
        <select id="item-sort">
          <option value="updated_desc">最近修改：新 → 旧</option>
          <option value="updated_asc">最近修改：旧 → 新</option>
          <option value="stock_desc">Available：高 → 低</option>
          <option value="stock_asc">Available：低 → 高</option>
          <option value="brand_asc">Brand：A → Z</option>
          <option value="brand_desc">Brand：Z → A</option>
          <option value="name_asc">商品名称：A → Z</option>
          <option value="name_desc">商品名称：Z → A</option>
          <option value="collection">Collection 默认顺序</option>
        </select>
        <button id="btn-search" class="secondary">应用</button>
      </div>
      <div id="items-summary" class="muted small"></div>
      <div id="items-out">加载中…</div>
      <div id="items-pagination" class="pagination"></div>
    </div>`;
  const run = async () => {
    $w('#items-out').innerHTML = '加载中…';
    try {
      const params = new URLSearchParams({
        q: $('#q').value,
        vendor: $('#vendor-filter').value,
        collection: $('#collection-filter').value,
        sort: $('#item-sort').value,
        page: String(page),
        limit: '50',
      });
      const result = await api(`/items?${params}`);
      const { rows } = result;
      $('#items-summary').textContent = `共 ${result.total} 个商品变体`;
      $w('#items-out').innerHTML = rows.length ? `
        <div class="table-scroll"><table class="items-table"><thead><tr><th>商品</th><th class="num">Unavailable</th><th class="num">Committed</th><th class="num">Available</th><th class="num">On hand</th><th class="num">Incoming</th><th>最近库存修改</th><th>最近修改时间</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><a class="item-link" href="#/items/${r.id}">${productName(r)}</a>${r.source === 'local' ? ' <span class="badge">已删除</span>' : ''}${codeMeta(r)}</td>
          <td class="num">${stockValue(r.total_unavailable)}</td>
          <td class="num">${stockValue(r.total_committed)}</td>
          <td class="num">${stockValue(r.total_available)}</td>
          <td class="num">${stockValue(r.total_on_hand)}</td>
          <td class="num">${stockValue(r.total_incoming)}</td>
          <td>${r.last_changed_at ? esc(lastInventoryChange(r)) : '<span class="muted">暂无记录</span>'}<div class="muted small">${r.last_activity ? esc(activityLabel(r.last_activity)) : ''}</div></td>
          <td>${fmtDate(r.last_changed_at)}</td></tr>`).join('')}</tbody></table></div>` : '无结果。';
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      $w('#items-pagination').innerHTML = result.total > result.pageSize ? `
        <button id="items-prev" class="secondary" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${page} / ${pages} 页</span>
        <button id="items-next" class="secondary" ${page >= pages ? 'disabled' : ''}>下一页</button>` : '';
      if ($('#items-prev')) $('#items-prev').onclick = () => { page--; run(); };
      if ($('#items-next')) $('#items-next').onclick = () => { page++; run(); };
    } catch (e) { $w('#items-out').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  const resetAndRun = () => { page = 1; run(); };
  $('#btn-search').onclick = resetAndRun;
  $('#vendor-filter').onchange = resetAndRun;
  $('#collection-filter').onchange = () => {
    if ($('#collection-filter').value && $('#item-sort').value === 'updated_desc') {
      $('#item-sort').value = 'collection';
    }
    resetAndRun();
  };
  $('#item-sort').onchange = resetAndRun;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') resetAndRun(); });
  await run();
}

const TREND_METRICS = {
  available: { label: 'Available', help: '可用于销售或分配的库存。负数通常表示超卖或尚未完成库存修正。' },
  on_hand: { label: 'On hand', help: '仓位内实际持有的库存，包括 Available 与各类不可售库存。' },
  committed: { label: 'Committed', help: '已经分配给订单、尚未完成出库的库存。' },
  incoming: { label: 'Incoming', help: '已经在采购或调拨流程中、尚未到达仓位的库存。' },
};
const CHART_RANGES = { 30: '最近 30 天', 90: '最近 90 天', 180: '最近 180 天', all: '全部记录' };
const shortDay = (value) => new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
const levelTotal = (levels, key) => {
  const values = levels.map((level) => level[key]).filter((value) => value !== null && value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) : null;
};
const inventoryNumber = (value, key = '') => {
  if (value === null || value === undefined) return '<span class="inventory-value muted">未提供</span>';
  const className = key === 'available' && Number(value) < 0 ? 'negative' : Number(value) > 0 ? 'positive' : '';
  return `<span class="inventory-value ${className}">${esc(value)}</span>`;
};
const metricCard = (levels, key) => {
  const metric = TREND_METRICS[key];
  const value = levelTotal(levels, key);
  return `<div class="inventory-metric ${key === 'available' && Number(value) < 0 ? 'attention' : ''}">
    <div class="inventory-metric-label">${metric.label} ${infoTip(metric.help)}</div>
    ${inventoryNumber(value, key)}
    <div class="inventory-metric-note">${key === 'available' && Number(value) < 0
      ? `库存不足 ${Math.abs(Number(value))}`
      : key === 'incoming' && Number(value) > 0 ? `${value} 件正在入库` : '全部仓位合计'}</div>
  </div>`;
};
const locationCard = (level) => {
  const available = level.available === null ? null : Number(level.available);
  const unavailable = level.unavailable === null ? null : Number(level.unavailable);
  const detailStates = [
    ['Committed', level.committed],
    ['Reserved', level.reserved],
    ['Damaged', level.damaged],
    ['Safety stock', level.safety_stock],
    ['Quality control', level.quality_control],
  ].filter(([, value]) => value !== null && value !== undefined);
  const status = available < 0
    ? `<span class="location-status danger">库存不足 ${Math.abs(available)}</span>`
    : Number(level.incoming || 0) > 0
      ? `<span class="location-status incoming">有 ${esc(level.incoming)} 件在途</span>`
      : '<span class="location-status">库存已同步</span>';
  return `<article class="location-inventory-card">
    <header>
      <div><h3>${esc(level.name)}</h3>${status}</div>
      <span class="location-updated">更新于 ${fmtDate(level.updated_at)}</span>
    </header>
    <div class="location-metrics">
      <div><span>Available</span>${inventoryNumber(level.available, 'available')}</div>
      <div><span>On hand</span>${inventoryNumber(level.on_hand)}</div>
      <div><span>Incoming</span>${inventoryNumber(level.incoming)}</div>
      <div class="unavailable-total"><span>Unavailable ${infoTip('由 On hand − Available 计算，是不可售库存总量；Committed 等状态包含在其中，不应与其再次相加。')}</span>${inventoryNumber(unavailable)}</div>
    </div>
    <div class="location-breakdown">
      <span>Unavailable 明细</span>
      ${detailStates.length
        ? detailStates.map(([name, value]) => `<span>${name} <strong>${esc(value)}</strong></span>`).join('')
        : '<span class="muted">Shopify 未提供明细</span>'}
    </div>
  </article>`;
};

function inventoryTrendChart(data) {
  const metric = TREND_METRICS[data.state] || TREND_METRICS.available;
  if (data.current === null || data.current === undefined) {
    return `<div class="trend-empty"><strong>${metric.label} 暂无数据</strong><span>Shopify 尚未提供这个库存状态。</span></div>`;
  }
  if (!data.hasHistory || data.points.length < 2) {
    return `<div class="trend-empty"><strong>当前 ${metric.label}：${esc(data.current)}</strong><span>还没有足够的修改记录可绘制趋势；系统不会用两个日期制造一条假折线。</span></div>`;
  }

  const points = data.points.map((point) => ({ ...point, time: +new Date(point.at), value: Number(point.value) }));
  const w = 1000, h = 270, left = 58, right = 24, top = 18, bottom = 46;
  const xMin = points[0].time;
  const xMax = points[points.length - 1].time;
  const rawMin = Math.min(0, ...points.map((point) => point.value));
  const rawMax = Math.max(0, ...points.map((point) => point.value));
  const rawSpan = rawMax - rawMin;
  const margin = rawSpan === 0 ? 1 : Math.max(1, rawSpan * 0.12);
  const yMin = rawMin - margin;
  const yMax = rawMax + margin;
  const X = (value) => left + (w - left - right) * (xMax === xMin ? 0.5 : (value - xMin) / (xMax - xMin));
  const Y = (value) => top + (h - top - bottom) * (yMax - value) / (yMax - yMin);
  const line = points.reduce((path, point, index) => {
    const x = X(point.time).toFixed(1);
    const y = Y(point.value).toFixed(1);
    return index ? `${path} H${x} V${y}` : `M${x},${y}`;
  }, '');
  const zeroY = Y(0).toFixed(1);
  const area = `M${X(points[0].time).toFixed(1)},${zeroY} L${X(points[0].time).toFixed(1)},${Y(points[0].value).toFixed(1)} ${line.slice(line.indexOf(' ') + 1)} L${X(points.at(-1).time).toFixed(1)},${zeroY} Z`;
  const tickCount = 4;
  const yTicks = [...new Set(Array.from(
    { length: tickCount + 1 },
    (_, index) => Math.round(yMin + (yMax - yMin) * index / tickCount),
  ))].sort((a, b) => a - b);
  const xTicks = [xMin, xMin + (xMax - xMin) / 2, xMax];
  const pointMarks = points.map((point, index) => {
    if (point.kind === 'baseline' && index === 0) return '';
    const x = X(point.time);
    const y = Y(point.value);
    return `<g class="trend-point" tabindex="0" role="button"
      aria-label="${esc(`${fmtDate(point.at)}，${metric.label} ${point.value}`)}"
      data-x="${(x / w * 100).toFixed(2)}" data-y="${(y / h * 100).toFixed(2)}"
      data-date="${esc(fmtDate(point.at))}" data-value="${esc(point.value)}"
      data-delta="${point.delta === null || point.delta === undefined ? '' : esc(point.delta)}"
      data-activity="${point.activity ? esc(activityLabel(point.activity)) : ''}"
      data-location="${point.location ? esc(point.location) : ''}">
      <circle class="trend-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>
      <circle class="trend-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14"/>
    </g>`;
  }).join('');

  return `<div class="trend-chart-wrap" data-trend-chart>
    <div class="trend-current"><span>${esc(data.location)} · ${metric.label}</span><strong>${esc(data.current)}</strong></div>
    <svg class="inventory-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`${metric.label} 库存趋势`)}">
      <defs><linearGradient id="inventory-trend-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#008060" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#008060" stop-opacity=".015"/>
      </linearGradient></defs>
      ${yTicks.map((tick) => `<g>
        <line x1="${left}" y1="${Y(tick).toFixed(1)}" x2="${w - right}" y2="${Y(tick).toFixed(1)}" class="${Math.abs(tick) < .001 ? 'trend-zero-line' : 'trend-grid-line'}"/>
        <text x="${left - 10}" y="${(Y(tick) + 4).toFixed(1)}" text-anchor="end" class="trend-axis-label">${Math.round(tick)}</text>
      </g>`).join('')}
      <path d="${area}" class="trend-area"/>
      <path d="${line}" class="trend-line"/>
      ${pointMarks}
      ${xTicks.map((time, index) => `<text x="${X(time).toFixed(1)}" y="${h - 16}" text-anchor="${index === 0 ? 'start' : index === 2 ? 'end' : 'middle'}" class="trend-axis-label">${esc(shortDay(time))}</text>`).join('')}
    </svg>
    <div class="trend-tooltip" role="status"></div>
    <div class="trend-caption"><span>每个圆点代表一次库存操作；阶梯线仅在操作发生时改变</span><span>${esc(CHART_RANGES[data.range] || '')} · 截至 ${fmtDate(data.to)}</span></div>
  </div>`;
}

function wireTrendChart() {
  const wrap = document.querySelector('[data-trend-chart]');
  if (!wrap) return;
  const tooltip = wrap.querySelector('.trend-tooltip');
  const hide = () => tooltip.classList.remove('visible');
  wrap.querySelectorAll('.trend-point').forEach((point) => {
    const show = () => {
      const delta = point.dataset.delta;
      const context = [point.dataset.activity, point.dataset.location].filter(Boolean).join(' · ');
      tooltip.innerHTML = `<strong>${esc(point.dataset.value)}</strong><span>${esc(point.dataset.date)}${delta ? ` · 变动 ${signed(delta)}` : ' · 当前库存'}</span>${context ? `<span>${esc(context)}</span>` : ''}`;
      tooltip.style.left = `${Math.max(8, Math.min(92, Number(point.dataset.x)))}%`;
      tooltip.style.top = `${Math.max(14, Number(point.dataset.y))}%`;
      tooltip.classList.add('visible');
    };
    point.addEventListener('mouseenter', show);
    point.addEventListener('focus', show);
    point.addEventListener('mouseleave', hide);
    point.addEventListener('blur', hide);
  });
}

const SALES_RANGE_LABELS = {
  7: '最近 7 天',
  30: '最近 30 天',
  90: '最近 3 个月',
  180: '最近半年',
  365: '最近一年',
  all: '全部记录',
};
const MOVEMENT_LABELS = {
  order: '下单占用',
  sale: '销售出库',
  cancel: '取消/释放',
  return: '退货入库',
  receipt: '采购入库',
};
const compactNumber = (value, digits = 0) => Number(value || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const salesPeriodLabel = (period) => {
  if (/^\d{4}-\d{2}$/.test(period)) return `${Number(period.slice(5))}月`;
  const date = new Date(`${period}T00:00:00.000Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
};

function salesHistoryChart(data) {
  const series = data.series || [];
  const maxValue = Math.max(0, ...series.flatMap((row) => [
    row.ordered,
    row.sold,
    row.cancelled,
    row.returned,
    row.received,
  ]));
  if (!series.length || maxValue === 0) {
    return `<div class="sales-chart-empty">这个时间段没有可绘制的下单、出货、取消、退货或采购入库数据。</div>`;
  }
  const w = 1000, h = 220, left = 45, right = 18, top = 18, bottom = 42;
  const plotHeight = h - top - bottom;
  const plotWidth = w - left - right;
  const groupWidth = plotWidth / series.length;
  const barWidth = Math.max(2.5, Math.min(11, groupWidth * .22));
  const Y = (value) => top + plotHeight * (1 - value / maxValue);
  const bars = series.map((row, index) => {
    const center = left + groupWidth * (index + .5);
    const values = [
      ['ordered', row.ordered, center - barWidth * 2.3],
      ['sold', row.sold, center - barWidth * 1.15],
      ['cancelled', row.cancelled, center],
      ['returned', row.returned, center + barWidth * 1.15],
      ['received', row.received, center + barWidth * 2.3],
    ];
    return `<g class="sales-period" tabindex="0">
      <title>${esc(`${row.period} · 下单 ${row.ordered} · 出货 ${row.sold} · 取消/释放 ${row.cancelled} · 退货 ${row.returned} · 采购入库 ${row.received}`)}</title>
      ${values.map(([type, value, x]) => {
        const y = Y(value);
        return `<rect class="sales-bar ${type}" x="${(x - barWidth / 2).toFixed(1)}"
          y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}"
          height="${Math.max(0, top + plotHeight - y).toFixed(1)}" rx="1.5"/>`;
      }).join('')}
    </g>`;
  }).join('');
  const tickIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  const yTicks = [...new Set([0, Math.ceil(maxValue / 2), Math.ceil(maxValue)])];

  return `<div class="sales-chart">
    <div class="sales-legend">
      <span><i class="order"></i>下单占用</span>
      <span><i class="sale"></i>销售出库</span>
      <span><i class="cancel"></i>取消/释放</span>
      <span><i class="return"></i>退货入库</span>
      <span><i class="receipt"></i>采购入库</span>
    </div>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="下单、销售出库、取消、退货和采购入库趋势">
      ${yTicks.map((tick) => `<g>
        <line x1="${left}" y1="${Y(tick).toFixed(1)}" x2="${w - right}" y2="${Y(tick).toFixed(1)}" class="sales-grid-line"/>
        <text x="${left - 9}" y="${(Y(tick) + 4).toFixed(1)}" text-anchor="end" class="trend-axis-label">${tick}</text>
      </g>`).join('')}
      ${bars}
      ${tickIndexes.map((index) => {
        const x = left + groupWidth * (index + .5);
        return `<text x="${x.toFixed(1)}" y="${h - 14}" text-anchor="middle" class="trend-axis-label">${esc(salesPeriodLabel(series[index].period))}</text>`;
      }).join('')}
    </svg>
  </div>`;
}

const salesSummary = (data) => {
  const summary = data.summary;
  const coverage = summary.coverageDays === null
    ? '—'
    : summary.coverageDays > 999 ? '999+ 天' : `${Math.round(summary.coverageDays)} 天`;
  return `<div class="sales-summary-grid">
    <div><span>下单数量</span><strong>${compactNumber(summary.ordered)}</strong><small>${summary.orderedOrders} 个订单已占用库存</small></div>
    <div><span>已出货销量</span><strong>${compactNumber(summary.sold)}</strong><small>${summary.salesOrders} 个订单已完成出库</small></div>
    <div><span>待出货 ${infoTip('按同一订单的下单占用 − 已出货 − 已释放推算；只覆盖本应用已采集到的记录。')}</span><strong>${compactNumber(summary.pending)}</strong><small>${summary.pendingOrders} 个订单尚未见完整出库</small></div>
    <div><span>取消 / 退货</span><strong>${compactNumber(summary.cancelled + summary.returned)}</strong><small>释放 ${summary.cancelled} · 退货入库 ${summary.returned}</small></div>
    <div><span>净销售量</span><strong>${compactNumber(summary.netSold)}</strong><small>销售 − 退货</small></div>
    <div><span>采购入库</span><strong>${compactNumber(summary.received)}</strong><small>不含仓库调拨</small></div>
    <div><span>周均已出货</span><strong>${compactNumber(summary.averageWeekly, 1)}</strong><small>按净出货量和所选周期折算</small></div>
    <div><span>预计可售天数 ${infoTip('当前 Available ÷ 所选周期的日均净销量。没有净销量或库存为负时不估算。')}</span><strong>${coverage}</strong><small>当前 Available ${data.currentAvailable ?? '—'}</small></div>
  </div>`;
};

const movementQuantity = (row) => {
  if (row.movement_type === 'sale') return `−${esc(row.quantity)}`;
  if (['cancel', 'return', 'receipt'].includes(row.movement_type)) return `+${esc(row.quantity)}`;
  return esc(row.quantity);
};

const salesRows = (data) => data.rows.map((row) => `<tr>
  <td>${fmtDate(row.occurred_at)}</td>
  <td><span class="movement-badge ${esc(row.movement_type)}">${esc(MOVEMENT_LABELS[row.movement_type] || row.movement_type)}</span></td>
  <td class="num movement-qty ${row.movement_type === 'sale' ? 'out' : ['cancel', 'return', 'receipt'].includes(row.movement_type) ? 'in' : 'demand'}">${movementQuantity(row)}</td>
  <td>${esc(row.location)}</td>
  <td>${referenceCell(row, data.shopHandle)}</td>
  <td>${esc(activityLabel(row.activity))}</td>
</tr>`).join('');

function renderSalesHistory(data) {
  const rangeText = data.first
    ? `${data.rangeLabel} · ${fmtDate(data.first)} 至 ${fmtDate(data.last)}`
    : `${data.rangeLabel} · 暂无销售业务记录`;
  return `
    <p class="sales-range muted">${esc(rangeText)}</p>
    ${salesSummary(data)}
    ${salesHistoryChart(data)}
    <div class="sales-method-note">
      下单数量来自订单导致的 Available 占用；只有 Order fulfilled 导致 On hand 减少才算已出货销量。待出货按同一订单的下单、出货和库存释放记录推算；退货与采购入库单独统计，调拨、人工调整和 App 修正不计入销量。
    </div>
    <div class="table-scroll"><table class="sales-history-table">
      <thead><tr><th>Date</th><th>类型</th><th class="num">数量</th><th>Location</th><th>关联单据 / 客户</th><th>Activity</th></tr></thead>
      <tbody>${salesRows(data) || '<tr><td colspan="6" class="muted">这个周期暂无下单、出货、取消、退货或采购入库记录。</td></tr>'}</tbody>
    </table></div>`;
}

async function viewItem(id) {
  app.innerHTML = '<div class="card">加载中…</div>';
  const { item, levels, shopHandle, links, lastChange } = await api(`/items/${id}`);
  const latestLevelUpdate = levels.reduce((latest, level) =>
    !latest || +new Date(level.updated_at) > +new Date(latest) ? level.updated_at : latest, null);
  app.innerHTML = `
    <p><a class="back-link" href="#/items">← 返回商品</a></p>
    <div class="card">
      <div class="card-heading"><h2>${productName(item)}</h2><div class="button-group">
        ${links.storefront ? `<a class="button secondary" href="${esc(links.storefront)}" target="_blank" rel="noopener">查看前台商品 ↗</a>` : '<span class="button secondary disabled">前台未发布</span>'}
        ${links.admin ? `<a class="button" href="${esc(links.admin)}" target="_blank" rel="noopener">打开 Shopify 后台 ↗</a>` : ''}
      </div></div>
      <div class="product-detail-meta">${codeMeta(item)}<span>零售价 ${item.price ?? '—'} · 成本 ${item.unit_cost ?? '—'}</span></div>
      <div class="inventory-overview-grid">
        ${metricCard(levels, 'available')}
        ${metricCard(levels, 'on_hand')}
        ${metricCard(levels, 'committed')}
        ${metricCard(levels, 'incoming')}
      </div>
      <div class="inventory-last-change">
        <span>最近库存变动 <strong>${lastChange ? esc(lastInventoryChange(lastChange)) : '暂无记录'}</strong></span>
        <span>最近同步 <strong>${fmtDate(latestLevelUpdate)}</strong></span>
      </div>
    </div>
    <div class="card inventory-trend-card">
      <div class="card-heading">
        <div><h2>库存趋势</h2><p class="muted compact">根据已保存的修改记录逐次反推库存；每次操作独立显示，不会把同一天的增减提前抵消。</p></div>
        <div class="trend-controls">
          <select id="trend-state" aria-label="库存状态">
            ${Object.entries(TREND_METRICS).map(([value, meta]) => `<option value="${value}">${meta.label}</option>`).join('')}
          </select>
          <select id="trend-location" aria-label="仓位">
            <option value="">全部仓位</option>
            ${levels.map((level) => `<option value="${esc(level.location_id)}">${esc(level.name)}</option>`).join('')}
          </select>
          <select id="trend-range" aria-label="时间范围">
            ${Object.entries(CHART_RANGES).map(([value, label]) => `<option value="${value}" ${value === '30' ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="inventory-trend"><div class="trend-loading">正在读取库存趋势…</div></div>
    </div>
    <div class="card sales-history-card">
      <div class="card-heading">
        <div><h2>销售历史</h2><p class="muted compact">区分下单需求、真实出货、待出货、取消/退货和采购入库，作为后续补货计划的数据基础。</p></div>
        <select id="sales-range" aria-label="销售历史周期">
          ${Object.entries(SALES_RANGE_LABELS).map(([value, label]) => `<option value="${value}" ${value === '30' ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div id="sales-history"><div class="trend-loading">正在计算销售历史…</div></div>
      <div id="sales-pagination" class="pagination"></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>各仓库存状态</h2><p class="muted compact">Unavailable 是不可售总量，Committed 等状态属于其明细，不重复相加。</p></div></div>
      <div class="location-inventory-list">${levels.map(locationCard).join('') || '<div class="trend-empty">Shopify 尚未提供仓位库存。</div>'}</div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>历史修改记录</h2><p id="history-range" class="muted compact">本地已保存的全部时间范围，可分页查看。</p></div>
        <select id="history-location"><option value="">全部仓位</option>${levels.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</select>
      </div>
      <div id="all-history">加载中…</div>
      <div id="history-pagination" class="pagination"></div>
    </div>
    <div class="notice"><strong>关于历史期限：</strong>Shopify 商品页仅显示最近 180 天；本应用会长期保留已采集记录。当前最早日期取决于首次同步时间，Stocky 更早历史需通过导入补齐。</div>`;

  let trendRequest = 0;
  const loadTrend = async () => {
    const request = ++trendRequest;
    const params = new URLSearchParams({
      state: $('#trend-state').value,
      range: $('#trend-range').value,
    });
    if ($('#trend-location').value) params.set('location', $('#trend-location').value);
    $w('#inventory-trend').innerHTML = '<div class="trend-loading">正在读取库存趋势…</div>';
    try {
      const result = await api(`/items/${id}/trend?${params}`);
      if (request !== trendRequest) return;
      $w('#inventory-trend').innerHTML = inventoryTrendChart(result);
      wireTrendChart();
    } catch (error) {
      if (request === trendRequest) $w('#inventory-trend').innerHTML = `<div class="trend-empty error">${esc(error.message)}</div>`;
    }
  };
  $('#trend-state').onchange = loadTrend;
  $('#trend-location').onchange = loadTrend;
  $('#trend-range').onchange = loadTrend;
  loadTrend();

  let salesPage = 1;
  const loadSales = async () => {
    const params = new URLSearchParams({
      range: $('#sales-range').value,
      page: String(salesPage),
      limit: '20',
    });
    $w('#sales-history').innerHTML = '<div class="trend-loading">正在计算销售历史…</div>';
    $w('#sales-pagination').innerHTML = '';
    try {
      const result = await api(`/items/${id}/sales?${params}`);
      $w('#sales-history').innerHTML = renderSalesHistory(result);
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      $w('#sales-pagination').innerHTML = result.total > result.pageSize ? `
        <button id="sales-prev" class="secondary" ${salesPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${salesPage} / ${pages} 页</span>
        <button id="sales-next" class="secondary" ${salesPage >= pages ? 'disabled' : ''}>下一页</button>` : '';
      if ($('#sales-prev')) $('#sales-prev').onclick = () => { salesPage--; loadSales(); };
      if ($('#sales-next')) $('#sales-next').onclick = () => { salesPage++; loadSales(); };
    } catch (error) {
      $w('#sales-history').innerHTML = `<div class="trend-empty error">${esc(error.message)}</div>`;
    }
  };
  $('#sales-range').onchange = () => { salesPage = 1; loadSales(); };

  let historyPage = 1;
  const loadHistory = async () => {
    const location = $('#history-location').value;
    const suffix = location ? `&location=${encodeURIComponent(location)}` : '';
    $w('#all-history').innerHTML = '加载中…';
    const historical = await api(`/items/${id}/history?page=${historyPage}&limit=25${suffix}`);
    $w('#all-history').innerHTML = historyTable(historical.rows, shopHandle, '该仓位暂无历史修改记录');
    $('#history-range').textContent = historical.first
      ? `共 ${historical.total} 条 · ${fmtDate(historical.first)} 至 ${fmtDate(historical.last)}`
      : '暂无已保存的修改记录';
    const pages = Math.max(1, Math.ceil(historical.total / historical.pageSize));
    $w('#history-pagination').innerHTML = historical.total > historical.pageSize ? `
      <button id="history-prev" class="secondary" ${historyPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${historyPage} / ${pages} 页</span>
      <button id="history-next" class="secondary" ${historyPage >= pages ? 'disabled' : ''}>下一页</button>` : '';
    if ($('#history-prev')) $('#history-prev').onclick = () => { historyPage--; loadHistory(); };
    if ($('#history-next')) $('#history-next').onclick = () => { historyPage++; loadHistory(); };
  };
  $('#history-location').onchange = () => { historyPage = 1; loadHistory(); };
  await Promise.all([loadSales(), loadHistory()]);
}

async function viewSystem() {
  app.innerHTML = '<div class="card">加载中…</div>';
  const status = await api('/status');
  const pct = backfillPercent(status.historyBackfill);
  const historyState = status.historyBackfill?.running
    ? { value: `${pct || '…'}%`, hint: `已读取 ${status.historyBackfill.fetched || 0} 行${status.historyBackfill.cursor ? `，已回填到 ${fmtDate(status.historyBackfill.cursor)}` : ''}`, className: '' }
    : status.historyBackfill?.error
      ? { value: '已暂停', hint: status.historyBackfill.error, className: 'warn' }
      : status.historyBackfill?.finishedAt
        ? { value: '完成', hint: '自动增量记录中', className: 'ok' }
        : { value: '未开始', hint: '可从首页维护工具开始同步', className: 'warn' };
  const snapshotState = status.lastSnapshot
    ? { value: '已刷新', hint: fmtDate(status.lastSnapshot.finishedAt || status.lastSnapshot.snapDate), className: 'ok' }
    : { value: '未开始', hint: '可从首页维护工具刷新', className: 'warn' };
  app.innerHTML = `
    <div class="page-heading"><div><h1>系统状态</h1><p class="muted">查看实时接收、信息补全和 Shopify 数据同步进度。</p></div><a class="back-link" href="#/dashboard">← 返回首页</a></div>
    <div class="grid system-stat-grid">
      <div class="stat ${status.webhookBacklog ? 'warn' : 'ok'}"><div class="n">${status.webhookBacklog}</div><div class="l">实时接收队列</div><div class="hint">通常应为 0</div></div>
      <div class="stat"><div class="n">${status.pendingAttribution}</div><div class="l status-label">等待官方流水 ${infoTip(STATUS_HELP.completion)}</div><div class="hint">官方流水回传后自动入账，通常几分钟</div></div>
      <div class="stat"><div class="n" style="font-size:15px">${fmtDate(status.events?.last)}</div><div class="l">修改记录已入账至</div><div class="hint">此后发生的变动已收到实时信号（数字已更新），等 Shopify 官方流水确认后入账，偶尔延迟数小时</div></div>
      <div class="stat ${snapshotState.className}"><div class="n">${snapshotState.value}</div><div class="l status-label">每日全量核对 ${infoTip(STATUS_HELP.currentInventory)}</div><div class="hint">${esc(snapshotState.hint)}</div></div>
      <div class="stat ${historyState.className}"><div class="n">${historyState.value}</div><div class="l status-label">180 天历史同步 ${infoTip(STATUS_HELP.history)}</div><div class="hint">${esc(historyState.hint)}</div></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>数据记录原则</h2><p class="muted compact">界面展示 Shopify 已返回的真实库存数量变化，不展示本地推算告警。</p></div></div>
      <div class="health-grid">
        <div><strong>当前库存</strong><p>直接使用 Shopify 返回的各仓位 Available、On hand、Committed 和 Incoming。</p></div>
        <div><strong>修改记录</strong><p>来自 Shopify Adjustment history、实时库存事件和本应用已提交的调整单；操作人和关联单据会随后自动补全。</p></div>
        <div><strong>每日快照</strong><p>只刷新当前库存基准并保存趋势检查点，不虚构操作人、原因或业务单据。</p></div>
      </div>
    </div>`;
}

async function viewHistory() {
  app.innerHTML = '<div class="card">加载中…</div>';
  let page = 1;
  const filters = { q: '', person: '', source: '', dateFrom: '', dateTo: '' };
  const load = async () => {
    const params = new URLSearchParams({ ...filters, page, limit: 50 });
    const result = await api(`/history?${params}`);
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    app.innerHTML = `
      <div class="page-heading"><div><h1>修改记录</h1><p class="muted">全店库存操作按事件合并显示，可查看操作人、App 和关联订单。</p></div></div>
      <div class="card">
        <div class="history-filters">
          <input id="history-q" type="search" value="${esc(filters.q)}" placeholder="商品、Barcode、SKU、订单或调整编号">
          <input id="history-person" type="search" value="${esc(filters.person)}" placeholder="员工或 App">
          <select id="history-source">
            <option value="">全部来源</option>
            ${[
              ['sale', 'Sale'], ['refund', 'Return'], ['transfer', 'Transfer'],
              ['adjustment', 'Adjustment'], ['staff', 'Staff'], ['app', 'App'],
            ].map(([value, label]) => `<option value="${value}" ${filters.source === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <input id="history-from" type="date" value="${esc(filters.dateFrom)}" aria-label="开始日期">
          <input id="history-to" type="date" value="${esc(filters.dateTo)}" aria-label="结束日期">
          <button id="history-filter" class="secondary">应用</button>
        </div>
        <div class="table-scroll"><table class="store-history">
          <thead><tr><th>Date</th><th>Activity</th><th>Created by</th><th>Product</th><th>Location</th><th>Reference</th></tr></thead>
          <tbody>${result.rows.map((row) => {
            // Multi-variant events expand inline (one product per line) instead
            // of only being visible after clicking into the detail page.
            const product = row.product_count === 1
              ? `<a class="history-event-link" href="#/history/${row.id}" title="查看本次修改详情"><span class="event-product-title">${esc(row.product_title)}${row.variant_title && row.variant_title !== 'Default Title' ? ` / ${esc(row.variant_title)}` : ''}</span>${codeMeta(row)}<span class="history-arrow" aria-hidden="true">→</span></a>`
              : `<details class="product-expand"><summary><strong>${row.product_count} 个商品变体</strong></summary>
                  <ul class="product-lines">${(row.products || []).map((p) => `<li><a class="item-link" href="#/items/${p.id}">${esc(p.product_title)}${p.variant_title && p.variant_title !== 'Default Title' ? ` / ${esc(p.variant_title)}` : ''}</a> <span class="muted">${esc(p.barcode || p.sku || '')}</span></li>`).join('')}</ul>
                  <a class="subtle-link" href="#/history/${row.id}">查看本次修改详情 →</a></details>`;
            return `<tr><td>${fmtDate(row.occurred_at)}</td>
              <td><span class="activity">${esc(activityLabel(row.activity))}</span><div>${srcBadge(row.source_type)}</div></td>
              <td>${actorCell(row)}</td><td>${product}</td><td>${esc(row.locations)}</td>
              <td>${referenceCell(row, result.shopHandle)}</td></tr>`;
          }).join('') || '<tr><td colspan="6" class="muted">暂无修改记录</td></tr>'}</tbody>
        </table></div>
        <div class="pagination">${result.total > result.pageSize ? `
          <button id="history-prev" class="secondary" ${page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>第 ${page} / ${pages} 页 · 共 ${result.total} 次修改</span>
          <button id="history-next" class="secondary" ${page >= pages ? 'disabled' : ''}>下一页</button>` : `<span class="muted">共 ${result.total} 次修改</span>`}</div>
      </div>
      <div class="notice">这里显示的是业务层面的修改事件，不再展示系统内部的逐状态技术流水。商品详情页可查看每次修改对 Available、On hand 等状态的具体影响。</div>`;
    const applyFilters = () => {
      filters.q = $('#history-q').value.trim();
      filters.person = $('#history-person').value.trim();
      filters.source = $('#history-source').value;
      filters.dateFrom = $('#history-from').value;
      filters.dateTo = $('#history-to').value;
      page = 1;
      load();
    };
    $('#history-filter').onclick = applyFilters;
    $('#history-source').onchange = applyFilters;
    for (const selector of ['#history-q', '#history-person']) {
      $(selector).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') applyFilters();
      });
    }
    if ($('#history-prev')) $('#history-prev').onclick = () => { page--; load(); };
    if ($('#history-next')) $('#history-next').onclick = () => { page++; load(); };
  };
  await load();
}

async function viewHistoryEvent(id) {
  app.innerHTML = '<div class="card">加载中…</div>';
  const { event, rows, adjustment, shopHandle } = await api(`/history/${id}`);
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>修改记录详情</h1><p class="muted">查看本次操作涉及的全部商品与 Shopify 返回的库存状态变化。</p></div>
      <a class="back-link" href="#/history">← 返回修改记录</a>
    </div>
    <div class="card event-overview">
      <div><span>Date</span><strong>${fmtDate(event.occurred_at)}</strong></div>
      <div><span>Activity</span><strong>${esc(activityLabel(event.activity))}</strong>${srcBadge(event.source_type)}</div>
      <div><span>Created by</span><div>${actorCell(event)}</div></div>
      <div><span>Reference</span><div>${referenceCell(event, shopHandle)}</div></div>
    </div>
    ${adjustment ? `<div class="card event-overview">
      <div><span>Adjustment</span><strong><a class="item-link" href="#/adjustments/${adjustment.id}">${esc(adjustment.display_number || '查看调整单')}</a></strong></div>
      <div><span>Shopify account</span><strong>${esc(adjustment.login_account_name || '—')}</strong></div>
      <div><span>Recorded by</span><strong>${esc(adjustment.recorded_by_name || '—')}</strong></div>
      <div><span>Handled by</span><strong>${esc(adjustment.handled_by_names || '—')}</strong></div>
    </div>${adjustment.notes ? `<div class="notice"><strong>Notes：</strong>${esc(adjustment.notes)}</div>` : ''}` : ''}
    <div class="card">
      <div class="card-heading"><div><h2>涉及商品</h2><p class="muted compact">共 ${rows.length} 个商品 / 仓位组合，Barcode 为主要识别编号。</p></div></div>
      <div class="table-scroll"><table class="event-detail-table">
        <thead><tr><th>商品</th><th>Barcode</th><th>SKU</th><th>Location</th>
          <th class="num">Unavailable</th><th class="num">Committed</th>
          <th class="num">Available</th><th class="num">On hand</th><th class="num">Incoming</th></tr></thead>
        <tbody>${rows.map((row) => {
          const standardMissing = ['unavailable', 'committed', 'available', 'on_hand', 'incoming']
            .every((state) => row[`${state}_delta`] === null || row[`${state}_delta`] === undefined);
          return `<tr>
          <td><a class="item-link" href="#/items/${row.item_id}">${productName(row)}</a>
            ${rawStateSummary(row)}
            ${standardMissing ? '<div class="missing-state-note">此工作流事件未返回表中 5 个标准状态；实际数量变化通常记录在同一操作的相邻事件。</div>' : ''}
          </td>
          <td><strong>${esc(primaryCode(row))}</strong></td><td>${esc(row.sku || '—')}</td><td>${esc(row.location)}</td>
          <td class="num">${historyDetailValue(row.unavailable_delta, row.unavailable_after)}</td>
          <td class="num">${historyDetailValue(row.committed_delta, row.committed_after)}</td>
          <td class="num">${historyDetailValue(row.available_delta, row.available_after)}</td>
          <td class="num">${historyDetailValue(row.on_hand_delta, row.on_hand_after)}</td>
          <td class="num">${historyDetailValue(row.incoming_delta, row.incoming_after)}</td>
        </tr>`;
        }).join('') || '<tr><td colspan="9" class="muted">该事件没有商品明细</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="notice"><strong>“未提供”不是 0：</strong>它表示 Shopify 在这条工作流事件中没有返回该库存状态。Transfer 等操作可能拆分成多条相邻事件，只有包含实际数量变化的事件才会显示数字。</div>`;
}

const ADJUSTMENT_STATUS = {
  draft: 'Draft',
  applying: 'Submitting',
  applied: 'Applied',
  archived: 'Archived',
};
const adjustmentStatus = (status) =>
  `<span class="status-pill adjustment-${esc(status)}">${ADJUSTMENT_STATUS[status] || esc(status)}</span>`;
// Imported Stocky records keep their original number (STK-3267 → shown as
// #3267). App-created ones use ADJ-…. isStocky lets callers add a source tag.
const stockyOriginalNo = (displayNumber) => {
  const m = String(displayNumber || '').match(/^STK-(.+)$/);
  return m ? m[1] : null;
};
const adjustmentNumber = (number, displayNumber = null) => {
  const stk = stockyOriginalNo(displayNumber);
  if (stk) return `#${esc(stk)}`;
  return esc(displayNumber || `A${String(number || 0).padStart(4, '0')}`);
};
// List view shows just the sequence part (A0002), the full A0002-260803 stays
// on the detail page where the date is useful.
const shortAdjustmentNumber = (number, displayNumber = null) => {
  const stk = stockyOriginalNo(displayNumber);
  if (stk) return `#${esc(stk)}`;
  const short = String(displayNumber || '').split('-')[0];
  return esc(short || `A${String(number || 0).padStart(4, '0')}`);
};
const stockyTag = (displayNumber) =>
  stockyOriginalNo(displayNumber) ? '<span class="badge import">Stocky 导入</span>' : '';
// Variant label, empty when it's the meaningless "Default Title".
const variantLabel = (row) =>
  row.variant_title && row.variant_title !== 'Default Title' ? esc(row.variant_title) : '';
const numOrDash = (v) => (v === null || v === undefined ? '—' : v);

async function viewAdjustments() {
  const options = await api('/adjustment-options');
  let page = 1;
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>库存调整</h1><p class="muted">建立可审核的 Draft，并在确认后写入 Shopify Available 库存。</p></div>
      <div class="button-group"><button id="adjustments-export" class="secondary">导出 CSV</button><a class="button" href="#/adjustments/new">新建调整</a></div>
    </div>
    <div class="card">
      <div class="adjustment-filters">
        <input id="adjustment-q" type="search" placeholder="搜索编号、Barcode、SKU 或商品…">
        <select id="adjustment-status"><option value="">全部状态</option>
          <option value="draft">Draft</option><option value="applying">Submitting</option>
          <option value="applied">Applied</option><option value="archived">Archived</option>
        </select>
        <select id="adjustment-reason"><option value="">全部原因</option>${options.reasons.map((reason) => `<option value="${reason.id}">${esc(reason.name)}</option>`).join('')}</select>
        <select id="adjustment-staff"><option value="">全部员工</option>${options.staff.map((person) => `<option value="${person.id}">${esc(person.display_name)}</option>`).join('')}</select>
        <button id="adjustment-filter" class="secondary">应用</button>
      </div>
      <div id="adjustments-out">加载中…</div>
      <div id="adjustments-pagination" class="pagination"></div>
    </div>
    <details class="card system-details" id="adjustment-settings">
      <summary>Adjustment reasons 与员工名称</summary>
      <div class="settings-grid">
        <section>
          <div class="section-heading"><div><h2>Adjustment reasons</h2><p class="muted compact">停用后不会出现在新调整单中，历史记录仍保留。</p></div></div>
          <div class="reason-list">${options.reasons.map((reason) => `<div class="setting-row">
            <input type="text" value="${esc(reason.name)}" data-reason-name="${reason.id}">
            <select data-reason-direction="${reason.id}">
              <option value="any" ${reason.direction === 'any' ? 'selected' : ''}>Increase / decrease</option>
              <option value="in" ${reason.direction === 'in' ? 'selected' : ''}>Increase only</option>
              <option value="out" ${reason.direction === 'out' ? 'selected' : ''}>Decrease only</option>
            </select>
            <label><input type="checkbox" data-reason-active="${reason.id}" ${reason.active ? 'checked' : ''}> Active</label>
            <button class="secondary small-button save-reason" data-id="${reason.id}">保存</button>
            <button class="secondary small-button danger delete-reason" data-id="${reason.id}" data-name="${esc(reason.name)}" title="删除">删除</button>
          </div>`).join('')}</div>
          <div class="setting-row new-reason"><input id="new-reason-name" type="text" placeholder="New reason">
            <select id="new-reason-direction"><option value="any">Increase / decrease</option><option value="in">Increase only</option><option value="out">Decrease only</option></select>
            <button id="add-reason" class="secondary small-button">添加</button></div>
        </section>
        <section>
          <div class="section-heading"><div><h2>员工</h2><p class="muted compact">调整单里「记录员工 / 经手员工」可选的人。与 Shopify 账号无关——多名员工可共用一个账号。员工离职时取消 Active 即可停用：不再出现在新调整的选择菜单，历史记录照常显示。</p></div></div>
          <div class="staff-list">${options.staff.map((person) => `<div class="setting-row ${person.active ? '' : 'inactive-row'}">
            <input type="text" value="${esc(person.display_name)}" data-staff-name="${person.id}" aria-label="员工姓名">
            <label class="active-toggle"><input type="checkbox" data-staff-active="${person.id}" ${person.active ? 'checked' : ''}> Active</label>
            <button class="secondary small-button save-staff" data-id="${person.id}">保存</button>
            <button class="secondary small-button danger delete-staff" data-id="${person.id}" data-name="${esc(person.display_name)}">删除</button>
          </div>`).join('') || '<p class="muted">尚无员工，请在下方添加。</p>'}</div>
          <div class="setting-row new-staff">
            <input id="new-staff-name" type="text" placeholder="新员工姓名">
            <span></span><span></span>
            <button id="add-staff" class="secondary small-button">添加</button>
          </div>
          <div class="section-heading account-section"><div><h2>Shopify 登录账号</h2><p class="muted compact">系统自动识别账号 ID。Shopify 不向非 Plus 商店的 App 提供账号邮箱（需 Plus 专属的 read_users 权限），所以请在此手动改成邮箱等易读名称——只需改一次，之后所有记录都会显示这个名称。不参与员工选择，也不能删除。</p></div></div>
          <div class="staff-list">${(options.accounts || []).map((acct) => `<div class="setting-row">
            <input type="text" value="${esc(acct.display_name)}" data-staff-name="${acct.id}" aria-label="账号名称">
            <span class="muted small">ID ${esc(acct.shopify_user_id || '')}</span>
            <button class="secondary small-button save-staff" data-id="${acct.id}">保存</button>
            <span></span>
          </div>`).join('') || '<p class="muted">尚未识别到登录账号。</p>'}</div>
        </section>
      </div>
    </details>`;

  const query = () => new URLSearchParams({
    q: $('#adjustment-q').value,
    status: $('#adjustment-status').value,
    reasonId: $('#adjustment-reason').value,
    staffId: $('#adjustment-staff').value,
  });
  const load = async () => {
    $w('#adjustments-out').innerHTML = '加载中…';
    const params = query();
    params.set('page', page);
    params.set('limit', '25');
    const result = await api(`/adjustments?${params}`);
    $w('#adjustments-out').innerHTML = `<div class="table-scroll"><table class="adjustments-table">
      <thead><tr><th>调整单</th><th>备注 / 原因</th><th>操作人</th><th>仓位</th><th class="num">商品</th><th class="num">合计</th><th>日期</th><th>状态</th><th></th></tr></thead>
      <tbody>${result.rows.map((row) => `<tr>
        <td class="col-no"><a class="item-link" href="#/adjustments/${row.id}">${shortAdjustmentNumber(row.number, row.display_number)}</a>${stockyTag(row.display_number)}</td>
        <td class="col-note">${row.notes ? `<div class="note-main">${esc(row.notes)}</div>` : '<div class="note-main muted">（无备注）</div>'}<div class="muted xsmall">${esc(row.reason || '—')}</div>${row.apply_error ? `<div class="error xsmall">${esc(row.apply_error)}</div>` : ''}</td>
        <td class="col-person">${esc(row.recorded_by_name || '—')}${row.handled_by_names ? `<div class="muted xsmall">经手：${esc(row.handled_by_names)}</div>` : ''}</td>
        <td class="col-loc">${esc(row.locations || '—')}</td>
        <td class="num col-qty">${row.line_count}</td><td class="num col-qty"><span class="${Number(row.total_delta) > 0 ? 'pos' : Number(row.total_delta) < 0 ? 'neg' : ''}">${signed(row.total_delta)}</span></td>
        <td class="col-date">${fmtDateCompact(row.applied_at || row.created_at)}</td>
        <td class="col-status">${adjustmentStatus(row.status)}</td><td class="col-arrow"><a class="row-arrow" href="#/adjustments/${row.id}" aria-label="查看">→</a></td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">暂无库存调整</td></tr>'}</tbody></table></div>`;
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    $w('#adjustments-pagination').innerHTML = result.total > result.pageSize ? `
      <button id="adjustments-prev" class="secondary" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${page} / ${pages} 页 · 共 ${result.total} 张</span>
      <button id="adjustments-next" class="secondary" ${page >= pages ? 'disabled' : ''}>下一页</button>` : `<span class="muted">共 ${result.total} 张</span>`;
    if ($('#adjustments-prev')) $('#adjustments-prev').onclick = () => { page--; load(); };
    if ($('#adjustments-next')) $('#adjustments-next').onclick = () => { page++; load(); };
  };
  const filter = () => { page = 1; load(); };
  $('#adjustment-filter').onclick = filter;
  $('#adjustment-status').onchange = filter;
  $('#adjustment-reason').onchange = filter;
  $('#adjustment-staff').onchange = filter;
  $('#adjustment-q').addEventListener('keydown', (event) => { if (event.key === 'Enter') filter(); });
  $('#adjustments-export').onclick = async (event) => {
    event.target.disabled = true;
    try { await apiDownload(`/adjustments.csv?${query()}`, `inventory-adjustments-${new Date().toISOString().slice(0, 10)}.csv`); }
    catch (error) { alert(`导出失败：${error.message}`); }
    finally { event.target.disabled = false; }
  };
  document.querySelectorAll('.save-reason').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/adjustment-reasons/${button.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: $(`[data-reason-name="${button.dataset.id}"]`).value,
            direction: $(`[data-reason-direction="${button.dataset.id}"]`).value,
            active: $(`[data-reason-active="${button.dataset.id}"]`).checked,
          }),
        });
        await viewAdjustments();
        $('#adjustment-settings').open = true;
      } catch (error) { alert(`保存失败：${error.message}`); button.disabled = false; }
    };
  });
  // Delete reason / staff. The API deactivates instead of deleting when the
  // record is referenced by history, and tells us which happened.
  const wireDelete = (selector, path, label) => {
    document.querySelectorAll(selector).forEach((button) => {
      button.onclick = async () => {
        if (!confirm(`删除${label}「${button.dataset.name}」？\n若历史记录已使用过它，会自动改为停用以保留历史。`)) return;
        button.disabled = true;
        try {
          const r = await api(`${path}/${button.dataset.id}`, { method: 'DELETE' });
          if (r.deactivated) alert(`「${button.dataset.name}」已被 ${r.usedBy} 条历史记录使用，无法删除，已改为停用（不再出现在新调整中）。`);
          await viewAdjustments();
          $('#adjustment-settings').open = true;
        } catch (error) { alert(`删除失败：${error.message}`); button.disabled = false; }
      };
    });
  };
  wireDelete('.delete-reason', '/adjustment-reasons', '原因');
  wireDelete('.delete-staff', '/staff', '员工');
  document.querySelectorAll('.save-staff').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/staff/${button.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            displayName: $(`[data-staff-name="${button.dataset.id}"]`).value,
            ...($(`[data-staff-active="${button.dataset.id}"]`)
              ? { active: $(`[data-staff-active="${button.dataset.id}"]`).checked }
              : {}),
          }),
        });
        await viewAdjustments();
        $('#adjustment-settings').open = true;
      } catch (error) { alert(`保存失败：${error.message}`); button.disabled = false; }
    };
  });
  $('#add-reason').onclick = async (event) => {
    event.target.disabled = true;
    try {
      await api('/adjustment-reasons', {
        method: 'POST',
        body: JSON.stringify({ name: $('#new-reason-name').value, direction: $('#new-reason-direction').value }),
      });
      await viewAdjustments();
      $('#adjustment-settings').open = true;
    } catch (error) { alert(`添加失败：${error.message}`); event.target.disabled = false; }
  };
  $('#add-staff').onclick = async (event) => {
    event.target.disabled = true;
    try {
      await api('/staff', {
        method: 'POST',
        body: JSON.stringify({
          displayName: $('#new-staff-name').value,
        }),
      });
      await viewAdjustments();
      $('#adjustment-settings').open = true;
    } catch (error) { alert(`添加失败：${error.message}`); event.target.disabled = false; }
  };
  await load();
}

async function viewAdjustmentForm(id = null) {
  app.innerHTML = '<div class="card">加载中…</div>';
  const [options, detail] = await Promise.all([
    api('/adjustment-options'),
    id ? api(`/adjustments/${id}`) : Promise.resolve(null),
  ]);
  const adjustment = detail?.adjustment;
  if (adjustment && adjustment.status !== 'draft') {
    location.hash = `#/adjustments/${id}`;
    return;
  }
  let lines = (adjustment?.lines || []).map((line) => ({
    itemId: line.item_id,
    product_title: line.product_title,
    variant_title: line.variant_title,
    barcode: line.barcode,
    sku: line.sku,
    vendor: line.vendor,
    available: Number(line.current_available ?? line.qty_before),
    delta: Number(line.delta),
  }));
  let pendingFiles = [];
  let handledBy = (adjustment?.handled_by || []).map((person) => ({
    staffId: person.staff_id || null,
    name: person.name,
  }));
  // Recorded by is never auto-detected: one Shopify account is shared by
  // several employees, so the actual person must be chosen by hand.
  const recordedStaffId = adjustment?.recorded_by?.staff_id || null;
  const recordedIsCustom = Boolean(adjustment?.recorded_by && !adjustment.recorded_by.staff_id);
  app.innerHTML = `
    <div class="page-heading"><div><h1>${id ? `编辑 ${adjustmentNumber(adjustment.number, adjustment.display_number)}` : '新建库存调整'}</h1>
      <p class="muted">先保存 Draft；保存不会改变 Shopify 库存。</p></div><a class="back-link" href="${id ? `#/adjustments/${id}` : '#/adjustments'}">← 返回</a></div>
    <div class="card adjustment-form">
      <div class="form-grid adjustment-basics">
        <label><span>Location</span><select id="draft-location">${options.locations.map((location) => `<option value="${location.id}" ${Number(adjustment?.lines?.[0]?.location_id) === location.id ? 'selected' : ''}>${esc(location.name)}</option>`).join('')}</select></label>
        <label><span>Adjustment reason</span><select id="draft-reason">${options.reasons.filter((reason) => reason.active || reason.id === adjustment?.reason_id).map((reason) => `<option value="${reason.id}" data-direction="${reason.direction}" ${reason.id === adjustment?.reason_id ? 'selected' : ''}>${esc(reason.name)}</option>`).join('')}</select></label>
        <div class="adjustment-people">
          <label><span>Shopify 登录账号（自动识别）</span>
            <input type="text" readonly value="${esc(options.currentStaff?.display_name || '无法识别')}" title="Shopify user id: ${esc(options.currentStaff?.shopify_user_id || '')}">
            <span class="muted small">多名员工可能共用此账号，因此下面的经办人需手动选择。</span>
          </label>
          <label><span>Recorded by（实际做记录的员工）</span>
            <select id="draft-recorded">
              <option value="" ${!recordedIsCustom && !recordedStaffId ? 'selected' : ''}>请选择员工…</option>
              ${options.staff.filter((person) => person.active).map((person) => `<option value="staff:${person.id}" ${!recordedIsCustom && Number(recordedStaffId) === person.id ? 'selected' : ''}>${esc(person.display_name)}</option>`).join('')}
              <option value="custom" ${recordedIsCustom ? 'selected' : ''}>手动填写姓名…</option>
            </select>
            <input id="draft-recorded-custom" type="text" maxlength="120" value="${recordedIsCustom ? esc(adjustment.recorded_by.name) : ''}" placeholder="记录员工姓名" ${recordedIsCustom ? '' : 'hidden'}>
          </label>
          <div>
            <label><span>Handled by（拿取/处理商品的人，可多人）</span></label>
            <div class="participant-picker">
              <select id="draft-handled">
                ${options.staff.filter((person) => person.active).map((person) => `<option value="staff:${person.id}">${esc(person.display_name)}${person.employee_code ? ` · ${esc(person.employee_code)}` : ''}</option>`).join('')}
                <option value="custom">手动填写姓名…</option>
              </select>
              <button id="add-handled" type="button" class="secondary small-button">添加</button>
            </div>
            <input id="draft-handled-custom" type="text" maxlength="120" placeholder="经手员工姓名" hidden>
            <div id="handled-chips"></div>
          </div>
        </div>
        <label class="notes-field"><span>Notes</span><textarea id="draft-notes" maxlength="10000" rows="4" placeholder="详细填写调整原因、票据编号、处理过程或内部说明">${esc(adjustment?.notes || '')}</textarea></label>
        <div class="evidence-field">
          <span>Evidence attachments</span>
          <div class="evidence-picker"><input id="draft-attachments" type="file" multiple accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"><label for="draft-attachments" class="button secondary">添加图片、视频或文件</label></div>
          <p class="muted small">每个文件最大 50 MB，每张调整单最多 20 个；保存 Draft 后上传，不会写入 Shopify。</p>
          <div id="pending-attachments"></div>
          ${id ? `<div id="existing-attachments">${attachmentListHtml(adjustment.attachments, true)}</div>` : ''}
        </div>
      </div>
      <div class="section-heading"><div><h2>调整明细</h2><p class="muted compact">选择 − 或 +，再输入变化数量；After 会根据当前 Available 自动计算。</p></div></div>
      <div id="draft-lines"></div>
      <div class="item-picker">
        <div><h2>添加商品</h2><p class="muted compact">扫描条码，或输入 Barcode / SKU / 标题 / Brand（可用空格分词，如「dzofilm arles 100mm」）。勾选后可一次加入多个变体。</p></div>
        <div class="picker-search"><input id="draft-item-search" type="search" placeholder="扫描或输入 Barcode / SKU / 商品"><button id="draft-item-find" class="secondary">搜索</button></div>
      </div>
      <div id="draft-search-results"></div>
      <div class="form-actions"><a class="button secondary" href="${id ? `#/adjustments/${id}` : '#/adjustments'}">取消</a><button id="save-draft">保存 Draft</button></div>
    </div>`;

  const renderHandled = () => {
    $w('#handled-chips').innerHTML = handledBy.length
      ? `<div class="participant-chips">${handledBy.map((person, index) => `<span class="participant-chip">${esc(person.name)}<button type="button" data-remove-handled="${index}" aria-label="移除">×</button></span>`).join('')}</div>`
      : '<div class="muted small">尚未添加经手员工。</div>';
    document.querySelectorAll('[data-remove-handled]').forEach((button) => {
      button.onclick = () => {
        handledBy.splice(Number(button.dataset.removeHandled), 1);
        renderHandled();
      };
    });
  };
  const toggleRecordedCustom = () => {
    $('#draft-recorded-custom').hidden = $('#draft-recorded').value !== 'custom';
  };
  const toggleHandledCustom = () => {
    $('#draft-handled-custom').hidden = $('#draft-handled').value !== 'custom';
  };
  $('#draft-recorded').onchange = toggleRecordedCustom;
  $('#draft-handled').onchange = toggleHandledCustom;
  $('#add-handled').onclick = () => {
    const selected = $('#draft-handled').value;
    let person;
    if (selected === 'custom') {
      const name = $('#draft-handled-custom').value.trim();
      if (!name) return alert('请填写经手员工姓名');
      person = { staffId: null, name };
    } else {
      const staffId = Number(selected.replace('staff:', ''));
      const staff = options.staff.find((entry) => entry.id === staffId);
      person = { staffId, name: staff?.display_name || '' };
    }
    const duplicate = handledBy.some((entry) => person.staffId
      ? Number(entry.staffId) === person.staffId
      : !entry.staffId && entry.name.toLocaleLowerCase() === person.name.toLocaleLowerCase());
    if (duplicate) return alert('该经手员工已添加');
    handledBy.push(person);
    $('#draft-handled-custom').value = '';
    renderHandled();
  };

  const selectedDirection = () => $('#draft-reason').selectedOptions[0]?.dataset.direction || 'any';
  const normalizeLineDirection = (line) => {
    const magnitude = Math.max(1, Math.abs(Number(line.delta) || 1));
    if (selectedDirection() === 'out') line.delta = -magnitude;
    else if (selectedDirection() === 'in') line.delta = magnitude;
    else line.delta = Number(line.delta) < 0 ? -magnitude : magnitude;
  };
  const renderPendingFiles = () => {
    $w('#pending-attachments').innerHTML = pendingFiles.length
      ? `<div class="pending-files">${pendingFiles.map((file, index) => `<span>${esc(file.name)} · ${formatBytes(file.size)} <button class="pending-file-remove" data-pending-remove="${index}" aria-label="移除附件">×</button></span>`).join('')}</div>`
      : '';
    document.querySelectorAll('[data-pending-remove]').forEach((button) => {
      button.onclick = () => { pendingFiles.splice(Number(button.dataset.pendingRemove), 1); renderPendingFiles(); };
    });
  };
  const renderLines = () => {
    lines.forEach(normalizeLineDirection);
    const direction = selectedDirection();
    $w('#draft-lines').innerHTML = lines.length ? `<div class="table-scroll"><table class="adjustment-lines">
      <thead><tr><th>商品</th><th class="num">Before</th><th class="num">Change (+ / −)</th><th class="num">After</th><th></th></tr></thead>
      <tbody>${lines.map((line, index) => `<tr>
        <td><span class="event-product-title">${productName(line)}</span>${codeMeta(line)}</td>
        <td class="num">${line.available}</td>
        <td class="num"><div class="delta-control">
          <button type="button" class="delta-sign ${line.delta < 0 ? 'active minus' : ''}" data-sign="-1" data-index="${index}" ${direction === 'in' ? 'disabled' : ''} aria-label="减少库存">−</button>
          <input class="delta-input" type="number" min="1" step="1" value="${Math.abs(line.delta)}" data-magnitude="${index}" aria-label="变化数量">
          <button type="button" class="delta-sign ${line.delta > 0 ? 'active plus' : ''}" data-sign="1" data-index="${index}" ${direction === 'out' ? 'disabled' : ''} aria-label="增加库存">+</button>
        </div></td>
        <td class="num"><strong class="${line.delta > 0 ? 'pos' : line.delta < 0 ? 'neg' : ''}">${line.available + Number(line.delta || 0)}</strong></td>
        <td><button class="secondary small-button remove-adjustment-line" data-index="${index}">移除</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">尚未添加商品。</div>';
    document.querySelectorAll('[data-sign]').forEach((button) => {
      button.onclick = () => {
        const line = lines[Number(button.dataset.index)];
        line.delta = Number(button.dataset.sign) * Math.max(1, Math.abs(Number(line.delta) || 1));
        renderLines();
      };
    });
    document.querySelectorAll('[data-magnitude]').forEach((input) => {
      input.oninput = () => {
        const line = lines[Number(input.dataset.magnitude)];
        const sign = Number(line.delta) < 0 ? -1 : 1;
        const magnitude = Math.max(0, Math.abs(Math.trunc(Number(input.value) || 0)));
        line.delta = sign * magnitude;
        const after = input.closest('tr').querySelector('td:nth-child(4) strong');
        after.textContent = String(line.available + line.delta);
        after.className = line.delta > 0 ? 'pos' : line.delta < 0 ? 'neg' : '';
      };
      input.onblur = () => { if (!Number(input.value) || Number(input.value) < 1) renderLines(); };
    });
    document.querySelectorAll('.remove-adjustment-line').forEach((button) => {
      button.onclick = () => { lines.splice(Number(button.dataset.index), 1); renderLines(); };
    });
  };
  // Shopify-style picker: variant-level rows with checkboxes so several products
  // can be added in one go. A single exact barcode/SKU hit (i.e. a scan) is
  // added immediately so scanning stays one motion.
  const addRows = (rows) => {
    const reason = $('#draft-reason').selectedOptions[0];
    const delta = reason?.dataset.direction === 'out' ? -1 : 1;
    let added = 0;
    for (const row of rows) {
      if (lines.some((line) => line.itemId === row.id)) continue;
      lines.push({ itemId: row.id, ...row, available: Number(row.available), delta });
      added++;
    }
    $w('#draft-search-results').innerHTML = '';
    $('#draft-item-search').value = '';
    $('#draft-item-search').focus();
    renderLines();
    return added;
  };
  const findItems = async () => {
    const term = $('#draft-item-search').value.trim();
    if (!term) return;
    $w('#draft-search-results').innerHTML = '<p class="muted">搜索中…</p>';
    try {
      const result = await api(`/adjustment-items?locationId=${encodeURIComponent($('#draft-location').value)}&q=${encodeURIComponent(term)}`);
      $w('#draft-search-results').innerHTML = '';
      if (!result.rows.length) {
        $w('#draft-search-results').innerHTML = '<p class="muted">该仓位没有匹配且可调整的商品。</p>';
        return;
      }
      // Barcode/SKU scan → add straight away, no dialog.
      const exact = result.rows.filter((r) => r.barcode === term || r.sku === term);
      if (exact.length === 1 && !lines.some((l) => l.itemId === exact[0].id)) {
        addRows(exact);
        return;
      }
      openPicker(result.rows, term);
    } catch (error) { $w('#draft-search-results').innerHTML = `<p class="error">${esc(error.message)}</p>`; }
  };

  // Modal picker so results never push the page around. Items already in the
  // draft show up pre-checked and disabled — no alert needed.
  const openPicker = (rows, term) => {
    const inDraft = (id) => lines.some((l) => l.itemId === id);
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop';
    dialog.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="选择商品">
        <div class="modal-head">
          <strong>选择商品</strong>
          <span class="muted small">「${esc(term)}」共 ${rows.length} 个变体</span>
          <button class="icon-button" id="picker-close" aria-label="关闭">×</button>
        </div>
        <div class="modal-toolbar">
          <label><input type="checkbox" id="picker-all"> 全选</label>
          <span class="muted small" id="picker-count"></span>
        </div>
        <div class="modal-body">${rows.map((row) => `
          <label class="picker-row ${inDraft(row.id) ? 'already' : ''}">
            <input type="checkbox" class="picker-check" value="${row.id}" ${inDraft(row.id) ? 'checked disabled' : ''}>
            <span class="picker-main"><strong>${esc(row.product_title)}</strong>${variantLabel(row) ? ` <span class="variant-tag">${variantLabel(row)}</span>` : ''}<span class="picker-codes">${esc(row.barcode || '—')}${row.sku ? ` · ${esc(row.sku)}` : ''}${row.vendor ? ` · ${esc(row.vendor)}` : ''}</span></span>
            <span class="picker-avail">${inDraft(row.id) ? '已加入' : `Available <strong>${row.available}</strong>`}</span>
          </label>`).join('')}</div>
        <div class="modal-foot">
          <button class="secondary" id="picker-cancel">取消</button>
          <button id="picker-add" disabled>加入所选</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    const close = () => dialog.remove();
    const checks = [...dialog.querySelectorAll('.picker-check:not([disabled])')];
    const refresh = () => {
      const n = checks.filter((c) => c.checked).length;
      dialog.querySelector('#picker-add').disabled = !n;
      dialog.querySelector('#picker-add').textContent = n ? `加入所选（${n}）` : '加入所选';
      dialog.querySelector('#picker-count').textContent = `已选 ${n} / 可选 ${checks.length}`;
    };
    checks.forEach((c) => { c.onchange = refresh; });
    dialog.querySelector('#picker-all').onchange = (e) => {
      checks.forEach((c) => { c.checked = e.target.checked; });
      refresh();
    };
    dialog.querySelector('#picker-close').onclick = close;
    dialog.querySelector('#picker-cancel').onclick = close;
    dialog.onclick = (e) => { if (e.target === dialog) close(); };
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    dialog.querySelector('#picker-add').onclick = () => {
      const ids = checks.filter((c) => c.checked).map((c) => Number(c.value));
      addRows(rows.filter((r) => ids.includes(r.id)));
      close();
    };
    refresh();
  };
  $('#draft-item-find').onclick = findItems;
  $('#draft-item-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') findItems(); });
  $('#draft-reason').onchange = () => {
    lines.forEach(normalizeLineDirection);
    renderLines();
  };
  $('#draft-attachments').onchange = (event) => {
    const selected = [...event.target.files];
    const tooLarge = selected.find((file) => file.size > 50 * 1024 * 1024);
    if (tooLarge) alert(`${tooLarge.name} 超过 50 MB，未添加。`);
    const room = 20 - Number(adjustment?.attachments?.length || 0) - pendingFiles.length;
    pendingFiles.push(...selected.filter((file) => file.size > 0 && file.size <= 50 * 1024 * 1024).slice(0, Math.max(0, room)));
    if (selected.length > room) alert('每张调整单最多保存 20 个附件。');
    event.target.value = '';
    renderPendingFiles();
  };
  if (id) {
    await wireAttachmentActions(id, adjustment.attachments);
    document.querySelectorAll('[data-attachment-delete]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm('从这个 Draft 中移除该附件？')) return;
        button.disabled = true;
        try {
          await api(`/adjustments/${id}/attachments/${button.dataset.attachmentDelete}`, { method: 'DELETE' });
          await viewAdjustmentForm(id);
        } catch (error) { alert(`移除失败：${error.message}`); button.disabled = false; }
      };
    });
  }
  $('#draft-location').onchange = () => {
    if (!lines.length || confirm('更改仓位会清空当前调整明细，是否继续？')) {
      lines = [];
      $w('#draft-search-results').innerHTML = '';
      renderLines();
    } else {
      $('#draft-location').value = String(adjustment?.lines?.[0]?.location_id || options.locations[0]?.id || '');
    }
  };
  $('#save-draft').onclick = async (event) => {
    const recordedValue = $('#draft-recorded').value;
    if (!recordedValue) {
      alert('请选择「Recorded by」实际做记录的员工。');
      return;
    }
    if (recordedValue === 'custom' && !$('#draft-recorded-custom').value.trim()) {
      alert('请填写记录员工姓名。');
      return;
    }
    event.target.disabled = true;
    try {
      const body = {
        locationId: Number($('#draft-location').value),
        reasonId: Number($('#draft-reason').value),
        notes: $('#draft-notes').value,
        recordedBy: $('#draft-recorded').value === 'custom'
          ? { name: $('#draft-recorded-custom').value.trim() }
          : { staffId: Number($('#draft-recorded').value.replace('staff:', '')) },
        handledBy,
        lines: lines.map((line) => ({ itemId: line.itemId, delta: Number(line.delta) })),
      };
      const result = await api(id ? `/adjustments/${id}` : '/adjustments', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      const uploadErrors = [];
      for (const file of pendingFiles) {
        try { await apiUploadAttachment(result.id, file); }
        catch (error) { uploadErrors.push(`${file.name}: ${error.message}`); }
      }
      if (uploadErrors.length) {
        alert(`Draft 已保存，但以下附件上传失败：\n${uploadErrors.join('\n')}`);
        await viewAdjustmentForm(result.id);
        return;
      }
      location.hash = `#/adjustments/${result.id}`;
    } catch (error) { alert(`保存失败：${error.message}`); event.target.disabled = false; }
  };
  toggleRecordedCustom();
  toggleHandledCustom();
  renderHandled();
  renderPendingFiles();
  renderLines();
}

async function viewAdjustment(id) {
  app.innerHTML = '<div class="card">加载中…</div>';
  const { adjustment } = await api(`/adjustments/${id}`);
  const total = adjustment.lines.reduce((sum, line) => sum + Number(line.delta), 0);
  const canApply = adjustment.status === 'draft' || adjustment.status === 'applying';
  app.innerHTML = `
    <div class="page-heading"><div><h1>${adjustmentNumber(adjustment.number, adjustment.display_number)} ${stockyTag(adjustment.display_number)} ${adjustmentStatus(adjustment.status)}</h1></div>
      <div class="button-group"><a class="back-link" href="#/adjustments">← 返回列表</a>
        ${adjustment.status === 'draft' ? `<a class="button secondary" href="#/adjustments/${id}/edit">编辑 Draft</a>` : ''}
        ${canApply ? `<button id="apply-adjustment">${adjustment.status === 'applying' ? '安全重试提交' : '提交到 Shopify'}</button>` : ''}
        ${['draft', 'applied'].includes(adjustment.status) ? '<button id="archive-adjustment" class="secondary">归档</button>' : ''}
      </div></div>
    ${adjustment.apply_error ? `<div class="notice adjustment-error"><strong>上次提交信息：</strong>${esc(adjustment.apply_error)}</div>` : ''}
    ${adjustment.notes ? `<div class="card adjustment-notes-card"><span class="field-label">调整备注 Notes</span><p class="notes-body">${esc(adjustment.notes)}</p></div>` : ''}
    <div class="card event-overview adjustment-overview">
      <div><span>调整原因 Reason</span><strong>${esc(adjustment.reason || '—')}</strong></div>
      <div><span>记录员工 Recorded by</span><strong>${esc(adjustment.recorded_by?.name || '—')}</strong></div>
      <div><span>经手员工 Handled by</span><strong>${esc(adjustment.handled_by?.map((person) => person.name).join(', ') || '—')}</strong></div>
      <div><span>仓位 Location</span><strong>${esc([...new Set(adjustment.lines.map((l) => l.location))].join(', ') || '—')}</strong></div>
      <div><span>合计变化 Total change</span><strong class="${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}">${signed(total)}</strong></div>
      <div><span>${adjustment.applied_at ? '完成时间 Applied' : '创建时间 Created'}</span><strong>${fmtDate(adjustment.applied_at || adjustment.created_at)}</strong></div>
      <div><span>Shopify 登录账号</span><strong>${esc(adjustment.created_by_account_name || adjustment.login_account_name || '—')}</strong></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>调整明细</h2><p class="muted compact">共 ${adjustment.lines.length} 个商品/仓位；数量均为 Available。${stockyOriginalNo(adjustment.display_number) ? 'Stocky 导出不含调整前/后数量，故 Before/After 显示为 —。' : ''}</p></div></div>
      <div class="table-scroll"><table class="adjustment-lines">
        <thead><tr><th>商品</th><th>规格</th><th>Barcode / SKU</th><th class="num">Before</th><th class="num">Change</th><th class="num">After</th></tr></thead>
        <tbody>${adjustment.lines.length ? adjustment.lines.map((line) => `<tr>
          <td><a class="item-link" href="#/items/${line.item_id}">${esc(line.product_title || '(无标题)')}</a>${line.source === 'local' ? ' <span class="badge">已删除</span>' : ''}</td>
          <td>${variantLabel(line) || '<span class="muted">—</span>'}</td>
          <td><strong>${esc(line.barcode || '—')}</strong>${line.sku ? `<div class="muted small">${esc(line.sku)}</div>` : ''}</td>
          <td class="num">${numOrDash(line.qty_before)}</td><td class="num"><strong class="${line.delta > 0 ? 'pos' : 'neg'}">${signed(line.delta)}</strong></td>
          <td class="num"><strong>${numOrDash(line.qty_after)}</strong>${adjustment.status === 'draft' && line.qty_before !== null && Number(line.current_available) !== Number(line.qty_before) ? `<div class="warning small">当前 ${line.current_available}，提交时会重新校验</div>` : ''}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted">此调整单没有商品明细（导入时商品无法识别）</td></tr>'}</tbody>
      </table></div>
      <div class="adjustment-evidence">
        <strong>Evidence attachments</strong>
        ${attachmentListHtml(adjustment.attachments)}
      </div>
    </div>
    ${canApply ? '<div class="notice"><strong>提交前确认：</strong>这一步会真实改变 Shopify Available 库存。系统会先核对最新数量；如库存已被其他订单、员工或 App 修改，提交会停止并要求重新确认。</div>' : ''}`;
  await wireAttachmentActions(id, adjustment.attachments);
  if ($('#apply-adjustment')) $('#apply-adjustment').onclick = async (event) => {
    const message = adjustment.status === 'applying'
      ? '将使用同一个幂等键安全重试，不会重复调整。是否继续？'
      : `即将把 ${adjustment.lines.length} 个商品的 Available 库存合计调整 ${signed(total)}。这会真实写入 Shopify，是否确认？`;
    if (!confirm(message)) return;
    event.target.disabled = true;
    event.target.textContent = '提交中…';
    try {
      await api(`/adjustments/${id}/apply`, { method: 'POST' });
      await viewAdjustment(id);
    } catch (error) {
      alert(`提交失败：${error.message}`);
      await viewAdjustment(id);
    }
  };
  if ($('#archive-adjustment')) $('#archive-adjustment').onclick = async (event) => {
    if (!confirm('归档后调整单将锁定，不能再次编辑或提交，是否继续？')) return;
    event.target.disabled = true;
    try {
      await api(`/adjustments/${id}/archive`, { method: 'POST' });
      await viewAdjustment(id);
    } catch (error) { alert(`归档失败：${error.message}`); event.target.disabled = false; }
  };
}

async function viewSearch(query) {
  const term = String(query || '').trim();
  if (!term) {
    app.innerHTML = '<div class="card"><p class="muted">请输入商品、Barcode、SKU、人员、订单、调拨或调整编号。</p></div>';
    return;
  }
  app.innerHTML = '<div class="card">搜索中…</div>';
  const result = await api(`/search?q=${encodeURIComponent(term)}`);
  $('#global-search-input').value = term;
  const section = (title, rows, render) => `<section class="card search-section">
    <h2>${title}</h2><div class="muted result-count">${rows.length ? `${rows.length} 个结果` : '没有匹配结果'}</div>
    ${rows.length ? `<div class="search-result-list">${rows.map(render).join('')}</div>` : ''}
  </section>`;
  app.innerHTML = `
    <div class="page-heading"><div><h1>搜索结果</h1><p class="muted">“${esc(term)}” 的商品、人员与操作记录。</p></div></div>
    ${section('商品', result.products, (row) => `<a class="search-result-row" href="#/items/${row.id}">
      <div><span class="event-product-title">${productName(row)}</span>${codeMeta(row)}</div>
      <div>Available <strong>${row.available}</strong></div><span class="arrow">→</span>
    </a>`)}
    ${section('库存调整', result.adjustments, (row) => `<a class="search-result-row" href="#/adjustments/${row.id}">
      <div><strong>${esc(adjustmentNumber(row.number, row.display_number))}</strong><div class="muted small">${esc(row.reason || '—')}</div></div>
      <div>${esc(row.recorded_by_name || row.login_account_name || '—')} · ${fmtDate(row.created_at)}</div><span class="arrow">→</span>
    </a>`)}
    ${section('修改记录', result.history, (row) => `<a class="search-result-row" href="#/history/${row.id}">
      <div><strong>${esc(activityLabel(row.activity))}</strong><div class="muted small">${row.product_count === 1 ? productName(row) : `${row.product_count} 个商品变体`}</div></div>
      <div>${referenceCell(row, result.shopHandle)}<div class="muted small">${fmtDate(row.occurred_at)}</div></div><span class="arrow">→</span>
    </a>`)}
    ${section('人员', result.people, (row) => `<div class="search-result-row">
      <div><strong>${esc(row.display_name)}</strong><div class="muted small">${esc(row.employee_code || '无员工编号')}</div></div>
      <div class="muted">${row.shopify_user_id ? `Shopify account ${esc(row.shopify_user_id)}` : '本地员工资料'}</div><span></span>
    </div>`)}`;
}

// ---- router ----
async function route() {
  navGeneration++;
  clearMediaObjectUrls();
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.nav}`)));
  try {
    const m = hash.match(/^#\/items\/(\d+)/);
    if (m) return await viewItem(m[1]);
    const historyEvent = hash.match(/^#\/history\/(\d+)/);
    if (historyEvent) return await viewHistoryEvent(historyEvent[1]);
    const adjustmentEdit = hash.match(/^#\/adjustments\/(\d+)\/edit$/);
    if (adjustmentEdit) return await viewAdjustmentForm(adjustmentEdit[1]);
    const adjustment = hash.match(/^#\/adjustments\/(\d+)$/);
    if (adjustment) return await viewAdjustment(adjustment[1]);
    if (hash === '#/adjustments/new') return await viewAdjustmentForm();
    if (hash.startsWith('#/search')) {
      const query = new URLSearchParams(hash.split('?')[1] || '').get('q') || '';
      return await viewSearch(query);
    }
    if (hash.startsWith('#/local-items')) return await viewLocalItems();
    if (hash.startsWith('#/items')) return await viewItems();
    if (hash.startsWith('#/history')) return await viewHistory();
    if (hash.startsWith('#/adjustments')) return await viewAdjustments();
    if (hash.startsWith('#/system')) return await viewSystem();
    return await viewDashboard();
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
  }
}
$('#global-search').onsubmit = (event) => {
  event.preventDefault();
  const query = $('#global-search-input').value.trim();
  if (query) location.hash = `#/search?q=${encodeURIComponent(query)}`;
};
window.addEventListener('hashchange', route);
route();
