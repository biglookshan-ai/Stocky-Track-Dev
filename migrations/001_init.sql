-- Core schema. Ledger is append-only: business columns are never UPDATEd.

CREATE TABLE IF NOT EXISTS shops (
  id            SERIAL PRIMARY KEY,
  shop_domain   TEXT UNIQUE NOT NULL,
  installed_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  id               SERIAL PRIMARY KEY,
  shopify_user_id  TEXT UNIQUE,
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member',   -- admin | member
  active           BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS locations (
  id           SERIAL PRIMARY KEY,
  shopify_gid  TEXT UNIQUE,                          -- gid://shopify/Location/…
  name         TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true
);

-- One row per sellable variant. source=shopify rows mirror Shopify variants;
-- source=local rows are Stocky-style internal items (the "#" components) that
-- only exist in this app.
CREATE TABLE IF NOT EXISTS items (
  id                          SERIAL PRIMARY KEY,
  source                      TEXT NOT NULL DEFAULT 'shopify',  -- shopify | local
  shopify_variant_gid         TEXT UNIQUE,
  shopify_inventory_item_gid  TEXT UNIQUE,
  shopify_product_gid         TEXT,
  product_title               TEXT NOT NULL DEFAULT '',
  variant_title               TEXT NOT NULL DEFAULT '',
  sku                         TEXT NOT NULL DEFAULT '',
  barcode                     TEXT NOT NULL DEFAULT '',
  vendor                      TEXT NOT NULL DEFAULT '',
  price                       NUMERIC(12,2),
  unit_cost                   NUMERIC(12,2),
  tracked                     BOOLEAN NOT NULL DEFAULT true,
  status                      TEXT NOT NULL DEFAULT 'active',   -- active | archived | deleted
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_items_sku ON items (sku);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items (barcode);
CREATE INDEX IF NOT EXISTS idx_items_vendor ON items (vendor);

-- Last known quantity per item+location, maintained by webhooks + syncs.
-- This is what ledger delta calculation reads/writes; snapshots reconcile it.
CREATE TABLE IF NOT EXISTS current_levels (
  item_id      INT NOT NULL REFERENCES items(id),
  location_id  INT NOT NULL REFERENCES locations(id),
  available    INT,
  on_hand      INT,
  updated_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_id, location_id)
);

-- ① The ledger. Append-only.
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id            BIGSERIAL PRIMARY KEY,
  item_id       INT NOT NULL REFERENCES items(id),
  location_id   INT NOT NULL REFERENCES locations(id),
  state         TEXT NOT NULL DEFAULT 'available',    -- available | on_hand
  delta         INT NOT NULL,
  qty_after     INT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type   TEXT NOT NULL DEFAULT 'unknown',
    -- sale | refund | adjustment | stocktake | bundle_op | transfer |
    -- external_app | admin_manual | import | reconciliation | unknown
  source_ref    TEXT,                                 -- order name / adjustment id / webhook id…
  reason_code   TEXT,
  staff_id      INT REFERENCES staff(id),
  notes         TEXT,
  attribution   TEXT NOT NULL DEFAULT 'pending',      -- pending | matched | shopifyql | manual | n/a
  attributed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ledger_item ON inventory_ledger (item_id, location_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_occurred ON inventory_ledger (occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_pending ON inventory_ledger (attribution) WHERE attribution = 'pending';

-- Raw webhook archive; webhook_id gives us idempotency.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    TEXT UNIQUE,
  topic         TEXT NOT NULL,
  shop_domain   TEXT,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_we_unprocessed ON webhook_events (received_at) WHERE processed_at IS NULL;

-- ③ Daily snapshots (incremental: a row is written when the value differs from
-- the previous snapshot; a full baseline is written on the 1st of each month).
CREATE TABLE IF NOT EXISTS daily_snapshots (
  snap_date    DATE NOT NULL,
  item_id      INT NOT NULL REFERENCES items(id),
  location_id  INT NOT NULL REFERENCES locations(id),
  available    INT,
  on_hand      INT,
  unit_cost    NUMERIC(12,2),
  PRIMARY KEY (snap_date, item_id, location_id)
);

CREATE TABLE IF NOT EXISTS reconcile_alerts (
  id           BIGSERIAL PRIMARY KEY,
  snap_date    DATE NOT NULL,
  item_id      INT NOT NULL REFERENCES items(id),
  location_id  INT NOT NULL REFERENCES locations(id),
  expected     INT,
  actual       INT,
  resolved     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Adjustments (M2; schema in place from day one so imports can target it).
CREATE TABLE IF NOT EXISTS adjustment_reasons (
  id        SERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  direction TEXT NOT NULL DEFAULT 'any',              -- in | out | any
  active    BOOLEAN NOT NULL DEFAULT true,
  position  INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS adjustments (
  id          SERIAL PRIMARY KEY,
  number      INT UNIQUE,                             -- continues Stocky numbering
  reason_id   INT REFERENCES adjustment_reasons(id),
  staff_id    INT REFERENCES staff(id),
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'draft',          -- draft | applied | archived
  applied_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adjustment_lines (
  id             BIGSERIAL PRIMARY KEY,
  adjustment_id  INT NOT NULL REFERENCES adjustments(id),
  item_id        INT NOT NULL REFERENCES items(id),
  location_id    INT NOT NULL REFERENCES locations(id),
  qty_before     INT,
  delta          INT NOT NULL,
  qty_after      INT,
  unit_cost      NUMERIC(12,2)
);
CREATE INDEX IF NOT EXISTS idx_adjlines_adj ON adjustment_lines (adjustment_id);
CREATE INDEX IF NOT EXISTS idx_adjlines_item ON adjustment_lines (item_id);

-- Virtual stock (first-class; each entry links to the applying/reverting adjustment).
CREATE TABLE IF NOT EXISTS virtual_stock (
  id                    SERIAL PRIMARY KEY,
  item_id               INT NOT NULL REFERENCES items(id),
  location_id           INT NOT NULL REFERENCES locations(id),
  qty                   INT NOT NULL,
  bundle_item_id        INT REFERENCES items(id),
  reason                TEXT,
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'active',  -- active | reverted
  created_by            INT REFERENCES staff(id),
  created_at            TIMESTAMPTZ DEFAULT now(),
  apply_adjustment_id   INT REFERENCES adjustments(id),
  revert_adjustment_id  INT REFERENCES adjustments(id)
);

-- Stocktakes (M3).
CREATE TABLE IF NOT EXISTS stocktakes (
  id             SERIAL PRIMARY KEY,
  number         INT UNIQUE,
  name           TEXT NOT NULL DEFAULT '',
  location_id    INT REFERENCES locations(id),
  scope_filter   JSONB,
  status         TEXT NOT NULL DEFAULT 'open',        -- open | counting | completed
  created_by     INT REFERENCES staff(id),
  created_at     TIMESTAMPTZ DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  adjustment_id  INT REFERENCES adjustments(id)
);

CREATE TABLE IF NOT EXISTS stocktake_lines (
  stocktake_id  INT NOT NULL REFERENCES stocktakes(id),
  item_id       INT NOT NULL REFERENCES items(id),
  expected_qty  INT,
  counted_qty   INT NOT NULL DEFAULT 0,
  counted_by    INT REFERENCES staff(id),
  counted_at    TIMESTAMPTZ,
  PRIMARY KEY (stocktake_id, item_id)
);

-- Bundle BOM (M3).
CREATE TABLE IF NOT EXISTS bundle_components (
  bundle_item_id     INT NOT NULL REFERENCES items(id),
  component_item_id  INT NOT NULL REFERENCES items(id),
  qty                INT NOT NULL DEFAULT 1,
  PRIMARY KEY (bundle_item_id, component_item_id)
);

-- Misc state: sync cursors, job locks, last-run timestamps.
CREATE TABLE IF NOT EXISTS sync_state (
  key    TEXT PRIMARY KEY,
  value  JSONB,
  ts     TIMESTAMPTZ DEFAULT now()
);

-- Seed the 11 reasons currently in use in Stocky (usage counts as of 2026-07-10
-- for reference: Manual adjustment 1173, -Manual invoice 536, Manual Stock count
-- 100, Virtual stock adjustment 96, -Demo Stock 92, Demo 82, +Return restock 81,
-- -Staff purchase 10, -Damaged 7, -Resend order 3, Stocky Stocktakes 9).
INSERT INTO adjustment_reasons (name, direction, position) VALUES
  ('Manual adjustment', 'any', 1),
  ('-Manual invoice', 'out', 2),
  ('Manual Stock count', 'any', 3),
  ('Virtual stock adjustment', 'any', 4),
  ('-Demo Stock', 'out', 5),
  ('Demo', 'out', 6),
  ('+Return restock', 'in', 7),
  ('-Staff purchase', 'out', 8),
  ('-Damaged', 'out', 9),
  ('-Resend order', 'out', 10),
  ('Stocktake', 'any', 11)
ON CONFLICT (name) DO NOTHING;
