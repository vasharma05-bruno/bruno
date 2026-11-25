import jsyaml from 'js-yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { test as isValidPathTemplate } from 'openapi-path-templating';
import {
  exportApiSpec,
  serializeOpenApiSpec,
  buildSpecVariables,
  getEnvironmentVariablesKeyValuePairs,
  getSecretVariableNames,
  isVariableSecret,
  omitSecretVariables,
  omitSecretAndReservedVariables,
  getEnabledVariables,
  buildServerEntry,
  getBaseUrlSources,
  resolveRequestUrl,
  extractTagFromDepth,
  sanitizeId,
  restoreUnresolvedPlaceholders,
  getComponentId,
  addWarning,
  buildParameters,
  buildQueryParameters,
  buildPathParameters,
  buildFormSchema,
  buildBodyComponent,
  buildInlineRequestBody,
  addRequestBodyComponent,
  buildSecurityScheme,
  addSecurityScheme,
  takesComponentId,
  buildOperation,
  groupOperationsByPath
} from './openapi-spec';
import path from 'path';
import openApiToBruno from '../../../../bruno-converters/src/openapi/openapi-to-bruno';

jest.mock('nanoid', () => ({
  ...jest.requireActual('nanoid')
}));

// Mock @usebruno/common to provide a working interpolate function
jest.mock('@usebruno/common', () => ({
  ...jest.requireActual('@usebruno/common'),
  interpolate: (str, vars) => {
    if (!str || typeof str !== 'string') return str;
    let result = str;
    // Simple recursive interpolation for tests
    let changed = true;
    while (changed) {
      changed = false;
      result = result.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        if (vars && vars[key] !== undefined) {
          changed = true;
          return String(vars[key]);
        }
        return match;
      });
    }
    return result;
  }
}));

// The export as the app writes it: YAML text plus warnings
const toYaml = (exported) => ({ content: serializeOpenApiSpec(exported.spec, 'yaml'), warnings: exported.warnings });

// The exporter takes environments keyed by name; many tests here describe them as a list
const keyByName = (environments) => Object.fromEntries((environments || []).map((env) => [env.name, env.variables]));

describe('exportApiSpec - server variables reconstruction', () => {
  const makeItems = (urls) =>
    urls.map((url, i) => ({
      name: `Request ${i + 1}`,
      type: 'http-request',
      request: {
        url,
        method: 'GET',
        params: [],
        headers: [],
        body: {},
        auth: {}
      }
    }));

  it('should reconstruct server URL template and variables map when baseUrl has template vars', () => {
    const variables = {
      baseUrl: '{{protocol}}://{{host}}:{{port}}/v1',
      protocol: 'https',
      host: 'api.example.com',
      port: '443'
    };
    const items = makeItems(['{{baseUrl}}/users', '{{baseUrl}}/items']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables));

    // Should contain the template server URL
    expect(content).toContain('url: \'{protocol}://{host}:{port}/v1\'');

    // Should contain the variables with defaults (js-yaml may or may not quote values)
    expect(content).toContain('protocol:');
    expect(content).toMatch(/default:\s*'?https'?/);
    expect(content).toContain('host:');
    expect(content).toMatch(/default:\s*api\.example\.com/);
    expect(content).toContain('port:');
    expect(content).toMatch(/default:\s*'443'/);

    // Should NOT contain the resolved origin as a separate server
    expect(content).not.toMatch(/url:\s*'?https:\/\/api\.example\.com:443'?/);
  });

  it('should strip base path from request pathnames to avoid duplication', () => {
    const variables = {
      baseUrl: '{{protocol}}://{{host}}/v1',
      protocol: 'https',
      host: 'api.example.com'
    };
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables));

    // Path should be /users, not /v1/users (since server URL already has /v1)
    expect(content).toContain('/users:');
    expect(content).not.toMatch(/\/v1\/users:/);
  });

  it('should use plain resolved URL when baseUrl has no template vars', () => {
    const variables = {
      baseUrl: 'https://api.example.com/v1'
    };
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables));

    // Should contain the resolved origin as a plain server
    expect(content).toMatch(/url:\s*'?https:\/\/api\.example\.com'?/);

    // Should NOT contain template syntax
    expect(content).not.toContain('{protocol}');
    expect(content).not.toContain('variables:');
  });

  it('should add non-baseUrl servers as operation-level overrides, not root servers', () => {
    const variables = {
      baseUrl: '{{protocol}}://{{host}}/v1',
      protocol: 'https',
      host: 'api.example.com'
    };
    // Mix of baseUrl requests and a direct URL request
    const items = makeItems(['{{baseUrl}}/users', 'https://other-api.com/data']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables));

    // Template server should be in root servers
    expect(content).toContain('url: \'{protocol}://{host}/v1\'');

    // Other server should appear as an operation-level override under /data
    expect(content).toContain('/data:');

    // Root servers should only contain the baseUrl server
    const parsed = require('js-yaml').load(content);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].url).toBe('{protocol}://{host}/v1');

    // The operation-level server should be inside the GET operation
    expect(parsed.paths['/data'].get.servers).toHaveLength(1);
    expect(parsed.paths['/data'].get.servers[0].url).toBe('https://other-api.com');
  });

  it('should export request-level baseUrl override as a path-level server', () => {
    const variables = {
      baseUrl: 'https://api.example.com/v1'
    };
    const items = [
      {
        name: 'Get users',
        type: 'http-request',
        pathname: path.join('collection', 'Active Users', 'Get users.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [],
          headers: [],
          body: {},
          auth: {}
        }
      },
      {
        name: 'Get files',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/files',
          method: 'GET',
          params: [],
          headers: [],
          body: {},
          auth: {},
          vars: {
            req: [
              { name: 'baseUrl', value: 'https://files.example.com', enabled: true }
            ]
          }
        }
      }
    ];

    const { content } = toYaml(exportApiSpec('Test API', items, variables));
    const parsed = require('js-yaml').load(content);

    // Root servers should only have the collection baseUrl
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].url).toBe('https://api.example.com/v1');

    // /users GET should NOT have an operation-level server override
    expect(parsed.paths['/users'].get.servers).toBeUndefined();

    // /files GET should have an operation-level server override
    expect(parsed.paths['/files'].get.servers).toHaveLength(1);
    expect(parsed.paths['/files'].get.servers[0].url).toBe('https://files.example.com');
  });

  it('should export request-level baseUrl override with template variables', () => {
    const variables = {
      baseUrl: 'https://api.example.com/v1'
    };
    const items = [
      {
        name: 'Regional data',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/data',
          method: 'GET',
          params: [],
          headers: [],
          body: {},
          auth: {},
          vars: {
            req: [
              { name: 'baseUrl', value: '{{protocol}}://{{region}}.example.com/v2', enabled: true },
              { name: 'protocol', value: 'https', enabled: true },
              { name: 'region', value: 'us-east', enabled: true }
            ]
          }
        }
      }
    ];

    const { content } = toYaml(exportApiSpec('Test API', items, variables));
    const parsed = require('js-yaml').load(content);

    // Operation-level server should have template URL with variables
    const pathServers = parsed.paths['/data'].get.servers;
    expect(pathServers).toHaveLength(1);
    expect(pathServers[0].url).toBe('{protocol}://{region}.example.com/v2');
    expect(pathServers[0].variables.protocol.default).toBe('https');
    expect(pathServers[0].variables.region.default).toBe('us-east');
  });
});

describe('exportApiSpec - duplicate operation variants', () => {
  const flattenItemsForExport = (items, parentPath = 'collection') => {
    return items.flatMap((item) => {
      if (item.type === 'folder') {
        return flattenItemsForExport(item.items || [], path.join(parentPath, item.name));
      }

      return [{
        ...item,
        pathname: path.join(parentPath, `${item.name}.bru`),
        depth: parentPath.split(path.sep).length
      }];
    });
  };

  it('should preserve duplicate path and method requests in x-bruno-variants', () => {
    const items = [
      {
        name: 'Get users',
        type: 'http-request',
        pathname: path.join('collection', 'Active Users', 'Get users.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [{ name: 'status', value: 'active', enabled: true, type: 'query' }],
          headers: [],
          body: {},
          auth: {}
        }
      },
      {
        name: 'Get users inactive',
        type: 'http-request',
        pathname: path.join('collection', 'Inactive Users', 'Get users inactive.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [{ name: 'status', value: 'inactive', enabled: true, type: 'query' }],
          headers: [],
          body: {},
          auth: {},
          vars: {
            req: [{ name: 'baseUrl', value: 'https://files.example.com', enabled: true }]
          }
        }
      },
      {
        name: 'Get users pending',
        type: 'http-request',
        pathname: path.join('collection', 'Pending Users', 'Get users pending.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [{ name: 'status', value: 'pending', enabled: true, type: 'query' }],
          headers: [],
          body: {},
          auth: {},
          vars: {
            req: [{ name: 'baseUrl', value: 'https://audit.example.com', enabled: true }]
          }
        }
      }
    ];

    const { content } = toYaml(exportApiSpec(
      'Test API',
      items,
      { baseUrl: 'https://api.example.com' }
    ));
    const parsed = require('js-yaml').load(content);
    const operation = parsed.paths['/users'].get;
    const variants = operation['x-bruno-variants'];

    expect(operation.summary).toBe('Get users');
    expect(operation.tags).toEqual(['Active Users']);
    expect(operation.parameters[0]).toMatchObject({ name: 'status', example: 'active' });
    expect(variants).toHaveLength(2);
    expect(variants[0].summary).toBe('Get users inactive');
    expect(variants[0].tags).toEqual(['Inactive Users']);
    expect(variants[0].parameters[0]).toMatchObject({ name: 'status', example: 'inactive' });
    expect(variants[0].servers[0].url).toBe('https://files.example.com');
    expect(variants[1].summary).toBe('Get users pending');
    expect(variants[1].tags).toEqual(['Pending Users']);
    expect(variants[1].parameters[0]).toMatchObject({ name: 'status', example: 'pending' });
    expect(variants[1].servers[0].url).toBe('https://audit.example.com');
  });

  it('should preserve distinct bodies for duplicate operations with the same name', () => {
    const items = [
      {
        name: 'Update user',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/users',
          method: 'POST',
          params: [],
          headers: [],
          body: { mode: 'json', json: '{"status":"active"}' },
          auth: { mode: 'basic' }
        }
      },
      {
        name: 'Update user',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/users',
          method: 'POST',
          params: [],
          headers: [],
          body: { mode: 'json', json: '{"status":"inactive"}' },
          auth: { mode: 'bearer' }
        }
      }
    ];

    const { content } = toYaml(exportApiSpec(
      'Test API',
      items,
      { baseUrl: 'https://api.example.com' }
    ));
    const parsed = require('js-yaml').load(content);
    const operation = parsed.paths['/users'].post;
    const variant = operation['x-bruno-variants'][0];

    expect(operation.requestBody.$ref).toBe('#/components/requestBodies/update_user');
    expect(variant.requestBody.$ref).toBe('#/components/requestBodies/update_user_1');
    expect(parsed.components.schemas.update_user.example).toEqual({ status: 'active' });
    expect(parsed.components.schemas.update_user_1.example).toEqual({ status: 'inactive' });
    expect(operation.security).toEqual({ update_user: [] });
    expect(variant.security).toEqual({ update_user_1: [] });
    expect(parsed.components.securitySchemes.update_user.scheme).toBe('basic');
    expect(parsed.components.securitySchemes.update_user_1.scheme).toBe('bearer');
  });

  it('should suffix conflicting component refs by request name', () => {
    const items = [
      {
        name: 'Sync user',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/users',
          method: 'POST',
          params: [],
          headers: [],
          body: { mode: 'json', json: '{"name":"Ada"}' },
          auth: {}
        }
      },
      {
        name: 'Sync user',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/users/{userId}',
          method: 'PUT',
          params: [],
          headers: [],
          body: { mode: 'json', json: '{"name":"Grace"}' },
          auth: {}
        }
      }
    ];

    const firstExport = toYaml(exportApiSpec(
      'Test API',
      items,
      { baseUrl: 'https://api.example.com' }
    ));
    const firstParsed = require('js-yaml').load(firstExport.content);

    expect(firstParsed.paths['/users'].post.requestBody.$ref).toBe('#/components/requestBodies/sync_user');
    expect(firstParsed.paths['/users/{userId}'].put.requestBody.$ref).toBe('#/components/requestBodies/sync_user_1');
    expect(Object.keys(firstParsed.components.schemas).sort()).toEqual(['sync_user', 'sync_user_1']);
  });

  it('should not reserve component names for requests without exported components', () => {
    const items = [
      {
        name: 'Sync user',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [],
          headers: [],
          body: {},
          auth: {}
        }
      },
      {
        name: 'Sync user',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/users/{userId}',
          method: 'PUT',
          params: [],
          headers: [],
          body: { mode: 'json', json: '{"name":"Grace"}' },
          auth: {}
        }
      }
    ];

    const { content } = toYaml(exportApiSpec(
      'Test API',
      items,
      { baseUrl: 'https://api.example.com' }
    ));
    const parsed = require('js-yaml').load(content);

    expect(parsed.paths['/users/{userId}'].put.requestBody.$ref).toBe('#/components/requestBodies/sync_user');
    expect(Object.keys(parsed.components.schemas)).toEqual(['sync_user']);
  });

  it('should round-trip duplicate operation variants without nesting x-bruno-variants', () => {
    const items = [
      {
        name: 'Get users',
        type: 'http-request',
        pathname: path.join('collection', 'Active Users', 'Get users.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [{ name: 'status', value: 'active', enabled: true, type: 'query' }],
          headers: [],
          body: {},
          auth: {}
        }
      },
      {
        name: 'Get users inactive',
        type: 'http-request',
        pathname: path.join('collection', 'Inactive Users', 'Get users inactive.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [{ name: 'status', value: 'inactive', enabled: true, type: 'query' }],
          headers: [],
          body: {},
          auth: {},
          vars: {
            req: [{ name: 'baseUrl', value: 'https://files.example.com', enabled: true }]
          }
        }
      },
      {
        name: 'Get users pending',
        type: 'http-request',
        pathname: path.join('collection', 'Pending Users', 'Get users pending.bru'),
        depth: 2,
        request: {
          url: '{{baseUrl}}/users',
          method: 'GET',
          params: [{ name: 'status', value: 'pending', enabled: true, type: 'query' }],
          headers: [],
          body: {},
          auth: {},
          vars: {
            req: [{ name: 'baseUrl', value: 'https://audit.example.com', enabled: true }]
          }
        }
      }
    ];
    const variables = { baseUrl: 'https://api.example.com' };
    const firstExport = toYaml(exportApiSpec('Test API', items, variables));
    const imported = openApiToBruno(require('js-yaml').load(firstExport.content));
    const reExportItems = flattenItemsForExport(imported.items);

    const secondExport = toYaml(exportApiSpec(
      imported.name,
      reExportItems,
      Object.fromEntries(imported.environments[0].variables.map((variable) => [variable.name, variable.value]))
    ));
    const operation = require('js-yaml').load(secondExport.content).paths['/users'].get;

    expect(operation['x-bruno-variants']).toHaveLength(2);
    expect(operation['x-bruno-variants'].map((variant) => variant.summary)).toEqual([
      'Get users inactive',
      'Get users pending'
    ]);
    expect(operation['x-bruno-variants'].every((variant) => !variant['x-bruno-variants'])).toBe(true);
  });
});

