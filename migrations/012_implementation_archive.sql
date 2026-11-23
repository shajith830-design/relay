ALTER TABLE product_implementations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS product_implementations_archived_idx
  ON product_implementations(workspace_id, archived_at)
  WHERE archived_at IS NOT NULL;
