import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import postgres from "postgres";
import { EntityBackedPostgres } from "../lib/entity-backed-postgres.mjs";
import { EntityRuntimeStore } from "../lib/entity-runtime.mjs";
import { EntitySnapshotStore, EntityStoreClient } from "../lib/entity-store.mjs";
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

function snapshotStore(mock, suffix) {
  const client = new EntityStoreClient({
    baseUrl: mock.baseUrl,
    apiKey: "test-key",
    namespace: "paperclip",
    ownerEntityId: "360001",
  });
  return new EntitySnapshotStore({
    client,
    keyPrefix: `paperclip/instances/default/${suffix}`,
    chunkBytes: 1024,
  });
}

test("Paperclip SQL data survives a fresh device through Entity Service", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const directory = mkdtempSync(join(tmpdir(), "paperclip-entity-postgres-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const snapshots = snapshotStore(mock, "database");
  const silent = () => {};

  const first = new EntityBackedPostgres({
    dataDir: join(directory, "device-one"),
    port: await freePort(),
    snapshotStore: snapshots,
    onLog: silent,
    onError: silent,
  });
  const firstUrl = await first.start();
  const firstSql = postgres(firstUrl, { max: 1 });
  await firstSql`
    create table proof_items (
      id integer primary key,
      message text not null
    )
  `;
  await firstSql`insert into proof_items (id, message) values (1, 'stored by Omnira Entity Service')`;
  await firstSql.end();
  const snapshot = await first.backup();
  assert.ok(snapshot.snapshotId);
  await first.stop();

  const second = new EntityBackedPostgres({
    dataDir: join(directory, "device-two"),
    port: await freePort(),
    snapshotStore: snapshots,
    onLog: silent,
    onError: silent,
  });
  const secondUrl = await second.start();
  t.after(() => second.stop());
  const secondSql = postgres(secondUrl, { max: 1 });
  const rows = await secondSql`select id, message from proof_items`;
  await secondSql.end();

  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { id: 1, message: "stored by Omnira Entity Service" },
  ]);
  assert.equal(second.lastSnapshot.snapshotId, snapshot.snapshotId);
});

test("Paperclip config, secrets, and attachments restore on a fresh device", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const directory = mkdtempSync(join(tmpdir(), "paperclip-entity-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const snapshots = snapshotStore(mock, "runtime");
  const firstHome = join(directory, "device-one");
  const instanceRoot = join(firstHome, "instances", "default");
  mkdirSync(join(instanceRoot, "secrets"), { recursive: true });
  mkdirSync(join(instanceRoot, "data", "storage"), { recursive: true });
  writeFileSync(join(instanceRoot, "config.json"), '{"version":"proof"}\n');
  writeFileSync(join(instanceRoot, "secrets", "master.key"), "secret-proof\n");
  writeFileSync(join(instanceRoot, "data", "storage", "attachment.txt"), "attachment-proof\n");

  const first = new EntityRuntimeStore({
    paperclipHome: firstHome,
    instanceId: "default",
    snapshotStore: snapshots,
  });
  const uploaded = await first.backup();
  assert.ok(uploaded.snapshotId);

  const secondHome = join(directory, "device-two");
  mkdirSync(secondHome, { recursive: true });
  const second = new EntityRuntimeStore({
    paperclipHome: secondHome,
    instanceId: "default",
    snapshotStore: snapshots,
  });
  const restored = await second.restoreLatest();
  assert.equal(restored.snapshotId, uploaded.snapshotId);
  assert.equal(
    readFileSync(join(secondHome, "instances", "default", "config.json"), "utf8"),
    '{"version":"proof"}\n',
  );
  assert.equal(
    readFileSync(join(secondHome, "instances", "default", "secrets", "master.key"), "utf8"),
    "secret-proof\n",
  );
  assert.equal(
    readFileSync(
      join(secondHome, "instances", "default", "data", "storage", "attachment.txt"),
      "utf8",
    ),
    "attachment-proof\n",
  );
});
