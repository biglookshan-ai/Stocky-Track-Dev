-- Durable delivery state for Lark notifications sent after an adjustment is applied.

ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS lark_notified_at TIMESTAMPTZ;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS lark_notify_error TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS lark_notify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS lark_notify_parts_sent INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_adjustments_lark_retry
  ON adjustments (applied_at, id)
  WHERE status = 'applied'
    AND lark_notified_at IS NULL
    AND lark_notify_attempts > 0;
