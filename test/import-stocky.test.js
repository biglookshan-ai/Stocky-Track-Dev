import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvObjects, parseStockyDate, planImport, canonicalEmployee, mergeAdjustmentLines, pickCoveringEvent } from '../src/import-stocky.js';

test('parseCsv: quotes, embedded commas, newlines and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","line1\nline2"\r\n2,"he said ""hi""",z\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'line1\nline2'],
    ['2', 'he said "hi"', 'z'],
  ]);
});

test('parseCsv: BOM stripped', () => {
  assert.deepEqual(parseCsv('﻿a,b\n1,2')[0], ['a', 'b']);
});

test('csvObjects: maps header and records csv line numbers', () => {
  const o = csvObjects('No.,Reason\n1001,Demo\n1002,Test');
  assert.equal(o[0]['No.'], '1001');
  assert.equal(o[0]._line, 2);
  assert.equal(o[1]._line, 3);
});

test('parseStockyDate: dd/mm/yyyy → ISO noon UTC', () => {
  assert.equal(parseStockyDate('12/06/2022'), '2022-06-12T12:00:00Z');
  assert.equal(parseStockyDate('1/2/2026'), '2026-02-01T12:00:00Z');
  assert.equal(parseStockyDate(''), null);
  assert.equal(parseStockyDate('2022-06-12'), null);
});

const row = (over = {}) => ({
  _line: over._line ?? 2, 'No.': '1001', Location: 'CineGearPro Shop', Product: 'P',
  Variant: '', SKU: 'S', Barcode: '533262', Reason: 'Demo', Notes: 'n',
  Employee: 'kay', Status: 'adjusted', Date: '12/06/2022', Adjustment: '-1', ...over,
});

test('planImport: groups rows by number, one event per adjustment', () => {
  const plan = planImport([row(), row({ _line: 3, Barcode: '999', Adjustment: '2' })]);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].lines.length, 2);
  assert.equal(plan.events[0].occurredAt, '2022-06-12T12:00:00Z');
});

test('planImport: not_adjusted and failed rows never become lines', () => {
  const plan = planImport([row({ Status: 'not_adjusted' }), row({ _line: 3, Status: 'failed' })]);
  assert.equal(plan.events.length, 0);
  assert.equal(plan.issues.notAdjustedRows, 2);
});

test('planImport: groups on/after coverage start are skipped', () => {
  const plan = planImport(
    [row(), row({ 'No.': '3000', _line: 3, Date: '01/03/2026' })],
    { coverageStart: '2026-01-29T00:00:00Z' },
  );
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].number, '1001');
  assert.equal(plan.issues.coveredGroups, 1);
});

test('planImport: date backfilled from sibling rows of the same group', () => {
  const plan = planImport([row({ Date: '' }), row({ _line: 3, Barcode: '888' })]);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].occurredAt, '2022-06-12T12:00:00Z');
});

test('planImport: group with no date at all is reported and skipped', () => {
  const plan = planImport([row({ Date: '' })]);
  assert.equal(plan.events.length, 0);
  assert.deepEqual(plan.issues.missingDateGroups, ['1001']);
});

test('planImport: staffName is the most frequent employee of the group', () => {
  const plan = planImport([
    row(), row({ _line: 3, Barcode: '2', Employee: 'Ling' }), row({ _line: 4, Barcode: '3', Employee: 'Ling' }),
  ]);
  assert.equal(plan.events[0].staffName, 'Ling');
});

test('canonicalEmployee trims and nulls empties', () => {
  assert.equal(canonicalEmployee('kay '), 'kay');
  assert.equal(canonicalEmployee('  '), null);
});

test('mergeAdjustmentLines: merges same barcode+location, keeps distinct', () => {
  const merged = mergeAdjustmentLines([
    { barcode: 'a', location: 'Shop', delta: -1 },
    { barcode: 'a', location: 'shop', delta: -2 },
    { barcode: 'a', location: 'CN', delta: 5 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((l) => l.location === 'Shop').delta, -3);
});

test('mergeAdjustmentLines: nets to zero rows are dropped', () => {
  assert.deepEqual(mergeAdjustmentLines([
    { barcode: 'a', location: 'Shop', delta: -1 },
    { barcode: 'a', location: 'Shop', delta: 1 },
  ]), []);
});

test('pickCoveringEvent: single common event across all lines', () => {
  assert.deepEqual(
    pickCoveringEvent([new Set(['7', '8']), new Set(['7'])]),
    { eventId: '7', ambiguous: false },
  );
});

test('pickCoveringEvent: empty candidate for any line → unmatched', () => {
  assert.deepEqual(
    pickCoveringEvent([new Set(['7']), new Set()]),
    { eventId: null, ambiguous: false },
  );
});

test('pickCoveringEvent: multiple common events → ambiguous, never guesses', () => {
  assert.deepEqual(
    pickCoveringEvent([new Set(['7', '8']), new Set(['7', '8'])]),
    { eventId: null, ambiguous: true },
  );
});

test('pickCoveringEvent: disjoint sets → unmatched', () => {
  assert.deepEqual(
    pickCoveringEvent([new Set(['7']), new Set(['8'])]),
    { eventId: null, ambiguous: false },
  );
});

test('planImport: covered groups routed to coveredEvents, not dropped', () => {
  const plan = planImport(
    [row(), row({ 'No.': '3000', _line: 3, Date: '01/03/2026' })],
    { coverageStart: '2026-01-29T00:00:00Z' },
  );
  assert.equal(plan.events.length, 1);
  assert.equal(plan.coveredEvents.length, 1);
  assert.equal(plan.coveredEvents[0].number, '3000');
});
