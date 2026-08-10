-- Only the reasons the shop actually uses stay selectable on a new adjustment.
-- The rest are deactivated, never deleted: adjustments already filed against
-- them keep their reason, and they can be switched back on in settings.
--
-- Names carry a +/- prefix that encodes direction ('-Manual invoice'), so the
-- match ignores any leading sign and is case-insensitive.
--
-- 'Reversal' is kept active because it is applied automatically when an
-- adjustment is undone, and submitting requires an active reason.
UPDATE adjustment_reasons
SET active = (
  lower(btrim(regexp_replace(name, '^[+-]\s*', ''))) IN (
    'manual adjustment',
    'manual invoice',
    'manual stock count',
    'virtual stock adjustment',
    'demo',
    'return restock',
    'staff purchase',
    'damaged',
    're-send order',
    'reversal'
  )
);
