# CLAUDE.md

## What This Is
n8n community node that dynamically discovers and executes Leapter blueprints deployed to a Leapter Runtime Cluster. It reads the cluster's environments, projects and blueprints to populate dropdowns and each project's OpenAPI document to generate input fields - no hardcoded operations.

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
```

Releases are cut from the GitHub Releases UI (draft a release with a `vX.Y.Z` tag, publish it). `publish.yml` derives the npm version from the tag; the `version` in `package.json` is a permanent placeholder — never bump it.

## Project Structure
```
├── nodes/Leapter/
│   ├── Leapter.node.ts    # Main node implementation
│   ├── cluster.ts         # Run base, https check, cluster error messages
│   ├── Leapter.node.json  # Node metadata for n8n
│   └── leapter.svg        # Node icon
├── credentials/
│   ├── LeapterApi.credentials.ts  # Service key credential, per-project evaluation keys
│   └── eval-keys.ts       # Evaluation key map, grace period, authenticate ↔ preAuthentication side channel
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
| Methods | camelCase | `getProjects`, `getOperations` |
| Constants | SCREAMING_SNAKE_CASE | `CREDENTIAL_TYPE` |
| Properties | camelCase | `displayName`, `operationId` |

## Key Principles

### n8n Node Development
- Nodes implement `INodeType` with `description` and `execute()` method
- Credentials implement `ICredentialType` with `authenticate` block
- Use `loadOptions` methods for dynamic dropdowns
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
User selects environment (GET {cp}/environments) → project (GET {cp}/environments/{env}/status, applications with callable blueprints)
→ blueprint (callable[] of that application) → input fields from the engine's OpenAPI document
→ Execute POST {runBase}/runtime/api/v1/{env}/{app}/models/{blueprintId}/runs
```
`{cp}` is `{clusterUrl}/runtime-management`. `{runBase}` is read once per execution by `readRunBase()` (`nodes/Leapter/cluster.ts`).

### Saved Parameter Values
- **Environment**: the environment slug
- **Project**: `environment::application` (application slug)
- **Operation**: the blueprint id from `status` (`callable[].id`)

Parsed via array destructuring: `const [environment, application] = project.split('::')`

### Runtime Cluster Endpoints
- `GET {cp}/environments` - Environments the service key may reach (also the credential test)
- `GET {cp}/environments/{env}/status` - Applications with their callable blueprints (`id`, `name`, `slug`)
- `POST {cp}/environments/{env}/applications/{app}/keys` - Creates a project's evaluation key
- `POST {cp}/environments/{env}/applications/{app}/keys/{id}/revoke` - Revokes a replaced evaluation key
- `GET {runBase}/runtime/api/v1/{env}/{app}/openapi` - The project's OpenAPI 3.0 document
- `POST {runBase}/runtime/api/v1/{env}/{app}/models/{blueprintId}/runs` - Executes a blueprint
- `GET {origin}/runtime-management/ui/config.json` - Public, no credential: `runBaseUrl`, or the origin when null, 404 or 410 (same rule as the genielabs CLI)

All requests use `disableFollowRedirect: true`; `assertHttps()` refuses non-https addresses except `localhost`/`127.0.0.1`.

### Authentication and Key Handling
- The credential holds a key of the cluster's `n8n` service account (`serviceKey`, `lk_mgmt_…`). The control plane takes it; the engines take only per-project evaluation keys.
- `authenticate` routes by URL path: `/runtime-management/` gets `Authorization: Bearer <serviceKey>`, `/runtime/api/v1/{env}/{app}/` gets `X-API-Key` from the hidden expirable field `evalKeys` (JSON map `{ "env/app": { id, key, mintedAt } }`).
- `preAuthentication` (n8n calls it when `evalKeys` is empty and after every 401) creates a key for each project that was requested without one and replaces a rejected key once it is older than the 90 s grace period (`GRACE_MS`, `credentials/eval-keys.ts`): mint, then revoke the old id. A fresh key answers 401 for up to 60 s, so a younger key is never replaced. n8n stores the returned `evalKeys`.
- `authenticate` and `preAuthentication` share a module-level side channel (`pending`, `lastUsed` in `credentials/eval-keys.ts`), because n8n gives `preAuthentication` only the credential data.
- `execute` resends a run that throws 401 or 404 every 3 s for up to 90 s (a new key or a new deploy). Never set `ignoreHttpStatusErrors`: n8n re-runs `preAuthentication` only when a request throws a 401.
- Errors: `answerOf()` reads status (`httpCode`), body and headers from the thrown `NodeApiError` (`cause.response`); `describeClusterError()` turns them into the user-facing messages.

## Key Implementation Details

- **Only the POST `/models/{id}/runs` path** of the OpenAPI document is read, for the selected blueprint id; the document's `servers` are never used
- **resourceMapper** generates dynamic fields from OpenAPI schema properties
- **Array fields** are passed as JSON strings in visual mode, parsed via `tryParseJson()`
- **Response metadata**: Adds `_metadata.runId` (from `x-run-id` header); requests send the n8n execution ID as `X-Correlation-Id`
- **$ref resolution**: `resolveSchema()` handles `#/components/schemas/...` references

## Gotchas
- `usableAsTool: true` can cause node loading issues in dev mode (see line 240)
- Minimum n8n version 0.228.0 required for resourceMapper UI
- The `::` separator assumes values don't contain `::` themselves
