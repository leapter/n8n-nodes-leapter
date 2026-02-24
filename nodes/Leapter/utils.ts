import type {
	ILoadOptionsFunctions,
	INodePropertyOptions,
	FieldType,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

/**
 * OpenAPI 3.0 Specification types
 */
export interface OpenAPISpec {
	openapi: string;
	info: {
		title: string;
		version: string;
		description?: string;
	};
	servers?: Array<{
		url: string;
		description?: string;
	}>;
	paths: Record<string, PathItem>;
	components?: {
		schemas?: Record<string, JSONSchema>;
	};
}

export interface PathItem {
	get?: Operation;
	post?: Operation;
	put?: Operation;
	delete?: Operation;
	patch?: Operation;
}

export interface Operation {
	summary?: string;
	description?: string;
	operationId?: string;
	tags?: string[];
	deprecated?: boolean;
	parameters?: Parameter[];
	requestBody?: {
		required?: boolean;
		description?: string;
		content?: Record<string, { schema?: JSONSchema }>;
	};
	responses?: Record<string, unknown>;
}

export interface Parameter {
	name: string;
	in: 'path' | 'query' | 'header' | 'cookie';
	required?: boolean;
	description?: string;
	schema?: JSONSchema;
}

export interface JSONSchema {
	type?: string;
	format?: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	items?: JSONSchema;
	enum?: string[];
	description?: string;
	$ref?: string;
}

/**
 * Project info from /api/n8n/projects
 */
export interface ProjectInfo {
	projectId: string;
	projectName: string;
	specUrl: string;
	editorBaseUrl: string;
}

/**
 * Response from /api/n8n/projects
 */
export interface ProjectDiscoveryResponse {
	accountId: string;
	projects: ProjectInfo[];
}

/**
 * Credential type name for Leapter API Key
 */
export const CREDENTIAL_TYPE = 'leapterApi';

/**
 * Resolve $ref references in JSON Schema
 */
export function resolveSchema(schema: JSONSchema, spec: OpenAPISpec): JSONSchema {
	if (schema.$ref) {
		// Parse $ref like "#/components/schemas/MySchema"
		const refPath = schema.$ref.replace('#/', '').split('/');
		let resolved: unknown = spec;

		for (const part of refPath) {
			if (resolved === undefined || resolved === null || typeof resolved !== 'object') {
				throw new Error(`Cannot resolve $ref "${schema.$ref}": missing segment "${part}"`);
			}
			resolved = (resolved as Record<string, unknown>)[part];
		}

		if (resolved === undefined || resolved === null) {
			throw new Error(`Cannot resolve $ref "${schema.$ref}": target not found`);
		}

		return resolved as JSONSchema;
	}

	return schema;
}

/**
 * Map OpenAPI types to n8n field types
 */
export function mapOpenApiType(openApiType: string | undefined): FieldType {
	const typeMap: Record<string, FieldType> = {
		string: 'string',
		integer: 'number',
		number: 'number',
		boolean: 'boolean',
		object: 'object',
		array: 'array',
	};

	return typeMap[openApiType || 'string'] || 'string';
}

/**
 * Try to parse a value as JSON if it's a string that looks like JSON array/object
 * Returns the parsed value or the original value if parsing fails
 */
export function tryParseJson(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}

	const trimmed = value.trim();

	// Only try to parse if it looks like JSON array or object
	if (
		(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
		(trimmed.startsWith('{') && trimmed.endsWith('}'))
	) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// If parsing fails, return the original string
			return value;
		}
	}

	return value;
}

/**
 * Convert an OpenAPI JSON Schema property to a Zod type
 */
