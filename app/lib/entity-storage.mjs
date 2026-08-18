import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  badRequest,
  notFound,
  unprocessable,
} from "../node_modules/@paperclipai/server/dist/errors.js";
import { EntityStoreError } from "./entity-store.mjs";

// Entity blocks travel through Omnira's gRPC tunnel as base64 JSON. Keep each
// raw chunk comfortably below the 4 MiB transport frame after encoding.
const DEFAULT_CHUNK_BYTES = 512 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeObjectKey(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    throw badRequest("Invalid object key");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw badRequest("Invalid object key");
  }
  return parts.join("/");
}

async function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createEntityStorageProvider({
  client,
  keyPrefix,
  chunkBytes = DEFAULT_CHUNK_BYTES,
}) {
  if (!client) throw new Error("Entity Service client is required");
  if (!keyPrefix) throw new Error("Entity storage key prefix is required");
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("Entity storage chunk size must be a positive integer");
  }

  const prefix = keyPrefix.replace(/^\/+|\/+$/g, "");
  const manifestKey = (objectKey) => `${prefix}/${normalizeObjectKey(objectKey)}/manifest.json`;

  async function readManifest(objectKey) {
    const block = await client.getJsonOptional(manifestKey(objectKey));
    if (!block || block.value.deleted) return null;
    return block;
  }

  async function loadObject(objectKey) {
    const manifestBlock = await readManifest(objectKey);
    if (!manifestBlock) throw notFound("Object not found");
    const { value: manifest } = manifestBlock;
    const chunks = [];
    let sizeBytes = 0;
    const fullHash = createHash("sha256");
    for (const expected of manifest.chunks) {
      const block = await client.get(expected.key);
      if (block.data.length !== Number(expected.sizeBytes)) {
        throw new Error(`Entity object chunk ${expected.key} has the wrong size`);
      }
      if (sha256(block.data) !== expected.sha256) {
        throw new Error(`Entity object chunk ${expected.key} failed SHA-256 verification`);
      }
      chunks.push(block.data);
      sizeBytes += block.data.length;
      fullHash.update(block.data);
    }
    if (sizeBytes !== Number(manifest.sizeBytes)) {
      throw new Error("Entity object has the wrong size");
    }
    if (fullHash.digest("hex") !== manifest.sha256) {
      throw new Error("Entity object failed SHA-256 verification");
    }
    return { manifest, data: Buffer.concat(chunks, sizeBytes) };
  }

  return {
    // Paperclip persists this identifier in its asset records. The bytes themselves
    // live only in Entity Service; no local-disk provider is constructed.
    id: "local_disk",

    async putObject(input) {
      const objectKey = normalizeObjectKey(input.objectKey);
      const bytes = await bodyToBuffer(input.body);
      if (Number(input.contentLength) !== bytes.length) {
        throw unprocessable("Object content length does not match its body");
      }
      const current = await client.getJsonOptional(manifestKey(objectKey));
      const versionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      const versionPrefix = `${prefix}/${objectKey}/versions/${versionId}`;
      const chunks = [];
      for (let offset = 0, index = 0; offset < bytes.length || index === 0; index += 1) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
        const key = `${versionPrefix}/chunks/${String(index).padStart(6, "0")}.bin`;
        await client.put(key, chunk, { generation: -1 });
        chunks.push({ key, sizeBytes: chunk.length, sha256: sha256(chunk) });
        offset += chunk.length;
        if (bytes.length === 0) break;
      }
      const createdAt = new Date().toISOString();
      const manifest = {
        version: 1,
        objectKey,
        versionId,
        createdAt,
        updatedAt: createdAt,
        contentType: input.contentType,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        chunks,
        deleted: false,
      };
      try {
        await client.putJson(manifestKey(objectKey), manifest, {
          generation: current ? current.metadata.generation : -1,
        });
      } catch (error) {
        if (error instanceof EntityStoreError && error.conflict) {
          throw new Error(`Concurrent write rejected for Entity object ${objectKey}`, {
            cause: error,
          });
        }
        throw error;
      }
    },

    async getObject(input) {
      const { manifest, data } = await loadObject(input.objectKey);
      let selected = data;
      if (input.range) {
        const start = Number(input.range.start);
        const end = Number(input.range.end);
        if (
          !Number.isSafeInteger(start)
          || !Number.isSafeInteger(end)
          || start < 0
          || end < start
          || start >= data.length
        ) {
          throw badRequest("Invalid object byte range");
        }
        selected = data.subarray(start, Math.min(end + 1, data.length));
      }
      return {
        stream: Readable.from([selected]),
        contentType: manifest.contentType,
        contentLength: selected.length,
        etag: manifest.sha256,
        lastModified: new Date(manifest.updatedAt),
      };
    },

    async headObject(input) {
      const block = await readManifest(input.objectKey);
      if (!block) return { exists: false };
      return {
        exists: true,
        contentType: block.value.contentType,
        contentLength: Number(block.value.sizeBytes),
        etag: block.value.sha256,
        lastModified: new Date(block.value.updatedAt),
      };
    },

    async deleteObject(input) {
      const key = manifestKey(input.objectKey);
      const current = await client.getJsonOptional(key);
      if (!current || current.value.deleted) return;
      await client.putJson(
        key,
        {
          ...current.value,
          deleted: true,
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { generation: current.metadata.generation },
      );
    },
  };
}
