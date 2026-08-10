-- Remember which failure was already announced in Lark, so retrying a failing
-- adjustment does not post the same warning to the group over and over. A
-- different error message is a different event and is announced again.
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS lark_failure_notified_error TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS lark_failure_notified_at TIMESTAMPTZ;
