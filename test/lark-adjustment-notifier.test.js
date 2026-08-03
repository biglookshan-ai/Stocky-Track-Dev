import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdjustmentNotificationMessages,
  larkWebhookSignature,
  postLarkTextMessage,
} from '../src/lark-adjustment-notifier.js';

function sampleAdjustment(lineCount = 2) {
  return {
    id: 42,
    number: 42,
    display_number: 'A0042-260803',
    status: 'applied',
    reason: 'Manual adjustment',
    notes: '客人取消订单，手动增加库存',
    created_at: '2026-08-03T10:00:00Z',
    applied_at: '2026-08-03T11:00:00Z',
    created_by_account_name: 'kay@example.com',
    recorded_by: { name: 'Kay' },
    handled_by: [{ name: 'Chill' }, { name: 'Shan' }],
    reference_document_uri: 'https://admin.shopify.com/store/test/apps/inventory/adjustments/42',
    attachments: [{
      original_name: 'evidence.jpg',
      size_bytes: 2048,
      uploaded_by_name: 'Kay',
    }],
    lines: Array.from({ length: lineCount }, (_, index) => ({
      product_title: `Product ${index + 1}`,
      variant_title: `Variant ${index + 1}`,
      vendor: 'CGP',
      barcode: `5000${index}`,
      sku: `SKU-${index}`,
      location: 'CineGearPro Shop',
      qty_before: index,
      delta: index % 2 ? -1 : 2,
      qty_after: index + (index % 2 ? -1 : 2),
    })),
  };
}

test('builds a complete adjustment notification', () => {
  const messages = buildAdjustmentNotificationMessages(sampleAdjustment(), {
    timeZone: 'UTC',
  });
  const combined = messages.join('\n');
  assert.match(combined, /库存调整已执行 · A0042-260803/);
  assert.match(combined, /记录员工：Kay/);
  assert.match(combined, /经手员工：Chill、Shan/);
  assert.match(combined, /evidence\.jpg · 2\.0 KB/);
  assert.match(combined, /Product 1 \/ Variant 1/);
  assert.match(combined, /Barcode：50000 · SKU：SKU-0/);
  assert.match(combined, /Before：0 · Change：\+2 · After：2/);
  assert.match(combined, /查看完整调整单：https:\/\/admin\.shopify\.com/);
});

test('splits long adjustments without dropping products', () => {
  const adjustment = sampleAdjustment(80);
  const messages = buildAdjustmentNotificationMessages(adjustment, {
    timeZone: 'UTC',
    maxChars: 1400,
  });
  assert.ok(messages.length > 1);
  const combined = messages.join('\n');
  for (let index = 0; index < adjustment.lines.length; index += 1) {
    assert.match(combined, new RegExp(`Product ${index + 1} \\/ Variant ${index + 1}`));
  }
  assert.match(messages[0], /消息 1\//);
  assert.match(messages.at(-1), new RegExp(`消息 ${messages.length}\/${messages.length}`));
});

test('creates the Lark custom-bot signature', () => {
  const expected = 'Z8iLECa89Wq48k5ocNlN9tbPuJve8CvC10mKMMDPIOQ=';
  assert.equal(larkWebhookSignature('test-secret', '1722672000'), expected);
});

test('posts a text message and accepts Lark success responses', async () => {
  let request;
  const result = await postLarkTextMessage({
    webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/test-id',
    secret: 'test-secret',
    message: 'hello',
    now: 1722672000000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ StatusCode: 0, StatusMessage: 'success' }), {
        status: 200,
      });
    },
  });
  assert.equal(result.StatusCode, 0);
  assert.equal(request.url, 'https://open.larksuite.com/open-apis/bot/v2/hook/test-id');
  const body = JSON.parse(request.options.body);
  assert.equal(body.msg_type, 'text');
  assert.equal(body.content.text, 'hello');
  assert.equal(body.timestamp, '1722672000');
  assert.equal(body.sign, larkWebhookSignature('test-secret', '1722672000'));
});

test('rejects non-Lark webhook URLs and API errors', async () => {
  await assert.rejects(() => postLarkTextMessage({
    webhookUrl: 'https://example.com/hook',
    message: 'hello',
    fetchImpl: async () => new Response('{}'),
  }), /官方 HTTPS/);
  await assert.rejects(() => postLarkTextMessage({
    webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/test-id',
    message: 'hello',
    fetchImpl: async () => new Response(JSON.stringify({ code: 19021, msg: 'bad sign' }), {
      status: 200,
    }),
  }), /bad sign/);
});
