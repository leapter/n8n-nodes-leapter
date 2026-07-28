# n8n-nodes-leapter

This is an n8n community node that lets you use [Leapter](https://leapter.com) in your n8n workflows.

Leapter is an AI application platform that enables you to build, deploy, and manage AI blueprints. This node dynamically discovers and executes Leapter blueprints via OpenAPI specifications, providing a seamless integration between n8n workflows and Leapter's AI capabilities.

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

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

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
| `pnpm release` | Publish a new release |

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

The Leapter node provides dynamic operations based on your available blueprints:

- **Execute Blueprint**: Run any Leapter blueprint with input parameters
- **Dynamic Operation Discovery**: Automatically discovers available operations from your Leapter projects via OpenAPI specifications

### How It Works

1. Select a **Project** from your available Leapter projects
2. Choose an **Operation** (blueprint) to execute
3. Configure input parameters using either:
   - **Visual Mode**: Map fields visually with type hints
   - **JSON Mode**: Provide raw JSON input for advanced use cases
4. Execute and receive results with metadata including run ID and editor link

## Credentials

To use this node, you need a Leapter API key.

### Prerequisites

1. Sign up for a Leapter account at [lab.leapter.com](https://lab.leapter.com)
2. Create at least one project with published blueprints

### Setting Up Credentials

1. In Leapter, go to **Settings** → **API Keys**
2. Click **Create API Key**
3. Copy the generated key (starts with `lpt_`)
4. In n8n, create new credentials for "Leapter API"
5. Paste your API key
6. (Optional) Change the server URL if using a self-hosted instance

### Credential Fields

| Field | Description | Required |
|-------|-------------|----------|
| API Key | Your Leapter API key (starts with `lpt_`) | Yes |
| Leapter Server | Server URL (default: `https://lab.leapter.com`) | No |

## Compatibility

- **Minimum n8n version**: 2.0.0
- **Tested with**: n8n 2.x

## Usage

### Visual Mode (Recommended)

Visual mode provides a guided experience with field-by-field mapping:

1. Select your project and operation
2. The node automatically loads available input fields
3. Map values from previous nodes or enter static values
4. Each field shows its type and whether it's required

### JSON Mode

For advanced users or complex payloads:

1. Select your project and operation
2. Switch **Input Mode** to "JSON"
3. Enter your parameters as a JSON object
4. Refer to the OpenAPI spec for field definitions

### Example Workflow

```
Trigger → Leapter (Execute Blueprint) → Process Results
```

### Output

The node returns:
- **Response data**: The blueprint execution results
- **Metadata**:
  - `runId`: Unique identifier for the execution
  - `editorLink`: Direct link to view the run in Leapter

### Error Handling

- **401/403 errors**: Check your API key and project access
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
