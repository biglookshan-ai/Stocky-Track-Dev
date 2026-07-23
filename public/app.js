// Embedded SPA: business-facing inventory audit with technical health tucked
// behind an explicit system-status section.
// App Bridge (CDN) provides window.shopify.idToken() for session tokens.

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

async function api(path, opts = {}) {
  let token = '';
  try { token = await window.shopify.idToken(); }
  catch { throw new Error('请从 Shopify 后台打开本应用（App Bridge 未初始化）'); }
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '—';

const SOURCE_LABEL = {
  sale: 'Sale', refund: 'Return', adjustment: 'Adjustment', stocktake: 'Stocktake',
  import: 'Historical import', reconciliation: 'Reconciliation', external_app: 'App',
  admin_manual: 'Staff', order: 'Order', transfer: 'Transfer',
  unknown: 'Pending attribution', bundle_op: 'Bundle',
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
  const ref = gidParts(row.reference_document_uri);
  const type = row.reference_document_type || ref?.type;
  const id = row.reference_document_id || ref?.id;
  if (!type && !id) return '<span class="muted">—</span>';
  const labels = { Order: 'Order', PurchaseOrder: 'Purchase order', Transfer: 'Transfer' };
  const label = labels[type] || String(type || 'Reference').replace(/([a-z])([A-Z])/g, '$1 $2');
  if (type === 'Order' && id && shopHandle) {
    const url = `https://admin.shopify.com/store/${encodeURIComponent(shopHandle)}/orders/${encodeURIComponent(id)}`;
    return `<a class="reference-link" href="${url}" target="_blank" rel="noopener">${esc(label)} #${esc(id)} ↗</a>`;
  }
  return `${esc(label)}${id ? ` #${esc(id)}` : ''}`;
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

// ---- views ----

async function viewDashboard() {
  const s = await api('/status');
  const sync = s.initialSync;
  const snap = s.lastSnapshot;
  const history = s.historySync;
  const backfill = s.historyBackfill;
  const hasAttention = s.webhookBacklog > 20 || s.pendingAttribution > 100 || s.openAlerts > 0;
  const coverage = s.events.first ? `${new Date(s.events.first).toLocaleDateString('zh-CN')} 至今` : '尚无记录';
  app.innerHTML = `
    <div class="page-heading">
      <div><h1>库存概览</h1><p class="muted">查看商品、修改记录和数据同步状态。</p></div>
    </div>
    <div class="grid overview-grid">
      <a class="stat stat-link" href="#/items"><div class="n">${s.items.n}</div><div class="l">商品 / SKU</div><div class="hint">查看商品与各仓库存</div></a>
      <a class="stat stat-link" href="#/history"><div class="n">${s.events.n}</div><div class="l">修改记录</div><div class="hint">按一次操作合并显示</div></a>
      <div class="stat"><div class="n range">${coverage}</div><div class="l">已保存的历史范围</div><div class="hint">本地记录长期保留</div></div>
      <div class="stat ${hasAttention ? 'warn' : 'ok'}"><div class="n">${hasAttention ? '需复核' : '正常'}</div><div class="l">系统状态</div><div class="hint">${hasAttention ? `${s.openAlerts} 条对账提醒` : '实时记录与对账正常'}</div></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>数据同步</h2><p class="muted compact">系统自动接收 Shopify 修改，并每天核对库存。</p></div>
        <span class="status-pill ${backfill?.running ? 'running' : 'success'}">${backfill?.running ? '历史同步中' : '自动运行中'}</span>
      </div>
      <div class="sync-list">
        <div><strong>实时修改记录</strong><div class="muted">Webhook 已${s.webhooksRegistered ? '启用' : '未启用'}；新修改通常几秒内出现。</div></div>
        <div><strong>每日库存核对</strong><div class="muted">${snap ? `上次完成 ${fmtDate(snap.finishedAt || snap.snapDate)}，自动修正 ${snap.driftHealed} 处差异。` : '尚未完成首次核对。'}</div></div>
        <div><strong>历史记录</strong><div class="muted">${backfill?.running
          ? `正在读取 Shopify 最近 180 天，已读取 ${backfill.fetched || 0} 行。`
          : backfill?.error ? `同步已暂停：${esc(backfill.error)}`
          : backfill?.finishedAt ? `最近 180 天已同步完成（${fmtDate(backfill.finishedAt)}）。` : '尚未同步 Shopify 最近 180 天。'}</div></div>
      </div>
    </div>
    <details class="card system-details">
      <summary>系统状态说明 ${hasAttention ? `<span class="badge unknown">${s.openAlerts} 条需复核</span>` : ''}</summary>
      <div class="health-grid">
        <div><strong>实时接收队列：${s.webhookBacklog}</strong><p>Shopify 已发送、应用尚未处理的事件。通常应为 0，短暂增加后会自动清空。</p></div>
        <div><strong>归因处理中：${s.pendingAttribution}</strong><p>数量变化已保存，系统正在匹配对应的订单、员工或 App；不会影响库存记录。</p></div>
        <div><strong>对账提醒：${s.openAlerts}</strong><p>每日核对发现本地推算与 Shopify 实际值曾不同；数量已自动修正，提醒保留供人工复核。</p></div>
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
              ? `❌ 部分注册失败（${s.webhooksRegistered.results.filter((r) => !r.ok).map((r) => esc(r.topic)).join('、')}）`
              : `✅ 已注册（${fmtDate(s.webhooksRegistered.at)}）`
            : '未注册'}</span>
      </div>
      <div class="row">
        <button id="btn-snapshot" class="secondary">立即核对库存</button>
        <span class="muted">${s.snapshotError?.error
          ? `❌ ${esc(s.snapshotError.error)}`
          : snap ? `上次快照 ${snap.snapDate}：${snap.snapshotRows} 行，修复漂移 ${snap.driftHealed}` : '尚无快照'}</span>
      </div>
      <div class="row">
        <button id="btn-history" class="secondary">同步 Shopify 最近 180 天</button>
        <span class="muted">${backfill ? backfill.running ? `⏳ 历史回填中… 已读取 ${backfill.fetched || 0} 行` : backfill.error ? `❌ ${esc(backfill.error)}` : `历史回填完成 ${fmtDate(backfill.finishedAt)}：新增 ${backfill.inserted || 0}` : '尚未回填'}
        ${history?.finishedAt ? ` · 实时归因 ${fmtDate(history.finishedAt)}` : ''}</span>
      </div>
      <p class="muted compact">这些工具仅用于安装、恢复或人工复核；日常使用无需点击。</p>
    </details>
    <div class="notice"><strong>历史范围说明：</strong>Shopify 商品 Adjustment history 页面提供最近 180 天。本应用会永久保存已经采集或导入的记录；要补齐更早的 Stocky 历史，需要后续导入 Stocky 导出文件。</div>`;
  const guard = (fn) => async (e) => {
    e.target.disabled = true;
    try { await fn(e); }
    catch (err) { alert(`操作失败：${err.message}`); e.target.disabled = false; }
  };
  $('#btn-sync').onclick = guard(async () => { await api('/setup/sync', { method: 'POST' }); setTimeout(viewDashboard, 1500); });
  $('#btn-webhooks').onclick = guard(async () => {
    const { results } = await api('/setup/webhooks', { method: 'POST' });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) alert(`部分 topic 注册失败：\n${failed.map((f) => `${f.topic}: ${JSON.stringify(f.errors)}`).join('\n')}`);
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
}

async function viewItems() {
  app.innerHTML = `
    <div class="card">
      <div class="row">
        <input type="search" id="q" placeholder="搜索标题 / SKU / 条码 / 品牌…">
        <button id="btn-search" class="secondary">搜索</button>
      </div>
      <div id="items-out">输入关键词搜索，或直接点搜索看前 100 个。</div>
    </div>`;
  const run = async () => {
    $('#items-out').innerHTML = '加载中…';
    try {
      const { rows } = await api(`/items?q=${encodeURIComponent($('#q').value)}`);
      $('#items-out').innerHTML = rows.length ? `
        <table><thead><tr><th>商品</th><th>SKU</th><th>条码</th><th>品牌</th><th class="num">可用</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><a class="item-link" href="#/items/${r.id}">${esc(r.product_title)}${r.variant_title && r.variant_title !== 'Default Title' ? ` / ${esc(r.variant_title)}` : ''}</a>${r.source === 'local' ? ' <span class="badge">本地</span>' : ''}</td>
          <td>${esc(r.sku)}</td><td>${esc(r.barcode)}</td><td>${esc(r.vendor)}</td>
          <td class="num">${r.total_available}</td></tr>`).join('')}</tbody></table>` : '无结果。';
    } catch (e) { $('#items-out').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  };
  $('#btn-search').onclick = run;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  run();
}

function lineChart(series) {
  if (!series.length) return '<p class="muted">暂无快照数据（每日快照跑过之后这里会出现全生命周期曲线）。</p>';
  const w = 1000, h = 220, pad = 36;
  const xs = series.map((p) => +new Date(p.snap_date));
  const ys = series.map((p) => p.available ?? 0);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) || 1];
  const y1 = Math.max(...ys, 1);
  const X = (x) => pad + (w - 2 * pad) * (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0));
  const Y = (y) => h - pad - (h - 2 * pad) * (y / y1);
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${X(+new Date(p.snap_date)).toFixed(1)},${Y(p.available ?? 0).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#e1e3e5"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="#e1e3e5"/>
    <text x="${pad - 6}" y="${pad + 4}" text-anchor="end" font-size="11" fill="#6d7175">${y1}</text>
    <text x="${pad - 6}" y="${h - pad}" text-anchor="end" font-size="11" fill="#6d7175">0</text>
    <text x="${pad}" y="${h - pad + 16}" font-size="11" fill="#6d7175">${series[0].snap_date}</text>
    <text x="${w - pad}" y="${h - pad + 16}" text-anchor="end" font-size="11" fill="#6d7175">${series[series.length - 1].snap_date}</text>
    <path d="${d}" fill="none" stroke="#7b47f1" stroke-width="2"/>
  </svg>`;
}

async function viewItem(id) {
  app.innerHTML = '<div class="card">加载中…</div>';
  const { item, levels, series, shopHandle } = await api(`/items/${id}`);
  app.innerHTML = `
    <p><a class="back-link" href="#/items">← 返回商品</a></p>
    <div class="card">
      <h2>${esc(item.product_title)}${item.variant_title && item.variant_title !== 'Default Title' ? ` / ${esc(item.variant_title)}` : ''}</h2>
      <p class="muted">SKU ${esc(item.sku) || '—'} · 条码 ${esc(item.barcode) || '—'} · ${esc(item.vendor)} · 零售价 ${item.price ?? '—'} · 成本 ${item.unit_cost ?? '—'}</p>
      ${lineChart(series)}
    </div>
    <div class="card"><h2>各仓库存状态</h2>
      <div class="table-scroll"><table><thead><tr><th>仓位</th><th class="num">不可用</th><th class="num">已承诺</th><th class="num">可用</th><th class="num">在手</th><th class="num">在途</th><th>更新时间</th></tr></thead>
      <tbody>${levels.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.unavailable ?? '—'}</td><td class="num">${l.committed ?? '—'}</td><td class="num">${l.available ?? '—'}</td><td class="num">${l.on_hand ?? '—'}</td><td class="num">${l.incoming ?? '—'}</td><td>${fmtDate(l.updated_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">无</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>最近修改记录</h2><p class="muted compact">每行代表一次 Shopify 库存操作；Activity 保留 Shopify 的英文叫法。</p></div>
        <select id="history-location"><option value="">全部仓位</option>${levels.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</select>
      </div>
      <div id="recent-history">加载中…</div>
    </div>
    <div class="card">
      <div class="card-heading"><div><h2>历史修改记录</h2><p id="history-range" class="muted compact">本地已保存的全部时间范围，可分页查看。</p></div></div>
      <div id="all-history">加载中…</div>
      <div id="history-pagination" class="pagination"></div>
    </div>
    <div class="notice"><strong>关于历史期限：</strong>Shopify 商品页仅显示最近 180 天；本应用会长期保留已采集记录。当前最早日期取决于首次同步时间，Stocky 更早历史需通过导入补齐。</div>`;

  let historyPage = 1;
  const loadHistory = async () => {
    const location = $('#history-location').value;
    const suffix = location ? `&location=${encodeURIComponent(location)}` : '';
    $('#recent-history').innerHTML = '加载中…';
    $('#all-history').innerHTML = '加载中…';
    const [recent, historical] = await Promise.all([
      api(`/items/${id}/history?page=1&limit=10${suffix}`),
      api(`/items/${id}/history?page=${historyPage}&limit=25${suffix}`),
    ]);
    $('#recent-history').innerHTML = historyTable(recent.rows, shopHandle, '该仓位暂无修改记录');
    $('#all-history').innerHTML = historyTable(historical.rows, shopHandle, '该仓位暂无历史修改记录');
    $('#history-range').textContent = historical.first
      ? `共 ${historical.total} 条 · ${fmtDate(historical.first)} 至 ${fmtDate(historical.last)}`
      : '暂无已保存的修改记录';
    const pages = Math.max(1, Math.ceil(historical.total / historical.pageSize));
    $('#history-pagination').innerHTML = historical.total > historical.pageSize ? `
      <button id="history-prev" class="secondary" ${historyPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${historyPage} / ${pages} 页</span>
      <button id="history-next" class="secondary" ${historyPage >= pages ? 'disabled' : ''}>下一页</button>` : '';
    if ($('#history-prev')) $('#history-prev').onclick = () => { historyPage--; loadHistory(); };
    if ($('#history-next')) $('#history-next').onclick = () => { historyPage++; loadHistory(); };
  };
  $('#history-location').onchange = () => { historyPage = 1; loadHistory(); };
  await loadHistory();
}

async function viewHistory() {
  app.innerHTML = '<div class="card">加载中…</div>';
  let page = 1;
  const load = async () => {
    const result = await api(`/history?page=${page}&limit=50`);
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    app.innerHTML = `
      <div class="page-heading"><div><h1>修改记录</h1><p class="muted">全店库存操作按事件合并显示，可查看操作人、App 和关联订单。</p></div></div>
      <div class="card">
        <div class="table-scroll"><table class="store-history">
          <thead><tr><th>Date</th><th>Activity</th><th>Created by</th><th>Product</th><th>Location</th><th>Reference</th></tr></thead>
          <tbody>${result.rows.map((row) => {
            const product = row.product_count === 1
              ? `<a class="item-link" href="#/items/${row.item_id}">${esc(row.product_title)}${row.variant_title && row.variant_title !== 'Default Title' ? ` / ${esc(row.variant_title)}` : ''}</a><div class="muted small">${esc(row.sku)}</div>`
              : `${row.product_count} 个商品变体`;
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
    if ($('#history-prev')) $('#history-prev').onclick = () => { page--; load(); };
    if ($('#history-next')) $('#history-next').onclick = () => { page++; load(); };
  };
  await load();
}

// ---- router ----
async function route() {
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.nav}`)));
  try {
    const m = hash.match(/^#\/items\/(\d+)/);
    if (m) return await viewItem(m[1]);
    if (hash.startsWith('#/items')) return await viewItems();
    if (hash.startsWith('#/history')) return await viewHistory();
    return await viewDashboard();
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);
route();
