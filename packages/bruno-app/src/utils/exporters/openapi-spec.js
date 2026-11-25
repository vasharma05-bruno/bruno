import jsyaml from 'js-yaml';
import { each, filter } from 'lodash';
import { interpolate } from '@usebruno/common';
import { parseQueryParams } from '@usebruno/common/utils';
import { isValidUrl, splitOnFirst } from 'utils/url/index';
const xml2js = require('xml2js');

const OPENAPI_VERSION = '3.0.0';
const DEFAULT_SPEC_VERSION = '1.0.0';
const SUPPORTED_ITEM_TYPES = ['http-request', 'graphql-request'];
const BASE_URL_VARIABLE = 'baseUrl';
const BASE_URL_PLACEHOLDER = `{{${BASE_URL_VARIABLE}}}`;
const COLLECTION_SERVER_DESCRIPTION = 'Base Server';

const placeholderRegex = /\{\{([^}]+)\}\}/g;
const reservedVariableNameRegex = /^(\$secrets|process|\$oauth2)(\.|$)/;

// Blank out {{...}} placeholders, so characters inside them (like the ? of a prompt variable) aren't read as url syntax
const maskPlaceholders = (value) => value.replace(placeholderRegex, (placeholder) => '_'.repeat(placeholder.length));

// Query params of a raw url as { name, value } pairs, first occurrence of each name
const getUrlQueryParams = (url) => {
  const [, query] = splitOnFirst(url, '?');
  const seen = new Set();
  return parseQueryParams(query)
    .map(({ name, value }) => ({ name, value: value ?? '' }))
    .filter(({ name }) => !seen.has(name) && seen.add(name));
};

// Split a url into server and path as text when the URL parser can't be used: the address (scheme, host or port) has a
// placeholder in it, or the url has no scheme. Placeholders stay whole and keep their spelling.
const splitAddressAsText = (url) => {
  const masked = maskPlaceholders(url);
  if (!masked || masked.startsWith('/')) return null;

  const [scheme = ''] = masked.match(/^[^/?#]*?:\/\//) || [];
  const addressLength = masked.slice(scheme.length).search(/[/?#]/);
  const addressEnd = addressLength === -1 ? masked.length : scheme.length + addressLength;
  if (scheme && !url.slice(0, addressEnd).includes('{{')) return null;

  const credentialsEnd = masked.lastIndexOf('@', addressEnd - 1);
  const hostStart = credentialsEnd >= scheme.length ? credentialsEnd + 1 : scheme.length;
  const host = url.slice(hostStart, addressEnd);
  if (!host) return null;

  const rest = url.slice(addressEnd);
  return { server: url.slice(0, scheme.length) + host, path: rest.startsWith('/') ? rest : `/${rest}` };
};

// Turn a Bruno path into an OpenAPI path template: {{name}} placeholders and :name segments become {name}
const toTemplatePath = (path) => {
  const masked = maskPlaceholders(path);
  const segmentParamNames = [];
  let templatePath = '';
  let copiedUpTo = 0;
  for (const match of masked.matchAll(/(^|\/):([^/]+)/g)) {
    const nameStart = match.index + match[1].length + 1;
    const name = path.slice(nameStart, nameStart + match[2].length);
    if (name.includes('{{')) continue;
    templatePath += `${path.slice(copiedUpTo, nameStart - 1)}{${name}}`;
    segmentParamNames.push(name);
    copiedUpTo = nameStart + name.length;
  }
  templatePath += path.slice(copiedUpTo);
  return { templatePath: templatePath.replace(placeholderRegex, '{$1}'), segmentParamNames };
};

const hasValue = (value) => value !== undefined && value !== null && value !== '';

// Secret handling. A secret's value is never written into the spec; where the spec needs the variable,
// it keeps its {{name}} placeholder. Which secret names apply depends on the part of the spec being built.

export const getSecretVariableNames = (environments) => {
  const secretNames = new Set();
  each(environments, (environment) => {
    each(environment.variables, (variable) => {
      if (variable.enabled && variable.secret) secretNames.add(variable.name);
    });
  });
  return secretNames;
};

// Reserved names ($secrets.*, process.*, $oauth2.*) are filled in by Bruno at runtime, so they count as secret too
export const isVariableSecret = (secretNames, varName) => secretNames.has(varName) || reservedVariableNameRegex.test(varName);

export const omitSecretVariables = (variables, secretNames) => {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => !secretNames.has(name)));
};

export const omitSecretAndReservedVariables = (variables, secretNames) => {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => !isVariableSecret(secretNames, name)));
};

