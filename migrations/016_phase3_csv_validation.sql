ALTER TABLE product_implementation_steps
  ADD COLUMN IF NOT EXISTS csv_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS csv_schema_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS credential_verification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS credential_verified_provider TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS credential_verified_at TIMESTAMPTZ;

ALTER TABLE product_customer_files
  ADD COLUMN IF NOT EXISTS task_id INTEGER REFERENCES product_implementation_steps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS validation_schema_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE product_customer_files
  DROP CONSTRAINT IF EXISTS product_customer_files_content_type_check;

ALTER TABLE product_customer_files
  ADD CONSTRAINT product_customer_files_content_type_check
  CHECK (content_type IN (
    'application/pdf',
    'image/png',
    'image/jpeg',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ));

CREATE INDEX IF NOT EXISTS product_customer_files_task_idx
  ON product_customer_files(task_id, created_at DESC)
  WHERE task_id IS NOT NULL;
