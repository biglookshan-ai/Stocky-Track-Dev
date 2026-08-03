-- 'TransferAdjustment' (a manual stock edit) was matched by a substring test
-- and stored as a transfer, producing a Transfer badge and a broken
-- /inventory/transfers/<id> link. Reclassify the existing rows.
UPDATE inventory_events
SET source_type = CASE WHEN staff_name IS NOT NULL THEN 'admin_manual' ELSE 'adjustment' END
WHERE source_type = 'transfer'
  AND (reference_document_type ILIKE '%transferadjustment%'
       OR reference_document_type ILIKE '%transfer_adjustment%'
       OR reference_document_uri ILIKE '%TransferAdjustment%');

UPDATE inventory_ledger lg
SET source_type = e.source_type
FROM inventory_events e
WHERE e.id = lg.event_id AND lg.source_type = 'transfer'
  AND e.source_type IN ('admin_manual', 'adjustment');

-- Drop the cached documents built from the mis-typed reference so they are
-- resolved again with the corrected logic.
DELETE FROM reference_documents
WHERE canonical_uri ILIKE 'gid://shopify/InventoryTransfer/%'
  AND (fetch_error IS NOT NULL OR display_name IS NULL);
