import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_CHUNK_BYTES = 3 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encodedBlockPath(namespace, key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `/v1/blocks/${encodeURIComponent(namespace)}/${encodedKey}`;
}

export class EntityStoreError extends Error {
  constructor(message, { status = 0, body = "", cause } = {}) {
    super(message, { cause });
    this.name = "EntityStoreError";
    this.status = status;
    this.body = body;
  }

  get notFound() {
    return this.status === 404 || this.status === 410;
  }

  get conflict() {
    return this.status === 409;
  }
}

export class EntityStoreClient {
  constructor({ baseUrl, apiKey, namespace, ownerEntityId, fetchImpl = fetch }) {
    if (!baseUrl) throw new Error("Entity Service base URL is required");
    if (!apiKey) throw new Error("Entity Service API key is required");
    if (!namespace) throw new Error("Entity Service namespace is required");
    if (!/^\d+$/.test(String(ownerEntityId)) || Number(ownerEntityId) <= 0) {
      throw new Error("Entity Service owner entity ID must be a positive integer");
    }

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.namespace = namespace;
    this.ownerEntityId = String(ownerEntityId);
    this.fetchImpl = fetchImpl;
  }

  async request(method, key, { body } = {}) {
    let response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}${encodedBlockPath(this.namespace, key)}`,
        {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    } catch (cause) {
      throw new EntityStoreError(`Entity Service ${method} failed: ${cause.message}`, {
        cause,
      });
    }

    const responseBody = await response.text();
    if (!response.ok) {
      throw new EntityStoreError(
        `Entity Service ${method} ${key} returned HTTP ${response.status}`,
        { status: response.status, body: responseBody },
      );
    }

    if (!responseBody) return {};
    try {
      return JSON.parse(responseBody);
    } catch (cause) {
      throw new EntityStoreError(
        `Entity Service ${method} ${key} returned invalid JSON`,
        { status: response.status, body: responseBody, cause },
      );
    }
  }

  async get(key) {
    const response = await this.request("GET", key);
    const metadata = response.metadata ?? response.block ?? {};
    return {
      data: Buffer.from(response.data ?? "", "base64"),
      metadata: {
        ...metadata,
        generation: Number(metadata.generation ?? 0),
        sizeBytes: Number(metadata.sizeBytes ?? 0),
      },
    };
  }

  async getOptional(key) {
    try {
      return await this.get(key);
    } catch (error) {
      if (error instanceof EntityStoreError && error.notFound) return null;
      throw error;
    }
  }

  async put(key, data, { contentType = "application/octet-stream", generation = 0 } = {}) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const metadata = await this.request("PUT", key, {
      body: {
        data: bytes.toString("base64"),
        contentType,
        ownerEntityId: this.ownerEntityId,
        ifGenerationMatch: String(generation),
      },
    });
    return {
      ...metadata,
      generation: Number(metadata.generation ?? 0),
      sizeBytes: Number(metadata.sizeBytes ?? bytes.length),
    };
  }

  async getJson(key) {
    const block = await this.get(key);
    return { ...block, value: JSON.parse(block.data.toString("utf8")) };
  }

  async getJsonOptional(key) {
    const block = await this.getOptional(key);
    if (!block) return null;
    return { ...block, value: JSON.parse(block.data.toString("utf8")) };
  }

  async putJson(key, value, { generation = 0 } = {}) {
    return this.put(key, Buffer.from(JSON.stringify(value)), {
      contentType: "application/json",
      generation,
    });
  }
}

export class EntityLease {
  constructor({ client, key, holder, ttlMs = 45_000, now = () => Date.now() }) {
    this.client = client;
    this.key = key;
    this.holder = holder;
    this.ttlMs = ttlMs;
    this.now = now;
    this.token = randomUUID();
    this.generation = 0;
    this.expiresAt = null;
  }

  payload(expiresAt) {
    return {
      holder: this.holder,
      token: this.token,
      acquiredAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async acquire() {
    const current = await this.client.getJsonOptional(this.key);
    const now = this.now();
    if (current) {
      const expiresAt = Date.parse(current.value.expiresAt ?? "");
      if (Number.isFinite(expiresAt) && expiresAt > now) return false;
    }

    const expectedGeneration = current ? current.metadata.generation : -1;
    const nextExpiry = now + this.ttlMs;
    try {
      const saved = await this.client.putJson(this.key, this.payload(nextExpiry), {
        generation: expectedGeneration,
      });
      this.generation = saved.generation;
      this.expiresAt = new Date(nextExpiry).toISOString();
      return true;
    } catch (error) {
      if (error instanceof EntityStoreError && error.conflict) return false;
      throw error;
    }
  }

  async renew() {
    const current = await this.client.getJsonOptional(this.key);
    if (!current || current.value.token !== this.token) return false;

    const nextExpiry = this.now() + this.ttlMs;
    try {
      const saved = await this.client.putJson(this.key, this.payload(nextExpiry), {
        generation: current.metadata.generation,
      });
      this.generation = saved.generation;
      this.expiresAt = new Date(nextExpiry).toISOString();
      return true;
    } catch (error) {
      if (error instanceof EntityStoreError && error.conflict) return false;
      throw error;
    }
  }

  async release() {
    const current = await this.client.getJsonOptional(this.key);
    if (!current || current.value.token !== this.token) return false;
    try {
      await this.client.putJson(
        this.key,
        {
          ...current.value,
          releasedAt: new Date(this.now()).toISOString(),
          expiresAt: new Date(0).toISOString(),
        },
        { generation: current.metadata.generation },
      );
      this.expiresAt = new Date(0).toISOString();
      return true;
    } catch (error) {
      if (error instanceof EntityStoreError && error.conflict) return false;
      throw error;
    }
  }
}

export class EntitySnapshotStore {
  constructor({ client, keyPrefix, chunkBytes = DEFAULT_CHUNK_BYTES }) {
    this.client = client;
    this.keyPrefix = keyPrefix.replace(/^\/+|\/+$/g, "");
    this.chunkBytes = chunkBytes;
  }

  key(suffix) {
    return `${this.keyPrefix}/${suffix}`;
  }

  async getLatest() {
    return this.client.getJsonOptional(this.key("snapshots/latest.json"));
  }

  async uploadFile(filePath) {
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const chunks = [];
    const fullHash = createHash("sha256");
    let carry = Buffer.alloc(0);
    let index = 0;

    for await (const incoming of createReadStream(filePath)) {
      carry = Buffer.concat([carry, incoming]);
      while (carry.length >= this.chunkBytes) {
        const chunk = carry.subarray(0, this.chunkBytes);
        carry = carry.subarray(this.chunkBytes);
        chunks.push(await this.uploadChunk(snapshotId, index++, chunk));
        fullHash.update(chunk);
      }
    }
    if (carry.length > 0 || index === 0) {
      chunks.push(await this.uploadChunk(snapshotId, index, carry));
      fullHash.update(carry);
    }

    const fileStats = statSync(filePath);
    const manifest = {
      version: 1,
      snapshotId,
      createdAt: new Date().toISOString(),
      fileName: "paperclip.sql.gz",
      contentType: "application/gzip",
      sizeBytes: fileStats.size,
      sha256: fullHash.digest("hex"),
      chunks,
    };
    const manifestKey = this.key(`snapshots/${snapshotId}/manifest.json`);
    await this.client.putJson(manifestKey, manifest, { generation: -1 });

    const current = await this.getLatest();
    const latest = {
      version: 1,
      snapshotId,
      manifestKey,
      createdAt: manifest.createdAt,
      sizeBytes: manifest.sizeBytes,
      sha256: manifest.sha256,
    };
    await this.client.putJson(this.key("snapshots/latest.json"), latest, {
      generation: current ? current.metadata.generation : -1,
    });
    return latest;
  }

  async uploadChunk(snapshotId, index, data) {
    const key = this.key(
      `snapshots/${snapshotId}/chunks/${String(index).padStart(6, "0")}.bin`,
    );
    await this.client.put(key, data, { generation: -1 });
    return { key, sizeBytes: data.length, sha256: sha256(data) };
  }

  async downloadLatest(destinationPath) {
    const latest = await this.getLatest();
    if (!latest) return null;
    const manifestBlock = await this.client.getJson(latest.value.manifestKey);
    const manifest = manifestBlock.value;
    mkdirSync(dirname(destinationPath), { recursive: true });
    const writer = createWriteStream(destinationPath, { flags: "w" });
    const fullHash = createHash("sha256");
    let sizeBytes = 0;

    try {
      for (const expected of manifest.chunks) {
        const block = await this.client.get(expected.key);
        if (block.data.length !== Number(expected.sizeBytes)) {
          throw new Error(`Snapshot chunk ${expected.key} has the wrong size`);
        }
        if (sha256(block.data) !== expected.sha256) {
          throw new Error(`Snapshot chunk ${expected.key} failed SHA-256 verification`);
        }
        fullHash.update(block.data);
        sizeBytes += block.data.length;
        if (!writer.write(block.data)) {
          await new Promise((resolve) => writer.once("drain", resolve));
        }
      }
      await new Promise((resolve, reject) => {
        writer.once("error", reject);
        writer.end(resolve);
      });
    } catch (error) {
      writer.destroy();
      try {
        unlinkSync(destinationPath);
      } catch {
        // The partial file may not have reached disk.
      }
      throw error;
    }

    if (sizeBytes !== Number(manifest.sizeBytes)) {
      throw new Error("Restored snapshot has the wrong size");
    }
    if (fullHash.digest("hex") !== manifest.sha256) {
      throw new Error("Restored snapshot failed SHA-256 verification");
    }
    return latest.value;
  }
}