export function openApiToZod(
	schema: JSONSchema,
	spec: OpenAPISpec,
	required: boolean,
): ZodTypeAny {
	const resolved = resolveSchema(schema, spec);
	let zodType: ZodTypeAny;

	switch (resolved.type) {
		case 'string':
			if (resolved.enum && resolved.enum.length > 0) {
				zodType = z.enum(resolved.enum as [string, ...string[]]);
			} else {
				zodType = z.string();
			}
			break;
		case 'integer':
		case 'number':
			zodType = z.number();
			break;
		case 'boolean':
			zodType = z.boolean();
			break;
		case 'array': {
			const itemSchema = resolved.items
				? openApiToZod(resolved.items, spec, true)
				: z.string();
			zodType = z.array(itemSchema);
			break;
		}
		case 'object':
			if (resolved.properties) {
				const shape: Record<string, ZodTypeAny> = {};
				for (const [key, propSchema] of Object.entries(resolved.properties)) {
					const isRequired = resolved.required?.includes(key) ?? false;
					shape[key] = openApiToZod(propSchema, spec, isRequired);
				}
				zodType = z.object(shape);
			} else {
				zodType = z.record(z.unknown());
			}
			break;
		default:
			zodType = z.string();
	}

	if (resolved.description) {
		zodType = zodType.describe(resolved.description);
	}

	return required ? zodType : zodType.optional();
}

/**
 * Sanitize a blueprint name into a valid LangChain tool name.
 * Must match /^[a-zA-Z0-9_-]{1,64}$/
 */
export function sanitizeToolName(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/g, '_')
		.replace(/[^a-z0-9_-]/g, '')
		.slice(0, 64) || 'leapter_tool';
}

/**
 * Deduplicate tool names by appending numeric suffixes
 */
export function deduplicateToolNames(names: string[]): string[] {
	const counts = new Map<string, number>();
	const result: string[] = [];

	for (const name of names) {
		const count = counts.get(name) ?? 0;
		if (count === 0) {
			result.push(name);
		} else {
			const suffix = `_${count}`;
			const base = name.slice(0, 64 - suffix.length);
			result.push(`${base}${suffix}`);
		}
		counts.set(name, count + 1);
	}

	return result;
}

/**
 * Fetch projects from /api/v1/n8n/projects
 */
export async function fetchProjects(
	context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	try {
		const credentials = await context.getCredentials(CREDENTIAL_TYPE);
		const labUrl = credentials.server as string;

		const discoveryResponse = (await context.helpers.httpRequestWithAuthentication.call(
			context,
			CREDENTIAL_TYPE,
			{
				method: 'POST',
				url: `${labUrl}/api/v1/n8n/projects`,
				json: true,
			},
		)) as ProjectDiscoveryResponse;

		if (!discoveryResponse.projects || discoveryResponse.projects.length === 0) {
			throw new NodeOperationError(
				context.getNode(),
				'No projects found. Ensure your API key has access to at least one project.',
			);
		}

		const options: INodePropertyOptions[] = discoveryResponse.projects.map((project) => ({
			name: project.projectName,
			value: `${project.projectId}::${project.specUrl}::${project.editorBaseUrl}::${project.projectName}`,
			description: `Project ID: ${project.projectId}`,
		}));

		options.sort((a, b) => a.name.localeCompare(b.name));

		return options;
	} catch (error) {
		if (error instanceof NodeOperationError) throw error;
		const err = error as Error & { statusCode?: number };

		if (err.statusCode === 401 || err.statusCode === 403) {
			throw new NodeOperationError(
				context.getNode(),
				'Invalid API key or no project access. Please check your credentials.',
			);
		}

		throw new NodeOperationError(
			context.getNode(),
			`Failed to load projects: ${err.message}`,
		);
	}
}

/**
 * Fetch operations (blueprints) from a project's OpenAPI spec
 */
