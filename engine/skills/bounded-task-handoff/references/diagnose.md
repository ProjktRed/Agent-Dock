# Diagnostic evidence

Reproduce the smallest relevant failure first. Record the exact command, completion/exit status, and directly observed lifecycle or code boundary. Add only in-scope instrumentation needed to test a specific hypothesis. Compare baseline resources with resources owned by the run; do not attribute unrelated processes to it. Implement a fix only after executable evidence identifies the cause and the fix is within scope. Otherwise report observations, limitations, and the next missing evidence without guessing.
