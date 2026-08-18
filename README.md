# Paperclip for Omnira Entity Service

An Omnira deployment wrapper for the MIT-licensed
[Paperclip](https://github.com/paperclipai/paperclip) runtime.

This variant uses the Omnira Entity Service BlockStore as Paperclip's durable
backing store. Paperclip keeps a private embedded PostgreSQL process as its SQL
execution engine, while the wrapper provides:

- SHA-256-verified, chunked logical database snapshots in Entity Service
- snapshots of Paperclip config, its secrets key, and local attachments
- a CAS-protected leader lease so only one Omnira device can accept writes
- automatic restore and promotion when a fresh device becomes leader
- a `GET /_omnira/storage` proof/health endpoint

The repository root is a small Go launcher so Omnira recognizes the project as
a long-running compiled service instead of a static Node site. On a device's
first start it extracts the JavaScript wrapper from `app/`, installs production
dependencies with an available Node.js 20+ runtime, then replaces itself with
Paperclip. If Node.js is unavailable, it downloads a checksum-pinned Bun
runtime for the current Omnira device. Service secrets are deliberately removed
from the dependency installer's environment.

The default backup interval is 60 seconds, so an abrupt device loss can lose up
to roughly one interval of recent writes. Use a shared managed PostgreSQL server
instead when zero-RPO failover is required.

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

Optional tuning:

```text
OMNIRA_ENTITY_BACKUP_INTERVAL_SECONDS=60
OMNIRA_ENTITY_LEASE_TTL_SECONDS=45
PAPERCLIP_INSTANCE_ID=default
```

## Run and verify

```sh
go build ./...
go test ./...

cd app
npm ci
npm run build
npm test
npm start
```

After startup, open `/_omnira/storage`. A ready writer reports:

```json
{
  "ok": true,
  "storageBackend": "omnira-entity-blockstore",
  "mode": "leader",
  "paperclipHealth": "ok",
  "durableStore": "Omnira Entity Service BlockStore"
}
```

For a legacy local-only development instance without Entity Service, set
`PAPERCLIP_STORAGE_BACKEND=local`.
