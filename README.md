# Paperclip for Omnira Entity Service

An Omnira deployment wrapper for the MIT-licensed
[Paperclip](https://github.com/paperclipai/paperclip) runtime.

This variant uses the Omnira Entity Service BlockStore as Paperclip's **only
durable backing store**. It runs PostgreSQL-compatible SQL in an in-memory
[PGlite](https://pglite.dev/) WASM engine and provides:

- SHA-256-verified, chunked PGlite snapshots in Entity Service
- direct Entity-block storage for Paperclip attachments (including ranges and tombstones)
- a CAS-protected leader lease so only one Omnira device can accept writes
- automatic restore and promotion when a fresh device becomes leader
- a `GET /_omnira/storage` proof/health endpoint
- no `DATABASE_URL`, external database, or durable local filesystem

The production build is one compiled Bun executable containing Paperclip,
PGlite, PostgreSQL extensions, all 182 upstream migrations, and all UI assets.
The repository root is a small Go launcher so Omnira recognizes it as a compiled
service. The launcher expands the compressed executable, waits until Paperclip
has restored Entity state and preloaded every embedded asset, then unlinks the
temporary executable and directory. There is no runtime package install and no
runtime file that Omnira cleanup can remove.

Database snapshots are scheduled after successful mutating requests and on
graceful shutdown. A periodic integrity pass backs up only when the database is
dirty. This is crash-consistent snapshot durability, not zero-RPO synchronous
replication.

## Required Omnira settings

```text
PAPERCLIP_STORAGE_BACKEND=omnira-entity
OMNIRA_ENTITY_URL=https://entityservice-k4u67azzg5.app.omnira.dev
OMNIRA_ENTITY_API_KEY=<service-principal API key>
OMNIRA_ENTITY_OWNER_ID=<positive owner entity ID>
OMNIRA_ENTITY_NAMESPACE=paperclip
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
```

The service principal must be permitted to read and write the `paperclip`
BlockStore namespace. Keep the API key in Omnira service settings; never commit
it to this repository.

Optional configuration:

```text
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_PUBLIC_URL=https://paperclip-k4u67azzg5.app.omnira.dev
```

## Run and verify

```sh
go build ./...
go test ./...

cd app
npm ci
npm run build
npm test
bun scripts/build-standalone.mjs bun-darwin-arm64 ../build/paperclip-entity-darwin-arm64
npm start
```

After building the standalone executable, refresh the checked-in compressed
Darwin/ARM64 deployment asset:

```sh
zip -j -9 -FS assets/paperclip-entity-darwin-arm64.zip build/paperclip-entity-darwin-arm64
go test ./...
```

After startup, open `/_omnira/storage`. A ready writer reports:

```json
{
  "ok": true,
  "mode": "strict-entity-only",
  "databaseEngine": "PGlite (in-memory PostgreSQL/WASM)",
  "databaseTables": 156,
  "migrations": { "appliedNow": 0, "appliedTotal": 182 },
  "durableStore": "Omnira Entity Service BlockStore",
  "externalDatabase": false,
  "durableLocalDisk": false,
  "uiAssetsEmbedded": 203
}
```
