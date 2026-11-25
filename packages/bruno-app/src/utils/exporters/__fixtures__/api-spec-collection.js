import path from 'path';

// A machine-independent collection root, so pathnames (and the operationIds built from them) are the same everywhere
export const ROOT = path.join(path.sep, 'home', 'dev', 'Api Spec Fixture');

// A request as the collection reader returns it. A .bru and a .yml file parse to the same shape in memory;
// only the file extension in `pathname` differs.
const request = (format, relativePath, { type = 'http-request', seq = 1, vars, ...fields }) => {
  const segments = `${relativePath}.${format}`.split('/');
  return {
    type,
    name: path.basename(relativePath),
    seq,
    pathname: path.join(ROOT, ...segments),
    depth: segments.length,
    request: {
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { mode: 'none' },
      ...(vars ? { vars } : {}),
      ...fields
    }
  };
};

export const buildRequests = (format) => [
  request(format, 'Get Users', {
    method: 'GET',
    url: '{{baseUrl}}/users?page=1',
    params: [{ name: 'page', value: '1', type: 'query', enabled: true, description: 'Page number, starting at 1' }],
    headers: [{ name: 'X-Api-Version', value: '{{version}}', enabled: true, description: 'Api version to use' }]
  }),
  request(format, 'Health', {
    method: 'GET',
    url: '{{baseUrl}}/health',
    vars: {
      req: [
        { name: 'baseUrl', value: 'https://status.test', enabled: true },
        { name: 'region', value: 'eu', enabled: true }
      ]
    }
  }),
  request(format, 'users/List Active Users', {
    method: 'GET',
    url: '{{baseUrl}}/users?active=true',
    params: [{ name: 'active', value: 'true', type: 'query', enabled: true }]
  }),
  request(format, 'users/Search Users', {
    seq: 2,
    method: 'GET',
    url: '{{baseUrl}}/users',
    params: [{ name: 'q', value: 'ada', type: 'query', enabled: true }]
  }),
  request(format, 'users/Create User', {
    seq: 3,
    method: 'POST',
    url: '{{baseUrl}}/users',
    headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
    body: {
      mode: 'json',
      json: '{\n  "name": "Ada",\n  "email": "ada@example.test",\n  "age": 36,\n  "admin": false,\n  "tags": ["beta"],\n  "address": { "city": "London" }\n}'
    },
    auth: { mode: 'bearer', bearer: { token: '{{token}}' } }
  }),
  request(format, 'users/Import Users', {
    seq: 4,
    method: 'POST',
    url: '{{baseUrl}}/users/import',
    headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
    body: { mode: 'json', json: '{\n  "users": [\n    { "name": "Ada" },\n' }
  }),
  request(format, 'users/admin/Update User', {
    method: 'PUT',
    url: '{{baseUrl}}/users/:id',
    params: [{ name: 'id', value: '42', type: 'path', enabled: true }],
    headers: [{ name: 'Content-Type', value: 'application/xml', enabled: true }],
    body: { mode: 'xml', xml: '<user>\n  <name>Ada</name>\n  <role>admin</role>\n</user>' },
    auth: { mode: 'basic', basic: { username: 'admin', password: '{{adminPassword}}' } }
  }),
  request(format, 'users/admin/Replace User', {
    seq: 2,
    method: 'PUT',
    url: '{{baseUrl}}/users/:id',
    params: [{ name: 'id', value: '43', type: 'path', enabled: true }],
    headers: [{ name: 'Content-Type', value: 'application/xml', enabled: true }],
    body: { mode: 'xml', xml: '<user>\n  <name>Ada</role>\n</user>' }
  }),
  request(format, 'graphql/Query Users', {
    type: 'graphql-request',
    method: 'POST',
    url: '{{baseUrl}}/graphql',
    body: { mode: 'graphql', graphql: { query: 'query Users {\n  users {\n    id\n    name\n  }\n}', variables: '' } }
  }),
  request(format, 'auth/OAuth Login', {
    method: 'GET',
    url: '{{baseUrl}}/auth/me',
    auth: {
      mode: 'oauth2',
      oauth2: {
        grantType: 'authorization_code',
        callbackUrl: 'https://app.test/callback',
        authorizationUrl: 'https://auth.test/authorize',
        accessTokenUrl: 'https://auth.test/token',
        clientId: 'fixture-client',
        clientSecret: '',
        scope: 'read',
        state: '',
        pkce: false
      }
    }
  }),
  request(format, 'auth/Password Login', {
    seq: 2,
    method: 'POST',
    url: '{{baseUrl}}/auth/password',
    auth: {
      mode: 'oauth2',
      oauth2: {
        grantType: 'password',
        accessTokenUrl: 'https://auth.test/token',
        username: 'ada',
        password: '{{adminPassword}}',
        clientId: 'fixture-client',
        clientSecret: '',
        scope: 'write'
      }
    }
  }),
  request(format, 'auth/Service Token', {
    seq: 3,
    method: 'POST',
    url: '{{baseUrl}}/auth/service',
    auth: {
      mode: 'oauth2',
      oauth2: {
        grantType: 'client_credentials',
        accessTokenUrl: 'https://auth.test/token',
        clientId: 'fixture-service',
        clientSecret: '{{token}}',
        scope: ''
      }
    }
  }),
  request(format, 'auth/Digest Login', {
    seq: 4,
    method: 'GET',
    url: '{{baseUrl}}/auth/digest',
    auth: { mode: 'digest', digest: { username: 'ada', password: '{{adminPassword}}' } }
  }),
  request(format, 'storage/Get Object', {
    method: 'GET',
    url: 'https://s3.{{region}}.amazonaws.test/bucket/object.txt',
    auth: {
      mode: 'awsv4',
      awsv4: {
        accessKeyId: 'AKIAFIXTURE',
        secretAccessKey: '{{token}}',
        sessionToken: '',
        service: 's3',
        region: '{{region}}',
        profileName: ''
      }
    }
  }),
  request(format, 'uploads/Upload Avatar', {
    method: 'POST',
    url: '{{baseUrl}}/uploads/avatar',
    body: {
      mode: 'multipartForm',
      multipartForm: [
        { name: 'userId', value: '42', type: 'text', enabled: true, description: 'Owner of the avatar' },
        { name: 'file', value: ['/home/dev/avatar.png'], type: 'file', enabled: true }
      ]
    }
  }),
  request(format, 'uploads/Submit Form', {
    seq: 2,
    method: 'POST',
    url: '{{baseUrl}}/uploads/form',
    body: {
      mode: 'formUrlEncoded',
      formUrlEncoded: [
        { name: 'title', value: 'Hello', enabled: true, description: 'Form title' },
        { name: 'draft', value: 'false', enabled: true }
      ]
    }
  }),
  request(format, 'notes/nested/Create Note', {
    method: 'POST',
    url: '{{baseUrl}}/{{version}}/notes',
    headers: [{ name: 'Content-Type', value: 'text/plain', enabled: true }],
    body: { mode: 'text', text: 'Remember the milk' }
  })
];

export const collectionVariables = {
  baseUrl: 'https://api.test',
  version: 'v1',
  region: 'us-east-1'
};

export const envVariables = {
  Local: [
    { name: 'baseUrl', value: 'http://localhost:3000/', enabled: true, secret: false, type: 'text' },
    { name: 'token', value: 'local-secret-token', enabled: true, secret: true, type: 'text' },
    { name: 'version', value: 'v2', enabled: true, secret: false, type: 'text' }
  ],
  Prod: [
    { name: 'baseUrl', value: '{{protocol}}://prod.test', enabled: true, secret: false, type: 'text' },
    { name: 'protocol', value: 'https', enabled: true, secret: false, type: 'text' },
    { name: 'adminPassword', value: 'prod-admin-password', enabled: true, secret: true, type: 'text' },
    { name: 'region', value: 'eu-west-1', enabled: true, secret: false, type: 'text' }
  ]
};
