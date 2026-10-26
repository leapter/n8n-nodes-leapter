import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodeListSearchItems,
  INodeListSearchResult,
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
import {
  answerOf,
  assertHttps,
  clusterError,
  clusterUrlOf,
  provisionKey,
  readRunBase,
} from './cluster';
import { newestLoad } from './newest-load';

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
 * While a project's new key or deploy activates (401 or 404, up to a minute), the field list and
 * a run ask again every 10 s, at most 6 times after the first request: 7 requests over 60 s
 */
const RETRY_INTERVAL_MS = 10_000;
const MAX_RETRIES = 6;

/**
 * Id of the hidden placeholder field of a blueprint without inputs; never sent
 */
const NO_INPUTS_FIELD = '__leapter_no_inputs';

function isActivating(error: unknown): boolean {
  const httpCode = (error as { httpCode?: string | null }).httpCode;
  return httpCode === '401' || httpCode === '404';
}

export class Leapter implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Leapter',
    name: 'leapter',
    // The dark variant brightens the gradient for dark backgrounds
    icon: { light: 'file:leapter.svg', dark: 'file:leapter.dark.svg' },
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
      // 1. Project (deployed projects with public blueprints, in every environment the service key
      // reaches). A resource locator, not a dropdown: n8n since 2.x asks a dropdown for its options
      // when the panel opens, on a node's first opening before it has assigned the credential, and
      // then never again. A resource locator asks when the list is opened, and again after a failure.
      {
        displayName: 'Project',
        name: 'project',
        type: 'resourceLocator',
        default: { mode: 'list', value: '' },
        required: true,
        description: 'The Leapter project containing your blueprints',
        modes: [
          {
            displayName: 'From List',
            name: 'list',
            type: 'list',
            typeOptions: {
              searchListMethod: 'searchProjects',
              searchable: true,
            },
          },
        ],
      },

      // 2. Blueprint Dropdown (the project's public blueprints, depends on project)
      {
        displayName: 'Blueprint Name or ID',
        name: 'operation',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getOperations',
          // The resource locator's value: n8n compares dependencies as strings
          loadOptionsDependsOn: ['project.value'],
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

      // 4. Activation notice: shown while a blueprint is chosen and its fields are not loaded yet.
      // n8n cannot show emptyFieldsNotice during a load, so this static notice explains the wait
      // and hides itself once the resource mapper's schema has entries. Paths into a parameter
      // start with `/` (from the node's root): n8n before 2.40 cannot order a dependency named
      // `parameters.schema` and fails every run with "Could not resolve parameter dependencies".
      {
        displayName:
          'On first use, Leapter activates access to this project. This can take up to a minute; the fields load automatically.',
        name: 'activationNotice',
        type: 'notice',
        default: '',
        displayOptions: {
          show: {
            project: [{ _cnd: { exists: true } }],
            operation: [{ _cnd: { exists: true } }],
            inputMode: ['visual'],
          },
          hide: {
            '/parameters.schema': [{ _cnd: { exists: true } }],
          },
        },
      },

      // 4a. A blueprint without inputs: its schema holds only the hidden placeholder field
      // (n8n shows emptyFieldsNotice only for an empty schema, so this notice says it instead)
      {
        displayName: 'This blueprint takes no inputs. Run it as it is.',
        name: 'noInputsNotice',
        type: 'notice',
        default: '',
        displayOptions: {
          show: {
            inputMode: ['visual'],
            '/parameters.schema[0].id': [NO_INPUTS_FIELD],
          },
        },
      },

      // 4b. Visual Parameter Mapping (resourceMapper)
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
          loadOptionsDependsOn: ['project.value', 'operation'],
          resourceMapper: {
            resourceMapperMethod: 'getOperationFields',
            mode: 'add',
            fieldWords: {
              singular: 'parameter',
              plural: 'parameters',
            },
            addAllFields: true,
            multiKeyMatch: false,
            // Replaces n8n's "No parameters found in Leapter"; the node's notice says why
            noFieldsError: 'No input fields to show.',
          },
        },
        // Only once a blueprint is chosen: without one n8n would show "No input fields to show"
        displayOptions: {
          show: {
            inputMode: ['visual'],
            operation: [{ _cnd: { exists: true } }],
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
    listSearch: {
      /**
       * Lists the deployed projects with public blueprints in every environment the service key
       * reaches
       */
      async searchProjects(
        this: ILoadOptionsFunctions,
        filter?: string,
      ): Promise<INodeListSearchResult> {
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

          const results: INodeListSearchItems[] = [];
          for (const environment of environments) {
            for (const application of await getApplications(this, environment)) {
              if (!application.callable?.length) continue;
              // Value format: environment::application; the environment is named only when the
              // key reaches more than one
              results.push({
                name:
                  environments.length === 1
                    ? application.slug
                    : `${environment} · ${application.slug}`,
                value: `${environment}::${application.slug}`,
              });
            }
          }
          const needle = filter?.trim().toLowerCase();
          return {
            results: results
              .filter((result) => !needle || result.name.toLowerCase().includes(needle))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        } catch (error) {
          throw clusterError(this, error, 'Failed to load projects');
        }
      },
    },

    loadOptions: {
      /**
       * Lists the selected project's public blueprints
       */
      async getOperations(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const projectValue = projectOf(this);

        if (!projectValue) {
          return [];
        }

        try {
          const [environment, application] = projectValue.split('::');
          // Pre-warm: one engine request now, so a missing key is created while the user still
          // picks the blueprint. Not awaited; its result is ignored.
          void prewarm(this, environment, application);
          // Value: the blueprint id the engine addresses runs by
          return (await callableBlueprints(this, environment, application))
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
        const projectValue = projectOf(this);
        const blueprintId = this.getNodeParameter('operation') as string;
        const [environment, application] = projectValue.split('::');

        // Every request takes part, an empty one too: it is the newest selection
        return await newestLoad(fieldLoadCaller(this), async (superseded) => {
          if (!projectValue || !blueprintId) {
            return { fields: [] };
          }

          // After a project switch n8n keeps the old blueprint and asks with it once; answer at
          // once instead of waiting for a document that cannot have its path
          let callable: Awaited<ReturnType<typeof callableBlueprints>>;
          try {
            callable = await callableBlueprints(this, environment, application);
          } catch (error) {
            throw clusterError(this, error, 'Failed to load the blueprint fields');
          }
          if (!callable.some((blueprint) => blueprint.id === blueprintId)) {
            return { fields: [] };
          }

          const spec = await getOpenApiSpec(this, environment, application, superseded);
          if (spec === null) {
            // n8n shows this notice; it does not show errors thrown here
            return {
              fields: [],
              // Below the activation notice, so it says only what changed: the automatic wait ended
              emptyFieldsNotice: `Access to ${application} is still not active after a minute. Click Retry to try again.`,
            };
          }

          return operationFields(this, spec, blueprintId);
        });
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // Get n8n execution ID for correlation (used for server-side logging)
    const executionId = this.getExecutionId();

    // The address the cluster answers runs on, once per execution
    const runBase = await readRunBase(this, await clusterUrlOf(this));
    assertHttps(this, runBase);

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        // Saved values: project = environment::application, operation = blueprint id. Checked
        // per item: an expression may give each item its own project.
        const project = splitProject(
          this.getNodeParameter('project', itemIndex, '', { extractValue: true }),
        );
        if (!project) {
          throw new NodeOperationError(
            this.getNode(),
            'No project selected. Pick one from the list.',
            { itemIndex },
          );
        }
        const [environment, application] = project;
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
            // Only blueprint inputs: never the no-inputs placeholder
            if (key.startsWith('body.') && key !== NO_INPUTS_FIELD) {
              const paramName = key.replace('body.', '');
              // Try to parse JSON strings (for arrays and objects)
              const parsedValue = tryParseJson(value);
              bodyParams[paramName] = parsedValue as IDataObject[keyof IDataObject];
            }
          }
        } else {
          // JSON mode: text, or an object when an expression gives one (e.g. an AI Agent's
          // $fromAI(…, 'json'))
          const parametersJson = this.getNodeParameter('parametersJson', itemIndex, '{}') as
            | string
            | IDataObject;
          bodyParams = parseJsonInput(this, parametersJson, itemIndex);
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
        for (let retries = 0; ; retries++) {
          try {
            await provisionKey(this, runBase, environment, application);
            response = await this.helpers.httpRequestWithAuthentication.call(
              this,
              CREDENTIAL_TYPE,
              requestOptions,
            );
            if (retries > 0) {
              const waited = Math.round((Date.now() - firstAttempt) / 1000);
              this.addExecutionHints({
                message: `Access to ${application} was activated; this run waited ${waited} s.`,
                type: 'info',
                location: 'outputPane',
              });
            }
            break;
          } catch (error) {
            if (!isActivating(error) || retries >= MAX_RETRIES) {
              throw new NodeApiError(this.getNode(), error as JsonObject);
            }
            // A 404 is also a blueprint that is no longer deployed or public; waiting cannot
            // help then. Asked once per item; when the cluster cannot say, keep waiting.
            if (retries === 0 && answerOf(error)?.status === 404) {
              const callable = await callableBlueprints(this, environment, application).catch(
                () => undefined,
              );
              if (callable && !callable.some((blueprint) => blueprint.id === blueprintId)) {
                throw new NodeOperationError(
                  this.getNode(),
                  `The blueprint ${blueprintId} is not a public blueprint of ${application} (any more). Pick the blueprint again.`,
                  { itemIndex },
                );
              }
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
 * The project's public blueprints, from the environment's status
 */
async function callableBlueprints(
  ctx: ILoadOptionsFunctions | IExecuteFunctions,
  environment: string,
  application: string,
): Promise<StatusAnswer['environments'][number]['applications'][number]['callable']> {
  const applications = await getApplications(ctx, environment);
  return applications.find((entry) => entry.slug === application)?.callable ?? [];
}

/**
 * The environment's applications from GET {clusterUrl}/runtime-management/environments/{env}/status
 */
async function getApplications(
  ctx: ILoadOptionsFunctions | IExecuteFunctions,
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
 * One engine request for the project through the credential, after provisionKey(): a missing key
 * is created while the user picks the blueprint
 */
async function prewarm(
  ctx: ILoadOptionsFunctions,
  environment: string,
  application: string,
): Promise<void> {
  try {
    const runBase = await readRunBase(ctx, await clusterUrlOf(ctx));
    assertHttps(ctx, runBase);
    await provisionKey(ctx, runBase, environment, application);
    await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, {
      method: 'GET',
      url: `${runBase}/runtime/api/v1/${environment}/${application}/openapi`,
      json: true,
      disableFollowRedirect: true,
    });
  } catch {
    // Ignored: the field list asks again and reports problems itself
  }
}

/**
 * The JSON input as an object: parsed from text, or taken as it is. Anything but a JSON object
 * fails with a message that says so.
 */
function parseJsonInput(
  ctx: IExecuteFunctions,
  value: string | IDataObject,
  itemIndex: number,
): IDataObject {
  let input: unknown = value;
  if (typeof value === 'string') {
    try {
      input = JSON.parse(value);
    } catch (error) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Parameters (JSON) is not valid JSON: ${(error as Error).message}`,
        { itemIndex },
      );
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NodeOperationError(ctx.getNode(), 'Parameters (JSON) must be a JSON object.', {
      itemIndex,
    });
  }
  return input as IDataObject;
}

/**
 * The selected project (`environment::application`) in a load-options call, '' when none
 */
function projectOf(ctx: ILoadOptionsFunctions): string {
  return splitProject(ctx.getNodeParameter('project', '', { extractValue: true }))?.join('::') ?? '';
}

/**
 * `environment::application` split in two, or undefined when either part is missing
 */
function splitProject(value: unknown): [string, string] | undefined {
  const [environment, application, rest] = String(value ?? '').split('::');
  return environment && application && rest === undefined ? [environment, application] : undefined;
}

/**
 * Whose field loads supersede each other: the credential's. n8n gives a loader no node, workflow
 * or user identity (it runs as "Temp-Node"), so two people sharing a credential and loading fields
 * in the same activation minute could get each other's answer; one person switching blueprints is
 * the case this is for.
 */
function fieldLoadCaller(ctx: ILoadOptionsFunctions): string | undefined {
  return ctx.getNode().credentials?.[CREDENTIAL_TYPE]?.id ?? undefined;
}

/**
 * The input fields of the blueprint's POST /models/{id}/runs request body
 */
function operationFields(
  ctx: ILoadOptionsFunctions,
  spec: OpenAPISpec,
  blueprintId: string,
): ResourceMapperFields {
  const fields: ResourceMapperField[] = [];
  try {
    const path = `/models/${blueprintId}/runs`;
    const operationDef = spec.paths?.[path]?.post;
    if (!operationDef) {
      throw new NodeOperationError(ctx.getNode(), `Path ${path} not found in spec`);
    }

    // Process Request Body (application/json)
    const jsonContent = operationDef.requestBody?.content?.['application/json'];
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
            defaultValue: itemType === 'string' ? '["value1", "value2"]' : '[1, 2, 3]',
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
  } catch (error) {
    const err = error as Error;
    throw new NodeOperationError(ctx.getNode(), `Failed to load operation fields: ${err.message}`);
  }

  if (fields.length === 0) {
    // One hidden placeholder, so the schema has an entry: the activation notice hides (n8n
    // ignores a hide rule on an empty list) and the no-inputs notice shows. execute() never
    // sends it: only `body.` fields go into the body, so a run of such a blueprint sends {}.
    return {
      fields: [
        {
          id: NO_INPUTS_FIELD,
          displayName: 'This blueprint takes no inputs',
          required: false,
          defaultMatch: false,
          display: false,
          type: 'string',
          canBeUsedToMatch: false,
        },
      ],
    };
  }
  return { fields };
}

/**
 * The project's OpenAPI document from the engine, or null when access is still being activated
 * (401 or 404) after the last retry, or when a newer field load superseded this one. This
 * request gets the project's evaluation key from the credential; its first refusal makes the
 * credential create the key, so the key exists before the workflow first runs.
 */
async function getOpenApiSpec(
  ctx: ILoadOptionsFunctions,
  environment: string,
  application: string,
  superseded: () => boolean,
): Promise<OpenAPISpec | null> {
  const runBase = await readRunBase(ctx, await clusterUrlOf(ctx));
  assertHttps(ctx, runBase);

  // The editor shows its loading state meanwhile; after the last retry the caller shows the
  // activation notice with n8n's Retry
  for (let retries = 0; ; retries++) {
    try {
      await provisionKey(ctx, runBase, environment, application);
      return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, {
        method: 'GET',
        url: `${runBase}/runtime/api/v1/${environment}/${application}/openapi`,
        json: true,
        disableFollowRedirect: true,
      })) as OpenAPISpec;
    } catch (error) {
      if (!isActivating(error)) {
        throw clusterError(ctx, error, 'Failed to load the blueprint fields');
      }
      if (retries >= MAX_RETRIES || superseded()) {
        return null;
      }
      await sleep(RETRY_INTERVAL_MS);
      if (superseded()) {
        return null;
      }
    }
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
