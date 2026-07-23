-- Evidence files attached to app-local inventory adjustment drafts.

CREATE TABLE IF NOT EXISTS adjustment_attachments (
  id             BIGSERIAL PRIMARY KEY,
  adjustment_id  INT NOT NULL REFERENCES adjustments(id) ON DELETE CASCADE,
  uploaded_by    INT REFERENCES staff(id),
  original_name  TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL,
  storage_key    TEXT UNIQUE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adjustment_attachments_adjustment
  ON adjustment_attachments (adjustment_id, created_at, id);
