-- Snapshot drift alerts were an internal implementation detail and could make
-- already-correct Shopify inventory look uncertain to users. Preserve the
-- historical rows for auditability, but archive every open alert. New
-- snapshots refresh current_levels silently and do not insert new alerts.
UPDATE reconcile_alerts SET resolved = true WHERE NOT resolved;
