import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const db = spawn(process.execPath, ["scripts/local-db-server.mjs"], {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, LOCAL_DB_PORT: "3142" },
});
const child = spawn(npmCommand, ["run", "start"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, VITE_DATA_SOURCE: "local-db" },
});

function shutdown() {
  if (!db.killed) db.kill();
  if (!child.killed) child.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code, signal) => {
  shutdown();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