export const getEnabledVariables = (variables) => {
  const enabledVariables = {};
  each(variables, (variable) => {
    if (variable.name && variable.enabled) enabledVariables[variable.name] = variable.value;
  });
  return enabledVariables;
};

export const getEnvironmentVariablesKeyValuePairs = (envVariables) => {
  return getEnabledVariables(filter(envVariables, (variable) => !variable.secret && hasValue(variable.value)));
};

// An enabled secret wins at runtime over a collection or plain environment variable of the same name,
// so keep its placeholder
export const buildSpecVariables = (collectionVariables, envVariables, selectedEnvironment) => {
  const environmentVariables = selectedEnvironment ? envVariables?.[selectedEnvironment] || {} : {};
  const secretNames = getSecretVariableNames([{ variables: environmentVariables }]);
  return omitSecretVariables({ ...collectionVariables, ...getEnvironmentVariablesKeyValuePairs(environmentVariables) }, secretNames);
};

export const addWarning = (warnings, message, itemName) => {
  warnings.push({
    message,
    itemName
  });
};

// Build an OpenAPI server entry from a URL (supports {{var}} templates)
export const buildServerEntry = (url, vars, description, secretVariableNames) => {
  const cleanedUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const matches = [...cleanedUrl.matchAll(placeholderRegex)];
  const entry = {};

  if (matches.length > 0) {
    entry.url = cleanedUrl.replace(placeholderRegex, '{$1}');
    const serverVariables = {};

    // each match m is an array where m[0] is the full match (e.g. {{protocol}}) and m[1] is the capture group (e.g. protocol).
    matches.forEach((m) => {
      const varName = m[1];
      // A secret keeps its placeholder text as a hint; any other variable without a value stays empty
      const isSet = Object.hasOwn(vars, varName) && vars[varName] !== undefined;
      const fallback = isVariableSecret(secretVariableNames, varName) ? `{{${varName}}}` : '';
      serverVariables[varName] = { default: isSet ? String(vars[varName]) : fallback };
    });
    // Can still be empty: a {{__proto__}} placeholder sets the prototype instead of adding a key
    if (Object.keys(serverVariables).length > 0) {
      entry.variables = serverVariables;
    }
  } else {
    entry.url = cleanedUrl;
  }

  if (description) entry.description = description;
  return entry;
};

// Collect all baseUrl sources: collection variables + each environment
// Each source becomes a self-contained server entry in the OpenAPI spec.
// On import, each server entry maps to a separate Bruno environment.
export const getBaseUrlSources = (variables, environments) => {
  const baseUrlSources = [];

  const collectionBaseUrl = variables?.[BASE_URL_VARIABLE];
  if (collectionBaseUrl) {
    baseUrlSources.push({ baseUrl: collectionBaseUrl, description: COLLECTION_SERVER_DESCRIPTION, vars: variables });
  }

  for (const env of environments) {
    // An environment's server only leaves out the names that are secret in that same environment
    const envSecretNames = getSecretVariableNames([env]);
    const envVars = omitSecretVariables(getEnabledVariables(env.variables), envSecretNames);
    const baseUrl = isVariableSecret(envSecretNames, BASE_URL_VARIABLE) ? BASE_URL_PLACEHOLDER : envVars[BASE_URL_VARIABLE];
    if (baseUrl) {
      baseUrlSources.push({ baseUrl, description: env.name, vars: envVars });
    }
  }

  return baseUrlSources;
};

