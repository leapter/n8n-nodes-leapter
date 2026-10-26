# End-to-end test

`pnpm e2e` (`e2e/run.sh`) builds the node, starts n8n in Docker with the build as a custom
extension, and checks the whole flow against a real Runtime Cluster. Run it before every release, on
the oldest and the newest n8n the node supports: `N8N_VERSION` picks the `n8nio/n8n` image tag
(default 2.44.5), e.g. `N8N_VERSION=2.0.3 pnpm e2e`.

| Check | What passes |
|-------|-------------|
| C1 credential test | `POST /rest/credentials/test` answers OK |
| C2 first run | `n8n execute` returns `outputData`; the credential stores exactly one evaluation key, for `<ENVIRONMENT>/<APPLICATION>` |
| C3 second run | Succeeds with the same key |
| C4 restart | After `docker compose restart`, succeeds with the same key |
| C5 revoked key | After revoking the key and waiting 65 s, succeeds within 120 s with a new key |
| C6 overlapping field loads | Through a second credential without a key: a field load waiting for the new key, overtaken by one for a blueprint the project lacks, answers with the newer (empty) result within 20 s; the newer one within 10 s; then the blueprint's fields load |
| C7 removed blueprint | A run of a blueprint id the project does not have fails within 20 s with "is not a public blueprint", instead of waiting a minute |

The script stops at the first `FAIL`. It always revokes the keys it left and removes n8n with
`docker compose down -v` (set `E2E_KEEP=1` to keep both for debugging).

## Inputs

`bash e2e/run.sh --help` lists them: `CLUSTER_URL`, `SERVICE_KEY` (an `operator` service key of the
environment), `ENVIRONMENT`, `APPLICATION`, `BLUEPRINT_ID`, `INPUT_JSON`.

## Against the local cluster

Needs Docker, `jq`, the local cluster running (`pnpm dev:cluster` in genielabs) and a project with
a public blueprint deployed to `dev` from the Lab.

```bash
eval "$(bash e2e/prepare-local.sh)" && pnpm e2e
```

`prepare-local.sh` reads the bootstrap admin key from
`$GENIELABS_DIR/apps/runtime-management/.env` (default `~/leapter/genielabs`), grants the `n8n`
service account and the bootstrap principal `operator` on `dev` (a key creator must hold what the
key holds), creates an `n8n` service key, picks the first application of `dev` with a public
blueprint and prints the six inputs as `export` lines. Its input defaults to the fixture blueprint
"Hello World" (`{"userInput": string}`); set `INPUT_JSON` first for another blueprint. Each call
creates a new service key; revoke old ones in the Admin UI (Service accounts → n8n).

A local cluster answers on `http://localhost`, and the node refuses `http://` anywhere else. So
`relay.js` runs inside the n8n container and forwards the cluster's ports (the control plane's and
the run address's from `config.json`) from the container's `localhost` to `host.docker.internal`.
A remote `https://` cluster needs no relay.

## Against the dev stage

With a key of `service:env:playground:n8n`:

```bash
CLUSTER_URL=https://dev.runtime.leapter.com SERVICE_KEY=$DEV_SERVICE_KEY ENVIRONMENT=playground \
APPLICATION=<app> BLUEPRINT_ID=<id> INPUT_JSON='<input>' pnpm e2e
```
