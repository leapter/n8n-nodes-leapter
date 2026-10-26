# CLAUDE.md

## What This Is
n8n community node that dynamically discovers and executes Leapter blueprints deployed to a Leapter Runtime Cluster. It reads the projects and blueprints the service key reaches to populate dropdowns and each project's OpenAPI document to generate input fields - no hardcoded operations.

## Core Technologies
- **TypeScript** (strict mode) - All source code
- **n8n-workflow** - Node/credential interfaces and types
- **@n8n/node-cli** - Build tooling, linting, dev server
- **pnpm** - Package manager
- **OpenAPI 3.0** - Blueprint discovery and schema parsing

## Essential Commands
```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript to dist/
pnpm lint             # Check for lint errors
pnpm lint:fix         # Auto-fix lint errors
pnpm dev              # Start dev mode with n8n
pnpm test             # tsc, then unit tests (node:test, test/*.test.mjs against dist/)
pnpm e2e              # n8n in Docker against a Runtime Cluster (e2e/README.md)
pnpm e2e:queue        # the same in n8n queue mode: main and worker share keys through the credential
```

Against a local cluster from a host-run n8n (`pnpm dev`), start it as `NODE_OPTIONS=--dns-result-order=ipv4first pnpm dev`: the cluster names its run address `http://localhost:3003`, that port listens on IPv4 only, and n8n's HTTP client does not fall back from `::1`.

Releases are cut from the GitHub Releases UI (draft a release with a `vX.Y.Z` tag, publish it). `publish.yml` derives the npm version from the tag; the `version` in `package.json` is a permanent placeholder — never bump it.

## Project Structure
```
├── nodes/Leapter/
│   ├── Leapter.node.ts    # Main node implementation
│   ├── cluster.ts         # Run base, https check, cluster error messages
│   ├── newest-load.ts     # Overlapping field loads answer with the newest one's result
│   ├── Leapter.node.json  # Node metadata for n8n
│   └── leapter.svg        # Node icon
├── credentials/
│   ├── LeapterApi.credentials.ts  # Service key credential, per-project evaluation keys
│   └── eval-keys.ts       # Evaluation key map, grace period, authenticate ↔ preAuthentication side channel, cluster address rules
├── dist/                  # Build output (git-ignored)
└── package.json           # n8n node registration
```

## Code Formatting (Prettier)
- **Indentation**: Tabs (width: 2)
- **Quotes**: Single quotes
- **Semicolons**: Required
- **Trailing commas**: All
- **Print width**: 100 characters
- **Line endings**: LF
- **Arrow parens**: Always `(x) => x`

## Naming Conventions
| Element | Convention | Example |
|---------|------------|---------|
| Files | PascalCase for nodes/credentials | `Leapter.node.ts` |
| Classes | PascalCase, implements n8n interface | `class Leapter implements INodeType` |
| Interfaces | PascalCase with `I` prefix (n8n) or plain (local) | `INodeType`, `OpenAPISpec` |
| Methods | camelCase | `searchProjects`, `getOperations` |
| Constants | SCREAMING_SNAKE_CASE | `CREDENTIAL_TYPE` |
| Properties | camelCase | `displayName`, `operationId` |

## Key Principles

### n8n Node Development
- Nodes implement `INodeType` with `description` and `execute()` method
- Credentials implement `ICredentialType` with `authenticate` block
- Use `loadOptions` methods for dynamic dropdowns, `listSearch` methods for resource locators
- Use `resourceMapper` for dynamic input field generation
- Access credentials via `this.helpers.httpRequestWithAuthentication()`
- Return `INodeExecutionData[][]` from execute (array of arrays for multiple outputs)

### TypeScript Strict Mode
- No implicit `any` - always type parameters and returns
- Strict null checks - handle undefined/null explicitly
- Cast errors in catch blocks: `const err = error as Error`
- Use `type` imports: `import type { X } from 'n8n-workflow'`

### Error Handling
- Wrap operations in try/catch
- Throw `NodeOperationError` with node context and itemIndex
- Support `continueOnFail()` for graceful degradation
- Return error in json output when continuing on fail

## Architecture

### Data Flow
```
User selects project (GET {cp}/environments, then GET {cp}/environments/{env}/status for each: applications with callable blueprints)
→ blueprint (callable[] of that application) → input fields from the engine's OpenAPI document
→ Execute POST {runBase}/runtime/api/v1/{env}/{app}/models/{blueprintId}/runs
```
`{cp}` is `{clusterUrl}/runtime-management`. `{runBase}` is read once per execution by `readRunBase()` (`nodes/Leapter/cluster.ts`).

