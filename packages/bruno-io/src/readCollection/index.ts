import fs from 'node:fs';
import path from 'node:path';
import { parseRequest, parseEnvironment, parseCollection, type CollectionFormat } from '@usebruno/filestore';
import { walk, defaultClassify, resolveDenylist } from '../walk';
import type { CollectionConfigFile, ReadCollectionRequest, ReadCollectionResult } from '../types';

interface CollectionConfig {
  configFile: CollectionConfigFile;
  brunoConfig: Record<string, any> | null;
  configParsed: boolean;
}

const resolveConfigFile = (collectionPath: string): CollectionConfigFile | null => {
  if (fs.existsSync(path.join(collectionPath, 'opencollection.yml'))) return 'opencollection.yml';
  if (fs.existsSync(path.join(collectionPath, 'bruno.json'))) return 'bruno.json';
  return null;
};

const readCollectionConfig = async (collectionPath: string): Promise<CollectionConfig> => {
  const configFile = resolveConfigFile(collectionPath);
  if (!configFile) {
    throw new Error(`No bruno.json or opencollection.yml found in ${collectionPath}`);
  }

  const configPath = path.join(collectionPath, configFile);
  try {
    if (configFile === 'opencollection.yml') {
      const parsed = await parseCollection(fs.readFileSync(configPath, 'utf8'), { format: 'yml' });
      return { configFile, brunoConfig: parsed?.brunoConfig || null, configParsed: true };
    }
    return { configFile, brunoConfig: JSON.parse(fs.readFileSync(configPath, 'utf8')), configParsed: true };
  } catch (err) {
    console.error(`Failed to parse ${configFile}:`, err);
    return { configFile, brunoConfig: null, configParsed: false };
  }
};

const markSkipped = (skipped: string[], relativePath: string): void => {
  if (!skipped.includes(relativePath)) {
    skipped.push(relativePath);
  }
};

const readOrSkip = async (label: string, relativePath: string, reading: Promise<void>, skipped: string[]): Promise<void> => {
  try {
    await reading;
  } catch (err) {
    console.error(`Failed to parse ${label} ${relativePath}:`, err);
    markSkipped(skipped, relativePath);
  }
};

const readRequestFile = async (
  absolutePath: string,
  relativePath: string,
  format: CollectionFormat,
  requests: ReadCollectionRequest[]
): Promise<void> => {
  const item = await parseRequest(fs.readFileSync(absolutePath, 'utf8'), { format });
  requests.push({ ...item, pathname: absolutePath, depth: relativePath.split(path.sep).filter(Boolean).length });
};

const readEnvironmentFile = async (
  absolutePath: string,
  relativePath: string,
  format: CollectionFormat,
  envVariables: ReadCollectionResult['envVariables']
): Promise<void> => {
  const environment = await parseEnvironment(fs.readFileSync(absolutePath, 'utf8'), { format });
  const environmentName = path.basename(relativePath).replace(/\.(bru|ya?ml)$/i, '');
  envVariables[environmentName] = environment.variables;
};

const readCollectionRootFile = async (
  absolutePath: string,
  format: CollectionFormat,
  collectionVariables: ReadCollectionResult['collectionVariables']
): Promise<void> => {
  const parsed = await parseCollection(fs.readFileSync(absolutePath, 'utf8'), { format });
  const collectionRoot = parsed?.collectionRoot || parsed;
  const collectionRootVars = collectionRoot?.request?.vars?.req || [];
  collectionRootVars.forEach((variable: { name: string; value: unknown; enabled?: boolean }) => {
    if (variable.enabled) collectionVariables[variable.name] = variable.value;
  });
};

/**
 * Reads a Bruno collection directory (`bru` or `yml`) from disk: its requests, environments and
 * collection-level variables. Files that fail to parse are logged and listed in `skipped`; a
 * folder without `bruno.json` or `opencollection.yml` is rejected.
 */
export const readCollection = async (collectionPath: string): Promise<ReadCollectionResult> => {
  const { configFile, brunoConfig, configParsed } = await readCollectionConfig(collectionPath);

  const requests: ReadCollectionRequest[] = [];
  const envVariables: ReadCollectionResult['envVariables'] = {};
  const collectionVariables: ReadCollectionResult['collectionVariables'] = {};
  const skipped: string[] = [];

  if (!configParsed) {
    markSkipped(skipped, configFile);
  }

  for (const { relativePath, absolutePath } of walk(collectionPath, resolveDenylist(brunoConfig?.ignore))) {
    const classification = defaultClassify(relativePath);
    if (!classification) continue;

    switch (classification.type) {
      case 'request':
        await readOrSkip('request', relativePath, readRequestFile(absolutePath, relativePath, classification.format, requests), skipped);
        break;

      case 'environment':
        await readOrSkip('environment', relativePath, readEnvironmentFile(absolutePath, relativePath, classification.format, envVariables), skipped);
        break;

      case 'collection':
        await readOrSkip('collection root', relativePath, readCollectionRootFile(absolutePath, classification.format, collectionVariables), skipped);
        break;

      default:
        break;
    }
  }

  return {
    configFile,
    requests,
    envVariables,
    collectionVariables,
    skipped
  };
};