const splitPathname = (pathname) => pathname.split(/[\\/]/);

export const extractTagFromDepth = (item) => {
  const { pathname, depth } = item;
  if (!pathname) return;

  const parts = splitPathname(pathname);
  const baseDepth = parts.length - depth;
  if (depth === 1) return '';

  const tagIndex = Math.max(baseDepth, 0);

  return parts[tagIndex];
};

export const sanitizeId = (name) => {
  if (!name) return '';
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
};

export const getComponentId = (existingComponentIds, item) => {
  const baseId = String(item?.name || 'request')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'request';
  let componentId = baseId;
  let suffix = 1;

  while (existingComponentIds.has(componentId)) {
    componentId = `${baseId}_${suffix}`;
    suffix += 1;
  }
  existingComponentIds.add(componentId);

  return componentId;
};

export const restoreUnresolvedPlaceholders = (value) => value.replace(/%7B%7B(.*?)%7D%7D/gi, '{{$1}}');

// Resolve a raw request URL to a path and optional operation-level server override.
// Checks for request-level baseUrl overrides (vars.req), then {{baseUrl}} placeholder,
// then known baseUrl sources. Falls back to full resolution for unknown URLs.
export const resolveRequestUrl = (rawUrl, requestVars, variables, baseUrlSources, secretVariableNames) => {
  // URL uses {{baseUrl}} placeholder — strip it and resolve remaining path
  if (rawUrl.startsWith(BASE_URL_PLACEHOLDER)) {
    const path = rawUrl.slice(BASE_URL_PLACEHOLDER.length) || '/';

    // Request has a baseUrl override in vars.req — export as operation-level server
    const baseUrlOverride = requestVars && requestVars.find((v) => v.name === BASE_URL_VARIABLE && v.enabled);
    if (baseUrlOverride) {
      const reqVarsMap = {};
      requestVars.filter((v) => v.enabled).forEach((v) => { reqVarsMap[v.name] = v.value; });
      return { url: interpolate(path, reqVarsMap), operationLevelServer: buildServerEntry(baseUrlOverride.value, reqVarsMap, undefined, secretVariableNames) };
    }
    return { url: path, operationLevelServer: null };
  }

  // URL matches a known baseUrl value directly (e.g. user typed template vars inline)
  for (const source of baseUrlSources) {
    const baseUrl = source.baseUrl.replace(/\/+$/, '');
    const rest = rawUrl.slice(baseUrl.length);
    if (rawUrl.startsWith(baseUrl) && (rest === '' || /^[/?#]/.test(rest))) {
      const rawPath = rest;
      const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
      return { url: path, operationLevelServer: null };
    }
  }

  // Unknown URL — resolve fully and add operation-level server override
  const resolvedUrl = interpolate(rawUrl, variables);
  const textSplit = splitAddressAsText(resolvedUrl);
  if (textSplit) {
    return { url: textSplit.path, operationLevelServer: buildServerEntry(textSplit.server, variables, undefined, secretVariableNames) };
  }

  if (isValidUrl(resolvedUrl)) {
    const urlDetails = new URL(resolvedUrl);
    return {
      url: restoreUnresolvedPlaceholders(urlDetails.pathname),
      operationLevelServer: buildServerEntry(urlDetails.origin, variables, undefined, secretVariableNames)
    };
  }

  return { url: rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`, operationLevelServer: null };
};

// xml2js runs the parseString callback synchronously, so the result is set by the time this returns
const xmlToJson = (xmlString) => {
  const parser = new xml2js.Parser({ explicitArray: false, trim: true });
  let jsonResult = null;

  parser.parseString(xmlString, (err, result) => {
    if (err) {
      throw err;
    } else {
      jsonResult = result;
    }
  });

  return jsonResult;
};

// Query params from the params list, then the ones written only in the url
export const buildQueryParameters = (params, url) => {
  const urlQueryParams = getUrlQueryParams(url);
  const queryParamNames = new Set(params.filter((p) => p?.type !== 'path').map((p) => p?.name));

  return [
    // Query params (exclude path-type params to avoid duplication)
    ...params.filter((p) => p?.type !== 'path').map((param) => ({
      name: param?.name,
      in: 'query',
      description: param?.description || '',
      required: param?.enabled,
      example: param?.value
    })),
    ...urlQueryParams
      .filter(({ name }) => !queryParamNames.has(name))
      .map(({ name, value }) => ({
        name,
        in: 'query',
        description: '',
        required: true,
        example: value
      }))
  ];
};

export const buildPathParameters = (params, pathOnly, segmentParamNames) => {
  const placeholderNames = [...new Set([...pathOnly.matchAll(placeholderRegex)].map((m) => m[1]))];
  const pathParamsRegex = /(?<!{){([^{}]+)}(?!})/g;
  const pathMatches = pathOnly.match(pathParamsRegex) || [];

  // Build known path param names from the params array
  const knownPathParamNames = new Set(params.filter((p) => p?.type === 'path').map((p) => p?.name));

  return [
    // Path params from the params array (have values from Bruno)
    ...params.filter((p) => p?.type === 'path').map((param) => ({
      name: param?.name,
      in: 'path',
      required: true,
      example: param?.value
    })),
    // Path params from URL regex that aren't already in the params array
    ...pathMatches
      .map((path) => path.slice(1, path.length - 1))
      .filter((name) => !knownPathParamNames.has(name))
      .map((name) => ({ name, in: 'path', required: true })),
    // Bruno :name path params that aren't in the params array
    ...segmentParamNames
      .filter((name) => !knownPathParamNames.has(name))
      .map((name) => ({ name, in: 'path', required: true })),
    ...placeholderNames
      .filter((name) => !knownPathParamNames.has(name))
      .map((name) => ({
        name,
        in: 'path',
        required: true,
        example: `{{${name}}}`,
        schema: { type: 'string' }
      }))
  ];
};

export const buildParameters = (item, pathOnly, segmentParamNames) => {
  const { params = [], headers = [] } = item.request;

  return [
    ...buildQueryParameters(params, item.request.url || ''),
    ...headers.map((header) => ({
      name: header?.name,
      in: 'header',
      description: header?.description || '',
      required: header?.enabled,
      example: header?.value
    })),
    ...buildPathParameters(params, pathOnly, segmentParamNames)
  ];
};

const generatePropertyShape = (value) => {
  const shape = Array.isArray(value) ? { type: 'array', items: { type: 'string' } } : { type: typeof value };

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    // Assigned one by one so a JSON __proto__ key sets the prototype instead of becoming an own property
    const properties = {};
    keys.forEach((key) => {
      properties[key] = generatePropertyShape(value[key]);
    });
    if (keys.length) {
      shape.properties = properties;
    }
  }
  return shape;
};

export const buildFormSchema = (fields) => {
  const properties = {};
  fields.forEach((field) => {
    const prop = generatePropertyShape(field.value);
    if (field.description) prop.description = field.description;
    properties[field.name] = prop;
  });
  return { type: 'object', properties };
};

const buildJsonBodyComponent = (json, itemName, warnings) => {
  try {
    const parsedJson = JSON.parse(json);
    const schema = generatePropertyShape(parsedJson);
    schema.example = parsedJson;
    return { mediaType: 'application/json', schema };
  } catch (error) {
    addWarning(warnings, `Failed to parse JSON in request body: ${error.message}`, itemName);
    return { mediaType: 'application/json', schema: { type: 'object', properties: {} } };
  }
};

const buildXmlBodyComponent = (xml, itemName, warnings) => {
  try {
    const jsonResult = xmlToJson(xml);
    if (!jsonResult) {
      addWarning(warnings, 'Failed to parse XML in request body', itemName);
      return undefined;
    }
    const schema = generatePropertyShape(jsonResult);
    schema.example = jsonResult;
    return { mediaType: 'application/xml', schema };
  } catch (error) {
    addWarning(warnings, `Failed to parse XML in request body: ${error.message}`, itemName);
    return undefined;
  }
};

// The media type and schema of a body that is exported as a request body component
export const buildBodyComponent = (item, warnings) => {
  const { body } = item.request;
  switch (body?.mode) {
    case 'json':
      return body.json ? buildJsonBodyComponent(body.json, item.name, warnings) : undefined;
    case 'xml':
      return body.xml ? buildXmlBodyComponent(body.xml, item.name, warnings) : undefined;
    case 'multipartForm':
      return body.multipartForm ? { mediaType: 'multipart/form-data', schema: buildFormSchema(body.multipartForm) } : undefined;
    case 'formUrlEncoded':
      return body.formUrlEncoded ? { mediaType: 'application/x-www-form-urlencoded', schema: buildFormSchema(body.formUrlEncoded) } : undefined;
    default:
      return undefined;
  }
};

// A text body is written into the operation itself, without a component
export const buildInlineRequestBody = (body) => {
  if (body?.mode !== 'text' || !body.text) return undefined;
  return {
    content: {
      'text/plain': {
        schema: {
          type: 'string'
        }
      }
    }
  };
};

export const addRequestBodyComponent = (components, componentId, mediaType, schema) => {
  components.schemas[componentId] = schema;
  components.requestBodies[componentId] = {
    content: {
      [mediaType]: {
        schema: {
          $ref: `#/components/schemas/${componentId}`
        }
      }
    },
    description: '',
    required: true
  };
  return {
    $ref: `#/components/requestBodies/${componentId}`
  };
};

