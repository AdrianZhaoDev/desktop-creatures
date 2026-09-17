import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readdir, realpath, lstat } from 'node:fs/promises';
import { TARGET, snapshot, plain, tree, records, assertRecords, assertTree, digest, stable, sameIdentity, newDirectory, writeNew, inside } from './native-safety.mjs';
import { assertNativeFrontend, nativeFrontendPath } from './native-policy.mjs';
import { command } from './native-toolchain.mjs';

export const EMBEDDING_KIND = 'steam-native-frontend-embedding';
const PROBE_KIND = 'tauri-native-embedding-codegen-probe';
const VERSIONS = { brotli: '8.0.4', sha2: '0.10.9', syn: '2.0.119', tauri_codegen: '2.6.3', tauri_utils: '2.9.3', serde_json: '1.0.151' };
const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const unprefix = value => value.replace(/^\\\\\?\\/, '');
function absoluteDependency(value) {
  value = unprefix(value);
  if (!path.isAbsolute(value)) throw Error('Nonabsolute compiler dependency');
  return path.resolve(value);
}
// rustc's Make dependency format escapes spaces; Windows path separators remain
// literal. Read only the executable rule, not subsequent empty phony rules.
export function parseNativeDepInfo(text, executable) {
  const line = text.replace(/\\\r?\n/g, '').split(/\r?\n/).find(line => line.trim());
  const delimiter = line?.indexOf(': ');
  if (!(delimiter > 0)) throw Error('Missing executable dependency rule');
  const words = value => value.match(/(?:\\[ #]|[^\s])+/g)?.map(word => word.replace(/\\([ #])/g, '$1')) ?? [];
  const target = words(line.slice(0, delimiter));
  if (target.length !== 1 || absoluteDependency(target[0]) !== executable) throw Error('Wrong executable dependency rule');
  return [...new Set(words(line.slice(delimiter + 2)).map(absoluteDependency))].sort();
}

export function assertProbeReport(report, frontend, expected) {
  if (report?.kind !== PROBE_KIND || report.schemaVersion !== 1 || report.verified !== true || report.nativeExecutableBound !== false || report.classifyOnly !== false || report.frontendDistKind !== 'Directory' || report.dev !== false || report.target !== TARGET || report.frontendRoot !== frontend || report.compression !== 'brotli') throw Error('Actual Tauri parser/codegen did not prove a Directory asset closure');
  if (!expected.length || report.assetCount !== expected.length || report.assets?.length !== expected.length || !report.cacheCount || report.cacheCount !== report.cacheFiles?.length) throw Error('Empty or incomplete EmbeddedAssets closure');
  const mapped = report.assets.map(asset => {
    if (asset.key !== '/' + path.relative(frontend, asset.inputPath).replaceAll('\\', '/') || !inside(frontend, asset.inputPath)) throw Error('Codegen asset input escaped the candidate');
    return { path: asset.key.slice(1), bytes: asset.inputBytes, sha256: asset.inputSha256 };
  }).sort(order);
  if (stable(mapped) !== stable([...expected].sort(order))) throw Error('Codegen asset paths/hashes differ from the complete frozen frontend');
  const cacheNames = new Set(report.assets.map(a => path.basename(a.cachePath)));
  if (cacheNames.size !== report.cacheCount) throw Error('Incorrect deduplicated codegen asset count');
}

export async function compileEmbeddingProbe({ project, output, toolchain }) {
  const host = path.join(output, 'cargo-target/release/deps');
  const buildLog = (await snapshot(path.join(output, 'logs/tauri-release-build.log'))).bytes.toString('utf8');
  const lines = buildLog.split(/\r?\n/).filter(line => line.includes('--crate-name tauri_codegen '));
  if (lines.length !== 1 || !lines[0].includes('compression')) throw Error('Missing unique locked compressed Tauri codegen invocation');
  const line = lines[0], codegenHash = line.match(/extra-filename=-([a-f0-9]+)(?: |`)/)?.[1];
  if (!codegenHash) throw Error('Missing actual Tauri codegen crate output');
  const externs = [];
  for (const [name, version] of Object.entries(VERSIONS)) {
    let file;
    if (name === 'tauri_codegen') file = path.join(host, `libtauri_codegen-${codegenHash}.rlib`);
    else {
      const matches = [...line.matchAll(new RegExp(`--extern (?:"${name}=([^"]+)"|${name}=([^\\s]+))`, 'g'))];
      if (matches.length !== 1) throw Error(`Missing unique codegen dependency: ${name}`);
      file = (matches[0][1] ?? matches[0][2]).replace(/\.rmeta$/, '.rlib');
    }
    if (path.dirname(file) !== host || !new RegExp(`^lib${name}-[a-f0-9]+\\.rlib$`).test(path.basename(file))) throw Error('Codegen dependency escaped the new host output');
    const depFile = path.join(host, path.basename(file).replace(/^lib/, '').replace(/\.rlib$/, '.d'));
    const dep = await snapshot(depFile), crate = name.startsWith('tauri_') ? name.replaceAll('_', '-') : name;
    if (!dep.bytes.toString('utf8').replaceAll('\\', '/').includes(`/${crate}-${version}/src/lib.rs`)) throw Error(`Unexpected locked probe dependency version: ${name}`);
    const checked = await snapshot(file);
    externs.push({ name, version, path: file, bytes: checked.bytes.length, sha256: checked.sha256, depInfo: { path: depFile, bytes: dep.bytes.length, sha256: dep.sha256 } });
  }
  const hostInputs = await tree(host), probeRoot = path.join(output, 'embedding-probe');
  await newDirectory(probeRoot);
  const exe = path.join(probeRoot, 'native_embedding_probe.exe');
  const args = ['--edition=2024', '--crate-name', 'native_embedding_probe', path.join(project, 'src-tauri/examples/native_embedding_probe.rs'), '-o', exe, '-L', `dependency=${host}`, '-C', `linker=${toolchain.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER}`];
  for (const item of externs) args.push('--extern', `${item.name}=${item.path}`);
  const built = await command(toolchain.rustc, args, { cwd: probeRoot, env: toolchain.env, logRoot: toolchain.logRoot, name: 'embedding-probe-compile' });
  await assertTree(host, hostInputs);
  const binary = await snapshot(exe);
  return { executable: { path: exe, bytes: binary.bytes.length, sha256: binary.sha256 }, host, hostInputs, externs, command: built.record };
}

export async function runEmbeddingProbe({ project, output, probe, env, outDir, logRoot }) {
  const checked = await snapshot(probe.executable.path);
  if (checked.sha256 !== probe.executable.sha256 || checked.bytes.length !== probe.executable.bytes) throw Error('Pinned embedding probe changed');
  const args = ['--config', path.join(project, 'src-tauri/tauri.conf.json'), '--override', path.join(output, 'tauri-override.json'), '--out-dir', outDir];
  const result = await command(probe.executable.path, args, { cwd: project, env, logRoot, name: 'embedding-codegen' });
  const report = JSON.parse(result.stdout);
  return { report, command: result.record };
}

export async function createEmbeddingProof({ project, output, candidate, frontendFiles, toolchain, executablePath }) {
  const identities = await assertNativeFrontend(project, candidate, frontendFiles);
  const probe = await compileEmbeddingProbe({ project, output, toolchain });
  const generated = await runEmbeddingProbe({ project, output, probe, env: toolchain.env, outDir: path.join(output, 'embedding-probe/codegen'), logRoot: toolchain.logRoot });
  const report = generated.report, frontend = nativeFrontendPath(project, candidate);
  assertProbeReport(report, frontend, frontendFiles);
  await writeNew(output, 'embedding-probe/report.json', JSON.stringify(report, null, 2) + '\n');
  const release = path.join(output, 'cargo-target', TARGET, 'release');
  const depPath = path.join(release, 'desktop-creatures.d'), dep = await snapshot(depPath);
  const dependencies = parseNativeDepInfo(dep.bytes.toString('utf8'), path.join(release, 'desktop-creatures.exe'));
  const caches = dependencies.filter(file => file.includes(`${path.sep}tauri-codegen-assets${path.sep}`));
  const cacheRoots = [...new Set(caches.map(file => path.dirname(file)))];
  if (cacheRoots.length !== 1 || !inside(path.join(release, 'build'), cacheRoots[0]) || !/^desktop-creatures-[a-f0-9]+$/.test(path.basename(path.resolve(cacheRoots[0], '../..')))) throw Error('Missing unique actual compile-time Tauri asset output');
  const cacheRoot = cacheRoots[0];
  const assets = report.assets.map(a => ({
    path: a.key.slice(1), key: a.key, inputPath: a.inputPath, bytes: a.inputBytes, sha256: a.inputSha256,
    cachePath: path.join(cacheRoot, path.basename(a.cachePath)), compressedBytes: a.compressedBytes, compressedSha256: a.compressedSha256,
    transformedBytes: a.transformedBytes, transformedSha256: a.transformedSha256, transformedBlake3: a.transformedBlake3,
  })).sort(order);
  const proof = { schemaVersion: 1, kind: EMBEDDING_KIND, verified: true, frontendDistKind: 'Directory', target: TARGET,
    frontendRoot: frontend, frontendTreeSha256: digest(frontendFiles), assetCount: assets.length, cacheCount: cacheRoots.length && new Set(assets.map(a => a.cachePath)).size,
    parserVersion: 'tauri-utils 2.9.3', codegenVersion: 'tauri-codegen 2.6.3', compression: 'brotli',
    assets, compilerDepInfo: { path: depPath, bytes: dep.bytes.length, sha256: dep.sha256 }, cacheRoot,
    cacheFiles: await tree(cacheRoot), probe, codegenCommand: generated.command, reportPath: path.join(output, 'embedding-probe/report.json'),
    executableSha256: (await snapshot(executablePath)).sha256,
    assurance: 'Actual locked Directory codegen; every frontend input is in executable dep-info, generated compressed cache and final PE bytes. Local build observation, not a signature.' };
  await assertEmbeddingClosure({ proof, project, candidate, frontendFiles, executablePath, identities });
  return { proof, identities };
}

export async function assertEmbeddingClosure({ proof, project, candidate, frontendFiles, executablePath, identities }) {
  if (proof?.schemaVersion !== 1 || proof.kind !== EMBEDDING_KIND || proof.verified !== true || proof.frontendDistKind !== 'Directory' || proof.target !== TARGET || proof.assetCount !== frontendFiles.length || !proof.assetCount || proof.assets?.length !== proof.assetCount || !proof.cacheCount || proof.frontendTreeSha256 !== digest(frontendFiles)) throw Error('Missing complete native frontend embedding proof');
  const frontend = nativeFrontendPath(project, candidate);
  await assertNativeFrontend(project, candidate, frontendFiles, identities);
  if (proof.frontendRoot !== frontend) throw Error('Embedded frontend root differs from candidate');
  const mapped = proof.assets.map(a => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 })).sort(order);
  if (stable(mapped) !== stable([...frontendFiles].sort(order))) throw Error('Embedded frontend closure differs from frozen files');
  const output = path.dirname(project), release = path.join(output, 'cargo-target', TARGET, 'release');
  if (proof.compilerDepInfo.path !== path.join(release, 'desktop-creatures.d') || !inside(path.join(release, 'build'), proof.cacheRoot)) throw Error('Invalid actual compiler asset paths');
  const dep = await snapshot(proof.compilerDepInfo.path);
  if (dep.sha256 !== proof.compilerDepInfo.sha256 || dep.bytes.length !== proof.compilerDepInfo.bytes) throw Error('Compiler frontend dependency file changed');
  const dependencies = parseNativeDepInfo(dep.bytes.toString('utf8'), path.join(release, 'desktop-creatures.exe'));
  const depSet = new Set(dependencies), expectedCaches = new Map();
  const expectedInputs = new Set(frontendFiles.map(f => path.join(frontend, f.path)));
  for (const file of dependencies.filter(file => inside(frontend, file))) {
    if (!expectedInputs.has(file)) {
      const info = await plain(file, 'directory');
      if (!info.isDirectory() || ![...expectedInputs].some(input => inside(file, input))) throw Error('Extra frontend compiler dependency');
    }
  }
  const exe = await snapshot(executablePath);
  if (exe.sha256 !== proof.executableSha256) throw Error('Embedding proof executable changed');
  for (const a of proof.assets) {
    if (a.key !== '/' + a.path || a.inputPath !== path.join(frontend, a.path) || !depSet.has(a.inputPath) || path.dirname(a.cachePath) !== proof.cacheRoot || !depSet.has(a.cachePath)) throw Error('Frontend asset missing from actual executable dependency closure');
    if (await realpath(a.inputPath) !== a.inputPath || await realpath(a.cachePath) !== a.cachePath) throw Error('Compiler asset canonical path differs');
    const cache = await snapshot(a.cachePath);
    if (!cache.bytes.length || cache.bytes.length !== a.compressedBytes || cache.sha256 !== a.compressedSha256) throw Error('Actual compiled embedded asset differs from locked codegen');
    if (exe.bytes.indexOf(cache.bytes) < 0) throw Error(`Embedded asset bytes absent from final EXE: ${a.path}`);
    const item = { path: path.basename(a.cachePath), bytes: cache.bytes.length, sha256: cache.sha256 };
    if (expectedCaches.has(item.path) && stable(expectedCaches.get(item.path)) !== stable(item)) throw Error('Conflicting deduplicated asset');
    expectedCaches.set(item.path, item);
  }
  const expected = [...expectedCaches.values()].sort(order);
  if (expected.length !== proof.cacheCount || stable(expected) !== stable(proof.cacheFiles) || stable(dependencies.filter(p => p.includes(`${path.sep}tauri-codegen-assets${path.sep}`))) !== stable([...expectedCaches.keys()].map(n => path.join(proof.cacheRoot, n)).sort())) throw Error('Extra or missing compiled embedded assets');
  await assertTree(proof.cacheRoot, expected);
  await assertNativeFrontend(project, candidate, frontendFiles, identities);
}

