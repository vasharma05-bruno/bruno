import type { CollectionFormat } from '@usebruno/filestore';
import type { BrunoEnvironment, BrunoItem } from '@usebruno/schema-types';

export interface WriteCollectionOptions {
  format?: CollectionFormat;
}

export type CollectionConfigFile = 'opencollection.yml' | 'bruno.json';

export type ReadCollectionRequest = BrunoItem & {
  pathname: string;
  depth: number;
};

export interface ReadCollectionResult {
  configFile: CollectionConfigFile;
  requests: ReadCollectionRequest[];
  envVariables: Record<string, BrunoEnvironment['variables']>;
  collectionVariables: Record<string, unknown>;
  skipped: string[];
}