// An oauth2 grant type the spec can't describe gives null rather than undefined: the request still takes a component id
const buildOauth2SecurityScheme = (oauth2) => {
  const { authorizationUrl, accessTokenUrl, scope } = oauth2;
  const scopes = scope ? { [scope]: '' } : {};
  switch (oauth2.grantType) {
    case 'authorization_code':
      return { type: 'oauth2', flows: { authorizationCode: { authorizationUrl, tokenUrl: accessTokenUrl, scopes } } };
    case 'password':
    case 'client_credentials':
      return { type: 'oauth2', flows: { password: { tokenUrl: accessTokenUrl, scopes } } };
    default:
      return null;
  }
};

export const buildSecurityScheme = (auth) => {
  switch (auth?.mode) {
    case 'basic':
      return { type: 'http', scheme: 'basic' };
    case 'bearer':
      return { type: 'http', scheme: 'bearer' };
    case 'oauth2':
      return auth.oauth2?.grantType ? buildOauth2SecurityScheme(auth.oauth2) : undefined;
    case 'awsv4':
      return {
        'type': 'apiKey',
        'name': 'Authorization',
        'in': 'header',
        'x-amazon-apigateway-authtype': 'awsSigv4'
      };
    case 'digest':
      return { type: 'digest', scheme: 'digest', description: 'Digest Authentication' };
    default:
      return undefined;
  }
};

