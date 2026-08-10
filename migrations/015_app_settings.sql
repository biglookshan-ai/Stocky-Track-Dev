-- Settings the shop owner edits in the app (as opposed to sync_state, which the
-- background jobs own). Secrets inside the JSON are encrypted before they land
-- here, the same way offline Shopify tokens are.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