### Saved Parameter Values
- **Project**: a resource locator (list mode only): `{ __rl: true, mode: 'list', value: 'environment::application' }` (application slug); read with `{ extractValue: true }` (`projectOf()` in load-options methods)
- **Operation**: the blueprint id from `status` (`callable[].id`)

Split by `splitProject()` (undefined unless both parts are there); `execute` checks it per item, as an expression may give each item its own project.

Project is a resource locator, not an `options` dropdown: n8n 2.39+ (not 2.0.3) asks a dropdown for its options when the panel opens, and on the first node of an editor page that is before it has assigned the existing credential; the reload the assignment triggers is dropped while that first request runs (`ParameterInput.vue`), so the list stayed "Error fetching options". A resource locator asks when its list is opened (`searchProjects`, `methods.listSearch`) and again after a failure.

### Runtime Cluster Endpoints
- `GET {cp}/environments` - Environments the service key may reach (also the credential test)
- `GET {cp}/environments/{env}/status` - Applications with their callable blueprints (`id`, `name`, `slug`)
- `POST {cp}/environments/{env}/applications/{app}/keys` - Creates a project's evaluation key
- `POST {cp}/environments/{env}/applications/{app}/keys/{id}/revoke` - Revokes a replaced evaluation key
- `GET {runBase}/runtime/api/v1/{env}/{app}/openapi` - The project's OpenAPI 3.0 document
- `POST {runBase}/runtime/api/v1/{env}/{app}/models/{blueprintId}/runs` - Executes a blueprint
- `GET {origin}/runtime-management/ui/config.json` - Public, no credential: `runBaseUrl`, or the origin when null, 404 or 410 (same rule as the genielabs CLI)

All requests use `disableFollowRedirect: true`; `assertHttps()` refuses non-https addresses except `localhost`/`127.0.0.1` (`isSecureAddress()`), and `authenticate` refuses them too before adding any key, the credential test included. `clusterBaseUrl()` (`credentials/eval-keys.ts`) reads the credential's address: the default when unset, without trailing slashes or a pasted `/runtime-management/…` path.

### Authentication and Key Handling
- The credential holds a key of the cluster's `n8n` service account (`serviceKey`, `lk_mgmt_…`). The control plane takes it; the engines take only per-project evaluation keys.
- `authenticate` routes by URL path: `/runtime-management/` gets `Authorization: Bearer <serviceKey>`, `/runtime/api/v1/{env}/{app}/` gets `X-API-Key` from the hidden expirable field `evalKeys` (JSON map `{ "env/app": { id, key, mintedAt } }`). `evalKeys` is also a `password` field: n8n redacts it before the editor gets the credential and puts the stored value back on save. Read it in tests with `n8n export:credentials --decrypted`, not the REST API.
- `preAuthentication` (every n8n version since 2.0 calls it before a request while `evalKeys` is empty, after every 401 and on every credential test) creates a key for each project that was requested without one, and replaces rejected keys: mint, then revoke the old id. A 401 does not say which request got it, so every project used in the last 2 min (`RECENT_USE_MS`) whose key is past the 90 s grace period (`GRACE_MS`) is probed with `GET …/openapi`; only a key the engine answers 401 is replaced. A fresh key answers 401 for up to 60 s, so a younger key is never replaced. n8n stores the returned `evalKeys`; it returns `''` while no project has a key, so n8n keeps calling it before each request. A project leaves `pending` before its key is created, and only the requested project's refusal fails the request, so one refused project (gone, or an environment without rights) does not block every later key.
- Each key entry records the cluster address it was created at (`cluster`); `currentKeys()` ignores entries of another address, so changing the Leapter Server creates new keys.
- A project that has never had a key is not served: its engine answers 404, not 401, and n8n runs `preAuthentication` on 401 only (n8n 2.40+ has `preAuthenticationRetryStatusCode`; it is not used, so every version since 2.0 works the same). So before each engine request `provisionKey()` (`nodes/Leapter/cluster.ts`) checks the credential: without a key for the project, it sends one request to the engine of a project the credential holds a key for, marked with `X-Leapter-Provision: env/app` (`PROVISION_HEADER`). `authenticate` removes the mark, adds the project to `pending` and sends no key; that engine answers 401 (a project that has had a key answers 401 without one, even after every key was revoked), and `preAuthentication` creates the key. n8n's repeat of the request comes without the mark. `provisionKey()` passes on every error but 401 and 404: anything else is `preAuthentication`'s refusal to create the key (a 403 for an environment without rights), and a run fails at once instead of waiting a minute. While the credential holds no key at all, the mark only adds the project to `pending`, and the next request's `preAuthentication` creates it.
- `authenticate` and `preAuthentication` share a side channel (`keyState()` in `credentials/eval-keys.ts`), because n8n gives `preAuthentication` only the credential data. It is per credential (cluster address and service key), not per process: `pending`, `used` (when and where each project was last requested with a key), `lastRequested`, the newest map this process returned (`latest`) and a queue that runs one `preAuthentication` per credential at a time. `currentKeys()` merges the stored copy with `latest` (newest `mintedAt` wins), because n8n may hand a later call an older copy of the credential; that is what kept parallel requests from dropping keys and creating them twice.
- `getOperationFields` and `execute` ask again on 401 or 404 (a new key or a new deploy) every `RETRY_INTERVAL_MS` (10 s), at most `MAX_RETRIES` (6) times: 7 requests over 60 s. Then the field list shows the activation notice and a run rethrows. A run that needed retries adds the execution hint "Access to <application> was activated; this run waited <n> s." n8n 2.44.5 keeps a 60 s load-options request open. Never set `ignoreHttpStatusErrors`: n8n re-runs `preAuthentication` only when a request throws. A run's first 404 asks `/status` once whether the blueprint is still one of the project's public blueprints; if not, it fails at once ("is not a public blueprint of …"), otherwise it keeps waiting.
- Errors: `answerOf()` reads status (`httpCode`), body and headers from the thrown `NodeApiError` (`cause.response`); `describeClusterError()` turns them into the user-facing messages. A blueprint's own errors (`properties.errorOutput[].detail` of a 500) are shown line by line. The credential test maps 401, 403 and 404 to messages with `rules`.

