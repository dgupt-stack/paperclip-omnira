import { createHash, createHmac, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { extname } from "node:path";
import { createServer } from "node:http";
import { EMBEDDED_UI_ASSETS } from "./generated/embedded-assets.mjs";
import { createEntityPglite } from "./lib/entity-pglite.mjs";
import { createEntityStorageProvider } from "./lib/entity-storage.mjs";
import {
  EntityLease,
  EntitySnapshotStore,
  EntityStoreClient,
} from "./lib/entity-store.mjs";

const VERSION = "2026.722.0-entity.1";
const INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
const PORT = Math.max(1, Number(process.env.PORT || process.env.PAPERCLIP_PORT || 3100));
const PUBLIC_URL = (
  process.env.PAPERCLIP_PUBLIC_URL?.trim()
  || (process.env.OMNIRA_ENVIRONMENT
    ? "https://paperclip-k4u67azzg5.app.omnira.dev"
    : `http://127.0.0.1:${PORT}`)
).replace(/\/$/, "");
const entityConfig = {
  baseUrl: process.env.OMNIRA_ENTITY_URL?.trim(),
  apiKey: process.env.OMNIRA_ENTITY_API_KEY?.trim(),
  namespace: process.env.OMNIRA_ENTITY_NAMESPACE?.trim() || "paperclip",
  ownerEntityId: process.env.OMNIRA_ENTITY_OWNER_ID?.trim(),
};

function requireEntityConfig() {
  const missing = Object.entries(entityConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Strict Entity-only mode is missing configuration: ${missing.join(", ")}`);
  }
}

function deriveSecret(label, encoding = "hex") {
  return createHmac("sha256", entityConfig.apiKey).update(`paperclip-omnira:${label}`).digest(encoding);
}

function configurePaperclipEnvironment() {
  process.env.PAPERCLIP_PUBLIC_URL = PUBLIC_URL;
  process.env.PAPERCLIP_API_URL = PUBLIC_URL;
  process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
  process.env.PAPERCLIP_LISTEN_PORT = String(PORT);
  process.env.PAPERCLIP_RUNTIME_API_URL = PUBLIC_URL;
  process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify([PUBLIC_URL]);
  process.env.PAPERCLIP_SECRETS_PROVIDER = "local_encrypted";
  process.env.PAPERCLIP_SECRETS_STRICT_MODE = "true";
  process.env.BETTER_AUTH_SECRET ||= deriveSecret("better-auth");
  process.env.PAPERCLIP_AGENT_JWT_SECRET ||= deriveSecret("agent-jwt");
  process.env.PAPERCLIP_SECRETS_MASTER_KEY ||= deriveSecret("managed-secrets", "base64");
  process.env.BETTER_AUTH_TRUSTED_ORIGINS ||= PUBLIC_URL;
  process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED ||= "true";
  process.env.HEARTBEAT_SCHEDULER_ENABLED ||= "false";
  process.env.PAPERCLIP_TELEMETRY_ENABLED ||= "false";
  process.env.TRUST_PROXY ||= "loopback, linklocal, uniquelocal";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contentType(path) {
  return ({
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml; charset=utf-8",
  })[extname(path).toLowerCase()] || "application/octet-stream";
}

async function preloadUi() {
  if (typeof Bun === "undefined") throw new Error("The embedded UI requires Bun");
  const assets = new Map();
  for (const asset of EMBEDDED_UI_ASSETS) {
    const data = Buffer.from(await Bun.file(asset.embeddedPath).arrayBuffer());
    assets.set(asset.publicPath, {
      data,
      contentType: contentType(asset.publicPath),
      etag: `"${sha256(data)}"`,
    });
  }
  if (!assets.has("/index.html")) throw new Error("Embedded Paperclip UI is missing index.html");
  return assets;
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function publicStatus(state) {
  return {
    ok: state.phase === "ready" && !state.leaseLost && !state.lastBackupError,
    mode: state.leaseLost ? "lease-lost" : "strict-entity-only",
    phase: state.phase,
    version: VERSION,
    instanceId: INSTANCE_ID,
    databaseEngine: "PGlite (in-memory PostgreSQL/WASM)",
    databaseTables: state.databaseTables,
    migrations: state.migrations,
    durableStore: "Omnira Entity Service BlockStore",
    databaseSnapshotKey: state.databaseSnapshotKey,
    attachmentStore: "Omnira Entity Service BlockStore",
    externalDatabase: false,
    durableLocalDisk: false,
    restoredSnapshotId: state.restoredSnapshotId,
    latestSnapshotId: state.latestSnapshotId,
    latestSnapshotAt: state.latestSnapshotAt,
    latestSnapshotBytes: state.latestSnapshotBytes,
    lastBackupReason: state.lastBackupReason,
    lastBackupError: state.lastBackupError,
    uiAssetsEmbedded: state.uiAssetsEmbedded,
    startedAt: state.startedAt,
  };
}

requireEntityConfig();
configurePaperclipEnvironment();

const state = {
  phase: "acquiring-entity-lease",
  startedAt: new Date().toISOString(),
  databaseSnapshotKey: `paperclip/instances/${INSTANCE_ID}/database-pglite-v1`,
  databaseTables: 0,
  migrations: null,
  restoredSnapshotId: null,
  latestSnapshotId: null,
  latestSnapshotAt: null,
  latestSnapshotBytes: null,
  latestSnapshotHash: null,
  lastBackupReason: null,
  lastBackupError: null,
  leaseLost: false,
  uiAssetsEmbedded: 0,
};

const entityClient = new EntityStoreClient(entityConfig);
const databaseSnapshots = new EntitySnapshotStore({
  client: entityClient,
  keyPrefix: state.databaseSnapshotKey,
});
const processId = `${hostname()}-${process.pid}-${randomUUID()}`;
const lease = new EntityLease({
  client: entityClient,
  key: `paperclip/instances/${INSTANCE_ID}/leader.json`,
  holder: processId,
  ttlMs: 45_000,
});
if (!await lease.acquire()) {
  throw new Error("Another Paperclip process currently owns the Entity Service writer lease");
}

state.phase = "restoring-entity-snapshot";
const restored = await databaseSnapshots.downloadBuffer();
if (restored) {
  state.restoredSnapshotId = restored.snapshot.snapshotId;
  state.latestSnapshotId = restored.snapshot.snapshotId;
  state.latestSnapshotAt = restored.snapshot.createdAt;
  state.latestSnapshotBytes = restored.snapshot.sizeBytes;
  state.latestSnapshotHash = restored.snapshot.sha256;
}

state.phase = "starting-in-memory-database";
const pglite = await createEntityPglite({ snapshot: restored?.data });
state.migrations = pglite.migrationStatus;
const tableCount = await pglite.client.query(
  "select count(*)::int as count from information_schema.tables where table_schema = 'public'",
);
state.databaseTables = Number(tableCount.rows[0]?.count ?? 0);

let backupPromise = null;
let backupTimer = null;
let backupRequested = false;
let databaseDirty = pglite.migrationStatus.appliedNow > 0 || !restored;
async function persistSnapshot(reason, { force = false } = {}) {
  backupRequested = true;
  if (backupPromise) return backupPromise;
  backupPromise = (async () => {
    while (backupRequested) {
      backupRequested = false;
      if (!force && !databaseDirty) continue;
      force = false;
      databaseDirty = false;
      const archive = await pglite.dump();
      const digest = sha256(archive);
      const saved = await databaseSnapshots.uploadBuffer(archive);
      state.latestSnapshotId = saved.snapshotId;
      state.latestSnapshotAt = saved.createdAt;
      state.latestSnapshotBytes = saved.sizeBytes;
      state.latestSnapshotHash = saved.sha256;
      state.lastBackupReason = reason;
      state.lastBackupError = null;
    }
  })().catch((error) => {
    databaseDirty = true;
    state.lastBackupError = error instanceof Error ? error.message : String(error);
    console.error(`[paperclip-entity] snapshot failed: ${state.lastBackupError}`);
    throw error;
  }).finally(() => {
    backupPromise = null;
  });
  return backupPromise;
}

function scheduleSnapshot(reason) {
  databaseDirty = true;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void persistSnapshot(reason).catch(() => {});
  }, 1_000);
  backupTimer.unref?.();
}

state.phase = "preloading-embedded-ui";
const uiAssets = await preloadUi();
state.uiAssetsEmbedded = uiAssets.size;

state.phase = "creating-paperclip-app";
const [
  { createApp },
  {
    createBetterAuthHandler,
    createBetterAuthInstance,
    deriveAuthTrustedOrigins,
    resolveBetterAuthSession,
    resolveBetterAuthSessionFromHeaders,
  },
  { initializeBoardClaimChallenge, getBoardClaimWarningUrl },
  { setupLiveEventsWebSocketServer },
  { createStorageService },
] = await Promise.all([
  import("./node_modules/@paperclipai/server/dist/app.js"),
  import("./node_modules/@paperclipai/server/dist/auth/better-auth.js"),
  import("./node_modules/@paperclipai/server/dist/board-claim.js"),
  import("./node_modules/@paperclipai/server/dist/realtime/live-events-ws.js"),
  import("./node_modules/@paperclipai/server/dist/storage/service.js"),
]);

const parsedPublicUrl = new URL(PUBLIC_URL);
const config = {
  deploymentMode: "authenticated",
  deploymentExposure: "public",
  bind: "custom",
  customBindHost: "0.0.0.0",
  host: "0.0.0.0",
  port: PORT,
  allowedHostnames: [parsedPublicUrl.hostname, "localhost", "127.0.0.1"],
  authBaseUrlMode: "explicit",
  authPublicBaseUrl: PUBLIC_URL,
  authDisableSignUp: false,
  databaseMode: "postgres",
  databaseUrl: undefined,
  databaseMigrationUrl: undefined,
  embeddedPostgresDataDir: "",
  embeddedPostgresPort: 0,
  databaseBackupEnabled: false,
  databaseBackupIntervalMinutes: 0,
  databaseBackupRetentionDays: 0,
  databaseBackupDir: "",
  serveUi: false,
  uiDevMiddleware: false,
  secretsProvider: "local_encrypted",
  secretsStrictMode: true,
  secretsMasterKeyFilePath: "",
  storageProvider: "local_disk",
  storageLocalDiskBaseDir: "",
  storageS3Bucket: "",
  storageS3Region: "",
  storageS3Endpoint: undefined,
  storageS3Prefix: "",
  storageS3ForcePathStyle: false,
  feedbackExportBackendUrl: undefined,
  feedbackExportBackendToken: undefined,
  heartbeatSchedulerEnabled: false,
  heartbeatSchedulerIntervalMs: 30_000,
  companyDeletionEnabled: false,
  telemetryEnabled: false,
};
const trustedOrigins = deriveAuthTrustedOrigins(config, { listenPort: PORT });
const auth = createBetterAuthInstance(pglite.db, config, trustedOrigins);
const resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
await initializeBoardClaimChallenge(pglite.db, { deploymentMode: config.deploymentMode });
const storageService = createStorageService(createEntityStorageProvider({
  client: entityClient,
  keyPrefix: `paperclip/instances/${INSTANCE_ID}/objects`,
}));
const app = await createApp(pglite.db, {
  uiMode: "none",
  serverPort: PORT,
  storageService,
  deploymentMode: config.deploymentMode,
  deploymentExposure: config.deploymentExposure,
  allowedHostnames: config.allowedHostnames,
  bindHost: config.host,
  authReady: true,
  companyDeletionEnabled: false,
  instanceId: INSTANCE_ID,
  hostVersion: VERSION,
  pluginMigrationDb: pglite.db,
  betterAuthHandler: createBetterAuthHandler(auth),
  resolveSession: (request) => resolveBetterAuthSession(auth, request),
});

await persistSnapshot("startup", { force: pglite.migrationStatus.appliedNow > 0 || !restored });

const apiPrefixes = ["/api", "/mcp", "/_plugins"];
const server = createServer((request, response) => {
  const url = new URL(request.url || "/", PUBLIC_URL);
  if (url.pathname === "/_omnira/storage") {
    sendJson(response, state.phase === "ready" ? 200 : 503, publicStatus(state));
    return;
  }
  if (state.leaseLost) {
    sendJson(response, 503, { error: "Entity Service writer lease was lost" });
    return;
  }
  if (apiPrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "")) {
      response.once("finish", () => {
        if (response.statusCode < 500) scheduleSnapshot(`${request.method} ${url.pathname}`);
      });
    }
    app(request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  let asset = uiAssets.get(url.pathname);
  const isAssetRequest = url.pathname.startsWith("/assets/");
  if (!asset && !isAssetRequest) asset = uiAssets.get("/index.html");
  if (!asset) {
    sendJson(response, 404, { error: "Asset not found" });
    return;
  }
  if (request.headers["if-none-match"] === asset.etag) {
    response.writeHead(304);
    response.end();
    return;
  }
  response.writeHead(200, {
    "Cache-Control": isAssetRequest ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Length": asset.data.length,
    "Content-Type": asset.contentType,
    ETag: asset.etag,
  });
  response.end(request.method === "HEAD" ? undefined : asset.data);
});
server.keepAliveTimeout = 185_000;
server.headersTimeout = 186_000;
setupLiveEventsWebSocketServer(server, pglite.db, {
  deploymentMode: config.deploymentMode,
  resolveSessionFromHeaders,
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "0.0.0.0", resolve);
});
state.phase = "ready";

const localClaimUrl = getBoardClaimWarningUrl("127.0.0.1", PORT);
if (localClaimUrl) {
  const claim = new URL(localClaimUrl);
  console.warn(`[paperclip-entity] board claim URL: ${PUBLIC_URL}${claim.pathname}${claim.search}`);
}
console.log(JSON.stringify({
  event: "paperclip-entity-ready",
  url: PUBLIC_URL,
  port: PORT,
  tables: state.databaseTables,
  migrations: state.migrations,
  restoredSnapshotId: state.restoredSnapshotId,
  latestSnapshotId: state.latestSnapshotId,
  uiAssets: state.uiAssetsEmbedded,
}));

const leaseTimer = setInterval(() => {
  void lease.renew().then((renewed) => {
    if (!renewed) {
      state.leaseLost = true;
      state.phase = "lease-lost";
      console.error("[paperclip-entity] Entity Service writer lease was lost");
    }
  }).catch((error) => {
    state.lastBackupError = `Lease renewal failed: ${error.message}`;
    console.error(`[paperclip-entity] ${state.lastBackupError}`);
  });
}, 15_000);
leaseTimer.unref?.();
const periodicBackupTimer = setInterval(() => {
  void persistSnapshot("periodic-integrity-check").catch(() => {});
}, 30_000);
periodicBackupTimer.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  state.phase = "shutting-down";
  clearInterval(leaseTimer);
  clearInterval(periodicBackupTimer);
  if (backupTimer) clearTimeout(backupTimer);
  console.log(`[paperclip-entity] received ${signal}; saving Entity snapshot`);
  try {
    await persistSnapshot(`shutdown-${signal}`);
    await lease.release();
  } catch (error) {
    console.error(`[paperclip-entity] shutdown persistence failed: ${error.message}`);
  }
  await new Promise((resolve) => server.close(resolve));
  await pglite.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
