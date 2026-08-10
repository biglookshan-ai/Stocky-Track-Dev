// Lark adjustment-notification settings, editable in the app so the shop owner
// can point the notification at a different group, or change what the card
// shows, without a developer touching environment variables.
//
// The webhook URL embeds the bot token, so it is stored encrypted (same scheme
// as the offline Shopify token) and never sent back to the browser in full.
import { q } from './db.js';
import { encryptToken, decryptToken } from './token-store.js';

export const LARK_SETTINGS_KEY = 'lark_adjustment_notification';

export const HEADER_COLOURS = ['green', 'blue', 'turquoise', 'orange', 'red', 'grey'];

export const DEFAULT_LARK_SETTINGS = {
  enabled: true,
  title: '✅ Stock adjustment applied · {number}',
  headerColour: 'green',
  // An undo is still an adjustment, but reads very differently in a group chat,
  // so it gets its own heading rather than looking like a fresh change.
  reversalTitle: '↩️ Adjustment undone · {number}',
  reversalColour: 'orange',
  // A failed submission is the one case nobody else finds out about — the
  // person who clicked sees it on screen and may simply close the tab.
  notifyOnFailure: true,
  failureTitle: '⚠️ Stock adjustment failed · {number}',
  failureColour: 'red',
  showReason: true,
  showNotes: true,
  showLines: true,
  showBarcode: true,
  showSku: true,
  showLocation: true,
  showBeforeAfter: true,
  showRecordedBy: true,
  showHandledBy: true,
  showAppliedAt: true,
  showDetailButton: true,
};

const BOOLEAN_FIELDS = Object.entries(DEFAULT_LARK_SETTINGS)
  .filter(([, value]) => typeof value === 'boolean')
  .map(([key]) => key);

export function normalizeLarkSettings(input = {}) {
  const settings = { ...DEFAULT_LARK_SETTINGS };
  for (const field of BOOLEAN_FIELDS) {
    if (input[field] !== undefined) settings[field] = input[field] !== false;
  }
  for (const field of ['title', 'reversalTitle', 'failureTitle']) {
    if (input[field] === undefined) continue;
    const title = String(input[field]).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    if (!title) throw new Error('通知标题不能为空');
    settings[field] = title;
  }
  for (const field of ['headerColour', 'reversalColour', 'failureColour']) {
    if (input[field] === undefined) continue;
    const colour = String(input[field]).trim().toLowerCase();
    if (!HEADER_COLOURS.includes(colour)) throw new Error('通知标题颜色无效');
    settings[field] = colour;
  }
  return settings;
}

// Accepts an official Lark/Feishu group bot webhook only — the same check the
// sender applies, run early so a typo is rejected while the user is looking at
// the form rather than when an adjustment is submitted.
export function normalizeWebhookUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Lark 群机器人 Webhook 地址无效'); }
  const allowedHosts = new Set(['open.larksuite.com', 'open.feishu.cn']);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)
      || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) {
    throw new Error('Lark 群机器人 Webhook 必须使用官方 HTTPS 地址');
  }
  return url.toString();
}

// Never show the token part back to the browser: enough to recognise the group,
// not enough to repost to it from somewhere else.
export function maskWebhookUrl(url) {
  const raw = String(url || '');
  if (!raw) return '';
  const token = raw.split('/').pop() || '';
  return raw.slice(0, raw.length - token.length) + (token.length > 6
    ? `${token.slice(0, 4)}…${token.slice(-2)}`
    : '…');
}

function decryptOrNull(value) {
  if (!value) return '';
  try { return decryptToken(value); } catch { return ''; }
}

// Environment variables stay as the fallback so an existing deployment keeps
// working until someone saves settings in the app.
export async function loadLarkConfig() {
  const stored = await q('SELECT value FROM app_settings WHERE key=$1', [LARK_SETTINGS_KEY]);
  const row = stored.rows[0]?.value || {};
  const settings = normalizeLarkSettings(row.settings || {});
  const webhookUrl = row.webhookUrl
    ? decryptOrNull(row.webhookUrl)
    : String(process.env.LARK_ADJUSTMENT_WEBHOOK_URL || '').trim();
  const secret = row.secret !== undefined
    ? decryptOrNull(row.secret)
    : String(process.env.LARK_ADJUSTMENT_WEBHOOK_SECRET || '');
  return {
    settings,
    webhookUrl,
    secret,
    source: row.webhookUrl ? 'app' : (webhookUrl ? 'env' : 'none'),
  };
}

export async function saveLarkConfig({ settings, webhookUrl, secret }) {
  const current = await loadLarkConfig();
  const next = {
    settings: normalizeLarkSettings({ ...current.settings, ...(settings || {}) }),
  };
  // undefined = leave as-is (the browser never receives the real values back);
  // an empty string = deliberately clear it.
  const url = webhookUrl === undefined ? current.webhookUrl : normalizeWebhookUrl(webhookUrl);
  const nextSecret = secret === undefined ? current.secret : String(secret).trim();
  if (url) next.webhookUrl = encryptToken(url);
  next.secret = nextSecret ? encryptToken(nextSecret) : '';
  await q(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [LARK_SETTINGS_KEY, JSON.stringify(next)],
  );
  return loadLarkConfig();
}
