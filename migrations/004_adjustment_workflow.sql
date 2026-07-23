-- M2 adjustment workflow safety and retry metadata.

ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS reference_document_uri TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS shopify_group_gid TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS apply_error TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustments_idempotency_key
  ON adjustments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_adjustments_created
  ON adjustments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adjustments_status
  ON adjustments (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_lines_item_location
  ON adjustment_lines (adjustment_id, item_id, location_id);
