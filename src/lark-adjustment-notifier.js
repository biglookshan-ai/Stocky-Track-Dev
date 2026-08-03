import crypto from 'node:crypto';
import { q, withLock } from './db.js';

const DEFAULT_MAX_MESSAGE_CHARS = 12000;
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

function formatDate(value, timeZone) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const timeZone = options.timeZone || process.env.TZ || DEFAULT_TIME_ZONE;
  const maxChars = Math.max(1000, Number(options.maxChars || DEFAULT_MAX_MESSAGE_CHARS));
  const number = text(
    adjustment.display_number,
    adjustment.number ? `#${adjustment.number}` : `#${adjustment.id}`,
  );
  const lines = Array.isArray(adjustment.lines) ? adjustment.lines : [];
  const attachments = Array.isArray(adjustment.attachments) ? adjustment.attachments : [];
  const total = lines.reduce((sum, line) => sum + Number(line.delta || 0), 0);
  const locations = [...new Set(lines.map((line) => text(line.location, '')).filter(Boolean))];
  const recordedBy = text(adjustment.recorded_by?.name);
  const handledBy = text(adjustment.handled_by?.map((person) => person.name).filter(Boolean).join('、'));
  const loginAccount = text(
    adjustment.created_by_account_name
      || adjustment.login_account_name
      || adjustment.applied_by_account_name,
  );
  const url = detailUrl(adjustment, options.appUrl || process.env.APP_URL);

  const sections = [
    [
      '状态：Applied',
      `调整原因：${text(adjustment.reason)}`,
      `仓位：${locations.length ? locations.join('、') : '—'}`,
      `合计变化：${signed(total)}`,
      `记录员工：${recordedBy}`,
      `经手员工：${handledBy}`,
      `Shopify 登录账号：${loginAccount}`,
      `创建时间：${formatDate(adjustment.created_at, timeZone)}`,
      `完成时间：${formatDate(adjustment.applied_at, timeZone)}`,
    ].join('\n'),
    `调整备注：${text(adjustment.notes)}`,
    attachments.length
      ? `证明附件（${attachments.length}）：\n${attachments.map((attachment, index) =>
        `${index + 1}. ${text(attachment.original_name)} · ${formatBytes(attachment.size_bytes)} · 上传人 ${text(attachment.uploaded_by_name)}`).join('\n')}`
      : '证明附件：无',
    `调整明细（共 ${lines.length} 个商品/仓位）`,
    ...lines.map((line, index) => [
      `${index + 1}. ${text(line.product_title, '(无标题)')}${line.variant_title ? ` / ${text(line.variant_title)}` : ''}`,
      `   Brand：${text(line.vendor)} · Barcode：${text(line.barcode)} · SKU：${text(line.sku)}`,
      `   仓位：${text(line.location)} · Before：${quantity(line.qty_before)} · Change：${signed(line.delta)} · After：${quantity(line.qty_after)}`,
    ].join('\n')),
  ];

  const title = `✅ 库存调整已执行 · ${number}`;
  const footer = url ? `\n\n查看完整调整单：${url}` : '';
  const contentLimit = Math.max(500, maxChars - title.length - footer.length - 40);
  const pages = packSections(sections, contentLimit);
  return pages.map((page, index) => [
    title,
    pages.length > 1 ? `消息 ${index + 1}/${pages.length}` : '',
    '',
    page,
  ].filter((line, lineIndex) => line || lineIndex === 2).join('\n') + footer);
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

export async function postLarkTextMessage({
  webhookUrl,
  secret = '',
  message,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 10000,
}) {
  const url = validateWebhookUrl(webhookUrl);
  const body = { msg_type: 'text', content: { text: message } };
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
        await postLarkTextMessage({
          webhookUrl,
          secret: options.secret ?? process.env.LARK_ADJUSTMENT_WEBHOOK_SECRET ?? '',
          message: messages[index],
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
