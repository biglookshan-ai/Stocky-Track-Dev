import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LARK_SETTINGS, normalizeLarkSettings, normalizeWebhookUrl, maskWebhookUrl,
} from '../src/lark-settings.js';
import {
  buildAdjustmentNotificationMessages, buildAdjustmentFailureMessage,
} from '../src/lark-adjustment-notifier.js';

const ADJUSTMENT = {
  id: 42,
  display_number: 'A0042-260803',
  reason: 'Manual adjustment',
  notes: 'Customer cancelled the order',
  applied_at: '2026-08-03T10:00:00.000Z',
  recorded_by: { name: 'Kay' },
  handled_by: [{ name: 'Chill' }],
  lines: [{
    product_title: 'Product 1', variant_title: 'Variant 1',
    barcode: '50000', sku: 'SKU-0', location: 'CineGearPro Shop',
    delta: 2, qty_before: 0, qty_after: 2,
  }],
};

const cardText = (settings) => JSON.stringify(
  buildAdjustmentNotificationMessages(ADJUSTMENT, { settings, appUrl: 'https://app.test' }),
);

test('unknown keys are ignored and defaults fill the gaps', () => {
  const settings = normalizeLarkSettings({ showReason: false, bogus: 'x' });
  assert.equal(settings.showReason, false);
  assert.equal(settings.showNotes, DEFAULT_LARK_SETTINGS.showNotes);
  assert.equal(settings.bogus, undefined);
});

test('title and colour are validated', () => {
  assert.equal(normalizeLarkSettings({ title: '  Stock update {number} ' }).title, 'Stock update {number}');
  assert.throws(() => normalizeLarkSettings({ title: '   ' }), /标题不能为空/);
  assert.throws(() => normalizeLarkSettings({ headerColour: 'hotpink' }), /颜色无效/);
  assert.equal(normalizeLarkSettings({ headerColour: 'RED' }).headerColour, 'red');
});

test('the title template carries the adjustment number and the chosen colour', () => {
  const [message] = buildAdjustmentNotificationMessages(ADJUSTMENT, {
    settings: normalizeLarkSettings({ title: 'Stock update {number}', headerColour: 'blue' }),
  });
  assert.equal(message.card.header.title.content, 'Stock update A0042');
  assert.equal(message.card.header.template, 'blue');
});

test('every field switch removes exactly its own part of the card', () => {
  assert.match(cardText(DEFAULT_LARK_SETTINGS), /\*\*Reason:\*\*/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showReason: false })), /\*\*Reason:\*\*/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showNotes: false })), /Customer cancelled/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showBarcode: false })), /Barcode:/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showSku: false })), /SKU:/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showLocation: false })), /CineGearPro Shop/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showBeforeAfter: false })), /Before:/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showRecordedBy: false })), /Recorded by:/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showHandledBy: false })), /Handled by:/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showAppliedAt: false })), /Adjusted at:/);
  assert.doesNotMatch(cardText(normalizeLarkSettings({ showDetailButton: false })), /View full adjustment/);
});

test('switching off the item list drops the products but keeps the rest', () => {
  const card = cardText(normalizeLarkSettings({ showLines: false }));
  assert.doesNotMatch(card, /Product 1/);
  assert.doesNotMatch(card, /\*\*Items:\*\*/);
  assert.match(card, /\*\*Reason:\*\*/);
  assert.match(card, /\*\*Recorded by:\*\* Kay/);
});

test('turning off before/after keeps the change itself visible', () => {
  const card = cardText(normalizeLarkSettings({ showBeforeAfter: false }));
  assert.match(card, /Change:/);
  assert.match(card, /\+2/);
});

