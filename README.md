# n8n-nodes-leapter

This is an n8n community node that lets you use [Leapter](https://leapter.com) in your n8n workflows.

Leapter is a decision logic platform: business rules live as visual, versioned **Blueprints**. You describe a rule in plain language and Leapter's AI agents draft the Blueprint for you — then humans review and approve it. At runtime, the approved Blueprint executes deterministically: the same input always produces the same output, with no LLM anywhere in the execution path. This node lists the public Blueprints deployed to your Leapter Runtime Cluster and runs them from your workflow, either as a regular node or as a tool on an AI Agent.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

## Table of Contents

- [Installation](#installation)
- [Development Setup](#development-setup)
- [Operations](#operations)
- [Credentials](#credentials)
- [Compatibility](#compatibility)
- [Usage](#usage)
- [Resources](#resources)
- [Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation, using the package name `n8n-nodes-leapter`.

> **Renamed in v0.1.4.** This package was previously released as `@leapter/n8n-nodes-leapter`,
> which is now deprecated. Existing installations keep working but do not update automatically —
> reinstall using the new name to receive further releases.

## Development Setup

### Prerequisites

- **Node.js**: Version 20.19 - 24.x (n8n does not support Node.js 25+)
- **pnpm**: Package manager

To check your Node.js version:
```bash
node -v
```

If you need to switch versions using Homebrew:
```bash
brew install node@24
brew unlink node
brew link --overwrite node@24
```

### Install Dependencies

```bash
pnpm install
```

### Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start n8n with the node in development mode (with hot reload) |
| `pnpm build` | Build the node for production |
| `pnpm build:watch` | Build and watch for changes |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Fix linting issues |

Releases are cut from the GitHub Releases UI: draft a release with a `vX.Y.Z` tag and publish it. The version is taken from the tag (see `.github/workflows/publish.yml`); the `version` field in `package.json` is a placeholder.

### Running Locally

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start the development server:
   ```bash
   pnpm dev
   ```

3. Open n8n in your browser:
   ```
   http://localhost:5678
   ```

The Leapter node will be available in the n8n node picker.

## Operations

The Leapter node provides dynamic operations based on the Blueprints deployed to your Runtime Cluster:

- **Execute Blueprint**: Run any public Leapter Blueprint with input parameters
- **Dynamic Discovery**: Lists the projects and Blueprints your service key reaches and reads each Blueprint's input fields from its OpenAPI specification

### How It Works

1. Select a **Project**: the dropdown lists every deployed project with public Blueprints that your service key reaches. When the key reaches more than one environment, each project is shown as `environment · project`.
2. Select a **Blueprint**: the dropdown lists the project's public Blueprints
3. Configure input parameters using either:
   - **Visual Mode**: Map fields visually with type hints
   - **JSON Mode**: Provide raw JSON input for advanced use cases
4. Execute and receive results with the run ID

The first use of a project creates its access key automatically; the node starts this as soon as you choose the project. The key takes up to a minute to become active. Meanwhile a yellow note says "On first use, Leapter activates access to this project. This can take up to a minute; the fields load automatically.", n8n shows "Fetching parameters", and the node asks again every 10 s, up to 6 times. The fields then appear by themselves and the note disappears; you do not need to click anything. Only if the key is still not active after a minute does the list say "Access to <project> is being activated, which takes up to a minute. Click Retry in a moment." A first run waits the same way and then notes in its output: "Access to <project> was activated; this run waited <n> s." Later runs start at once. A Blueprint without inputs shows "This blueprint takes no inputs. Run it as it is." and runs with an empty input.

## Credentials

One Leapter credential gives access to every project in the environments its service key reaches.

### Setting Up Credentials

1. **Deploy the project** in the Leapter Lab to an environment of your Runtime Cluster.
2. **Create a key for the `n8n` service account** in the Runtime Cluster's Admin UI: **Service accounts → n8n → Create key**. Copy the key (starts with `lk_mgmt_`).
3. **Create the credential** in n8n: add a "Leapter API" credential, paste that key and save; n8n tests it. For a self-hosted or development cluster, turn on **Advanced Settings** and enter its address as **Leapter Server**.

### Credential Fields

| Field | Description | Required |
|-------|-------------|----------|
| Service Key | A key of the `n8n` service account (starts with `lk_mgmt_`) | Yes |
| Advanced Settings | Shows the server field | No |
| Leapter Server | The Leapter Runtime Cluster: the Admin UI's address without `/runtime-management/ui`. Default `https://runtime.leapter.com`; only change for self-hosted clusters or development | No |

The credential also keeps the access keys it creates for each project, in a field n8n does not show. Anyone who can read the credential in n8n can read them.

## Compatibility

- **Minimum n8n version**: 2.0.0
- **Tested with**: n8n 2.44.5

## Usage

### Visual Mode (Recommended)

Visual mode provides a guided experience with field-by-field mapping:

1. Select your project and Blueprint
2. The node automatically loads available input fields
3. Map values from previous nodes or enter static values
4. Each field shows its type and whether it's required

### JSON Mode

For advanced users or complex payloads:

1. Select your project and Blueprint
2. Switch **Input Mode** to "JSON"
3. Enter your parameters as a JSON object
4. Refer to the OpenAPI spec for field definitions

### Example Workflow

```
Trigger → Leapter (Execute Blueprint) → Process Results
```

### Output

The node returns:
- **Response data**: The Blueprint execution results (`outputData`)
- **Metadata**:
  - `runId`: Unique identifier for the run

Runs appear in the Admin UI under **Runs**, with the n8n execution ID as their correlation ID.

### Error Handling

| Answer | Message |
|--------|---------|
| 403 from the cluster | "The cluster refused the service key. It was revoked or has no rights here. Create a new key in the Admin UI: Service accounts → n8n → Create key." |
| 401 from a run, after the node's own retries (6, 10 s apart) | "The project's access key is not active yet or was revoked. Try again in a minute." |
| 404 without a JSON body, after the node's own retries (6, 10 s apart) | "The cluster serves nothing at this address yet. A newly deployed project takes about a minute to be reachable." |
| 400 | The cluster's `detail`, then one line per invalid field: `<field>: <message>` |
| 500 | The cluster's `detail`, plus the Blueprint's exception type |
| 429 or 503 | The cluster's `detail`, plus "Retry after <n> s" when the cluster says so. Use n8n's **Retry On Fail** setting to retry automatically. |
| Any other | The cluster's `detail`, else its `title`, else "Request failed with status <n>" |

While loading the field list, a 401 or 404 is retried the same way; only if it persists does the list show "Access to <project> is being activated, which takes up to a minute. Click Retry in a moment."

With **Continue On Fail**, a failed item outputs `{ error, statusCode, ...body }`.

- **Timeout errors**: Increase the timeout in node options (default: 30 seconds)

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Leapter Documentation](https://docs.leapter.com)
- [Leapter n8n Integration Guide](https://github.com/leapter/n8n-nodes-leapter#readme)

## Version history

### 0.1.0

- Initial release
- Dynamic project and blueprint discovery
- Visual and JSON input modes
- Resource mapper for visual field mapping
- Execution metadata with run ID and editor links
