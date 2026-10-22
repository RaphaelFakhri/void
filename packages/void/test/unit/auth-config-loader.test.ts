import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { loadVoidAuthConfig, loadVoidAuthConfigWithDependencies } from '../../src/auth/config.ts';

const tempDirs: Array<string> = [];

function createTempDir(): string {
  // The loader reports real paths (macOS temp dirs sit behind /var -> /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'void-auth-config-')));
  tempDirs.push(dir);
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
}

type Step = { write?: Record<string, string>; load: string; together?: number };
type StepResult =
  | { value: unknown; dependencies: Array<string>; restartRequired: Array<string>; reused: boolean }
  | { error: string };

const CONFIG_URL = pathToFileURL(
  join(import.meta.dirname, '..', '..', 'src', 'auth', 'config.ts'),
).href;

// Vitest routes `import()` through its own module runner, so the Node resolve
// hook the loader relies on only runs in a plain Node process.
const DRIVER = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
const [, moduleUrl, dir, stepsJson] = process.argv;
const { loadVoidAuthConfigWithDependencies } = await import(moduleUrl);
const toRelative = (paths) => paths.map((path) => relative(dir, path).split(sep).join('/')).sort();
const results = [];
let previous;
for (const step of JSON.parse(stepsJson)) {
  for (const [file, source] of Object.entries(step.write ?? {})) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  const loads = Array.from({ length: step.together ?? 1 }, () =>
    loadVoidAuthConfigWithDependencies(join(dir, step.load)),
  );
  for (const outcome of await Promise.allSettled(loads)) {
    if (outcome.status === 'rejected') {
      results.push({ error: String(outcome.reason?.message ?? outcome.reason).split('\\n')[0] });
      continue;
    }
    const { config, dependencies, restartRequired } = outcome.value;
    results.push({
      value: typeof config === 'function' ? config() : config,
      dependencies: toRelative(dependencies),
      restartRequired: toRelative(restartRequired),
      reused: config === previous,
    });
    previous = config;
  }
}
process.stdout.write(JSON.stringify(results));
`;

function runSteps(dir: string, steps: Array<Step>): Array<StepResult> {
  const env = { ...process.env };
  delete env.NODE_ENV;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', DRIVER, CONFIG_URL, dir, JSON.stringify(steps)],
    { cwd: dir, encoding: 'utf8', env, timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Array<StepResult>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('loadVoidAuthConfig', () => {
  it('returns undefined without a config file', async () => {
    expect(await loadVoidAuthConfig(null)).toBeUndefined();
    expect(await loadVoidAuthConfigWithDependencies(null)).toEqual({
      config: undefined,
      dependencies: [],
      restartRequired: [],
    });
  });

  it.each([
    ['default', "export default { marker: 'default' };", 'default'],
    ['auth', "export const auth = { marker: 'auth' };", 'auth'],
    ['config', "export const config = { marker: 'config' };", 'config'],
  ])('reads the %s export', async (_name, source, marker) => {
    const path = join(createTempDir(), 'auth.ts');
    writeFileSync(path, source);
    expect(await loadVoidAuthConfig(path)).toEqual({ marker });
  });

  it('reads edits to the config and to the local files it imports', () => {
    const dir = createTempDir();
    const pkg = (name: string) => ({
      [`node_modules/${name}/package.json`]: JSON.stringify({
        name,
        type: 'module',
        exports: './index.js',
      }),
      [`node_modules/${name}/index.js`]: `globalThis.${name}Runs = (globalThis.${name}Runs ?? 0) + 1;\nexport const runs = () => globalThis.${name}Runs;`,
    });
    writeFiles(dir, {
      'package.json': JSON.stringify({
        type: 'module',
        imports: { '#lib/*': './lib/*', '#dep': 'dep' },
      }),
      // Before `void prepare` writes `.void/tsconfig.json`; Node never reads it.
      'tsconfig.json': JSON.stringify({ extends: './.void/tsconfig.json' }),
      ...pkg('pkg'),
      ...pkg('dep'),
      'helper.ts': "export const field: string = 'nickname';",
      'lib/sub.ts': "export const sub = 'sub-1';",
      'auth.ts': [
        "import { runs } from 'pkg';",
        "import { runs as depRuns } from '#dep';",
        "import { field } from './helper.ts';",
        "import { sub } from '#lib/sub.ts';",
        'export default () => ({ field, sub, runs: [runs(), depRuns()], env: process.env.NODE_ENV ?? "unset" });',
      ].join('\n'),
    });

    const results = runSteps(dir, [
      { load: 'auth.ts' },
      { write: { 'helper.ts': "export const field: string = 'displayName';" }, load: 'auth.ts' },
      { write: { 'lib/sub.ts': "export const sub = 'sub-2';" }, load: 'auth.ts' },
      {
        write: {
          'auth.ts': [
            "import { runs } from 'pkg';",
            "import { field } from './helper.ts';",
            "export default () => ({ field: field + '!', runs: [runs()] });",
          ].join('\n'),
        },
        load: 'auth.ts',
      },
    ]);

    const loaded = (value: unknown, dependencies = ['helper.ts', 'lib/sub.ts']) => ({
      value,
      dependencies,
      restartRequired: [],
      reused: false,
    });
    // Packages, including one reached through a `#` import, run once.
    expect(results).toEqual([
      loaded({ field: 'nickname', sub: 'sub-1', runs: [1, 1], env: 'unset' }),
      loaded({ field: 'displayName', sub: 'sub-1', runs: [1, 1], env: 'unset' }),
      loaded({ field: 'displayName', sub: 'sub-2', runs: [1, 1], env: 'unset' }),
      loaded({ field: 'displayName!', runs: [1] }, ['helper.ts']),
    ]);
  });

  it('keeps CommonJS files at their first evaluation and reports them', () => {
    const dir = createTempDir();
    writeFiles(dir, {
      'package.json': JSON.stringify({ type: 'commonjs' }),
      'base.cjs': "module.exports = { base: 'base-1' };",
      // A re-export, which Node reads ahead of running the file.
      'spread.cjs': "module.exports = { ...require('./base.cjs'), spread: true };",
      'esm.mts': "export const esm: string = 'esm-1';",
      'bridge.cjs': "module.exports = { esm: require('./esm.mts').esm };",
      'auth.mts': [
        "import spread from './spread.cjs';",
        "import bridge from './bridge.cjs';",
        "export const marker = 'marker-1';",
        'export default { ...spread, ...bridge, marker };',
      ].join('\n'),
      'auth.cts': "module.exports = { base: require('./base.cjs').base };",
    });

    const results = runSteps(dir, [
      { load: 'auth.mts' },
      {
        write: {
          'base.cjs': "module.exports = { base: 'base-2' };",
          'esm.mts': "export const esm: string = 'esm-2';",
          'auth.mts': [
            "import spread from './spread.cjs';",
            "import bridge from './bridge.cjs';",
            "export const marker = 'marker-2';",
            'export default { ...spread, ...bridge, marker };',
          ].join('\n'),
        },
        load: 'auth.mts',
      },
      { load: 'auth.cts' },
    ]);

    const restartRequired = ['base.cjs', 'bridge.cjs', 'esm.mts', 'spread.cjs'];
    expect(results).toEqual([
      {
        value: { base: 'base-1', spread: true, esm: 'esm-1', marker: 'marker-1' },
        dependencies: restartRequired,
        restartRequired,
        reused: false,
      },
      {
        value: { base: 'base-1', spread: true, esm: 'esm-1', marker: 'marker-2' },
        dependencies: restartRequired,
        restartRequired,
        reused: false,
      },
      {
        value: { base: 'base-1' },
        dependencies: ['base.cjs'],
        restartRequired: ['auth.cts', 'base.cjs'],
        reused: false,
      },
    ]);
  });

  it('reports a CommonJS .js helper in a package without a type', () => {
    const dir = createTempDir();
    writeFiles(dir, {
      'package.json': '{}',
      'helper.js': "module.exports = { helper: 'helper-1' };",
      'auth.mts': "import helper from './helper.js';\nexport default { ...helper };",
    });

    const results = runSteps(dir, [
      { load: 'auth.mts' },
      { write: { 'helper.js': "module.exports = { helper: 'helper-2' };" }, load: 'auth.mts' },
    ]);

    const loaded = { dependencies: ['helper.js'], restartRequired: ['helper.js'], reused: false };
    expect(results).toEqual([
      { value: { helper: 'helper-1' }, ...loaded },
      { value: { helper: 'helper-1' }, ...loaded },
    ]);
  });

  it('recovers after a syntax error and after a missing import is created', () => {
    const dir = createTempDir();
    writeFiles(dir, {
      'helper.ts': "export const field = 'nickname';",
      'auth.ts': "import { field } from './helper.ts';\nexport default { field };",
    });

    const results = runSteps(dir, [
      { load: 'auth.ts' },
      { write: { 'helper.ts': 'export const field = {' }, load: 'auth.ts' },
      { write: { 'helper.ts': "export const field = 'fixed';" }, load: 'auth.ts' },
      {
        write: { 'auth.ts': "import { extra } from './extra.ts';\nexport default { extra };" },
        load: 'auth.ts',
      },
      { write: { 'extra.ts': "export const extra = 'created';" }, load: 'auth.ts' },
    ]);

    expect(results[0]).toMatchObject({ value: { field: 'nickname' } });
    expect(results[1]).toHaveProperty('error');
    expect(results[2]).toMatchObject({ value: { field: 'fixed' } });
    expect(results[3]).toHaveProperty('error');
    expect(results[4]).toMatchObject({ value: { extra: 'created' }, dependencies: ['extra.ts'] });
  });

  it('reuses the last config while none of its files changed', () => {
    const dir = createTempDir();
    writeFiles(dir, {
      'helper.ts': [
        'globalThis.helperRuns = (globalThis.helperRuns ?? 0) + 1;',
        "export const field = 'nickname';",
      ].join('\n'),
      'auth.mts': [
        "import { field } from './helper.ts';",
        'const awaited = await Promise.resolve(field);',
        'export default () => ({ awaited, runs: globalThis.helperRuns, dir: import.meta.dirname });',
      ].join('\n'),
    });

    const results = runSteps(dir, [
      { load: 'auth.mts' },
      { load: 'auth.mts' },
      {
        write: { 'helper.ts': "globalThis.helperRuns += 1;\nexport const field = 'next';" },
        load: 'auth.mts',
      },
    ]);

    const loaded = (value: unknown, reused: boolean) => ({
      value,
      dependencies: ['helper.ts'],
      restartRequired: [],
      reused,
    });
    expect(results).toEqual([
      loaded({ awaited: 'nickname', runs: 1, dir }, false),
      loaded({ awaited: 'nickname', runs: 1, dir }, true),
      loaded({ awaited: 'next', runs: 2, dir }, false),
    ]);
  });

  it('loads one config at a time when called together', () => {
    const dir = createTempDir();
    writeFiles(dir, {
      'package.json': JSON.stringify({ type: 'commonjs' }),
      'inner.cjs': "module.exports = 'inner';",
      'helper.cjs': "module.exports = require('./inner.cjs');",
      'auth.mts': "import helper from './helper.cjs';\nexport default { helper };",
    });

    const results = runSteps(dir, [{ load: 'auth.mts', together: 2 }]);

    expect(results).toEqual([
      {
        value: { helper: 'inner' },
        dependencies: ['helper.cjs', 'inner.cjs'],
        restartRequired: ['helper.cjs', 'inner.cjs'],
        reused: false,
      },
      {
        value: { helper: 'inner' },
        dependencies: ['helper.cjs', 'inner.cjs'],
        restartRequired: ['helper.cjs', 'inner.cjs'],
        reused: true,
      },
    ]);
  });
});
