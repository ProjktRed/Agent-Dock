# Implementation regression

Make the exact assigned change, retaining valid existing work. When a behavior changes, reproduce its failure with a focused test before editing and rerun it afterward. Run the task's required checks; report their actual results and unresolved regressions. Do not replace failed checks with weaker assertions, wrappers, forced success, or unrelated refactors. Stop with a precise blocker when the required change would cross approved paths.
