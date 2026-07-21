// Minimal embedded SPA (M0): status dashboard + items + ledger.
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
const deltaCell = (n) => `<td class="num ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${n}</td>`;

const SOURCE_LABEL = {
  sale: '销售', refund: '退货入库', adjustment: '调整', stocktake: '盘点', import: '历史导入',
  reconciliation: '对账修正', external_app: '外部操作', unknown: '待归因', bundle_op: '组套',
};
const srcBadge = (s) => `<span class="badge ${esc(s)}">${SOURCE_LABEL[s] || esc(s)}</span>`;

// ---- views ----

async function viewDashboard() {
  const s = await api('/status');
  const sync = s.initialSync;
  const snap = s.lastSnapshot;
  app.innerHTML = `
    <div class="grid">
      <div class="stat"><div class="n">${s.items.n}</div><div class="l">商品变体（本地 ${s.items.local}）</div></div>
      <div class="stat"><div class="n">${s.ledger.n}</div><div class="l">账本流水行</div></div>
      <div class="stat ${s.webhookBacklog > 50 ? 'bad' : 'ok'}"><div class="n">${s.webhookBacklog}</div><div class="l">Webhook 待处理</div></div>
      <div class="stat ${s.pendingAttribution > 200 ? 'warn' : ''}"><div class="n">${s.pendingAttribution}</div><div class="l">待归因</div></div>
      <div class="stat ${s.openAlerts > 0 ? 'warn' : 'ok'}"><div class="n">${s.openAlerts}</div><div class="l">未处理对账告警</div></div>
    </div>
    <div class="card">
      <h2>初始化（M0 一次性步骤）</h2>
      <div class="row">
        <button id="btn-sync">① 全量同步商品目录</button>
        <span class="muted">${sync ? (sync.done ? `✅ 已完成：${sync.count} 个变体（${fmtDate(sync.finishedAt)}）` : sync.error ? `❌ 失败：${esc(sync.error)}` : `⏳ 进行中… ${sync.count || 0} 个变体`) : '未运行'}</span>
      </div>
      <div class="row">
        <button id="btn-webhooks">② 注册 Webhooks</button>
        <span class="muted">${s.webhooksRegistered ? `✅ 已注册（${fmtDate(s.webhooksRegistered.at)}）` : '未注册'}</span>
      </div>
      <div class="row">
        <button id="btn-snapshot" class="secondary">立即跑一次快照/对账</button>
        <span class="muted">${snap ? `上次快照 ${snap.snapDate}：${snap.snapshotRows} 行，修复漂移 ${snap.driftHealed}` : '尚无快照'}</span>
      </div>
      <p class="muted">账本第一天起就在记录：目录同步建立基线 → webhook 记增量 → 每日快照对账自愈。</p>
    </div>
    <div class="card">
      <h2>账本时间范围</h2>
      <p>${s.ledger.first ? `${fmtDate(s.ledger.first)} → ${fmtDate(s.ledger.last)}` : '暂无流水（等第一笔库存变动进来）'}</p>
    </div>`;
  $('#btn-sync').onclick = async (e) => { e.target.disabled = true; await api('/setup/sync', { method: 'POST' }); setTimeout(viewDashboard, 1500); };
  $('#btn-webhooks').onclick = async (e) => { e.target.disabled = true; await api('/setup/webhooks', { method: 'POST' }); viewDashboard(); };
  $('#btn-snapshot').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = '快照运行中…（可能几分钟）';
    try { await api('/jobs/snapshot', { method: 'POST' }); } finally { viewDashboard(); }
  };
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
  const { item, levels, ledger, series } = await api(`/items/${id}`);
  app.innerHTML = `
    <div class="card">
      <h2>${esc(item.product_title)}${item.variant_title && item.variant_title !== 'Default Title' ? ` / ${esc(item.variant_title)}` : ''}</h2>
      <p class="muted">SKU ${esc(item.sku) || '—'} · 条码 ${esc(item.barcode) || '—'} · ${esc(item.vendor)} · 零售价 ${item.price ?? '—'} · 成本 ${item.unit_cost ?? '—'}</p>
      ${lineChart(series)}
    </div>
    <div class="card"><h2>各仓可用量</h2>
      <table><thead><tr><th>仓位</th><th class="num">可用</th><th class="num">在手</th><th>更新时间</th></tr></thead>
      <tbody>${levels.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.available ?? '—'}</td><td class="num">${l.on_hand ?? '—'}</td><td>${fmtDate(l.updated_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody></table>
    </div>
    <div class="card"><h2>账本流水（最近 500 条）</h2>
      <table><thead><tr><th>时间</th><th>仓位</th><th class="num">±</th><th class="num">变动后</th><th>来源</th><th>原因/单据</th><th>操作人</th><th>备注</th></tr></thead>
      <tbody>${ledger.map((r) => `<tr>
        <td>${fmtDate(r.occurred_at)}</td><td>${esc(r.location)}</td>${deltaCell(r.delta)}
        <td class="num">${r.qty_after ?? '—'}</td><td>${srcBadge(r.source_type)}</td>
        <td>${esc(r.reason_code || r.source_ref || '')}</td><td>${esc(r.staff || '')}</td><td>${esc(r.notes || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">暂无流水</td></tr>'}</tbody></table>
    </div>`;
}

async function viewLedger() {
  app.innerHTML = '<div class="card">加载中…</div>';
  const { rows } = await api('/ledger');
  app.innerHTML = `
    <div class="card"><h2>全店最近流水（200 条）</h2>
      <table><thead><tr><th>时间</th><th>商品</th><th>仓位</th><th class="num">±</th><th class="num">变动后</th><th>来源</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${fmtDate(r.occurred_at)}</td>
        <td>${esc(r.product_title)}${r.variant_title && r.variant_title !== 'Default Title' ? ` / ${esc(r.variant_title)}` : ''} <span class="muted">${esc(r.sku)}</span></td>
        <td>${esc(r.location)}</td>${deltaCell(r.delta)}<td class="num">${r.qty_after ?? '—'}</td>
        <td>${srcBadge(r.source_type)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">暂无流水</td></tr>'}</tbody></table>
    </div>`;
}

// ---- router ----
async function route() {
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.nav}`)));
  try {
    const m = hash.match(/^#\/items\/(\d+)/);
    if (m) return await viewItem(m[1]);
    if (hash.startsWith('#/items')) return await viewItems();
    if (hash.startsWith('#/ledger')) return await viewLedger();
    return await viewDashboard();
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);
route();
