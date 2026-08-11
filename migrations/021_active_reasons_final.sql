-- Final agreed list (2026-08-11): 'Stocktake' is in use and must stay
-- selectable; only '-Demo Stock' and 'Stocky Stocktakes' are retired.
-- 'Reversal' is kept because an undo applies it automatically and submitting
-- requires an active reason. Matching ignores the +/- direction prefix,
-- hyphens, spaces and case, so a stored '-Resend order' matches 'Re-send order'.
UPDATE adjustment_reasons
SET active = (
  regexp_replace(
    lower(btrim(regexp_replace(name, '^[+-]\s*', ''))),
    '[\s-]', '', 'g'
  ) IN (
    'manualadjustment',
    'manualinvoice',
    'manualstockcount',
    'virtualstockadjustment',
    'demo',
    'returnrestock',
    'staffpurchase',
    'damaged',
    'resendorder',
    'stocktake',
    'reversal'
  )
);
