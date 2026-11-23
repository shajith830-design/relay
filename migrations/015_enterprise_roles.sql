ALTER TABLE product_memberships
  DROP CONSTRAINT IF EXISTS product_memberships_role_check;

UPDATE product_memberships
SET role = 'contributor'
WHERE role = 'member';

ALTER TABLE product_memberships
  ADD CONSTRAINT product_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'implementation_manager', 'contributor', 'executive_viewer'));

ALTER TABLE product_workspace_invites
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'contributor'
    CHECK (role IN ('admin', 'implementation_manager', 'contributor', 'executive_viewer'));
