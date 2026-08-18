import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EntityLease,
  EntitySnapshotStore,
  EntityStoreClient,
} from "../lib/entity-store.mjs";
import { startEntityServiceMock } from "./helpers/entity-service-mock.mjs";

function clientFor(mock) {
  return new EntityStoreClient({
    baseUrl: mock.baseUrl,
    apiKey: "test-key",
    namespace: "paperclip",
    ownerEntityId: "360001",
  });
}

test("EntityStoreClient round-trips bytes and honors CAS generations", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const client = clientFor(mock);

  const created = await client.put("test/a.bin", Buffer.from("first"), {
    generation: -1,
  });
  assert.equal(created.generation, 1);
  const read = await client.get("test/a.bin");
  assert.equal(read.data.toString("utf8"), "first");
  assert.equal(read.metadata.generation, 1);

  await assert.rejects(
    client.put("test/a.bin", Buffer.from("stale"), { generation: -1 }),
    (error) => error.conflict,
  );
  const updated = await client.put("test/a.bin", Buffer.from("second"), {
    generation: 1,
  });
  assert.equal(updated.generation, 2);
});

test("EntityLease prevents two Paperclip writers and permits expiry takeover", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const client = clientFor(mock);
  let now = Date.now();
  const first = new EntityLease({
    client,
    key: "instances/default/leader.json",
    holder: "device-one",
    ttlMs: 45_000,
    now: () => now,
  });
  const second = new EntityLease({
    client,
    key: "instances/default/leader.json",
    holder: "device-two",
    ttlMs: 45_000,
    now: () => now,
  });

  assert.equal(await first.acquire(), true);
  assert.equal(await second.acquire(), false);
  now += 46_000;
  assert.equal(await second.acquire(), true);
  assert.equal(await first.renew(), false);
  assert.equal(await second.renew(), true);
});

test("EntitySnapshotStore restores chunked snapshots with SHA-256 verification", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const directory = mkdtempSync(join(tmpdir(), "paperclip-entity-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.bin");
  const destination = join(directory, "restored.bin");
  const expected = Buffer.from("entity-service-snapshot-".repeat(200));
  writeFileSync(source, expected);

  const snapshots = new EntitySnapshotStore({
    client: clientFor(mock),
    keyPrefix: "paperclip/instances/default/database",
    chunkBytes: 257,
  });
  const uploaded = await snapshots.uploadFile(source);
  assert.equal(uploaded.sizeBytes, expected.length);
  assert.ok(uploaded.snapshotId);

  const restored = await snapshots.downloadLatest(destination);
  assert.equal(restored.snapshotId, uploaded.snapshotId);
  assert.deepEqual(readFileSync(destination), expected);
});

test("EntitySnapshotStore round-trips an in-memory PGlite archive", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const expected = Buffer.from("pglite-memory-archive".repeat(300));
  const snapshots = new EntitySnapshotStore({
    client: clientFor(mock),
    keyPrefix: "paperclip/instances/default/database-pglite-v1",
    chunkBytes: 193,
  });

  const uploaded = await snapshots.uploadBuffer(expected);
  const restored = await snapshots.downloadBuffer();
  assert.equal(restored.snapshot.snapshotId, uploaded.snapshotId);
  assert.equal(restored.manifest.fileName, "paperclip-pglite.tar.gz");
  assert.deepEqual(restored.data, expected);
});