test('only official Lark and Feishu bot webhooks are accepted', () => {
  const url = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc-123';
  assert.equal(normalizeWebhookUrl(` ${url} `), url);
  assert.equal(normalizeWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/x'),
    'https://open.feishu.cn/open-apis/bot/v2/hook/x');
  assert.equal(normalizeWebhookUrl(''), '');
  assert.throws(() => normalizeWebhookUrl('not a url'), /地址无效/);
  assert.throws(() => normalizeWebhookUrl('http://open.larksuite.com/open-apis/bot/v2/hook/x'), /HTTPS/);
  assert.throws(() => normalizeWebhookUrl('https://evil.example.com/open-apis/bot/v2/hook/x'), /HTTPS/);
  assert.throws(() => normalizeWebhookUrl('https://open.larksuite.com/other/path'), /HTTPS/);
});

test('the masked webhook hides the bot token but stays recognisable', () => {
  const masked = maskWebhookUrl('https://open.larksuite.com/open-apis/bot/v2/hook/abcdef123456');
  assert.match(masked, /^https:\/\/open\.larksuite\.com\/open-apis\/bot\/v2\/hook\//);
  assert.doesNotMatch(masked, /abcdef123456/);
  assert.equal(maskWebhookUrl(''), '');
});

test('an undo gets its own heading and colour, and says what it undoes', () => {
  const reversal = { ...ADJUSTMENT, reversal_of: { display_number: 'A0009-260808' } };
  const [message] = buildAdjustmentNotificationMessages(reversal, {
    settings: normalizeLarkSettings({}),
  });
  assert.equal(message.card.header.title.content, '❕ Adjustment undone · A0042');
  assert.equal(message.card.header.template, 'orange');
  assert.match(JSON.stringify(message), /\*\*Undoes:\*\* A0009/);
});

test('a normal adjustment is unaffected by the undo wording', () => {
  const [message] = buildAdjustmentNotificationMessages(ADJUSTMENT, {
    settings: normalizeLarkSettings({}),
  });
  assert.equal(message.card.header.title.content, '✅ Stock adjustment applied · A0042');
  assert.doesNotMatch(JSON.stringify(message), /Undoes/);
});

test('the three titles and colours are validated independently', () => {
  const settings = normalizeLarkSettings({
    reversalTitle: 'Undone {number}', failureColour: 'grey',
  });
  assert.equal(settings.reversalTitle, 'Undone {number}');
  assert.equal(settings.failureColour, 'grey');
  assert.equal(settings.title, DEFAULT_LARK_SETTINGS.title);
  assert.throws(() => normalizeLarkSettings({ failureTitle: '  ' }), /标题不能为空/);
  assert.throws(() => normalizeLarkSettings({ reversalColour: 'gold' }), /颜色无效/);
});

test('a rejected submission says the stock did not change', () => {
  const card = buildAdjustmentFailureMessage(ADJUSTMENT, {
    settings: normalizeLarkSettings({}),
    kind: 'rejected',
    error: 'Quantity has changed since this adjustment was created',
  });
  assert.equal(card.card.header.title.content, '✖ Stock adjustment failed · A0042');
  assert.equal(card.card.header.template, 'red');
  const text = JSON.stringify(card);
  assert.match(text, /Stock was not changed/);
  assert.match(text, /Quantity has changed since/);
  assert.match(text, /submit again/);
});

test('an unconfirmed submission says the result is unknown and retrying is safe', () => {
  const text = JSON.stringify(buildAdjustmentFailureMessage(ADJUSTMENT, {
    settings: normalizeLarkSettings({}),
    kind: 'unknown',
    error: 'socket hang up',
  }));
  assert.match(text, /did not confirm the result/);
  assert.match(text, /cannot apply twice/);
  assert.doesNotMatch(text, /Stock was not changed/);
});

test('an unrecognised failure kind is treated as a rejection, not dropped', () => {
  const text = JSON.stringify(buildAdjustmentFailureMessage(ADJUSTMENT, {
    settings: normalizeLarkSettings({}), kind: 'nonsense', error: 'x',
  }));
  assert.match(text, /Stock was not changed/);
});

const TWO_LINES = {
  ...ADJUSTMENT,
  lines: [
    ADJUSTMENT.lines[0],
    {
      product_title: 'Product 2', variant_title: 'Variant 2',
      barcode: '50001', sku: 'SKU-1', location: 'CineGearPro Shop',
      delta: -1, qty_before: 4, qty_after: 3,
    },
  ],
};

test('one location is stated once for the whole card, not per product', () => {
  const card = cardText(normalizeLarkSettings({}));
  assert.match(card, /\*\*Location:\*\* CineGearPro Shop/);
  // The line itself now starts straight at the change.
  assert.match(card, /Change: <font/);
  assert.doesNotMatch(card, /CineGearPro Shop \| Change:/);
});

test('several products at one location still only name it once', () => {
  const card = JSON.stringify(
    buildAdjustmentNotificationMessages(TWO_LINES, { settings: normalizeLarkSettings({}) }),
  );
  assert.equal(card.match(/CineGearPro Shop/g).length, 1);
  assert.match(card, /Product 1/);
  assert.match(card, /Product 2/);
});

test('an adjustment spanning locations keeps the label on every line', () => {
  const mixed = {
    ...TWO_LINES,
    lines: [TWO_LINES.lines[0], { ...TWO_LINES.lines[1], location: 'External Warehouse' }],
  };
  const card = JSON.stringify(
    buildAdjustmentNotificationMessages(mixed, { settings: normalizeLarkSettings({}) }),
  );
  assert.doesNotMatch(card, /\*\*Location:\*\*/);
  assert.match(card, /CineGearPro Shop \| Change:/);
  assert.match(card, /External Warehouse \| Change:/);
});

test('switching off location removes it from both places', () => {
  const off = normalizeLarkSettings({ showLocation: false });
  assert.doesNotMatch(cardText(off), /CineGearPro Shop/);
  assert.doesNotMatch(cardText(off), /\*\*Location:\*\*/);
});

test('the undo card describes the undo itself, not the original', () => {
  // The card announces a stock change, so the quantities must be the ones that
  // just moved — the undo's own, negated ones — with the original only named.
  const undo = {
    ...ADJUSTMENT,
    display_number: 'A0043-260810',
    reversal_of: { id: 41, display_number: 'A0009-260808' },
    lines: [{ ...ADJUSTMENT.lines[0], delta: -2, qty_before: 2, qty_after: 0 }],
  };
  const card = JSON.stringify(buildAdjustmentNotificationMessages(undo, {
    settings: normalizeLarkSettings({}), appUrl: 'https://app.test',
  }));
  assert.match(card, /A0043/);
  assert.match(card, /\*\*Undoes:\*\* \[A0009\]\(https:\/\/app\.test\/adjustments\/41\)/);
  assert.match(card, /-2/);
});

test('an undo without a resolvable original still names it, unlinked', () => {
  const undo = { ...ADJUSTMENT, reversal_of: { display_number: 'A0009-260808' } };
  const card = JSON.stringify(buildAdjustmentNotificationMessages(undo, {
    settings: normalizeLarkSettings({}), appUrl: 'https://app.test',
  }));
  assert.match(card, /\*\*Undoes:\*\* A0009/);
  assert.doesNotMatch(card, /\[A0009\]/);
});

test('the applied card stays green no matter how it is previewed', () => {
  // The preview picks a real adjustment as its sample; if that sample happened
  // to be an undo, the 'applied' card rendered orange and looked like a
  // regression. Clearing the link is what the preview does, so assert it works.
  const undo = { ...ADJUSTMENT, reversal_of: { id: 41, display_number: 'A0014-260811' } };
  const [asApplied] = buildAdjustmentNotificationMessages(
    { ...undo, reversal_of: null }, { settings: normalizeLarkSettings({}) },
  );
  assert.equal(asApplied.card.header.template, 'green');
  assert.match(asApplied.card.header.title.content, /Stock adjustment applied/);
});
