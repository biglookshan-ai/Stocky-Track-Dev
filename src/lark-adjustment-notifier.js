import crypto from 'node:crypto';
import { q, withLock } from './db.js';
import { DEFAULT_LARK_SETTINGS, normalizeLarkSettings, loadLarkConfig } from './lark-settings.js';

const DEFAULT_MAX_MESSAGE_CHARS = 7000;
const DEFAULT_TIME_ZONE = 'Europe/London';

function text(value, fallback = '—') {
  const normalized = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return normalized || fallback;
}

function signed(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function quantity(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function markdown(value, fallback = '—') {
  return text(value, fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]~])/g, '\\$1');
}

export function shouldNotifyAdjustment(input) {
  return input?.notifyLark !== false;
}

function shortAdjustmentNumber(adjustment) {
  const display = text(adjustment.display_number, '');
  const match = display.match(/^(A\d+)-\d{6}$/i);
  if (match) return match[1].toUpperCase();
  return display || (adjustment.number ? `#${adjustment.number}` : `#${adjustment.id}`);
}

function changeMarkdown(value) {
  const amount = signed(value);
  const color = Number(value) > 0 ? 'green' : Number(value) < 0 ? 'red' : 'grey';
  return `<font color='${color}'>**${amount}**</font>`;
}

function formatAdjustmentTime(value, timeZone) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return markdown(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function shopifyId(gid, resource) {
  const match = String(gid || '').match(new RegExp(`^gid://shopify/${resource}/(\\d+)$`, 'i'));
  return match?.[1] || '';
}

function shopHandle(adjustment, configuredShop) {
  const referenceMatch = String(adjustment.reference_document_uri || '')
    .match(/^https:\/\/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (referenceMatch) return referenceMatch[1];
  return String(configuredShop || '').replace(/\.myshopify\.com$/i, '').trim();
}

function variantAdminUrl(adjustment, line, configuredShop) {
  const handle = shopHandle(adjustment, configuredShop);
  const productId = shopifyId(line.shopify_product_gid, 'Product');
  const variantId = shopifyId(line.shopify_variant_gid, 'ProductVariant');
  if (!handle || !productId || !variantId) return '';
  return `https://admin.shopify.com/store/${encodeURIComponent(decodeURIComponent(handle))}/products/${productId}/variants/${variantId}`;
}

function barcodeMarkdown(adjustment, line, configuredShop) {
  const barcode = markdown(line.barcode);
  const adminUrl = variantAdminUrl(adjustment, line, configuredShop);
  return adminUrl && line.barcode ? `[${barcode}](${adminUrl})` : barcode;
}

function markdownElement(content) {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

// Lark collapses Markdown whitespace and wrapped lines return to the outer
// element's left edge. Keep labels/numbers in their own auto-width column so
// every explicit or automatic continuation stays aligned in the content column.
function alignedColumns(label, content) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'top',
        elements: [markdownElement(label)],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        elements: [markdownElement(content)],
      },
    ],
  };
}

function adjustmentLineBlock(adjustment, line, index, configuredShop, settings) {
  const codes = [
    settings.showBarcode ? `Barcode: ${barcodeMarkdown(adjustment, line, configuredShop)}` : '',
    settings.showSku ? `SKU: ${markdown(line.sku)}` : '',
  ].filter(Boolean).join(' | ');
  const movement = [
    settings.showLocation ? markdown(line.location) : '',
    [
      `Change: ${changeMarkdown(line.delta)}`,
      settings.showBeforeAfter ? `Before: **${quantity(line.qty_before)}**` : '',
      settings.showBeforeAfter ? `After: **${quantity(line.qty_after)}**` : '',
    ].filter(Boolean).join(' · '),
  ].filter(Boolean).join(' | ');
  const content = [
    `**${markdown(line.product_title, '(no title)')}${line.variant_title ? ` / ${markdown(line.variant_title)}` : ''}**`,
    codes,
    movement,
  ].filter(Boolean).join('\n');
  return {
    charCount: content.length + String(index).length + 2,
    elements: [alignedColumns(`${index}.`, content)],
  };
}

