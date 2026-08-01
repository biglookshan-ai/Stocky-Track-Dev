import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb, q, getState, setState, withLock } from './db.js';
import { getAccessToken, requireSession } from './auth-embedded.js';
import { graphql, offlineCtx } from './shopify.js';
import { initialSync } from './catalog.js';
import {
  listGrantedScopes,
  listSubscriptions,
  missingRequiredScopes,
  processPending,
  receive as receiveWebhook,
  registerAll,
} from './webhooks.js';
import { runAttribution } from './attribution.js';
import { runSnapshot } from './snapshot.js';
import { runStockyImport } from './import-stocky.js';
import {
  groupAuditEvents,
  mergeNearbyProvisionalEvents,
  runHistorySync,
} from './inventory-history.js';
import {
  adjustmentsCsv,
  applyAdjustment,
  archiveAdjustment,
  createAdjustmentReason,
  createStaff,
  getAdjustment,
  listAdjustmentOptions,
  listAdjustments,
  saveAdjustmentDraft,
  searchAdjustmentItems,
  updateAdjustmentReason,
  updateStaff,
} from './adjustments.js';
import { enrichReferences } from './references.js';
import {
  deleteAdjustmentAttachment,
  getAdjustmentAttachment,
  storeAdjustmentAttachment,
} from './adjustment-attachments.js';
import {
  buildInventoryTrend,
  TREND_RANGES,
  TREND_STATES,
  trendStart,
} from './inventory-trend.js';
import {
  SALES_RANGES,
  salesHistoryStart,
  summarizeSalesHistory,
} from './sales-history.js';

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
const collectionCache = new Map();
let collectionOptionsCache = { expiresAt: 0, rows: [] };

async function listCollectionOptions(ctx) {
  if (collectionOptionsCache.expiresAt > Date.now()) return collectionOptionsCache.rows;
  const rows = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(ctx, `
      query($cursor: String) {
        collections(first: 250, after: $cursor, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          nodes { id title handle }
        }
      }`, { cursor });
    rows.push(...data.collections.nodes);
    if (!data.collections.pageInfo.hasNextPage) break;
    cursor = data.collections.pageInfo.endCursor;
  }
  collectionOptionsCache = { expiresAt: Date.now() + 10 * 60 * 1000, rows };
  return rows;
}

async function collectionProductGids(ctx, collectionId) {
  const cached = collectionCache.get(collectionId);
  if (cached?.expiresAt > Date.now()) return cached.rows;
  const rows = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(ctx, `
      query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor, sortKey: COLLECTION_DEFAULT) {
            pageInfo { hasNextPage endCursor }
            nodes { id }
          }
        }
      }`, { id: collectionId, cursor });
    const products = data.collection?.products;
    if (!products) break;
    rows.push(...products.nodes.map((product) => product.id));
    if (!products.pageInfo.hasNextPage) break;
    cursor = products.pageInfo.endCursor;
  }
  collectionCache.set(collectionId, { expiresAt: Date.now() + 10 * 60 * 1000, rows });
  return rows;
}

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

// Provisional realtime placeholders (webhook-derived events still awaiting
// Shopify's formal audit trail) are internal bookkeeping only. Every
// user-facing surface shows formal events exclusively: a record either has its
// definite actor/reason or it is not shown yet.
const formalEvent = (alias) =>
  `NOT (${alias}.source_type='unknown' AND ${alias}.shopify_group_gid LIKE 'webhook:%')`;
const AWAITING_FORMAL_SQL = `
  SELECT count(*)::int n FROM inventory_events e
  WHERE e.source_type='unknown' AND e.shopify_group_gid LIKE 'webhook:%'
    AND EXISTS (SELECT 1 FROM inventory_ledger lg
                WHERE lg.event_id=e.id AND lg.attribution <> 'stale')`;

