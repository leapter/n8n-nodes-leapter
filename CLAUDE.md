# CLAUDE.md

## What This Is
n8n community node that dynamically discovers and executes Leapter AI blueprints. It reads OpenAPI specs at runtime to populate dropdowns and generate input fields - no hardcoded operations.

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
│   ├── Leapter.node.json  # Node metadata for n8n
│   └── leapter.svg        # Node icon
├── credentials/
│   └── LeapterApi.credentials.ts  # API key credential
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
User selects project → Fetch OpenAPI spec → Parse blueprints → User selects blueprint → Generate input fields from schema → Execute POST to /models/{id}/runs
```

### Critical Pattern: Compound Value Encoding
Dropdowns encode multiple values with `::` separator to avoid extra API calls:
- **Project**: `projectId::specUrl::editorBaseUrl::projectName`
- **Operation**: `method::path::operationUrl::editorBaseUrl::blueprintName`

This is parsed via array destructuring: `const [method, path, operationUrl] = operation.split('::')`

### Leapter API Endpoints
- `POST /api/v1/n8n/projects` - Returns projects with their OpenAPI spec URLs
- `GET {specUrl}` - Returns OpenAPI 3.0 spec for a project
- `POST /models/{blueprintId}/runs` - Executes a blueprint (defined in spec)
- `POST /api/api-keys/validate` - Credential test endpoint

### Authentication
Uses `httpRequestWithAuthentication()` which auto-injects `X-API-Key` header via credential's `authenticate` block.

## Key Implementation Details

- **Only POST endpoints** are parsed - Leapter runs are always POST to `/models/{id}/runs`
- **resourceMapper** generates dynamic fields from OpenAPI schema properties
- **Array fields** are passed as JSON strings in visual mode, parsed via `tryParseJson()`
- **Response metadata**: Adds `_metadata.runId` (from `x-run-id` header) and `_metadata.editorLink`
- **$ref resolution**: `resolveSchema()` handles `#/components/schemas/...` references

## Gotchas
- `usableAsTool: true` can cause node loading issues in dev mode (see line 240)
- OpenAPI spec must have `servers` array defined
- Minimum n8n version 0.228.0 required for resourceMapper UI
- The `::` separator assumes values don't contain `::` themselves
