import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateRecoveryState,recoveryClassification} from '../src/recovery-policy.mjs';
test('migration distinguishes advisory from unsafe without removing evidence',()=>{
  const original={stage:'manual-review',manualReview:true,latestQa:'implementation incomplete',task:{id:'x'},correctionCount:2,elevateResult:{kind:'old'},codexOperation:{status:'completed'}};
  const migrated=migrateRecoveryState(original);assert.equal(migrated.stage,'USER_ATTENTION');assert.equal(migrated.task,original.task);assert.equal(migrated.codexOperation,original.codexOperation);assert.equal(migrated.correctionCount,2);
  assert.equal(migrateRecoveryState({...original,latestQa:'permission denied'}).stage,'BLOCKED');
  for(const cause of ['out-of-scope','unexpected-head','malformed-state','unsafe-commit','missing-permissions','security-policy','destructive-action']) assert.equal(recoveryClassification({manualReviewCause:cause}),'blocked');
});

test('ordinary QA wording about broken code stays recoverable; corrupted state stays blocked',()=>{
  // Regression: Sonnet QA described a malformed test file as "Corrupted structure" and the loop hard-blocked.
  assert.equal(recoveryClassification({status:'fail',output:'QA FAIL. Test file findings: 1. Corrupted structure: orphan body, duplicated it() blocks.'}),'recoverable');
  assert.equal(recoveryClassification({status:'fail',output:'the edit corrupted the test file'}),'recoverable');
  assert.equal(recoveryClassification({status:'fail',output:'corrupted state file .state/live.json'}),'blocked');
  assert.equal(recoveryClassification({status:'fail',output:'git index corruption detected: corrupt git index'}),'blocked');
  assert.equal(recoveryClassification({status:'fail',output:'malformed recovery state'}),'blocked');
});
