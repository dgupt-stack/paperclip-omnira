import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@paperclipai/db";
import { drizzle } from "drizzle-orm/pglite";
import pgliteDataPath from "../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
import pgliteWasmPath from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import fuzzystrmatchPath from "../node_modules/@electric-sql/pglite/dist/fuzzystrmatch.tar.gz" with { type: "file" };
import pgTrgmPath from "../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz" with { type: "file" };
import { EMBEDDED_MIGRATIONS } from "../generated/embedded-assets.mjs";

function embeddedExtension(name, path) {
  return {
    name,
    setup: async () => ({ bundlePath: pathToFileURL(path) }),
  };
}

async function applyMigrations(client) {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
  const applied = await client.query(
    "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1",
  );
  const lastAppliedAt = Number(applied.rows[0]?.created_at ?? 0);
  let appliedCount = 0;
  for (const migration of EMBEDDED_MIGRATIONS) {
    if (migration.when <= lastAppliedAt) continue;
    const hash = createHash("sha256").update(migration.sql).digest("hex");
    const statements = migration.sql
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean);
    await client.transaction(async (tx) => {
      for (const statement of statements) await tx.exec(statement);
      await tx.query(
        "insert into drizzle.__drizzle_migrations(hash, created_at) values ($1, $2)",
        [hash, migration.when],
      );
    });
    appliedCount += 1;
  }
  const result = await client.query(
    "select count(*)::int as count from drizzle.__drizzle_migrations",
  );
  return { appliedNow: appliedCount, appliedTotal: Number(result.rows[0]?.count ?? 0) };
}

export async function createEntityPglite({ snapshot } = {}) {
  if (typeof Bun === "undefined") {
    throw new Error("Strict Entity-only Paperclip requires the bundled Bun runtime");
  }
  const [wasmBytes, dataBytes] = await Promise.all([
    Bun.file(pgliteWasmPath).arrayBuffer(),
    Bun.file(pgliteDataPath).arrayBuffer(),
  ]);
  const client = await PGlite.create({
    dataDir: "memory://",
    wasmModule: await WebAssembly.compile(wasmBytes),
    fsBundle: new Blob([dataBytes]),
    ...(snapshot ? { loadDataDir: new Blob([snapshot]) } : {}),
    extensions: {
      fuzzystrmatch: embeddedExtension("fuzzystrmatch", fuzzystrmatchPath),
      pg_trgm: embeddedExtension("pg_trgm", pgTrgmPath),
    },
  });
  const migrationStatus = await applyMigrations(client);
  const db = drizzle({ client, schema });
  return {
    client,
    db,
    migrationStatus,
    async dump() {
      const archive = await client.dumpDataDir("gzip");
      return Buffer.from(await archive.arrayBuffer());
    },
    close: () => client.close(),
  };
}
