ALTER TABLE product_workspace_events
  ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;

ALTER TABLE product_customer_files
  ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;

ALTER TABLE product_customer_files
  DROP CONSTRAINT IF EXISTS product_customer_files_scan_status_check;

ALTER TABLE product_customer_files
  ADD CONSTRAINT product_customer_files_scan_status_check
  CHECK (scan_status IN ('pending', 'clean', 'infected'));
