import { existsSync, readFileSync } from 'node:fs';
import { parseSync } from 'vite';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import type { VoidAuthConfig } from '../runtime/auth.ts';
import type { AstNode, AstProgram } from '../shared/ast.ts';
import { importFresh } from './fresh-import.ts';

function isVoidAuthConfigSource(code: string, filename: string): boolean {
  if (!code.includes('void/auth')) {
    return false;
  }
  let program: AstProgram;
  try {
    program = parseSync(filename, code).program as unknown as AstProgram;
  } catch {
    return false;
  }
  return (program.body ?? []).some((node: AstNode) => {
    if (
      node.type !== 'ImportDeclaration' &&
      node.type !== 'ExportNamedDeclaration' &&
      node.type !== 'ExportAllDeclaration'
    ) {
      return false;
    }
    return (node.source as { value?: unknown } | undefined)?.value === 'void/auth';
  });
}

export function findVoidAuthConfig(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  for (const absPath of paths.authConfigCandidates) {
    if (!existsSync(absPath)) {
      continue;
    }
    const code = readFileSync(absPath, 'utf-8');
    if (isVoidAuthConfigSource(code, absPath)) {
      return absPath;
    }
  }
  return null;
}

export type LoadedVoidAuthConfig = {
  config: VoidAuthConfig | undefined;
  /** Local files the config imported, the config file excluded. */
  dependencies: Array<string>;
  /** Local files, the config included, whose edits only a restart picks up. */
  restartRequired: Array<string>;
};

/**
 * Evaluate the auth config from its current source, and the current source of
 * the local files it imports, so a dev server picks up saved edits.
 */
export async function loadVoidAuthConfigWithDependencies(
  configPath: string | null,
): Promise<LoadedVoidAuthConfig> {
  if (!configPath) {
    return { config: undefined, dependencies: [], restartRequired: [] };
  }
  const { module, dependencies, restartRequired } = await importFresh(configPath);
  return {
    config: (module.default ?? module.auth ?? module.config) as VoidAuthConfig | undefined,
    dependencies,
    restartRequired,
  };
}

export async function loadVoidAuthConfig(
  configPath: string | null,
): Promise<VoidAuthConfig | undefined> {
  return (await loadVoidAuthConfigWithDependencies(configPath)).config;
}