describe('exportApiSpec - operation ids', () => {
  const requestItem = (fileName, method, url) => ({
    name: fileName,
    type: 'http-request',
    pathname: path.join('collection', `${fileName}.bru`),
    request: { url: `{{baseUrl}}${url}`, method, params: [], headers: [], body: {}, auth: {} }
  });

  const exportItems = (items) => jsyaml.load(toYaml(exportApiSpec('Test API', items, { baseUrl: 'https://api.example.com' })).content);

  it('gives each request an operation id from its pathname', () => {
    const spec = exportItems([
      requestItem('List pets', 'GET', '/pets'),
      requestItem('Create pet', 'POST', '/pets'),
      requestItem('Search pets', 'GET', '/pets/search'),
      requestItem('Archived pets', 'GET', '/pets/archive'),
      requestItem('Create order', 'POST', '/orders')
    ]);
    const operations = [spec.paths['/pets'].get, spec.paths['/pets'].post, spec.paths['/pets/search'].get, spec.paths['/pets/archive'].get, spec.paths['/orders'].post];

    expect(operations.map(({ operationId }) => operationId)).toEqual([
      'collection_list_pets_bru',
      'collection_create_pet_bru',
      'collection_search_pets_bru',
      'collection_archived_pets_bru',
      'collection_create_order_bru'
    ]);
  });

  it('gives a variant an operation id from its own pathname', () => {
    const operation = exportItems([requestItem('Update user', 'POST', '/users'), requestItem('Update user email', 'POST', '/users')]).paths['/users'].post;

    expect([operation.operationId, operation['x-bruno-variants'][0].operationId]).toEqual(['collection_update_user_bru', 'collection_update_user_email_bru']);
  });
});

describe('exportApiSpec - parameter and body value preservation', () => {
  it('should export form request body media types without trailing colons', () => {
    const variables = { baseUrl: 'https://api.example.com' };
    const items = [
      {
        name: 'Upload avatar',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/avatars',
          method: 'POST',
          params: [],
          headers: [],
          body: {
            mode: 'multipartForm',
            multipartForm: [{ name: 'avatar', value: 'avatar.png' }]
          },
          auth: {}
        }
      },
      {
        name: 'Create session',
        type: 'http-request',
        request: {
          url: '{{baseUrl}}/sessions',
          method: 'POST',
          params: [],
          headers: [],
          body: {
            mode: 'formUrlEncoded',
            formUrlEncoded: [{ name: 'email', value: 'ada@example.com' }]
          },
          auth: {}
        }
      }
    ];

    const { content } = toYaml(exportApiSpec('Test API', items, variables));
    const parsed = require('js-yaml').load(content);

    expect(parsed.components.requestBodies.upload_avatar.content).toHaveProperty('multipart/form-data');
    expect(parsed.components.requestBodies.upload_avatar.content).not.toHaveProperty('multipart/form-data:');
    expect(parsed.components.requestBodies.create_session.content).toHaveProperty('application/x-www-form-urlencoded');
    expect(parsed.components.requestBodies.create_session.content).not.toHaveProperty('application/x-www-form-urlencoded:');
  });

  it('should export path parameter values from params array', () => {
    const variables = { baseUrl: 'https://api.example.com' };
    const items = [{
      name: 'Get user',
      type: 'http-request',
      request: {
        url: '{{baseUrl}}/users/{userId}',
        method: 'GET',
        params: [
          { name: 'userId', value: '123', type: 'path', enabled: true },
          { name: 'include', value: 'profile', type: 'query', enabled: true }
        ],
        headers: [], body: {}, auth: {}
      }
    }];
    const { content } = toYaml(exportApiSpec('Test', items, variables));
    const parsed = require('js-yaml').load(content);
    const params = parsed.paths['/users/{userId}'].get.parameters;

    const pathParam = params.find((p) => p.in === 'path');
    expect(pathParam.name).toBe('userId');
    expect(pathParam.example).toBe('123');

    const queryParam = params.find((p) => p.in === 'query');
    expect(queryParam.name).toBe('include');
    expect(queryParam.example).toBe('profile');
  });

  it('should not export path-type params as query params', () => {
    const variables = { baseUrl: 'https://api.example.com' };
    const items = [{
      name: 'Get user',
      type: 'http-request',
      request: {
        url: '{{baseUrl}}/users/{userId}',
        method: 'GET',
        params: [
          { name: 'userId', value: '123', type: 'path', enabled: true }
        ],
        headers: [], body: {}, auth: {}
      }
    }];
    const { content } = toYaml(exportApiSpec('Test', items, variables));
    const parsed = require('js-yaml').load(content);
    const params = parsed.paths['/users/{userId}'].get.parameters;

    const queryParams = params.filter((p) => p.in === 'query');
    expect(queryParams).toHaveLength(0);

    const pathParams = params.filter((p) => p.in === 'path');
    expect(pathParams).toHaveLength(1);
    expect(pathParams[0].name).toBe('userId');
  });

  it('should fall back to URL regex for path params not in params array', () => {
    const variables = { baseUrl: 'https://api.example.com' };
    const items = [{
      name: 'Get user',
      type: 'http-request',
      request: {
        url: '{{baseUrl}}/users/{userId}',
        method: 'GET',
        params: [],
        headers: [], body: {}, auth: {}
      }
    }];
    const { content } = toYaml(exportApiSpec('Test', items, variables));
    const parsed = require('js-yaml').load(content);
    const params = parsed.paths['/users/{userId}'].get.parameters;

    const pathParams = params.filter((p) => p.in === 'path');
    expect(pathParams).toHaveLength(1);
    expect(pathParams[0].name).toBe('userId');
    expect(pathParams[0].example).toBeUndefined();
  });

  it('should preserve JSON body example for round-trip', () => {
    const variables = { baseUrl: 'https://api.example.com' };
    const items = [{
      name: 'Create user',
      type: 'http-request',
      request: {
        url: '{{baseUrl}}/users',
        method: 'POST',
        params: [], headers: [],
        body: { mode: 'json', json: '{"name":"John","age":30}' },
        auth: {}
      }
    }];
    const { content } = toYaml(exportApiSpec('Test', items, variables));
    const parsed = require('js-yaml').load(content);
    const schema = parsed.components.schemas.create_user;

    expect(schema.example).toEqual({ name: 'John', age: 30 });
    expect(schema.properties.name.type).toBe('string');
    expect(schema.properties.age.type).toBe('number');
  });
});

describe('exportApiSpec - multi-environment servers', () => {
  const makeItems = (urls) =>
    urls.map((url, i) => ({
      name: `Request ${i + 1}`,
      type: 'http-request',
      request: {
        url,
        method: 'GET',
        params: [],
        headers: [],
        body: {},
        auth: {}
      }
    }));

  const makeEnv = (name, vars) => ({
    uid: name.toLowerCase(),
    name,
    variables: Object.entries(vars).map(([k, v]) => ({
      uid: `${name}-${k}`,
      name: k,
      value: v,
      enabled: true,
      type: 'text',
      secret: false
    }))
  });

  it('should create a server entry per environment when baseUrl has template vars', () => {
    const variables = {};
    const environments = [
      makeEnv('Production', { baseUrl: '{{protocol}}://{{host}}/v1', protocol: 'https', host: 'api.prod.com' }),
      makeEnv('Staging', { baseUrl: '{{protocol}}://{{host}}/v1', protocol: 'https', host: 'api.staging.com' })
    ];
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));

    // Both environments should appear as servers
    expect(content).toContain('description: Production');
    expect(content).toContain('description: Staging');

    // Template URL should be used
    expect(content).toContain('url: \'{protocol}://{host}/v1\'');

    // Production vars
    expect(content).toContain('api.prod.com');
    // Staging vars
    expect(content).toContain('api.staging.com');
  });

  it('should create a server entry per environment when baseUrl is a plain URL in each env', () => {
    const variables = {};
    const environments = [
      makeEnv('Production', { baseUrl: 'https://api.prod.com/v1' }),
      makeEnv('Staging', { baseUrl: 'https://api.staging.com/v1' })
    ];
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));

    // Both servers should appear
    expect(content).toMatch(/url:\s*'?https:\/\/api\.prod\.com\/v1'?/);
    expect(content).toMatch(/url:\s*'?https:\/\/api\.staging\.com\/v1'?/);

    // Descriptions should match env names
    expect(content).toContain('description: Production');
    expect(content).toContain('description: Staging');

    // No OpenAPI template variable syntax in servers section
    expect(content).not.toMatch(/url:\s*'?\{baseUrl\}'?/);
  });

  it('should use collection variables baseUrl when no environments are passed', () => {
    const variables = {
      baseUrl: '{{protocol}}://{{host}}/v1',
      protocol: 'https',
      host: 'api.example.com'
    };
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables));

    // Should use collection baseUrl as template
    expect(content).toContain('url: \'{protocol}://{host}/v1\'');
    expect(content).toMatch(/default:\s*'?https'?/);
    expect(content).toContain('api.example.com');
    expect(content).toContain('description: Base Server');
  });

  it('should include both collection and env baseUrl as separate servers', () => {
    const variables = {
      baseUrl: '{{protocol}}://{{host}}/v1',
      protocol: 'https',
      host: 'api.default.com'
    };
    const environments = [
      makeEnv('Production', { baseUrl: 'https://api.prod.com/v1' }),
      makeEnv('Staging', { protocol: 'http', host: 'localhost' })
    ];
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));

    // Collection template server should be present
    expect(content).toContain('url: \'{protocol}://{host}/v1\'');
    expect(content).toContain('description: Base Server');

    // Production's plain URL override should also be present
    expect(content).toMatch(/url:\s*'?https:\/\/api\.prod\.com\/v1'?/);
    expect(content).toContain('description: Production');

    // Staging doesn't define baseUrl — no separate server entry
    expect(content).not.toContain('description: Staging');
  });

  it('should export both collection and env even when baseUrl resolves to the same value', () => {
    const variables = {
      baseUrl: 'https://api.example.com/v1'
    };
    const environments = [
      makeEnv('Production', { baseUrl: 'https://api.example.com/v1' })
    ];
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));

    // Both should appear as separate server entries
    expect(content).toContain('description: Base Server');
    expect(content).toContain('description: Production');
  });

  it('should skip environments that do not define baseUrl', () => {
    const variables = {
      baseUrl: '{{host}}/api'
    };
    const environments = [
      makeEnv('Production', { host: 'https://api.prod.com', baseUrl: 'https://api.prod.com/api' }),
      { uid: 'empty', name: 'Empty', variables: [] }
    ];
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));

    // Collection template and Production should have server entries
    expect(content).toContain('description: Base Server');
    expect(content).toContain('description: Production');

    // Empty env has no baseUrl — no server entry
    expect(content).not.toContain('description: Empty');
  });

  it('should export both envs even when baseUrl is identical', () => {
    const variables = {};
    const environments = [
      makeEnv('Production', { baseUrl: 'https://api.example.com/v1' }),
      makeEnv('Staging', { baseUrl: 'https://api.example.com/v1' })
    ];
    const items = makeItems(['{{baseUrl}}/users']);

    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));

    // Both should appear as separate server entries (each maps to a Bruno environment on import)
    expect(content).toContain('description: Production');
    expect(content).toContain('description: Staging');
  });
});

describe('exportApiSpec - OAuth2 scope handling (BRU-3297)', () => {
  const makeOauth2Item = (grantType, scope) => ({
    name: 'Req',
    type: 'http-request',
    request: {
      url: 'https://api.example.com/users',
      method: 'GET',
      params: [],
      headers: [],
      body: {},
      auth: {
        mode: 'oauth2',
        oauth2: {
          grantType,
          authorizationUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: 'https://auth.example.com/token',
          callbackUrl: 'https://app.example.com/callback',
          scope
        }
      }
    }
  });

  // No-throw checks for all 3 grant types affected by BRU-3297.
  describe.each([
    'authorization_code',
    'password',
    'client_credentials'
  ])('grant type %s', (grantType) => {
    it(`should not throw when scope is null`, () => {
      const items = [makeOauth2Item(grantType, null)];
      expect(() => toYaml(exportApiSpec('Test', items, {}))).not.toThrow();
    });

    it(`should not throw when scope is undefined`, () => {
      const items = [makeOauth2Item(grantType, undefined)];
      expect(() => toYaml(exportApiSpec('Test', items, {}))).not.toThrow();
    });
  });

  describe.each([
    ['authorization_code', 'authorizationCode'],
    ['password', 'password']
  ])('grant type %s emits valid scopes object', (grantType, flowKey) => {
    it(`should emit empty scopes object when scope is null (OpenAPI 3.0 requires scopes key)`, () => {
      const items = [makeOauth2Item(grantType, null)];
      const { content } = toYaml(exportApiSpec('Test', items, {}));
      expect(content).toContain(`${flowKey}:`);
      expect(content).toMatch(new RegExp(`${flowKey}:[\\s\\S]*?scopes:\\s*{}`));
    });

    it(`should emit empty scopes object when scope is empty string`, () => {
      const items = [makeOauth2Item(grantType, '')];
      const { content } = toYaml(exportApiSpec('Test', items, {}));
      expect(content).toMatch(new RegExp(`${flowKey}:[\\s\\S]*?scopes:\\s*{}`));
    });

    it(`should emit scope entry when scope is a non-empty string`, () => {
      const items = [makeOauth2Item(grantType, 'openid')];
      const { content } = toYaml(exportApiSpec('Test', items, {}));
      expect(content).toContain('openid:');
    });
  });
});

