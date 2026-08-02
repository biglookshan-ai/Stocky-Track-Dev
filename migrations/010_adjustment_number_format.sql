-- Adopt the A<seq4>-YYMMDD adjustment number format (sequence first, then date).
-- Regenerate existing app-created numbers (imported STK-… are left untouched).
UPDATE adjustments
SET display_number = 'A' || lpad(number::text, 4, '0') || '-' || to_char(created_at, 'YYMMDD')
WHERE number IS NOT NULL AND display_number LIKE 'ADJ-%';