function splitLongSection(section, limit) {
  if (section.length <= limit) return [section];
  const parts = [];
  let rest = section;
  while (rest.length > limit) {
    let boundary = rest.lastIndexOf('\n', limit);
    if (boundary < Math.floor(limit * 0.5)) boundary = rest.lastIndexOf(' ', limit);
    if (boundary < Math.floor(limit * 0.5)) boundary = limit;
    parts.push(rest.slice(0, boundary).trim());
    rest = rest.slice(boundary).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function packElementBlocks(blocks, limit) {
  const pages = [];
  let elements = [];
  let charCount = 0;
  for (const block of blocks) {
    const separatorCost = elements.length ? 2 : 0;
    if (elements.length && charCount + separatorCost + block.charCount > limit) {
      pages.push(elements);
      elements = [];
      charCount = 0;
    }
    elements.push(...block.elements);
    charCount += (elements.length > block.elements.length ? separatorCost : 0) + block.charCount;
  }
  if (elements.length) pages.push(elements);
  return pages.length ? pages : [[markdownElement('')]];
}

function detailUrl(adjustment, appUrl) {
  if (adjustment.reference_document_uri) return String(adjustment.reference_document_uri);
  if (!appUrl) return '';
  return `${String(appUrl).replace(/\/+$/, '')}/adjustments/${adjustment.id}`;
}

export function buildAdjustmentNotificationMessages(adjustment, options = {}) {
  const settings = normalizeLarkSettings(options.settings || DEFAULT_LARK_SETTINGS);
  const maxChars = Math.max(1000, Number(options.maxChars || DEFAULT_MAX_MESSAGE_CHARS));
  const timeZone = options.timeZone || process.env.TZ || DEFAULT_TIME_ZONE;
  const configuredShop = options.shop || process.env.SHOP;
  const number = shortAdjustmentNumber(adjustment);
  const lines = settings.showLines && Array.isArray(adjustment.lines) ? adjustment.lines : [];
  const recordedBy = markdown(adjustment.recorded_by?.name);
  const handledBy = markdown(adjustment.handled_by?.map((person) => person.name).filter(Boolean).join(', '));
  const url = settings.showDetailButton
    ? detailUrl(adjustment, options.appUrl || process.env.APP_URL)
    : '';

  const undoes = adjustment.reversal_of
    ? shortAdjustmentNumber(adjustment.reversal_of)
    : '';
  const note = markdown(adjustment.notes).replace(/\r\n?/g, '\n');
  const noteChunks = settings.showNotes
    ? splitLongSection(note, Math.max(500, maxChars - 100))
    : [];
  const detailHeading = lines.length ? '**Items:**' : '**Items:** —';
  const footer = [
    settings.showRecordedBy ? `**Recorded by:** ${recordedBy}` : '',
    settings.showHandledBy ? `**Handled by:** ${handledBy}` : '',
    settings.showAppliedAt ? `**Adjusted at:** ${formatAdjustmentTime(adjustment.applied_at, timeZone)}` : '',
  ].filter(Boolean).join('\n');
  const blocks = [
    // Which adjustment this undoes is the whole point of an undo, so it is
    // stated outright rather than left to be inferred from the note.
    ...(undoes ? [{
      charCount: undoes.length + 12,
      elements: [markdownElement(`**Undoes:** ${markdown(undoes)}`)],
    }] : []),
    ...(settings.showReason ? [{
      charCount: markdown(adjustment.reason).length + 12,
      elements: [markdownElement(`**Reason:** ${markdown(adjustment.reason)}`)],
    }] : []),
    ...noteChunks.map((chunk) => ({
      charCount: chunk.length + 6,
      elements: [alignedColumns('**Note:**', chunk)],
    })),
    ...(settings.showLines ? [
      { charCount: detailHeading.length, elements: [markdownElement(detailHeading)] },
      ...lines.map((line, index) =>
        adjustmentLineBlock(adjustment, line, index + 1, configuredShop, settings)),
    ] : []),
    ...(footer ? [{ charCount: footer.length, elements: [markdownElement(footer)] }] : []),
  ];

  const pages = packElementBlocks(blocks, maxChars);
  return pages.map((pageElements, index) => ({
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: undoes ? settings.reversalColour : settings.headerColour,
        title: {
          tag: 'plain_text',
          content: `${(undoes ? settings.reversalTitle : settings.title).replace(/\{number\}/g, number)}${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`,
        },
      },
      elements: [
        ...pageElements,
        ...(url && index === pages.length - 1 ? [{
          tag: 'action',
          actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: 'View full adjustment' },
            type: 'primary',
            url,
          }],
        }] : []),
      ],
    },
  }));
}

