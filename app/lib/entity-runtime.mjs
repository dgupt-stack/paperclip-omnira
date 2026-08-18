import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as tar from "tar";

export class EntityRuntimeStore {
  constructor({ paperclipHome, instanceId, snapshotStore }) {
    this.paperclipHome = resolve(paperclipHome);
    this.instanceId = instanceId;
    this.snapshotStore = snapshotStore;
    this.instanceRoot = join(this.paperclipHome, "instances", instanceId);
    this.archivePath = join(this.paperclipHome, ".entity-runtime", "runtime.tar.gz");
  }

  archiveEntries() {
    return [
      join(this.instanceRoot, "config.json"),
      join(this.instanceRoot, ".env"),
      join(this.instanceRoot, "secrets"),
      join(this.instanceRoot, "data", "storage"),
    ]
      .filter((path) => existsSync(path))
      .map((path) => relative(this.paperclipHome, path));
  }

  async backup() {
    const entries = this.archiveEntries();
    if (entries.length === 0) return null;
    mkdirSync(dirname(this.archivePath), { recursive: true });
    await tar.c(
      {
        cwd: this.paperclipHome,
        file: this.archivePath,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      entries,
    );
    try {
      return await this.snapshotStore.uploadFile(this.archivePath);
    } finally {
      try {
        unlinkSync(this.archivePath);
      } catch {
        // Preserve the primary archive/upload result.
      }
    }
  }

  async restoreLatest() {
    mkdirSync(dirname(this.archivePath), { recursive: true });
    const snapshot = await this.snapshotStore.downloadLatest(this.archivePath);
    if (!snapshot) return null;
    try {
      await tar.x({
        cwd: this.paperclipHome,
        file: this.archivePath,
        preservePaths: false,
        strict: true,
      });
      return snapshot;
    } finally {
      try {
        unlinkSync(this.archivePath);
      } catch {
        // A successfully extracted temporary archive can be reclaimed later.
      }
    }
  }
}
