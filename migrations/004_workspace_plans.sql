ALTER TABLE product_workspace_subscriptions
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'custom'
    CHECK (plan IN ('starter', 'growth', 'custom'));

ALTER TABLE product_workspace_subscriptions
  ADD COLUMN IF NOT EXISTS member_limit INTEGER
    CHECK (member_limit IS NULL OR member_limit > 0);

ALTER TABLE product_workspace_subscriptions
  ADD COLUMN IF NOT EXISTS active_implementation_limit INTEGER
    CHECK (active_implementation_limit IS NULL OR active_implementation_limit > 0);

ALTER TABLE product_workspace_subscriptions
  ADD COLUMN IF NOT EXISTS template_limit INTEGER
    CHECK (template_limit IS NULL OR template_limit > 0);
