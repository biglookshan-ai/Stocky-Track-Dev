-- The undo and failure headings moved to clearer symbols (❗ and ❌). Titles are
-- editable, so only rewrite the ones still sitting at the previous default —
-- anything typed by hand is left exactly as it is.
UPDATE app_settings
SET value = jsonb_set(value, '{settings,reversalTitle}', '"❗ Adjustment undone · {number}"'),
    updated_at = now()
WHERE key = 'lark_adjustment_notification'
  AND value->'settings'->>'reversalTitle' = '↩️ Adjustment undone · {number}';

UPDATE app_settings
SET value = jsonb_set(value, '{settings,failureTitle}', '"❌ Stock adjustment failed · {number}"'),
    updated_at = now()
WHERE key = 'lark_adjustment_notification'
  AND value->'settings'->>'failureTitle' = '⚠️ Stock adjustment failed · {number}';
