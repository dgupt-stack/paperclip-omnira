import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import {
  ensurePostgresDatabase,
  prepareEmbeddedPostgresNativeRuntime,
  resetPostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";

function persistentPassword(filePath) {
  if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();
  const password = randomBytes(32).toString("hex");
  writeFileSync(filePath, `${password}\n`, { mode: 0o600 });
  return password;
}

export class EntityBackedPostgres {
  constructor({ dataDir, port, snapshotStore, onLog = console.log, onError = console.error }) {
    this.dataDir = resolve(dataDir);
    this.port = Number(port);
    this.snapshotStore = snapshotStore;
    this.onLog = onLog;
    this.onError = onError;
    this.postgres = null;
    this.connectionString = null;
    this.adminConnectionString = null;
    this.markerPath = join(this.dataDir, "entity-snapshot.json");
    this.lastSnapshot = null;
  }

  async start() {
    mkdirSync(this.dataDir, { recursive: true });
    await prepareEmbeddedPostgresNativeRuntime();
    const password = persistentPassword(join(this.dataDir, ".password"));
    const encodedPassword = encodeURIComponent(password);
    const clusterDir = join(this.dataDir, "cluster");

    this.postgres = new EmbeddedPostgres({
      databaseDir: clusterDir,
      user: "paperclip",
      password,
      port: this.port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: this.onLog,
      onError: this.onError,
    });

    if (!existsSync(join(clusterDir, "PG_VERSION"))) {
      await this.postgres.initialise();
    } else {
      try {
        unlinkSync(join(clusterDir, "postmaster.pid"));
      } catch {
        // Expected when the prior shutdown was clean.
      }
    }
    await this.postgres.start();

    this.adminConnectionString =
      `postgres://paperclip:${encodedPassword}@127.0.0.1:${this.port}/postgres`;
    this.connectionString =
      `postgres://paperclip:${encodedPassword}@127.0.0.1:${this.port}/paperclip`;
    await ensurePostgresDatabase(this.adminConnectionString, "paperclip");
    await this.restoreLatestIfNeeded();
    return this.connectionString;
  }

  readMarker() {
    if (!existsSync(this.markerPath)) return null;
    try {
      return JSON.parse(readFileSync(this.markerPath, "utf8"));
    } catch {
      return null;
    }
  }

  writeMarker(snapshot) {
    writeFileSync(this.markerPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    this.lastSnapshot = snapshot;
  }

  async restoreLatestIfNeeded() {
    const latest = await this.snapshotStore.getLatest();
    if (!latest) return null;
    const marker = this.readMarker();
    if (marker?.snapshotId === latest.value.snapshotId) {
      this.lastSnapshot = marker;
      return { restored: false, snapshot: marker };
    }

    const restoreDir = join(this.dataDir, "restore");
    const restorePath = join(restoreDir, "paperclip.sql.gz");
    const snapshot = await this.snapshotStore.downloadLatest(restorePath);
    await resetPostgresDatabase(this.adminConnectionString, "paperclip");
    await runDatabaseRestore({
      connectionString: this.connectionString,
      backupFile: restorePath,
      connectTimeoutSeconds: 15,
    });
    this.writeMarker(snapshot);
    try {
      unlinkSync(restorePath);
    } catch {
      // A successfully restored temporary file can be reclaimed later.
    }
    return { restored: true, snapshot };
  }

  async backup() {
    if (!this.connectionString) throw new Error("Postgres has not started");
    const backupDir = join(this.dataDir, "backup");
    const result = await runDatabaseBackup({
      connectionString: this.connectionString,
      backupDir,
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      filenamePrefix: "paperclip-entity",
      connectTimeoutSeconds: 15,
      backupEngine: "javascript",
    });

    try {
      const snapshot = await this.snapshotStore.uploadFile(result.backupFile);
      this.writeMarker(snapshot);
      return snapshot;
    } finally {
      try {
        unlinkSync(result.backupFile);
      } catch {
        // Preserve the primary upload result/error.
      }
    }
  }

  async stop() {
    if (!this.postgres) return;
    const postgres = this.postgres;
    this.postgres = null;
    await postgres.stop();
  }
}
