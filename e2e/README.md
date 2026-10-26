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

## Queue mode

`pnpm e2e:queue` (`e2e/queue.sh`) runs n8n in queue mode with `docker-compose.queue.yml`: the main
process (editor, REST API, webhooks), a separate worker, Postgres and Redis. Runs go through a
webhook and execute on the worker; the editor's field list runs on the main process. Each process
keeps its own key state (`keyState()`), so the checks are about sharing keys through the stored
credential:

| Check | What passes |
|-------|-------------|
| Q1 first run on the worker | The run succeeds on the worker; exactly one key exists |
| Q2 editor after the worker | The field list (main) loads with the worker's key; no new key |
| Q3 run after the editor | A key the editor created is reused by the worker's run |
| Q4 revoked key | After revoking and waiting 95 s, the worker's run replaces the key; the editor then keeps the replacement |
| Q5 same moment | First use on main and worker at once both succeed; it reports how many keys were created (a race can create two, the credential stores one, the other stays active until revoked) |
| Q6 never-keyed project | Only with `FRESH_APPLICATION` and `FRESH_BLUEPRINT_ID`: a project that never had a key, first used on the worker |

Same inputs as `pnpm e2e`, plus `ADMIN_KEY`, a key that may list an application's keys and create a
second `n8n` service key for Q5 (credentials with the same service key share their key state). For
the local cluster it is read from genielabs:

```bash
eval "$(bash e2e/prepare-local.sh)" && pnpm e2e:queue
```

Cleanup revokes every key the run created and Q5's service key, and removes n8n.
