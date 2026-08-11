-- Final agreed list (2026-08-11): 'Stocktake' is in use and stays selectable;
-- only '-Demo Stock' (duplicate of Demo) and 'Stocky Stocktakes' (superseded by
-- Stocktake) are retired. 'Reversal' is kept because an undo applies it
-- automatically and submitting requires an active reason.
UPDATE adjustment_reasons
SET active = (
  replace(replace(replace(lower(btrim(name)), '+', ''), '-', ''), ' ', '') IN (
    'manualadjustment', 'manualinvoice', 'manualstockcount',
    'virtualstockadjustment', 'demo', 'returnrestock',
    'staffpurchase', 'damaged', 'resendorder', 'stocktake', 'reversal'
  )
);
