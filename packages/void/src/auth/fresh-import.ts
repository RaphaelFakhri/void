import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Native `import()` keeps the first evaluation of a file, and of every file it
 * imports, for the life of the process. A resolve hook gives each fresh load
 * its own `?void-fresh-import=<id>` on the entry and on every local ES module
 * it imports, so Node evaluates those again with the same module rules as a
 * plain import (type stripping, top-level await, `--conditions`). Packages keep
 * their single cached evaluation.
 *
 * CommonJS files, and anything reached through `require()`, stay cached by file
 * path: dropping their `require.cache` entries breaks the ES module views Node
 * already built of them. They are reported as `restartRequired`.
 *
 * Old local module instances stay in memory, so a load whose files are all
 * unchanged returns the previous result instead of evaluating again.
 */

const LOAD_PARAM = 'void-fresh-import';

type ActiveLoad = {
  /** The entry's real path, as the hook resolved it. */
  entry?: string;
  /** Every local file the load reached, the entry included. */
  files: Set<string>;
  /** Signature of each dependency, taken before Node read it. */
  signatures: Array<string>;
  /** Files Node loaded as CommonJS or through `require()`. */
  cached: Set<string>;
};

export type FreshImport = {
  module: Record<string, unknown>;
  /** Local files the entry imported, the entry excluded. */
  dependencies: Array<string>;
  /**
   * Local files, the entry included, whose edits need a restart: Node loaded
   * them as CommonJS or through `require()` and keeps their first evaluation.
   */
  restartRequired: Array<string>;
};

const activeLoads = new Map<string, ActiveLoad>();
const lastLoads = new Map<string, { result: FreshImport; signature: string }>();
let hooksRegistered = false;
let lastLoadId = 0;
// One load at a time: concurrent loads that share a CommonJS file trip Node's loader.
let queue: Promise<unknown> = Promise.resolve();

/** A content hash: a same-size save within one mtime tick still counts as a change. */
function fileSignature(path: string): string {
  let source: Buffer;
  try {
    source = readFileSync(path);
  } catch {
    return `${path}:missing`;
  }
  return `${path}:${createHash('sha1').update(source).digest('hex')}`;
}

/** Relative, absolute and `#` subpath imports name the app's own files. */
function isLocalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('#') ||
    // `require('C:\\app\\helper.cjs')` on Windows.
    isWindowsAbsolute(specifier)
  );
}

function localPath(url: string): string | undefined {
  if (!url.startsWith('file:')) {
    return undefined;
  }
  const parsed = new URL(url);
  if (parsed.pathname.includes('/node_modules/')) {
    return undefined;
  }
  parsed.searchParams.delete(LOAD_PARAM);
  return fileURLToPath(parsed);
}

function loadIdOf(url: string): string | undefined {
  const id = new URL(url).searchParams.get(LOAD_PARAM);
  if (id) {
    return id;
  }
  // `require()` inside a CommonJS file reports its parent without the query.
  const path = localPath(url);
  for (const [loadId, load] of activeLoads) {
    if (path && load.files.has(path)) {
      return loadId;
    }
  }
  return undefined;
}

/** False where Node's module hooks are missing (Bun, Deno). */
function registerFreshImportHooks(): boolean {
  if (hooksRegistered) {
    return true;
  }
  const registerHooks = (nodeModule as Partial<typeof nodeModule>).registerHooks;
  if (typeof registerHooks !== 'function' || 'Bun' in globalThis || 'Deno' in globalThis) {
    return false;
  }
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (activeLoads.size === 0) {
        return result;
      }
      const entryId = specifier.startsWith('file:')
        ? new URL(specifier).searchParams.get(LOAD_PARAM)
        : null;
      const id =
        entryId ??
        (context.parentURL && isLocalSpecifier(specifier)
          ? loadIdOf(context.parentURL)
          : undefined);
      const load = id ? activeLoads.get(id) : undefined;
      const path = localPath(result.url);
      if (!id || !load || !path) {
        return result;
      }
      if (entryId) {
        load.entry = path;
      } else if (!load.files.has(path)) {
        // Taken before Node reads the file, so a save during the load counts as a change.
        load.signatures.push(fileSignature(path));
      }
      load.files.add(path);
      if (context.conditions?.includes('require') || result.format?.startsWith('commonjs')) {
        load.cached.add(path);
        return result;
      }
      const url = new URL(result.url);
      url.searchParams.set(LOAD_PARAM, id);
      return { ...result, url: url.href };
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      // A `.js` file's format is only known once Node reads its package.json or source.
      const id = activeLoads.size > 0 ? new URL(url).searchParams.get(LOAD_PARAM) : null;
      const path = localPath(url);
      if (id && path && result.format?.startsWith('commonjs')) {
        activeLoads.get(id)?.cached.add(path);
      }
      return result;
    },
  });
  return true;
}

async function load(path: string): Promise<FreshImport> {
  const last = lastLoads.get(path);
  if (last && [path, ...last.result.dependencies].map(fileSignature).join('|') === last.signature) {
    return last.result;
  }

  if (!registerFreshImportHooks()) {
    const module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    return { module, dependencies: [], restartRequired: [path] };
  }
  const id = String(++lastLoadId);
  const active: ActiveLoad = { files: new Set(), signatures: [], cached: new Set() };
  activeLoads.set(id, active);
  const entrySignature = fileSignature(path);
  const url = pathToFileURL(path);
  url.searchParams.set(LOAD_PARAM, id);
  try {
    const module = (await import(url.href)) as Record<string, unknown>;
    // A cached CommonJS file does not run its `require()` calls again, so keep
    // what earlier loads of this entry reached through it.
    const restartRequired = new Set([...(last?.result.restartRequired ?? []), ...active.cached]);
    const entry = active.entry ?? path;
    if (restartRequired.delete(entry)) {
      restartRequired.add(path);
    }
    const dependencies = [...active.files].filter((file) => file !== entry);
    for (const file of restartRequired) {
      if (file !== path && !dependencies.includes(file)) {
        dependencies.push(file);
        active.signatures.push(fileSignature(file));
      }
    }
    const result = { module, dependencies, restartRequired: [...restartRequired] };
    lastLoads.set(path, { result, signature: [entrySignature, ...active.signatures].join('|') });
    return result;
  } finally {
    activeLoads.delete(id);
  }
}

/**
 * Import `path` with its current source and the current source of every local
 * ES module it imports. Returns the previous result when none of its files changed.
 */
export function importFresh(path: string): Promise<FreshImport> {
  const result = queue.then(() => load(path));
  queue = result.catch(() => undefined);
  return result;
}
