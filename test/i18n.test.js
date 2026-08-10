import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// i18n.js is a browser script (IIFE assigning window.I18N), so load it with a
// minimal DOM stand-in rather than importing it as a module.
function loadI18n({ stored = null } = {}) {
  const context = {
    window: {},
    document: {
      documentElement: {},
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    localStorage: { getItem: () => stored, setItem: () => {} },
    console: { warn: () => {} },
  };
  const source = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'console', source)(
    context.window, context.document, context.localStorage, context.console,
  );
  return context.window.I18N;
}

test('defaults to English and honours a stored Chinese preference', () => {
  assert.equal(loadI18n().lang, 'en');
  assert.equal(loadI18n({ stored: 'zh' }).lang, 'zh');
  assert.equal(loadI18n({ stored: 'nonsense' }).lang, 'en');
});

test('English mode translates known interface strings', () => {
  const { t } = loadI18n();
  assert.equal(t('手动调整'), 'Manual adjustments');
  assert.equal(t('撤销这张调整单'), 'Undo this adjustment');
});

test('Chinese mode returns the source string untouched', () => {
  const { t } = loadI18n({ stored: 'zh' });
  assert.equal(t('手动调整'), '手动调整');
  assert.equal(t('共 {n} 个商品变体', { n: 7 }), '共 7 个商品变体');
});

test('placeholders are substituted in both languages', () => {
  assert.equal(loadI18n().t('共 {n} 个商品变体', { n: 7 }), '7 product variants');
  assert.equal(
    loadI18n().t('第 {page} / {pages} 页', { page: 2, pages: 5 }),
    'Page 2 of 5',
  );
});

test('server messages carrying a value are translated by pattern', () => {
  const { t } = loadI18n();
  assert.equal(t('第 3 行商品无效'), 'Row 3: that product is not valid');
  assert.equal(
    t('每张调整单最多 250 个商品'),
    'An adjustment can hold at most 250 products',
  );
  assert.match(t('该调整单已有撤销单 A0012-260810，请先处理或归档它'), /A0012-260810/);
});

test('text with no translation falls back to the source, not to blank', () => {
  const { t } = loadI18n();
  // Staff names, notes and reason names are user data — they must survive
  // unchanged even though they never appear in the dictionary.
  assert.equal(t('张三'), '张三');
  assert.equal(t('Damaged in transit'), 'Damaged in transit');
  assert.equal(t('HTTP 500'), 'HTTP 500');
});
