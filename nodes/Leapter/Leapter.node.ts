import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  ResourceMapperFields,
  ResourceMapperField,
  FieldType,
  IHttpRequestMethods,
  IDataObject,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

/**
 * OpenAPI 3.0 Specification types
 */
interface OpenAPISpec {
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

interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  delete?: Operation;
  patch?: Operation;
}

interface Operation {
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

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JSONSchema;
}

interface JSONSchema {
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
interface ProjectInfo {
  projectId: string;
  projectName: string;
  specUrl: string;
  editorBaseUrl: string;
}

/**
 * Response from /api/n8n/projects
 */
interface ProjectDiscoveryResponse {
  accountId: string;
  projects: ProjectInfo[];
}

/**
 * Credential type name for Leapter API Key
 */
const CREDENTIAL_TYPE = 'leapterApi';

export class Leapter implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Leapter',
    name: 'leapter',
    icon: 'file:leapter.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]?.split("::")[4] || ""}}',
    description: 'Execute Leapter blueprint operations dynamically',
    usableAsTool: true,
    defaults: {
      name: 'Leapter',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'leapterApi',
        required: true,
      },
    ],
    properties: [
      // 1. Project Dropdown (loaded from /api/n8n/projects)
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
        description: 'The Leapter project containing your blueprints. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },

      // 2. Blueprint Dropdown (dynamically loaded from OpenAPI spec, depends on project)
      {
        displayName: 'Blueprint Name or ID',
        name: 'operation',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getOperations',
          loadOptionsDependsOn: ['project'],
        },
        default: '',
        required: true,
        noDataExpression: true,
        description: 'The blueprint operation to execute. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },

      // 3. Input Mode Toggle
      {
        displayName: 'Input Mode',
        name: 'inputMode',
        type: 'options',
        options: [
          {
            name: 'Visual Mapping',
            value: 'visual',
            description: 'Use visual field mapping for parameters',
          },
          {
            name: 'JSON',
            value: 'json',
            description: 'Provide parameters as raw JSON',
          },
        ],
        default: 'visual',
        description: 'How to provide operation parameters',
      },

      // 4. Visual Parameter Mapping (resourceMapper)
      {
        displayName: 'Parameters',
        name: 'parameters',
        type: 'resourceMapper',
        noDataExpression: true,
        default: {
          mappingMode: 'defineBelow',
          value: null,
        },
        required: true,
        typeOptions: {
          loadOptionsDependsOn: ['project', 'operation'],
          resourceMapper: {
            resourceMapperMethod: 'getOperationFields',
            mode: 'add',
            fieldWords: {
              singular: 'parameter',
              plural: 'parameters',
            },
            addAllFields: true,
            multiKeyMatch: false,
          },
        },
        displayOptions: {
          show: {
            inputMode: ['visual'],
          },
        },
        description: 'Map input data to operation parameters',
      },

      // 5. JSON Input (fallback for complex schemas)
      {
        displayName: 'Parameters (JSON)',
        name: 'parametersJson',
        type: 'json',
        default: '{}',
        required: true,
        displayOptions: {
          show: {
            inputMode: ['json'],
          },
        },
        description:
          'Parameters in JSON format. See the OpenAPI spec for the expected schema.',
        hint: 'Use this for complex nested objects or advanced use cases',
      },

      // 6. Additional Options
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
		// usableAsTool: true, // Disabled: can cause node loading issues in dev mode
  };

  methods = {
    loadOptions: {
      /**
       * Fetches accessible projects from /api/n8n/projects
       */
      async getProjects(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        try {
          // Get credentials for server URL
          const credentials = await this.getCredentials(CREDENTIAL_TYPE);
          const labUrl = credentials.server as string;

          // Discover accessible projects using authenticated request
          const discoveryResponse = (await this.helpers.httpRequestWithAuthentication.call(
            this,
            CREDENTIAL_TYPE,
            {
              method: 'POST',
              url: `${labUrl}/api/v1/n8n/projects`,
              json: true,
            },
          )) as ProjectDiscoveryResponse;

          if (!discoveryResponse.projects || discoveryResponse.projects.length === 0) {
            throw new NodeOperationError(
              this.getNode(),
              'No projects found. Ensure your API key has access to at least one project.',
            );
          }

          // Map projects to dropdown options
          // Value format: projectId::specUrl::editorBaseUrl::projectName
          const options: INodePropertyOptions[] = discoveryResponse.projects.map(
            (project) => ({
              name: project.projectName,
              value: `${project.projectId}::${project.specUrl}::${project.editorBaseUrl}::${project.projectName}`,
              description: `Project ID: ${project.projectId}`,
            }),
          );

          options.sort((a, b) => a.name.localeCompare(b.name));

          return options;
        } catch (error) {
          const err = error as Error & { statusCode?: number };

          if (err.statusCode === 401 || err.statusCode === 403) {
            throw new NodeOperationError(
              this.getNode(),
              'Invalid API key or no project access. Please check your credentials.',
            );
          }

          throw new NodeOperationError(
            this.getNode(),
            `Failed to load projects: ${err.message}`,
          );
        }
      },

      /**
       * Fetches OpenAPI spec for selected project and returns all operations
       */
      async getOperations(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const returnData: INodePropertyOptions[] = [];
        const projectValue = this.getNodeParameter('project') as string;

        if (!projectValue) {
          return returnData;
        }

        try {
          // Parse project value: projectId::specUrl::editorBaseUrl::projectName
          const [, specUrl, editorBaseUrl] = projectValue.split('::');

          // Fetch OpenAPI spec using authenticated request
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
            throw new NodeOperationError(
              this.getNode(),
              'Invalid OpenAPI specification',
            );
          }

          // Validate that spec has servers defined
          if (!spec.servers || spec.servers.length === 0) {
            throw new NodeOperationError(
              this.getNode(),
              'OpenAPI spec must define at least one server URL',
            );
          }

          // Get server URL from spec (remove trailing slash to avoid double slashes)
          const serverUrl = spec.servers[0].url.replace(/\/$/, '');

          // Parse operations from spec - Leapter only uses POST for runs
          for (const [path, pathItem] of Object.entries(spec.paths || {})) {
            const operation = pathItem.post;

            if (operation && !operation.deprecated) {
              // Extract model ID from path (e.g., /models/requirement-doc/runs -> requirement-doc)
              const modelIdMatch = path.match(/\/models\/([^/]+)\/runs/);
              const modelId = modelIdMatch?.[1] || path;

              // Build the full operation URL from server + path
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
          const err = error as Error & { statusCode?: number };

          if (err.message?.includes('Invalid API key')) {
            throw new NodeOperationError(
              this.getNode(),
              'Invalid API key. Please check your credentials.',
            );
          }

          if (err.statusCode === 401 || err.statusCode === 403) {
            throw new NodeOperationError(
              this.getNode(),
              'Invalid API key. Please check your credentials.',
            );
          }

          throw new NodeOperationError(
            this.getNode(),
            `Failed to load blueprints: ${err.message}`,
          );
        }
      },
    },

    resourceMapping: {
      /**
       * Generates input fields for the selected operation
       */
      async getOperationFields(
        this: ILoadOptionsFunctions,
      ): Promise<ResourceMapperFields> {
        const fields: ResourceMapperField[] = [];
        const projectValue = this.getNodeParameter('project') as string;
        const operationValue = this.getNodeParameter('operation') as string;

        if (!projectValue || !operationValue) {
          return { fields };
        }

        try {
          // Parse project value: projectId::specUrl::editorBaseUrl::projectName
          const [, specUrl] = projectValue.split('::');
          // Parse operation value: method::path::operationUrl::editorBaseUrl::blueprintName
          const [method, path] = operationValue.split('::');

          // Fetch OpenAPI spec using authenticated request
          const spec = (await this.helpers.httpRequestWithAuthentication.call(
            this,
            CREDENTIAL_TYPE,
            {
              method: 'GET',
              url: specUrl,
              json: true,
            },
          )) as OpenAPISpec;

          const pathItem = spec.paths[path];
          if (!pathItem) {
            throw new NodeOperationError(
              this.getNode(),
              `Path ${path} not found in spec`,
            );
          }

          const operationDef = pathItem[method as keyof PathItem];
          if (!operationDef) {
            throw new NodeOperationError(
              this.getNode(),
              `Operation ${method} ${path} not found in spec`,
            );
          }

          // Process Request Body (application/json)
          if (operationDef.requestBody) {
            const jsonContent =
              operationDef.requestBody.content?.['application/json'];

            if (jsonContent?.schema) {
              const schema = resolveSchema(jsonContent.schema, spec);
              const properties = schema.properties || {};
              const required = schema.required || [];

              for (const [fieldName, fieldSchema] of Object.entries(properties)) {
                const resolvedField = resolveSchema(fieldSchema, spec);
                const fieldDisplayName = resolvedField.description
                  ? `${fieldName} - ${resolvedField.description}`
                  : fieldName;

                // Handle enum types
                if (resolvedField.enum) {
                  fields.push({
                    id: `body.${fieldName}`,
                    displayName: fieldDisplayName,
                    required: required.includes(fieldName),
                    defaultMatch: false,
                    display: true,
                    type: 'options',
                    options: resolvedField.enum.map((value) => ({
                      name: value,
                      value: value,
                    })),
                    canBeUsedToMatch: false,
                  });
                } else if (resolvedField.type === 'array') {
                  // Array fields - show hint about JSON format
                  const itemType = resolvedField.items?.type || 'string';
                  fields.push({
                    id: `body.${fieldName}`,
                    displayName: `${fieldDisplayName} (JSON array)`,
                    required: required.includes(fieldName),
                    defaultMatch: false,
                    display: true,
                    type: 'string',
                    canBeUsedToMatch: false,
                    defaultValue:
                      itemType === 'string' ? '["value1", "value2"]' : '[1, 2, 3]',
                  });
                } else {
                  fields.push({
                    id: `body.${fieldName}`,
                    displayName: fieldDisplayName,
                    required: required.includes(fieldName),
                    defaultMatch: false,
                    display: true,
                    type: mapOpenApiType(resolvedField.type),
                    canBeUsedToMatch: false,
                  });
                }
              }
            }
          }

          return { fields };
        } catch (error) {
          const err = error as Error;
          throw new NodeOperationError(
            this.getNode(),
            `Failed to load operation fields: ${err.message}`,
          );
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // Get n8n execution ID for correlation (used for server-side logging)
    const executionId = this.getExecutionId();

    // Get selected project (same for all items)
    const projectValue = this.getNodeParameter('project', 0) as string;

    if (!projectValue) {
      throw new NodeOperationError(
        this.getNode(),
        'No project selected. Please select a project first.',
      );
    }

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const operation = this.getNodeParameter('operation', itemIndex) as string;
        const inputMode = this.getNodeParameter('inputMode', itemIndex) as string;
        const options = this.getNodeParameter('options', itemIndex, {}) as {
          timeout?: number;
        };

        // Parse operation: method::path::operationUrl::editorBaseUrl::blueprintName
        const [method, path, operationUrl, editorBaseUrl] = operation.split('::');

        // Extract model ID from path for editor link
        const modelIdMatch = path.match(/\/models\/([^/]+)\/runs/);
        const modelId = modelIdMatch?.[1];

        // Get parameters
        let bodyParams: IDataObject = {};

        if (inputMode === 'visual') {
          const parameters = this.getNodeParameter('parameters', itemIndex, {}) as {
            value?: Record<string, unknown>;
          };
          const paramValues = parameters.value || {};

          for (const [key, value] of Object.entries(paramValues)) {
            if (key.startsWith('body.')) {
              const paramName = key.replace('body.', '');
              // Try to parse JSON strings (for arrays and objects)
              const parsedValue = tryParseJson(value);
              bodyParams[paramName] = parsedValue as IDataObject[keyof IDataObject];
            }
          }
        } else {
          // JSON mode
          const parametersJson = this.getNodeParameter(
            'parametersJson',
            itemIndex,
            '{}',
          ) as string;
          bodyParams = JSON.parse(parametersJson) as IDataObject;
        }

        // Build request options (X-API-Key added automatically by credential authenticate)
        const requestOptions: {
          method: IHttpRequestMethods;
          url: string;
          headers: Record<string, string>;
          body: IDataObject;
          json: boolean;
          timeout?: number;
          returnFullResponse: boolean;
          ignoreHttpStatusErrors: boolean;
        } = {
          method: method.toUpperCase() as IHttpRequestMethods,
          url: operationUrl,
          headers: {
            'X-Correlation-Id': executionId || '',
            'Content-Type': 'application/json',
          },
          body: bodyParams,
          json: true,
          returnFullResponse: true,
          ignoreHttpStatusErrors: true, // Don't throw on non-2xx status
        };

        // Add timeout option
        if (options.timeout) {
          requestOptions.timeout = options.timeout;
        }

        // Execute request using authenticated helper
        const response = await this.helpers.httpRequestWithAuthentication.call(
          this,
          CREDENTIAL_TYPE,
          requestOptions,
        );

        // Handle response based on type
        let responseBody: IDataObject;
        let responseHeaders: Record<string, string> = {};
        let statusCode = 200;

        if (typeof response === 'object' && response !== null) {
          if ('body' in response && 'headers' in response) {
            // Full response object
            responseBody =
              typeof response.body === 'string'
                ? JSON.parse(response.body)
                : response.body;
            responseHeaders = response.headers as Record<string, string>;
            statusCode = (response.statusCode as number) || 200;
          } else {
            // Direct response
            responseBody = response as IDataObject;
          }
        } else if (typeof response === 'string') {
          responseBody = JSON.parse(response);
        } else {
          responseBody = {};
        }

        // Check for error status
        if (statusCode >= 400) {
          const errorMessage =
            (responseBody.detail as string) ||
            (responseBody.error as string) ||
            (responseBody.message as string) ||
            `Request failed with status ${statusCode}`;

          if (this.continueOnFail()) {
            returnData.push({
              json: {
                error: errorMessage,
                statusCode,
                ...responseBody,
              },
              pairedItem: { item: itemIndex },
            });
            continue;
          }

          throw new NodeOperationError(this.getNode(), errorMessage, {
            itemIndex,
          });
        }

        // Extract runId from response header
        const runId = responseHeaders['x-run-id'] || responseHeaders['X-Run-Id'];

        // Build editor link from stored editorBaseUrl and modelId
        const editorLink = modelId
          ? `${editorBaseUrl}/${modelId}`
          : editorBaseUrl;

        // Return output data with metadata
        returnData.push({
          json: {
            ...responseBody,
            _metadata: {
              runId,
              editorLink,
            },
          },
          pairedItem: { item: itemIndex },
        });
      } catch (error) {
        const err = error as Error;

        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: err.message,
            },
            pairedItem: { item: itemIndex },
          });
          continue;
        }

        throw new NodeOperationError(
          this.getNode(),
          `Blueprint execution failed: ${err.message}`,
          { itemIndex },
        );
      }
    }

    return [returnData];
  }
}

/**
 * Map OpenAPI types to n8n field types
 */
function mapOpenApiType(openApiType: string | undefined): FieldType {
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
 * Resolve $ref references in JSON Schema
 */
function resolveSchema(schema: JSONSchema, spec: OpenAPISpec): JSONSchema {
  if (schema.$ref) {
    // Parse $ref like "#/components/schemas/MySchema"
    const refPath = schema.$ref.replace('#/', '').split('/');
    let resolved: unknown = spec;

    for (const part of refPath) {
      resolved = (resolved as Record<string, unknown>)[part];
    }

    return resolved as JSONSchema;
  }

  return schema;
}

/**
 * Try to parse a value as JSON if it's a string that looks like JSON array/object
 * Returns the parsed value or the original value if parsing fails
 */
function tryParseJson(value: unknown): unknown {
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