// Two ways a submission fails, and they need different instructions:
//   rejected — Shopify refused it, stock is untouched, the draft can be fixed
//   unknown  — the request went out with no answer, so it may or may not have
//              landed; retrying is safe because the idempotency key is reused
export const FAILURE_KINDS = {
  rejected: {
    outcome: '**Stock was not changed.** The adjustment went back to draft.',
    action: 'Someone needs to open it, check the quantities and submit again.',
  },
  unknown: {
    outcome: '**Shopify did not confirm the result**, so the stock may or may not have changed.',
    action: 'Open the adjustment and press retry — it is safe, it cannot apply twice.',
  },
};

export function buildAdjustmentFailureMessage(adjustment, options = {}) {
  const settings = normalizeLarkSettings(options.settings || DEFAULT_LARK_SETTINGS);
  const kind = FAILURE_KINDS[options.kind] ? options.kind : 'rejected';
  const { outcome, action } = FAILURE_KINDS[kind];
  const number = shortAdjustmentNumber(adjustment);
  const lines = Array.isArray(adjustment.lines) ? adjustment.lines : [];
  const url = detailUrl(adjustment, options.appUrl || process.env.APP_URL);
  const elements = [
    markdownElement(outcome),
    alignedColumns('**Reason given by Shopify:**', markdown(options.error)),
    markdownElement([
      `**Adjustment:** ${markdown(number)}`,
      `**Products:** ${lines.length}`,
      `**Recorded by:** ${markdown(adjustment.recorded_by?.name)}`,
    ].join('\n')),
    markdownElement(action),
  ];
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: settings.failureColour,
        title: {
          tag: 'plain_text',
          content: settings.failureTitle.replace(/\{number\}/g, number),
        },
      },
      elements: url ? [...elements, {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Open the adjustment' },
          type: 'primary',
          url,
        }],
      }] : elements,
    },
  };
}

// Announced once per distinct error: retrying a stubbornly failing adjustment
// must not fill the group with the same warning.
export async function notifyFailedAdjustmentOnce(adjustment, options = {}) {
  const config = options.config ?? await loadLarkConfig();
  if (config.settings.enabled === false) return { sent: false, disabled: true };
  if (config.settings.notifyOnFailure === false) return { sent: false, disabled: true };
  const webhookUrl = options.webhookUrl ?? config.webhookUrl;
  if (!webhookUrl || !adjustment?.id) return { configured: false, sent: false };
  const error = String(options.error || '').slice(0, 1000);

  const claimed = await q(
    `UPDATE adjustments
     SET lark_failure_notified_error=$2, lark_failure_notified_at=now()
     WHERE id=$1 AND lark_failure_notified_error IS DISTINCT FROM $2
     RETURNING id`,
    [Number(adjustment.id), error],
  );
  if (!claimed.rowCount) return { sent: false, alreadySent: true };

  await postLarkMessage({
    webhookUrl,
    secret: options.secret ?? config.secret ?? '',
    payload: buildAdjustmentFailureMessage(adjustment, {
      ...options, settings: options.settings ?? config.settings,
    }),
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  return { sent: true };
}

export function larkWebhookSignature(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

function validateWebhookUrl(webhookUrl) {
  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error('Lark 群机器人 Webhook 地址无效');
  }
  const allowedHosts = new Set(['open.larksuite.com', 'open.feishu.cn']);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)
      || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) {
    throw new Error('Lark 群机器人 Webhook 必须使用官方 HTTPS 地址');
  }
  return url.toString();
}

