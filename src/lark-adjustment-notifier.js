import crypto from 'node:crypto';
import { q, withLock } from './db.js';

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

function adjustmentLineMarkdown(adjustment, line, index, configuredShop) {
  return [
    `${index}. **${markdown(line.product_title, '(无标题)')}${line.variant_title ? ` / ${markdown(line.variant_title)}` : ''}**`,
    `   Barcode：${barcodeMarkdown(adjustment, line, configuredShop)} | SKU：${markdown(line.sku)}`,
    `   ${markdown(line.location)} | Before：**${quantity(line.qty_before)}** · Change：${changeMarkdown(line.delta)} · After：**${quantity(line.qty_after)}**`,
  ].join('\n');
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

function packSections(sections, limit) {
  const pieces = sections.flatMap((section) => splitLongSection(section, limit));
  const pages = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (current && candidate.length > limit) {
      pages.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) pages.push(current);
  return pages.length ? pages : [''];
}

function detailUrl(adjustment, appUrl) {
  if (adjustment.reference_document_uri) return String(adjustment.reference_document_uri);
  if (!appUrl) return '';
  return `${String(appUrl).replace(/\/+$/, '')}/adjustments/${adjustment.id}`;
}

export function buildAdjustmentNotificationMessages(adjustment, options = {}) {
  const maxChars = Math.max(1000, Number(options.maxChars || DEFAULT_MAX_MESSAGE_CHARS));
  const timeZone = options.timeZone || process.env.TZ || DEFAULT_TIME_ZONE;
  const configuredShop = options.shop || process.env.SHOP;
  const number = shortAdjustmentNumber(adjustment);
  const lines = Array.isArray(adjustment.lines) ? adjustment.lines : [];
  const recordedBy = markdown(adjustment.recorded_by?.name);
  const handledBy = markdown(adjustment.handled_by?.map((person) => person.name).filter(Boolean).join('、'));
  const url = detailUrl(adjustment, options.appUrl || process.env.APP_URL);

  const sections = [
    [`**原因：** ${markdown(adjustment.reason)}`, `**备注：** ${markdown(adjustment.notes)}`].join('\n'),
    lines.length
      ? `**调整明细：**\n${adjustmentLineMarkdown(adjustment, lines[0], 1, configuredShop)}`
      : '**调整明细：** —',
    ...lines.slice(1).map((line, index) =>
      adjustmentLineMarkdown(adjustment, line, index + 2, configuredShop)),
    [
      `**记录员工：** ${recordedBy}`,
      `**经手员工：** ${handledBy}`,
      `**调整时间：** ${formatAdjustmentTime(adjustment.applied_at, timeZone)}`,
    ].join('\n'),
  ];

  const pages = packSections(sections, maxChars);
  return pages.map((page, index) => ({
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: 'green',
        title: {
          tag: 'plain_text',
          content: `✅ 库存调整已执行 · ${number}${pages.length > 1 ? `（${index + 1}/${pages.length}）` : ''}`,
        },
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: page } },
        ...(url && index === pages.length - 1 ? [{
          tag: 'action',
          actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '查看完整调整单' },
            type: 'primary',
            url,
          }],
        }] : []),
      ],
    },
  }));
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
  const webhookUrl = options.webhookUrl ?? process.env.LARK_ADJUSTMENT_WEBHOOK_URL;
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

    const messages = buildAdjustmentNotificationMessages(adjustment, options);
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
          secret: options.secret ?? process.env.LARK_ADJUSTMENT_WEBHOOK_SECRET ?? '',
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
        `UPDATE adjustments SET lark_notified_at=now(), lark_notify_error=NULL
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
