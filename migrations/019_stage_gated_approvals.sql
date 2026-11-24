ALTER TABLE product_approval_requests
  ADD COLUMN IF NOT EXISTS stage_gate TEXT;

UPDATE product_approval_requests approval
SET stage_gate = implementation.stage_gate_status
FROM product_implementations implementation
WHERE approval.implementation_id = implementation.id
  AND approval.stage_gate IS NULL;

ALTER TABLE product_approval_requests
  ALTER COLUMN stage_gate SET DEFAULT 'kickoff',
  ALTER COLUMN stage_gate SET NOT NULL;

ALTER TABLE product_approval_requests
  ADD CONSTRAINT product_approval_requests_stage_gate_check
  CHECK (stage_gate IN ('kickoff', 'configuration', 'testing', 'launch', 'hypercare', 'complete'));

CREATE INDEX IF NOT EXISTS product_approval_requests_gate_status_idx
  ON product_approval_requests(implementation_id, stage_gate, status);
