-- Keep item-level history pagination fast as the permanent local audit grows
-- beyond Shopify Admin's 180-day product-history window.
CREATE INDEX IF NOT EXISTS idx_ledger_item_location_state_event
  ON inventory_ledger (item_id, location_id, state, event_id)
  WHERE event_id IS NOT NULL;
