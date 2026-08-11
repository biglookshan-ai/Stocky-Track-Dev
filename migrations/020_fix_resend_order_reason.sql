-- 019 matched reason names after stripping the +/- direction prefix, but the
-- stored name is '-Resend order' while the agreed list writes 'Re-send order'.
-- The hyphen made them different strings, so that reason was switched off by
-- mistake. Matching now also ignores hyphens and spaces, so both spellings —
-- and any future 'Manual  invoice' style typo — land on the same key.
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
    'reversal'
  )
);
