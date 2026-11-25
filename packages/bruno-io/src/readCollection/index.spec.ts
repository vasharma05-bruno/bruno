import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringifyRequest, stringifyEnvironment, stringifyCollection, type CollectionFormat } from '@usebruno/filestore';
import { readCollection } from './index';

const httpItem = (name: string, url: string): any => ({
  type: 'http-request',
  name,
  seq: 1,
  request: { method: 'GET', url, headers: [], params: [], body: { mode: 'none' }, auth: { mode: 'none' } }
});

const gqlItem = (name: string, url: string, query: string): any => ({
  type: 'graphql-request',
  name,
  seq: 1,
  request: { method: 'POST', url, headers: [], params: [], body: { mode: 'graphql', graphql: { query, variables: '' } }, auth: { mode: 'none' } }
});

const envObj = (name: string, variables: Record<string, unknown>[]): any => ({ name, variables });

const tmpDirs: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apispec-${tag}-`));
  tmpDirs.push(dir);
  return dir;
};
const writeFile = (dir: string, rel: string, content: string): void => {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

const mkCollection = (tag: string): string => {
  const dir = mkTmp(tag);
  writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'MyCollection' }));
  return dir;
};

afterAll(() => {
  tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
});

describe.each<CollectionFormat>(['bru', 'yml'])('readCollection: %s collections', (format) => {
  const ext = format === 'yml' ? 'yml' : 'bru';
  let result: Awaited<ReturnType<typeof readCollection>>;

  beforeAll(async () => {
    const dir = mkTmp(format);
    if (format === 'yml') {
      writeFile(dir, 'opencollection.yml', stringifyCollection({} as any, { name: 'MyCollection', version: '1' }));
    } else {
      writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'MyCollection' }));
    }
    writeFile(dir, `GetUsers.${ext}`, stringifyRequest(httpItem('GetUsers', 'https://api.test/users'), { format }));
    writeFile(dir, path.join('FolderA', `GetPosts.${ext}`), stringifyRequest(httpItem('GetPosts', 'https://api.test/posts'), { format }));
    writeFile(dir, path.join('FolderA', `GqlUsers.${ext}`), stringifyRequest(gqlItem('GqlUsers', 'https://api.test/graphql', '{ users { id } }'), { format }));
    writeFile(dir, path.join('environments', `Local.${ext}`), stringifyEnvironment(envObj('Local', [{ name: 'baseUrl', value: 'https://local.test', enabled: true, secret: false, type: 'text' }]), { format }));
    writeFile(dir, path.join('environments', `Prod.${ext}`), stringifyEnvironment(envObj('Prod', [{ name: 'baseUrl', value: 'https://prod.test', enabled: true, secret: false, type: 'text' }]), { format }));
    result = await readCollection(dir);
  });

  it('reads every http and graphql request, including nested folders', () => {
    const byName = Object.fromEntries(result.requests.map((f) => [f.name, f.type]));
    expect(byName).toEqual({ GetUsers: 'http-request', GetPosts: 'http-request', GqlUsers: 'graphql-request' });
  });

  it('sets pathname and depth so folder tags/operationIds match the in-app export', () => {
    const byName = Object.fromEntries(result.requests.map((f) => [f.name, f]));
    expect(byName.GetUsers.depth).toBe(1);
    expect(byName.GetPosts.depth).toBe(2);
    expect(byName.GqlUsers.depth).toBe(2);
    expect(path.isAbsolute(byName.GetUsers.pathname)).toBe(true);
    expect(byName.GetUsers.pathname.endsWith(`GetUsers.${ext}`)).toBe(true);
  });

  it('keeps the graphql query intact in the parsed request body', () => {
    const gql: any = result.requests.find((f) => f.name === 'GqlUsers');
    expect(gql.request.body.mode).toBe('graphql');
    expect(gql.request.body.graphql.query).toContain('users');
  });

  it('loads every environment with its own variables', () => {
    expect(Object.keys(result.envVariables).sort()).toEqual(['Local', 'Prod']);
    const local: any = result.envVariables.Local.find((v) => v.name === 'baseUrl');
    expect(local.value).toBe('https://local.test');
    const prod: any = result.envVariables.Prod.find((v) => v.name === 'baseUrl');
    expect(prod.value).toBe('https://prod.test');
  });
});

describe('readCollection: robustness', () => {
  it('skips an unparseable request file instead of failing the whole load, and reports it in skipped', async () => {
    const dir = mkCollection('bad');
    writeFile(dir, 'Good.bru', stringifyRequest(httpItem('Good', 'https://api.test/ok'), { format: 'bru' }));
    writeFile(dir, 'Broken.bru', 'not valid bru at all {{{{');
    const result = await readCollection(dir);
    expect(result.requests.map((f) => f.name)).toEqual(['Good']);
    expect(result.skipped).toEqual(['Broken.bru']);
  });

  it('rejects when a directory inside the collection cannot be read, so the load error is surfaced', async () => {
    const dir = mkCollection('noaccess');
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', 'https://api.test/ok'), { format: 'bru' }));
    writeFile(dir, path.join('locked', 'Hidden.bru'), stringifyRequest(httpItem('Hidden', 'https://api.test/hidden'), { format: 'bru' }));
    const lockedDir = path.join(dir, 'locked');
    const realReaddir = fs.readdirSync;
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, opts: any) => {
      if (p === lockedDir) {
        const err: any = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return realReaddir(p, opts);
    }) as typeof fs.readdirSync);
    try {
      await expect(readCollection(dir)).rejects.toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects when the collection root itself cannot be read, instead of returning an empty result', async () => {
    const dir = mkCollection('noaccess-root');
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', 'https://api.test/ok'), { format: 'bru' }));
    const realReaddir = fs.readdirSync;
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, opts: any) => {
      if (p === dir) {
        const err: any = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return realReaddir(p, opts);
    }) as typeof fs.readdirSync);
    try {
      await expect(readCollection(dir)).rejects.toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a malformed bru environment in skipped instead of raising an unhandled promise rejection', async () => {
    const dir = mkCollection('bad-env');
    writeFile(dir, path.join('environments', 'Broken.bru'), '@@@ not valid bru @@@\n');
    writeFile(dir, path.join('environments', 'Good.bru'), stringifyEnvironment(envObj('Good', [{ name: 'baseUrl', value: 'https://x', enabled: true, secret: false, type: 'text' }]), { format: 'bru' }));
    const result = await readCollection(dir);
    expect(Object.keys(result.envVariables)).toEqual(['Good']);
    expect(result.skipped).toEqual([path.join('environments', 'Broken.bru')]);
  });

  it.each<CollectionFormat>(['bru', 'yml'])('%s: a secret variable comes back empty while the ordinary ones keep their values, so a password can never end up in the spec file', async (format) => {
    const ext = format === 'yml' ? 'yml' : 'bru';
    const dir = mkCollection(`secret-${format}`);
    writeFile(
      dir,
      path.join('environments', `Local.${ext}`),
      stringifyEnvironment(
        envObj('Local', [
          { name: 'token', value: '', enabled: true, secret: true, type: 'text' },
          { name: 'baseUrl', value: 'https://local.test', enabled: true, secret: false, type: 'text' }
        ]),
        { format }
      )
    );

    const result = await readCollection(dir);
    const byName = Object.fromEntries(result.envVariables.Local.map((v) => [v.name, v.value]));

    expect(byName.token).toBe('');
    expect(byName.baseUrl).toBe('https://local.test');
  });

  it.each<CollectionFormat>(['bru', 'yml'])('%s: marks which variables are secret, so the caller can tell a secret environment apart', async (format) => {
    const ext = format === 'yml' ? 'yml' : 'bru';
    const dir = mkCollection(`secret-flag-${format}`);
    writeFile(
      dir,
      path.join('environments', `Local.${ext}`),
      stringifyEnvironment(
        envObj('Local', [
          { name: 'token', value: '', enabled: true, secret: true, type: 'text' },
          { name: 'baseUrl', value: 'https://x', enabled: true, secret: false, type: 'text' }
        ]),
        { format }
      )
    );

    const result = await readCollection(dir);
    const byName = Object.fromEntries(result.envVariables.Local.map((v) => [v.name, v.secret]));

    expect(byName).toEqual({ token: true, baseUrl: false });
  });
});

describe('readCollection: yml collection config (opencollection.yml)', () => {
  it('honors the ignore patterns from opencollection.yml for a yml collection', async () => {
    const dir = mkTmp('ocignore');
    writeFile(dir, 'opencollection.yml', stringifyCollection({} as any, { name: 'YmlColl', version: '1', ignore: ['drafts/**'] }));
    writeFile(dir, 'GetUsers.yml', stringifyRequest(httpItem('GetUsers', 'https://api.test/users'), { format: 'yml' }));
    writeFile(dir, path.join('drafts', 'Scratch.yml'), stringifyRequest(httpItem('Scratch', 'https://api.test/scratch'), { format: 'yml' }));
    const result = await readCollection(dir);
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
  });
});

describe('readCollection: .yaml extension environments', () => {
  it('handles a .yaml extension too, storing the environment under its name', async () => {
    const dir = mkCollection('yaml-env');
    writeFile(dir, path.join('environments', 'Local.yaml'), stringifyEnvironment(envObj('Local', [{ name: 'baseUrl', value: 'https://local.test', enabled: true, secret: false, type: 'text' }]), { format: 'yml' }));
    const result = await readCollection(dir);
    expect(Object.keys(result.envVariables)).toEqual(['Local']);
  });
});

describe('readCollection: collection-level variables', () => {
  it('extracts enabled collection variables from the collection root so the exporter can resolve them', async () => {
    const dir = mkTmp('collvars');
    writeFile(dir, 'opencollection.yml', stringifyCollection(
      { request: { vars: { req: [{ name: 'baseUrl', value: 'https://coll.test', enabled: true, type: 'text' }] } } } as any,
      { name: 'C', version: '1' }
    ));
    writeFile(dir, 'GetUsers.yml', stringifyRequest(httpItem('GetUsers', '{{baseUrl}}/users'), { format: 'yml' }));
    const result = await readCollection(dir);
    expect(result.collectionVariables).toEqual({ baseUrl: 'https://coll.test' });
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
  });

  it('extracts collection variables from a bru collection root, which parses to a different shape than yml', async () => {
    const dir = mkTmp('collvars-bru');
    writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'BruColl' }));
    writeFile(dir, 'collection.bru', 'vars:pre-request {\n  baseUrl: https://coll.test\n}\n');
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', '{{baseUrl}}/users'), { format: 'bru' }));
    const result = await readCollection(dir);
    expect(result.collectionVariables).toEqual({ baseUrl: 'https://coll.test' });
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
  });

  it('leaves out disabled collection variables', async () => {
    const dir = mkTmp('collvars-disabled');
    writeFile(dir, 'opencollection.yml', stringifyCollection(
      { request: { vars: { req: [
        { name: 'baseUrl', value: 'https://coll.test', enabled: true, type: 'text' },
        { name: 'oldUrl', value: 'https://old.test', enabled: false, type: 'text' }
      ] } } } as any,
      { name: 'C', version: '1' }
    ));
    const result = await readCollection(dir);
    expect(result.collectionVariables).toEqual({ baseUrl: 'https://coll.test' });
  });
});

describe('readCollection: config edge cases', () => {
  it('prefers opencollection.yml over bruno.json when both exist', async () => {
    const dir = mkTmp('both-configs');
    writeFile(dir, 'opencollection.yml', stringifyCollection({} as any, { name: 'FromYml', version: '1' }));
    writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'FromJson' }));
    const result = await readCollection(dir);
    expect(result.configFile).toBe('opencollection.yml');
  });

  it('still loads requests when opencollection.yml is malformed, and reports the config as skipped', async () => {
    const dir = mkTmp('bad-config');
    writeFile(dir, 'opencollection.yml', ':: not valid yaml ::\n\t');
    writeFile(dir, 'GetUsers.yml', stringifyRequest(httpItem('GetUsers', 'https://api.test/users'), { format: 'yml' }));
    const result = await readCollection(dir);
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
    expect(result.skipped).toEqual(['opencollection.yml']);
  });

  it('reports a malformed bruno.json as skipped, since its ignore patterns are lost', async () => {
    const dir = mkTmp('bad-json');
    writeFile(dir, 'bruno.json', '{ not valid json');
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', 'https://api.test/users'), { format: 'bru' }));
    const result = await readCollection(dir);
    expect(result.skipped).toEqual(['bruno.json']);
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
  });

  it('leaves skipped empty when the config is fine but carries no collection config', async () => {
    const dir = mkTmp('ok-config');
    writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'Fine' }));
    const result = await readCollection(dir);
    expect(result.skipped).toEqual([]);
  });

  it('reports a malformed collection root in skipped so the missing collection variables are surfaced', async () => {
    const dir = mkTmp('bad-root');
    writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'BruColl' }));
    writeFile(dir, 'collection.bru', 'vars:pre-request {{{ broken');
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', '{{baseUrl}}/users'), { format: 'bru' }));
    const result = await readCollection(dir);
    expect(result.skipped).toEqual(['collection.bru']);
    expect(result.collectionVariables).toEqual({});
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
  });

  it('reads a real collection that has no requests in it and simply finds nothing to export', async () => {
    const dir = mkTmp('empty');
    writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'Empty' }));
    const result = await readCollection(dir);
    expect(result.requests).toEqual([]);
    expect(result.envVariables).toEqual({});
    expect(result.collectionVariables).toEqual({});
    expect(result.skipped).toEqual([]);
  });
});

describe('readCollection: folders that are not Bruno collections', () => {
  it('refuses a folder that does not contain a Bruno collection file', async () => {
    const dir = mkTmp('not-a-collection');
    writeFile(dir, 'readme.txt', 'i am not a collection');
    await expect(readCollection(dir)).rejects.toThrow('No bruno.json or opencollection.yml found');
  });

  it('refuses a completely empty folder', async () => {
    await expect(readCollection(mkTmp('bare'))).rejects.toThrow('No bruno.json or opencollection.yml found');
  });

  it('refuses a folder that does not exist, rather than pretending the collection was empty', async () => {
    const missing = path.join(mkTmp('missing'), 'gone');
    await expect(readCollection(missing)).rejects.toThrow('No bruno.json or opencollection.yml found');
  });

  it('says which Bruno collection file it found, so the app can tell a real collection from any other folder', async () => {
    const ymlDir = mkTmp('marker-yml');
    writeFile(ymlDir, 'opencollection.yml', stringifyCollection({} as any, { name: 'FromYml', version: '1' }));
    expect((await readCollection(ymlDir)).configFile).toBe('opencollection.yml');

    const jsonDir = mkTmp('marker-json');
    writeFile(jsonDir, 'bruno.json', JSON.stringify({ version: '1', name: 'FromJson' }));
    expect((await readCollection(jsonDir)).configFile).toBe('bruno.json');
  });

  it('accepts a collection that uses the older bruno.json file', async () => {
    const dir = mkTmp('json-only');
    writeFile(dir, 'bruno.json', JSON.stringify({ version: '1', name: 'JsonOnly' }));
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', 'https://api.test/ok'), { format: 'bru' }));
    const result = await readCollection(dir);
    expect(result.requests.map((f) => f.name)).toEqual(['GetUsers']);
  });
});

describe('readCollection: missing collection config', () => {
  it('throws naming the folder when neither bruno.json nor opencollection.yml exists', async () => {
    const dir = mkTmp('no-config');
    writeFile(dir, 'GetUsers.bru', stringifyRequest(httpItem('GetUsers', 'https://api.test/ok'), { format: 'bru' }));
    await expect(readCollection(dir)).rejects.toThrow(`No bruno.json or opencollection.yml found in ${dir}`);
  });
});

describe('readCollection: return shape', () => {
  it('returns exactly configFile, requests, envVariables, collectionVariables and skipped', async () => {
    const dir = mkCollection('shape');
    const result = await readCollection(dir);
    expect(Object.keys(result)).toEqual(['configFile', 'requests', 'envVariables', 'collectionVariables', 'skipped']);
  });
});
