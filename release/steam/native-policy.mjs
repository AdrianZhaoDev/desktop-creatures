import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { relativeName, uniqueNames } from './candidate-safety.mjs';
import { TARGET, FEATURES, snapshot, records, tree, stable, digest, nativePath, sha256, sameIdentity, plain, assertTree } from './native-safety.mjs';

export const POLICY_FILE = 'release/steam/native-source-policy.json';
export const HOOK_WRAPPER_FILE = 'native-before-build.cmd';
export const NATIVE_FRONTEND_DIST = '../../candidate/frontend';
export function nativeFrontendPath(project, candidate, encoded = NATIVE_FRONTEND_DIST) {
  for (const value of [project, candidate]) nativePath(value);
  if (path.basename(project) !== 'project' || candidate !== path.join(path.dirname(project), 'candidate') || encoded !== NATIVE_FRONTEND_DIST) throw Error('Invalid controlled relative frontendDist');
  const resolved = path.resolve(project, 'src-tauri', encoded);
  if (resolved !== path.join(candidate, 'frontend')) throw Error('frontendDist escaped the exact candidate');
  return resolved;
}
export async function assertNativeFrontend(project, candidate, expectedFiles, identities) {
  const frontend = nativeFrontendPath(project, candidate);
  const paths = [project, path.join(project, 'src-tauri'), candidate, frontend];
  const checked = [];
  for (let i = 0; i < paths.length; i++) {
    const info = await plain(paths[i], 'directory');
    if (await realpath(paths[i]) !== paths[i]) throw Error('Frontend path case or canonical root differs');
    if (identities && !sameIdentity(identities[i], info)) throw Error('Frontend directory identity changed');
    checked.push({ dev: info.dev, ino: info.ino });
  }
  await assertTree(frontend, [...expectedFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 0; i < paths.length; i++) if (!sameIdentity(checked[i], await plain(paths[i], 'directory'))) throw Error('Frontend directory identity changed');
  return checked;
}
const REQUIRED = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'rust-toolchain.toml', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/capabilities/default.json', 'src-tauri/icons/icon.ico', 'assets/config/game-balance.legacy.json', 'release/steam/build-native-candidate.mjs', 'release/steam/native-before-build.mjs', 'release/steam/native-msvc-environment.ps1'];
export async function loadNativePolicy(root) {
  const policySnapshot = await snapshot(path.join(root, POLICY_FILE));
  const bytes = policySnapshot.bytes;
  const policy = JSON.parse(bytes);
  if (policy.schemaVersion !== 1 || policy.kind !== 'steam-native-source-policy' || policy.releaseReady !== false || policy.target !== TARGET || stable(policy.features) !== stable(FEATURES)) throw Error('Invalid native source policy');
  uniqueNames(policy.files ?? []);
  if (REQUIRED.some(p => !policy.files.includes(p)) || policy.files.includes(POLICY_FILE)) throw Error('Native policy missing required input');
  if (stable(policy.completeTrees) !== stable(['src-tauri/src', 'src-tauri/examples', 'src-tauri/capabilities'])) throw Error('Native complete trees must be explicit');
  for (const name of policy.files) if (!/^(?:src-tauri\/(?:src\/|examples\/|tests\/cloud-float-exchange\.mjs$|capabilities\/|icons\/icon\.ico$|Cargo\.(?:toml|lock)$|build\.rs$|tauri\.conf\.json$)|release\/steam\/|docs\/steam-v1\/evidence\/v4-native-storage\/ts-(?:empty|active|homes|steam)\.json$|assets\/config\/game-balance\.legacy\.json$|(?:rust-toolchain\.toml|LICENSE|package(?:-lock)?\.json)$)/.test(name)) throw Error(`Native policy attempted scope expansion: ${name}`);
  for (const prefix of policy.completeTrees) {
    const actual = (await tree(path.join(root, prefix))).map(f => `${prefix}/${f.path}`).sort();
    if (stable(actual) !== stable(policy.files.filter(p => p.startsWith(prefix + '/')).sort())) throw Error(`Unlisted/missing native source: ${prefix}`);
  }
  for (const name of policy.files.filter(n => n.endsWith('.rs'))) {
    const source = (await snapshot(path.join(root, name))).bytes.toString('utf8');
    const withoutCargoDir = source.replace(/\benv!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)/g, '');
    if (/\binclude!\s*\(/.test(source) || /\b(?:env|option_env)!\s*\(/.test(withoutCargoDir)) throw Error(`Unreviewed Rust compile-time include/environment macro: ${name}`);
    const all = [...source.matchAll(/\binclude_(?:str|bytes)!\s*\(/g)];
    const literals = [...source.matchAll(/\binclude_(?:str|bytes)!\s*\(\s*"([^"\r\n]+)"\s*,?\s*\)/g)];
    if (all.length !== literals.length) throw Error(`Nonliteral Rust embedded input: ${name}`);
    for (const match of [...literals, ...source.matchAll(/#\[path\s*=\s*"([^"\r\n]+)"\]/g)]) {
      const referenced = path.relative(root, path.resolve(root, path.dirname(name), match[1])).replaceAll('\\', '/');
      relativeName(referenced);
      if (!policy.files.includes(referenced)) throw Error(`Unlisted Rust embedded/module input: ${referenced}`);
    }
  }
  // A second config is an implicit merge input, even if the caller never passes --config.
  for (const name of await readdir(path.join(root, 'src-tauri'))) {
    if ((/^tauri.*\.(?:json|json5|toml)$/i.test(name) || /^Tauri\.toml$/i.test(name)) && name !== 'tauri.conf.json') throw Error(`Unrecorded Tauri configuration: ${name}`);
  }
  const cargo = (await snapshot(path.join(root, 'src-tauri/Cargo.toml'))).bytes.toString('utf8');
  if (/^\s*\[(?:patch|replace|workspace)(?:\.|\])/m.test(cargo) || /\b(?:path|git|registry)\s*=/.test(cargo) || /^\s*build\s*=/m.test(cargo)) throw Error('Unreviewed Cargo workspace/path/git/build override');
  const toolchain = (await snapshot(path.join(root, 'rust-toolchain.toml'))).bytes.toString('utf8');
  const version = toolchain.match(/^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m)?.[1];
  if (!version || !toolchain.includes(`targets = ["${TARGET}"]`) || /^\s*(?:path|components)\s*=/m.test(toolchain)) throw Error('Unreviewed Rust toolchain specification');
  const defaults = JSON.parse((await snapshot(path.join(root, 'src-tauri/tauri.conf.json'))).bytes);
  validateDefaultConfig(defaults);
  return { policy, policySha256: digest(JSON.parse(bytes)), policyFileSha256: policySnapshot.sha256, rustVersion: version, defaultConfig: defaults };
}
export function validateDefaultConfig(config) {
  const top = ['$schema', 'productName', 'version', 'identifier', 'build', 'app', 'bundle'];
  if (!config || Object.keys(config).some(k => !top.includes(k)) || config.identifier !== 'com.desktopcreatures.desktop') throw Error('Unreviewed Tauri top-level configuration');
  if (!config.build || Object.keys(config.build).some(k => !['beforeDevCommand', 'devUrl', 'beforeBuildCommand', 'frontendDist'].includes(k))) throw Error('Unreviewed Tauri build runner/features/configuration');
  if (!config.bundle || config.bundle.resources || config.bundle.externalBin || config.bundle.createUpdaterArtifacts || config.bundle.windows?.signCommand) throw Error('Unreviewed Tauri bundle resource/sidecar/signing configuration');
  if (config.mainBinaryName || config.app?.security?.assetProtocol?.enable) throw Error('Unreviewed Tauri executable/asset protocol');
}
// JSON Merge Patch, as used by Tauri: objects merge, arrays replace, null removes.
export function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const out = base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Unsafe merge key');
    if (value === null) delete out[key]; else out[key] = mergeConfig(out[key], value);
  }
  return out;
}
export function nativeConfig(defaults, { project, candidate, context, contextSha256, node }) {
  for (const p of [project, candidate, context, node]) nativePath(p);
  if (!/^[a-f0-9]{64}$/.test(contextSha256)) throw Error('Invalid beforeBuild context hash');
  validateDefaultConfig(defaults);
  const output = path.dirname(context);
  if (project !== path.join(output, 'project') || context !== path.join(output, 'build-context.json')) throw Error('Invalid controlled build context layout');
  nativeFrontendPath(project, candidate);
  const wrapperContent = `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n"${node}" "${path.join(project, 'release/steam/native-before-build.mjs')}" --context "${context}" --sha256 ${contextSha256}\r\nexit /b %ERRORLEVEL%\r\n`;
  const beforeBuildWrapper = { path: path.join(output, HOOK_WRAPPER_FILE), content: wrapperContent, bytes: Buffer.byteLength(wrapperContent), sha256: sha256(Buffer.from(wrapperContent)) };
  // Tauri 2.11.4 passes script as one cmd /S /C argument. Embedded quotes
  // are escaped by Rust's Windows argument serialization, so use one fixed
  // relative wrapper name. Its contents retain the exact checked interpreter.
  const script = `.\\${HOOK_WRAPPER_FILE}`;
  const override = {
    build: { beforeDevCommand: null, devUrl: null, beforeBuildCommand: { script, cwd: output }, frontendDist: NATIVE_FRONTEND_DIST },
    bundle: { active: false, targets: [], icon: ['icons/icon.ico'] },
  };
  const effective = mergeConfig(defaults, override);
  if (effective.bundle.active !== false || effective.build.frontendDist !== NATIVE_FRONTEND_DIST || effective.build.beforeBuildCommand.script !== script) throw Error('Native config invariant failed');
  return { defaults, override, effective, beforeBuildWrapper, defaultSha256: digest(defaults), overrideSha256: digest(override), effectiveSha256: digest(effective), mergeSemantics: 'JSON Merge Patch RFC7396; no platform overlay permitted' };
}
export async function assertNativeHookWrapper(configuration, identity) {
  const expected = configuration.beforeBuildWrapper, actual = await snapshot(expected.path);
  if (actual.sha256 !== expected.sha256 || actual.bytes.length !== expected.bytes || !actual.bytes.equals(Buffer.from(expected.content))) throw Error('Generated native hook wrapper changed');
  if (identity && !sameIdentity(identity, actual.info)) throw Error('Generated native hook wrapper identity changed');
  return actual.info;
}
export async function nativeInputRecords(root, loaded, frontendPolicy) {
  const lock = JSON.parse((await snapshot(path.join(root, 'package-lock.json'))).bytes);
  const names = new Set([POLICY_FILE, ...loaded.policy.files, ...frontendPolicy.inputs, ...frontendPolicy.dependencyModules, ...frontendPolicy.files.map(f => f.source), ...frontendPolicy.notices.map(f => f.source)]);
  const tooling = [];
  const reviewed = new Map(loaded.policy.npmToolingPackages.map(p => [p.name, p.version]));
  if (reviewed.size !== loaded.policy.npmToolingPackages.length) throw Error('Duplicate npm package policy');
  for (const [name, version] of reviewed) {
    relativeName(name);
    const key = `node_modules/${name}`, pinned = lock.packages[key];
    if (!pinned || pinned.version !== version || !/^sha512-/.test(pinned.integrity ?? '') || !pinned.resolved?.startsWith('https://registry.npmjs.org/')) throw Error(`Unpinned npm tooling package: ${name}`);
    const installed = JSON.parse((await snapshot(path.join(root, key, 'package.json'))).bytes);
    if (installed.name !== name || installed.version !== version) throw Error(`Npm tooling package identity mismatch: ${name}`);
    for (const dep of Object.keys({ ...pinned.dependencies, ...pinned.optionalDependencies })) {
      const target = lock.packages[`node_modules/${dep}`];
      if (target && (!target.os || target.os.includes('win32')) && (!target.cpu || target.cpu.includes('x64')) && !reviewed.has(dep)) throw Error(`Unreviewed npm tooling dependency: ${dep}`);
    }
    const files = await tree(path.join(root, key));
    for (const file of files) names.add(`${key}/${file.path}`);
    tooling.push({ name, version, integrity: pinned.integrity, resolved: pinned.resolved, files, treeSha256: digest(files), trust: 'installed local package tree, locked identity; hash is not registry archive authentication' });
  }
  return { inputs: await records(root, [...names]), tooling };
}
