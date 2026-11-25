import fs from 'node:fs';
import path from 'node:path';
import type { CollectionFormat } from '@usebruno/filestore';

export interface WalkEntry {
  relativePath: string;
  absolutePath: string;
}

export interface ConfigFileClassification {
  format: 'json';
  type: 'config';
}

export interface CollectionFileClassification {
  format: CollectionFormat;
  type: 'collection' | 'folder' | 'environment' | 'request';
}

export type FileClassification = ConfigFileClassification | CollectionFileClassification;

const DENY_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.bruno']);
const DEFAULT_DENYLIST = ['**/.DS_Store', '**/Thumbs.db'];

const GLOB_METACHAR = /[*?[\]{}]/;

export const COLLECTION_ROOT_BASENAMES = new Set(['collection.bru', 'collection.yml', 'opencollection.yml']);
export const FOLDER_ROOT_BASENAMES = new Set(['folder.bru', 'folder.yml']);
export const BRUNO_CONFIG_BASENAME = 'bruno.json';
export const ENVIRONMENTS_DIR = 'environments';

export const posixifyPath = (p: string): string => (p ? p.replace(/\\/g, '/') : p);

export const resolveDenylist = (patterns?: string[] | null): string[] => [...DEFAULT_DENYLIST, ...(patterns || [])];

// Plain folder names are prefixes, same as the watcher. Globs stay path.matchesGlob
// on the path itself: stripping a trailing slash turns `**/` into `**`.
const matchesPlainPrefix = (relativePathPosix: string, patterns: string[]): boolean => {
  for (const pattern of patterns) {
    const raw = posixifyPath(pattern);
    if (!raw || GLOB_METACHAR.test(raw)) continue;
    const folder = raw.replace(/\/+$/, '');
    if (!folder) continue;
    if (relativePathPosix === folder || relativePathPosix.startsWith(`${folder}/`)) return true;
  }
  return false;
};

export const isDenied = (relativePathPosix: string, patterns: string[]): boolean => {
  if (matchesPlainPrefix(relativePathPosix, patterns)) return true;
  for (const pattern of patterns) {
    const raw = posixifyPath(pattern);
    if (!raw || !GLOB_METACHAR.test(raw)) continue;
    if (path.matchesGlob(relativePathPosix, raw)) return true;
  }
  return false;
};

const visitDirectory = (
  absDir: string,
  relDir: string,
  denylist: string[],
  visited: Set<string>,
  out: WalkEntry[]
): void => {
  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(absDir);
  } catch (err) {
    return;
  }
  if (visited.has(canonicalDir)) return;
  visited.add(canonicalDir);

  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const childAbs = path.join(absDir, entry.name);
    const childRel = relDir ? path.join(relDir, entry.name) : entry.name;

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(childAbs);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch (err) {
        continue;
      }
    }

    if (isDir) {
      if (DENY_DIRS.has(entry.name)) continue;
      if (matchesPlainPrefix(posixifyPath(childRel), denylist)) continue;
      visitDirectory(childAbs, childRel, denylist, visited, out);
    } else if (isFile) {
      if (isDenied(posixifyPath(childRel), denylist)) continue;
      out.push({ relativePath: childRel, absolutePath: childAbs });
    }
  }
};

/**
 * Lists every file under `root` depth-first, in filesystem order, skipping VCS/tooling folders
 * and anything matched by `denylist`. Symlinked directories are followed once.
 */
export const walk = (root: string, denylist: string[]): WalkEntry[] => {
  const out: WalkEntry[] = [];
  visitDirectory(root, '', denylist, new Set<string>(), out);
  return out;
};

/**
 * Classifies a collection file by its path relative to the collection root, or returns `null`
 * when it isn't a Bruno file.
 */
export const defaultClassify = (relativePath: string): FileClassification | null => {
  const basename = path.basename(relativePath);
  const dirname = path.dirname(relativePath);
  const segments = dirname === '.' || dirname === '' ? [] : dirname.split(path.sep).filter(Boolean);

  if (basename === BRUNO_CONFIG_BASENAME && segments.length === 0) {
    return { format: 'json', type: 'config' };
  }

  const ext = path.extname(basename).slice(1).toLowerCase();
  let format: CollectionFormat;
  if (ext === 'bru') format = 'bru';
  else if (ext === 'yml' || ext === 'yaml') format = 'yml';
  else return null;

  if (COLLECTION_ROOT_BASENAMES.has(basename) && segments.length === 0) {
    return { format, type: 'collection' };
  }
  if (FOLDER_ROOT_BASENAMES.has(basename)) {
    return { format, type: 'folder' };
  }
  if (segments[0] === ENVIRONMENTS_DIR && segments.length === 1) {
    return { format, type: 'environment' };
  }
  return { format, type: 'request' };
};
