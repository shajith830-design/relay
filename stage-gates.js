"use strict";

const STAGE_GATE_ORDER = Object.freeze([
  "kickoff",
  "configuration",
  "testing",
  "launch",
  "hypercare",
  "complete"
]);

const APPROVAL_STAGE_GATES = Object.freeze(STAGE_GATE_ORDER.slice(0, -1));

function stagesRequiringApprovalBeforeMove(currentStage, nextStage) {
  const currentIndex = STAGE_GATE_ORDER.indexOf(currentStage);
  const nextIndex = STAGE_GATE_ORDER.indexOf(nextStage);
  if (currentIndex < 0 || nextIndex < 0) return null;
  return nextIndex > currentIndex
    ? STAGE_GATE_ORDER.slice(currentIndex, nextIndex)
    : [];
}

module.exports = {
  APPROVAL_STAGE_GATES,
  STAGE_GATE_ORDER,
  stagesRequiringApprovalBeforeMove
};
