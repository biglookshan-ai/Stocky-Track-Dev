-- History views join adjustments by shopify_group_gid on every row; without an
-- index this made the 修改记录 list noticeably slow.
CREATE INDEX IF NOT EXISTS idx_adjustments_group_gid
  ON adjustments (shopify_group_gid) WHERE shopify_group_gid IS NOT NULL;
