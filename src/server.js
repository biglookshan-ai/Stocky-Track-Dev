import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb, q, getState, setState, withLock } from './db.js';
import { requireSession } from './auth-embedded.js';
import { offlineCtx } from './shopify.js';
import { initialSync } from './catalog.js';
import { receive as receiveWebhook, processPending, registerAll, listSubscriptions } from './webhooks.js';
import { runAttribution } from './attribution.js';
import { runSnapshot } from './snapshot.js';
import { groupAuditEvents, runHistorySync } from './inventory-history.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- tiny .env loader (Railway injects vars directly; this is for local dev) ---
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const API_KEY = process.env.SHOPIFY_API_KEY || '';
const app = express();

// Webhooks need the raw body for HMAC; capture it before JSON parsing.
app.use(express.json({
  limit: '4mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Allow framing by Shopify admin (embedded app).
app.use((req, res, next) => {
  const shop = (req.query.shop || '').toString();
  const frame = shop ? `https://${shop} https://admin.shopify.com` : 'https://*.myshopify.com https://admin.shopify.com';
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frame};`);
  next();
});

const indexHtml = () => fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
function sendIndex(req, res) {
  res.set('Content-Type', 'text/html').send(indexHtml().replaceAll('%%API_KEY%%', API_KEY));
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/config', (req, res) => res.json({ apiKey: API_KEY, version: process.env.SHOPIFY_API_VERSION || '2026-04' }));

// ---- Webhook intake (public; HMAC-verified inside) ----
app.post('/webhooks', receiveWebhook);

// ---- Health (public, for Railway + monitoring) ----
app.get('/healthz', async (req, res) => {
  try {
    const [backlog, pending, snap] = await Promise.all([
      q('SELECT count(*)::int n FROM webhook_events WHERE processed_at IS NULL'),
      q(`SELECT count(*)::int n FROM inventory_ledger WHERE attribution='pending'`),
      getState('last_snapshot'),
    ]);
    res.json({ ok: true, webhookBacklog: backlog.rows[0].n, pendingAttribution: pending.rows[0].n, lastSnapshot: snap });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Authenticated API ----
const api = express.Router();
api.use(requireSession());

api.get('/status', async (req, res) => {
  try {
    const [items, events, ledger, backlog, pending, alerts, reasons] = await Promise.all([
      q(`SELECT count(*)::int n, count(*) FILTER (WHERE source='local')::int local FROM items WHERE status <> 'deleted'`),
      q(`SELECT count(*)::int n, min(occurred_at) first, max(occurred_at) last FROM inventory_events`),
      q(`SELECT count(*)::int n, min(occurred_at) first, max(occurred_at) last FROM inventory_ledger`),
      q('SELECT count(*)::int n FROM webhook_events WHERE processed_at IS NULL'),
      q(`SELECT count(*)::int n FROM inventory_ledger WHERE attribution='pending'`),
      q('SELECT count(*)::int n FROM reconcile_alerts WHERE NOT resolved'),
      q('SELECT count(*)::int n FROM adjustment_reasons WHERE active'),
    ]);
    res.json({
      items: items.rows[0],
      events: events.rows[0],
      ledger: ledger.rows[0],
      webhookBacklog: backlog.rows[0].n,
      pendingAttribution: pending.rows[0].n,
      openAlerts: alerts.rows[0].n,
      reasons: reasons.rows[0].n,
      initialSync: await getState('initial_sync'),
      lastSnapshot: await getState('last_snapshot'),
      snapshotError: await getState('last_snapshot_error'),
      historySync: await getState('inventory_history_sync'),
      historyBackfill: await getState('inventory_history_backfill'),
      webhooksRegistered: await getState('webhooks_registered'),
      staff: req.ctx.staff,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time setup: full catalog sync (runs async; poll /api/status).
api.post('/setup/sync', async (req, res) => {
  const state = await getState('initial_sync');
  if (state && !state.done) return res.json({ started: false, running: true, state });
  setState('initial_sync', { count: 0, done: false, startedAt: new Date().toISOString() });
  initialSync({ shop: req.ctx.shop, token: req.ctx.token })
    .then((n) => console.log(`[sync] initial sync done: ${n} variants`))
    .catch((e) => {
      console.error('[sync] initial sync failed:', e.message);
      setState('initial_sync', { done: false, error: e.message });
    });
  res.json({ started: true });
});

// One-time setup: register webhook subscriptions.
// APP_URL is optional — default to the host this request came in on (Railway
// sets x-forwarded-host), so there's one less env var to misconfigure.
api.post('/setup/webhooks', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL
      || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const results = await registerAll({ shop: req.ctx.shop, token: req.ctx.token }, appUrl);
    await setState('webhooks_registered', { at: new Date().toISOString(), results });
    res.json({ results });
  } catch (e) {
    await setState('webhooks_registered', {
      at: new Date().toISOString(), error: e.message,
    }).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

api.get('/setup/webhooks', async (req, res) => {
  try {
    res.json({ subscriptions: await listSubscriptions({ shop: req.ctx.shop, token: req.ctx.token }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual triggers (also run on schedule) — useful during M0 verification.
api.post('/jobs/snapshot', async (req, res) => {
  try {
    const r = await withLock('shopify-heavy', 30 * 60 * 1000, async () => {
      try {
        const result = await runSnapshot({ shop: req.ctx.shop, token: req.ctx.token });
        await setState('last_snapshot_error', null);
        return result;
      } catch (error) {
        await setState('last_snapshot_error', {
          error: error.message, at: new Date().toISOString(),
        });
        throw error;
      }
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
api.post('/jobs/attribution', async (req, res) => {
  try { res.json(await runAttribution()); } catch (e) { res.status(500).json({ error: e.message }); }
});
api.post('/jobs/history', async (req, res) => {
  try {
    const days = Math.min(180, Math.max(1, Number(req.query.days || 2)));
    const incremental = days <= 2;
    const stateKey = incremental ? 'inventory_history_sync' : 'inventory_history_backfill';
    const running = await getState(stateKey);
    if (running?.running) return res.json({ started: false, running: true, state: running });
    await setState(stateKey, { ...(running || {}), running: true, startedAt: new Date().toISOString() });
    withLock('shopify-heavy', 2 * 60 * 60 * 1000,
      () => runHistorySync(
        { shop: req.ctx.shop, token: req.ctx.token },
        { days, incremental },
      ))
      .then(async (lockResult) => {
        if (lockResult.skipped) {
          await setState(stateKey, {
            ...(await getState(stateKey) || {}),
            running: false, error: '另一个 Shopify 全量任务正在运行，请稍后重试',
          });
        }
      })
      .catch(async (e) => {
        console.error('[history] manual sync failed:', e.message);
        await setState(stateKey, {
          ...(await getState(stateKey) || {}),
          running: false, error: e.message, failedAt: new Date().toISOString(),
        });
      });
    res.status(202).json({ started: true, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Items list/search with current levels.
api.get('/items', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim().slice(0, 80);
    const args = [];
    let cond = `i.status <> 'deleted'`;
    if (term) {
      args.push(`%${term}%`);
      cond += ` AND (i.product_title ILIKE $1 OR i.variant_title ILIKE $1 OR i.sku ILIKE $1 OR i.barcode ILIKE $1 OR i.vendor ILIKE $1)`;
    }
    const r = await q(`
      SELECT i.id, i.product_title, i.variant_title, i.sku, i.barcode, i.vendor, i.price, i.source,
             COALESCE(SUM(cl.available), 0)::int total_available
      FROM items i LEFT JOIN current_levels cl ON cl.item_id = i.id
      WHERE ${cond}
      GROUP BY i.id ORDER BY i.product_title, i.variant_title LIMIT 100`, args);
    res.json({ rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Item detail: current levels + snapshot series. Adjustment history is loaded
// separately so the UI can paginate through every locally retained event.
api.get('/items/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [item, levels, series] = await Promise.all([
      q('SELECT * FROM items WHERE id = $1', [id]),
      q(`SELECT l.name, cl.available, cl.on_hand, cl.committed, cl.incoming,
                cl.reserved, cl.damaged, cl.safety_stock, cl.quality_control,
                CASE WHEN cl.on_hand IS NULL OR cl.available IS NULL THEN NULL
                     ELSE cl.on_hand - cl.available END AS unavailable,
                cl.updated_at
         FROM current_levels cl JOIN locations l ON l.id = cl.location_id
         WHERE cl.item_id = $1 ORDER BY l.name`, [id]),
      q(`SELECT snap_date, SUM(available)::int available
         FROM daily_snapshots WHERE item_id = $1 GROUP BY snap_date ORDER BY snap_date`, [id]),
    ]);
    if (!item.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({
      item: item.rows[0], levels: levels.rows, series: series.rows,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Paginated adjustment history for one item. One displayed row represents an
// adjustment event at one location, matching Shopify Admin's presentation.
api.get('/items/:id/history', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(10, Number(req.query.limit || 25)));
    const location = String(req.query.location || '').trim().slice(0, 120);
    const params = [id];
    const filters = ['lg.item_id=$1', 'lg.event_id IS NOT NULL'];
    if (location) {
      params.push(location);
      filters.push(`loc.name=$${params.length}`);
    }
    const where = filters.join(' AND ');
    const [summary, levels] = await Promise.all([
      q(`SELECT count(DISTINCT (e.id, loc.id))::int total,
                min(e.occurred_at) first, max(e.occurred_at) last
         FROM inventory_ledger lg
         JOIN inventory_events e ON e.id=lg.event_id
         JOIN locations loc ON loc.id=lg.location_id
         WHERE ${where}`, params),
      q(`SELECT l.name, cl.available, cl.on_hand, cl.committed, cl.incoming,
                cl.reserved, cl.damaged, cl.safety_stock, cl.quality_control
         FROM current_levels cl JOIN locations l ON l.id=cl.location_id
         WHERE cl.item_id=$1`, [id]),
    ]);
    const groupParams = [...params, pageSize, (page - 1) * pageSize];
    const groups = await q(`
      SELECT e.id AS event_id, loc.id AS location_id, e.occurred_at
      FROM inventory_ledger lg
      JOIN inventory_events e ON e.id=lg.event_id
      JOIN locations loc ON loc.id=lg.location_id
      WHERE ${where}
      GROUP BY e.id, loc.id, e.occurred_at
      ORDER BY e.occurred_at DESC, e.id DESC, loc.id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, groupParams);
    if (!groups.rowCount) {
      return res.json({
        rows: [], page, pageSize, total: summary.rows[0].total,
        first: summary.rows[0].first, last: summary.rows[0].last,
      });
    }
    const selectedParams = [id];
    const selectedValues = groups.rows.map((row) => {
      selectedParams.push(row.event_id, row.location_id);
      return `($${selectedParams.length - 1}::bigint,$${selectedParams.length}::int)`;
    }).join(',');
    const changes = await q(`
      WITH selected(event_id, location_id) AS (VALUES ${selectedValues}),
      states(state) AS (
        VALUES ('available'),('on_hand'),('committed'),('incoming'),
               ('reserved'),('damaged'),('safety_stock'),('quality_control')
      ),
      event_changes AS (
        SELECT lg.event_id, lg.location_id, lg.state, sum(lg.delta)::int AS delta,
               max(lg.qty_after) AS qty_after, max(lg.reason_code) AS reason_code,
               max(lg.source_type) AS source_type, max(lg.actor_name) AS actor_name,
               max(lg.app_name) AS app_name,
               max(lg.reference_document_uri) AS reference_document_uri
        FROM inventory_ledger lg
        JOIN selected s ON s.event_id=lg.event_id AND s.location_id=lg.location_id
        WHERE lg.item_id=$1
        GROUP BY lg.event_id, lg.location_id, lg.state
      )
      SELECT s.event_id, states.state, COALESCE(c.delta, 0)::int AS delta,
             COALESCE(c.qty_after,
               (CASE states.state
                 WHEN 'available' THEN cl.available
                 WHEN 'on_hand' THEN cl.on_hand
                 WHEN 'committed' THEN cl.committed
                 WHEN 'incoming' THEN cl.incoming
                 WHEN 'reserved' THEN cl.reserved
                 WHEN 'damaged' THEN cl.damaged
                 WHEN 'safety_stock' THEN cl.safety_stock
                 WHEN 'quality_control' THEN cl.quality_control
               END) - COALESCE((
                 SELECT sum(newer.delta)
                 FROM inventory_ledger newer
                 JOIN inventory_events newer_event ON newer_event.id=newer.event_id
                 WHERE newer.item_id=$1 AND newer.location_id=s.location_id
                   AND newer.state=states.state
                   AND (newer_event.occurred_at > e.occurred_at
                     OR (newer_event.occurred_at=e.occurred_at AND newer_event.id > e.id))
               ), 0)
             )::int AS computed_qty_after,
             e.occurred_at, c.reason_code, c.source_type, c.actor_name, c.app_name,
             c.reference_document_uri, loc.name AS location,
             e.occurred_at AS event_occurred_at, e.activity, e.reason AS event_reason,
             e.app_name AS event_app_name, e.staff_name,
             e.reference_document_uri AS event_reference_uri,
             e.reference_document_type AS event_reference_type,
             e.reference_document_id AS event_reference_id,
             e.source_type AS event_source_type
      FROM selected s
      JOIN inventory_events e ON e.id=s.event_id
      JOIN locations loc ON loc.id=s.location_id
      JOIN current_levels cl ON cl.item_id=$1 AND cl.location_id=s.location_id
      CROSS JOIN states
      LEFT JOIN event_changes c ON c.event_id=s.event_id
        AND c.location_id=s.location_id AND c.state=states.state
      ORDER BY e.occurred_at DESC, e.id DESC, loc.id, states.state`, selectedParams);
    res.json({
      rows: groupAuditEvents(changes.rows, levels.rows),
      page, pageSize, total: summary.rows[0].total,
      first: summary.rows[0].first, last: summary.rows[0].last,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Business-level adjustment events across the store. Technical child ledger
// rows stay internal and no longer dominate the main navigation.
api.get('/history', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(10, Number(req.query.limit || 50)));
    const [count, rows] = await Promise.all([
      q(`SELECT count(*)::int total FROM inventory_events e
         WHERE EXISTS (SELECT 1 FROM inventory_ledger lg WHERE lg.event_id=e.id)`),
      q(`SELECT e.id, e.occurred_at, e.activity, e.reason, e.staff_name,
                e.app_name, e.reference_document_uri, e.reference_document_type,
                e.reference_document_id, e.source_type,
                count(DISTINCT lg.item_id)::int product_count,
                min(i.id)::int item_id,
                min(i.product_title) AS product_title,
                min(i.variant_title) AS variant_title,
                min(i.sku) AS sku,
                string_agg(DISTINCT loc.name, ', ' ORDER BY loc.name) AS locations
         FROM inventory_events e
         JOIN inventory_ledger lg ON lg.event_id=e.id
         JOIN items i ON i.id=lg.item_id
         JOIN locations loc ON loc.id=lg.location_id
         GROUP BY e.id
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]),
    ]);
    res.json({
      rows: rows.rows, page, pageSize, total: count.rows[0].total,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', api);

// ---- Scheduler ----
// Webhook processing every 5s; attribution every 2min; snapshot daily at
// SNAPSHOT_HOUR UTC (default 03). Single instance → simple loops + db lock.
function startScheduler() {
  setInterval(() => processPending().catch((e) => console.error('[sched] webhooks:', e.message)), 5000);
  setInterval(() => runAttribution().catch((e) => console.error('[sched] attribution:', e.message)), 120000);
  setInterval(() => {
    withLock('shopify-heavy', 15 * 60 * 1000,
      () => runHistorySync(offlineCtx(), { days: 2 }))
      .catch((e) => console.error('[sched] inventory history:', e.message));
  }, 5 * 60 * 1000);
  setInterval(async () => {
    try {
      const hour = Number(process.env.SNAPSHOT_HOUR ?? 3);
      const now = new Date();
      if (now.getUTCHours() !== hour) return;
      const today = now.toISOString().slice(0, 10);
      const last = await getState('last_snapshot');
      if (last && last.snapDate === today) return;
      await withLock('shopify-heavy', 30 * 60 * 1000, () => runSnapshot(offlineCtx()));
    } catch (e) { console.error('[sched] snapshot:', e.message); }
  }, 60000);
}

async function resumeInterruptedHistory() {
  const state = await getState('inventory_history_backfill');
  if (!state?.running) return;
  console.log(`[history] resuming backfill from ${state.cursor || 'latest cursor'}`);
  const lockResult = await withLock('shopify-heavy', 2 * 60 * 60 * 1000,
    () => runHistorySync(offlineCtx(), { days: 180, incremental: false }));
  if (lockResult.skipped) return;
  console.log('[history] resumed backfill finished');
}

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`inventory-app listening on :${PORT}`));
  startScheduler();
  resumeInterruptedHistory().catch(async (e) => {
    console.error('[history] resume failed:', e.message);
    const state = await getState('inventory_history_backfill').catch(() => ({}));
    await setState('inventory_history_backfill', {
      ...(state || {}), running: false, error: e.message,
      failedAt: new Date().toISOString(),
    }).catch(() => {});
  });
}).catch((e) => {
  console.error('startup failed:', e.message);
  process.exit(1);
});
