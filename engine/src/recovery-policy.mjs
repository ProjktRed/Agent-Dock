import { createHash } from 'node:crypto';

export const unsafeCauses = new Set(['out-of-scope','unexpected-head','malformed-state','unsafe-commit','missing-permissions','security-policy','policy','corrupted-state','destructive-action']);
export function recoveryClassification(decision = {}) {
  if (decision.status === 'pass') return 'pass';
  const reason = decision.output ?? decision.failureReason ?? '';
  if (decision.status === 'blocked' || unsafeCauses.has(decision.manualReviewCause ?? decision.cause) ||
      /permission denied|access denied|outside (?:approved|allowed)|out.of.scope|unexpected.*HEAD|unsafe.*commit|corrupt(?:ed|ion)?\s+(?:state|repository|repo\b|git|index|recovery)|malformed.*state|cannot reconcile|security.*policy|destructive.*authorization/i.test(reason)) return 'blocked';
  return 'recoverable';
}
export function migrateRecoveryState(live) {
  if (!live || live.stage !== 'manual-review') return live;
  const blocked = recoveryClassification({output:live.latestQa, manualReviewCause:live.manualReviewCause}) === 'blocked';
  return {...live, stage:blocked?'BLOCKED':'USER_ATTENTION', manualReview:false,
    userAttention:!blocked, userAttentionReason:blocked?null:live.latestQa,
    blockedReason:blocked?live.latestQa:null, correctionCount:live.correctionCount??0};
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
export const recoveryFingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function correctionText(result, packet) {
  if (!['correction','strategy-revised'].includes(result.status) || !result.nextWorkerInstructions?.trim()) throw new Error('Malformed recovery result: missing bounded instructions');
  return ['PRESERVE:', ...(result.preserve??[]).map(x=>'- '+x), 'FIX:', result.nextWorkerInstructions,
    'DO NOT:', 'Redo unrelated working implementation, refactor unrelated code, remove passing behavior, or change files outside the original allowedPaths.',
    'EVIDENCE:', result.rootProblem, result.previousStrategyFailure, result.failureReason,
    'RECOMMENDED APPROACH:', result.newStrategy,
    'Completing this correction does not waive remaining original acceptance criteria.',
    `Validation: ${packet.task?.qaCommand ?? packet.qaEvidence?.command?.command ?? ''}`].join('\n');
}

/**
 * Whether QA may review the blocked attempt again (after the user fixed what stopped QA, such as
 * a tool or permission problem): the attempt must be finished, clean and inside its approved paths.
 * The loop still reconciles HEAD and scope before QA runs.
 */
export function qaRetryAvailability(r) {
  if (!r) return { available: false, reason: 'No task in progress' };
  if (r.phase !== 'blocked') return { available: false, reason: 'The task is not blocked' };
  if (!r.qaPacket || !r.workerResult) return { available: false, reason: 'No finished attempt to review' };
  if (r.qaPacket.attempt !== r.attempt) return { available: false, reason: 'The last attempt has no evidence yet' };
  if (r.workerResult.exitCode !== 0) return { available: false, reason: 'The worker did not finish cleanly' };
  if (r.qaPacket.qaEvidence?.scope?.status !== 'PASS') return { available: false, reason: 'The change is outside its approved paths' };
  return { available: true, reason: null };
}

// QA that could not run its tools at all: a sandbox or launcher failure, not a verdict on the code.
const QA_ENVIRONMENT_FAILURE = /helper_unknown_error|setup refresh had errors|failed before execution|is not recognized as an internal or external command|\bsandbox\b[^.\n]{0,80}\b(?:error|errors|denied|failed|refused)\b|\bspawn\b[^\n]{0,80}\bE(?:NOENT|PERM|ACCES)\b/i;

/**
 * Whether a non-pass QA decision came from QA being unable to run commands while the engine's own
 * check run passed. Such a result is retried once instead of becoming a correction for the worker.
 */
export function qaEnvironmentFailure(decision, qaPacket) {
  return Boolean(decision && decision.status !== 'pass' && qaPacket?.qaEvidence?.command?.exitCode === 0 &&
    QA_ENVIRONMENT_FAILURE.test(String(decision.output ?? '')));
}

// Prompt size: a stored correction prompt repeats the whole task; only its correction part is new.
const CORRECTION_PART = /Next bounded correction:\s*([\s\S]*?)\s*Original task and acceptance criteria/;

/** The correction instructions of one stored worker prompt (the whole prompt, bounded, if it has no such part). */
export function correctionInstructions(prompt) {
  const text = String(prompt ?? '');
  return (CORRECTION_PART.exec(text)?.[1] ?? text).slice(0, 6000);
}

/** Correction history for a reasoning prompt: each entry's instructions instead of the full worker prompt. */
export function compactCorrections(history = []) {
  return history.map(({ prompt, ...entry }) => ({ ...entry, instructions: correctionInstructions(prompt) }));
}

/** The QA packet for a reasoning prompt whose input already carries the task and the current diff. */
export function packetForPrompt(packet) {
  if (!packet) return packet;
  const { task, diff, ...rest } = packet;
  return { ...rest, note: 'The task and the current diff are given once, at the top level of this input.' };
}
