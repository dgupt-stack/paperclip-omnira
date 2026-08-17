import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const serviceName = process.env.OMNIRA_SERVICE_NAME || "paperclip";
const publicHost =
  process.env.PAPERCLIP_PUBLIC_HOST ||
  `${serviceName}-k4u67azzg5.app.omnira.dev`;
const publicUrl =
  process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || `https://${publicHost}`;
const paperclipHome =
  process.env.PAPERCLIP_HOME || join(homedir(), ".paperclip-omnira");
const configPath = join(
  paperclipHome,
  "instances",
  process.env.PAPERCLIP_INSTANCE_ID || "default",
  "config.json",
);

mkdirSync(paperclipHome, { recursive: true });

const env = {
  ...process.env,
  HOST: "0.0.0.0",
  PORT: process.env.PORT || "8080",
  PAPERCLIP_HOME: paperclipHome,
  PAPERCLIP_BIND: "custom",
  PAPERCLIP_BIND_HOST: "0.0.0.0",
  PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
  PAPERCLIP_DEPLOYMENT_EXPOSURE:
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "private",
  PAPERCLIP_AUTH_PUBLIC_BASE_URL: publicUrl,
  PAPERCLIP_ALLOWED_HOSTNAMES: publicHost,
  PAPERCLIP_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
};

const cli = join(
  process.cwd(),
  "node_modules",
  "paperclipai",
  "dist",
  "index.js",
);

const args = existsSync(configPath)
  ? [cli, "run"]
  : [
      cli,
      "onboard",
      "--yes",
      "--data-dir",
      paperclipHome,
    ];

const child = spawn(process.execPath, args, {
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
