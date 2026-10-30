CREATE TABLE IF NOT EXISTS product_workspace_subscriptions (
  workspace_id INTEGER PRIMARY KEY REFERENCES product_workspaces(id) ON DELETE CASCADE,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS product_workspace_subscriptions_expiry_idx
  ON product_workspace_subscriptions(expires_at);
