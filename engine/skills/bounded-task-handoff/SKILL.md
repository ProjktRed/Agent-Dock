---
name: bounded-task-handoff
description: Prepare precise Codex-to-Cline tasks and report exact implementation and validation evidence in the local automation loop.
---

# Shared skill: bounded-task-handoff

Apply the section for your role. Repository instructions and the approved task scope still apply. This skill does not authorize a new task, wider paths, implementation by QA, or acceptance by Cline.

## Codex: assessment and correction

Give Cline one achievable outcome, not a project plan. Use plain, direct instructions with these fields:

- Task skill: diagnose|implement|verify — select one mode for this attempt, not the literal alternatives.
- Goal: one observable result.
- Evidence: the current failing behavior and what is known versus unknown. Do not invent a root cause.
- Changes: exact approved files and known symbols/configuration, the required behavior, and whether to retain, amend, or revert existing work. For diagnosis, specify the evidence to collect instead of guessing a fix.
- Boundaries: allowedPaths, preserved behavior, and explicit non-goals.
- Validation: exact commands, required outcome, and the condition at which to stop and report a blocker.

Choose [diagnose](references/diagnose.md) for unresolved causes, [implement](references/implement.md) for an evidenced change, or [verify](references/verify.md) for bounded validation. Node supplies only the selected reference to Cline. Keep the original task's scope and acceptance criteria on corrections; reassessment advice is not permission to widen them.

## Cline: execution and final handoff

Use the supplied selected mode. Stay within the assigned task; Codex owns independent QA, commits, and next-task selection. End with a concise report (target under 1,800 characters):

SKILL: selected mode and how it was applied.
CHANGES: each changed file, symbol/configuration, and exact completed behavior; say none if no change was made.
TESTS: each exact command actually run, exit code, passed/failed counts when reported, and result. Use NOT RUN with a reason for required checks you did not run. An interrupted/hanging command is INCONCLUSIVE, never PASS from progress lines alone.
EVIDENCE: observed resource/cause or result; distinguish observations from hypotheses.
BLOCKERS: unresolved issues and incomplete acceptance criteria, or none. Do not claim Codex acceptance.

## Codex: independent QA and advisory handoff

Compare CHANGES and TESTS against the scoped diff and Node's deterministic evidence. A self-report or skill-use claim is not proof of correctness. Investigate only missing/conflicting/inconclusive evidence; never invent missing results. QA reports findings and remaining criteria; Assessment owns correction drafting. PASS remains subject to normal QA and safe-commit rules.

Elevation revises strategy; the local worker implements its bounded instructions, then independent QA judges the resulting evidence. Recoverable problems receive User Attention and continue through Assessment. Unsafe Git, scope, state, permission or policy conditions are BLOCKED.

Assessment corrections use PRESERVE, FIX, DO NOT, EVIDENCE, RECOMMENDED APPROACH, and ACCEPTANCE STILL REQUIRED. Preserve correct existing work and original scope. Missing evidence calls for bounded executable diagnosis, not a speculative repair.