export async function postLarkMessage({
  webhookUrl,
  secret = '',
  payload,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 10000,
}) {
  const url = validateWebhookUrl(webhookUrl);
  if (!payload || payload.msg_type !== 'interactive' || !payload.card) {
    throw new Error('Lark 消息卡片内容无效');
  }
  const body = { ...payload };
  if (secret) {
    const timestamp = String(Math.floor(Number(now) / 1000));
    body.timestamp = timestamp;
    body.sign = larkWebhookSignature(secret, timestamp);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Lark 通知超时');
    throw new Error(`Lark 通知请求失败：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let result = null;
  try { result = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }
  const code = result?.code ?? result?.StatusCode ?? result?.status_code;
  if (!response.ok || (code !== undefined && Number(code) !== 0)) {
    const reason = result?.msg || result?.StatusMessage || result?.message || raw || `HTTP ${response.status}`;
    throw new Error(`Lark 通知被拒绝：${String(reason).slice(0, 300)}`);
  }
  return result || { ok: true };
}

export async function notifyAppliedAdjustmentOnce(adjustment, options = {}) {
  const config = options.config ?? await loadLarkConfig();
  if (config.settings.enabled === false) return { configured: true, sent: false, disabled: true };
  const webhookUrl = options.webhookUrl ?? config.webhookUrl;
  if (!webhookUrl) return { configured: false, sent: false };
  if (!adjustment?.id) throw new Error('调整单不完整，无法发送 Lark 通知');

  const lock = await withLock(`lark-adjustment-notification:${adjustment.id}`, 0, async () => {
    const state = await q(
      `SELECT status, lark_notified_at, lark_notify_parts_sent
       FROM adjustments WHERE id=$1`,
      [Number(adjustment.id)],
    );
    if (!state.rowCount) throw new Error('调整单不存在');
    if (state.rows[0].status !== 'applied') throw new Error('只有 Applied 调整单可以发送 Lark 通知');
    if (state.rows[0].lark_notified_at) {
      return { configured: true, sent: false, alreadySent: true };
    }

    const messages = buildAdjustmentNotificationMessages(adjustment, {
      ...options, settings: options.settings ?? config.settings,
    });
    const startAt = Math.min(Number(state.rows[0].lark_notify_parts_sent || 0), messages.length);
    await q(
      `UPDATE adjustments
       SET lark_notify_attempts=lark_notify_attempts+1, lark_notify_error=NULL
       WHERE id=$1`,
      [Number(adjustment.id)],
    );
    try {
      for (let index = startAt; index < messages.length; index += 1) {
        await postLarkMessage({
          webhookUrl,
          secret: options.secret ?? config.secret ?? '',
          payload: messages[index],
          fetchImpl: options.fetchImpl,
          now: options.now,
          timeoutMs: options.timeoutMs,
        });
        await q(
          `UPDATE adjustments SET lark_notify_parts_sent=$2, lark_notify_error=NULL
           WHERE id=$1`,
          [Number(adjustment.id), index + 1],
        );
      }
      await q(
        `UPDATE adjustments SET lark_notified_at=now(), lark_notify_error=NULL,
                lark_failure_notified_error=NULL
         WHERE id=$1`,
        [Number(adjustment.id)],
      );
      return { configured: true, sent: true, parts: messages.length };
    } catch (error) {
      await q(
        `UPDATE adjustments SET lark_notify_error=$2 WHERE id=$1`,
        [Number(adjustment.id), error.message],
      ).catch(() => {});
      throw error;
    }
  });

  if (lock.skipped) return { configured: true, sent: false, busy: true };
  return lock.result;
}