export async function fetchOperations(
	context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const returnData: INodePropertyOptions[] = [];
	const projectValue = context.getNodeParameter('project') as string;

	if (!projectValue) {
		return returnData;
	}

	try {
		const [, specUrl, editorBaseUrl] = projectValue.split('::');

		const spec = (await context.helpers.httpRequestWithAuthentication.call(
			context,
			CREDENTIAL_TYPE,
			{
				method: 'GET',
				url: specUrl,
				json: true,
			},
		)) as OpenAPISpec;

		if (!spec.openapi || !spec.paths) {
			throw new NodeOperationError(context.getNode(), 'Invalid OpenAPI specification');
		}

		if (!spec.servers || spec.servers.length === 0) {
			throw new NodeOperationError(
				context.getNode(),
				'OpenAPI spec must define at least one server URL',
			);
		}

		const serverUrl = spec.servers[0].url.replace(/\/$/, '');

		for (const [path, pathItem] of Object.entries(spec.paths || {})) {
			const operation = pathItem.post;

			if (operation && !operation.deprecated) {
				const modelIdMatch = path.match(/\/models\/([^/]+)\/runs/);
				const modelId = modelIdMatch?.[1] || path;

				const operationUrl = `${serverUrl}${path}`;
				const blueprintName = operation.summary || modelId;

				returnData.push({
					name: blueprintName,
					value: `post::${path}::${operationUrl}::${editorBaseUrl}::${blueprintName}`,
					description: operation.description || undefined,
				});
			}
		}

		returnData.sort((a, b) => a.name.localeCompare(b.name));

		return returnData;
	} catch (error) {
		if (error instanceof NodeOperationError) throw error;
		const err = error as Error & { statusCode?: number };

		if (err.message?.includes('Invalid API key')) {
			throw new NodeOperationError(
				context.getNode(),
				'Invalid API key. Please check your credentials.',
			);
		}

		if (err.statusCode === 401 || err.statusCode === 403) {
			throw new NodeOperationError(
				context.getNode(),
				'Invalid API key. Please check your credentials.',
			);
		}

		throw new NodeOperationError(
			context.getNode(),
			`Failed to load blueprints: ${err.message}`,
		);
	}
}

/**
 * Build Zod schema fields from an OpenAPI request body schema
 */
export function buildZodSchemaFromOperation(
	operation: Operation,
	spec: OpenAPISpec,
): Record<string, ZodTypeAny> {
	const zodShape: Record<string, ZodTypeAny> = {};
	const jsonContent = operation.requestBody?.content?.['application/json'];

	if (!jsonContent?.schema) {
		return zodShape;
	}

	const schema = resolveSchema(jsonContent.schema, spec);
	const properties = schema.properties || {};
	const required = schema.required || [];

	for (const [fieldName, fieldSchema] of Object.entries(properties)) {
		zodShape[fieldName] = openApiToZod(fieldSchema, spec, required.includes(fieldName));
	}

	return zodShape;
}

/**
 * Build a human-readable parameter summary from an OpenAPI operation's request body.
 * Used in tool descriptions to help the LLM understand what each tool expects.
 */
export function describeOperationParams(
	operation: Operation,
	spec: OpenAPISpec,
): string {
	const jsonContent = operation.requestBody?.content?.['application/json'];
	if (!jsonContent?.schema) return '';

	const schema = resolveSchema(jsonContent.schema, spec);
	const properties = schema.properties || {};
	const required = schema.required || [];

	if (Object.keys(properties).length === 0) return '';

	const lines: string[] = [];
	for (const [name, propSchema] of Object.entries(properties)) {
		const resolved = resolveSchema(propSchema, spec);
		const isRequired = required.includes(name);
		const type = resolved.type || 'string';
		const parts: string[] = [`${name} (${type}, ${isRequired ? 'required' : 'optional'})`];

		if (resolved.description) {
			parts.push(`: ${resolved.description}`);
		}

		if (resolved.enum && resolved.enum.length > 0) {
			parts.push(` [${resolved.enum.join(', ')}]`);
		}

		lines.push(parts.join(''));
	}

	return 'Parameters:\n' + lines.map((l) => `  - ${l}`).join('\n');
}
