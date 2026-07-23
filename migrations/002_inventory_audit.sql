-- M1 inventory audit model.
-- Shopify inventory has multiple named quantities. Keep their latest values
-- locally so product detail can match Admin's Adjustment history.

ALTER TABLE current_levels ADD COLUMN IF NOT EXISTS committed INT;
ALTER TABLE current_levels ADD COLUMN IF NOT EXISTS incoming INT;
ALTER TABLE current_levels ADD COLUMN IF NOT EXISTS reserved INT;
ALTER TABLE current_levels ADD COLUMN IF NOT EXISTS damaged INT;
ALTER TABLE current_levels ADD COLUMN IF NOT EXISTS safety_stock INT;
ALTER TABLE current_levels ADD COLUMN IF NOT EXISTS quality_control INT;

ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS committed INT;
ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS incoming INT;
ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS reserved INT;
ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS damaged INT;
ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS safety_stock INT;
ALTER TABLE daily_snapshots ADD COLUMN IF NOT EXISTS quality_control INT;

ALTER TABLE reconcile_alerts ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'available';

-- One parent row per Shopify InventoryAdjustmentGroup. Child quantity changes
-- remain in inventory_ledger so the append-only invariant is preserved.
CREATE TABLE IF NOT EXISTS inventory_events (
  id                       BIGSERIAL PRIMARY KEY,
  shopify_group_gid        TEXT UNIQUE,
  occurred_at              TIMESTAMPTZ NOT NULL,
  activity                 TEXT,
  reason                   TEXT,
  app_shopify_id           TEXT,
  app_name                 TEXT,
  staff_shopify_id         TEXT,
  staff_name               TEXT,
  reference_document_uri   TEXT,
  reference_document_type  TEXT,
  reference_document_id    TEXT,
  source_type              TEXT NOT NULL DEFAULT 'shopifyql',
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw                      JSONB
);
CREATE INDEX IF NOT EXISTS idx_inventory_events_occurred
  ON inventory_events (occurred_at DESC);

ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES inventory_events(id);
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS external_change_id TEXT;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS app_name TEXT;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS reference_document_uri TEXT;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS ledger_document_uri TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_ledger_external_change
  ON inventory_ledger (external_change_id) WHERE external_change_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_event ON inventory_ledger (event_id);

