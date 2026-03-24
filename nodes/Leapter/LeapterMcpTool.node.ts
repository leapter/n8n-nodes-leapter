import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

// URL is a Node.js global available at runtime but not in our TypeScript lib config
declare class URL {
	constructor(input: string, base?: string);
}

import {
	CREDENTIAL_TYPE,
	sanitizeToolName,
	deduplicateToolNames,
	jsonSchemaToZod,
	getAllMcpTools,
	extractTextFromContent,
} from './utils';
import type { McpCallToolResult, McpToolDef } from './utils';

// System fields injected by n8n into tool input data (not blueprint arguments)
const SYSTEM_FIELDS = new Set(['sessionId', 'action', 'chatInput', 'toolCallId']);

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class LeapterMcpTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Leapter MCP Tool',
		name: 'leapterMcpTool',
		icon: 'file:leapter.svg',
		group: ['transform'],
		version: 1,
		description: 'Use Leapter MCP server tools as AI Agent tools',
		defaults: {
			name: 'Leapter MCP Tool',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/leapter/n8n-nodes-leapter#readme',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: [
			{
				name: 'leapterApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'MCP Server URL',
				name: 'mcpServerUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. https://mcp.leapter.com/v1/mcp',
				description: 'The URL of the Leapter MCP server endpoint',
			},
			{
				displayName: 'Tool Description Prefix',
				name: 'toolDescriptionPrefix',
				type: 'string',
				default: '',
				description:
					'Optional text prepended to each tool description. Use this to give the AI extra context about when to use these tools.',
				placeholder: 'e.g. "Use this tool for the Acme project to..."',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 30000,
						description: 'Request timeout in milliseconds',
					},
				],
			},
		],
	};

	/**
	 * Fallback execution path. Reconnects to MCP and calls the tool identified by the action field.
	 * Used when n8n routes execution here instead of through the func closure.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const mcpServerUrl = this.getNodeParameter('mcpServerUrl', 0) as string;
		if (!mcpServerUrl) {
			throw new NodeOperationError(this.getNode(), 'MCP Server URL is required.');
		}

		const credentials = await this.getCredentials(CREDENTIAL_TYPE);
		const apiKey = credentials.apiKey as string;

		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { StreamableHTTPClientTransport } = await import(
			'@modelcontextprotocol/sdk/client/streamableHttp.js'
		);

		const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl), {
			requestInit: { headers: { 'X-API-Key': apiKey } },
		});

		const client = new Client({ name: 'n8n-leapter', version: '1.0.0' });
		await client.connect(transport);

		try {
			const mcpTools = await getAllMcpTools(client);

			for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
				try {
					const input = items[itemIndex].json;
					const action = typeof input.action === 'string' ? input.action : '';

					// Extract tool arguments (filter out n8n system fields)
					const toolArgs: Record<string, unknown> = {};
					for (const [key, value] of Object.entries(input)) {
						if (!SYSTEM_FIELDS.has(key)) {
							toolArgs[key] = value;
						}
					}

					// Find matching tool by action name
					const actionSanitized = sanitizeToolName(action);
					const matched = mcpTools.find(
						(t) => sanitizeToolName(t.name) === actionSanitized,
					);

					if (!matched) {
						throw new NodeOperationError(
							this.getNode(),
							`No MCP tool matched action "${action}". Available: ${mcpTools.map((t) => t.name).join(', ')}`,
							{ itemIndex },
						);
					}

					const result = (await client.callTool({
						name: matched.name,
						arguments: toolArgs,
					})) as McpCallToolResult;

					const text = extractTextFromContent(result.content);
					let jsonResult: IDataObject;
					try {
						jsonResult = JSON.parse(text) as IDataObject;
					} catch {
						jsonResult = { result: text };
					}

					returnData.push({
						json: jsonResult,
						pairedItem: { item: itemIndex },
					});
				} catch (error) {
					const err = error as Error;
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: err.message },
							pairedItem: { item: itemIndex },
						});
						continue;
					}
					if (error instanceof NodeOperationError) throw error;
					throw new NodeOperationError(
						this.getNode(),
						`MCP tool execution failed: ${err.message}`,
						{ itemIndex },
					);
				}
			}
		} finally {
			await client.close();
		}

		return [returnData];
	}

	/**
	 * Provides tools to the AI Agent — one per MCP tool.
	 * Connects to the MCP server once, lists all tools, then wraps each
	 * as a DynamicStructuredTool with a func closure that calls the MCP server directly.
	 */
	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { DynamicStructuredTool } = await import('@langchain/core/tools');
		const { z } = await import('zod');

		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { StreamableHTTPClientTransport } = await import(
			'@modelcontextprotocol/sdk/client/streamableHttp.js'
		);

		const mcpServerUrl = this.getNodeParameter('mcpServerUrl', itemIndex) as string;
		if (!mcpServerUrl) {
			throw new NodeOperationError(this.getNode(), 'MCP Server URL is required.');
		}

		const toolDescriptionPrefix = this.getNodeParameter(
			'toolDescriptionPrefix',
			itemIndex,
			'',
		) as string;

		// Get API key from credentials
		const credentials = await this.getCredentials(CREDENTIAL_TYPE);
		const apiKey = credentials.apiKey as string;

		// Create transport with API key header
		const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl), {
			requestInit: { headers: { 'X-API-Key': apiKey } },
		});

		// Connect MCP client
		const client = new Client({ name: 'n8n-leapter', version: '1.0.0' });
		await client.connect(transport);

		let mcpTools: McpToolDef[];
		try {
			mcpTools = await getAllMcpTools(client);
		} catch (error) {
			await client.close();
			const err = error as Error;
			throw new NodeOperationError(
				this.getNode(),
				`Failed to list MCP tools: ${err.message}`,
			);
		}

		if (mcpTools.length === 0) {
			await client.close();
			throw new NodeOperationError(this.getNode(), 'No tools found on the MCP server.');
		}

		// Build tool names and deduplicate
		const toolNames = mcpTools.map((t) => sanitizeToolName(t.name));
		const uniqueNames = deduplicateToolNames(toolNames);
		const nodeName = this.getNode().name;

		// Create DynamicStructuredTool per MCP tool
		const tools = mcpTools.map((mcpTool, i) => {
			const properties = mcpTool.inputSchema.properties || {};
			const required = mcpTool.inputSchema.required || [];
			const zodShape: Record<string, import('zod').ZodTypeAny> = {};

			for (const [key, propSchema] of Object.entries(properties)) {
				zodShape[key] = jsonSchemaToZod(propSchema, required.includes(key));
			}

			const hasSchema = Object.keys(zodShape).length > 0;
			const zodObject = hasSchema
				? z.object(zodShape)
				: z.object({ input: z.string().optional().describe('Optional input') });

			const description = [toolDescriptionPrefix, mcpTool.description || mcpTool.name]
				.filter(Boolean)
				.join('\n');

			return new DynamicStructuredTool({
				name: uniqueNames[i],
				description,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				schema: zodObject as any,
				func: async (args: Record<string, unknown>): Promise<string> => {
					try {
						const result = (await client.callTool({
							name: mcpTool.name,
							arguments: args,
						})) as McpCallToolResult;
						return extractTextFromContent(result.content);
					} catch (error) {
						const err = error as Error;
						return JSON.stringify({ error: err.message });
					}
				},
				metadata: {
					sourceNodeName: nodeName,
				},
			});
		});

		return {
			response: tools,
			closeFunction: async () => {
				await client.close();
			},
		};
	}
}
