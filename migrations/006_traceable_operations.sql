-- Traceable adjustment actors, participants and cached Shopify references.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS employee_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_employee_code
  ON staff (lower(employee_code)) WHERE employee_code IS NOT NULL;

ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS display_number TEXT;
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS created_by_staff_id INT REFERENCES staff(id);
ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS applied_by_staff_id INT REFERENCES staff(id);

UPDATE adjustments
SET display_number = 'ADJ-' || lpad(number::text, 5, '0')
WHERE display_number IS NULL AND number IS NOT NULL;

UPDATE adjustments
SET created_by_staff_id = staff_id
WHERE created_by_staff_id IS NULL AND staff_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustments_display_number
  ON adjustments (display_number) WHERE display_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS adjustment_participants (
  id                     BIGSERIAL PRIMARY KEY,
  adjustment_id          INT NOT NULL REFERENCES adjustments(id) ON DELETE CASCADE,
  role                   TEXT NOT NULL, -- recorded_by | handled_by
  staff_id               INT REFERENCES staff(id),
  display_name_snapshot  TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role IN ('recorded_by', 'handled_by'))
);

CREATE INDEX IF NOT EXISTS idx_adjustment_participants_adjustment
  ON adjustment_participants (adjustment_id, role, id);
CREATE INDEX IF NOT EXISTS idx_adjustment_participants_staff
  ON adjustment_participants (staff_id, adjustment_id);
CREATE INDEX IF NOT EXISTS idx_adjustment_participants_name
  ON adjustment_participants (lower(display_name_snapshot));
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_recorded_by
  ON adjustment_participants (adjustment_id) WHERE role = 'recorded_by';

-- Existing adjustments used staff_id as both login account and business actor.
-- Preserve that attribution as the initial recorded-by participant.
INSERT INTO adjustment_participants
  (adjustment_id, role, staff_id, display_name_snapshot)
SELECT a.id, 'recorded_by', a.staff_id, s.display_name
FROM adjustments a
JOIN staff s ON s.id = a.staff_id
WHERE NOT EXISTS (
  SELECT 1 FROM adjustment_participants ap
  WHERE ap.adjustment_id = a.id AND ap.role = 'recorded_by'
);

CREATE TABLE IF NOT EXISTS reference_documents (
  canonical_uri   TEXT PRIMARY KEY,
  document_type   TEXT NOT NULL,
  shopify_id      TEXT,
  display_name    TEXT,
  customer_name   TEXT,
  status          TEXT,
  admin_url       TEXT,
  details         JSONB,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_reference_documents_display
  ON reference_documents (lower(display_name));
CREATE INDEX IF NOT EXISTS idx_reference_documents_customer
  ON reference_documents (lower(customer_name));
