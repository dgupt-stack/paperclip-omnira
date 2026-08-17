# Paperclip for Omnira

Slim deployment wrapper for the MIT-licensed
[Paperclip](https://github.com/paperclipai/paperclip) runtime.

It installs the official `paperclipai` package, initializes an authenticated
private instance on first boot, binds to Omnira's `PORT`, and disables anonymous
telemetry. Paperclip data is stored under `PAPERCLIP_HOME`.

Public multi-device deployments must additionally set `DATABASE_URL` to a
shared PostgreSQL database and `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`.

## Run locally

```sh
npm ci
PAPERCLIP_PUBLIC_HOST=localhost PORT=3100 npm start
```
