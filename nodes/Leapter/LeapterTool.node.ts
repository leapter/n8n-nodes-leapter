import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { ZodTypeAny } from 'zod';

import {
	CREDENTIAL_TYPE,
	fetchProjects,
	fetchOperations,
	buildZodSchemaFromOperation,
	describeOperationParams,
	resolveSchema,
	sanitizeToolName,
	deduplicateToolNames,
} from './utils';
import type { OpenAPISpec } from './utils';

// System fields injected by n8n into tool input data (not blueprint arguments)
const SYSTEM_FIELDS = new Set([
	'sessionId',
	'action',
	'chatInput',
	'toolCallId',
]);

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class LeapterTool implements INodeType {
		description: INodeTypeDescription = {
		displayName: 'Leapter Tool',
		name: 'leapterTool',
		icon: 'file:leapter.svg',
		group: ['transform'],
		version: 1,
		description: 'Use Leapter blueprints as AI Agent tools',
		defaults: {
			name: 'Leapter Tool',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/genielabs-com/n8n-nodes-leapter#readme',
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
			// 1. Project Dropdown
			{
				displayName: 'Project Name or ID',
				name: 'project',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getProjects',
				},
				default: '',
				required: true,
				noDataExpression: true,
				description:
					'The Leapter project whose blueprints will be exposed as AI tools. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// 2. Blueprints Filter (multi-select, empty = all)
			{
				displayName: 'Blueprint Names or IDs',
				name: 'blueprintFilter',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getOperations',
					loadOptionsDependsOn: ['project'],
				},
				default: [],
				noDataExpression: true,
				description:
					'Select specific blueprints to expose as tools. Leave empty to expose all blueprints in the project. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// 3. Tool Description Prefix (optional)
			{
				displayName: 'Tool Description Prefix',
				name: 'toolDescriptionPrefix',
				type: 'string',
				default: '',
				description:
					'Optional text prepended to each tool description. Use this to give the AI extra context about when to use these tools.',
				placeholder: 'e.g. "Use this tool for the Acme project to..."',
			},

			// 4. Options
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

	methods = {
		loadOptions: {
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return fetchProjects(this);
			},

			async getOperations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return fetchOperations(this);
			},
		},
	};

	/**
	 * Called by n8n when the AI Agent invokes a tool.
	 * Routes to the correct blueprint using:
	 * 1. The action field (tool name) if available
	 * 2. Schema-key matching as fallback
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const executionId = this.getExecutionId() || '';

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const input = items[itemIndex].json;
				const options = this.getNodeParameter('options', itemIndex, {}) as {
					timeout?: number;
				};

				// Extract action field for tool-name routing before filtering
				const action = typeof input.action === 'string' ? input.action : '';

				// Extract tool arguments (filter out n8n system fields)
				const toolArgs: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(input)) {
					if (!SYSTEM_FIELDS.has(key)) {
						toolArgs[key] = value;
					}
				}

				// Parse project compound value: projectId::specUrl::editorBaseUrl::projectName
				const projectValue = this.getNodeParameter('project', itemIndex) as string;
				const projectParts = projectValue.split('::');
				const specUrl = projectParts[1];
				const editorBaseUrl = projectParts[2];

				if (!specUrl || !specUrl.startsWith('http')) {
					throw new NodeOperationError(
						this.getNode(),
						`Invalid project configuration. Cannot parse spec URL from: "${projectValue}"`,
						{ itemIndex },
					);
				}

				// Fetch OpenAPI spec to resolve blueprint
				const spec = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL_TYPE,
					{
						method: 'GET',
						url: specUrl,
						json: true,
					},
				)) as OpenAPISpec;

				const serverUrl = (spec.servers?.[0]?.url || '').replace(/\/$/, '');

				if (!serverUrl.startsWith('http')) {
					throw new NodeOperationError(
						this.getNode(),
						`OpenAPI spec server URL is not absolute: "${spec.servers?.[0]?.url}"`,
						{ itemIndex },
					);
				}

				// Collect all blueprints with their schemas
				const blueprints: Array<{
					name: string;
					path: string;
					operationUrl: string;
					schemaKeys: Set<string>;
				}> = [];

				for (const [path, pathItem] of Object.entries(spec.paths)) {
					const operation = pathItem.post;
					if (!operation || operation.deprecated) continue;

					const bpName =
						operation.summary || operation.operationId || path.replace(/\//g, '_');
					const schemaKeys = new Set<string>();

					const requestBody = operation.requestBody;
					if (requestBody) {
						const content = requestBody.content?.['application/json'];
						const rawSchema = content?.schema;
						if (rawSchema) {
							// Resolve $ref to get actual properties
							const resolvedSchema = resolveSchema(rawSchema, spec);
							if (resolvedSchema?.properties) {
								for (const key of Object.keys(resolvedSchema.properties)) {
									schemaKeys.add(key);
								}
							}
						}
					}

					blueprints.push({
						name: sanitizeToolName(bpName),
						path,
						operationUrl: `${serverUrl}${path}`,
						schemaKeys,
					});
				}

				// Route to the correct blueprint
				let matched: (typeof blueprints)[0] | undefined;

				// Strategy 1: Match by action field (tool name)
				if (action) {
					const actionSanitized = sanitizeToolName(action);
					matched = blueprints.find((bp) => bp.name === actionSanitized);
				}

				// Strategy 2: Schema-key matching fallback
				if (!matched) {
					if (blueprints.length === 1) {
						matched = blueprints[0];
					} else if (blueprints.length > 1) {
						const inputKeys = new Set(Object.keys(toolArgs));
						let bestScore = -1;

						for (const bp of blueprints) {
							if (bp.schemaKeys.size === 0) continue;

							// Score: how many input keys match the blueprint's schema keys
							let score = 0;
							for (const key of inputKeys) {
								if (bp.schemaKeys.has(key)) score++;
							}

							// Coverage: what fraction of blueprint schema is matched
							const coverage = score / bp.schemaKeys.size;

							// Prefer blueprints where input keys match most of the schema
							const weightedScore = score + coverage;

							if (weightedScore > bestScore) {
								bestScore = weightedScore;
								matched = bp;
							}
						}
					}
				}

				if (!matched) {
					throw new NodeOperationError(
						this.getNode(),
						`No blueprint matched the input arguments: ${JSON.stringify(Object.keys(toolArgs))}. ` +
							`Available blueprints: ${blueprints.map((b) => b.name).join(', ')}`,
						{ itemIndex },
					);
				}

				// Execute the matched blueprint
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL_TYPE,
					{
						method: 'POST',
						url: matched.operationUrl,
						headers: {
							'X-Correlation-Id': executionId,
							'Content-Type': 'application/json',
						},
						body: toolArgs,
						json: true,
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
						...(options.timeout ? { timeout: options.timeout } : {}),
					},
				)) as {
					body: unknown;
					headers: Record<string, string>;
					statusCode: number;
				};

				const statusCode = response.statusCode || 200;
				const responseBody = response.body;

				if (statusCode >= 400) {
					const errorBody =
						typeof responseBody === 'object' && responseBody !== null
							? responseBody
							: {};
					const errorMessage =
						(errorBody as Record<string, string>).detail ||
						(errorBody as Record<string, string>).error ||
						(errorBody as Record<string, string>).message ||
						`Request failed with status ${statusCode}`;

					returnData.push({
						json: { error: errorMessage, statusCode },
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				// Extract metadata
				const runId = response.headers['x-run-id'] || response.headers['X-Run-Id'];
				const modelIdMatch = matched.path.match(/\/models\/([^/]+)\/runs/);
				const modelId = modelIdMatch?.[1];
				const editorLink =
					modelId && editorBaseUrl && editorBaseUrl !== 'undefined'
						? `${editorBaseUrl}/${modelId}`
						: '';

				const resultObj =
					typeof responseBody === 'object' && responseBody !== null
						? (responseBody as Record<string, unknown>)
						: { result: responseBody };

				returnData.push({
					json: {
						...resultObj,
						_metadata: { runId, editorLink },
					},
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
					`Blueprint execution failed: ${err.message}`,
					{ itemIndex },
				);
			}
		}

		return [returnData];
	}

	/**
	 * Provides multiple tools to the AI Agent — one per blueprint.
	 * Each tool has a concrete schema from the OpenAPI spec so the LLM
	 * can generate proper structured tool calls.
	 * When the LLM calls a tool, n8n invokes execute() with the arguments.
	 */
	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		// Lazy imports: @langchain/core and zod are provided by n8n at runtime
		// but not resolvable at module load time in dev mode
		// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports
		const { DynamicStructuredTool } = await import('@langchain/core/tools');
		const { z } = await import('zod');

		const projectValue = this.getNodeParameter('project', itemIndex) as string;

		if (!projectValue) {
			throw new NodeOperationError(
				this.getNode(),
				'No project selected. Please select a project first.',
			);
		}

		const blueprintFilter = this.getNodeParameter('blueprintFilter', itemIndex, []) as
			| string[]
			| string;
		const toolDescriptionPrefix = this.getNodeParameter(
			'toolDescriptionPrefix',
			itemIndex,
			'',
		) as string;

		// Parse project compound value: projectId::specUrl::editorBaseUrl::projectName
		const projectParts = projectValue.split('::');
		const specUrl = projectParts[1];

		if (!specUrl || !specUrl.startsWith('http')) {
			throw new NodeOperationError(
				this.getNode(),
				`Invalid project value. Expected compound format but got: "${projectValue}" (parsed specUrl: "${specUrl}")`,
			);
		}

		// Fetch OpenAPI spec
		const spec = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_TYPE,
			{
				method: 'GET',
				url: specUrl,
				json: true,
			},
		)) as OpenAPISpec;

		if (!spec.openapi || !spec.paths) {
			throw new NodeOperationError(this.getNode(), 'Invalid OpenAPI specification');
		}

		if (!spec.servers || spec.servers.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'OpenAPI spec must define at least one server URL',
			);
		}

		const rawServerUrl = spec.servers[0].url;
		const serverUrl = rawServerUrl.replace(/\/$/, '');

		if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
			throw new NodeOperationError(
				this.getNode(),
				`OpenAPI spec server URL must be absolute, got: "${rawServerUrl}". ` +
					'The spec.servers[0].url must include the protocol and host.',
			);
		}

		const filterArray: string[] = Array.isArray(blueprintFilter) ? blueprintFilter : [];
		const filterPaths = new Set(
			filterArray.map((v) => {
				const [, filterPath] = v.split('::');
				return filterPath;
			}),
		);
		const hasFilter = filterPaths.size > 0;

		// Build one tool per POST blueprint
		const toolNames: string[] = [];
		const toolEntries: Array<{
			name: string;
			description: string;
			schema: Record<string, ZodTypeAny>;
		}> = [];

		for (const [path, pathItem] of Object.entries(spec.paths)) {
			const operation = pathItem.post;
			if (!operation || operation.deprecated) continue;

			if (hasFilter && !filterPaths.has(path)) continue;

			const blueprintName =
				operation.summary || operation.operationId || path.replace(/\//g, '_');
			const toolName = sanitizeToolName(blueprintName);
			toolNames.push(toolName);

			const paramDescription = describeOperationParams(operation, spec);
			const description = [
				toolDescriptionPrefix,
				operation.description || operation.summary || blueprintName,
				paramDescription,
			]
				.filter(Boolean)
				.join('\n');

			const zodShape = buildZodSchemaFromOperation(operation, spec);

			toolEntries.push({
				name: toolName,
				description,
				schema: zodShape,
			});
		}

		if (toolEntries.length === 0) {
			throw new NodeOperationError(
				this.getNode(),
				'No blueprints found in the selected project. Ensure the project has published blueprints.',
			);
		}

		// Deduplicate tool names
		const uniqueNames = deduplicateToolNames(toolNames);

		const nodeName = this.getNode().name;

		// Create one DynamicStructuredTool per blueprint with concrete schemas
		const tools = toolEntries.map((entry, i) => {
			const hasSchema = Object.keys(entry.schema).length > 0;
			const zodObject = hasSchema
				? z.object(entry.schema)
				: z.object({ input: z.string().optional().describe('Optional input') });

			return new DynamicStructuredTool({
				name: uniqueNames[i],
				description: entry.description,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			schema: zodObject as any,
				// func is required by DynamicStructuredTool but n8n calls execute() instead
				func: async (): Promise<string> => {
					return JSON.stringify({
						error: 'Unexpected: func should not be called directly',
					});
				},
				metadata: {
					sourceNodeName: nodeName,
				},
			});
		});

		return { response: tools };
	}
}