// ---- Health (public, for Railway + monitoring) ----
app.get('/healthz', async (req, res) => {
  try {
    const [webhooks, pending, latestFormal, snap, historySync, historyBackfill] = await Promise.all([
      q(`SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS backlog,
                count(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
                max(received_at) AS last_received_at,
                max(processed_at) AS last_processed_at
         FROM webhook_events`),
      q(AWAITING_FORMAL_SQL),
      q(`SELECT max(e.occurred_at) AS at FROM inventory_events e
         WHERE NOT (e.source_type='unknown' AND e.shopify_group_gid LIKE 'webhook:%')`),
      getState('last_snapshot'),
      getState('inventory_history_sync'),
      getState('inventory_history_backfill'),
    ]);
    res.json({
      ok: true,
      webhookBacklog: webhooks.rows[0].backlog,
      webhookErrors: webhooks.rows[0].errors,
      lastWebhookReceivedAt: webhooks.rows[0].last_received_at,
      lastWebhookProcessedAt: webhooks.rows[0].last_processed_at,
      pendingAttribution: pending.rows[0].n,
      lastFormalEventAt: latestFormal.rows[0].at,
      historySync,
      historyBackfill: historyBackfill && {
        running: historyBackfill.running, cursor: historyBackfill.cursor,
        error: historyBackfill.error || null, heartbeat: historyBackfill.heartbeat,
      },
      lastSnapshot: snap,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Authenticated API ----
const api = express.Router();
api.use(requireSession());

function backfillNeedsResume(state) {
  if (!state || state.running || state.finishedAt || !state.cursor || !state.start) return false;
  return +new Date(state.cursor) > +new Date(state.start);
}

async function runPrioritizedHistoryBackfill(ctx) {
  // A full backfill can hold the ShopifyQL lock for a while. Refresh the
  // recent cursor first so delayed reporting rows and provisional webhook
  // entries are enriched before older history continues.
  await runHistorySync(ctx, {
    since: new Date(Date.now() - 2 * 86400000).toISOString(),
    incremental: true,
  });
  return runHistorySync(ctx, { days: 180, incremental: false });
}

function continueHistoryBackfill(ctx) {
  return withLock('shopify-heavy', 2 * 60 * 60 * 1000,
    () => runPrioritizedHistoryBackfill(ctx))
    .then(async (lockResult) => {
      if (!lockResult.skipped) return;
      const state = await getState('inventory_history_backfill');
      await setState('inventory_history_backfill', {
        ...(state || {}), running: false,
        error: '另一个 Shopify 全量任务正在运行，请稍后重试',
      });
    })
    .catch(async (error) => {
      console.error('[history] background backfill failed:', error.message);
      const state = await getState('inventory_history_backfill').catch(() => ({}));
      await setState('inventory_history_backfill', {
        ...(state || {}), running: false, error: error.message,
        failedAt: new Date().toISOString(),
      }).catch(() => {});
    });
}

api.get('/status', async (req, res) => {
  try {
    const [items, events, ledger, webhooks, pending, reasons] = await Promise.all([
      q(`SELECT count(*)::int n, count(*) FILTER (WHERE source='local')::int local FROM items WHERE status <> 'deleted'`),
      q(`SELECT count(*)::int n, min(occurred_at) first, max(occurred_at) last
         FROM inventory_events e
         WHERE EXISTS (SELECT 1 FROM inventory_ledger lg WHERE lg.event_id=e.id)
           AND ${formalEvent('e')}`),
      q(`SELECT count(*)::int n, min(occurred_at) first, max(occurred_at) last FROM inventory_ledger`),
      q(`SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS backlog,
                count(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
                max(received_at) AS last_received_at,
                max(processed_at) AS last_processed_at,
                max(received_at) FILTER (WHERE topic='inventory_levels/update') AS last_inventory_at
         FROM webhook_events`),
      q(AWAITING_FORMAL_SQL),
      q('SELECT count(*)::int n FROM adjustment_reasons WHERE active'),
    ]);
    const historySync = await getState('inventory_history_sync');
    let historyBackfill = await getState('inventory_history_backfill');
    // A deployment can interrupt a manual history backfill before an offline
    // token has been restored. The first authenticated app request has a valid
    // Admin token, so use it to resume from the saved cursor automatically.
    if (backfillNeedsResume(historyBackfill)) {
      historyBackfill = {
        ...historyBackfill, running: true, error: null,
        resumedAt: new Date().toISOString(),
      };
      await setState('inventory_history_backfill', historyBackfill);
      continueHistoryBackfill({ shop: req.ctx.shop, token: req.ctx.token });
    }
    res.json({
      items: items.rows[0],
      events: events.rows[0],
      ledger: ledger.rows[0],
      webhookBacklog: webhooks.rows[0].backlog,
      webhookErrors: webhooks.rows[0].errors,
      webhookState: webhooks.rows[0],
      pendingAttribution: pending.rows[0].n,
      // Kept as a rolling-deploy compatibility field for older cached clients.
      // Snapshot checkpoints no longer create review alerts.
      openAlerts: 0,
      reasons: reasons.rows[0].n,
      initialSync: await getState('initial_sync'),
      lastSnapshot: await getState('last_snapshot'),
      snapshotError: await getState('last_snapshot_error'),
      historySync,
      historyBackfill,
      webhooksRegistered: await getState('webhooks_registered'),
      staff: req.ctx.staff,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/recent-items', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(20, Math.max(5, Number(req.query.limit || 10)));
    const result = await q(`WITH event_items AS (
         SELECT lg.item_id, e.id AS event_id, e.occurred_at, e.activity,
                e.staff_name, e.app_name, e.source_type,
                sum(lg.delta) FILTER (WHERE lg.state='available')::int AS available_delta,
                sum(lg.delta) FILTER (WHERE lg.state='on_hand')::int AS on_hand_delta,
                string_agg(DISTINCT loc.name, ', ' ORDER BY loc.name) AS locations
         FROM inventory_events e
         JOIN inventory_ledger lg ON lg.event_id=e.id
         JOIN locations loc ON loc.id=lg.location_id
         WHERE e.occurred_at >= now() - interval '3 days'
           AND ${formalEvent('e')}
         GROUP BY lg.item_id, e.id
       ),
       latest AS (
         SELECT DISTINCT ON (item_id) *
         FROM event_items ORDER BY item_id, occurred_at DESC, event_id DESC
       ),
       stock AS (
         SELECT item_id, COALESCE(sum(available), 0)::int AS total_available
         FROM current_levels GROUP BY item_id
       )
       SELECT i.id, i.product_title, i.variant_title, i.sku, i.barcode, i.vendor,
              latest.occurred_at, latest.activity, latest.staff_name,
              latest.app_name, latest.source_type, latest.available_delta,
              latest.on_hand_delta, latest.locations,
              COALESCE(stock.total_available, 0)::int AS total_available,
              count(*) OVER()::int AS total
       FROM latest
       JOIN items i ON i.id=latest.item_id
       LEFT JOIN stock ON stock.item_id=i.id
       WHERE i.status <> 'deleted'
       ORDER BY latest.occurred_at DESC
       LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]);
    const total = result.rows[0]?.total || 0;
    res.json({
      rows: result.rows.map(({ total: _total, ...row }) => row),
      total, page, pageSize,
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
    let token = req.ctx.token;
    let tokenRefreshError = null;
    if (!process.env.SHOPIFY_ADMIN_TOKEN) {
      try {
        token = await getAccessToken(req.ctx.shop, req.ctx.sessionToken, { force: true });
      } catch (error) {
        tokenRefreshError = String(error.message || error).slice(0, 500);
      }
    }
    const ctx = { shop: req.ctx.shop, token };
    let grantedScopes = null;
    let scopeCheckError = null;
    try {
      grantedScopes = await listGrantedScopes(ctx);
    } catch (error) {
      scopeCheckError = String(error.message || error).slice(0, 500);
    }
    const results = await registerAll(ctx, appUrl);
    const state = {
      at: new Date().toISOString(),
      results,
      grantedScopes,
      missingScopes: grantedScopes ? missingRequiredScopes(grantedScopes) : [],
      tokenRefreshError,
      scopeCheckError,
    };
    await setState('webhooks_registered', state);
    res.json(state);
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

// Stocky legacy CSV import: dry-run returns the mapping report; commit writes.
// The client re-sends the same file for commit; both are idempotent.
api.post('/import/stocky', express.text({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    const commit = String(req.query.mode || 'dry-run') === 'commit';
    const result = await runStockyImport(req.body, { commit });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
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
    if (incremental) {
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
    } else {
      continueHistoryBackfill({ shop: req.ctx.shop, token: req.ctx.token });
    }
    res.status(202).json({ started: true, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/item-options', async (req, res) => {
  try {
    const [vendors, collections] = await Promise.all([
      q(`SELECT vendor FROM items
         WHERE status <> 'deleted' AND vendor <> ''
         GROUP BY vendor
         ORDER BY lower(vendor)`),
      listCollectionOptions({ shop: req.ctx.shop, token: req.ctx.token }),
    ]);
    res.json({ vendors: vendors.rows.map((row) => row.vendor), collections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stocky-style inventory adjustments. Saving creates or updates an app-local
// Draft; only the explicit /apply endpoint changes Shopify inventory.
api.get('/adjustment-options', async (req, res) => {
  try {
    res.json({
      ...await listAdjustmentOptions(),
      currentStaff: req.ctx.staff,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/adjustment-items', async (req, res) => {
  try {
    res.json({
      rows: await searchAdjustmentItems({
        term: req.query.q,
        locationId: req.query.locationId,
      }),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.get('/adjustments.csv', async (req, res) => {
  try {
    const csv = await adjustmentsCsv(req.query);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-adjustments-${new Date().toISOString().slice(0, 10)}.csv"`,
    }).send(`\ufeff${csv}`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/adjustments', async (req, res) => {
  try {
    res.json(await listAdjustments(req.query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.post('/adjustments', async (req, res) => {
  try {
    if (!req.ctx.staff?.id) return res.status(403).json({ error: '无法识别当前 Shopify 员工账号' });
    const id = await saveAdjustmentDraft({
      input: req.body,
      staffId: req.ctx.staff?.id,
    });
    res.status(201).json({ id, adjustment: await getAdjustment(id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const attachmentBody = express.raw({ type: '*/*', limit: '50mb' });

api.post('/adjustments/:id/attachments', attachmentBody, async (req, res) => {
  try {
    if (!req.ctx.staff?.id) return res.status(403).json({ error: '无法识别当前 Shopify 员工账号' });
    let filename = '';
    try { filename = decodeURIComponent(String(req.get('X-File-Name') || '')); }
    catch { return res.status(400).json({ error: '附件文件名无效' }); }
    const attachment = await storeAdjustmentAttachment({
      adjustmentId: req.params.id,
      staffId: req.ctx.staff.id,
      filename,
      contentType: req.get('Content-Type'),
      buffer: req.body,
    });
    res.status(201).json({ attachment });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.get('/adjustments/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const attachment = await getAdjustmentAttachment(req.params.id, req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: '附件不存在' });
    const inline = /^(image|video)\//.test(attachment.content_type)
      || attachment.content_type === 'application/pdf';
    const encodedName = encodeURIComponent(attachment.original_name);
    res.set({
      'Content-Type': attachment.content_type,
      'Content-Length': String(attachment.size_bytes),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    const stream = fs.createReadStream(attachment.fullPath);
    stream.on('error', (error) => {
      console.error('[attachments] read failed:', error.message);
      if (!res.headersSent) res.status(404).json({ error: '附件文件不存在' });
      else res.destroy(error);
    });
    stream.pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.delete('/adjustments/:id/attachments/:attachmentId', async (req, res) => {
  try {
    if (!req.ctx.staff?.id) return res.status(403).json({ error: '无法识别当前 Shopify 员工账号' });
    await deleteAdjustmentAttachment(req.params.id, req.params.attachmentId);
    res.json({ deleted: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.get('/adjustments/:id', async (req, res) => {
  try {
    const adjustment = await getAdjustment(req.params.id);
    if (!adjustment) return res.status(404).json({ error: '调整单不存在' });
    res.json({ adjustment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.put('/adjustments/:id', async (req, res) => {
  try {
    if (!req.ctx.staff?.id) return res.status(403).json({ error: '无法识别当前 Shopify 员工账号' });
    const id = await saveAdjustmentDraft({
      id: req.params.id,
      input: req.body,
      staffId: req.ctx.staff?.id,
    });
    res.json({ id, adjustment: await getAdjustment(id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.post('/adjustments/:id/apply', async (req, res) => {
  try {
    if (!req.ctx.staff?.id) return res.status(403).json({ error: '无法识别当前 Shopify 员工账号' });
    res.json(await applyAdjustment({
      id: req.params.id,
      ctx: { shop: req.ctx.shop, token: req.ctx.token },
      staffId: req.ctx.staff.id,
    }));
  } catch (e) { res.status(409).json({ error: e.message }); }
});

api.post('/adjustments/:id/archive', async (req, res) => {
  try {
    await archiveAdjustment(req.params.id);
    res.json({ archived: true });
  } catch (e) { res.status(409).json({ error: e.message }); }
});

api.post('/adjustment-reasons', async (req, res) => {
  try {
    res.status(201).json({ reason: await createAdjustmentReason(req.body) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.patch('/adjustment-reasons/:id', async (req, res) => {
  try {
    res.json({ reason: await updateAdjustmentReason(req.params.id, req.body) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.patch('/staff/:id', async (req, res) => {
  try {
    res.json({ staff: await updateStaff(req.params.id, req.body) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.post('/staff', async (req, res) => {
  try {
    res.status(201).json({ staff: await createStaff(req.body) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Items list/search with business filters, inventory totals and last change.
api.get('/items', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim().slice(0, 80);
    const vendor = String(req.query.vendor || '').trim().slice(0, 120);
    const collection = String(req.query.collection || '').trim().slice(0, 120);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(20, Number(req.query.limit || 50)));
    const sort = String(req.query.sort || 'updated_desc');
    const args = [];
    const filters = [`i.status <> 'deleted'`];
    const add = (value) => {
      args.push(value);
      return `$${args.length}`;
    };
    if (term) {
      const param = add(`%${term}%`);
      filters.push(`(i.product_title ILIKE ${param} OR i.variant_title ILIKE ${param}
        OR i.sku ILIKE ${param} OR i.barcode ILIKE ${param} OR i.vendor ILIKE ${param})`);
    }
    if (vendor) filters.push(`i.vendor=${add(vendor)}`);
    let collectionParam = null;
    if (collection) {
      if (!/^gid:\/\/shopify\/Collection\/\d+$/.test(collection)) {
        return res.status(400).json({ error: 'invalid collection' });
      }
      const productGids = await collectionProductGids(
        { shop: req.ctx.shop, token: req.ctx.token },
        collection,
      );
      collectionParam = add(productGids);
      filters.push(`i.shopify_product_gid=ANY(${collectionParam}::text[])`);
    }
    const where = filters.join(' AND ');
    const order = {
      updated_desc: 'latest.occurred_at DESC NULLS LAST, i.product_title, i.variant_title',
      updated_asc: 'latest.occurred_at ASC NULLS LAST, i.product_title, i.variant_title',
      stock_desc: 'COALESCE(stock.total_available, 0) DESC, i.product_title, i.variant_title',
      stock_asc: 'COALESCE(stock.total_available, 0) ASC, i.product_title, i.variant_title',
      brand_asc: 'lower(i.vendor), i.product_title, i.variant_title',
      brand_desc: 'lower(i.vendor) DESC, i.product_title, i.variant_title',
      name_asc: 'i.product_title, i.variant_title',
      name_desc: 'i.product_title DESC, i.variant_title DESC',
      collection: collectionParam
        ? `array_position(${collectionParam}::text[], i.shopify_product_gid), i.product_title, i.variant_title`
        : 'i.product_title, i.variant_title',
    }[sort] || 'latest.occurred_at DESC NULLS LAST, i.product_title, i.variant_title';
    const rowArgs = [...args, pageSize, (page - 1) * pageSize];
    const limitParam = `$${args.length + 1}`;
    const offsetParam = `$${args.length + 2}`;
    const [count, rows] = await Promise.all([
      q(`SELECT count(*)::int total FROM items i WHERE ${where}`, [...args]),
      q(`WITH stock AS (
           SELECT item_id,
                  sum(available)::int AS total_available,
                  sum(on_hand)::int AS total_on_hand,
                  sum(committed)::int AS total_committed,
                  sum(incoming)::int AS total_incoming,
                  CASE WHEN sum(on_hand) IS NULL OR sum(available) IS NULL THEN NULL
                       ELSE (sum(on_hand) - sum(available))::int END AS total_unavailable
           FROM current_levels GROUP BY item_id
         ),
         event_items AS (
           SELECT lg.item_id, e.id AS event_id, e.occurred_at, e.activity,
                  e.staff_name, e.app_name, e.source_type,
                  sum(lg.delta) FILTER (WHERE lg.state='available')::int AS available_delta,
                  sum(lg.delta) FILTER (WHERE lg.state='on_hand')::int AS on_hand_delta,
                  max(lg.qty_after) FILTER (WHERE lg.state='available')::int AS available_after
           FROM inventory_events e
           JOIN inventory_ledger lg ON lg.event_id=e.id
           WHERE ${formalEvent('e')}
           GROUP BY lg.item_id, e.id
         ),
         latest AS (
           SELECT DISTINCT ON (item_id) *
           FROM event_items ORDER BY item_id, occurred_at DESC, event_id DESC
         )
         SELECT i.id, i.product_title, i.variant_title, i.sku, i.barcode,
                i.vendor, i.price, i.source, i.shopify_product_gid,
                COALESCE(stock.total_available, 0)::int AS total_available,
                stock.total_unavailable, stock.total_committed,
                stock.total_on_hand, stock.total_incoming,
                latest.occurred_at AS last_changed_at, latest.activity AS last_activity,
                latest.staff_name, latest.app_name, latest.source_type,
                latest.available_delta, latest.on_hand_delta, latest.available_after
         FROM items i
         LEFT JOIN stock ON stock.item_id=i.id
         LEFT JOIN latest ON latest.item_id=i.id
         WHERE ${where}
         ORDER BY ${order}
         LIMIT ${limitParam} OFFSET ${offsetParam}`, rowArgs),
    ]);
    res.json({
      rows: rows.rows, total: count.rows[0].total, page, pageSize,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Item detail: current levels + snapshot series. Adjustment history is loaded
// separately so the UI can paginate through every locally retained event.
api.get('/items/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await q('SELECT * FROM items WHERE id = $1', [id]);
    if (!item.rowCount) return res.status(404).json({ error: 'not found' });
    const productGid = item.rows[0].shopify_product_gid;
    const [levels, lastChange, productMeta] = await Promise.all([
      q(`SELECT l.id AS location_id, l.name, cl.available, cl.on_hand, cl.committed, cl.incoming,
                cl.reserved, cl.damaged, cl.safety_stock, cl.quality_control,
                CASE WHEN cl.on_hand IS NULL OR cl.available IS NULL THEN NULL
                     ELSE cl.on_hand - cl.available END AS unavailable,
                cl.updated_at
         FROM current_levels cl JOIN locations l ON l.id = cl.location_id
         WHERE cl.item_id = $1 ORDER BY l.name`, [id]),
      q(`SELECT e.occurred_at, e.activity, e.staff_name, e.app_name, e.source_type,
                sum(lg.delta) FILTER (WHERE lg.state='available')::int AS available_delta,
                sum(lg.delta) FILTER (WHERE lg.state='on_hand')::int AS on_hand_delta
         FROM inventory_events e
         JOIN inventory_ledger lg ON lg.event_id=e.id
         WHERE lg.item_id=$1 AND ${formalEvent('e')}
         GROUP BY e.id
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT 1`, [id]),
      productGid
        ? graphql({ shop: req.ctx.shop, token: req.ctx.token }, `
            query($id: ID!) {
              product(id: $id) {
                handle
                onlineStoreUrl
                onlineStorePreviewUrl
              }
            }`, { id: productGid }).catch(() => ({ product: null }))
        : Promise.resolve({ product: null }),
    ]);
    const shopHandle = req.ctx.shop.replace(/\.myshopify\.com$/i, '');
    const productId = String(productGid || '').split('/').pop();
    const variantId = String(item.rows[0].shopify_variant_gid || '').split('/').pop();
    const storefrontBase = productMeta.product?.onlineStoreUrl
      || productMeta.product?.onlineStorePreviewUrl
      || null;
    res.json({
      item: item.rows[0], levels: levels.rows,
      lastChange: lastChange.rows[0] || null,
      shopHandle,
      links: {
        admin: productId
          ? `https://admin.shopify.com/store/${encodeURIComponent(shopHandle)}/products/${encodeURIComponent(productId)}`
          : null,
        storefront: storefrontBase
          ? `${storefrontBase}${storefrontBase.includes('?') ? '&' : '?'}variant=${encodeURIComponent(variantId)}`
          : null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inventory changes are discrete, so the chart is reconstructed from the
// append-only ledger and the current Shopify quantity. This avoids connecting
// sparse incremental snapshots with misleading diagonal lines.
api.get('/items/:id/trend', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid item id' });

    const state = TREND_STATES.has(req.query.state) ? req.query.state : 'available';
    const range = TREND_RANGES.has(req.query.range) ? req.query.range : '30';
    const locationId = req.query.location ? Number(req.query.location) : null;
    if (locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) {
      return res.status(400).json({ error: 'invalid location id' });
    }
    const locationClause = locationId ? ' AND location_id=$3' : '';
    const ledgerLocationClause = locationId ? ' AND lg.location_id=$3' : '';
    const baseArgs = locationId ? [id, state, locationId] : [id, state];

    const [currentResult, earliestResult, locationResult] = await Promise.all([
      q(`SELECT sum(${state})::int AS current
         FROM current_levels
         WHERE item_id=$1${locationId ? ' AND location_id=$2' : ''}`,
      locationId ? [id, locationId] : [id]),
      q(`SELECT min(lg.occurred_at) AS earliest
         FROM inventory_ledger lg
         LEFT JOIN inventory_events ev ON ev.id=lg.event_id
         WHERE lg.item_id=$1 AND lg.state=$2
           AND lg.source_type NOT IN ('reconciliation', 'import')
           AND (ev.id IS NULL OR ${formalEvent('ev')})${ledgerLocationClause}`, baseArgs),
      locationId
        ? q('SELECT name FROM locations WHERE id=$1', [locationId])
        : Promise.resolve({ rows: [{ name: '全部仓位' }] }),
    ]);

    const earliestAt = earliestResult.rows[0]?.earliest || null;
    const now = new Date();
    const from = trendStart(range, earliestAt, now);
    const current = currentResult.rows[0]?.current ?? null;
    let deltas = [];
    if (from) {
      const deltaArgs = locationId
        ? [id, state, locationId, from.toISOString()]
        : [id, state, from.toISOString()];
      const fromParam = locationId ? '$4' : '$3';
      const result = await q(`
        WITH changes AS (
          SELECT
            COALESCE(lg.event_id::text, 'ledger:' || lg.id::text) AS group_key,
            COALESCE(ev.occurred_at, lg.occurred_at) AS occurred_at,
            lg.delta,
            COALESCE(ev.activity, 'inventory_updated') AS activity,
            loc.name AS location
          FROM inventory_ledger lg
          LEFT JOIN inventory_events ev ON ev.id=lg.event_id
          JOIN locations loc ON loc.id=lg.location_id
          WHERE lg.item_id=$1 AND lg.state=$2
            AND lg.source_type NOT IN ('reconciliation', 'import')
            AND (ev.id IS NULL OR ${formalEvent('ev')})${ledgerLocationClause}
            AND lg.occurred_at >= ${fromParam}
        )
        SELECT min(occurred_at) AS at,
               sum(delta)::int AS delta,
               max(activity) AS activity,
               string_agg(DISTINCT location, ', ' ORDER BY location) AS location
        FROM changes
        GROUP BY group_key
        ORDER BY min(occurred_at), group_key`, deltaArgs);
      deltas = result.rows;
    }

    res.json({
      state,
      range,
      location: locationResult.rows[0]?.name || '未知仓位',
      earliestAt,
      from: from?.toISOString() || null,
      to: now.toISOString(),
      ...buildInventoryTrend({
        current,
        deltas,
        from,
        to: now,
        hasHistory: Boolean(earliestAt),
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Product sales history deliberately uses On hand movements rather than every
// inventory event. Order reservations only change Available and are not sales;
// internal transfers and manual adjustments are excluded from replenishment.
api.get('/items/:id/sales', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid item id' });

    const range = SALES_RANGES.has(String(req.query.range)) ? String(req.query.range) : '30';
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(10, Number(req.query.limit || 20)));
    const now = new Date();
    const [earliestResult, currentResult] = await Promise.all([
      q(`SELECT min(e.occurred_at) AS earliest
         FROM inventory_events e
         JOIN inventory_ledger lg ON lg.event_id=e.id
         WHERE lg.item_id=$1`, [id]),
      q(`SELECT sum(available)::int AS available
         FROM current_levels
         WHERE item_id=$1`, [id]),
    ]);
    const earliestAt = earliestResult.rows[0]?.earliest || null;
    const from = salesHistoryStart(range, earliestAt, now);
    let rawRows = [];
    if (from) {
      const movements = await q(`
        SELECT e.id AS event_id, e.occurred_at, e.activity, e.reason,
               e.source_type, e.staff_name, e.app_name,
               e.reference_document_uri, e.reference_document_type,
               e.reference_document_id, loc.id AS location_id, loc.name AS location,
               sum(lg.delta) FILTER (WHERE lg.state='on_hand')::int AS on_hand_delta,
               sum(lg.delta) FILTER (WHERE lg.state='available')::int AS available_delta,
               max(lg.source_type) AS ledger_source_type
        FROM inventory_events e
        JOIN inventory_ledger lg ON lg.event_id=e.id
        JOIN locations loc ON loc.id=lg.location_id
        WHERE lg.item_id=$1 AND e.occurred_at >= $2
        GROUP BY e.id, loc.id, loc.name
        ORDER BY e.occurred_at DESC, e.id DESC, loc.id`, [id, from.toISOString()]);
      rawRows = movements.rows;
    }

    const config = SALES_RANGES.get(range);
    const currentAvailable = currentResult.rows[0]?.available ?? null;
    const result = summarizeSalesHistory(rawRows, {
      from,
      to: now,
      bucket: config.bucket,
      currentAvailable,
    });
    const total = result.movements.length;
    const selected = result.movements.slice((page - 1) * pageSize, page * pageSize);
    const rows = await enrichReferences(
      { shop: req.ctx.shop, token: req.ctx.token },
      selected,
    );
    const businessFirst = result.movements.length
      ? result.movements.at(-1).occurred_at : null;
    const businessLast = result.movements.length
      ? result.movements[0].occurred_at : null;

    res.json({
      range,
      rangeLabel: config.label,
      bucket: config.bucket,
      from: from?.toISOString() || null,
      to: now.toISOString(),
      first: businessFirst,
      last: businessLast,
      currentAvailable,
      summary: result.summary,
      series: result.series,
      rows,
      page,
      pageSize,
      total,
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
    const filters = ['lg.item_id=$1', 'lg.event_id IS NOT NULL', formalEvent('e')];
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
             CASE WHEN e.source_type='import' THEN NULL ELSE COALESCE(c.qty_after,
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
                 WHERE ${formalEvent('newer_event')}
                   AND newer.item_id=$1 AND newer.location_id=s.location_id
                   AND newer.state=states.state
                   AND (newer_event.occurred_at > e.occurred_at
                     OR (newer_event.occurred_at=e.occurred_at AND newer_event.id > e.id))
               ), 0)
             ) END::int AS computed_qty_after,
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

function historyFilters(query, params) {
  const filters = [
    'EXISTS (SELECT 1 FROM inventory_ledger visible_lg WHERE visible_lg.event_id=e.id)',
    formalEvent('e'),
  ];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const term = String(query.q || '').trim().slice(0, 120);
  if (term) {
    const p = add(`%${term}%`);
    filters.push(`(
      e.activity ILIKE ${p} OR e.reason ILIKE ${p}
      OR e.staff_name ILIKE ${p} OR e.app_name ILIKE ${p}
      OR e.reference_document_uri ILIKE ${p}
      OR e.reference_document_type ILIKE ${p}
      OR e.reference_document_id ILIKE ${p}
      OR EXISTS (
        SELECT 1
        FROM inventory_ledger search_lg
        JOIN items search_i ON search_i.id=search_lg.item_id
        WHERE search_lg.event_id=e.id
          AND (search_i.barcode ILIKE ${p} OR search_i.sku ILIKE ${p}
            OR search_i.product_title ILIKE ${p}
            OR search_i.variant_title ILIKE ${p} OR search_i.vendor ILIKE ${p})
      )
      OR EXISTS (
        SELECT 1 FROM reference_documents search_rd
        WHERE (search_rd.canonical_uri=e.reference_document_uri
          OR search_rd.shopify_id=e.reference_document_id)
          AND (search_rd.display_name ILIKE ${p}
            OR search_rd.customer_name ILIKE ${p} OR search_rd.status ILIKE ${p})
      )
      OR EXISTS (
        SELECT 1
        FROM adjustments search_a
        LEFT JOIN adjustment_participants search_ap
          ON search_ap.adjustment_id=search_a.id
        LEFT JOIN staff search_s
          ON search_s.id IN (
            search_a.staff_id, search_a.created_by_staff_id, search_a.applied_by_staff_id
          )
        WHERE e.reference_document_type='Adjustment'
          AND search_a.number::text=e.reference_document_id
          AND (search_a.display_number ILIKE ${p}
            OR search_ap.display_name_snapshot ILIKE ${p}
            OR search_s.display_name ILIKE ${p}
            OR search_s.employee_code ILIKE ${p})
      )
    )`);
  }
  const person = String(query.person || '').trim().slice(0, 120);
  if (person) {
    const p = add(`%${person}%`);
    filters.push(`(
      e.staff_name ILIKE ${p} OR e.app_name ILIKE ${p}
      OR EXISTS (
        SELECT 1 FROM adjustments person_a
        JOIN adjustment_participants person_ap ON person_ap.adjustment_id=person_a.id
        WHERE e.reference_document_type='Adjustment'
          AND person_a.number::text=e.reference_document_id
          AND person_ap.display_name_snapshot ILIKE ${p}
      )
    )`);
  }
  const source = String(query.source || '').trim();
  if (source && ['sale', 'refund', 'transfer', 'staff', 'app', 'adjustment', 'unknown'].includes(source)) {
    const storedSource = { staff: 'admin_manual', app: 'external_app' }[source] || source;
    filters.push(`e.source_type=${add(storedSource)}`);
  }
  const locationId = Number(query.locationId);
  if (Number.isInteger(locationId) && locationId > 0) {
    filters.push(`EXISTS (
      SELECT 1 FROM inventory_ledger location_lg
      WHERE location_lg.event_id=e.id AND location_lg.location_id=${add(locationId)}
    )`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.dateFrom || ''))) {
    filters.push(`e.occurred_at >= ${add(`${query.dateFrom}T00:00:00Z`)}::timestamptz`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.dateTo || ''))) {
    filters.push(`e.occurred_at < ${add(`${query.dateTo}T00:00:00Z`)}::timestamptz + interval '1 day'`);
  }
  return filters.join(' AND ');
}

async function historyRows(query, { defaultLimit = 50, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(maxLimit, Math.max(1, Number(query.limit || defaultLimit)));
  const params = [];
  const where = historyFilters(query, params);
  const [count, rows] = await Promise.all([
    q(`SELECT count(*)::int total FROM inventory_events e WHERE ${where}`, params),
    q(`SELECT e.id, e.occurred_at, e.activity, e.reason, e.staff_name,
              e.app_name, e.reference_document_uri, e.reference_document_type,
              e.reference_document_id, e.source_type,
              count(DISTINCT lg.item_id)::int product_count,
              min(i.id)::int item_id,
              min(i.product_title) AS product_title,
              min(i.variant_title) AS variant_title,
              min(i.sku) AS sku,
              min(i.barcode) AS barcode,
              min(i.vendor) AS vendor,
              string_agg(DISTINCT loc.name, ', ' ORDER BY loc.name) AS locations
       FROM inventory_events e
       JOIN inventory_ledger lg ON lg.event_id=e.id
       JOIN items i ON i.id=lg.item_id
       JOIN locations loc ON loc.id=lg.location_id
       WHERE ${where}
       GROUP BY e.id
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]),
  ]);
  return { rows: rows.rows, page, pageSize, total: count.rows[0].total };
}

// Business-level adjustment events across the store. Technical child ledger
// rows stay internal and no longer dominate the main navigation.
api.get('/history', async (req, res) => {
  try {
    const result = await historyRows(req.query);
    const rows = await enrichReferences(
      { shop: req.ctx.shop, token: req.ctx.token },
      result.rows,
    );
    res.json({
      ...result, rows,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/search', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim().slice(0, 120);
    if (!term) return res.json({ query: '', products: [], adjustments: [], people: [], history: [] });
    const like = `%${term}%`;
    const [products, adjustments, people, history] = await Promise.all([
      q(`SELECT i.id, i.product_title, i.variant_title, i.barcode, i.sku, i.vendor,
                COALESCE(sum(cl.available), 0)::int AS available
         FROM items i
         LEFT JOIN current_levels cl ON cl.item_id=i.id
         WHERE i.status <> 'deleted'
           AND (i.barcode ILIKE $1 OR i.sku ILIKE $1 OR i.product_title ILIKE $1
             OR i.variant_title ILIKE $1 OR i.vendor ILIKE $1)
         GROUP BY i.id
         ORDER BY CASE WHEN i.barcode=$2 THEN 0 WHEN i.sku=$2 THEN 1 ELSE 2 END,
                  i.product_title, i.variant_title
         LIMIT 10`, [like, term]),
      listAdjustments({ term, limit: 10 }),
      q(`SELECT s.id, s.display_name, s.employee_code, s.shopify_user_id,
                s.role, s.active
         FROM staff s
         WHERE s.display_name ILIKE $1 OR s.employee_code ILIKE $1
           OR s.shopify_user_id ILIKE $1
         ORDER BY s.active DESC, lower(s.display_name)
         LIMIT 10`, [like]),
      historyRows({ q: term, page: 1, limit: 10 }, { defaultLimit: 10, maxLimit: 10 }),
    ]);
    const enrichedHistory = await enrichReferences(
      { shop: req.ctx.shop, token: req.ctx.token },
      history.rows,
    );
    res.json({
      query: term,
      products: products.rows,
      adjustments: adjustments.rows,
      people: people.rows,
      history: enrichedHistory,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/history/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [event, lines] = await Promise.all([
      q(`SELECT * FROM inventory_events WHERE id=$1`, [id]),
      q(`SELECT i.id AS item_id, i.product_title, i.variant_title,
                i.barcode, i.sku, i.vendor, loc.name AS location,
                sum(lg.delta) FILTER (WHERE lg.state='unavailable')::int AS direct_unavailable_delta,
                (array_agg(lg.qty_after ORDER BY lg.occurred_at DESC, lg.id DESC)
                  FILTER (WHERE lg.state='unavailable'))[1]::int AS direct_unavailable_after,
                sum(lg.delta) FILTER (WHERE lg.state='available')::int AS available_delta,
                (array_agg(lg.qty_after ORDER BY lg.occurred_at DESC, lg.id DESC)
                  FILTER (WHERE lg.state='available'))[1]::int AS available_after,
                sum(lg.delta) FILTER (WHERE lg.state='on_hand')::int AS on_hand_delta,
                (array_agg(lg.qty_after ORDER BY lg.occurred_at DESC, lg.id DESC)
                  FILTER (WHERE lg.state='on_hand'))[1]::int AS on_hand_after,
                sum(lg.delta) FILTER (WHERE lg.state='committed')::int AS committed_delta,
                (array_agg(lg.qty_after ORDER BY lg.occurred_at DESC, lg.id DESC)
                  FILTER (WHERE lg.state='committed'))[1]::int AS committed_after,
                sum(lg.delta) FILTER (WHERE lg.state='incoming')::int AS incoming_delta,
                (array_agg(lg.qty_after ORDER BY lg.occurred_at DESC, lg.id DESC)
                  FILTER (WHERE lg.state='incoming'))[1]::int AS incoming_after,
                jsonb_agg(jsonb_build_object(
                  'state', lg.state, 'delta', lg.delta, 'qty_after', lg.qty_after
                ) ORDER BY lg.state, lg.occurred_at, lg.id) AS state_changes
         FROM inventory_ledger lg
         JOIN items i ON i.id=lg.item_id
         JOIN locations loc ON loc.id=lg.location_id
         WHERE lg.event_id=$1
         GROUP BY i.id, loc.id, loc.name
         ORDER BY i.barcode, i.product_title, i.variant_title, loc.name`, [id]),
    ]);
    if (!event.rowCount) return res.status(404).json({ error: '修改记录不存在' });
    const [enrichedEvent] = await enrichReferences(
      { shop: req.ctx.shop, token: req.ctx.token },
      event.rows,
    );
    let adjustment = null;
    if (enrichedEvent.reference_document_type === 'Adjustment'
      && /^\d+$/.test(String(enrichedEvent.reference_document_id || ''))) {
      const local = await q(
        `SELECT a.id, a.display_number, a.notes,
                login.display_name AS login_account_name,
                max(ap.display_name_snapshot) FILTER (WHERE ap.role='recorded_by')
                  AS recorded_by_name,
                string_agg(ap.display_name_snapshot, ', ' ORDER BY ap.id)
                  FILTER (WHERE ap.role='handled_by') AS handled_by_names
         FROM adjustments a
         LEFT JOIN staff login ON login.id=a.staff_id
         LEFT JOIN adjustment_participants ap ON ap.adjustment_id=a.id
         WHERE a.number=$1
         GROUP BY a.id, login.display_name`,
        [Number(enrichedEvent.reference_document_id)],
      );
      adjustment = local.rows[0] || null;
    }
    const rows = lines.rows.map((row) => ({
      ...row,
      unavailable_delta: row.direct_unavailable_delta !== null
        ? row.direct_unavailable_delta
        : row.on_hand_delta === null && row.available_delta === null
          ? null : Number(row.on_hand_delta || 0) - Number(row.available_delta || 0),
      unavailable_after: row.direct_unavailable_after !== null
        ? row.direct_unavailable_after
        : row.on_hand_after === null || row.available_after === null
          ? null : Number(row.on_hand_after) - Number(row.available_after),
    }));
    res.json({
      event: enrichedEvent,
      rows,
      adjustment,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.get('/alerts', async (req, res) => {
  try {
    const rows = await q(`
      SELECT ra.id, ra.snap_date, ra.state, ra.expected, ra.actual, ra.created_at,
             i.id AS item_id, i.product_title, i.variant_title, i.sku, i.barcode, i.vendor,
             i.shopify_product_gid, loc.name AS location
      FROM reconcile_alerts ra
      JOIN items i ON i.id=ra.item_id
      JOIN locations loc ON loc.id=ra.location_id
      WHERE NOT ra.resolved
      ORDER BY ra.created_at DESC
      LIMIT 200`);
    res.json({
      rows: rows.rows,
      shopHandle: req.ctx.shop.replace(/\.myshopify\.com$/i, ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.post('/alerts/:id/resolve', async (req, res) => {
  try {
    const result = await q(
      'UPDATE reconcile_alerts SET resolved=true WHERE id=$1 AND NOT resolved',
      [Number(req.params.id)],
    );
    res.json({ resolved: result.rowCount > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', api);

// ---- Scheduler ----
// Webhook processing every 5s; provisional cleanup after processed events;
// attribution every 2min; snapshot daily at SNAPSHOT_HOUR UTC (default 03).
// Single instance → simple loops + db lock.
function startScheduler() {
  // Formal Shopify audit rows lag realtime webhooks by a few minutes (Shopify's
  // reporting pipeline). Kick a history sync shortly after inventory webhooks
  // arrive — instead of a fixed 5-minute wait — so formal records appear as
  // soon as Shopify can provide them. The periodic run stays as a backstop.
  let historyKickPending = false;
  let lastHistoryRunAt = 0;
  setInterval(() => processPending()
    .then(async ({ processed, inventoryChanged }) => {
      if (!processed) return;
      if (inventoryChanged) historyKickPending = true;
      const merged = await mergeNearbyProvisionalEvents();
      if (merged) console.log(`[history] merged ${merged} delayed webhook placeholder(s)`);
    })
    .catch((e) => console.error('[sched] webhooks:', e.message)), 5000);
  setInterval(() => runAttribution()
    .catch((e) => console.error('[sched] attribution:', e.message)), 120000);
  setInterval(() => {
    const now = Date.now();
    const kicked = historyKickPending && now - lastHistoryRunAt > 60 * 1000;
    const periodic = now - lastHistoryRunAt > 5 * 60 * 1000;
    if (!kicked && !periodic) return;
    historyKickPending = false;
    lastHistoryRunAt = now;
    withLock('shopify-heavy', 15 * 60 * 1000,
      async () => runHistorySync(await offlineCtx(), { days: 2 }))
      .catch((e) => console.error('[sched] inventory history:', e.message));
  }, 30 * 1000);
  setInterval(async () => {
    try {
      const hour = Number(process.env.SNAPSHOT_HOUR ?? 3);
      const now = new Date();
      if (now.getUTCHours() !== hour) return;
      const today = now.toISOString().slice(0, 10);
      const last = await getState('last_snapshot');
      if (last && last.snapDate === today) return;
      await withLock('shopify-heavy', 30 * 60 * 1000,
        async () => runSnapshot(await offlineCtx()));
    } catch (e) { console.error('[sched] snapshot:', e.message); }
  }, 60000);
}

async function resumeInterruptedHistory() {
  for (;;) {
    const state = await getState('inventory_history_backfill');
    if (!state?.running) return;
    console.log(`[history] resuming backfill from ${state.cursor || 'latest cursor'}`);
    const lockResult = await withLock('shopify-heavy', 2 * 60 * 60 * 1000,
      async () => runPrioritizedHistoryBackfill(await offlineCtx()));
    if (!lockResult.skipped) {
      console.log('[history] resumed backfill finished');
      return;
    }
    // Railway briefly overlaps the old and new container during deployment.
    // The old process can still own the advisory lock for a few seconds; keep
    // retrying instead of leaving the persisted state stuck at running=true.
    console.log('[history] resume lock busy; retrying in 15 seconds');
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`inventory-app listening on :${PORT}`));
  startScheduler();
  mergeNearbyProvisionalEvents()
    .then((merged) => {
      if (merged) console.log(`[history] merged ${merged} delayed webhook placeholder(s) at startup`);
    })
    .catch((e) => console.error('[history] startup placeholder cleanup:', e.message));
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