describe('exportApiSpec - non-HTTP request type filtering', () => {
  it('should keep only http-request and graphql-request items and not crash on others', () => {
    const items = [
      {
        name: 'HTTP Request',
        type: 'http-request',
        pathname: 'folder/http',
        depth: 2,
        request: {
          url: 'https://api.example.com/http',
          method: 'GET',
          params: [],
          headers: [],
          body: {},
          auth: {}
        },
        examples: []
      },
      {
        name: 'GraphQL Request',
        type: 'graphql-request',
        pathname: 'folder/graphql',
        depth: 2,
        request: {
          url: 'https://api.example.com/graphql',
          method: 'POST',
          params: [],
          headers: [],
          body: {},
          auth: {}
        },
        examples: []
      },
      {
        name: 'gRPC Request',
        type: 'grpc-request',
        request: { url: 'grpc://example.com/service' }
      },
      {
        name: 'WebSocket Request',
        type: 'ws-request',
        request: { url: 'wss://example.com/socket' }
      },
      {
        name: 'Folder',
        type: 'folder',
        items: []
      },
      {
        name: 'script.js',
        type: 'js'
      },
      {
        name: 'Transient',
        type: 'http-request',
        isTransient: true,
        pathname: 'folder/transient',
        depth: 2,
        request: {
          url: 'https://api.example.com/transient',
          method: 'GET',
          params: [],
          headers: [],
          body: {},
          auth: {}
        },
        examples: []
      }
    ];

    let result;
    expect(() => {
      result = toYaml(exportApiSpec('Test API', items, {}));
    }).not.toThrow();

    const spec = require('js-yaml').load(result.content);
    const pathKeys = Object.keys(spec.paths);

    expect(pathKeys).toHaveLength(2);
    expect(spec.paths['/http']).toBeDefined();
    expect(spec.paths['/http'].get).toBeDefined();
    expect(spec.paths['/graphql']).toBeDefined();
    expect(spec.paths['/graphql'].post).toBeDefined();
    expect(spec.paths['/transient']).toBeUndefined();
  });
});

describe('exportApiSpec - descriptions', () => {
  it('includes header and query param descriptions in the OpenAPI output', () => {
    const items = [
      {
        name: 'Described Request',
        type: 'http-request',
        request: {
          url: 'https://example.com/users',
          method: 'GET',
          params: [
            { name: 'q', value: 'search', enabled: true, type: 'query', description: 'Search query' }
          ],
          headers: [
            { name: 'X-Version', value: '2', enabled: true, description: 'API version header' }
          ],
          body: {},
          auth: {}
        }
      }
    ];

    const { content } = toYaml(exportApiSpec('Described API', items, {}));
    const spec = require('js-yaml').load(content);
    const operation = spec.paths['/users'].get;

    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'q', in: 'query', description: 'Search query' }),
        expect.objectContaining({ name: 'X-Version', in: 'header', description: 'API version header' })
      ])
    );
  });
});

