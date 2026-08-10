// Embedded SPA: business-facing inventory audit with technical health tucked
// behind an explicit system-status section.
// App Bridge (CDN) provides window.shopify.idToken() for session tokens.

const { t, lang: appLang } = window.I18N;
const dateLocale = appLang === 'zh' ? 'zh-CN' : 'en-GB';
const listSep = appLang === 'zh' ? '、' : ', ';

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
let navigationController = null;

const routeParams = () => new URLSearchParams(location.search);
const pageNumber = (value) => {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 1;
};
const routeUrl = (pathname, values = {}) => {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([name, value]) => {
    if (value !== '' && value !== null && value !== undefined && value !== false) {
      params.set(name, String(value));
    }
  });
  const search = params.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
};
const parentRoute = (pathname = location.pathname) => {
  const path = pathname.replace(/\/$/, '') || '/dashboard';
  const edit = path.match(/^\/adjustments\/(\d+)\/edit$/);
  if (edit) return `/adjustments/${edit[1]}`;
  if (/^\/items\/\d+$/.test(path)) return '/items';
  if (/^\/history\/\d+$/.test(path)) return '/history';
  if (/^\/adjustments\/\d+$/.test(path) || path === '/adjustments/new') return '/adjustments';
  if (path === '/virtual-stock' || path === '/lark-settings') return '/adjustments';
  if (path === '/local-items') return '/items';
  if (['/items', '/history', '/adjustments', '/search', '/system'].includes(path)) return '/dashboard';
  return null;
};
const syncNavigationControls = () => {
  const back = $('#app-back');
  if (back) back.disabled = !(navigationController?.canGoBack() || parentRoute());
};
const navigateTo = (url, { replace = false, render = true } = {}) => {
  navigationController.navigate(url, { replace });
  syncNavigationControls();
  if (render) route();
};

const sessionClient = window.InventorySessionClient.create({
  getToken: async () => {
    try { return await window.shopify.idToken(); }
    catch { throw new Error(t('请从 Shopify 后台打开本应用（App Bridge 未初始化）')); }
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
    if (res.status === 401) throw new Error(t('Shopify 登录会话暂时无法自动恢复，请稍后再试。'));
    throw new Error(t(j.error || `HTTP ${res.status}`));
  }
  return j;
}

async function apiDownload(path, filename) {
  const res = await authenticatedFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(t(res.status === 401 ? 'Shopify 登录会话暂时无法自动恢复，请稍后再试。' : body.error || `HTTP ${res.status}`));
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
    throw new Error(t(res.status === 401 ? 'Shopify 登录会话暂时无法自动恢复，请稍后再试。' : body.error || `HTTP ${res.status}`));
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
    throw new Error(t(res.status === 401 ? 'Shopify 登录会话暂时无法自动恢复，请稍后再试。' : body.error || `HTTP ${res.status}`));
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
      ${editable ? `<button class="secondary small-button attachment-delete" data-attachment-delete="${attachment.id}">${t('移除')}</button>` : ''}
    </div>`;
  }).join('')}</div>`
  : `<p class="muted compact">${t('暂无附件。')}</p>`;

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
      } catch (error) { alert(t('下载失败：{msg}', { msg: error.message })); }
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
    } catch { host.innerHTML = `<span class="muted small">${t('预览不可用')}</span>`; }
  }));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleString(dateLocale, { hour12: false }) : '—';
// Compact list format: date on the first line, time small underneath, so the
// column never wraps mid-number.
const fmtDateCompact = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  const date = appLang === 'zh'
    ? `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`
    : dt.toLocaleDateString(dateLocale);
  const time = dt.toLocaleTimeString(dateLocale, { hour12: false, hour: '2-digit', minute: '2-digit' });
  return `${date}<div class="muted xsmall">${time}</div>`;
};
const STATUS_HELP = {
  completion: t('修改记录只显示 Shopify 官方流水中的正式记录（含操作人/App/原因/单据）。这里是数量已变动、但官方流水还没回传的笔数——通常几分钟内回传并自动入账，期间不会显示任何不完整的记录。'),
  currentInventory: t('库存数字是实时的（变动信号一到就更新）。这里显示的是每天凌晨把全店所有商品与 Shopify 逐一核对的完成时间，是二次保险，不代表数字停留在该时刻。'),
  history: t('历史同步先补最近记录，再按每批最多 7 天向前读取；数据超过 Shopify 单次上限时会自动拆分。进度会按批次跳动，并非逐行增加。'),
};
const infoTip = (text) => `<span class="info-tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tooltip="${esc(text)}">?</span>`;

const SOURCE_LABEL = {
  sale: 'Sale', refund: 'Return', adjustment: 'Adjustment', stocktake: 'Stocktake',
  import: 'Historical import', reconciliation: 'Reconciliation', external_app: 'App',
  admin_manual: 'Staff', order: 'Order', transfer: 'Transfer',
  unknown: t('等待官方流水'), bundle_op: 'Bundle',
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
    return `<a href="/adjustments/${row.adjustment_id}">${t('调整单')} ${adjustmentNumber(row.adjustment_number, row.adjustment_display_number)}</a>`;
  }
  const ref = gidParts(row.reference_document_uri);
  const type = row.reference_document_type || ref?.type;
  const id = row.reference_document_id || ref?.id;
  if (!type && !id) return '<span class="muted">—</span>';
  const labels = {
    Order: 'Order', PurchaseOrder: 'Purchase order',
    Transfer: 'Transfer', InventoryTransfer: 'Transfer', Adjustment: 'Adjustment',
    // Shopify's wording for a manual stock edit; spelling it out as
    // "Transfer Adjustment" reads like a transfer, which it is not.
    TransferAdjustment: t('Shopify 库存调整'),
  };
  const label = labels[type] || String(type || 'Reference').replace(/([a-z])([A-Z])/g, '$1 $2');
  const fallbackUrl = type === 'Order' && id && shopHandle
    ? `https://admin.shopify.com/store/${encodeURIComponent(shopHandle)}/orders/${encodeURIComponent(id)}`
    : null;
  const url = row.reference_admin_url || fallbackUrl;
  // A raw uuid adds no meaning in the table — show a short form, keep the full
  // value in the tooltip.
  const shortId = id && String(id).length > 12 ? `${String(id).slice(0, 8)}…` : id;
  const title = row.reference_name || `${label}${shortId ? ` #${shortId}` : ''}`;
  const details = [
    row.reference_customer_name,
    row.reference_status,
  ].filter(Boolean).map((value) => esc(value)).join(' · ');
  return `${url
    ? `<a class="reference-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(title)} ↗</a>`
    : `<span title="${esc(id ? `${label} ${id}` : label)}">${esc(title)}</span>`}${details ? `<div class="muted small">${details}</div>` : ''}`;
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
const historyTable = (rows, shopHandle, empty = t('暂无修改记录')) => `
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
  if (delta === null || delta === undefined) return `<span class="not-provided">${t('未提供')}</span>`;
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

