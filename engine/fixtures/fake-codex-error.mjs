for await (const _chunk of process.stdin) {}
process.stderr.write(`${JSON.stringify({ type: "turn.failed", error: { message: "ordinary fake failure" } })}\n`);
process.exitCode = 1;