describe('exportApiSpec - collections that do not have any requests in them', () => {
  it('still produces a usable spec file when the collection has no requests in it yet', () => {
    const result = toYaml(exportApiSpec('EmptyColl', [], {}, keyByName([])));
    const spec = jsyaml.load(result.content);
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info).toEqual({ title: 'EmptyColl', version: '1.0.0' });
    expect(spec.paths).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('keeps the server addresses from each environment even when there are no requests', () => {
    const result = toYaml(exportApiSpec(
      'EmptyColl',
      [],
      { baseUrl: 'https://api.test' },
      keyByName([{ name: 'Local', variables: [{ name: 'baseUrl', value: 'https://local.test', enabled: true }] }])
    ));
    const spec = jsyaml.load(result.content);
    expect(spec.paths).toEqual({});
    expect(spec.servers.map((server) => server.url)).toEqual(['https://api.test', 'https://local.test']);
  });

  it('treats a collection that only contains folders as having no requests', () => {
    const result = toYaml(exportApiSpec(
      'FoldersOnly',
      [{ type: 'folder', name: 'A' }],
      {},
      keyByName([])
    ));
    expect(jsyaml.load(result.content).paths).toEqual({});
  });

  it('refuses to guess when the list of requests is missing altogether', () => {
    expect(() => toYaml(exportApiSpec('NoList', undefined, {}, keyByName([])))).toThrow();
  });
});

describe('exportApiSpec - a variable that could not be resolved', () => {
  const itemWithUrl = (url) => ({
    name: 'Request',
    type: 'http-request',
    request: { url, method: 'GET', params: [], headers: [], body: {}, auth: {} }
  });

  const pathsIn = (content) =>
    String(content)
      .split('\n')
      .filter((line) => /^ {2}\//.test(line))
      .map((line) => line.trim().replace(/:$/, ''));

  it('leaves the placeholder readable in the path instead of percent encoding its braces', () => {
    const { content } = toYaml(exportApiSpec(
      'Test API',
      [itemWithUrl('https://other.test/api/v1/{{secret-var}}/github')],
      { baseUrl: 'https://api.test' }
    ));

    expect(pathsIn(content)).toEqual(['/api/v1/{secret-var}/github']);
    expect(content).not.toContain('%7B');
  });

  it('writes the placeholder the same way whether or not the url starts with the base url', () => {
    const viaBaseUrl = toYaml(exportApiSpec(
      'Test API',
      [itemWithUrl('{{baseUrl}}/api/v1/{{secret-var}}/github')],
      { baseUrl: 'https://api.test' }
    ));
    const viaLiteralHost = toYaml(exportApiSpec(
      'Test API',
      [itemWithUrl('https://other.test/api/v1/{{secret-var}}/github')],
      { baseUrl: 'https://api.test' }
    ));

    expect(pathsIn(viaLiteralHost.content)).toEqual(pathsIn(viaBaseUrl.content));
  });

  it('keeps a character the user genuinely encoded, which still means what it meant', () => {
    const { content } = toYaml(exportApiSpec(
      'Test API',
      [itemWithUrl('https://other.test/api/v1/a%20b')],
      { baseUrl: 'https://api.test' }
    ));

    expect(pathsIn(content)).toEqual(['/api/v1/a%20b']);
  });
});

describe('exportApiSpec - secrets and other placeholders left unfilled', () => {
  const itemWithUrl = (url, request = {}) => ({
    name: 'Request',
    type: 'http-request',
    pathname: path.join('collection', 'Request.bru'),
    depth: 1,
    request: { url, method: 'GET', params: [], headers: [], body: {}, auth: {}, ...request }
  });

  const exportUrl = (url, { variables = {}, environments, request } = {}) => {
    const { content } = toYaml(exportApiSpec('Test API', [itemWithUrl(url, request)], variables, keyByName(environments)));
    const spec = jsyaml.load(content);
    const [specPath] = Object.keys(spec.paths);
    return { content, spec, specPath, operation: spec.paths[specPath].get };
  };

  const pathParam = (name) => ({ name, in: 'path', required: true, example: `{{${name}}}`, schema: { type: 'string' } });
  const withSecrets = (...names) => [{ name: 'local', variables: names.map((name) => ({ name, value: '', enabled: true, secret: true })) }];

  const expectValidSpec = async (content) => {
    await expect(SwaggerParser.validate(jsyaml.load(content))).resolves.toBeDefined();

    Object.entries(jsyaml.load(content).paths).forEach(([specPath, pathItem]) => {
      expect(isValidPathTemplate(specPath)).toBe(true);
      const templateNames = [...specPath.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
      Object.values(pathItem).forEach((operation) => {
        const declared = (operation.parameters || []).filter((p) => p.in === 'path').map((p) => p.name);
        templateNames.forEach((name) => expect(declared).toContain(name));
      });
    });
  };

  it('turns a secret left in a request path into a path parameter with its placeholder as the example', async () => {
    const { content, specPath, operation } = exportUrl('https://test.com/{{secvar}}/{{var}}', { variables: { var: 'env-var-value' } });

    expect(specPath).toBe('/{secvar}/env-var-value');
    expect(operation.servers).toEqual([{ url: 'https://test.com' }]);
    expect(operation.parameters).toEqual([pathParam('secvar')]);
    await expectValidSpec(content);
  });

  it('gives every secret in the path its own path parameter and still fills in normal variables', async () => {
    const { content, specPath, operation } = exportUrl('https://hooks.test/{{$secrets.vault.token}}/x/{{secret1}}/y/{{variable}}', {
      variables: { variable: 'abc' }
    });

    expect(specPath).toBe('/{$secrets.vault.token}/x/{secret1}/y/abc');
    expect(operation.parameters).toEqual([pathParam('$secrets.vault.token'), pathParam('secret1')]);
    await expectValidSpec(content);
  });

  it('turns placeholders in a base url request path into path parameters', async () => {
    const { content, specPath, operation } = exportUrl('{{baseUrl}}/users/{{id}}/orders', { variables: { baseUrl: 'https://api.test' } });

    expect(specPath).toBe('/users/{id}/orders');
    expect(operation.parameters).toEqual([pathParam('id')]);
    await expectValidSpec(content);
  });

  it('fills request variables into a request level base url override path and leaves secrets as path parameters', async () => {
    const { content, specPath, operation } = exportUrl('{{baseUrl}}/files/{{folder}}/{{secret}}', {
      variables: { baseUrl: 'https://api.test' },
      request: {
        vars: {
          req: [
            { name: 'baseUrl', value: 'https://files.test', enabled: true },
            { name: 'folder', value: 'request-value', enabled: true }
          ]
        }
      }
    });

    expect(specPath).toBe('/files/request-value/{secret}');
    expect(operation.servers).toEqual([{ url: 'https://files.test' }]);
    expect(operation.parameters).toEqual([pathParam('secret')]);
    await expectValidSpec(content);
  });

  it('declares a repeated placeholder once and does not repeat a path param from the params list', () => {
    const { operation } = exportUrl('https://api.test/{{id}}/{{id}}/{{userId}}', {
      request: { params: [{ name: 'userId', value: '7', type: 'path', enabled: true }] }
    });

    expect(operation.parameters.filter((p) => p.in === 'path').map((p) => p.name)).toEqual(['userId', 'id']);
  });

  it('writes a secret used in an environment base url as its placeholder text', async () => {
    const environments = [{
      name: 'Prod',
      variables: [
        { name: 'baseUrl', value: 'https://{{region}}.api.test/{{apiKey}}', enabled: true },
        { name: 'region', value: 'eu', enabled: true },
        { name: 'apiKey', value: 'decrypted-secret', enabled: true, secret: true }
      ]
    }];

    const { content, spec } = exportUrl('{{baseUrl}}/users', { environments });

    expect(spec.servers).toEqual([{
      url: 'https://{region}.api.test/{apiKey}',
      variables: { region: { default: 'eu' }, apiKey: { default: '{{apiKey}}' } },
      description: 'Prod'
    }]);
    expect(content).not.toContain('decrypted-secret');
    await expectValidSpec(content);
  });

  it('exports an environment whose base url is itself a secret as a placeholder server', async () => {
    const environments = [
      { name: 'Prod', variables: [{ name: 'baseUrl', value: 'https://secret-host.test', enabled: true, secret: true }] },
      { name: 'Staging', variables: [{ name: 'baseUrl', value: 'https://staging.test', enabled: true }] }
    ];

    const { content, spec } = exportUrl('{{baseUrl}}/users', { environments });

    expect(spec.servers).toEqual([
      { url: '{baseUrl}', variables: { baseUrl: { default: '{{baseUrl}}' } }, description: 'Prod' },
      { url: 'https://staging.test', description: 'Staging' }
    ]);
    expect(content).not.toContain('secret-host');
    await expectValidSpec(content);
  });

  it('keeps the spelling of a secret left in a request host and writes its placeholder text as the default', async () => {
    const { content, operation } = exportUrl('https://{{tenantToken}}.api.test:{{port}}/data', { variables: { port: '8443' }, environments: withSecrets('tenantToken') });

    expect(operation.servers).toEqual([{
      url: 'https://{tenantToken}.api.test:8443',
      variables: { tenantToken: { default: '{{tenantToken}}' } }
    }]);
    await expectValidSpec(content);
  });

  it('uses a secret at the start of the url as the server', async () => {
    const { content, specPath, operation } = exportUrl('{{apiHost}}/users/{{id}}', { environments: withSecrets('apiHost') });

    expect(specPath).toBe('/users/{id}');
    expect(operation.servers).toEqual([{ url: '{apiHost}', variables: { apiHost: { default: '{{apiHost}}' } } }]);
    expect(operation.parameters).toEqual([pathParam('id')]);
    await expectValidSpec(content);
  });

  it('keeps a port after a secret at the start of the url in the server', async () => {
    const { content, specPath, operation } = exportUrl('{{apiHost}}:8080/users#top');

    expect(specPath).toBe('/users');
    expect(operation.servers[0].url).toBe('{apiHost}:8080');
    await expectValidSpec(content);
  });

  it('leaves the query string out of the path and exports query params that are only in the url', () => {
    const { specPath, operation } = exportUrl('{{baseUrl}}/users?key={{apiKey}}&page=1&page=2', { variables: { baseUrl: 'https://api.test' } });

    expect(specPath).toBe('/users');
    expect(isValidPathTemplate(specPath)).toBe(true);
    expect(operation.parameters).toEqual([
      { name: 'key', in: 'query', description: '', required: true, example: '{{apiKey}}' },
      { name: 'page', in: 'query', description: '', required: true, example: '1' }
    ]);
  });

  it('exports a query param written without a value as an empty one and ignores the fragment', () => {
    const { operation } = exportUrl('https://api.test/x?flag&q=a=b#section');

    expect(operation.parameters.map((param) => [param.name, param.example])).toEqual([['flag', ''], ['q', 'a=b']]);
  });

  it('does not repeat a query param that is already in the params list', () => {
    const { operation } = exportUrl('https://api.test/x?page=1&q=find', {
      request: { params: [{ name: 'page', value: '1', type: 'query', enabled: true }] }
    });

    expect(operation.parameters.map((p) => [p.name, p.in])).toEqual([['page', 'query'], ['q', 'query']]);
  });

  it('writes the placeholder text as the server default when the environment has a secret and a plain variable of the same name', () => {
    const environments = [{
      name: 'Prod',
      variables: [
        { name: 'baseUrl', value: 'https://api.test/{{apiKey}}', enabled: true },
        { name: 'apiKey', value: 'decrypted-secret', enabled: true, secret: true },
        { name: 'apiKey', value: 'plain-value', enabled: true }
      ]
    }];

    const { content, spec } = exportUrl('{{baseUrl}}/users', { environments });

    expect(spec.servers[0].variables).toEqual({ apiKey: { default: '{{apiKey}}' } });
    expect(content).not.toContain('plain-value');
  });

  it('takes the host spelling only from the host, not from a placeholder in the path', () => {
    const { operation } = exportUrl('https://{{Tenant}}.api.test/{{alias}}', { variables: { alias: '{{tenant}}' }, environments: withSecrets('Tenant') });

    expect(operation.servers).toEqual([{ url: 'https://{Tenant}.api.test', variables: { Tenant: { default: '{{Tenant}}' } } }]);
  });

  it('keeps OAuth2 and process env placeholders out of the path and host as valid placeholders', async () => {
    const { content, specPath, operation } = exportUrl('https://{{process.env.HOST}}/x/{{$oauth2.cred.access_token}}');

    expect(specPath).toBe('/x/{$oauth2.cred.access_token}');
    expect(operation.servers).toEqual([{
      url: 'https://{process.env.HOST}',
      variables: { 'process.env.HOST': { default: '{{process.env.HOST}}' } }
    }]);
    expect(operation.parameters).toEqual([pathParam('$oauth2.cred.access_token')]);
    await expectValidSpec(content);
  });

  it('keeps the spelling of a secret that reaches the host through another variable', async () => {
    const { content, operation } = exportUrl('{{apiRoot}}/data', { variables: { apiRoot: 'https://{{tenantSecret}}.api.test' }, environments: withSecrets('tenantSecret') });

    expect(operation.servers).toEqual([{
      url: 'https://{tenantSecret}.api.test',
      variables: { tenantSecret: { default: '{{tenantSecret}}' } }
    }]);
    await expectValidSpec(content);
  });

  it('never fills in a secret, even when the caller passes its value', async () => {
    const { content, specPath, operation } = exportUrl('https://test.com/{{secvar}}/{{process.env.TOKEN}}/{{$secrets.vault.token}}/{{$oauth2.cred.access_token}}', {
      variables: {
        'secvar': 'leaked-env-secret',
        'process.env.TOKEN': 'leaked-dotenv-secret',
        'process': { env: { TOKEN: 'leaked-nested-dotenv-secret' } },
        '$secrets.vault.token': 'leaked-vault-secret',
        '$secrets': { vault: { token: 'leaked-nested-vault-secret' } },
        '$oauth2.cred.access_token': 'leaked-oauth2-secret'
      },
      environments: withSecrets('secvar')
    });

    expect(content).not.toMatch(/leaked-/);
    expect(specPath).toBe('/{secvar}/{process.env.TOKEN}/{$secrets.vault.token}/{$oauth2.cred.access_token}');
    expect(operation.parameters.map((param) => param.name)).toEqual(['secvar', 'process.env.TOKEN', '$secrets.vault.token', '$oauth2.cred.access_token']);
    await expectValidSpec(content);
  });

  it('never writes a secret passed by the caller into a server default', () => {
    const { content } = exportUrl('{{baseUrl}}/x', {
      variables: { baseUrl: 'https://{{apiKey}}.api.test', apiKey: 'leaked-api-key' },
      environments: withSecrets('apiKey')
    });

    expect(content).not.toContain('leaked-api-key');
    expect(jsyaml.load(content).servers.find((server) => server.description === 'Base Server').variables).toEqual({ apiKey: { default: '{{apiKey}}' } });
  });

  it('re-imports placeholders Bruno fills in itself without a variable that would hide them', () => {
    const environments = [{ name: 'Prod', variables: [{ name: 'baseUrl', value: 'https://{{process.env.HOST}}/{{$secrets.vault.path}}', enabled: true }] }];
    const { content } = toYaml(exportApiSpec('Test API', [itemWithUrl('{{baseUrl}}/data')], {}, keyByName(environments)));

    const environment = openApiToBruno(jsyaml.load(content)).environments.find((env) => env.name === 'Prod');
    expect(environment.variables.map((v) => [v.name, v.value])).toEqual([['baseUrl', 'https://{{process.env.HOST}}/{{$secrets.vault.path}}']]);
  });

  it('re-imports a secret from a request host as an empty secret in every environment', () => {
    const environments = [
      { name: 'Prod', variables: [{ name: 'baseUrl', value: 'https://api.test', enabled: true }] },
      { name: 'Staging', variables: [{ name: 'baseUrl', value: 'https://staging.test', enabled: true }] }
    ];
    const { content } = toYaml(exportApiSpec('Test API', [itemWithUrl('https://{{tenantSecret}}.other.test/data')], {}, keyByName([...environments, ...withSecrets('tenantSecret')])));

    openApiToBruno(jsyaml.load(content)).environments
      .filter((env) => ['Prod', 'Staging'].includes(env.name))
      .forEach((env) => expect(env.variables.find((v) => v.name === 'tenantSecret')).toMatchObject({ value: '', secret: true }));
  });

  it('re-imports into Bruno with secrets still pointing at the variables they came from', () => {
    const environments = [{
      name: 'Prod',
      variables: [
        { name: 'baseUrl', value: 'https://{{region}}.api.test/{{apiKey}}', enabled: true },
        { name: 'region', value: 'eu', enabled: true },
        { name: 'apiKey', value: 'decrypted-secret', enabled: true, secret: true },
        { name: 'tenantToken', value: '', enabled: true, secret: true }
      ]
    }];
    const { content } = toYaml(exportApiSpec(
      'Test API',
      [
        itemWithUrl('https://test.com/{{secvar}}/{{var}}'),
        { ...itemWithUrl('https://{{tenantToken}}.api.test/data'), name: 'Tenant', pathname: path.join('collection', 'Tenant.bru') }
      ],
      { var: 'env-var-value' },
      keyByName(environments)
    ));

    const collection = openApiToBruno(jsyaml.load(content));
    const [request, tenant] = collection.items;

    expect(request.request.url).toBe('{{baseUrl}}/:secvar/env-var-value');
    expect(request.request.params.filter((p) => p.type === 'path').map((p) => [p.name, p.value])).toEqual([['secvar', '{{secvar}}']]);
    expect(tenant.request.vars.req.map((v) => [v.name, v.value])).toEqual([['baseUrl', 'https://{{tenantToken}}.api.test']]);
    expect(collection.environments[0].variables.find((v) => v.name === 'apiKey')).toMatchObject({ value: '', secret: true });
  });
});

describe('exportApiSpec - export invariants across url shapes', () => {
  // Every secret below has a value on purpose, so a leak shows up as one of these strings
  const SECRET_VALUE = /secret-value/;
  const environments = [{
    name: 'local',
    variables: [
      { name: 'secvar', value: 'secret-value-secvar', enabled: true, secret: true },
      { name: 'apiKey', value: 'secret-value-apikey', enabled: true, secret: true },
      { name: 'tenantSecret', value: 'secret-value-tenant', enabled: true, secret: true },
      { name: 'secretPort', value: 'secret-value-port', enabled: true, secret: true },
      { name: 'region', value: 'secret-value-region', enabled: true, secret: true },
      { name: 'pass', value: 'secret-value-pass', enabled: true, secret: true },
      { name: 'var', value: 'env-var-value', enabled: true }
    ]
  }];
  const declaredSecrets = environments[0].variables.filter((v) => v.secret).map((v) => v.name);
  const variables = { baseUrl: 'https://api.test', var: 'env-var-value' };

  const request = (url, params = []) => ({ url, params });
  const idParam = [{ name: 'id', value: '1', type: 'path', enabled: true }];

  const exportRequests = (requests) => {
    const items = requests.map(({ url, params }, index) => ({
      name: `Request ${index + 1}`,
      type: 'http-request',
      pathname: path.join('collection', `Request ${index + 1}.bru`),
      depth: 1,
      request: { url, method: 'GET', params, headers: [], body: {}, auth: {} }
    }));
    const { content } = toYaml(exportApiSpec('Test API', items, variables, keyByName(environments)));
    return { content, spec: jsyaml.load(content) };
  };

  const operationsOf = (spec) =>
    Object.entries(spec.paths).flatMap(([specPath, pathItem]) =>
      Object.values(pathItem).flatMap((operation) => [operation, ...(operation['x-bruno-variants'] || [])].map((op) => ({ specPath, op }))));

  const expectInvariants = async ({ content, spec }, { requestCount, hasSchemalessParams }) => {
    expect(content).not.toMatch(SECRET_VALUE);

    const operations = operationsOf(spec);
    expect(operations).toHaveLength(requestCount);

    operations.forEach(({ specPath, op }) => {
      expect(specPath.startsWith('/')).toBe(true);
      expect(isValidPathTemplate(specPath)).toBe(true);
      const templateNames = [...new Set([...specPath.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]))].sort();
      const declaredNames = (op.parameters || []).filter((p) => p.in === 'path').map((p) => p.name).sort();
      expect(declaredNames).toEqual(templateNames);
    });

    [...(spec.servers || []), ...operations.flatMap(({ op }) => op.servers || [])].forEach((server) => {
      expect(server.url).not.toBe('null');
      expect(server.url).not.toContain('{{');
      [...server.url.matchAll(/\{([^{}]+)\}/g)].forEach(([, name]) => expect(typeof server.variables?.[name]?.default).toBe('string'));
    });

    // OSS query, header and params-list path params carry no schema yet, which swagger-parser rejects
    if (!hasSchemalessParams) {
      await expect(SwaggerParser.validate(jsyaml.load(content))).resolves.toBeDefined();
    }

    const reimported = openApiToBruno(jsyaml.load(content));
    reimported.environments.forEach((environment) => environment.variables
      .filter((v) => v.secret)
      .forEach((v) => expect(declaredSecrets).toContain(v.name)));
  };

  const rows = [
    ['a secret and a variable in the path', [request('https://test.com/{{secvar}}/{{var}}')], { paths: ['/{secvar}/env-var-value'], server: { url: 'https://test.com' } }],
    ['prompt variables stay in the path and keep two requests apart', [request('{{baseUrl}}/users/{{?User Id}}'), request('{{baseUrl}}/users/{{?User Id}}/posts')], { paths: ['/users/{?User Id}', '/users/{?User Id}/posts'] }],
    ['a secret port', [request('http://localhost:{{secretPort}}/api/users')], { paths: ['/api/users'], server: { url: 'http://localhost:{secretPort}', variables: { secretPort: { default: '{{secretPort}}' } } } }],
    ['a secret port after a host', [request('https://api.test:{{secretPort}}/data')], { paths: ['/data'], server: { url: 'https://api.test:{secretPort}', variables: { secretPort: { default: '{{secretPort}}' } } } }],
    ['a secret at the start with a bruno path param', [request('{{apiKey}}/users/:id', idParam)], { paths: ['/users/{id}'], server: { url: '{apiKey}', variables: { apiKey: { default: '{{apiKey}}' } } }, hasSchemalessParams: true }],
    ['a base url with a bruno path param', [request('{{baseUrl}}/users/:id', idParam)], { paths: ['/users/{id}'], hasSchemalessParams: true }],
    ['a literal port after the base url host is not mistaken for the base url', [request('https://api.test:8443/data')], { paths: ['/data'], server: { url: 'https://api.test:8443' } }],
    ['a url without a scheme and a secret in the host', [request('api-{{region}}.test/x')], { paths: ['/x'], server: { url: 'api-{region}.test', variables: { region: { default: '{{region}}' } } } }],
    ['a url without a scheme and a secret port', [request('localhost:{{secretPort}}/x')], { paths: ['/x'], server: { url: 'localhost:{secretPort}', variables: { secretPort: { default: '{{secretPort}}' } } } }],
    ['a plain url without a scheme', [request('localhost:8080/items')], { paths: ['/items'], server: { url: 'localhost:8080' } }],
    ['secrets and prompt variables in the query', [request('{{baseUrl}}/search?key={{secvar}}&q={{?Search term}}')], { paths: ['/search'], hasSchemalessParams: true }],
    ['a secret in the host keeps its spelling', [request('https://{{tenantSecret}}.api.test/data')], { paths: ['/data'], server: { url: 'https://{tenantSecret}.api.test', variables: { tenantSecret: { default: '{{tenantSecret}}' } } } }],
    ['credentials with a secret are dropped from the server', [request('https://user:{{pass}}@api.test/z')], { paths: ['/z'], server: { url: 'https://api.test' } }],
    ['an unknown variable at the start', [request('{{nope}}/ping')], { paths: ['/ping'], server: { url: '{nope}', variables: { nope: { default: '' } } } }],
    ['a relative url with a secret', [request('/relative/{{secvar}}')], { paths: ['/relative/{secvar}'] }],
    ['a secret scheme', [request('{{secvar}}://api.test/users')], { paths: ['/users'], server: { url: '{secvar}://api.test', variables: { secvar: { default: '{{secvar}}' } } } }],
    ['a process env scheme', [request('{{process.env.PROTOCOL}}://api.test/users')], { paths: ['/users'], server: { url: '{process.env.PROTOCOL}://api.test', variables: { 'process.env.PROTOCOL': { default: '{{process.env.PROTOCOL}}' } } } }]
  ];

  it.each(rows)('%s', async (label, requests, expected) => {
    const exported = exportRequests(requests);

    expect(Object.keys(exported.spec.paths)).toEqual(expected.paths);
    if (expected.server) {
      expect(operationsOf(exported.spec)[0].op.servers).toEqual([expected.server]);
    }
    await expectInvariants(exported, { requestCount: requests.length, hasSchemalessParams: expected.hasSchemalessParams });
  });

  it('exports query params from a url with a prompt variable without inventing new ones', () => {
    const { spec } = exportRequests([request('{{baseUrl}}/search?key={{secvar}}&q={{?Search term}}')]);

    expect(operationsOf(spec)[0].op.parameters.map((p) => [p.in, p.name, p.example])).toEqual([
      ['query', 'key', '{{secvar}}'],
      ['query', 'q', '{{?Search term}}']
    ]);
  });

  it.each([
    ['https://slash.test/', 'https://slash.test/users', '/users'],
    ['https://slash.test/api/', 'https://slash.test/api/users', '/users'],
    ['https://slash.test/', 'https://slash.test/', '/']
  ])('treats a request under the base url %s as a path on the root server', (baseUrl, url, expectedPath) => {
    const items = [{ name: 'Request', type: 'http-request', pathname: path.join('collection', 'Request.bru'), depth: 1, request: { url, method: 'GET', params: [], headers: [], body: {}, auth: {} } }];
    const slashEnvironments = [{ name: 'local', variables: [{ name: 'baseUrl', value: baseUrl, enabled: true }] }];
    const spec = jsyaml.load(toYaml(exportApiSpec('Test API', items, {}, keyByName(slashEnvironments))).content);

    expect(Object.keys(spec.paths)).toEqual([expectedPath]);
    expect(spec.paths[expectedPath].get.servers).toBeUndefined();
  });

  it('gives a request that only shares a prefix with the base url its own server', () => {
    const items = [{ name: 'Request', type: 'http-request', pathname: path.join('collection', 'Request.bru'), depth: 1, request: { url: 'https://slash.test/apiusers', method: 'GET', params: [], headers: [], body: {}, auth: {} } }];
    const prefixEnvironments = [{ name: 'local', variables: [{ name: 'baseUrl', value: 'https://slash.test/api', enabled: true }] }];
    const spec = jsyaml.load(toYaml(exportApiSpec('Test API', items, {}, keyByName(prefixEnvironments))).content);

    expect(spec.paths['/apiusers'].get.servers).toEqual([{ url: 'https://slash.test' }]);
  });

  it('keeps an empty default for a plain collection variable used in an environment base url', () => {
    const items = [{ name: 'Request', type: 'http-request', pathname: path.join('collection', 'Request.bru'), depth: 1, request: { url: '{{baseUrl}}/x', method: 'GET', params: [], headers: [], body: {}, auth: {} } }];
    const plainEnvironments = [{ name: 'local', variables: [{ name: 'baseUrl', value: 'https://api.test/{{apiVersion}}', enabled: true }] }];
    const { content } = toYaml(exportApiSpec('Test API', items, { apiVersion: 'v2' }, keyByName(plainEnvironments)));

    const localServer = jsyaml.load(content).servers.find((server) => server.description === 'local');
    expect(localServer.variables).toEqual({ apiVersion: { default: '' } });

    const reimported = openApiToBruno(jsyaml.load(content)).environments.find((e) => e.name === 'local');
    expect(reimported.variables.find((v) => v.name === 'apiVersion')).toMatchObject({ value: '', secret: false });
  });
});

// The blocks below record today's output, known bugs included (BRU-3523, B7 test gaps). A later fix must change
// them on purpose, with the new behaviour written first.

const gapItem = (name, request = {}, item = {}) => ({
  name,
  type: 'http-request',
  pathname: path.join('collection', `${name}.bru`),
  depth: 1,
  request: { url: '{{baseUrl}}/things', method: 'POST', params: [], headers: [], body: {}, auth: {}, ...request },
  ...item
});

const exportGapItems = (items, { collectionVariables = { baseUrl: 'https://api.test' }, envVariables, selectedEnvironment, name = 'Gap API' } = {}) => {
  const { content, warnings } = toYaml(exportApiSpec(name, items, collectionVariables, envVariables, selectedEnvironment));
  return { spec: jsyaml.load(content), warnings };
};

describe('exportApiSpec - request bodies today', () => {
  it('warns about invalid json and still writes an empty object schema for it', () => {
    const { spec, warnings } = exportGapItems([gapItem('Broken Json', { body: { mode: 'json', json: '{ "name": ' } })]);

    expect(warnings).toEqual([
      { message: expect.stringMatching(/^Failed to parse JSON in request body: /), itemName: 'Broken Json' }
    ]);
    expect(spec.paths['/things'].post.requestBody).toEqual({ $ref: '#/components/requestBodies/broken_json' });
    expect(spec.components.schemas.broken_json).toEqual({ type: 'object', properties: {} });
    expect(spec.components.requestBodies.broken_json).toEqual({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/broken_json' } } },
      description: '',
      required: true
    });
  });

  it('builds an xml body schema from the parsed xml, with every leaf as a string', () => {
    const { spec, warnings } = exportGapItems([
      gapItem('Xml User', { body: { mode: 'xml', xml: '<user>\n  <name>Ada</name>\n  <age>36</age>\n</user>' } })
    ]);

    expect(warnings).toEqual([]);
    expect(spec.paths['/things'].post.requestBody).toEqual({ $ref: '#/components/requestBodies/xml_user' });
    expect(spec.components.schemas.xml_user).toEqual({
      type: 'object',
      properties: {
        user: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'string' } } }
      },
      example: { user: { name: 'Ada', age: '36' } }
    });
    expect(spec.components.requestBodies.xml_user).toEqual({
      content: { 'application/xml': { schema: { $ref: '#/components/schemas/xml_user' } } },
      description: '',
      required: true
    });
  });

  it('warns about invalid xml and writes no body or component for it', () => {
    const { spec, warnings } = exportGapItems([gapItem('Broken Xml', { body: { mode: 'xml', xml: '<user><name>Ada</user>' } })]);

    expect(warnings).toEqual([
      { message: expect.stringMatching(/^Failed to parse XML in request body: /), itemName: 'Broken Xml' }
    ]);
    expect(spec.paths['/things'].post.requestBody).toBeUndefined();
    expect(spec.components).toEqual({ schemas: {}, requestBodies: {}, securitySchemes: {} });
  });

  it('writes a text body inline as text/plain, without a component or required flag', () => {
    const { spec } = exportGapItems([gapItem('Plain Note', { body: { mode: 'text', text: 'Remember the milk' } })]);

    expect(spec.paths['/things'].post.requestBody).toEqual({ content: { 'text/plain': { schema: { type: 'string' } } } });
    expect(spec.components.requestBodies).toEqual({});
  });

  it.each([
    ['mode none', { mode: 'none' }],
    ['no body at all', undefined],
    ['an empty json body', { mode: 'json', json: '' }],
    ['an empty text body', { mode: 'text', text: '' }],
    ['a graphql body', { mode: 'graphql', graphql: { query: '{ users { id } }', variables: '' } }]
  ])('writes no request body for %s', (_label, body) => {
    const { spec, warnings } = exportGapItems([gapItem('No Body', { body })]);

    expect(spec.paths['/things'].post.requestBody).toBeUndefined();
    expect(spec.components.requestBodies).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe('exportApiSpec - auth schemes today', () => {
  const withAuth = (name, auth) => gapItem(name, { auth });

  it('exports an oauth2 client_credentials grant as a password flow', () => {
    const { spec } = exportGapItems([
      withAuth('Service Token', {
        mode: 'oauth2',
        oauth2: { grantType: 'client_credentials', accessTokenUrl: 'https://auth.test/token', scope: 'jobs' }
      })
    ]);

    expect(spec.components.securitySchemes.service_token).toEqual({
      type: 'oauth2',
      flows: { password: { tokenUrl: 'https://auth.test/token', scopes: { jobs: '' } } }
    });
    expect(spec.paths['/things'].post.security).toEqual({ service_token: [] });
  });

  it('drops an oauth2 implicit grant but still reserves its component id', () => {
    const { spec } = exportGapItems([
      withAuth('Login', {
        mode: 'oauth2',
        oauth2: { grantType: 'implicit', authorizationUrl: 'https://auth.test/authorize', callbackUrl: 'https://app.test/cb', scope: 'read' }
      }),
      gapItem('Login', { url: '{{baseUrl}}/other', auth: { mode: 'bearer', bearer: { token: 't' } } })
    ]);

    expect(spec.paths['/things'].post.security).toBeUndefined();
    expect(spec.components.securitySchemes).toEqual({ login_1: { type: 'http', scheme: 'bearer' } });
    expect(spec.paths['/other'].post.security).toEqual({ login_1: [] });
  });

  it('exports awsv4 as an api key in the Authorization header with the amazon auth type extension', () => {
    const { spec } = exportGapItems([
      withAuth('Signed', { mode: 'awsv4', awsv4: { accessKeyId: 'AKIA', secretAccessKey: 's', service: 's3', region: 'us-east-1' } })
    ]);

    expect(spec.components.securitySchemes.signed).toEqual({
      'type': 'apiKey',
      'name': 'Authorization',
      'in': 'header',
      'x-amazon-apigateway-authtype': 'awsSigv4'
    });
    expect(spec.paths['/things'].post.security).toEqual({ signed: [] });
  });

  it('exports digest with type digest', () => {
    const { spec } = exportGapItems([withAuth('Digest', { mode: 'digest', digest: { username: 'ada', password: 'p' } })]);

    expect(spec.components.securitySchemes.digest).toEqual({ type: 'digest', scheme: 'digest', description: 'Digest Authentication' });
    expect(spec.paths['/things'].post.security).toEqual({ digest: [] });
  });

  it.each([
    ['apikey', { mode: 'apikey', apikey: { key: 'X-Api-Key', value: 'k', placement: 'header' } }],
    ['inherit', { mode: 'inherit' }],
    ['ntlm', { mode: 'ntlm', ntlm: { username: 'ada', password: 'p', domain: 'd' } }],
    ['wsse', { mode: 'wsse', wsse: { username: 'ada', password: 'p' } }]
  ])('does not export %s auth', (_label, auth) => {
    const { spec } = exportGapItems([withAuth('Unexported', auth)]);

    expect(spec.paths['/things'].post.security).toBeUndefined();
    expect(spec.components.securitySchemes).toEqual({});
  });
});

describe('exportApiSpec - identity and tags today', () => {
  it('builds the operation id from an absolute pathname, machine path and file extension included', () => {
    const pathname = path.join(path.sep, 'home', 'dev', 'My Collection', 'users', 'Get User.bru');
    const { spec } = exportGapItems([gapItem('Get User', { method: 'GET' }, { pathname, depth: 2 })]);

    expect(spec.paths['/things'].get.operationId).toBe('home_dev_my_collection_users_get_user_bru');
  });

  it('gives two requests whose names sanitise the same way the same operation id', () => {
    const { spec } = exportGapItems([
      gapItem('Get User', { method: 'GET', url: '{{baseUrl}}/a' }),
      gapItem('Get_User', { method: 'GET', url: '{{baseUrl}}/b' })
    ]);

    expect(spec.paths['/a'].get.operationId).toBe('collection_get_user_bru');
    expect(spec.paths['/b'].get.operationId).toBe('collection_get_user_bru');
  });

  it('tags a root request with an empty tag', () => {
    const { spec } = exportGapItems([gapItem('Root', {}, { pathname: path.join('collection', 'Root.bru'), depth: 1 })]);

    expect(spec.paths['/things'].post.tags).toEqual(['']);
  });

  it('tags a nested request with its top-level folder, not the folder it is in', () => {
    const pathname = path.join('collection', 'users', 'admin', 'Update.bru');
    const { spec } = exportGapItems([gapItem('Update', {}, { pathname, depth: 3 })]);

    expect(spec.paths['/things'].post.tags).toEqual(['users']);
  });

  it('tags a request without a pathname with null', () => {
    const { spec } = exportGapItems([gapItem('No Path', {}, { pathname: undefined, depth: undefined })]);

    expect(spec.paths['/things'].post.tags).toEqual([null]);
  });

  it('writes the collection name as the info title, with version 1.0.0', () => {
    const { spec } = exportGapItems([gapItem('Any')], { name: 'Pet Store' });

    expect(spec.info).toEqual({ title: 'Pet Store', version: '1.0.0' });
  });

  it('throws when a request has no method', () => {
    expect(() => exportGapItems([gapItem('No Method', { method: undefined })])).toThrow(TypeError);
  });
});

describe('exportApiSpec - base url trailing slash today', () => {
  it('strips one trailing slash from the collection and environment base urls', () => {
    const { spec } = exportGapItems([gapItem('Any')], {
      collectionVariables: { baseUrl: 'https://api.test/' },
      envVariables: { Local: [{ name: 'baseUrl', value: 'http://localhost:3000//', enabled: true }] }
    });

    expect(spec.servers).toEqual([
      { url: 'https://api.test', description: 'Base Server' },
      { url: 'http://localhost:3000/', description: 'Local' }
    ]);
  });
});

describe('exportApiSpec - disabled parameters today', () => {
  it('still exports a disabled query param and header, marked not required', () => {
    const { spec } = exportGapItems([
      gapItem('Disabled', {
        method: 'GET',
        params: [{ name: 'page', value: '2', type: 'query', enabled: false }],
        headers: [{ name: 'X-Trace', value: 'on', enabled: false }]
      })
    ]);

    expect(spec.paths['/things'].get.parameters).toEqual([
      { name: 'page', in: 'query', description: '', required: false, example: '2' },
      { name: 'X-Trace', in: 'header', description: '', required: false, example: 'on' }
    ]);
  });
});

describe('exportApiSpec - secret detection across environments today', () => {
  const collectionVariables = { baseUrl: 'https://api.test', apiKey: 'collection-api-key' };
  const exportWithEnvironments = (envVariables, selectedEnvironment) =>
    exportGapItems([gapItem('Keyed', { method: 'GET', url: 'https://{{apiKey}}.other.test/things' })], { collectionVariables, envVariables, selectedEnvironment });

  it('keeps a variable secret when it is an enabled secret in an environment other than the selected one', () => {
    const { spec } = exportWithEnvironments({
      Local: [{ name: 'baseUrl', value: 'http://localhost', enabled: true, secret: false }],
      Prod: [{ name: 'apiKey', value: 'prod-api-key', enabled: true, secret: true }]
    }, 'Local');

    expect(JSON.stringify(spec)).not.toMatch(/collection-api-key|prod-api-key/);
    expect(spec.paths['/things'].get.servers).toEqual([
      { url: 'https://{apiKey}.other.test', variables: { apiKey: { default: '{{apiKey}}' } } }
    ]);
  });

  it('does not treat a disabled secret as a secret', () => {
    const { spec } = exportWithEnvironments({
      Prod: [{ name: 'apiKey', value: 'prod-api-key', enabled: false, secret: true }]
    }, 'Prod');

    expect(JSON.stringify(spec)).not.toContain('prod-api-key');
    expect(spec.paths['/things'].get.servers).toEqual([{ url: 'https://collection-api-key.other.test' }]);
  });
});

describe('exportApiSpec - missing variables are treated as empty', () => {
  const items = [gapItem('List', { method: 'GET', url: '{{baseUrl}}/things' })];
  const exportWith = (collectionVariables, envVariables, selectedEnvironment) =>
    exportApiSpec('Empty Vars', items, collectionVariables, envVariables, selectedEnvironment);

  it.each([null, undefined])('exports an environment with %p variables like one with no variables', (variables) => {
    const expected = exportWith({ baseUrl: 'https://api.test' }, { Local: [] }, 'Local');

    expect(() => exportWith({ baseUrl: 'https://api.test' }, { Local: variables }, 'Local')).not.toThrow();
    expect(exportWith({ baseUrl: 'https://api.test' }, { Local: variables }, 'Local')).toEqual(expected);
    expect(exportWith({ baseUrl: 'https://api.test' }, { Local: variables })).toEqual(exportWith({ baseUrl: 'https://api.test' }, { Local: [] }));
  });

  it.each([null, undefined])('exports %p collection variables like empty ones', (collectionVariables) => {
    expect(exportWith(collectionVariables, { Local: [] }, 'Local')).toEqual(exportWith({}, { Local: [] }, 'Local'));
  });

  it.each([null, undefined])('exports %p environments like no environments', (envVariables) => {
    expect(exportWith({ baseUrl: 'https://api.test' }, envVariables)).toEqual(exportWith({ baseUrl: 'https://api.test' }, {}));
  });
});

describe('exportApiSpec - which secrets each part of the spec leaves out today', () => {
  const thingsItem = () => gapItem('Things', { method: 'GET', url: '{{baseUrl}}/things' });

  it('fills an environment server with its own value for a variable that is a secret in another environment only', () => {
    const { spec } = exportGapItems([thingsItem()], {
      collectionVariables: {},
      envVariables: {
        Local: [
          { name: 'baseUrl', value: 'https://{{host}}', enabled: true },
          { name: 'host', value: 'local.test', enabled: true }
        ],
        Prod: [{ name: 'host', value: 'prod-host.test', enabled: true, secret: true }]
      },
      selectedEnvironment: 'Local'
    });

    expect(spec.servers).toEqual([
      { url: 'https://{host}', variables: { host: { default: '{{host}}' } }, description: 'Base Server' },
      { url: 'https://{host}', variables: { host: { default: 'local.test' } }, description: 'Local' }
    ]);
  });

  it('leaves out a plain variable that shares its name with an enabled secret in the same environment', () => {
    const { spec } = exportGapItems([thingsItem()], {
      collectionVariables: {},
      envVariables: {
        Prod: [
          { name: 'baseUrl', value: 'https://{{host}}', enabled: true },
          { name: 'host', value: 'secret-host.test', enabled: true, secret: true },
          { name: 'host', value: 'plain-host.test', enabled: true }
        ]
      }
    });

    expect(JSON.stringify(spec)).not.toMatch(/secret-host|plain-host/);
    expect(spec.servers).toEqual([
      { url: 'https://{host}', variables: { host: { default: '{{host}}' } }, description: 'Prod' }
    ]);
  });

  it('fills an environment server with a variable named like a reserved name, but not the collection server', () => {
    const { spec } = exportGapItems([thingsItem()], {
      collectionVariables: {},
      envVariables: {
        Local: [
          { name: 'baseUrl', value: 'https://{{process.env.HOST}}', enabled: true },
          { name: 'process.env.HOST', value: 'env-host.test', enabled: true }
        ]
      },
      selectedEnvironment: 'Local'
    });

    expect(spec.servers).toEqual([
      { url: 'https://{process.env.HOST}', variables: { 'process.env.HOST': { default: '{{process.env.HOST}}' } }, description: 'Base Server' },
      { url: 'https://{process.env.HOST}', variables: { 'process.env.HOST': { default: 'env-host.test' } }, description: 'Local' }
    ]);
  });

  it('fills in a plain variable that shares its name with a disabled secret', () => {
    const { spec } = exportGapItems([thingsItem()], {
      collectionVariables: {},
      envVariables: {
        Prod: [
          { name: 'baseUrl', value: 'https://{{host}}', enabled: true },
          { name: 'host', value: 'off-secret.test', enabled: false, secret: true },
          { name: 'host', value: 'prod-host.test', enabled: true }
        ]
      },
      selectedEnvironment: 'Prod'
    });

    expect(JSON.stringify(spec)).not.toContain('off-secret');
    expect(spec.servers).toEqual([
      { url: 'https://{host}', variables: { host: { default: 'prod-host.test' } }, description: 'Base Server' },
      { url: 'https://{host}', variables: { host: { default: 'prod-host.test' } }, description: 'Prod' }
    ]);
  });

  it('keeps an empty environment value on that environment server, but lets the collection value fill the collection server', () => {
    const { spec } = exportGapItems([thingsItem()], {
      collectionVariables: { baseUrl: 'https://{{host}}', host: 'collection-host.test' },
      envVariables: {
        Local: [
          { name: 'baseUrl', value: 'https://{{host}}', enabled: true },
          { name: 'host', value: '', enabled: true }
        ]
      },
      selectedEnvironment: 'Local'
    });

    expect(spec.servers).toEqual([
      { url: 'https://{host}', variables: { host: { default: 'collection-host.test' } }, description: 'Base Server' },
      { url: 'https://{host}', variables: { host: { default: '' } }, description: 'Local' }
    ]);
  });

  it('uses the {{baseUrl}} placeholder only for the environment whose own baseUrl is a secret', () => {
    const { spec } = exportGapItems([thingsItem()], {
      collectionVariables: {},
      envVariables: {
        Local: [{ name: 'baseUrl', value: 'http://localhost', enabled: true }],
        Prod: [
          { name: 'baseUrl', value: 'https://secret-prod.test', enabled: true, secret: true },
          { name: 'baseUrl', value: 'https://plain-prod.test', enabled: true }
        ]
      }
    });

    expect(JSON.stringify(spec)).not.toMatch(/secret-prod|plain-prod/);
    expect(spec.servers).toEqual([
      { url: 'http://localhost', description: 'Local' },
      { url: '{baseUrl}', variables: { baseUrl: { default: '{{baseUrl}}' } }, description: 'Prod' }
    ]);
  });
});

describe('getEnvironmentVariablesKeyValuePairs', () => {
  it('ignores variables that are switched off or left blank', () => {
    const variables = [
      { name: 'baseUrl', value: 'https://api.test', enabled: true },
      { name: 'disabled', value: 'x', enabled: false },
      { name: 'blank', value: '', enabled: true },
      { name: '', value: 'noName', enabled: true }
    ];
    expect(getEnvironmentVariablesKeyValuePairs(variables)).toEqual({ baseUrl: 'https://api.test' });
  });

  it('keeps a variable whose value is off or zero, which a typed environment really can hold', () => {
    const variables = [
      { name: 'featureOff', value: false, enabled: true },
      { name: 'retries', value: 0, enabled: true }
    ];
    expect(getEnvironmentVariablesKeyValuePairs(variables)).toEqual({ featureOff: false, retries: 0 });
  });

  it('leaves out a secret, because its value never leaves the secrets store', () => {
    const variables = [
      { name: 'token', value: '', enabled: true, secret: true },
      { name: 'baseUrl', value: 'https://api.test', enabled: true }
    ];
    expect(getEnvironmentVariablesKeyValuePairs(variables)).toEqual({ baseUrl: 'https://api.test' });
  });

  it('leaves out a secret even when it arrives with its value', () => {
    const variables = [
      { name: 'token', value: 'decrypted-token', enabled: true, secret: true },
      { name: 'baseUrl', value: 'https://api.test', enabled: true }
    ];
    expect(getEnvironmentVariablesKeyValuePairs(variables)).toEqual({ baseUrl: 'https://api.test' });
  });
});

describe('buildSpecVariables', () => {
  const envVariables = {
    Local: [{ name: 'baseUrl', value: 'https://local.test', enabled: true }],
    Prod: [{ name: 'baseUrl', value: 'https://prod.test', enabled: true }]
  };

  it('lets the chosen environment win over a collection variable of the same name', () => {
    const variables = buildSpecVariables({ baseUrl: 'https://collection.test', other: 'kept' }, envVariables, 'Prod');
    expect(variables.baseUrl).toBe('https://prod.test');
    expect(variables.other).toBe('kept');
  });

  it('keeps the collection variables when no environment is chosen', () => {
    const variables = buildSpecVariables({ baseUrl: 'https://collection.test' }, envVariables, '');
    expect(variables.baseUrl).toBe('https://collection.test');
  });

  it('does not let a secret base url with a value into the merged variables', () => {
    const variables = buildSpecVariables(
      { other: 'kept' },
      { Prod: [{ name: 'baseUrl', value: 'https://secret-host.test', enabled: true, secret: true }] },
      'Prod'
    );
    expect(variables).toEqual({ other: 'kept' });
  });

  it('keeps the placeholder when an enabled secret in the environment overrides a collection variable', () => {
    const variables = buildSpecVariables(
      { host: 'https://collection-host.test', other: 'kept' },
      { Prod: [{ name: 'host', value: '', enabled: true, secret: true }] },
      'Prod'
    );
    expect(variables).toEqual({ other: 'kept' });
  });

  it('keeps the collection value when the secret with the same name is switched off', () => {
    const variables = buildSpecVariables(
      { host: 'https://collection-host.test' },
      { Prod: [{ name: 'host', value: '', enabled: false, secret: true }] },
      'Prod'
    );
    expect(variables).toEqual({ host: 'https://collection-host.test' });
  });

  it('keeps the placeholder when the environment has a secret and a plain variable of the same name', () => {
    const variables = buildSpecVariables(
      {},
      {
        Prod: [
          { name: 'host', value: '', enabled: true, secret: true },
          { name: 'host', value: 'https://plain-host.test', enabled: true }
        ]
      },
      'Prod'
    );
    expect(variables).toEqual({});
  });

  it('copes with a collection that has nothing in it', () => {
    expect(buildSpecVariables()).toEqual({});
  });

  it('copes with an environment name that does not exist', () => {
    const variables = buildSpecVariables({ a: '1' }, envVariables, 'Missing');
    expect(variables).toEqual({ a: '1' });
  });
});

describe('getSecretVariableNames', () => {
  it('collects the names of enabled secrets across all the given environments', () => {
    const environments = [
      { name: 'Local', variables: [{ name: 'token', value: 't', enabled: true, secret: true }] },
      { name: 'Prod', variables: [{ name: 'apiKey', value: '', enabled: true, secret: true }] }
    ];
    expect(getSecretVariableNames(environments)).toEqual(new Set(['token', 'apiKey']));
  });

  it('ignores disabled secrets and plain variables', () => {
    const environments = [
      {
        name: 'Prod',
        variables: [
          { name: 'off', value: 'x', enabled: false, secret: true },
          { name: 'host', value: 'h', enabled: true },
          { name: 'plainFlag', value: 'p', enabled: true, secret: false }
        ]
      }
    ];
    expect(getSecretVariableNames(environments)).toEqual(new Set());
  });

  it('copes with no environments, or an environment without variables', () => {
    expect(getSecretVariableNames([])).toEqual(new Set());
    expect(getSecretVariableNames(undefined)).toEqual(new Set());
    expect(getSecretVariableNames([{ name: 'Empty' }, { name: 'Unset', variables: {} }])).toEqual(new Set());
  });

  it.each([null, undefined])('treats an environment with %p variables like one with no variables', (variables) => {
    const environments = [
      { name: 'Missing', variables },
      { name: 'Prod', variables: [{ name: 'token', value: 't', enabled: true, secret: true }] }
    ];
    expect(getSecretVariableNames(environments)).toEqual(new Set(['token']));
  });
});

describe('isVariableSecret', () => {
  it('treats a name in the secret set as secret', () => {
    expect(isVariableSecret(new Set(['token']), 'token')).toBe(true);
    expect(isVariableSecret(new Set(['token']), 'host')).toBe(false);
  });

  it('treats the reserved $secrets, process and $oauth2 names as secret', () => {
    ['$secrets', '$secrets.apiKey', 'process', 'process.env.HOST', '$oauth2', '$oauth2.cred.access_token'].forEach((varName) => {
      expect(isVariableSecret(new Set(), varName)).toBe(true);
    });
  });

  it('does not treat a name that only starts like a reserved one as secret', () => {
    ['processor', 'my$secrets.apiKey', '$secretsKey', '$oauth2token'].forEach((varName) => {
      expect(isVariableSecret(new Set(), varName)).toBe(false);
    });
  });
});

describe('omitSecretVariables', () => {
  it('leaves out the names in the secret set and keeps the rest, empty values included', () => {
    expect(omitSecretVariables({ token: 't', host: 'h', blank: '' }, new Set(['token']))).toEqual({ host: 'h', blank: '' });
  });

  it('keeps a variable named like a reserved name, since it is not in the set', () => {
    expect(omitSecretVariables({ 'process.env.HOST': 'h' }, new Set())).toEqual({ 'process.env.HOST': 'h' });
  });

  it('keeps the order of the variables it keeps', () => {
    expect(Object.keys(omitSecretVariables({ b: '1', token: 't', a: '2' }, new Set(['token'])))).toEqual(['b', 'a']);
  });
});

describe('omitSecretAndReservedVariables', () => {
  it('leaves out the names in the secret set and the reserved names', () => {
    const variables = { 'token': 't', '$secrets.key': 'k', 'process.env.HOST': 'p', '$oauth2.cred.token': 'o', 'host': 'h', 'processor': 'kept' };
    expect(omitSecretAndReservedVariables(variables, new Set(['token']))).toEqual({ host: 'h', processor: 'kept' });
  });
});

describe('getEnabledVariables', () => {
  it('keeps enabled, named variables, empty, off and zero values included', () => {
    const variables = [
      { name: 'baseUrl', value: 'https://api.test', enabled: true },
      { name: 'blank', value: '', enabled: true },
      { name: 'featureOff', value: false, enabled: true },
      { name: 'retries', value: 0, enabled: true },
      { name: 'disabled', value: 'x', enabled: false },
      { name: '', value: 'noName', enabled: true }
    ];
    expect(getEnabledVariables(variables)).toEqual({ baseUrl: 'https://api.test', blank: '', featureOff: false, retries: 0 });
  });

  it('keeps an enabled secret, since leaving secrets out is up to the caller', () => {
    expect(getEnabledVariables([{ name: 'token', value: 't', enabled: true, secret: true }])).toEqual({ token: 't' });
  });

  it('lets the last enabled variable of a name win', () => {
    const variables = [
      { name: 'host', value: 'first', enabled: true },
      { name: 'host', value: 'second', enabled: true },
      { name: 'host', value: 'off', enabled: false }
    ];
    expect(getEnabledVariables(variables)).toEqual({ host: 'second' });
  });

  it('copes with no variables', () => {
    expect(getEnabledVariables(undefined)).toEqual({});
    expect(getEnabledVariables({})).toEqual({});
  });
});

describe('serializeOpenApiSpec', () => {
  const spec = { openapi: '3.0.0', info: { title: 'Test API', version: '1.0.0' }, paths: {} };

  it('writes YAML exactly as js-yaml dumps it', () => {
    expect(serializeOpenApiSpec(spec, 'yaml')).toBe(jsyaml.dump(spec));
  });

  it('writes JSON indented by two spaces, ending with a newline', () => {
    expect(serializeOpenApiSpec(spec, 'json')).toBe(`${JSON.stringify(spec, null, 2)}\n`);
  });

  it('writes YAML for any format other than json', () => {
    expect(serializeOpenApiSpec(spec)).toBe(jsyaml.dump(spec));
  });
});

// The secret variable names the exporter passes in; reserved $secrets/process/$oauth2 names count as secret on top
const secretNamesCheck = (names) => new Set(names);
const noSecrets = secretNamesCheck([]);

describe('buildServerEntry', () => {
  it('drops one trailing slash from a url without placeholders', () => {
    expect(buildServerEntry('https://api.test/v1/', {}, 'Prod', noSecrets)).toEqual({
      url: 'https://api.test/v1',
      description: 'Prod'
    });
  });

  it('leaves out the description when none is given', () => {
    expect(buildServerEntry('https://api.test', {}, undefined, noSecrets)).toEqual({ url: 'https://api.test' });
  });

  it('turns placeholders into server variables with their values as text', () => {
    expect(buildServerEntry('{{protocol}}://{{host}}:{{port}}/', { protocol: 'https', host: 'api.test', port: 8080 }, undefined, noSecrets)).toEqual({
      url: '{protocol}://{host}:{port}',
      variables: {
        protocol: { default: 'https' },
        host: { default: 'api.test' },
        port: { default: '8080' }
      }
    });
  });

  it('leaves a variable without a value empty', () => {
    expect(buildServerEntry('https://{{host}}', {}, undefined, noSecrets)).toEqual({
      url: 'https://{host}',
      variables: { host: { default: '' } }
    });
  });

  it('keeps the placeholder text for a secret without a value', () => {
    expect(buildServerEntry('https://{{host}}/{{$secrets.path}}', { host: undefined }, undefined, secretNamesCheck(['host']))).toEqual({
      url: 'https://{host}/{$secrets.path}',
      variables: {
        'host': { default: '{{host}}' },
        '$secrets.path': { default: '{{$secrets.path}}' }
      }
    });
  });

  it('uses an empty value as given, even for a secret name', () => {
    expect(buildServerEntry('https://{{host}}', { host: '' }, undefined, secretNamesCheck(['host']))).toEqual({
      url: 'https://{host}',
      variables: { host: { default: '' } }
    });
  });

  it('does not read a value from the prototype chain', () => {
    expect(buildServerEntry('https://{{toString}}', {}, undefined, noSecrets)).toEqual({
      url: 'https://{toString}',
      variables: { toString: { default: '' } }
    });
  });
});

describe('getBaseUrlSources', () => {
  it('has no sources when neither the variables nor any environment has a baseUrl', () => {
    expect(getBaseUrlSources({ host: 'h' }, [{ name: 'Local', variables: [{ name: 'host', value: 'h', enabled: true }] }])).toEqual([]);
  });

  it('lists the collection baseUrl first, as the Base Server with all the variables', () => {
    const variables = { baseUrl: 'https://api.test', token: 't' };
    const environments = [{ name: 'Local', variables: [{ name: 'baseUrl', value: 'http://localhost', enabled: true }] }];
    expect(getBaseUrlSources(variables, environments)).toEqual([
      { baseUrl: 'https://api.test', description: 'Base Server', vars: variables },
      { baseUrl: 'http://localhost', description: 'Local', vars: { baseUrl: 'http://localhost' } }
    ]);
  });

  it('gives each environment its enabled, non-secret variables', () => {
    const environments = [
      {
        name: 'Prod',
        variables: [
          { name: 'baseUrl', value: 'https://{{host}}', enabled: true },
          { name: 'host', value: 'prod.test', enabled: true },
          { name: 'off', value: 'x', enabled: false },
          { name: 'key', value: 'k', enabled: true, secret: true },
          { name: '', value: 'nameless', enabled: true }
        ]
      }
    ];
    expect(getBaseUrlSources({}, environments)).toEqual([
      { baseUrl: 'https://{{host}}', description: 'Prod', vars: { baseUrl: 'https://{{host}}', host: 'prod.test' } }
    ]);
  });

  it('uses the {{baseUrl}} placeholder for an environment whose baseUrl is a secret', () => {
    const environments = [{ name: 'Prod', variables: [{ name: 'baseUrl', value: 'https://secret.test', enabled: true, secret: true }] }];
    expect(getBaseUrlSources({}, environments)).toEqual([{ baseUrl: '{{baseUrl}}', description: 'Prod', vars: {} }]);
  });

  it('skips an environment whose baseUrl is disabled or empty', () => {
    const environments = [
      { name: 'Off', variables: [{ name: 'baseUrl', value: 'https://off.test', enabled: false }] },
      { name: 'Empty', variables: [{ name: 'baseUrl', value: '', enabled: true }] },
      { name: 'None', variables: [] }
    ];
    expect(getBaseUrlSources({}, environments)).toEqual([]);
  });

  it.each([null, undefined])('treats an environment with %p variables like one with no variables, down to its servers', (variables) => {
    const collectionVariables = { baseUrl: 'https://{{host}}', host: 'api.test' };
    const toServers = (sources) => sources.map((source) => buildServerEntry(source.baseUrl, source.vars, source.description, new Set()));
    const expected = getBaseUrlSources(collectionVariables, [{ name: 'Local', variables: [] }]);

    const sources = getBaseUrlSources(collectionVariables, [{ name: 'Local', variables }]);
    expect(sources).toEqual(expected);
    expect(toServers(sources)).toEqual(toServers(expected));
    expect(toServers(sources)).toEqual([
      { url: 'https://{host}', variables: { host: { default: 'api.test' } }, description: 'Base Server' }
    ]);
  });
});

describe('resolveRequestUrl', () => {
  it('turns a request-level baseUrl into an operation server, filling the path from the request variables', () => {
    const requestVars = [
      { name: 'baseUrl', value: 'https://{{region}}.api.test/', enabled: true },
      { name: 'region', value: 'eu', enabled: true },
      { name: 'id', value: '7', enabled: true },
      { name: 'off', value: 'x', enabled: false }
    ];
    expect(resolveRequestUrl('{{baseUrl}}/users/{{id}}/{{off}}', requestVars, {}, [], noSecrets)).toEqual({
      url: '/users/7/{{off}}',
      operationLevelServer: {
        url: 'https://{region}.api.test',
        variables: { region: { default: 'eu' } }
      }
    });
  });

  it('strips the {{baseUrl}} prefix when the request does not override it', () => {
    const requestVars = [{ name: 'baseUrl', value: 'https://override.test', enabled: false }];
    expect(resolveRequestUrl('{{baseUrl}}/users/{{id}}', requestVars, { id: '7' }, [], noSecrets)).toEqual({
      url: '/users/{{id}}',
      operationLevelServer: null
    });
  });

  it('uses / for a url that is only {{baseUrl}}', () => {
    expect(resolveRequestUrl('{{baseUrl}}', undefined, {}, [], noSecrets)).toEqual({ url: '/', operationLevelServer: null });
  });

  it('strips a known base url, ignoring its trailing slashes', () => {
    const baseUrlSources = [{ baseUrl: 'https://api.test/v1//', description: 'Prod', vars: {} }];
    expect(resolveRequestUrl('https://api.test/v1/users', undefined, {}, baseUrlSources, noSecrets)).toEqual({ url: '/users', operationLevelServer: null });
    expect(resolveRequestUrl('https://api.test/v1', undefined, {}, baseUrlSources, noSecrets)).toEqual({ url: '/', operationLevelServer: null });
    expect(resolveRequestUrl('https://api.test/v1?page=2', undefined, {}, baseUrlSources, noSecrets)).toEqual({ url: '/?page=2', operationLevelServer: null });
  });

  it('does not treat a longer path segment as the known base url', () => {
    const baseUrlSources = [{ baseUrl: 'https://api.test/v1', description: 'Prod', vars: {} }];
    expect(resolveRequestUrl('https://api.test/v10/users', undefined, {}, baseUrlSources, noSecrets)).toEqual({
      url: '/v10/users',
      operationLevelServer: { url: 'https://api.test' }
    });
  });

  it('fills an unknown url from the variables and splits off its origin as an operation server', () => {
    expect(resolveRequestUrl('{{host}}/users', undefined, { host: 'https://h.test' }, [], noSecrets)).toEqual({
      url: '/users',
      operationLevelServer: { url: 'https://h.test' }
    });
  });

  it('splits an unknown url as text when its address keeps a placeholder', () => {
    expect(resolveRequestUrl('https://{{host}}/users', undefined, {}, [], secretNamesCheck(['host']))).toEqual({
      url: '/users',
      operationLevelServer: { url: 'https://{host}', variables: { host: { default: '{{host}}' } } }
    });
  });

  it('keeps an unresolved placeholder in the path of an unknown url', () => {
    expect(resolveRequestUrl('https://other.test/a/{{id}}', undefined, {}, [], noSecrets)).toEqual({
      url: '/a/{{id}}',
      operationLevelServer: { url: 'https://other.test' }
    });
  });

  it('keeps a bare path as it is, adding a leading slash when it has none', () => {
    expect(resolveRequestUrl('/just/a/path', undefined, {}, [], noSecrets)).toEqual({ url: '/just/a/path', operationLevelServer: null });
  });
});

describe('extractTagFromDepth', () => {
  it('has no tag for an item without a pathname', () => {
    expect(extractTagFromDepth({ depth: 2 })).toBeUndefined();
  });

  it('uses an empty tag for a request at the collection root', () => {
    expect(extractTagFromDepth({ pathname: '/c/req.bru', depth: 1 })).toBe('');
  });

  it('uses the top-level folder under the collection', () => {
    expect(extractTagFromDepth({ pathname: '/home/c/users/admin/req.bru', depth: 3 })).toBe('users');
  });

  it('splits Windows paths on backslashes', () => {
    expect(extractTagFromDepth({ pathname: 'C:\\c\\users\\req.bru', depth: 2 })).toBe('users');
  });

  it('falls back to the first path part when the depth is larger than the path', () => {
    expect(extractTagFromDepth({ pathname: 'a/b', depth: 5 })).toBe('a');
  });
});

describe('sanitizeId', () => {
  it('is empty for a missing name', () => {
    expect(sanitizeId(undefined)).toBe('');
    expect(sanitizeId('')).toBe('');
  });

  it('replaces other characters with one underscore and trims underscores at the ends', () => {
    expect(sanitizeId('_Get  user.by-id!_')).toBe('Get_user_by-id');
  });

  it('keeps case, letters, digits, dashes and single underscores', () => {
    expect(sanitizeId('users_v2-List')).toBe('users_v2-List');
  });
});

describe('restoreUnresolvedPlaceholders', () => {
  it('turns url-encoded placeholders back into {{name}}, in any case', () => {
    expect(restoreUnresolvedPlaceholders('/a/%7B%7Bid%7D%7D/b/%7b%7bname%7d%7d')).toBe('/a/{{id}}/b/{{name}}');
  });

  it('leaves other text unchanged', () => {
    expect(restoreUnresolvedPlaceholders('/a/%20b/{c}')).toBe('/a/%20b/{c}');
  });
});

describe('getComponentId', () => {
  it('lowercases the name and replaces runs of other characters with one underscore', () => {
    const existingComponentIds = new Set();
    expect(getComponentId(existingComponentIds, { name: '  Get User.v2 (beta) ' })).toBe('get_user.v2_beta');
    expect([...existingComponentIds]).toEqual(['get_user.v2_beta']);
  });

  it('adds a numbered suffix for a name already taken', () => {
    const existingComponentIds = new Set(['list']);
    expect(getComponentId(existingComponentIds, { name: 'List' })).toBe('list_1');
    expect(getComponentId(existingComponentIds, { name: 'list' })).toBe('list_2');
    expect([...existingComponentIds]).toEqual(['list', 'list_1', 'list_2']);
  });

  it('uses request for an item without a usable name', () => {
    const existingComponentIds = new Set();
    expect(getComponentId(existingComponentIds, {})).toBe('request');
    expect(getComponentId(existingComponentIds, { name: '!!!' })).toBe('request_1');
    expect(getComponentId(existingComponentIds, undefined)).toBe('request_2');
  });
});

describe('addWarning', () => {
  it('appends the message and item name to the warnings, in order', () => {
    const warnings = [{ message: 'first', itemName: 'a' }];
    addWarning(warnings, 'second', 'b');
    addWarning(warnings, 'third');
    expect(warnings).toEqual([
      { message: 'first', itemName: 'a' },
      { message: 'second', itemName: 'b' },
      { message: 'third', itemName: undefined }
    ]);
  });
});

describe('buildParameters', () => {
  it('lists query params, url-only query params, headers, then path params from params, braces, segments and placeholders', () => {
    const item = {
      request: {
        url: '{{baseUrl}}/users/:userId/{{orgId}}/{legacy}?page=1&sort=asc',
        params: [
          { name: 'page', value: '1', type: 'query', enabled: true, description: 'Page number' },
          { name: 'userId', value: '42', type: 'path', enabled: true }
        ],
        headers: [{ name: 'X-Trace', value: 'abc', enabled: false }]
      }
    };

    expect(buildParameters(item, '/users/:userId/{{orgId}}/{legacy}', ['userId'])).toEqual([
      { name: 'page', in: 'query', description: 'Page number', required: true, example: '1' },
      { name: 'sort', in: 'query', description: '', required: true, example: 'asc' },
      { name: 'X-Trace', in: 'header', description: '', required: false, example: 'abc' },
      { name: 'userId', in: 'path', required: true, example: '42' },
      { name: 'legacy', in: 'path', required: true },
      { name: 'orgId', in: 'path', required: true, example: '{{orgId}}', schema: { type: 'string' } }
    ]);
  });

  it('adds a :name segment that is not in the params list as a path param without an example', () => {
    const item = { request: { url: '{{baseUrl}}/users/:userId' } };

    expect(buildParameters(item, '/users/:userId', ['userId'])).toEqual([{ name: 'userId', in: 'path', required: true }]);
  });

  it('returns no parameters for a request without params, headers or path params', () => {
    expect(buildParameters({ request: { url: '{{baseUrl}}/users' } }, '/users', [])).toEqual([]);
  });
});

describe('buildQueryParameters', () => {
  it('lists the query params from the params list, then the ones written only in the url', () => {
    const params = [
      { name: 'page', value: '1', type: 'query', enabled: true, description: 'Page number' },
      { name: 'userId', value: '42', type: 'path', enabled: true },
      { name: 'limit', value: '10', type: 'query', enabled: false }
    ];

    expect(buildQueryParameters(params, '{{baseUrl}}/users/:userId?page=2&sort=asc')).toEqual([
      { name: 'page', in: 'query', description: 'Page number', required: true, example: '1' },
      { name: 'limit', in: 'query', description: '', required: false, example: '10' },
      { name: 'sort', in: 'query', description: '', required: true, example: 'asc' }
    ]);
  });

  it('returns no parameters for a url without a query and no query params', () => {
    expect(buildQueryParameters([], '{{baseUrl}}/users')).toEqual([]);
  });
});

describe('buildPathParameters', () => {
  it('lists path params from params, then braces, then :name segments, then placeholders, skipping known names', () => {
    const params = [
      { name: 'userId', value: '42', type: 'path', enabled: true },
      { name: 'page', value: '1', type: 'query', enabled: true }
    ];

    expect(buildPathParameters(params, '/users/:userId/:postId/{{orgId}}/{legacy}/{userId}', ['userId', 'postId'])).toEqual([
      { name: 'userId', in: 'path', required: true, example: '42' },
      { name: 'legacy', in: 'path', required: true },
      { name: 'postId', in: 'path', required: true },
      { name: 'orgId', in: 'path', required: true, example: '{{orgId}}', schema: { type: 'string' } }
    ]);
  });

  it('returns no parameters for a path without path params', () => {
    expect(buildPathParameters([], '/users', [])).toEqual([]);
  });
});

describe('buildFormSchema', () => {
  it('makes an object schema with one property per field, keeping field descriptions', () => {
    const fields = [{ name: 'title', value: 'Hello', description: 'The title' }, { name: 'count', value: '3' }];

    expect(buildFormSchema(fields)).toEqual({
      type: 'object',
      properties: { title: { type: 'string', description: 'The title' }, count: { type: 'string' } }
    });
  });

  it('describes a field value by its shape', () => {
    const fields = [{ name: 'files', value: ['a.png', 'b.png'] }, { name: 'empty', value: undefined }];

    expect(buildFormSchema(fields)).toEqual({
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, properties: { 0: { type: 'string' }, 1: { type: 'string' } } },
        empty: { type: 'undefined' }
      }
    });
  });

  it('makes an object schema without properties for no fields', () => {
    expect(buildFormSchema([])).toEqual({ type: 'object', properties: {} });
  });
});

describe('buildBodyComponent', () => {
  const withBody = (body) => ({ name: 'Create', request: { body } });

  it('describes a json body with the parsed body as example', () => {
    const warnings = [];

    expect(buildBodyComponent(withBody({ mode: 'json', json: '{"name":"Ada","tags":["a"]}' }), warnings)).toEqual({
      mediaType: 'application/json',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, properties: { 0: { type: 'string' } } }
        },
        example: { name: 'Ada', tags: ['a'] }
      }
    });
    expect(warnings).toEqual([]);
  });

  it('warns about invalid json and describes it as an empty object', () => {
    const warnings = [];

    expect(buildBodyComponent(withBody({ mode: 'json', json: '{ "name": ' }), warnings)).toEqual({
      mediaType: 'application/json',
      schema: { type: 'object', properties: {} }
    });
    expect(warnings).toEqual([{ message: expect.stringMatching(/^Failed to parse JSON in request body: /), itemName: 'Create' }]);
  });

  it('describes an xml body from the parsed xml', () => {
    const warnings = [];

    expect(buildBodyComponent(withBody({ mode: 'xml', xml: '<user><name>Ada</name></user>' }), warnings)).toEqual({
      mediaType: 'application/xml',
      schema: {
        type: 'object',
        properties: { user: { type: 'object', properties: { name: { type: 'string' } } } },
        example: { user: { name: 'Ada' } }
      }
    });
    expect(warnings).toEqual([]);
  });

  it('warns about invalid xml and describes nothing', () => {
    const warnings = [];

    expect(buildBodyComponent(withBody({ mode: 'xml', xml: '<user><name>Ada</user>' }), warnings)).toBeUndefined();
    expect(warnings).toEqual([{ message: expect.stringMatching(/^Failed to parse XML in request body: /), itemName: 'Create' }]);
  });

  it('warns about xml that parses to nothing and describes nothing', () => {
    const warnings = [];

    expect(buildBodyComponent(withBody({ mode: 'xml', xml: '   ' }), warnings)).toBeUndefined();
    expect(warnings).toEqual([{ message: 'Failed to parse XML in request body', itemName: 'Create' }]);
  });

  it.each([
    ['multipartForm', 'multipart/form-data'],
    ['formUrlEncoded', 'application/x-www-form-urlencoded']
  ])('describes a %s body with one property per field', (mode, mediaType) => {
    const fields = [{ name: 'title', value: 'Hello', description: 'The title' }, { name: 'count', value: '3' }];

    expect(buildBodyComponent(withBody({ mode, [mode]: fields }), [])).toEqual({
      mediaType,
      schema: {
        type: 'object',
        properties: { title: { type: 'string', description: 'The title' }, count: { type: 'string' } }
      }
    });
  });

  it.each([
    ['no body', undefined],
    ['mode none', { mode: 'none' }],
    ['an empty json body', { mode: 'json', json: '' }],
    ['an empty xml body', { mode: 'xml', xml: '' }],
    ['a text body', { mode: 'text', text: 'Remember the milk' }],
    ['a graphql body', { mode: 'graphql', graphql: { query: '{ users { id } }' } }]
  ])('describes nothing for %s', (_label, body) => {
    const warnings = [];

    expect(buildBodyComponent(withBody(body), warnings)).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('buildInlineRequestBody', () => {
  it('returns a text body inline as a string', () => {
    expect(buildInlineRequestBody({ mode: 'text', text: 'Remember the milk' })).toEqual({
      content: { 'text/plain': { schema: { type: 'string' } } }
    });
  });

  it.each([
    ['no body', undefined],
    ['mode none', { mode: 'none' }],
    ['an empty text body', { mode: 'text', text: '' }],
    ['a json body', { mode: 'json', json: '{"a":1}' }],
    ['a graphql body', { mode: 'graphql', graphql: { query: '{ users { id } }' } }]
  ])('returns undefined for %s', (_label, body) => {
    expect(buildInlineRequestBody(body)).toBeUndefined();
  });
});

describe('addRequestBodyComponent', () => {
  const emptyComponents = () => ({ schemas: {}, requestBodies: {}, securitySchemes: {} });

  it('adds the schema and a required request body that refers to it, and returns a requestBody ref', () => {
    const components = emptyComponents();
    const schema = { type: 'object', properties: {} };

    expect(addRequestBodyComponent(components, 'create', 'application/xml', schema)).toEqual({
      $ref: '#/components/requestBodies/create'
    });
    expect(components).toEqual({
      schemas: { create: schema },
      requestBodies: {
        create: {
          content: { 'application/xml': { schema: { $ref: '#/components/schemas/create' } } },
          description: '',
          required: true
        }
      },
      securitySchemes: {}
    });
  });
});

describe('buildSecurityScheme', () => {
  it.each([
    ['basic', { mode: 'basic' }, { type: 'http', scheme: 'basic' }],
    ['bearer', { mode: 'bearer' }, { type: 'http', scheme: 'bearer' }],
    [
      'awsv4',
      { mode: 'awsv4' },
      { 'type': 'apiKey', 'name': 'Authorization', 'in': 'header', 'x-amazon-apigateway-authtype': 'awsSigv4' }
    ],
    ['digest', { mode: 'digest' }, { type: 'digest', scheme: 'digest', description: 'Digest Authentication' }],
    [
      'oauth2 authorization_code',
      { mode: 'oauth2', oauth2: { grantType: 'authorization_code', authorizationUrl: 'https://a.test/auth', accessTokenUrl: 'https://a.test/token', scope: 'read' } },
      { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://a.test/auth', tokenUrl: 'https://a.test/token', scopes: { read: '' } } } }
    ],
    [
      'oauth2 password',
      { mode: 'oauth2', oauth2: { grantType: 'password', accessTokenUrl: 'https://a.test/token' } },
      { type: 'oauth2', flows: { password: { tokenUrl: 'https://a.test/token', scopes: {} } } }
    ],
    [
      'oauth2 client_credentials',
      { mode: 'oauth2', oauth2: { grantType: 'client_credentials', accessTokenUrl: 'https://a.test/token', scope: 'jobs' } },
      { type: 'oauth2', flows: { password: { tokenUrl: 'https://a.test/token', scopes: { jobs: '' } } } }
    ]
  ])('describes %s auth', (_label, auth, scheme) => {
    expect(buildSecurityScheme(auth)).toEqual(scheme);
  });

  it.each([
    ['no auth', undefined],
    ['mode none', { mode: 'none' }],
    ['inherit', { mode: 'inherit' }],
    ['apikey', { mode: 'apikey', apikey: { key: 'X-Api-Key', value: 'k' } }],
    ['oauth2 without a grant type', { mode: 'oauth2', oauth2: {} }]
  ])('returns undefined for %s', (_label, auth) => {
    expect(buildSecurityScheme(auth)).toBeUndefined();
  });

  it('returns null for an oauth2 grant type the spec cannot describe', () => {
    expect(buildSecurityScheme({ mode: 'oauth2', oauth2: { grantType: 'implicit', authorizationUrl: 'https://a.test/auth' } })).toBeNull();
  });
});

describe('addSecurityScheme', () => {
  it('adds the scheme under the component id and returns the security object', () => {
    const components = { schemas: {}, requestBodies: {}, securitySchemes: {} };

    expect(addSecurityScheme(components, 'secure', { type: 'http', scheme: 'basic' })).toEqual({ secure: [] });
    expect(components).toEqual({ schemas: {}, requestBodies: {}, securitySchemes: { secure: { type: 'http', scheme: 'basic' } } });
  });
});

describe('takesComponentId', () => {
  const bodyComponent = { mediaType: 'application/json', schema: { type: 'object' } };
  const securityScheme = { type: 'http', scheme: 'basic' };

  it.each([
    ['takes one for a body component and a security scheme', bodyComponent, securityScheme, true],
    ['takes one for only a body component', bodyComponent, undefined, true],
    ['takes one for only a security scheme', undefined, securityScheme, true],
    ['takes one for an oauth2 grant type the spec cannot describe', undefined, null, true],
    ['takes none without a body component or a security scheme', undefined, undefined, false]
  ])('%s', (_label, body, scheme, expected) => {
    expect(takesComponentId(body, scheme)).toBe(expected);
  });
});

describe('buildOperation', () => {
  const emptyComponents = () => ({ schemas: {}, requestBodies: {}, securitySchemes: {} });
  const request = (name, requestFields = {}) => ({
    type: 'http-request',
    name,
    pathname: path.join('collection', 'users', `${name}.bru`),
    depth: 2,
    request: { method: 'POST', url: '{{baseUrl}}/users', params: [], headers: [], ...requestFields }
  });
  const build = (item, componentIds, components, warnings = []) =>
    buildOperation(item, { baseUrl: 'https://api.test' }, [], new Set(), componentIds, components, warnings);

  it('returns the template path, lower-case method, operation and operation-level server', () => {
    const components = emptyComponents();
    const item = request('Create User', {
      url: 'https://other.test/users/:id?verbose=true',
      headers: [{ name: 'X-Trace', value: 'abc', enabled: true }],
      body: { mode: 'json', json: '{"name":"Ada"}' },
      auth: { mode: 'bearer' }
    });

    expect(build(item, new Set(), components)).toEqual({
      url: '/users/{id}',
      method: 'post',
      data: {
        summary: 'Create User',
        operationId: 'collection_users_create_user_bru',
        description: '',
        tags: ['users'],
        responses: { 200: { description: '' } },
        parameters: [
          { name: 'verbose', in: 'query', description: '', required: true, example: 'true' },
          { name: 'X-Trace', in: 'header', description: '', required: true, example: 'abc' },
          { name: 'id', in: 'path', required: true }
        ],
        requestBody: { $ref: '#/components/requestBodies/create_user' },
        security: { create_user: [] }
      },
      operationLevelServer: { url: 'https://other.test' }
    });
    expect(Object.keys(components.schemas)).toEqual(['create_user']);
    expect(components.securitySchemes).toEqual({ create_user: { type: 'http', scheme: 'bearer' } });
  });

  it('leaves out parameters, requestBody and security when the request has none', () => {
    const operation = build(request('List Users', { method: 'GET' }), new Set(), emptyComponents());

    expect(operation.data).toEqual({
      summary: 'List Users',
      operationId: 'collection_users_list_users_bru',
      description: '',
      tags: ['users'],
      responses: { 200: { description: '' } }
    });
    expect(operation.operationLevelServer).toBeNull();
  });

  it('numbers the component id of a second request with the same name', () => {
    const componentIds = new Set();
    const components = emptyComponents();
    const jsonBody = { mode: 'json', json: '{"a":1}' };

    build(request('Create', { body: jsonBody }), componentIds, components);
    const second = build(request('Create', { body: jsonBody }), componentIds, components);

    expect(second.data.requestBody).toEqual({ $ref: '#/components/requestBodies/create_1' });
    expect([...componentIds]).toEqual(['create', 'create_1']);
  });

  it('uses one component id for both the body and the auth of a request', () => {
    const componentIds = new Set();
    const components = emptyComponents();

    const operation = build(request('Login', { body: { mode: 'json', json: '{}' }, auth: { mode: 'basic' } }), componentIds, components);

    expect(operation.data.requestBody).toEqual({ $ref: '#/components/requestBodies/login' });
    expect(operation.data.security).toEqual({ login: [] });
    expect([...componentIds]).toEqual(['login']);
  });

  it('reserves a component id for a dropped oauth2 implicit grant', () => {
    const componentIds = new Set();
    const components = emptyComponents();
    const implicitAuth = { mode: 'oauth2', oauth2: { grantType: 'implicit', authorizationUrl: 'https://a.test/auth' } };

    const dropped = build(request('Login', { auth: implicitAuth }), componentIds, components);
    const next = build(request('Login', { auth: { mode: 'bearer' } }), componentIds, components);

    expect(dropped.data.security).toBeUndefined();
    expect(next.data.security).toEqual({ login_1: [] });
    expect([...componentIds]).toEqual(['login', 'login_1']);
  });

  it.each([
    ['a text body', { body: { mode: 'text', text: 'hello' } }],
    ['an invalid xml body', { body: { mode: 'xml', xml: '<a><b></a>' } }],
    ['an empty json body', { body: { mode: 'json', json: '' } }],
    ['apikey auth', { auth: { mode: 'apikey', apikey: { key: 'k', value: 'v' } } }],
    ['oauth2 without a grant type', { auth: { mode: 'oauth2', oauth2: {} } }]
  ])('reserves no component id for %s', (_label, requestFields) => {
    const componentIds = new Set();

    build(request('Plain', requestFields), componentIds, emptyComponents());

    expect([...componentIds]).toEqual([]);
  });

  it('adds the body warnings with the request name', () => {
    const warnings = [];

    build(request('Broken', { body: { mode: 'json', json: '{' } }), new Set(), emptyComponents(), warnings);

    expect(warnings).toEqual([{ message: expect.stringMatching(/^Failed to parse JSON in request body: /), itemName: 'Broken' }]);
  });
});

describe('groupOperationsByPath', () => {
  const operation = (url, method, summary, operationLevelServer = null) => ({ url, method, data: { summary }, operationLevelServer });

  it('groups operations by path and method, keeping later duplicates as x-bruno-variants of the first', () => {
    const paths = groupOperationsByPath([
      operation('/users', 'get', 'List'),
      operation('/users', 'post', 'Create'),
      operation('/users', 'get', 'List again'),
      operation('/users/{id}', 'get', 'Get'),
      operation('/users', 'get', 'List once more')
    ]);

    expect(paths).toEqual({
      '/users': {
        get: {
          'summary': 'List',
          'x-bruno-variants': [{ summary: 'List again' }, { summary: 'List once more' }]
        },
        post: { summary: 'Create' }
      },
      '/users/{id}': { get: { summary: 'Get' } }
    });
  });

  it('writes an operation-level server into the operation as its servers', () => {
    const server = { url: 'https://other.test' };

    const paths = groupOperationsByPath([operation('/users', 'get', 'List'), operation('/users', 'get', 'Elsewhere', server)]);

    expect(paths['/users'].get.servers).toBeUndefined();
    expect(paths['/users'].get['x-bruno-variants']).toEqual([{ summary: 'Elsewhere', servers: [server] }]);
  });

  it('returns no paths for no operations', () => {
    expect(groupOperationsByPath([])).toEqual({});
  });
});
