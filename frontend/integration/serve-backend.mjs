import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = process.env.MEETORA_TEST_PYTHON || "python";
const server = fileURLToPath(new URL("./seed_server.py", import.meta.url));
// Pass argv directly so Windows paths with spaces and non-ASCII names work.
const child = spawn(python, [server], { stdio: "inherit", windowsHide: true });
child.on("error", (error) => {
  console.error(
    `Cannot run integration backend with ${python}: ${error.message}`,
  );
  console.error(
    "Set MEETORA_TEST_PYTHON to Python with requirements-dev.txt installed.",
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
