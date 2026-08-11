-- 019 matched names literally, so the stored '-Resend order' never matched the
-- written 'Re-send order' and was switched off by mistake.
--
-- Normalising with plain replace() rather than a regex bracket expression:
-- '[\s-]' expands \s to a character class and the trailing '-' can then be read
-- as a range start, which errors — and a failing migration takes the whole boot
-- down. Stripping '+', '-' and spaces covers every direction prefix anyway.
UPDATE adjustment_reasons
SET active = (
  replace(replace(replace(lower(btrim(name)), '+', ''), '-', ''), ' ', '') IN (
    'manualadjustment', 'manualinvoice', 'manualstockcount',
    'virtualstockadjustment', 'demo', 'returnrestock',
    'staffpurchase', 'damaged', 'resendorder', 'reversal'
  )
);
