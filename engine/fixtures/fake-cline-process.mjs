import { spawn } from "node:child_process";

const prompt = process.argv.at(-1) ?? "success";
const mode = ["hold-pipes", "nonzero", "timeout", "stdout-first", "stderr-first", "malformed", "incomplete"]
  .find((candidate) => prompt.includes(candidate)) ?? "success";
const result = (finishReason = "completed") =>
  JSON.stringify({ type: "run_result", finishReason, text: prompt });

if (mode === "hold-pipes") {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 900)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  descendant.unref();
  process.stdout.write(`${result()}\n`);
  process.exit(0);
} else if (mode === "nonzero") {
  process.stdout.write(`${result("error")}\n`);
  process.exit(7);
} else if (mode === "timeout") {
  process.stdout.write(`${result("timeout")}` + "\n");
  process.exit(124);
} else if (mode === "stdout-first") {
  process.stdout.end(`${result()}\n`, () => setTimeout(() => process.exit(0), 30));
} else if (mode === "stderr-first") {
  process.stderr.end("diagnostic\n", () => {
    process.stdout.write(`${result()}\n`);
    setTimeout(() => process.exit(0), 30);
  });
} else if (mode === "malformed") {
  process.stdout.write('{"type":"run_result"');
  process.exit(0);
} else if (mode === "incomplete") {
  process.stdout.write(`${JSON.stringify({ type: "run_result" })}\n`);
} else {
  process.stdout.write(`${result()}\n`);
}