async function viewDashboard(params = routeParams()) {
  let recentPage = pageNumber(params.get('recentPage'));
  const [s, initialRecent] = await Promise.all([
    api('/status'),
    api(`/recent-items?page=${recentPage}&limit=10`),
  ]);
  const sync = s.initialSync;
  const snap = s.lastSnapshot;
  const history = s.historySync;
  const backfill = s.historyBackfill;
  const backfillPct = backfillPercent(backfill);
  const historyStatus = backfill?.running
    ? { text: t('历史同步中'), className: 'running' }
    : backfill?.error
      ? { text: t('历史同步已暂停'), className: 'warning' }
      : { text: t('自动运行中'), className: 'success' };
  const webhookMissingScopes = missingWebhookScopes(s.webhooksRegistered);
  const hasAttention = s.webhookBacklog > 20 || s.webhookErrors > 0
    || s.pendingAttribution > 100;
  const coverage = s.events.first ? t('{date} 至今', { date: new Date(s.events.first).toLocaleDateString(dateLocale) }) : t('尚无记录');
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>${t('库存概览')}</h1><p class="muted">${t('查看商品、修改记录和数据同步状态。')}</p></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>${t('最近 3 天库存变动')}</h2><p class="muted compact">${t('每个商品显示最近一次库存修改。')}</p></div><a class="subtle-link" href="/history">${t('查看全部修改记录 →')}</a></div>
      <div class="table-scroll"><table class="recent-products"><thead><tr><th>${t('商品')}</th><th>Activity</th><th>Created by</th><th>Location</th><th class="num">Available</th><th>Last change</th></tr></thead>
      <tbody id="recent-products-body">${initialRecent.rows.map((row) => `<tr>
        <td><a class="item-link" href="/items/${row.id}">${productName(row)}</a>${codeMeta(row)}</td>
        <td>${esc(activityLabel(row.activity))}<div>${srcBadge(row.source_type)}</div></td>
        <td>${actorCell(row)}</td><td>${esc(row.locations)}</td>
        <td class="num">${row.total_available}</td>
        <td>${esc(lastInventoryChange(row))}<div class="muted small">${fmtDate(row.occurred_at)}</div></td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted">${t('最近 3 天没有库存修改')}</td></tr>`}</tbody></table></div>
      <div id="recent-products-pagination" class="pagination"></div>
    </div>
    <div class="grid overview-grid">
      <a class="stat stat-link" href="/items"><div class="n">${s.items.n}</div><div class="l">${t('商品 / Barcode')}</div><div class="hint">${t('查看商品与各仓库存')}</div></a>
      <a class="stat stat-link" href="/history"><div class="n">${s.events.n}</div><div class="l">${t('修改记录')}</div><div class="hint">${t('按一次操作合并显示')}</div></a>
      <a class="stat stat-link" href="/history"><div class="n range">${coverage}</div><div class="l">${t('已保存的历史范围')}</div><div class="hint">${t('点击查看历史修改记录')}</div></a>
      <a class="stat stat-link ${hasAttention ? 'warn' : 'ok'}" href="/system"><div class="n">${hasAttention ? t('需查看') : t('正常')}</div><div class="l">${t('系统状态')}</div><div class="hint">${hasAttention ? t('有同步状态需要查看') : t('实时记录与 Shopify 当前库存正常')}</div></a>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>${t('数据同步')}</h2><p class="muted compact">${t('数字实时；记录等 Shopify 官方流水确认后入账；每天凌晨全量核对。')}</p></div>
        <div class="heading-actions"><a class="subtle-link" href="/system">${t('查看详情 →')}</a>
          <span class="status-pill ${historyStatus.className}">${historyStatus.text}</span>
        </div>
      </div>
      <div class="sync-list">
        <div><strong>${t('① 库存数字（实时）')}</strong><div class="muted">${t('变动信号{state}，最近一次 {date} 已即时更新数字。', { state: s.webhooksRegistered ? t('通道正常') : t('未启用'), date: fmtDate(s.webhookState?.last_inventory_at || s.webhookState?.last_received_at) })}</div></div>
        <div><strong>${t('② 修改记录（官方流水）')}</strong><div class="muted">${t('已入账至 {date}', { date: fmtDate(s.events?.last) })}${s.pendingAttribution ? t('；{n} 笔变动已收到信号、等待 Shopify 官方确认后入账。', { n: s.pendingAttribution }) : t('，暂无待确认变动。')}</div></div>
        <div><strong>${t('③ 每日全量核对')}</strong><div class="muted">${snap ? t('凌晨 {date} 已把全店库存与 Shopify 逐一核对。', { date: fmtDate(snap.finishedAt || snap.snapDate) }) : t('尚未完成首次核对。')}</div></div>
        <div><strong>${t('历史记录')}</strong><div class="muted">${backfill?.running
          ? `${t('正在进行')}${backfillPct ? t('（约 {pct}%）', { pct: backfillPct }) : ''}${t('，已读取 {n} 行', { n: backfill.fetched || 0 })}${backfill.cursor ? t('，已回填到 {date}', { date: fmtDate(backfill.cursor) }) : ''}${t('；不影响当前页面使用。')}`
          : backfill?.error ? t('同步已暂停：{msg}', { msg: esc(backfill.error) })
          : backfill?.finishedAt ? t('最近 180 天已同步完成（{date}）。', { date: fmtDate(backfill.finishedAt) }) : t('尚未同步 Shopify 最近 180 天。')}</div></div>
      </div>
    </div>
    <details class="card system-details">
      <summary>${t('系统状态说明')}</summary>
      <div class="health-grid">
        <div><strong>${t('实时接收队列：{n}', { n: s.webhookBacklog })}</strong><p>${t('Shopify 已发送、应用尚未处理的事件。处理错误 {n} 条；通常两者都应为 0。', { n: s.webhookErrors || 0 })}</p></div>
        <div><strong class="status-label">${t('等待官方流水：{n}', { n: s.pendingAttribution })} ${infoTip(STATUS_HELP.completion)}</strong><p>${t('数量已实时更新；记录待 Shopify 官方流水回传后入账（通常几分钟）。')}</p></div>
        <div><strong class="status-label">${t('Shopify 当前库存')} ${infoTip(STATUS_HELP.currentInventory)}</strong><p>${t('当前数量直接采用 Shopify 真值；快照不会生成推算告警。')}</p></div>
      </div>
    </details>
    <details class="card system-details">
      <summary>${t('维护工具')}</summary>
      <div class="row">
        <button id="btn-sync">${t('同步商品目录')}</button>
        <span class="muted">${sync ? (sync.done ? t('✅ 已完成：{n} 个变体（{date}）', { n: sync.count, date: fmtDate(sync.finishedAt) }) : sync.error ? t('❌ 失败：{msg}', { msg: esc(sync.error) }) : t('⏳ 进行中… {n} 个变体', { n: sync.count || 0 })) : t('未运行')}</span>
      </div>
      <div class="row">
        <button id="btn-webhooks">${t('重新注册实时接收')}</button>
        <span class="muted">${s.webhooksRegistered?.error
          ? `❌ ${esc(s.webhooksRegistered.error)}`
          : s.webhooksRegistered
            ? s.webhooksRegistered.results?.some((r) => !r.ok)
              ? s.webhooksRegistered.results.some((r) => !r.ok && !r.optional)
                ? t('❌ 核心实时接收注册失败（{topics}）', { topics: s.webhooksRegistered.results.filter((r) => !r.ok && !r.optional).map((r) => esc(r.topic)).join(listSep) })
                : webhookMissingScopes.length
                  ? t('⚠️ 核心已注册；待授权：{scopes}', { scopes: webhookMissingScopes.map(esc).join(listSep) })
                  : t('⚠️ 核心已注册；{n} 个扩展事件未注册', { n: s.webhooksRegistered.results.filter((r) => !r.ok).length })
              : t('✅ 已注册（{date}）', { date: fmtDate(s.webhooksRegistered.at) })
            : t('未注册')}</span>
      </div>
      <div class="row">
        <button id="btn-snapshot" class="secondary">${t('刷新 Shopify 当前库存')}</button>
        <span class="muted">${s.snapshotError?.error
          ? `❌ ${esc(s.snapshotError.error)}`
          : snap ? t('上次刷新 {date}：保存 {n} 条变化快照', { date: snap.snapDate, n: snap.snapshotRows }) : t('尚未刷新')}</span>
      </div>
      <div class="row">
        <button id="btn-history" class="secondary">${t('同步 Shopify 最近 180 天')}</button>
        <span class="muted">${backfill ? backfill.running ? t('⏳ 历史回填中… 已读取 {n} 行', { n: backfill.fetched || 0 }) : backfill.error ? `❌ ${esc(backfill.error)}` : t('历史回填完成 {date}：新增 {n}', { date: fmtDate(backfill.finishedAt), n: backfill.inserted || 0 }) : t('尚未回填')}
        ${history?.finishedAt ? ` · ${t('信息补全 {date}', { date: fmtDate(history.finishedAt) })}` : ''}</span>
      </div>
      <div class="row" style="align-items:flex-start;flex-direction:column;gap:6px">
        <strong>${t('导入 Stocky 历史调整（CSV）')}</strong>
        <div class="row">
          <input type="file" id="stocky-csv" accept=".csv,text/csv">
          <button id="btn-stocky-dry" class="secondary">${t('① 预检（只分析不写入）')}</button>
          <button id="btn-stocky-commit" disabled>${t('② 确认导入')}</button>
          <button id="btn-stocky-undo" class="secondary" style="color:var(--red)">${t('撤销导入')}</button>
        </div>
        <div class="muted small">${t('撤销会删除导入的 STK 单和历史记录、并把回填的操作人/备注清回原样（不动 Shopify 原有数据）；撤销后可重新导入。')}</div>
        <div id="stocky-report" class="muted small"></div>
      </div>
      <p class="muted compact">${t('这些工具仅用于安装、恢复或手动刷新；日常使用无需点击。')}</p>
    </details>
    <div class="notice"><strong>${t('历史范围说明：')}</strong>${t('Shopify 商品 Adjustment history 页面提供最近 180 天。本应用会永久保存已经采集或导入的记录；要补齐更早的 Stocky 历史，需要后续导入 Stocky 导出文件。')}</div>`;
  const renderRecent = (result) => {
    $w('#recent-products-body').innerHTML = result.rows.map((row) => `<tr>
      <td><a class="item-link" href="/items/${row.id}">${productName(row)}</a>${codeMeta(row)}</td>
      <td>${esc(activityLabel(row.activity))}<div>${srcBadge(row.source_type)}</div></td>
      <td>${actorCell(row)}</td><td>${esc(row.locations)}</td>
      <td class="num">${row.total_available}</td>
      <td>${esc(lastInventoryChange(row))}<div class="muted small">${fmtDate(row.occurred_at)}</div></td>
    </tr>`).join('') || `<tr><td colspan="6" class="muted">${t('最近 3 天没有库存修改')}</td></tr>`;
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    $w('#recent-products-pagination').innerHTML = result.total > result.pageSize ? `
      <button id="recent-prev" class="secondary" ${recentPage <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
      <span>${t('第 {page} / {pages} 页 · 每页 10 个商品', { page: recentPage, pages })}</span>
      <button id="recent-next" class="secondary" ${recentPage >= pages ? 'disabled' : ''}>${t('下一页')}</button>` : '';
    if ($('#recent-prev')) $('#recent-prev').onclick = () => navigateTo(routeUrl('/dashboard', {
      recentPage: recentPage - 1 > 1 ? recentPage - 1 : '',
    }));
    if ($('#recent-next')) $('#recent-next').onclick = () => navigateTo(routeUrl('/dashboard', {
      recentPage: recentPage + 1,
    }));
  };
  renderRecent(initialRecent);
  const guard = (fn) => async (e) => {
    e.target.disabled = true;
    try { await fn(e); }
    catch (err) { alert(t('操作失败：{msg}', { msg: err.message })); e.target.disabled = false; }
  };
  $('#btn-sync').onclick = guard(async () => { await api('/setup/sync', { method: 'POST' }); setTimeout(viewDashboard, 1500); });
  $('#btn-webhooks').onclick = guard(async () => {
    const state = await api('/setup/webhooks', { method: 'POST' });
    const { results } = state;
    const failed = results.filter((r) => !r.ok);
    const coreFailed = failed.filter((r) => !r.optional);
    const missingScopes = missingWebhookScopes(state);
    if (coreFailed.length) {
      alert(t('核心实时接收注册失败：\n{topics}', { topics: coreFailed.map((f) => f.topic).join('\n') }));
    } else if (failed.length) {
      alert(`${t('核心库存实时接收已注册。')}\n${missingScopes.length
        ? t('当前安装缺少扩展权限：\n{scopes}\n\n请在 Shopify App 配置中加入这些 scopes、保存后重新打开 App 批准权限，再点击本按钮。', { scopes: missingScopes.join('\n') })
        : t('另有 {n} 个扩展事件未注册，不影响库存数量的实时记录。', { n: failed.length })}`);
    }
    viewDashboard();
  });
  $('#btn-snapshot').onclick = guard(async (e) => {
    e.target.textContent = t('快照运行中…（可能几分钟）');
    try { await api('/jobs/snapshot', { method: 'POST' }); } finally { viewDashboard(); }
  });
  $('#btn-history').onclick = guard(async () => {
    await api('/jobs/history?days=180', { method: 'POST' });
    setTimeout(viewDashboard, 1500);
  });

  // Stocky legacy CSV import: dry-run report first, explicit second click to commit.
  const stockyReport = (r, committed) => `
    <div class="notice" style="margin-top:6px">
      ${committed ? `<strong>${t('✅ 导入完成：')}</strong>${t('新增 {a} 张调整单（库存调整工作区，编号 STK-xxxx）、{b} 个修改记录事件、{c} 行账本明细、{d} 个本地商品。', { a: committed.adjustmentsCreated, b: committed.eventsInserted, c: committed.linesInserted, d: committed.itemsCreated })}<br>` : ''}
      <strong>${t('预检报告')}</strong>${t('（CSV {n} 行）', { n: r.totalCsvRows })}<br>
      ${t('· 将导入：')}<strong>${r.eventsToImport}</strong>${t(' 张调整单（进「库存调整」工作区，保留原编号/原因/调整人/备注）/ {n} 行（{range}）', { n: r.linesToImport, range: r.dateRange ? `${r.dateRange.first.slice(0, 10)} → ${r.dateRange.last.slice(0, 10)}` : '—' })}<br>
      ${t('· 跳过（{date} 起已有正式记录）：{groups} 单 / {rows} 行', { date: r.coverageStart ? r.coverageStart.slice(0, 10) : '—', groups: r.skippedAlreadyCovered.groups, rows: r.skippedAlreadyCovered.rows })}<br>
      ${t('· 跳过（Stocky 中未执行 not_adjusted/failed）：{n} 行；缺日期单：{d}；缺条码行：{b}', { n: r.skippedNotAdjustedRows, d: r.missingDateGroups.length, b: r.missingBarcodeRows })}<br>
      ${t('· 将新建本地商品（Stocky 内部 # 产品）：{n} 个', { n: r.localItemsToCreate })}${r.localItemSamples.length ? t('，如 {samples}', { samples: r.localItemSamples.slice(0, 3).map((s) => esc(s.product)).join(listSep) }) : ''}<br>
      ${t('· 将新建员工：{staff}；新建仓位：{locations}；新建历史原因（不进新建下拉）：{reasons}', {
        staff: r.newStaff.length ? r.newStaff.map(esc).join(listSep) : t('无'),
        locations: r.newLocations.length ? r.newLocations.map(esc).join(listSep) : t('无'),
        reasons: r.newReasons?.length ? r.newReasons.map(esc).join(listSep) : t('无'),
      })}<br>
      ${r.coveredMapping ? `${t('· 重叠期（已有正式记录）：{m} 单匹配成功→回填操作人/备注到现有记录；{u} 单未匹配、{a} 单有歧义（这些只建 STK 档案、不动现有记录）', { m: r.coveredMapping.matched, u: r.coveredMapping.unmatched, a: r.coveredMapping.ambiguous })}<br>` : ''}      ${t('· 原因分布：')}${r.reasons.slice(0, 6).map(([n, c]) => `${esc(n)}×${c}`).join(listSep)}${r.reasons.length > 6 ? '…' : ''}
      ${r.duplicateBarcodesInCatalog.length ? `<br>${t('· ⚠️ 目录中重复条码（取第一个匹配）：{codes}', { codes: r.duplicateBarcodesInCatalog.slice(0, 5).map(esc).join(listSep) })}` : ''}
    </div>`;
  const readStockyFile = () => new Promise((resolve, reject) => {
    const f = $('#stocky-csv').files[0];
    if (!f) return reject(new Error(t('请先选择 Stocky 导出的 CSV 文件')));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(t('文件读取失败')));
    reader.readAsText(f);
  });
  $('#btn-stocky-dry').onclick = guard(async (e) => {
    const text = await readStockyFile();
    $w('#stocky-report').innerHTML = t('预检中…');
    const { report } = await api('/import/stocky?mode=dry-run', {
      method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' },
    });
    $w('#stocky-report').innerHTML = stockyReport(report);
    $('#btn-stocky-commit').disabled = false;
    e.target.disabled = false;
  });
  $('#btn-stocky-commit').onclick = guard(async (e) => {
    if (!confirm(t('确认把预检通过的 Stocky 历史调整写入账本？（幂等，可重复执行）'))) { e.target.disabled = false; return; }
    const text = await readStockyFile();
    $w('#stocky-report').innerHTML = t('导入中…（几十秒）');
    const result = await api('/import/stocky?mode=commit', {
      method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' },
    });
    $w('#stocky-report').innerHTML = stockyReport(result.report, result);
  });
  $('#btn-stocky-undo').onclick = guard(async (e) => {
    if (!confirm(t('撤销 Stocky 导入？将删除所有 STK 调整单和导入的历史记录，并把回填的操作人/备注清回原样。此操作可逆——之后可重新导入。'))) { e.target.disabled = false; return; }
    $w('#stocky-report').innerHTML = t('撤销中…');
    const r = await api('/import/stocky/undo', { method: 'POST' });
    $w('#stocky-report').innerHTML = `<div class="notice">${t('✅ 已撤销：删除 {a} 张 STK 单、{b} 个历史事件、{c} 行明细；回退 {d} 行回填；删除 {e} 个本地商品。可重新导入。', { a: r.deletedAdjustments, b: r.deletedEvents, c: r.deletedLedgerRows, d: r.revertedBackfillRows, e: r.deletedLocalItems })}</div>`;
    e.target.disabled = false;
  });
}


async function viewVirtualStock(params = routeParams()) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const options = await api('/adjustment-options');
  let locationId = params.get('location') || '';
  const initialTerm = params.get('q') || '';
  const render = async (term = initialTerm) => {
    const { rows, locations } = await api(`/virtual-stock?q=${encodeURIComponent(term)}&location=${locationId}`);
    const total = rows.reduce((n, r) => n + r.virtual_qty, 0);
    const current = locations.find((l) => String(l.id) === String(locationId)) || locations[0];
    app.innerHTML = `
      <div class="page-heading"><div><h1>${t('虚拟库存')}</h1><p class="muted">${t('{name} 不放实物，凡是在这个仓库有库存的都是虚拟库存：前台照常显示有货，客人下单后我们再向供应商订货或从整套里拆。厂家停产或不再供货时,在这里勾选撤销。', { name: esc(current ? current.name : '') })}</p></div></div>
      <div class="grid overview-grid">
        <div class="stat"><div class="n">${rows.length}</div><div class="l">${t('有虚拟库存的商品')}</div></div>
        <div class="stat"><div class="n">${total}</div><div class="l">${t('虚拟库存件数合计')}</div></div>
      </div>
      <div class="card">
        <div class="row">
          <select id="vs-loc">${locations.map((l) => `<option value="${l.id}" ${current && l.id === current.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
          <input type="search" id="vs-q" value="${esc(term)}" placeholder="${t('搜索商品 / Barcode / SKU…')}">
          <button id="vs-search" class="secondary">${t('搜索')}</button>
          <button id="vs-revoke" disabled>${t('撤销所选')}</button>
        </div>
        <div class="table-scroll"><table class="virtual-stock-table">
          <colgroup><col class="w-check"><col><col class="w-n"><col class="w-date"><col></colgroup>
          <thead><tr><th></th><th>${t('商品')}</th><th>${t('虚拟库存')}</th><th>${t('最近设置')}</th><th>${t('最近备注')}</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><input type="checkbox" class="vs-check" data-item="${r.item_id}" data-location="${r.location_id}"></td>
            <td><a class="item-link" href="/items/${r.item_id}">${esc(r.product_title || t('(无标题)'))}</a>${variantLabel(r) ? ` <span class="variant-tag">${variantLabel(r)}</span>` : ''}<div class="muted xsmall">${esc(r.barcode || '—')}${r.sku ? ` · ${esc(r.sku)}` : ''}</div></td>
            <td><strong>${r.virtual_qty}</strong></td>
            <td class="col-date">${r.last_at ? fmtDateCompact(r.last_at) : '<span class="muted">—</span>'}</td>
            <td class="xsmall">${r.last_adjustment_id
              ? `<a href="/adjustments/${r.last_adjustment_id}">${esc(String(r.last_adjustment_number || '').replace(/^STK-/, '#') || t('查看调整单'))}</a> · ` : ''}<span class="muted">${esc(r.last_note || '—')}</span></td>
          </tr>`).join('') || `<tr><td colspan="5" class="muted">${t('这个仓库当前没有库存')}</td></tr>`}</tbody>
        </table></div>
      </div>`;
    const checks = [...document.querySelectorAll('.vs-check')];
    const refresh = () => {
      const n = checks.filter((c) => c.checked).length;
      $('#vs-revoke').disabled = !n;
      $('#vs-revoke').textContent = n ? t('撤销所选 {n} 项', { n }) : t('撤销所选');
    };
    checks.forEach((c) => { c.onchange = refresh; });
    const navigateFilters = () => navigateTo(routeUrl('/virtual-stock', {
      q: $('#vs-q').value.trim(),
      location: $('#vs-loc').value,
    }));
    $('#vs-search').onclick = navigateFilters;
    $('#vs-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateFilters(); });
    $('#vs-loc').onchange = navigateFilters;
    $('#vs-revoke').onclick = async (event) => {
      const entries = checks.filter((c) => c.checked)
        .map((c) => ({ itemId: Number(c.dataset.item), locationId: Number(c.dataset.location) }));
      const person = options.staff.filter((p) => p.active)[0];
      if (!person) return alert(t('请先在设置里添加至少一名员工，撤销单需要记录员工。'));
      if (!confirm(t('将为所选 {n} 项生成撤销草稿，把它们在 {location} 的库存清零（记录员工：{name}）。草稿不会立即改变 Shopify，需要你确认后提交。', { n: entries.length, location: current.name, name: person.display_name }))) return;
      event.target.disabled = true;
      try {
        const { created } = await api('/virtual-stock/revoke', {
          method: 'POST',
          body: JSON.stringify({ entries, recordedBy: { staffId: person.id } }),
        });
        if (created.length === 1) { navigateTo(`/adjustments/${created[0].id}`); return; }
        alert(t('已生成 {n} 张撤销草稿，请到手动调整列表逐张确认。', { n: created.length }));
        navigateTo('/adjustments');
      } catch (error) { alert(t('生成失败：{msg}', { msg: error.message })); event.target.disabled = false; }
    };
  };
  await render();
}

// Renders the very card JSON the notifier produces, so what is shown here
// cannot drift from what Lark receives. Only the handful of Lark markdown
// features the card builder actually emits are supported.
const larkMd = (value) => esc(String(value ?? ''))
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  .replace(/&lt;font color=&#039;?(\w+)&#039;?&gt;([\s\S]*?)&lt;\/font&gt;/g, '<span class="lk-$1">$2</span>')
  .replace(/&lt;font color='(\w+)'&gt;([\s\S]*?)&lt;\/font&gt;/g, '<span class="lk-$1">$2</span>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\n/g, '<br>');
const larkElement = (element) => {
  if (element.tag === 'div') return `<div class="lk-line">${larkMd(element.text?.content)}</div>`;
  if (element.tag === 'column_set') {
    const [label, body] = element.columns || [];
    return `<div class="lk-cols"><div class="lk-label">${larkMd(label?.elements?.[0]?.text?.content)}</div>
      <div class="lk-body">${larkMd(body?.elements?.[0]?.text?.content)}</div></div>`;
  }
  if (element.tag === 'action') {
    return `<div class="lk-actions">${(element.actions || []).map((action) =>
      `<span class="lk-button">${esc(action.text?.content)}</span>`).join('')}</div>`;
  }
  return '';
};
const larkCard = (message) => `<div class="lark-card">
  <div class="lark-card-header lk-head-${esc(message.card.header.template)}">${esc(message.card.header.title.content)}</div>
  <div class="lark-card-body">${(message.card.elements || []).map(larkElement).join('')}</div>
</div>`;

async function viewLarkSettings() {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const config = await api('/lark-settings');
  const settings = { ...config.settings };
  const FIELDS = [
    ['showReason', t('调整原因'), t('这张单为什么调整,比如 Damaged、Manual stock count')],
    ['showNotes', t('备注'), t('提交时写的说明文字')],
    ['showLines', t('商品明细'), t('关掉就只发一条摘要,不列具体商品')],
    ['showBarcode', t('Barcode'), t('可点击直达 Shopify 后台该变体'), 'showLines'],
    ['showSku', t('SKU'), '', 'showLines'],
    ['showLocation', t('仓位'), t('这次调整发生在哪个仓库'), 'showLines'],
    ['showBeforeAfter', t('调整前 / 调整后数量'), t('关掉只显示变化量,如 +5'), 'showLines'],
    ['showRecordedBy', t('记录员工'), ''],
    ['showHandledBy', t('经手员工'), ''],
    ['showAppliedAt', t('调整时间'), ''],
    ['showDetailButton', t('「查看完整调整单」按钮'), t('点击回到本 app 的调整单页面')],
  ];
  app.innerHTML = `
    <div class="page-heading"><div><h1>${t('Lark 通知设置')}</h1><p class="muted">${t('调整单提交后发到 Lark 群的消息。改动即时预览,满意后保存;群消息固定用英文。')}</p></div></div>
    <div class="lark-settings-layout">
      <div>
        <div class="card">
          <h2>${t('发到哪个群')}</h2>
          <label class="active-toggle"><input type="checkbox" id="lark-enabled" ${settings.enabled ? 'checked' : ''}> ${t('启用调整单通知')}</label>
          <p class="muted small">${config.hasWebhook
            ? t('当前群机器人：{url}（{source}）', {
              url: esc(config.webhookUrlMasked),
              source: config.source === 'app' ? t('在本页设置') : t('来自服务器配置'),
            })
            : t('尚未设置群机器人,通知不会发送。')}</p>
          <label class="field"><span>${t('群机器人 Webhook 地址')}</span>
            <input type="text" id="lark-url" placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…">
          </label>
          <p class="muted small">${t('在 Lark 群 → 设置 → 群机器人 → 添加「自定义机器人」,复制 Webhook 地址粘贴到这里。留空表示不改动现有地址。')}</p>
          <label class="field"><span>${t('签名密钥（可选）')}</span>
            <input type="text" id="lark-secret" placeholder="${config.hasSecret ? t('已设置,留空表示不改动') : t('机器人若开启签名校验才需要')}">
          </label>
        </div>
        <div class="card">
          <h2>${t('三种卡片的标题和颜色')}</h2>
          <p class="muted small">${t('{number} 会替换成调整单号,如 A0042。')}</p>
          ${[
            ['', t('调整成功'), t('正常提交一张调整单')],
            ['reversal', t('撤销调整'), t('撤销单提交后,群里一眼能看出是撤销')],
            ['failure', t('提交失败'), t('提交没成功时提醒群里,以免只有操作的人知道')],
          ].map(([kind, label, hint]) => `
            <div class="lark-variant">
              <div class="lark-variant-head"><strong>${label}</strong><em>${hint}</em></div>
              <div class="lark-variant-fields">
                <input type="text" data-title="${kind}" value="${esc(kind ? settings[`${kind}Title`] : settings.title)}" maxlength="120">
                <select data-colour="${kind}">${(config.colours || []).map((colour) =>
                  `<option value="${colour}" ${(kind ? settings[`${kind}Colour`] : settings.headerColour) === colour ? 'selected' : ''}>${t(colour)}</option>`).join('')}</select>
              </div>
              ${kind === 'failure' ? `<label class="active-toggle"><input type="checkbox" data-field="notifyOnFailure" ${settings.notifyOnFailure ? 'checked' : ''}> ${t('提交失败时通知群里')}</label>` : ''}
            </div>`).join('')}
        </div>
        <div class="card">
          <h2>${t('显示哪些内容')}</h2>
          <div class="lark-field-list">${FIELDS.map(([key, label, hint, parent]) => `
            <label class="lark-field ${parent ? 'nested' : ''}">
              <input type="checkbox" data-field="${key}" ${settings[key] ? 'checked' : ''} ${parent ? `data-parent="${parent}"` : ''}>
              <span><strong>${label}</strong>${hint ? `<em>${hint}</em>` : ''}</span>
            </label>`).join('')}</div>
        </div>
        <div class="card">
          <div class="button-group">
            <button id="lark-save">${t('保存设置')}</button>
            <button id="lark-test" class="secondary" ${config.hasWebhook ? '' : 'disabled'}>${t('发一条测试消息')}</button>
            <span id="lark-status" class="muted small"></span>
          </div>
          <p class="muted small">${t('测试消息会真的发到群里,用的是下面预览的内容。')}</p>
        </div>
      </div>
      <div class="card lark-preview-card">
        <h2>${t('群消息预览')}</h2>
        <p class="muted small" id="lark-preview-note"></p>
        <div id="lark-preview">${t('加载中…')}</div>
      </div>
    </div>`;

  const readForm = () => {
    const next = { ...settings, enabled: $('#lark-enabled').checked };
    document.querySelectorAll('[data-field]').forEach((box) => { next[box.dataset.field] = box.checked; });
    document.querySelectorAll('[data-title]').forEach((input) => {
      const key = input.dataset.title ? `${input.dataset.title}Title` : 'title';
      next[key] = input.value.trim() || settings[key];
    });
    document.querySelectorAll('[data-colour]').forEach((select) => {
      next[select.dataset.colour ? `${select.dataset.colour}Colour` : 'headerColour'] = select.value;
    });
    return next;
  };
  const syncNested = () => {
    document.querySelectorAll('[data-parent]').forEach((box) => {
      const parent = document.querySelector(`[data-field="${box.dataset.parent}"]`);
      box.closest('.lark-field').classList.toggle('disabled', !parent.checked);
      box.disabled = !parent.checked;
    });
  };
  let previewTimer = null;
  const renderPreview = async () => {
    const generation = currentNav();
    try {
      const { messages, reversal, failure, sample } = await api('/lark-settings/preview', {
        method: 'POST', body: JSON.stringify({ settings: readForm() }),
      });
      if (!isCurrent(generation)) return;
      $w('#lark-preview-note').textContent = sample
        ? t('还没有已提交的调整单,下面用示例商品演示。')
        : t('用你最近一张已提交的调整单演示。');
      const form = readForm();
      $w('#lark-preview').innerHTML = [
        [t('调整成功'), messages.map(larkCard).join('')],
        [t('撤销调整'), reversal.map(larkCard).join('')],
        [t('提交失败'), form.notifyOnFailure ? larkCard(failure) : `<p class="muted small">${t('已关闭,失败时不会通知群里。')}</p>`],
      ].map(([label, html]) => `<div class="lark-preview-group"><h3>${label}</h3>${html}</div>`).join('');
    } catch (error) {
      $w('#lark-preview').innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  };
  const schedulePreview = () => {
    syncNested();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  };
  document.querySelectorAll('[data-field], [data-colour], #lark-enabled').forEach((input) => {
    input.onchange = schedulePreview;
  });
  document.querySelectorAll('[data-title]').forEach((input) => {
    input.addEventListener('input', schedulePreview);
  });

  const status = (message, isError = false) => {
    const node = $w('#lark-status');
    node.textContent = message;
    node.className = isError ? 'error small' : 'muted small';
  };
  $('#lark-save').onclick = async (event) => {
    event.target.disabled = true;
    status(t('保存中…'));
    try {
      const body = { settings: readForm() };
      const url = $('#lark-url').value.trim();
      const secret = $('#lark-secret').value.trim();
      if (url) body.webhookUrl = url;
      if (secret) body.secret = secret;
      await api('/lark-settings', { method: 'PUT', body: JSON.stringify(body) });
      await viewLarkSettings();
    } catch (error) { status(t('保存失败：{msg}', { msg: error.message }), true); event.target.disabled = false; }
  };
  $('#lark-test').onclick = async (event) => {
    if (!confirm(t('这会真的往 Lark 群发一条消息,是否继续？'))) return;
    event.target.disabled = true;
    status(t('发送中…'));
    try {
      const { sent } = await api('/lark-settings/test', {
        method: 'POST', body: JSON.stringify({ settings: readForm() }),
      });
      status(t('已发送 {n} 条,请到群里查看。', { n: sent }));
    } catch (error) { status(t('发送失败：{msg}', { msg: error.message }), true); }
    event.target.disabled = false;
  };
  syncNested();
  await renderPreview();
}

async function viewLocalItems(params = routeParams()) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const render = async (term = params.get('q') || '') => {
    const { rows, total } = await api(`/local-items?q=${encodeURIComponent(term)}`);
    app.innerHTML = `
      <div class="page-heading"><div><h1>${t('Shopify 已删除产品（{n}）', { n: total })}</h1><p class="muted">${t('这些产品在导入时按 Barcode 和 SKU 都在当前 Shopify 目录里找不到——基本是这几年停产/下架、已从 Shopify 删除的旧品，以及 Stocky 内部 # 组件。系统保留它们，只为不丢失其历史调整记录。')}</p></div></div>
      <div class="card">
        <div class="row"><input type="search" id="local-q" value="${esc(term)}" placeholder="${t('搜索标题 / Barcode / SKU…')}"><button id="local-search" class="secondary">${t('搜索')}</button></div>
        <div class="table-scroll"><table>
          <thead><tr><th>${t('商品')}</th><th>${t('变体')}</th><th>Barcode</th><th>SKU</th><th class="num">${t('调整单数')}</th><th>${t('出现在（点击跳转）')}</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><a class="item-link" href="/items/${r.id}">${esc(r.product_title || t('(无标题)'))}</a></td>
            <td>${variantLabel(r) || '<span class="muted">—</span>'}</td>
            <td><strong>${esc(r.barcode || '—')}</strong></td><td>${esc(r.sku || '—')}</td>
            <td class="num">${r.adjustment_count}</td>
            <td class="small">${(r.adjustments || []).map((a) => `<a href="/adjustments/${a.id}">${esc(String(a.no || '').replace(/^STK-/, '#'))}</a>`).join(listSep)}</td>
          </tr>`).join('') || `<tr><td colspan="6" class="muted">${t('没有已删除产品')}</td></tr>`}</tbody>
        </table></div>
        ${total > rows.length ? `<p class="muted small">${t('显示前 {shown} 个（共 {total}），用搜索缩小范围。', { shown: rows.length, total })}</p>` : ''}
      </div>`;
    const navigateSearch = () => navigateTo(routeUrl('/local-items', { q: $('#local-q').value.trim() }));
    $('#local-search').onclick = navigateSearch;
    $('#local-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateSearch(); });
  };
  await render();
}

async function viewItems(params = routeParams()) {
  const options = await api('/item-options');
  const filters = {
    q: params.get('q') || '',
    vendor: params.get('vendor') || '',
    collection: params.get('collection') || '',
    sort: params.get('sort') || 'updated_desc',
  };
  const page = pageNumber(params.get('page'));
  app.innerHTML = `
    <div class="page-heading"><div><h1>${t('产品列表')}</h1><p class="muted">${t('按 Brand、Collection、库存或最近修改时间查找商品。')}</p></div>
      <div class="button-group"><a class="button secondary" href="/local-items">${t('Shopify 已删除产品')}</a></div></div>
    <div class="card">
      <div class="filter-grid">
        <input type="search" id="q" value="${esc(filters.q)}" placeholder="${t('搜索 Barcode / 标题 / SKU / 品牌…')}">
        <select id="vendor-filter"><option value="">${t('全部 Brand')}</option>${options.vendors.map((vendor) => `<option value="${esc(vendor)}" ${filters.vendor === vendor ? 'selected' : ''}>${esc(vendor)}</option>`).join('')}</select>
        <select id="collection-filter"><option value="">${t('全部 Collection')}</option>${options.collections.map((collection) => `<option value="${esc(collection.id)}" ${filters.collection === String(collection.id) ? 'selected' : ''}>${esc(collection.title)}</option>`).join('')}</select>
        <select id="item-sort">
          ${[
            ['updated_desc', t('最近修改：新 → 旧')], ['updated_asc', t('最近修改：旧 → 新')],
            ['stock_desc', t('Available：高 → 低')], ['stock_asc', t('Available：低 → 高')],
            ['brand_asc', t('Brand：A → Z')], ['brand_desc', t('Brand：Z → A')],
            ['name_asc', t('商品名称：A → Z')], ['name_desc', t('商品名称：Z → A')],
            ['collection', t('Collection 默认顺序')],
          ].map(([value, label]) => `<option value="${value}" ${filters.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button id="btn-search" class="secondary">${t('应用')}</button>
      </div>
      <div id="items-summary" class="muted small"></div>
      <div id="items-out">${t('加载中…')}</div>
      <div id="items-pagination" class="pagination"></div>
    </div>`;
  const run = async () => {
    $w('#items-out').innerHTML = t('加载中…');
    try {
      const params = new URLSearchParams({
        ...filters,
        page: String(page),
        limit: '50',
      });
      const result = await api(`/items?${params}`);
      const { rows } = result;
      $('#items-summary').textContent = t('共 {n} 个商品变体', { n: result.total });
      $w('#items-out').innerHTML = rows.length ? `
        <div class="table-scroll"><table class="items-table"><thead><tr><th>${t('商品')}</th><th class="num">Unavailable</th><th class="num">Committed</th><th class="num">Available</th><th class="num">On hand</th><th class="num">Incoming</th><th>${t('最近库存修改')}</th><th>${t('最近修改时间')}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><a class="item-link" href="/items/${r.id}">${productName(r)}</a>${r.source === 'local' ? ` <span class="badge">${t('已删除')}</span>` : ''}${codeMeta(r)}</td>
          <td class="num">${stockValue(r.total_unavailable)}</td>
          <td class="num">${stockValue(r.total_committed)}</td>
          <td class="num">${stockValue(r.total_available)}</td>
          <td class="num">${stockValue(r.total_on_hand)}</td>
          <td class="num">${stockValue(r.total_incoming)}</td>
          <td>${r.last_changed_at ? esc(lastInventoryChange(r)) : `<span class="muted">${t('暂无记录')}</span>`}<div class="muted small">${r.last_activity ? esc(activityLabel(r.last_activity)) : ''}</div></td>
          <td>${fmtDate(r.last_changed_at)}</td></tr>`).join('')}</tbody></table></div>` : t('无结果。');
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      $w('#items-pagination').innerHTML = result.total > result.pageSize ? `
        <button id="items-prev" class="secondary" ${page <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
        <span>${t('第 {page} / {pages} 页', { page, pages })}</span>
        <button id="items-next" class="secondary" ${page >= pages ? 'disabled' : ''}>${t('下一页')}</button>` : '';
      const listUrl = (nextPage) => routeUrl('/items', {
        ...filters,
        sort: filters.sort === 'updated_desc' ? '' : filters.sort,
        page: nextPage > 1 ? nextPage : '',
      });
      if ($('#items-prev')) $('#items-prev').onclick = () => navigateTo(listUrl(page - 1));
      if ($('#items-next')) $('#items-next').onclick = () => navigateTo(listUrl(page + 1));
    } catch (e) { $w('#items-out').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  const applyFilters = () => navigateTo(routeUrl('/items', {
    q: $('#q').value.trim(),
    vendor: $('#vendor-filter').value,
    collection: $('#collection-filter').value,
    sort: $('#item-sort').value === 'updated_desc' ? '' : $('#item-sort').value,
  }));
  $('#btn-search').onclick = applyFilters;
  $('#vendor-filter').onchange = applyFilters;
  $('#collection-filter').onchange = () => {
    if ($('#collection-filter').value && $('#item-sort').value === 'updated_desc') {
      $('#item-sort').value = 'collection';
    }
    applyFilters();
  };
  $('#item-sort').onchange = applyFilters;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
  await run();
}

const TREND_METRICS = {
  available: { label: 'Available', help: t('可用于销售或分配的库存。负数通常表示超卖或尚未完成库存修正。') },
  on_hand: { label: 'On hand', help: t('仓位内实际持有的库存，包括 Available 与各类不可售库存。') },
  committed: { label: 'Committed', help: t('已经分配给订单、尚未完成出库的库存。') },
  incoming: { label: 'Incoming', help: t('已经在采购或调拨流程中、尚未到达仓位的库存。') },
};
const CHART_RANGES = { 30: t('最近 30 天'), 90: t('最近 90 天'), 180: t('最近 180 天'), all: t('全部记录') };
const shortDay = (value) => new Date(value).toLocaleDateString(dateLocale, { month: 'numeric', day: 'numeric' });
const levelTotal = (levels, key) => {
  const values = levels.map((level) => level[key]).filter((value) => value !== null && value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) : null;
};
const inventoryNumber = (value, key = '') => {
  if (value === null || value === undefined) return `<span class="inventory-value muted">${t('未提供')}</span>`;
  const className = key === 'available' && Number(value) < 0 ? 'negative' : Number(value) > 0 ? 'positive' : '';
  return `<span class="inventory-value ${className}">${esc(value)}</span>`;
};
// One matrix instead of a metric grid plus one card per warehouse: rows are
// 合计 + each location, columns are the inventory states. The state labels then
// appear once rather than being repeated for every warehouse.
const INVENTORY_STATE_COLUMNS = [
  ['available', 'Available'],
  ['on_hand', 'On hand'],
  ['committed', 'Committed'],
  ['incoming', 'Incoming'],
  ['unavailable', 'Unavailable'],
];
const sumState = (levels, key) => {
  const values = levels.map((l) => l[key]).filter((v) => v !== null && v !== undefined);
  return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
};
const stateCell = (value, key) => {
  if (value === null || value === undefined) return `<td class="state-cell muted">${t('未提供')}</td>`;
  const n = Number(value);
  const cls = key === 'available' && n < 0 ? 'negative' : '';
  return `<td class="state-cell ${cls}">${signedPlain(n)}</td>`;
};
const signedPlain = (n) => (Number(n) < 0 ? `−${Math.abs(Number(n))}` : String(Number(n)));
const inventoryMatrix = (levels) => {
  if (!levels.length) return `<div class="trend-empty">${t('Shopify 尚未提供仓位库存。')}</div>`;
  const totals = Object.fromEntries(INVENTORY_STATE_COLUMNS.map(([key]) => [key, sumState(levels, key)]));
  const breakdown = (level) => [
    ['Committed', level.committed], ['Reserved', level.reserved],
    ['Damaged', level.damaged], ['Safety stock', level.safety_stock],
    ['Quality control', level.quality_control],
  ].filter(([, v]) => v !== null && v !== undefined && Number(v) !== 0);
  // Each row keeps a one-line, human summary of what that warehouse's numbers
  // mean (short stock / incoming / in sync) plus any non-zero unavailable
  // breakdown — the useful part of the old per-warehouse cards, without
  // repeating the column headings.
  const locSummary = (level) => {
    const available = level.available === null ? null : Number(level.available);
    const incoming = Number(level.incoming || 0);
    const parts = [];
    if (available !== null && available < 0) parts.push(`<span class="loc-status danger">${t('库存不足 {n} 件', { n: Math.abs(available) })}</span>`);
    else if (available !== null && available > 0) parts.push(`<span class="loc-status ok">${t('可售 {n} 件', { n: available })}</span>`);
    if (incoming > 0) parts.push(`<span class="loc-status incoming">${t('{n} 件在途', { n: incoming })}</span>`);
    const extra = breakdown(level);
    if (extra.length) parts.push(`<span class="loc-status ok">${extra.map(([n, v]) => `${n} ${esc(v)}`).join(' · ')}</span>`);
    if (!parts.length) parts.push(`<span class="loc-status ok">${t('无库存')}</span>`);
    return parts.join('');
  };
  const rows = levels.map((level) => `<tr>
      <th scope="row">${esc(level.name)}${locSummary(level)}</th>
      ${INVENTORY_STATE_COLUMNS.map(([key]) => stateCell(level[key], key)).join('')}
    </tr>`).join('');
  const totalAvailable = totals.available === null ? null : Number(totals.available);
  const totalIncoming = Number(totals.incoming || 0);
  const totalSummary = [
    totalAvailable !== null && totalAvailable < 0 ? `<span class="loc-status danger">${t('缺货 {n} 件', { n: Math.abs(totalAvailable) })}</span>`
      : totalAvailable ? `<span class="loc-status ok">${t('可售 {n} 件', { n: totalAvailable })}</span>` : `<span class="loc-status ok">${t('无可售库存')}</span>`,
    totalIncoming > 0 ? `<span class="loc-status incoming">${t('{n} 件在途', { n: totalIncoming })}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="table-scroll"><table class="inventory-matrix">
    <thead><tr><th>${t('仓位')}</th>${INVENTORY_STATE_COLUMNS.map(([key, label]) => `<th>${label}${key === 'unavailable' ? ` ${infoTip(t('由 On hand − Available 计算，是不可售库存总量；Committed 等状态包含在其中，不应与其再次相加。'))}` : ''}</th>`).join('')}</tr></thead>
    <tbody>
      <tr class="total-row"><th scope="row">${t('全部仓位合计')}${totalSummary}</th>${INVENTORY_STATE_COLUMNS.map(([key]) => stateCell(totals[key], key)).join('')}</tr>
      ${rows}
    </tbody>
  </table></div>`;
};

function inventoryTrendChart(data) {
  const metric = TREND_METRICS[data.state] || TREND_METRICS.available;
  if (data.current === null || data.current === undefined) {
    return `<div class="trend-empty"><strong>${t('{metric} 暂无数据', { metric: metric.label })}</strong><span>${t('Shopify 尚未提供这个库存状态。')}</span></div>`;
  }
  if (!data.hasHistory || data.points.length < 2) {
    return `<div class="trend-empty"><strong>${t('当前 {metric}：{n}', { metric: metric.label, n: esc(data.current) })}</strong><span>${t('还没有足够的修改记录可绘制趋势；系统不会用两个日期制造一条假折线。')}</span></div>`;
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
      aria-label="${esc(t('{date}，{metric} {value}', { date: fmtDate(point.at), metric: metric.label, value: point.value }))}"
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
    <svg class="inventory-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t('{metric} 库存趋势', { metric: metric.label }))}">
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
    <div class="trend-caption"><span>${t('每个圆点代表一次库存操作；阶梯线仅在操作发生时改变')}</span><span>${esc(CHART_RANGES[data.range] || '')} · ${t('截至 {date}', { date: fmtDate(data.to) })}</span></div>
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
      tooltip.innerHTML = `<strong>${esc(point.dataset.value)}</strong><span>${esc(point.dataset.date)}${delta ? ` · ${t('变动 {delta}', { delta: signed(delta) })}` : ` · ${t('当前库存')}`}</span>${context ? `<span>${esc(context)}</span>` : ''}`;
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
  7: t('最近 7 天'),
  30: t('最近 30 天'),
  90: t('最近 3 个月'),
  180: t('最近半年'),
  365: t('最近一年'),
  all: t('全部记录'),
};
const MOVEMENT_LABELS = {
  order: t('下单占用'),
  sale: t('销售出库'),
  cancel: t('取消/释放'),
  return: t('退货入库'),
  receipt: t('采购入库'),
};
const compactNumber = (value, digits = 0) => Number(value || 0).toLocaleString(dateLocale, {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const salesPeriodLabel = (period) => {
  if (/^\d{4}-\d{2}$/.test(period)) {
    return appLang === 'zh'
      ? t('{m}月', { m: Number(period.slice(5)) })
      : new Date(`${period}-01T00:00:00.000Z`).toLocaleDateString(dateLocale, { month: 'short', timeZone: 'UTC' });
  }
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
    return `<div class="sales-chart-empty">${t('这个时间段没有可绘制的下单、出货、取消、退货或采购入库数据。')}</div>`;
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
      <title>${esc(t('{period} · 下单 {o} · 出货 {s} · 取消/释放 {c} · 退货 {r} · 采购入库 {rc}', { period: row.period, o: row.ordered, s: row.sold, c: row.cancelled, r: row.returned, rc: row.received }))}</title>
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
      <span><i class="order"></i>${t('下单占用')}</span>
      <span><i class="sale"></i>${t('销售出库')}</span>
      <span><i class="cancel"></i>${t('取消/释放')}</span>
      <span><i class="return"></i>${t('退货入库')}</span>
      <span><i class="receipt"></i>${t('采购入库')}</span>
    </div>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${t('下单、销售出库、取消、退货和采购入库趋势')}">
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
    : summary.coverageDays > 999 ? t('999+ 天') : t('{n} 天', { n: Math.round(summary.coverageDays) });
  return `<div class="sales-summary-grid">
    <div><span>${t('下单数量')}</span><strong>${compactNumber(summary.ordered)}</strong><small>${t('{n} 个订单已占用库存', { n: summary.orderedOrders })}</small></div>
    <div><span>${t('已出货销量')}</span><strong>${compactNumber(summary.sold)}</strong><small>${t('{n} 个订单已完成出库', { n: summary.salesOrders })}</small></div>
    <div><span>${t('待出货')} ${infoTip(t('按同一订单的下单占用 − 已出货 − 已释放推算；只覆盖本应用已采集到的记录。'))}</span><strong>${compactNumber(summary.pending)}</strong><small>${t('{n} 个订单尚未见完整出库', { n: summary.pendingOrders })}</small></div>
    <div><span>${t('取消 / 退货')}</span><strong>${compactNumber(summary.cancelled + summary.returned)}</strong><small>${t('释放 {a} · 退货入库 {b}', { a: summary.cancelled, b: summary.returned })}</small></div>
    <div><span>${t('净销售量')}</span><strong>${compactNumber(summary.netSold)}</strong><small>${t('销售 − 退货')}</small></div>
    <div><span>${t('采购入库')}</span><strong>${compactNumber(summary.received)}</strong><small>${t('不含仓库调拨')}</small></div>
    <div><span>${t('周均已出货')}</span><strong>${compactNumber(summary.averageWeekly, 1)}</strong><small>${t('按净出货量和所选周期折算')}</small></div>
    <div><span>${t('预计可售天数')} ${infoTip(t('当前 Available ÷ 所选周期的日均净销量。没有净销量或库存为负时不估算。'))}</span><strong>${coverage}</strong><small>${t('当前 Available {n}', { n: data.currentAvailable ?? '—' })}</small></div>
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
    ? `${t(data.rangeLabel)} · ${t('{from} 至 {to}', { from: fmtDate(data.first), to: fmtDate(data.last) })}`
    : `${t(data.rangeLabel)} · ${t('暂无销售业务记录')}`;
  return `
    <p class="sales-range muted">${esc(rangeText)}</p>
    ${salesSummary(data)}
    ${salesHistoryChart(data)}
    <div class="sales-method-note">
      ${t('下单数量来自订单导致的 Available 占用；只有 Order fulfilled 导致 On hand 减少才算已出货销量。待出货按同一订单的下单、出货和库存释放记录推算；退货与采购入库单独统计，调拨、人工调整和 App 修正不计入销量。')}
    </div>
    <div class="table-scroll"><table class="sales-history-table">
      <thead><tr><th>Date</th><th>${t('类型')}</th><th class="num">${t('数量')}</th><th>Location</th><th>${t('关联单据 / 客户')}</th><th>Activity</th></tr></thead>
      <tbody>${salesRows(data) || `<tr><td colspan="6" class="muted">${t('这个周期暂无下单、出货、取消、退货或采购入库记录。')}</td></tr>`}</tbody>
    </table></div>`;
}

async function viewItem(id, params = routeParams()) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const { item, levels, shopHandle, links, lastChange } = await api(`/items/${id}`);
  document.title = `${item.product_title || t('商品详情')} · Inventory`;
  const latestLevelUpdate = levels.reduce((latest, level) =>
    !latest || +new Date(level.updated_at) > +new Date(latest) ? level.updated_at : latest, null);
  app.innerHTML = `
    <div class="card">
      <div class="card-heading"><h2>${productName(item)}</h2><div class="button-group">
        ${links.storefront ? `<a class="button secondary" href="${esc(links.storefront)}" target="_blank" rel="noopener">${t('查看前台商品 ↗')}</a>` : `<span class="button secondary disabled">${t('前台未发布')}</span>`}
        ${links.admin ? `<a class="button" href="${esc(links.admin)}" target="_blank" rel="noopener">${t('打开 Shopify 后台 ↗')}</a>` : ''}
      </div></div>
      <div class="product-detail-meta">${codeMeta(item)}<span>${t('零售价 {price} · 成本 {cost}', { price: item.price ?? '—', cost: item.unit_cost ?? '—' })}</span></div>
      ${inventoryMatrix(levels)}
      <div class="inventory-last-change">
        <span>${t('最近库存变动')} <strong>${lastChange ? esc(lastInventoryChange(lastChange)) : t('暂无记录')}</strong></span>
        <span>${t('最近同步')} <strong>${fmtDate(latestLevelUpdate)}</strong></span>
      </div>
    </div>
    <div class="card inventory-trend-card">
      <div class="card-heading">
        <div><h2>${t('库存趋势')}</h2><p class="muted compact">${t('根据已保存的修改记录逐次反推库存；每次操作独立显示，不会把同一天的增减提前抵消。')}</p></div>
        <div class="trend-controls">
          <select id="trend-state" aria-label="${t('库存状态')}">
            ${Object.entries(TREND_METRICS).map(([value, meta]) => `<option value="${value}">${meta.label}</option>`).join('')}
          </select>
          <select id="trend-location" aria-label="${t('仓位')}">
            <option value="">${t('全部仓位')}</option>
            ${levels.map((level) => `<option value="${esc(level.location_id)}">${esc(level.name)}</option>`).join('')}
          </select>
          <select id="trend-range" aria-label="${t('时间范围')}">
            ${Object.entries(CHART_RANGES).map(([value, label]) => `<option value="${value}" ${value === '30' ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="inventory-trend"><div class="trend-loading">${t('正在读取库存趋势…')}</div></div>
    </div>
    <div class="card sales-history-card">
      <div class="card-heading">
        <div><h2>${t('销售历史')}</h2><p class="muted compact">${t('区分下单需求、真实出货、待出货、取消/退货和采购入库，作为后续补货计划的数据基础。')}</p></div>
        <select id="sales-range" aria-label="${t('销售历史周期')}">
          ${Object.entries(SALES_RANGE_LABELS).map(([value, label]) => `<option value="${value}" ${value === '30' ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div id="sales-history"><div class="trend-loading">${t('正在计算销售历史…')}</div></div>
      <div id="sales-pagination" class="pagination"></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>${t('历史修改记录')}</h2><p id="history-range" class="muted compact">${t('本地已保存的全部时间范围，可分页查看。')}</p></div>
        <select id="history-location"><option value="">${t('全部仓位')}</option>${levels.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</select>
      </div>
      <div id="all-history">${t('加载中…')}</div>
      <div id="history-pagination" class="pagination"></div>
    </div>
    <div class="notice"><strong>${t('关于历史期限：')}</strong>${t('Shopify 商品页仅显示最近 180 天；本应用会长期保留已采集记录。当前最早日期取决于首次同步时间，Stocky 更早历史需通过导入补齐。')}</div>`;

  const initialTrendState = TREND_METRICS[params.get('trend')] ? params.get('trend') : 'available';
  const initialTrendRange = CHART_RANGES[params.get('trendRange')] ? params.get('trendRange') : '30';
  const initialTrendLocation = levels.some((level) => String(level.location_id) === params.get('trendLocation'))
    ? params.get('trendLocation') : '';
  const initialSalesRange = SALES_RANGE_LABELS[params.get('salesRange')] ? params.get('salesRange') : '30';
  const initialHistoryLocation = levels.some((level) => level.name === params.get('historyLocation'))
    ? params.get('historyLocation') : '';
  $('#trend-state').value = initialTrendState;
  $('#trend-range').value = initialTrendRange;
  $('#trend-location').value = initialTrendLocation;
  $('#sales-range').value = initialSalesRange;
  $('#history-location').value = initialHistoryLocation;

  let salesPage = pageNumber(params.get('salesPage'));
  let historyPage = pageNumber(params.get('historyPage'));
  // Detail controls describe the current product page rather than a new page
  // in the hierarchy. Replace this entry so "返回上一级" still returns to the
  // list/search/history page that opened the product.
  const updateDetailUrl = () => navigateTo(routeUrl(`/items/${id}`, {
    trend: $('#trend-state').value === 'available' ? '' : $('#trend-state').value,
    trendLocation: $('#trend-location').value,
    trendRange: $('#trend-range').value === '30' ? '' : $('#trend-range').value,
    salesRange: $('#sales-range').value === '30' ? '' : $('#sales-range').value,
    salesPage: salesPage > 1 ? salesPage : '',
    historyLocation: $('#history-location').value,
    historyPage: historyPage > 1 ? historyPage : '',
  }), { replace: true, render: false });

  let trendRequest = 0;
  const loadTrend = async () => {
    const request = ++trendRequest;
    const params = new URLSearchParams({
      state: $('#trend-state').value,
      range: $('#trend-range').value,
    });
    if ($('#trend-location').value) params.set('location', $('#trend-location').value);
    $w('#inventory-trend').innerHTML = `<div class="trend-loading">${t('正在读取库存趋势…')}</div>`;
    try {
      const result = await api(`/items/${id}/trend?${params}`);
      if (request !== trendRequest) return;
      $w('#inventory-trend').innerHTML = inventoryTrendChart(result);
      wireTrendChart();
    } catch (error) {
      if (request === trendRequest) $w('#inventory-trend').innerHTML = `<div class="trend-empty error">${esc(error.message)}</div>`;
    }
  };
  const changeTrend = () => { updateDetailUrl(); loadTrend(); };
  $('#trend-state').onchange = changeTrend;
  $('#trend-location').onchange = changeTrend;
  $('#trend-range').onchange = changeTrend;
  loadTrend();

  const loadSales = async () => {
    const params = new URLSearchParams({
      range: $('#sales-range').value,
      page: String(salesPage),
      limit: '20',
    });
    $w('#sales-history').innerHTML = `<div class="trend-loading">${t('正在计算销售历史…')}</div>`;
    $w('#sales-pagination').innerHTML = '';
    try {
      const result = await api(`/items/${id}/sales?${params}`);
      $w('#sales-history').innerHTML = renderSalesHistory(result);
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      $w('#sales-pagination').innerHTML = result.total > result.pageSize ? `
        <button id="sales-prev" class="secondary" ${salesPage <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
        <span>${t('第 {page} / {pages} 页', { page: salesPage, pages })}</span>
        <button id="sales-next" class="secondary" ${salesPage >= pages ? 'disabled' : ''}>${t('下一页')}</button>` : '';
      if ($('#sales-prev')) $('#sales-prev').onclick = () => { salesPage--; updateDetailUrl(); loadSales(); };
      if ($('#sales-next')) $('#sales-next').onclick = () => { salesPage++; updateDetailUrl(); loadSales(); };
    } catch (error) {
      $w('#sales-history').innerHTML = `<div class="trend-empty error">${esc(error.message)}</div>`;
    }
  };
  $('#sales-range').onchange = () => { salesPage = 1; updateDetailUrl(); loadSales(); };

  const loadHistory = async () => {
    const location = $('#history-location').value;
    const suffix = location ? `&location=${encodeURIComponent(location)}` : '';
    $w('#all-history').innerHTML = t('加载中…');
    const historical = await api(`/items/${id}/history?page=${historyPage}&limit=25${suffix}`);
    $w('#all-history').innerHTML = historyTable(historical.rows, shopHandle, t('该仓位暂无历史修改记录'));
    $('#history-range').textContent = historical.first
      ? `${t('共 {n} 条', { n: historical.total })} · ${t('{from} 至 {to}', { from: fmtDate(historical.first), to: fmtDate(historical.last) })}`
      : t('暂无已保存的修改记录');
    const pages = Math.max(1, Math.ceil(historical.total / historical.pageSize));
    $w('#history-pagination').innerHTML = historical.total > historical.pageSize ? `
      <button id="history-prev" class="secondary" ${historyPage <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
      <span>${t('第 {page} / {pages} 页', { page: historyPage, pages })}</span>
      <button id="history-next" class="secondary" ${historyPage >= pages ? 'disabled' : ''}>${t('下一页')}</button>` : '';
    if ($('#history-prev')) $('#history-prev').onclick = () => { historyPage--; updateDetailUrl(); loadHistory(); };
    if ($('#history-next')) $('#history-next').onclick = () => { historyPage++; updateDetailUrl(); loadHistory(); };
  };
  $('#history-location').onchange = () => { historyPage = 1; updateDetailUrl(); loadHistory(); };
  await Promise.all([loadSales(), loadHistory()]);
}

async function viewSystem() {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const status = await api('/status');
  const pct = backfillPercent(status.historyBackfill);
  const historyState = status.historyBackfill?.running
    ? { value: `${pct || '…'}%`, hint: `${t('已读取 {n} 行', { n: status.historyBackfill.fetched || 0 })}${status.historyBackfill.cursor ? t('，已回填到 {date}', { date: fmtDate(status.historyBackfill.cursor) }) : ''}`, className: '' }
    : status.historyBackfill?.error
      ? { value: t('已暂停'), hint: status.historyBackfill.error, className: 'warn' }
      : status.historyBackfill?.finishedAt
        ? { value: t('完成'), hint: t('自动增量记录中'), className: 'ok' }
        : { value: t('未开始'), hint: t('可从首页维护工具开始同步'), className: 'warn' };
  const snapshotState = status.lastSnapshot
    ? { value: t('已刷新'), hint: fmtDate(status.lastSnapshot.finishedAt || status.lastSnapshot.snapDate), className: 'ok' }
    : { value: t('未开始'), hint: t('可从首页维护工具刷新'), className: 'warn' };
  app.innerHTML = `
    <div class="page-heading"><div><h1>${t('系统状态')}</h1><p class="muted">${t('查看实时接收、信息补全和 Shopify 数据同步进度。')}</p></div></div>
    <div class="grid system-stat-grid">
      <div class="stat ${status.webhookBacklog ? 'warn' : 'ok'}"><div class="n">${status.webhookBacklog}</div><div class="l">${t('实时接收队列')}</div><div class="hint">${t('通常应为 0')}</div></div>
      <div class="stat"><div class="n">${status.pendingAttribution}</div><div class="l status-label">${t('等待官方流水')} ${infoTip(STATUS_HELP.completion)}</div><div class="hint">${t('官方流水回传后自动入账，通常几分钟')}</div></div>
      <div class="stat"><div class="n" style="font-size:15px">${fmtDate(status.events?.last)}</div><div class="l">${t('修改记录已入账至')}</div><div class="hint">${t('此后发生的变动已收到实时信号（数字已更新），等 Shopify 官方流水确认后入账，偶尔延迟数小时')}</div></div>
      <div class="stat ${snapshotState.className}"><div class="n">${snapshotState.value}</div><div class="l status-label">${t('每日全量核对')} ${infoTip(STATUS_HELP.currentInventory)}</div><div class="hint">${esc(snapshotState.hint)}</div></div>
      <div class="stat ${historyState.className}"><div class="n">${historyState.value}</div><div class="l status-label">${t('180 天历史同步')} ${infoTip(STATUS_HELP.history)}</div><div class="hint">${esc(historyState.hint)}</div></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>${t('数据记录原则')}</h2><p class="muted compact">${t('界面展示 Shopify 已返回的真实库存数量变化，不展示本地推算告警。')}</p></div></div>
      <div class="health-grid">
        <div><strong>${t('当前库存')}</strong><p>${t('直接使用 Shopify 返回的各仓位 Available、On hand、Committed 和 Incoming。')}</p></div>
        <div><strong>${t('修改记录')}</strong><p>${t('来自 Shopify Adjustment history、实时库存事件和本应用已提交的调整单；操作人和关联单据会随后自动补全。')}</p></div>
        <div><strong>${t('每日快照')}</strong><p>${t('只刷新当前库存基准并保存趋势检查点，不虚构操作人、原因或业务单据。')}</p></div>
      </div>
    </div>`;
}

async function viewHistory(params = routeParams()) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const page = pageNumber(params.get('page'));
  const filters = {
    q: params.get('q') || '',
    person: params.get('person') || '',
    source: params.get('source') || '',
    dateFrom: params.get('from') || '',
    dateTo: params.get('to') || '',
  };
  const load = async () => {
    const params = new URLSearchParams({ ...filters, page, limit: 50 });
    const result = await api(`/history?${params}`);
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    app.innerHTML = `
      <div class="page-heading"><div><h1>${t('修改记录')}</h1><p class="muted">${t('全店库存操作按事件合并显示，可查看操作人、App 和关联订单。')}</p></div></div>
      <div class="card">
        <div class="history-filters">
          <input id="history-q" type="search" value="${esc(filters.q)}" placeholder="${t('商品、Barcode、SKU、订单或调整编号')}">
          <input id="history-person" type="search" value="${esc(filters.person)}" placeholder="${t('员工或 App')}">
          <select id="history-source">
            <option value="">${t('全部来源')}</option>
            ${[
              ['sale', 'Sale'], ['refund', 'Return'], ['transfer', 'Transfer'],
              ['adjustment', 'Adjustment'], ['staff', 'Staff'], ['app', 'App'],
            ].map(([value, label]) => `<option value="${value}" ${filters.source === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <input id="history-from" type="date" value="${esc(filters.dateFrom)}" aria-label="${t('开始日期')}">
          <input id="history-to" type="date" value="${esc(filters.dateTo)}" aria-label="${t('结束日期')}">
          <button id="history-filter" class="secondary">${t('应用')}</button>
        </div>
        <div class="table-scroll"><table class="store-history">
          <thead><tr><th>Date</th><th>Activity</th><th>Created by</th><th>Product</th><th>Location</th><th>Reference</th></tr></thead>
          <tbody>${result.rows.map((row) => {
            // Multi-variant events expand inline (one product per line) instead
            // of only being visible after clicking into the detail page.
            const product = row.product_count === 1
              ? `<a class="history-event-link" href="/history/${row.id}" title="${t('查看本次修改详情')}"><span class="event-product-title">${esc(row.product_title)}${row.variant_title && row.variant_title !== 'Default Title' ? ` / ${esc(row.variant_title)}` : ''}</span>${codeMeta(row)}<span class="history-arrow" aria-hidden="true">→</span></a>`
              : `<details class="product-expand"><summary><strong>${t('{n} 个商品变体', { n: row.product_count })}</strong></summary>
                  <ul class="product-lines">${(row.products || []).map((p) => `<li><a class="item-link" href="/items/${p.id}">${esc(p.product_title)}${p.variant_title && p.variant_title !== 'Default Title' ? ` / ${esc(p.variant_title)}` : ''}</a> <span class="muted">${esc(p.barcode || p.sku || '')}</span></li>`).join('')}</ul>
                  <a class="subtle-link" href="/history/${row.id}">${t('查看本次修改详情 →')}</a></details>`;
            return `<tr><td>${fmtDate(row.occurred_at)}</td>
              <td><span class="activity">${esc(activityLabel(row.activity))}</span><div>${srcBadge(row.source_type)}</div></td>
              <td>${actorCell(row)}</td><td>${product}</td><td>${esc(row.locations)}</td>
              <td>${referenceCell(row, result.shopHandle)}</td></tr>`;
          }).join('') || `<tr><td colspan="6" class="muted">${t('暂无修改记录')}</td></tr>`}</tbody>
        </table></div>
        <div class="pagination">${result.total > result.pageSize ? `
          <button id="history-prev" class="secondary" ${page <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
          <span>${t('第 {page} / {pages} 页 · 共 {n} 次修改', { page, pages, n: result.total })}</span>
          <button id="history-next" class="secondary" ${page >= pages ? 'disabled' : ''}>${t('下一页')}</button>` : `<span class="muted">${t('共 {n} 次修改', { n: result.total })}</span>`}</div>
      </div>
      <div class="notice">${t('这里显示的是业务层面的修改事件，不再展示系统内部的逐状态技术流水。商品详情页可查看每次修改对 Available、On hand 等状态的具体影响。')}</div>`;
    const applyFilters = () => {
      navigateTo(routeUrl('/history', {
        q: $('#history-q').value.trim(),
        person: $('#history-person').value.trim(),
        source: $('#history-source').value,
        from: $('#history-from').value,
        to: $('#history-to').value,
      }));
    };
    $('#history-filter').onclick = applyFilters;
    $('#history-source').onchange = applyFilters;
    for (const selector of ['#history-q', '#history-person']) {
      $(selector).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') applyFilters();
      });
    }
    const listUrl = (nextPage) => routeUrl('/history', {
      q: filters.q,
      person: filters.person,
      source: filters.source,
      from: filters.dateFrom,
      to: filters.dateTo,
      page: nextPage > 1 ? nextPage : '',
    });
    if ($('#history-prev')) $('#history-prev').onclick = () => navigateTo(listUrl(page - 1));
    if ($('#history-next')) $('#history-next').onclick = () => navigateTo(listUrl(page + 1));
  };
  await load();
}

async function viewHistoryEvent(id) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const { event, rows, adjustment, shopHandle } = await api(`/history/${id}`);
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>${t('修改记录详情')}</h1><p class="muted">${t('查看本次操作涉及的全部商品与 Shopify 返回的库存状态变化。')}</p></div>
    </div>
    <div class="card event-overview">
      <div><span>Date</span><strong>${fmtDate(event.occurred_at)}</strong></div>
      <div><span>Activity</span><strong>${esc(activityLabel(event.activity))}</strong>${srcBadge(event.source_type)}</div>
      <div><span>Created by</span><div>${actorCell(event)}</div></div>
      <div><span>Reference</span><div>${referenceCell(event, shopHandle)}</div></div>
    </div>
    ${adjustment ? `<div class="card event-overview">
      <div><span>Adjustment</span><strong><a class="item-link" href="/adjustments/${adjustment.id}">${esc(adjustment.display_number || t('查看调整单'))}</a></strong></div>
      <div><span>Shopify account</span><strong>${esc(adjustment.login_account_name || '—')}</strong></div>
      <div><span>Recorded by</span><strong>${esc(adjustment.recorded_by_name || '—')}</strong></div>
      <div><span>${t('经手员工')}</span><strong>${esc(adjustment.handled_by_names || '—')}</strong></div>
    </div>${adjustment.notes ? `<div class="notice"><strong>${t('Notes：')}</strong>${esc(adjustment.notes)}</div>` : ''}` : ''}
    <div class="card">
      <div class="card-heading"><div><h2>${t('涉及商品')}</h2><p class="muted compact">${t('共 {n} 个商品 / 仓位组合，Barcode 为主要识别编号。', { n: rows.length })}</p></div></div>
      <div class="table-scroll"><table class="event-detail-table">
        <thead><tr><th>${t('商品')}</th><th>Barcode</th><th>SKU</th><th>Location</th>
          <th class="num">Unavailable</th><th class="num">Committed</th>
          <th class="num">Available</th><th class="num">On hand</th><th class="num">Incoming</th></tr></thead>
        <tbody>${rows.map((row) => {
          const standardMissing = ['unavailable', 'committed', 'available', 'on_hand', 'incoming']
            .every((state) => row[`${state}_delta`] === null || row[`${state}_delta`] === undefined);
          return `<tr>
          <td><a class="item-link" href="/items/${row.item_id}">${productName(row)}</a>
            ${rawStateSummary(row)}
            ${standardMissing ? `<div class="missing-state-note">${t('此工作流事件未返回表中 5 个标准状态；实际数量变化通常记录在同一操作的相邻事件。')}</div>` : ''}
          </td>
          <td><strong>${esc(primaryCode(row))}</strong></td><td>${esc(row.sku || '—')}</td><td>${esc(row.location)}</td>
          <td class="num">${historyDetailValue(row.unavailable_delta, row.unavailable_after)}</td>
          <td class="num">${historyDetailValue(row.committed_delta, row.committed_after)}</td>
          <td class="num">${historyDetailValue(row.available_delta, row.available_after)}</td>
          <td class="num">${historyDetailValue(row.on_hand_delta, row.on_hand_after)}</td>
          <td class="num">${historyDetailValue(row.incoming_delta, row.incoming_after)}</td>
        </tr>`;
        }).join('') || `<tr><td colspan="9" class="muted">${t('该事件没有商品明细')}</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="notice"><strong>${t('“未提供”不是 0：')}</strong>${t('它表示 Shopify 在这条工作流事件中没有返回该库存状态。Transfer 等操作可能拆分成多条相邻事件，只有包含实际数量变化的事件才会显示数字。')}</div>`;
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
// Variant label, empty when it's the meaningless "Default Title".
const variantLabel = (row) =>
  row.variant_title && row.variant_title !== 'Default Title' ? esc(row.variant_title) : '';
const numOrDash = (v) => (v === null || v === undefined ? '—' : v);

async function viewAdjustments(params = routeParams()) {
  const options = await api('/adjustment-options');
  const page = pageNumber(params.get('page'));
  const filters = {
    q: params.get('q') || '',
    status: params.get('status') || '',
    reasonId: params.get('reasonId') || '',
    staffId: params.get('staffId') || '',
  };
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>${t('库存调整')}</h1><p class="muted">${t('建立可审核的 Draft，并在确认后写入 Shopify Available 库存。')}</p></div>
      <div class="button-group"><a class="button secondary" href="/lark-settings">${t('Lark 通知设置')}</a><a class="button secondary" href="/virtual-stock">${t('虚拟库存管理')}</a><button id="adjustments-export" class="secondary">${t('导出 CSV')}</button><a class="button" href="/adjustments/new">${t('新建调整')}</a></div>
    </div>
    <div class="card">
      <div class="adjustment-filters">
        <input id="adjustment-q" type="search" value="${esc(filters.q)}" placeholder="${t('搜索编号、Barcode、SKU 或商品…')}">
        <select id="adjustment-status"><option value="">${t('全部状态')}</option>
          <option value="draft" ${filters.status === 'draft' ? 'selected' : ''}>Draft</option><option value="applying" ${filters.status === 'applying' ? 'selected' : ''}>Submitting</option>
          <option value="applied" ${filters.status === 'applied' ? 'selected' : ''}>Applied</option><option value="archived" ${filters.status === 'archived' ? 'selected' : ''}>Archived</option>
        </select>
        <select id="adjustment-reason"><option value="">${t('全部原因')}</option>${options.reasons.map((reason) => `<option value="${reason.id}" ${filters.reasonId === String(reason.id) ? 'selected' : ''}>${esc(reason.name)}</option>`).join('')}</select>
        <select id="adjustment-staff"><option value="">${t('全部员工')}</option>${options.staff.map((person) => `<option value="${person.id}" ${filters.staffId === String(person.id) ? 'selected' : ''}>${esc(person.display_name)}</option>`).join('')}</select>
        <button id="adjustment-filter" class="secondary">${t('应用')}</button>
      </div>
      <div id="adjustments-out">${t('加载中…')}</div>
      <div id="adjustments-pagination" class="pagination"></div>
    </div>
    <details class="card system-details" id="adjustment-settings">
      <summary>${t('Adjustment reasons 与员工名称')}</summary>
      <div class="settings-grid">
        <section>
          <div class="section-heading"><div><h2>Adjustment reasons</h2><p class="muted compact">${t('停用后不会出现在新调整单中，历史记录仍保留。')}</p></div></div>
          <div class="reason-list">${options.reasons.map((reason) => `<div class="setting-row">
            <input type="text" value="${esc(reason.name)}" data-reason-name="${reason.id}">
            <select data-reason-direction="${reason.id}">
              <option value="any" ${reason.direction === 'any' ? 'selected' : ''}>Increase / decrease</option>
              <option value="in" ${reason.direction === 'in' ? 'selected' : ''}>Increase only</option>
              <option value="out" ${reason.direction === 'out' ? 'selected' : ''}>Decrease only</option>
            </select>
            <label><input type="checkbox" data-reason-active="${reason.id}" ${reason.active ? 'checked' : ''}> Active</label>
            <button class="secondary small-button save-reason" data-id="${reason.id}">${t('保存')}</button>
            <button class="secondary small-button danger delete-reason" data-id="${reason.id}" data-name="${esc(reason.name)}" title="${t('删除')}">${t('删除')}</button>
          </div>`).join('')}</div>
          <div class="setting-row new-reason"><input id="new-reason-name" type="text" placeholder="New reason">
            <select id="new-reason-direction"><option value="any">Increase / decrease</option><option value="in">Increase only</option><option value="out">Decrease only</option></select>
            <button id="add-reason" class="secondary small-button">${t('添加')}</button></div>
        </section>
        <section>
          <div class="section-heading"><div><h2>${t('员工')}</h2><p class="muted compact">${t('调整单里「记录员工 / 经手员工」可选的人。与 Shopify 账号无关——多名员工可共用一个账号。员工离职时取消 Active 即可停用：不再出现在新调整的选择菜单，历史记录照常显示。')}</p></div></div>
          <div class="staff-list">${options.staff.map((person) => `<div class="setting-row ${person.active ? '' : 'inactive-row'}">
            <input type="text" value="${esc(person.display_name)}" data-staff-name="${person.id}" aria-label="${t('员工姓名')}">
            <label class="active-toggle"><input type="checkbox" data-staff-active="${person.id}" ${person.active ? 'checked' : ''}> Active</label>
            <button class="secondary small-button save-staff" data-id="${person.id}">${t('保存')}</button>
            <button class="secondary small-button danger delete-staff" data-id="${person.id}" data-name="${esc(person.display_name)}">${t('删除')}</button>
          </div>`).join('') || `<p class="muted">${t('尚无员工，请在下方添加。')}</p>`}</div>
          <div class="setting-row new-staff">
            <input id="new-staff-name" type="text" placeholder="${t('新员工姓名')}">
            <span></span><span></span>
            <button id="add-staff" class="secondary small-button">${t('添加')}</button>
          </div>
          <div class="section-heading account-section"><div><h2>${t('Shopify 登录账号')}</h2><p class="muted compact">${t('系统自动识别账号 ID。Shopify 不向非 Plus 商店的 App 提供账号邮箱（需 Plus 专属的 read_users 权限），所以请在此手动改成邮箱等易读名称——只需改一次，之后所有记录都会显示这个名称。不参与员工选择，也不能删除。')}</p></div></div>
          <div class="staff-list">${(options.accounts || []).map((acct) => `<div class="setting-row">
            <input type="text" value="${esc(acct.display_name)}" data-staff-name="${acct.id}" aria-label="${t('账号名称')}">
            <span class="muted small">ID ${esc(acct.shopify_user_id || '')}</span>
            <button class="secondary small-button save-staff" data-id="${acct.id}">${t('保存')}</button>
            <span></span>
          </div>`).join('') || `<p class="muted">${t('尚未识别到登录账号。')}</p>`}</div>
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
    $w('#adjustments-out').innerHTML = t('加载中…');
    const params = query();
    params.set('page', page);
    params.set('limit', '25');
    const result = await api(`/adjustments?${params}`);
    $w('#adjustments-out').innerHTML = `<div class="table-scroll"><table class="adjustments-table">
      <colgroup>
        <col class="w-no"><col><col class="w-person"><col class="w-loc">
        <col class="w-qty"><col class="w-qty"><col class="w-date"><col class="w-status">
      </colgroup>
      <thead><tr><th>${t('调整单')}</th><th>${t('备注 / 原因')}</th><th>${t('操作人')}</th><th>${t('仓位')}</th><th>${t('商品')}</th><th>${t('合计')}</th><th>${t('日期')}</th><th>${t('状态')}</th></tr></thead>
      <tbody>${result.rows.map((row) => `<tr>
        <td class="col-no"><a class="item-link" href="/adjustments/${row.id}">${shortAdjustmentNumber(row.number, row.display_number)}</a></td>
        <td class="col-note">${row.notes ? `<div class="note-main">${esc(row.notes)}</div>` : `<div class="note-main muted">${t('（无备注）')}</div>`}<div class="muted xsmall">${esc(row.reason || '—')}</div>${row.apply_error ? `<div class="error xsmall">${esc(row.apply_error)}</div>` : ''}</td>
        <td class="col-person">${esc(row.recorded_by_name || '—')}${row.handled_by_names ? `<div class="muted xsmall">${t('经手：{names}', { names: esc(row.handled_by_names) })}</div>` : ''}</td>
        <td class="col-loc">${esc(row.locations || '—')}</td>
        <td class="col-qty">${row.line_count}</td><td class="col-qty"><span class="${Number(row.total_delta) > 0 ? 'pos' : Number(row.total_delta) < 0 ? 'neg' : ''}">${signed(row.total_delta)}</span></td>
        <td class="col-date">${fmtDateCompact(row.applied_at || row.created_at)}</td>
        <td class="col-status">${adjustmentStatus(row.status)}</td>
      </tr>`).join('') || `<tr><td colspan="8" class="muted">${t('暂无库存调整')}</td></tr>`}</tbody></table></div>`;
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    $w('#adjustments-pagination').innerHTML = result.total > result.pageSize ? `
      <button id="adjustments-prev" class="secondary" ${page <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
      <span>${t('第 {page} / {pages} 页 · 共 {n} 张', { page, pages, n: result.total })}</span>
      <button id="adjustments-next" class="secondary" ${page >= pages ? 'disabled' : ''}>${t('下一页')}</button>` : `<span class="muted">${t('共 {n} 张', { n: result.total })}</span>`;
    const listUrl = (nextPage) => routeUrl('/adjustments', {
      ...filters,
      page: nextPage > 1 ? nextPage : '',
    });
    if ($('#adjustments-prev')) $('#adjustments-prev').onclick = () => navigateTo(listUrl(page - 1));
    if ($('#adjustments-next')) $('#adjustments-next').onclick = () => navigateTo(listUrl(page + 1));
  };
  const filter = () => navigateTo(routeUrl('/adjustments', {
    q: $('#adjustment-q').value.trim(),
    status: $('#adjustment-status').value,
    reasonId: $('#adjustment-reason').value,
    staffId: $('#adjustment-staff').value,
  }));
  $('#adjustment-filter').onclick = filter;
  $('#adjustment-status').onchange = filter;
  $('#adjustment-reason').onchange = filter;
  $('#adjustment-staff').onchange = filter;
  $('#adjustment-q').addEventListener('keydown', (event) => { if (event.key === 'Enter') filter(); });
  $('#adjustments-export').onclick = async (event) => {
    event.target.disabled = true;
    try { await apiDownload(`/adjustments.csv?${query()}`, `inventory-adjustments-${new Date().toISOString().slice(0, 10)}.csv`); }
    catch (error) { alert(t('导出失败：{msg}', { msg: error.message })); }
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
      } catch (error) { alert(t('保存失败：{msg}', { msg: error.message })); button.disabled = false; }
    };
  });
  // Delete reason / staff. The API deactivates instead of deleting when the
  // record is referenced by history, and tells us which happened.
  const wireDelete = (selector, path, label) => {
    document.querySelectorAll(selector).forEach((button) => {
      button.onclick = async () => {
        if (!confirm(t('删除{label}「{name}」？\n若历史记录已使用过它，会自动改为停用以保留历史。', { label, name: button.dataset.name }))) return;
        button.disabled = true;
        try {
          const r = await api(`${path}/${button.dataset.id}`, { method: 'DELETE' });
          if (r.deactivated) alert(t('「{name}」已被 {n} 条历史记录使用，无法删除，已改为停用（不再出现在新调整中）。', { name: button.dataset.name, n: r.usedBy }));
          await viewAdjustments();
          $('#adjustment-settings').open = true;
        } catch (error) { alert(t('删除失败：{msg}', { msg: error.message })); button.disabled = false; }
      };
    });
  };
  wireDelete('.delete-reason', '/adjustment-reasons', t('原因'));
  wireDelete('.delete-staff', '/staff', t('员工'));
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
      } catch (error) { alert(t('保存失败：{msg}', { msg: error.message })); button.disabled = false; }
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
    } catch (error) { alert(t('添加失败：{msg}', { msg: error.message })); event.target.disabled = false; }
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
    } catch (error) { alert(t('添加失败：{msg}', { msg: error.message })); event.target.disabled = false; }
  };
  await load();
}

async function viewAdjustmentForm(id = null) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const [options, detail] = await Promise.all([
    api('/adjustment-options'),
    id ? api(`/adjustments/${id}`) : Promise.resolve(null),
  ]);
  const adjustment = detail?.adjustment;
  if (adjustment && adjustment.status !== 'draft') {
    navigateTo(`/adjustments/${id}`, { replace: true });
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
    <div class="page-heading"><div><h1>${id ? t('编辑 {number}', { number: adjustmentNumber(adjustment.number, adjustment.display_number) }) : t('新建库存调整')}</h1>
      <p class="muted">${t('先保存 Draft；保存不会改变 Shopify 库存。')}</p></div></div>
    <div class="card adjustment-form">
      <div class="form-grid adjustment-basics">
        <label><span>Location</span><select id="draft-location">${options.locations.map((location) => `<option value="${location.id}" ${Number(adjustment?.lines?.[0]?.location_id) === location.id ? 'selected' : ''}>${esc(location.name)}</option>`).join('')}</select></label>
        <label><span>Adjustment reason</span><select id="draft-reason">${options.reasons.filter((reason) => reason.active || reason.id === adjustment?.reason_id).map((reason) => `<option value="${reason.id}" data-direction="${reason.direction}" ${reason.id === adjustment?.reason_id ? 'selected' : ''}>${esc(reason.name)}</option>`).join('')}</select></label>
        <div class="adjustment-people">
          <label><span>${t('Shopify 登录账号（自动识别）')}</span>
            <input type="text" readonly value="${esc(options.currentStaff?.display_name || t('无法识别'))}" title="Shopify user id: ${esc(options.currentStaff?.shopify_user_id || '')}">
            <span class="muted small">${t('多名员工可能共用此账号，因此下面的经办人需手动选择。')}</span>
          </label>
          <label><span>${t('Recorded by（实际做记录的员工）')}</span>
            <select id="draft-recorded">
              <option value="" ${!recordedIsCustom && !recordedStaffId ? 'selected' : ''}>${t('请选择员工…')}</option>
              ${options.staff.filter((person) => person.active).map((person) => `<option value="staff:${person.id}" ${!recordedIsCustom && Number(recordedStaffId) === person.id ? 'selected' : ''}>${esc(person.display_name)}</option>`).join('')}
              <option value="custom" ${recordedIsCustom ? 'selected' : ''}>${t('手动填写姓名…')}</option>
            </select>
            <input id="draft-recorded-custom" type="text" maxlength="120" value="${recordedIsCustom ? esc(adjustment.recorded_by.name) : ''}" placeholder="${t('记录员工姓名')}" ${recordedIsCustom ? '' : 'hidden'}>
          </label>
          <div>
            <label><span>${t('Handled by（拿取/处理商品的人，可多人）')}</span></label>
            <div class="participant-picker">
              <select id="draft-handled">
                ${options.staff.filter((person) => person.active).map((person) => `<option value="staff:${person.id}">${esc(person.display_name)}${person.employee_code ? ` · ${esc(person.employee_code)}` : ''}</option>`).join('')}
                <option value="custom">${t('手动填写姓名…')}</option>
              </select>
              <button id="add-handled" type="button" class="secondary small-button">${t('添加')}</button>
            </div>
            <input id="draft-handled-custom" type="text" maxlength="120" placeholder="${t('经手员工姓名')}" hidden>
            <div id="handled-chips"></div>
          </div>
        </div>
        <label class="notes-field"><span>Notes</span><textarea id="draft-notes" maxlength="10000" rows="4" placeholder="${t('详细填写调整原因、票据编号、处理过程或内部说明')}">${esc(adjustment?.notes || '')}</textarea></label>
        <div class="evidence-field">
          <span>Evidence attachments</span>
          <div class="evidence-picker"><input id="draft-attachments" type="file" multiple accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"><label for="draft-attachments" class="button secondary">${t('添加图片、视频或文件')}</label></div>
          <p class="muted small">${t('每个文件最大 50 MB，每张调整单最多 20 个；保存 Draft 后上传，不会写入 Shopify。')}</p>
          <div id="pending-attachments"></div>
          ${id ? `<div id="existing-attachments">${attachmentListHtml(adjustment.attachments, true)}</div>` : ''}
        </div>
      </div>
      <div class="section-heading adjustment-lines-heading"><div><h2>${t('调整明细')}</h2><p class="muted compact">${t('加入的商品会显示在这里；选择 − 或 +，再输入变化数量。')}</p></div>
        <button id="draft-item-open" type="button">${t('添加商品')}</button></div>
      <div id="draft-lines"></div>
      <div class="form-actions"><a class="button secondary" href="${id ? `/adjustments/${id}` : '/adjustments'}" data-app-back>${t('取消')}</a><button id="save-draft">${t('保存 Draft')}</button></div>
    </div>`;

  const renderHandled = () => {
    $w('#handled-chips').innerHTML = handledBy.length
      ? `<div class="participant-chips">${handledBy.map((person, index) => `<span class="participant-chip">${esc(person.name)}<button type="button" data-remove-handled="${index}" aria-label="${t('移除')}">×</button></span>`).join('')}</div>`
      : `<div class="muted small">${t('尚未添加经手员工。')}</div>`;
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
      if (!name) return alert(t('请填写经手员工姓名'));
      person = { staffId: null, name };
    } else {
      const staffId = Number(selected.replace('staff:', ''));
      const staff = options.staff.find((entry) => entry.id === staffId);
      person = { staffId, name: staff?.display_name || '' };
    }
    const duplicate = handledBy.some((entry) => person.staffId
      ? Number(entry.staffId) === person.staffId
      : !entry.staffId && entry.name.toLocaleLowerCase() === person.name.toLocaleLowerCase());
    if (duplicate) return alert(t('该经手员工已添加'));
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
      ? `<div class="pending-files">${pendingFiles.map((file, index) => `<span>${esc(file.name)} · ${formatBytes(file.size)} <button class="pending-file-remove" data-pending-remove="${index}" aria-label="${t('移除附件')}">×</button></span>`).join('')}</div>`
      : '';
    document.querySelectorAll('[data-pending-remove]').forEach((button) => {
      button.onclick = () => { pendingFiles.splice(Number(button.dataset.pendingRemove), 1); renderPendingFiles(); };
    });
  };
  const renderLines = () => {
    lines.forEach(normalizeLineDirection);
    const direction = selectedDirection();
    $w('#draft-lines').innerHTML = lines.length ? `<div class="table-scroll"><table class="adjustment-lines">
      <thead><tr><th>${t('商品')}</th><th class="num">Before</th><th class="num">Change (+ / −)</th><th class="num">After</th><th></th></tr></thead>
      <tbody>${lines.map((line, index) => `<tr>
        <td><span class="event-product-title">${productName(line)}</span>${codeMeta(line)}</td>
        <td class="num">${line.available}</td>
        <td class="num"><div class="delta-control">
          <button type="button" class="delta-sign ${line.delta < 0 ? 'active minus' : ''}" data-sign="-1" data-index="${index}" ${direction === 'in' ? 'disabled' : ''} aria-label="${t('减少库存')}">−</button>
          <input class="delta-input" type="number" min="1" step="1" value="${Math.abs(line.delta)}" data-magnitude="${index}" aria-label="${t('变化数量')}">
          <button type="button" class="delta-sign ${line.delta > 0 ? 'active plus' : ''}" data-sign="1" data-index="${index}" ${direction === 'out' ? 'disabled' : ''} aria-label="${t('增加库存')}">+</button>
        </div></td>
        <td class="num"><strong class="${line.delta > 0 ? 'pos' : line.delta < 0 ? 'neg' : ''}">${line.available + Number(line.delta || 0)}</strong></td>
        <td><button class="secondary small-button remove-adjustment-line" data-index="${index}">${t('移除')}</button></td>
      </tr>`).join('')}</tbody></table></div>` : `<div class="empty-state">${t('尚未添加商品。')}</div>`;
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
  // can be added in one go.
  const addRows = (rows) => {
    const reason = $('#draft-reason').selectedOptions[0];
    const delta = reason?.dataset.direction === 'out' ? -1 : 1;
    let added = 0;
    for (const row of rows) {
      if (lines.some((line) => line.itemId === row.id)) continue;
      lines.push({ itemId: row.id, ...row, available: Number(row.available), delta });
      added++;
    }
    renderLines();
    return added;
  };

  // Search and results live in one modal. The form itself only exposes a clear
  // “添加商品” action, while the adjustment lines remain the source of truth.
  const openPicker = () => {
    const inDraft = (id) => lines.some((l) => l.itemId === id);
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop';
    dialog.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${t('选择商品')}">
        <div class="modal-head">
          <strong>${t('添加商品')}</strong>
          <span class="muted small" id="picker-summary">${t('按 Barcode、SKU、商品标题或 Brand 搜索')}</span>
          <button class="icon-button" id="picker-close" aria-label="${t('关闭')}">×</button>
        </div>
        <div class="modal-search">
          <input id="picker-search" type="search" placeholder="${t('输入 Barcode / SKU / 商品 / Brand')}" autocomplete="off">
          <button id="picker-find" type="button">${t('搜索')}</button>
        </div>
        <div class="modal-toolbar" id="picker-toolbar" hidden>
          <label><input type="checkbox" id="picker-all"> ${t('本页全选')}</label>
          <span class="muted small" id="picker-count"></span>
        </div>
        <div class="modal-body" id="picker-results"><div class="picker-empty">${t('输入搜索内容，然后点击“搜索”。')}</div></div>
        <div class="modal-pagination" id="picker-pagination" hidden>
          <button class="secondary" id="picker-prev" type="button">${t('上一页')}</button>
          <span class="muted small" id="picker-page-info"></span>
          <button class="secondary" id="picker-next" type="button">${t('下一页')}</button>
        </div>
        <div class="modal-foot">
          <button class="secondary" id="picker-cancel">${t('取消')}</button>
          <button id="picker-add" disabled>${t('加入所选')}</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    let resultRows = [];
    let checks = [];
    let searchTerm = '';
    let currentPage = 1;
    let totalPages = 0;
    let totalResults = 0;
    const selectedRows = new Map();
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    const close = () => {
      document.removeEventListener('keydown', onKey);
      dialog.remove();
    };
    const refresh = () => {
      const n = selectedRows.size;
      const checkedOnPage = checks.filter((checkbox) => checkbox.checked).length;
      dialog.querySelector('#picker-add').disabled = !n;
      dialog.querySelector('#picker-add').textContent = n ? t('加入所选（{n}）', { n }) : t('加入所选');
      dialog.querySelector('#picker-count').textContent = t('已选 {n} / 共 {total} 个结果', { n, total: totalResults });
      dialog.querySelector('#picker-all').checked = Boolean(checks.length) && checkedOnPage === checks.length;
    };
    const showRows = (result, term) => {
      resultRows = result.rows;
      currentPage = Number(result.page || 1);
      totalPages = Number(result.totalPages || 0);
      totalResults = Number(result.total || result.rows.length);
      dialog.querySelector('#picker-summary').textContent = t('「{term}」共 {n} 个变体', { term, n: totalResults });
      dialog.querySelector('#picker-toolbar').hidden = !result.rows.length;
      dialog.querySelector('#picker-pagination').hidden = totalPages <= 1;
      dialog.querySelector('#picker-page-info').textContent = t('第 {page} / {pages} 页', { page: currentPage, pages: totalPages });
      dialog.querySelector('#picker-prev').disabled = currentPage <= 1;
      dialog.querySelector('#picker-next').disabled = currentPage >= totalPages;
      dialog.querySelector('#picker-results').innerHTML = result.rows.length ? result.rows.map((row) => `
        <label class="picker-row ${inDraft(row.id) ? 'already' : ''}">
          <input type="checkbox" class="picker-check" value="${row.id}" ${inDraft(row.id) || selectedRows.has(row.id) ? 'checked' : ''} ${inDraft(row.id) ? 'disabled' : ''}>
          <span class="picker-main"><strong>${esc(row.product_title)}</strong>${variantLabel(row) ? ` <span class="variant-tag">${variantLabel(row)}</span>` : ''}<span class="picker-codes">${esc(row.barcode || '—')}${row.sku ? ` · ${esc(row.sku)}` : ''}${row.vendor ? ` · ${esc(row.vendor)}` : ''}</span></span>
          <span class="picker-avail">${inDraft(row.id) ? t('已加入') : `Available <strong>${row.available}</strong>`}</span>
        </label>`).join('') : `<div class="picker-empty">${t('该仓位没有匹配且可调整的商品。')}</div>`;
      checks = [...dialog.querySelectorAll('.picker-check:not([disabled])')];
      checks.forEach((checkbox) => {
        checkbox.onchange = () => {
          const row = resultRows.find((entry) => entry.id === Number(checkbox.value));
          if (checkbox.checked) selectedRows.set(row.id, row);
          else selectedRows.delete(row.id);
          refresh();
        };
      });
      refresh();
    };
    const findItems = async (page = 1, resetSelection = false) => {
      const input = dialog.querySelector('#picker-search');
      const button = dialog.querySelector('#picker-find');
      const term = input.value.trim();
      if (!term) { input.focus(); return; }
      if (resetSelection || term !== searchTerm) selectedRows.clear();
      searchTerm = term;
      button.disabled = true;
      dialog.querySelector('#picker-toolbar').hidden = true;
      dialog.querySelector('#picker-pagination').hidden = true;
      dialog.querySelector('#picker-results').innerHTML = `<div class="picker-empty">${t('搜索中…')}</div>`;
      try {
        const result = await api(`/adjustment-items?locationId=${encodeURIComponent($('#draft-location').value)}&q=${encodeURIComponent(term)}&page=${page}&limit=50`);
        showRows(result, term);
      } catch (error) {
        resultRows = [];
        checks = [];
        dialog.querySelector('#picker-summary').textContent = t('搜索失败');
        dialog.querySelector('#picker-results').innerHTML = `<div class="picker-empty error">${esc(error.message)}</div>`;
        refresh();
      } finally { button.disabled = false; }
    };
    dialog.querySelector('#picker-all').onchange = (e) => {
      checks.forEach((checkbox) => {
        checkbox.checked = e.target.checked;
        const row = resultRows.find((entry) => entry.id === Number(checkbox.value));
        if (checkbox.checked) selectedRows.set(row.id, row);
        else selectedRows.delete(row.id);
      });
      refresh();
    };
    dialog.querySelector('#picker-close').onclick = close;
    dialog.querySelector('#picker-cancel').onclick = close;
    dialog.onclick = (e) => { if (e.target === dialog) close(); };
    document.addEventListener('keydown', onKey);
    dialog.querySelector('#picker-find').onclick = () => findItems(1, true);
    dialog.querySelector('#picker-prev').onclick = () => findItems(currentPage - 1);
    dialog.querySelector('#picker-next').onclick = () => findItems(currentPage + 1);
    dialog.querySelector('#picker-search').onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); findItems(1, true); }
    };
    dialog.querySelector('#picker-add').onclick = () => {
      addRows([...selectedRows.values()]);
      close();
    };
    refresh();
    dialog.querySelector('#picker-search').focus();
  };
  $('#draft-item-open').onclick = openPicker;
  $('#draft-reason').onchange = () => {
    lines.forEach(normalizeLineDirection);
    renderLines();
  };
  $('#draft-attachments').onchange = (event) => {
    const selected = [...event.target.files];
    const tooLarge = selected.find((file) => file.size > 50 * 1024 * 1024);
    if (tooLarge) alert(t('{name} 超过 50 MB，未添加。', { name: tooLarge.name }));
    const room = 20 - Number(adjustment?.attachments?.length || 0) - pendingFiles.length;
    pendingFiles.push(...selected.filter((file) => file.size > 0 && file.size <= 50 * 1024 * 1024).slice(0, Math.max(0, room)));
    if (selected.length > room) alert(t('每张调整单最多保存 20 个附件。'));
    event.target.value = '';
    renderPendingFiles();
  };
  if (id) {
    await wireAttachmentActions(id, adjustment.attachments);
    document.querySelectorAll('[data-attachment-delete]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm(t('从这个 Draft 中移除该附件？'))) return;
        button.disabled = true;
        try {
          await api(`/adjustments/${id}/attachments/${button.dataset.attachmentDelete}`, { method: 'DELETE' });
          await viewAdjustmentForm(id);
        } catch (error) { alert(t('移除失败：{msg}', { msg: error.message })); button.disabled = false; }
      };
    });
  }
  $('#draft-location').onchange = () => {
    if (!lines.length || confirm(t('更改仓位会清空当前调整明细，是否继续？'))) {
      lines = [];
      renderLines();
    } else {
      $('#draft-location').value = String(adjustment?.lines?.[0]?.location_id || options.locations[0]?.id || '');
    }
  };
  $('#save-draft').onclick = async (event) => {
    const recordedValue = $('#draft-recorded').value;
    if (!recordedValue) {
      alert(t('请选择「Recorded by」实际做记录的员工。'));
      return;
    }
    if (recordedValue === 'custom' && !$('#draft-recorded-custom').value.trim()) {
      alert(t('请填写记录员工姓名。'));
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
        alert(t('Draft 已保存，但以下附件上传失败：\n{errors}', { errors: uploadErrors.join('\n') }));
        navigateTo(`/adjustments/${result.id}/edit`, { replace: true });
        return;
      }
      navigateTo(`/adjustments/${result.id}`);
    } catch (error) { alert(t('保存失败：{msg}', { msg: error.message })); event.target.disabled = false; }
  };
  toggleRecordedCustom();
  toggleHandledCustom();
  renderHandled();
  renderPendingFiles();
  renderLines();
}

async function viewAdjustment(id) {
  app.innerHTML = `<div class="card">${t('加载中…')}</div>`;
  const { adjustment } = await api(`/adjustments/${id}`);
  const total = adjustment.lines.reduce((sum, line) => sum + Number(line.delta), 0);
  const canApply = adjustment.status === 'draft' || adjustment.status === 'applying';
  app.innerHTML = `
    <div class="page-heading"><div><h1>${adjustmentNumber(adjustment.number, adjustment.display_number)} ${adjustmentStatus(adjustment.status)}</h1></div>
      <div class="button-group">${adjustment.status === 'draft' ? `<a class="button secondary" href="/adjustments/${id}/edit">${t('编辑 Draft')}</a>` : ''}
        ${canApply ? `<button id="apply-adjustment">${adjustment.status === 'applying' ? t('安全重试提交') : t('提交到 Shopify')}</button>` : ''}
        ${canApply ? `<label class="notify-toggle" title="${t('取消勾选后只调整 Shopify，不发送 Lark 群通知')}"><input type="checkbox" id="notify-lark" checked><span>${t('通知')}</span></label>` : ''}
        ${adjustment.status === 'applied' && !adjustment.reversed_by?.length && !adjustment.reversal_of ? `<button id="reverse-adjustment" class="secondary">${t('撤销这张调整单')}</button>` : ''}
        ${['draft', 'applied'].includes(adjustment.status) ? `<button id="archive-adjustment" class="secondary">${t('归档')}</button>` : ''}
      </div></div>
    ${adjustment.reversal_of ? `<div class="notice"><strong>${t('这是一张撤销单。')}</strong>${t('它把 {number} 的调整数量原样反向抵消。', { number: `<a href="/adjustments/${adjustment.reversal_of.id}">${esc(adjustmentNumber(adjustment.reversal_of.number, adjustment.reversal_of.display_number))}</a>` })}</div>` : ''}
    ${adjustment.reversed_by?.length ? `<div class="notice"><strong>${t('这张调整单已被撤销。')}</strong>${t('撤销单：{numbers}', { numbers: adjustment.reversed_by.map((row) => `<a href="/adjustments/${row.id}">${esc(adjustmentNumber(row.number, row.display_number))}</a>${row.status === 'draft' ? `（${t('草稿，尚未提交')}）` : ''}`).join(listSep) })}</div>` : ''}
    ${adjustment.apply_error ? `<div class="notice adjustment-error"><strong>${t('上次提交信息：')}</strong>${esc(adjustment.apply_error)}</div>` : ''}
    ${adjustment.lark_notify_error ? `<div class="notice adjustment-error"><strong>${t('库存调整已成功，但 Lark 通知发送失败：')}</strong>${esc(adjustment.lark_notify_error)} <button id="retry-lark-notification" class="secondary">${t('重试发送')}</button></div>` : ''}
    ${adjustment.notes ? `<div class="card adjustment-notes-card"><span class="field-label">${t('调整备注 Notes')}</span><p class="notes-body">${esc(adjustment.notes)}</p></div>` : ''}
    <div class="card event-overview adjustment-overview">
      <div><span>${t('调整原因 Reason')}</span><strong>${esc(adjustment.reason || '—')}</strong></div>
      <div><span>${t('记录员工 Recorded by')}</span><strong>${esc(adjustment.recorded_by?.name || '—')}</strong></div>
      <div><span>${t('经手员工 Handled by')}</span><strong>${esc(adjustment.handled_by?.map((person) => person.name).join(', ') || '—')}</strong></div>
      <div><span>${t('仓位 Location')}</span><strong>${esc([...new Set(adjustment.lines.map((l) => l.location))].join(', ') || '—')}</strong></div>
      <div><span>${t('合计变化 Total change')}</span><strong class="${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}">${signed(total)}</strong></div>
      <div><span>${adjustment.applied_at ? t('完成时间 Applied') : t('创建时间 Created')}</span><strong>${fmtDate(adjustment.applied_at || adjustment.created_at)}</strong></div>
      <div><span>${t('Shopify 登录账号')}</span><strong>${esc(adjustment.created_by_account_name || adjustment.login_account_name || '—')}</strong></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>${t('调整明细')}</h2><p class="muted compact">${t('共 {n} 个商品/仓位；数量均为 Available。', { n: adjustment.lines.length })}${stockyOriginalNo(adjustment.display_number) ? t('Stocky 导出不含调整前/后数量，故 Before/After 显示为 —。') : ''}</p></div></div>
      <div class="table-scroll"><table class="adjustment-lines detail-lines">
        <colgroup><col><col class="w-variant"><col class="w-code"><col class="w-n"><col class="w-n"><col class="w-n"></colgroup>
        <thead><tr><th>${t('商品')}</th><th>${t('变体')}</th><th>Barcode / SKU</th><th>Before</th><th>Change</th><th>After</th></tr></thead>
        <tbody>${adjustment.lines.length ? adjustment.lines.map((line) => `<tr>
          <td><a class="item-link" href="/items/${line.item_id}">${esc(line.product_title || t('(无标题)'))}</a>${line.source === 'local' ? ` <span class="badge">${t('已删除')}</span>` : ''}</td>
          <td>${variantLabel(line) || '<span class="muted">—</span>'}</td>
          <td><strong>${esc(line.barcode || '—')}</strong>${line.sku ? `<div class="muted small">${esc(line.sku)}</div>` : ''}</td>
          <td class="col-n">${numOrDash(line.qty_before)}</td><td class="col-n"><strong class="${line.delta > 0 ? 'pos' : 'neg'}">${signed(line.delta)}</strong></td>
          <td class="col-n"><strong>${numOrDash(line.qty_after)}</strong>${adjustment.status === 'draft' && line.qty_before !== null && Number(line.current_available) !== Number(line.qty_before) ? `<div class="warning small">${t('当前 {n}，提交时会重新校验', { n: line.current_available })}</div>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="6" class="muted">${t('此调整单没有商品明细（导入时商品无法识别）')}</td></tr>`}</tbody>
      </table></div>
      <div class="adjustment-evidence">
        <strong>Evidence attachments</strong>
        ${attachmentListHtml(adjustment.attachments)}
      </div>
    </div>
    ${canApply ? `<div class="notice"><strong>${t('提交前确认：')}</strong>${t('这一步会真实改变 Shopify Available 库存。系统会先核对最新数量；如库存已被其他订单、员工或 App 修改，提交会停止并要求重新确认。')}</div>` : ''}`;
  await wireAttachmentActions(id, adjustment.attachments);
  if ($('#apply-adjustment')) $('#apply-adjustment').onclick = async (event) => {
    const notifyLark = $('#notify-lark')?.checked !== false;
    const message = adjustment.status === 'applying'
      ? t('将使用同一个幂等键安全重试，不会重复调整。{notify}是否继续？', { notify: notifyLark ? t('成功后会发送 Lark 通知。') : t('成功后不发送 Lark 通知。') })
      : t('即将把 {n} 个商品的 Available 库存合计调整 {delta}。这会真实写入 Shopify，{notify}，是否确认？', { n: adjustment.lines.length, delta: signed(total), notify: notifyLark ? t('成功后会发送 Lark 通知') : t('成功后不发送 Lark 通知') });
    if (!confirm(message)) return;
    event.target.disabled = true;
    event.target.textContent = t('提交中…');
    if ($('#notify-lark')) $('#notify-lark').disabled = true;
    try {
      const result = await api(`/adjustments/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ notifyLark }),
      });
      if (result.larkNotification?.error) {
        alert(t('库存调整已成功，但 Lark 通知发送失败：{msg}', { msg: result.larkNotification.error }));
      }
      await viewAdjustment(id);
    } catch (error) {
      alert(t('提交失败：{msg}', { msg: error.message }));
      await viewAdjustment(id);
    }
  };
  if ($('#retry-lark-notification')) $('#retry-lark-notification').onclick = async (event) => {
    event.target.disabled = true;
    event.target.textContent = t('发送中…');
    try {
      await api(`/adjustments/${id}/notify-lark`, { method: 'POST' });
      await viewAdjustment(id);
    } catch (error) {
      alert(t('Lark 通知发送失败：{msg}', { msg: error.message }));
      await viewAdjustment(id);
    }
  };
  if ($('#reverse-adjustment')) $('#reverse-adjustment').onclick = async (event) => {
    if (!confirm(t('将生成一张数量相反的草稿单（合计 {delta}），用来抵消这张调整单。草稿不会立刻改变 Shopify，你可以先修改数量或删除某些商品，确认无误后再提交。', { delta: signed(-total) }))) return;
    event.target.disabled = true;
    try {
      const { id: draftId } = await api(`/adjustments/${id}/reverse`, { method: 'POST' });
      navigateTo(`/adjustments/${draftId}/edit`);
    } catch (error) { alert(t('生成撤销单失败：{msg}', { msg: error.message })); event.target.disabled = false; }
  };
  if ($('#archive-adjustment')) $('#archive-adjustment').onclick = async (event) => {
    if (!confirm(t('归档后调整单将锁定，不能再次编辑或提交，是否继续？'))) return;
    event.target.disabled = true;
    try {
      await api(`/adjustments/${id}/archive`, { method: 'POST' });
      await viewAdjustment(id);
    } catch (error) { alert(t('归档失败：{msg}', { msg: error.message })); event.target.disabled = false; }
  };
}

async function viewSearch(query) {
  const term = String(query || '').trim();
  if (!term) {
    app.innerHTML = `<div class="card"><p class="muted">${t('请输入商品、Barcode、SKU、人员、订单、调拨或调整编号。')}</p></div>`;
    return;
  }
  app.innerHTML = `<div class="card">${t('搜索中…')}</div>`;
  const result = await api(`/search?q=${encodeURIComponent(term)}`);
  $('#global-search-input').value = term;
  const section = (title, rows, render) => `<section class="card search-section">
    <h2>${title}</h2><div class="muted result-count">${rows.length ? t('{n} 个结果', { n: rows.length }) : t('没有匹配结果')}</div>
    ${rows.length ? `<div class="search-result-list">${rows.map(render).join('')}</div>` : ''}
  </section>`;
  app.innerHTML = `
    <div class="page-heading"><div><h1>${t('搜索结果')}</h1><p class="muted">${t('“{term}” 的商品、人员与操作记录。', { term: esc(term) })}</p></div></div>
    ${section(t('商品'), result.products, (row) => `<a class="search-result-row" href="/items/${row.id}">
      <div><span class="event-product-title">${productName(row)}</span>${codeMeta(row)}</div>
      <div>Available <strong>${row.available}</strong></div><span class="arrow">→</span>
    </a>`)}
    ${section(t('库存调整'), result.adjustments, (row) => `<a class="search-result-row" href="/adjustments/${row.id}">
      <div><strong>${esc(adjustmentNumber(row.number, row.display_number))}</strong><div class="muted small">${esc(row.reason || '—')}</div></div>
      <div>${esc(row.recorded_by_name || row.login_account_name || '—')} · ${fmtDate(row.created_at)}</div><span class="arrow">→</span>
    </a>`)}
    ${section(t('修改记录'), result.history, (row) => `<a class="search-result-row" href="/history/${row.id}">
      <div><strong>${esc(activityLabel(row.activity))}</strong><div class="muted small">${row.product_count === 1 ? productName(row) : t('{n} 个商品变体', { n: row.product_count })}</div></div>
      <div>${referenceCell(row, result.shopHandle)}<div class="muted small">${fmtDate(row.occurred_at)}</div></div><span class="arrow">→</span>
    </a>`)}
    ${section(t('人员'), result.people, (row) => `<div class="search-result-row">
      <div><strong>${esc(row.display_name)}</strong><div class="muted small">${esc(row.employee_code || t('无员工编号'))}</div></div>
      <div class="muted">${row.shopify_user_id ? `Shopify account ${esc(row.shopify_user_id)}` : t('本地员工资料')}</div><span></span>
    </div>`)}`;
}

// ---- router ----
async function route() {
  navGeneration++;
  clearMediaObjectUrls();
  const path = location.pathname === '/' ? '/dashboard' : location.pathname.replace(/\/$/, '');
  const params = routeParams();
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', path.startsWith(`/${a.dataset.nav}`)));
  const sectionTitle = path.startsWith('/items') ? t('产品')
    : path.startsWith('/history') ? t('库存历史')
      : path.startsWith('/adjustments') ? t('手动调整')
        : path.startsWith('/search') ? t('搜索')
          : path.startsWith('/system') ? t('系统状态')
            : path.startsWith('/virtual-stock') ? t('虚拟库存')
              : path.startsWith('/lark-settings') ? t('Lark 通知设置')
                : t('首页');
  document.title = `${sectionTitle} · Inventory`;
  syncNavigationControls();
  try {
    const m = path.match(/^\/items\/(\d+)$/);
    if (m) return await viewItem(m[1], params);
    const historyEvent = path.match(/^\/history\/(\d+)$/);
    if (historyEvent) return await viewHistoryEvent(historyEvent[1]);
    const adjustmentEdit = path.match(/^\/adjustments\/(\d+)\/edit$/);
    if (adjustmentEdit) return await viewAdjustmentForm(adjustmentEdit[1]);
    const adjustment = path.match(/^\/adjustments\/(\d+)$/);
    if (adjustment) return await viewAdjustment(adjustment[1]);
    if (path === '/adjustments/new') return await viewAdjustmentForm();
    if (path === '/search') return await viewSearch(params.get('q') || '');
    if (path === '/virtual-stock') return await viewVirtualStock(params);
    if (path === '/lark-settings') return await viewLarkSettings();
    if (path === '/local-items') return await viewLocalItems(params);
    if (path === '/items') return await viewItems(params);
    if (path === '/history') return await viewHistory(params);
    if (path === '/adjustments') return await viewAdjustments(params);
    if (path === '/system') return await viewSystem();
    if (path === '/dashboard') return await viewDashboard(params);
    navigateTo('/dashboard', { replace: true });
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
  } finally {
    syncNavigationControls();
  }
}

navigationController = window.InventoryNavigation.create();
navigationController.initialize();

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest('a[href]');
  if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || !navigationController.isAppPath(url.pathname)) return;
  event.preventDefault();
  const target = `${url.pathname}${url.search}`;
  if (anchor.hasAttribute('data-app-back')) {
    navigationController.back(target);
    syncNavigationControls();
    route();
    return;
  }
  navigateTo(target);
}, true);

$('#app-back').onclick = () => {
  navigationController.back(parentRoute() || '/dashboard');
  syncNavigationControls();
  route();
};
$('#global-search').onsubmit = (event) => {
  event.preventDefault();
  const query = $('#global-search-input').value.trim();
  if (query) navigateTo(routeUrl('/search', { q: query }));
};
window.addEventListener('popstate', route);
route();
