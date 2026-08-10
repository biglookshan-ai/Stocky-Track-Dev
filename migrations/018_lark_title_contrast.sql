-- ❗ and ❌ are red glyphs and were sitting on orange and red headers, so they
-- barely showed. Only titles still at the previous default are rewritten.
UPDATE app_settings
SET value = jsonb_set(value, '{settings,reversalTitle}', '"❕ Adjustment undone · {number}"'),
    updated_at = now()
WHERE key = 'lark_adjustment_notification'
  AND value->'settings'->>'reversalTitle' IN
      ('❗ Adjustment undone · {number}', '↩️ Adjustment undone · {number}');

UPDATE app_settings
SET value = jsonb_set(value, '{settings,failureTitle}', '"✖ Stock adjustment failed · {number}"'),
    updated_at = now()
WHERE key = 'lark_adjustment_notification'
  AND value->'settings'->>'failureTitle' IN
      ('❌ Stock adjustment failed · {number}', '⚠️ Stock adjustment failed · {number}');
