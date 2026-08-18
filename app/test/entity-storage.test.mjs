import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createStorageService } from "../node_modules/@paperclipai/server/dist/storage/service.js";
import { createEntityStorageProvider } from "../lib/entity-storage.mjs";
import { EntityStoreClient } from "../lib/entity-store.mjs";
import { startEntityServiceMock } from "./helpers/entity-service-mock.mjs";

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function clientFor(mock) {
  return new EntityStoreClient({
    baseUrl: mock.baseUrl,
    apiKey: "test-key",
    namespace: "paperclip",
    ownerEntityId: "360001",
  });
}

test("Entity storage provider round-trips buffers, streams, ranges, and tombstones", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const provider = createEntityStorageProvider({
    client: clientFor(mock),
    keyPrefix: "paperclip/instances/default/objects",
    chunkBytes: 17,
  });
  const expected = Buffer.from("strict-entity-only-attachment".repeat(5));

  await provider.putObject({
    objectKey: "company/issues/proof.txt",
    body: Readable.from([expected.subarray(0, 20), expected.subarray(20)]),
    contentType: "text/plain",
    contentLength: expected.length,
  });

  const head = await provider.headObject({ objectKey: "company/issues/proof.txt" });
  assert.equal(head.exists, true);
  assert.equal(head.contentLength, expected.length);
  assert.match(head.etag, /^[a-f0-9]{64}$/);

  const complete = await provider.getObject({ objectKey: "company/issues/proof.txt" });
  assert.deepEqual(await readStream(complete.stream), expected);
  const range = await provider.getObject({
    objectKey: "company/issues/proof.txt",
    range: { start: 7, end: 22 },
  });
  assert.deepEqual(await readStream(range.stream), expected.subarray(7, 23));

  await provider.deleteObject({ objectKey: "company/issues/proof.txt" });
  assert.deepEqual(
    await provider.headObject({ objectKey: "company/issues/proof.txt" }),
    { exists: false },
  );
  await assert.rejects(
    provider.getObject({ objectKey: "company/issues/proof.txt" }),
    (error) => error.status === 404,
  );
});

test("Paperclip storage service persists an attachment entirely in Entity blocks", async (t) => {
  const mock = await startEntityServiceMock();
  t.after(() => mock.close());
  const storage = createStorageService(createEntityStorageProvider({
    client: clientFor(mock),
    keyPrefix: "paperclip/instances/default/objects",
    chunkBytes: 8,
  }));
  const body = Buffer.from("paperclip entity attachment proof");
  const saved = await storage.putFile({
    companyId: "company-123",
    namespace: "issues/attachments",
    originalFilename: "proof.txt",
    contentType: "text/plain",
    body,
  });

  assert.equal(saved.provider, "local_disk");
  assert.equal(saved.byteSize, body.length);
  assert.ok(saved.objectKey.startsWith("company-123/issues/attachments/"));
  assert.ok(mock.blocks.size > 2);
  const restored = await storage.getObject("company-123", saved.objectKey);
  assert.deepEqual(await readStream(restored.stream), body);
});
