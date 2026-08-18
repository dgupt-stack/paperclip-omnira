import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startEntityServiceMock } from "./helpers/entity-service-mock.mjs";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForProof(url, child, logs, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrapper exited with ${child.exitCode}\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${url}/_omnira/storage`);
      lastStatus = await response.json();
      if (
        response.ok &&
        lastStatus.mode === "leader" &&
        lastStatus.lastDatabaseSnapshot?.snapshotId &&
        lastStatus.lastRuntimeSnapshot?.snapshotId
      ) {
        return lastStatus;
      }
    } catch {
      // The public proxy may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `wrapper did not produce Entity persistence proof: ${JSON.stringify(lastStatus)}\n${logs.join("")}`,
  );
}

test("full Paperclip wrapper becomes healthy with Entity Service persistence", async (t) => {
  const mock = await startEntityServiceMock();
  const home = mkdtempSync(join(tmpdir(), "paperclip-entity-e2e-"));
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PAPERCLIP_HOME: home,
      PAPERCLIP_STORAGE_BACKEND: "omnira-entity",
      PAPERCLIP_PUBLIC_HOST: `127.0.0.1:${port}`,
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      OMNIRA_ENTITY_URL: mock.baseUrl,
      OMNIRA_ENTITY_API_KEY: "test-key",
      OMNIRA_ENTITY_OWNER_ID: "360001",
      OMNIRA_ENTITY_NAMESPACE: "paperclip",
      OMNIRA_ENTITY_BACKUP_INTERVAL_SECONDS: "15",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
    }
    await mock.close();
    rmSync(home, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const proof = await waitForProof(baseUrl, child, logs);
  assert.equal(proof.storageBackend, "omnira-entity-blockstore");
  assert.equal(proof.durableStore, "Omnira Entity Service BlockStore");
  assert.equal(proof.paperclipHealth, "ok");

  const app = await fetch(baseUrl, { headers: { Accept: "text/html" } });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /<!doctype html>/i);
});
