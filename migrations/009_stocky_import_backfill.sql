-- Tracks exactly which existing formal rows the Stocky import back-filled, so
-- an undo reverts only those (never Shopify's own data). Rows here mean: the
-- import wrote enrichment (notes / reason / employee) onto a pre-existing
-- ledger row or event that it did not create.
CREATE TABLE IF NOT EXISTS stocky_import_backfill (
  ledger_id   BIGINT PRIMARY KEY REFERENCES inventory_ledger(id) ON DELETE CASCADE,
  event_id    BIGINT,
  filled      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- column names this import set null→value
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocky_backfill_event ON stocky_import_backfill (event_id);
