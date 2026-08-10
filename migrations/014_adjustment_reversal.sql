-- One-click reversal: a reversing adjustment records which applied adjustment
-- it undoes, so the original can show "reversed by ..." and block duplicates.
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS reversal_of_adjustment_id INT REFERENCES adjustments(id);
CREATE INDEX IF NOT EXISTS idx_adjustments_reversal_of ON adjustments(reversal_of_adjustment_id)
  WHERE reversal_of_adjustment_id IS NOT NULL;
