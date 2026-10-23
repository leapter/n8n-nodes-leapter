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
  IHttpRequestOptions,
  IDataObject,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';
import { answerOf, assertHttps, clusterError, clusterUrlOf, readRunBase } from './cluster';

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
 * Answer of GET /runtime-management/environments
 */
interface EnvironmentsAnswer {
  environments: Array<{ slug: string }>;
}

/**
 * Answer of GET /runtime-management/environments/{env}/status
 */
interface StatusAnswer {
  environments: Array<{
    applications: Array<{
      slug: string;
      callable: Array<{ id: string; name: string; slug: string }>;
    }>;
  }>;
}

/**
 * Credential type name for Leapter API Key
 */
const CREDENTIAL_TYPE = 'leapterApi';

/**
 * How long and how often a run is resent while the project's key or deploy activates
 */
const RETRY_WINDOW_MS = 90_000;
const RETRY_INTERVAL_MS = 3_000;

export class Leapter implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Leapter',
    name: 'leapter',
    icon: 'file:leapter.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["project"]?.split("::")[1] || ""}}',
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
      // 1. Project Dropdown (deployed projects with public blueprints, in every environment the
      // service key reaches)
      {
        displayName: 'Project Name or ID',
        name: 'project',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getProjects',
          loadOptionsDependsOn: [],
        },
        default: '',
        required: true,
        noDataExpression: true,
        description: 'The Leapter project containing your blueprints. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },

      // 2. Blueprint Dropdown (the project's public blueprints, depends on project)
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
       * Lists the deployed projects with public blueprints in every environment the service key
       * reaches
       */
      async getProjects(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        try {
          const clusterUrl = await clusterUrlOf(this);
          const answer = (await this.helpers.httpRequestWithAuthentication.call(
            this,
            CREDENTIAL_TYPE,
            {
              method: 'GET',
              url: `${clusterUrl}/runtime-management/environments`,
              json: true,
              disableFollowRedirect: true,
            },
          )) as EnvironmentsAnswer;
          const environments = (answer.environments ?? []).map((environment) => environment.slug);

          const options: INodePropertyOptions[] = [];
          for (const environment of environments) {
            for (const application of await getApplications(this, environment)) {
              if (!application.callable?.length) continue;
              // Value format: environment::application; the environment is named only when the
              // key reaches more than one
              options.push({
                name:
                  environments.length === 1
                    ? application.slug
                    : `${environment} · ${application.slug}`,
                value: `${environment}::${application.slug}`,
              });
            }
          }
          return options.sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
          throw clusterError(this, error, 'Failed to load projects');
        }
      },

      /**
       * Lists the selected project's public blueprints
       */
      async getOperations(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const projectValue = this.getNodeParameter('project') as string;

        if (!projectValue) {
          return [];
        }

        try {
          const [environment, application] = projectValue.split('::');
          const applications = await getApplications(this, environment);
          const callable =
            applications.find((entry) => entry.slug === application)?.callable ?? [];

          // Value: the blueprint id the engine addresses runs by
          return callable
            .map((blueprint) => ({ name: blueprint.name, value: blueprint.id }))
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
          throw clusterError(this, error, 'Failed to load blueprints');
        }
      },
    },

    resourceMapping: {
      /**
       * Generates input fields for the selected blueprint from the engine's OpenAPI document
       */
      async getOperationFields(
        this: ILoadOptionsFunctions,
      ): Promise<ResourceMapperFields> {
        const fields: ResourceMapperField[] = [];
        const projectValue = this.getNodeParameter('project') as string;
        const blueprintId = this.getNodeParameter('operation') as string;

        if (!projectValue || !blueprintId) {
          return { fields };
        }

        const [environment, application] = projectValue.split('::');
        const spec = await getOpenApiSpec(this, environment, application);
        if (spec === null) {
          // n8n shows this notice; it does not show errors thrown here
          return {
            fields,
            emptyFieldsNotice: `Access to ${application} is being activated, which takes up to a minute. Click Retry in a moment.`,
          };
        }

        try {
          const path = `/models/${blueprintId}/runs`;
          const operationDef = spec.paths?.[path]?.post;
          if (!operationDef) {
            throw new NodeOperationError(
              this.getNode(),
              `Path ${path} not found in spec`,
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

          if (fields.length === 0) {
            // A run of such a blueprint sends {} as its body
            return { fields, emptyFieldsNotice: 'This blueprint takes no inputs. Run it as it is.' };
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

    // The address the cluster answers runs on, once per execution
    const runBase = await readRunBase(this, await clusterUrlOf(this));
    assertHttps(this, runBase);

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        // Saved values: project = environment::application, operation = blueprint id
        const [environment, application] = (
          this.getNodeParameter('project', itemIndex) as string
        ).split('::');
        const blueprintId = this.getNodeParameter('operation', itemIndex) as string;
        const inputMode = this.getNodeParameter('inputMode', itemIndex) as string;
        const options = this.getNodeParameter('options', itemIndex, {}) as {
          timeout?: number;
        };

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

        // The credential adds the project's evaluation key. HTTP errors must throw: n8n
        // re-runs the credential's preAuthentication only when a request throws a 401.
        const requestOptions: IHttpRequestOptions = {
          method: 'POST',
          url: `${runBase}/runtime/api/v1/${environment}/${application}/models/${blueprintId}/runs`,
          headers: {
            'X-Correlation-Id': executionId || '',
            'Content-Type': 'application/json',
          },
          body: bodyParams,
          json: true,
          returnFullResponse: true,
          disableFollowRedirect: true,
        };

        // Add timeout option
        if (options.timeout) {
          requestOptions.timeout = options.timeout;
        }

        // A new key answers 401 and a new deploy 404 for up to a minute; n8n itself retries
        // only once, immediately
        const firstAttempt = Date.now();
        let response: { body: unknown; headers: Record<string, string> };
        for (;;) {
          try {
            response = await this.helpers.httpRequestWithAuthentication.call(
              this,
              CREDENTIAL_TYPE,
              requestOptions,
            );
            break;
          } catch (error) {
            const httpCode = (error as { httpCode?: string | null }).httpCode;
            const activating = httpCode === '401' || httpCode === '404';
            if (!activating || Date.now() - firstAttempt >= RETRY_WINDOW_MS) {
              throw new NodeApiError(this.getNode(), error as JsonObject);
            }
            await sleep(RETRY_INTERVAL_MS);
          }
        }

        const responseBody = (
          typeof response.body === 'string' ? JSON.parse(response.body) : response.body ?? {}
        ) as IDataObject;

        // Extract runId from response header
        const runId = response.headers['x-run-id'] || response.headers['X-Run-Id'];

        // Return output data with metadata
        returnData.push({
          json: {
            ...responseBody,
            _metadata: {
              runId,
            },
          },
          pairedItem: { item: itemIndex },
        });
      } catch (error) {
        const nodeError = clusterError(this, error, 'Blueprint execution failed', itemIndex);

        if (this.continueOnFail()) {
          const answer = answerOf(error);
          const responseBody =
            typeof answer?.body === 'object' && answer.body !== null
              ? (answer.body as IDataObject)
              : {};
          returnData.push({
            json: answer
              ? { error: nodeError.message, statusCode: answer.status, ...responseBody }
              : { error: nodeError.message },
            pairedItem: { item: itemIndex },
          });
          continue;
        }

        throw nodeError;
      }
    }

    return [returnData];
  }
}

/**
 * The environment's applications from GET {clusterUrl}/runtime-management/environments/{env}/status
 */
async function getApplications(
  ctx: ILoadOptionsFunctions,
  environment: string,
): Promise<StatusAnswer['environments'][number]['applications']> {
  const clusterUrl = await clusterUrlOf(ctx);
  const answer = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, {
    method: 'GET',
    url: `${clusterUrl}/runtime-management/environments/${environment}/status`,
    json: true,
    disableFollowRedirect: true,
  })) as StatusAnswer;

  return answer.environments?.[0]?.applications ?? [];
}

/**
 * The project's OpenAPI document from the engine, or null while access is being activated
 * (401 or 404). This request gets the project's evaluation key from the credential; the first
 * 401 makes the credential create it, so the key exists before the workflow first runs.
 */
async function getOpenApiSpec(
  ctx: ILoadOptionsFunctions,
  environment: string,
  application: string,
): Promise<OpenAPISpec | null> {
  const runBase = await readRunBase(ctx, await clusterUrlOf(ctx));
  assertHttps(ctx, runBase);

  try {
    return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, {
      method: 'GET',
      url: `${runBase}/runtime/api/v1/${environment}/${application}/openapi`,
      json: true,
      disableFollowRedirect: true,
    })) as OpenAPISpec;
  } catch (error) {
    const httpCode = (error as { httpCode?: string | null }).httpCode;
    if (httpCode === '401' || httpCode === '404') {
      return null;
    }
    throw clusterError(ctx, error, 'Failed to load the blueprint fields');
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