export async function verifyEmbeddingProbe({ proof, project, output, candidate, frontendFiles, env }) {
  await assertTree(proof.probe.host, proof.probe.hostInputs);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'steam-embedding-reverify-'));
  const identity = await plain(temp, 'directory');
  try {
    const { report } = await runEmbeddingProbe({ project, output, probe: proof.probe, env, outDir: path.join(temp, 'codegen') });
    assertProbeReport(report, nativeFrontendPath(project, candidate), frontendFiles);
    const mapped = report.assets.map(a => ({ path: a.key.slice(1), key: a.key, inputPath: a.inputPath, bytes: a.inputBytes, sha256: a.inputSha256, cachePath: path.join(proof.cacheRoot, path.basename(a.cachePath)), compressedBytes: a.compressedBytes, compressedSha256: a.compressedSha256, transformedBytes: a.transformedBytes, transformedSha256: a.transformedSha256, transformedBlake3: a.transformedBlake3 })).sort(order);
    if (stable(mapped) !== stable(proof.assets)) throw Error('Fresh actual Tauri codegen differs from pinned embedding proof');
  } finally {
    if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('steam-embedding-reverify-') || !sameIdentity(identity, await lstat(temp))) throw Error('Temporary embedding verifier root replaced');
    await rm(temp, { recursive: true });
  }
}
