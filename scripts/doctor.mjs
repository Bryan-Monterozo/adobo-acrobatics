import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Set(process.argv.slice(2));
const allowed = new Set(['--strict', '--workspace-only']);
const failures = [];
const warnings = [];
const read = async (name) => readFile(path.join(root, name), 'utf8');
const json = async (name) => JSON.parse(await read(name));
const requireThat = (condition, message) => { if (!condition) failures.push(message); };

try {
  for (const arg of args) requireThat(allowed.has(arg), `Unknown option: ${arg}`);
  const manifest = await json('package.json');
  const nodePin = (await read('.nvmrc')).trim();
  const npmPin = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  const workspace = await json('adobo-acrobatics.code-workspace');
  const lock = await json('package-lock.json');
  requireThat(manifest.private === true, 'The root workspace must remain private.');
  requireThat(JSON.stringify(manifest.workspaces) === JSON.stringify(['apps/*', 'packages/*']), 'Expected apps/* and packages/* workspaces.');
  requireThat(/^24\.\d+\.\d+$/.test(nodePin), 'Expected an exact Node 24 pin.');
  requireThat(Boolean(npmPin), 'Expected an exact npm packageManager pin.');
  requireThat(workspace.folders?.[0]?.path === '.', 'Editor workspace must use a relative folder path.');
  requireThat(lock.lockfileVersion === 3, 'Expected a v3 npm lockfile.');
  requireThat(lock.name === manifest.name && lock.version === manifest.version, 'Root package and lockfile metadata differ.');
  requireThat(JSON.stringify(lock.packages?.['']?.workspaces) === JSON.stringify(manifest.workspaces), 'Lockfile workspace declarations differ.');
  for (const setting of ['engine-strict=true', 'save-exact=true', 'package-lock=true', 'global=false']) {
    requireThat((await read('.npmrc')).split(/\r?\n/).includes(setting), `Missing .npmrc setting: ${setting}`);
  }
  if (!args.has('--workspace-only')) {
    requireThat(Number(process.versions.node.split('.')[0]) === 24, 'Use Node 24 as required by package.json.');
    requireThat(process.env.npm_config_global !== 'true', 'Run project commands in local npm mode.');
    if (process.versions.node !== nodePin) warnings.push(`Node ${process.versions.node}; pinned ${nodePin}. Select .nvmrc with your version manager for an exact version match.`);
    const npmActual = /(?:^|\s)npm\/(\S+)/.exec(process.env.npm_config_user_agent ?? '')?.[1];
    if (npmActual !== npmPin) warnings.push(`npm ${npmActual ?? 'unknown (run through npm run doctor)'}; pinned ${npmPin}.`);
    console.log(`Platform: ${process.platform}/${process.arch}; Node ${process.versions.node}`);
  }
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  if (args.has('--strict')) failures.push(...warnings);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log(`Workspace configuration OK.${warnings.length ? ' Toolchain differs from the preferred exact versions.' : ''}`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