export const addSecurityScheme = (components, componentId, securityScheme) => {
  components.securitySchemes[componentId] = securityScheme;
  return {
    [componentId]: []
  };
};

// The body and the auth of a request share one component id. It is taken only when one of them adds a component, or
// the auth has an oauth2 grant type the spec can't describe (null scheme), so later requests with the same name keep
// the same numbered suffix.
export const takesComponentId = (bodyComponent, securityScheme) => Boolean(bodyComponent) || securityScheme !== undefined;

export const buildOperation = (item, variables, baseUrlSources, secretVariableNames, componentIds, components, warnings) => {
  const { method, url: rawUrl, vars: requestVars, body, auth } = item.request;
  const { url: rawPath, operationLevelServer } = resolveRequestUrl(rawUrl || '', requestVars?.req, variables, baseUrlSources, secretVariableNames);
  const queryStart = maskPlaceholders(rawPath).search(/[?#]/);
  const pathOnly = queryStart === -1 ? rawPath : rawPath.slice(0, queryStart);
  const { templatePath: url, segmentParamNames } = toTemplatePath(pathOnly);
  const parameters = buildParameters(item, pathOnly, segmentParamNames);

  const pathParts = item.pathname ? splitPathname(item.pathname).filter((part) => part && part.trim()) : [];
  const operationId = pathParts.length > 0
    ? sanitizeId(pathParts.join('_').toLowerCase())
    : sanitizeId(item.name?.toLowerCase() || '');

  const operation = {
    summary: item.name,
    operationId,
    description: '',
    tags: [extractTagFromDepth(item)],
    responses: {
      200: {
        description: ''
      }
    }
  };

  if (parameters.length) {
    operation.parameters = parameters;
  }

  const bodyComponent = buildBodyComponent(item, warnings);
  const securityScheme = buildSecurityScheme(auth);
  const componentId = takesComponentId(bodyComponent, securityScheme) ? getComponentId(componentIds, item) : undefined;

  const requestBody = bodyComponent
    ? addRequestBodyComponent(components, componentId, bodyComponent.mediaType, bodyComponent.schema)
    : buildInlineRequestBody(body);
  if (requestBody) {
    operation.requestBody = requestBody;
  }

  if (securityScheme) {
    operation.security = addSecurityScheme(components, componentId, securityScheme);
  }

  return {
    url,
    method: method.toLowerCase(),
    data: operation,
    operationLevelServer
  };
};

export const groupOperationsByPath = (operations) => {
  return operations.reduce((acc, item) => {
    if (!acc[item.url]) {
      acc[item.url] = {};
    }
    const operation = item.data;

    if (item.operationLevelServer) {
      // Add operation-level server override inside the operation object (not path-item level)
      // so the import can read it back from operationObject.servers
      operation.servers = [item.operationLevelServer];
    }

    const operationObject = acc[item.url][item.method];

    if (operationObject) {
      operationObject['x-bruno-variants'] = [
        ...(operationObject['x-bruno-variants'] || []),
        operation
      ];
    } else {
      acc[item.url][item.method] = operation;
    }
    return acc;
  }, {});
};

export const exportApiSpec = (name, items, collectionVariables, envVariables, selectedEnvironment) => {
  const environments = Object.entries(envVariables || {}).map(([envName, envVars]) => ({ name: envName, variables: envVars }));
  const secretVariableNames = getSecretVariableNames(environments);

  // Secrets are never filled in, even when the caller passes their values
  const variables = omitSecretAndReservedVariables(buildSpecVariables(collectionVariables, envVariables, selectedEnvironment), secretVariableNames);

  const requestItems = items.filter((item) => SUPPORTED_ITEM_TYPES.includes(item.type) && !item.isTransient);

  const components = {
    schemas: {},
    requestBodies: {},
    securitySchemes: {}
  };

  const warnings = [];

  const baseUrlSources = getBaseUrlSources(variables, environments);
  const servers = baseUrlSources.map((source) => buildServerEntry(source.baseUrl, source.vars, source.description, secretVariableNames));

  const componentIds = new Set();
  const operations = requestItems.map((item) => buildOperation(item, variables, baseUrlSources, secretVariableNames, componentIds, components, warnings));

  const spec = {
    openapi: OPENAPI_VERSION,
    info: { title: name, version: DEFAULT_SPEC_VERSION },
    paths: groupOperationsByPath(operations),
    servers,
    components
  };

  return { spec, warnings };
};

export const serializeOpenApiSpec = (spec, format) => {
  return format === 'json' ? JSON.stringify(spec, null, 2) + '\n' : jsyaml.dump(spec);
};
