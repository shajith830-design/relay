ALTER TABLE product_implementations
  ADD COLUMN IF NOT EXISTS communication_channel TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS communication_cadence TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS communication_owner_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS communication_owner_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS procurement_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (procurement_status IN ('not_started', 'in_progress', 'approved', 'blocked')),
  ADD COLUMN IF NOT EXISTS security_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (security_status IN ('not_started', 'in_progress', 'approved', 'blocked')),
  ADD COLUMN IF NOT EXISTS security_notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS integration_inventory TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS integration_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (integration_status IN ('not_started', 'discovering', 'in_progress', 'tested', 'blocked')),
  ADD COLUMN IF NOT EXISTS technical_setup_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (technical_setup_status IN ('not_started', 'in_progress', 'tested', 'ready', 'blocked')),
  ADD COLUMN IF NOT EXISTS technical_setup_notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS change_management_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (change_management_status IN ('not_started', 'planned', 'in_progress', 'adopted')),
  ADD COLUMN IF NOT EXISTS adoption_notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS early_validation_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (early_validation_status IN ('not_started', 'planned', 'in_progress', 'passed', 'failed')),
  ADD COLUMN IF NOT EXISTS early_validation_notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS post_launch_support_plan TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS duplicate_request_control TEXT NOT NULL DEFAULT '';
