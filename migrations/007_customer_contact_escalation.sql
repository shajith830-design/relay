ALTER TABLE product_implementations
  ADD COLUMN IF NOT EXISTS escalation_email TEXT NOT NULL DEFAULT '';

ALTER TABLE product_implementations
  ADD COLUMN IF NOT EXISTS escalation_delay_days INTEGER NOT NULL DEFAULT 5
  CHECK (escalation_delay_days BETWEEN 3 AND 30);