## Key Implementation Details

- **Only the POST `/models/{id}/runs` path** of the OpenAPI document is read, for the selected blueprint id; the document's `servers` are never used
- **resourceMapper** generates dynamic fields from OpenAPI schema properties. It is shown only once a blueprint is chosen (without one n8n shows "No input fields to show"). n8n (2.0 to 2.44.5) does not show errors thrown by `getOperationFields`, nor `emptyFieldsNotice` while a list loads, so:
  - `activationNotice` (type `notice`, above the resource mapper) explains the wait. Shown when a project and a blueprint are set in Visual Mapping, hidden once `/parameters.schema` has entries (displayOptions read the path with lodash `get`). Paths into a parameter start with `/` (from the node's root): n8n before 2.40 cannot order a dependency named `parameters.schema` and fails every run with "Could not resolve parameter dependencies".
  - `getOperationFields` waits for an activating key itself (10 s × 6). Only then does it return `emptyFieldsNotice` (with n8n's Retry) as the fallback; it shows below the activation notice, so it says only that the automatic wait ended.
  - A blueprint without inputs gets one hidden placeholder field `__leapter_no_inputs` (`display: false`). n8n ignores a hide rule on an empty list, so without it the activation notice would stay. `noInputsNotice` shows when `/parameters.schema[0].id` is the placeholder; `execute` sends only `body.` fields, so the placeholder is never sent.
  - n8n never cancels a field request; the editor ends its loading state with the first answer and keeps the last. So all field loads of one credential (`fieldLoadCaller()`) go through `newestLoad()`: a superseded load stops its retries and answers with the newest load's result. n8n gives a loader no node, workflow or user identity (it runs as "Temp-Node"); two people sharing a credential and loading fields in the same activation minute could get each other's answer.
  - Before waiting, `getOperationFields` checks that the blueprint is one of the project's (`/status`): after a project switch n8n asks once with the old blueprint, and that answers an empty list at once.
  - `getOperations` pre-warms the project's key: one engine request through the credential, not awaited, so a missing key is created while the user picks the blueprint.
- **Credential**: `clusterUrl` (display name "Leapter Server") is shown only under `showAdvanced`; its default is `https://runtime.leapter.com`
- **Array fields** are passed as JSON strings in visual mode, parsed via `tryParseJson()`
- **Response metadata**: Adds `_metadata.runId` (from `x-run-id` header); requests send the n8n execution ID as `X-Correlation-Id`
- **$ref resolution**: `resolveSchema()` handles `#/components/schemas/...` references

## Gotchas
- `usableAsTool: true` can cause node loading issues in dev mode (see line 240)
- Minimum n8n version 0.228.0 required for resourceMapper UI
- The `::` separator assumes values don't contain `::` themselves
