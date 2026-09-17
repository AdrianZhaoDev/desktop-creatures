import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, lstat, rename, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tree, writeNew, digest, sha256, TARGET } from './native-safety.mjs';
import { nativeConfig, nativeFrontendPath, assertNativeFrontend } from './native-policy.mjs';
import { parseNativeDepInfo, assertProbeReport, assertEmbeddingClosure, EMBEDDING_KIND } from './native-embedding.mjs';
import { validateNativeManifest, verifyNativeCandidate } from './build-native-candidate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'native-embedding-test-'));
  t.after(async () => {
    assert.equal(path.dirname(output), path.resolve(os.tmpdir()));
    assert.ok(path.basename(output).startsWith('native-embedding-test-'));
    assert.equal((await lstat(output)).isSymbolicLink(), false);
    await rm(output, { recursive: true });
  });
  const project = path.join(output, 'project'), candidate = path.join(output, 'candidate');
  await mkdir(path.join(project, 'src-tauri'), { recursive: true });
  await mkdir(candidate);
  await writeNew(candidate, 'frontend/index.html', '<html><head></head><body><script>window.probe = 1</script></body></html>');
  await writeNew(candidate, 'frontend/a.txt', 'same asset bytes');
  await writeNew(candidate, 'frontend/b.txt', 'same asset bytes');
  return { output, project, candidate, frontend: path.join(candidate, 'frontend'), files: await tree(path.join(candidate, 'frontend')) };
}
test('controlled frontend path rejects URL, Windows absolute path, escape and case aliases', async t => {
  const f = await fixture(t);
  assert.equal(nativeFrontendPath(f.project, f.candidate), f.frontend);
  for (const value of [f.frontend, 'https://example.com/', 'file:///C:/frontend', '../../Candidate/frontend', '../../candidate/../outside', '..\\..\\candidate\\frontend']) assert.throws(() => nativeFrontendPath(f.project, f.candidate, value), /controlled relative/);
  await assertNativeFrontend(f.project, f.candidate, f.files);
  await rename(f.frontend, path.join(f.candidate, 'old-frontend'));
  await mkdir(f.frontend);
  for (const file of f.files) await writeNew(f.frontend, file.path, await readFile(path.join(f.candidate, 'old-frontend', file.path)));
  const identities = await assertNativeFrontend(f.project, f.candidate, f.files);
  await rename(f.frontend, path.join(f.candidate, 'second-old-frontend'));
  await mkdir(f.frontend);
  for (const file of f.files) await writeNew(f.frontend, file.path, await readFile(path.join(f.candidate, 'old-frontend', file.path)));
  await assert.rejects(assertNativeFrontend(f.project, f.candidate, f.files, identities), /identity changed/);
});
test('compiler dependency parser preserves Windows paths and escaped spaces, ignoring phony rules', () => {
  const exe = 'C:\\output with spaces\\desktop-creatures.exe', input = 'C:\\candidate with spaces\\frontend\\index.html';
  const escaped = value => value.replaceAll(' ', '\\ ');
  assert.deepEqual(parseNativeDepInfo(`${escaped(exe)}: ${escaped(input)}\n\n${escaped(input)}:\n`, exe), [input]);
  assert.throws(() => parseNativeDepInfo('', exe), /Missing/);
  assert.throws(() => parseNativeDepInfo('C:\\other.exe: C:\\input\n', exe), /Wrong/);
});
test('schema v1 including revoked r2 cannot bind even with its correct external manifest hash', async t => {
  const f = await fixture(t), legacy = { schemaVersion: 1, kind: 'steam-controlled-native-candidate', nativeExecutableBound: true, bindingAssurance: 'controlled-local-build' };
  assert.throws(() => validateNativeManifest(legacy), /legacy r2 binding is revoked/);
  const bytes = Buffer.from(JSON.stringify(legacy));
  await writeNew(f.output, 'native-candidate-manifest.json', bytes);
  await assert.rejects(verifyNativeCandidate({ output: f.output, candidate: f.candidate, expectedManifestSha256: sha256(bytes), root }), /legacy r2 binding is revoked/);
});
test('actual locked Tauri parser/codegen proves Directory, complete transformed closure and rejects Windows URL and empty assets', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const f = await fixture(t), exe = path.join(root, 'src-tauri/target/debug/examples/native_embedding_probe.exe');
  await lstat(exe); // Required precondition: the single shared cargo test gate compiles this example.
  const defaults = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json')));
  await writeNew(f.project, 'src-tauri/tauri.conf.json', JSON.stringify(defaults));
  await writeNew(f.project, 'src-tauri/Cargo.toml', await readFile(path.join(root, 'src-tauri/Cargo.toml')));
  await writeNew(f.project, 'src-tauri/icons/icon.ico', await readFile(path.join(root, 'src-tauri/icons/icon.ico')));
  const config = nativeConfig(defaults, { project: f.project, candidate: f.candidate, context: path.join(f.output, 'build-context.json'), contextSha256: 'a'.repeat(64), node: process.execPath });
  const override = path.join(f.output, 'tauri-override.json');
  await writeNew(f.output, 'tauri-override.json', JSON.stringify(config.override));
  const execute = promisify(execFile), base = ['--config', path.join(f.project, 'src-tauri/tauri.conf.json'), '--override', override];
  const { stdout } = await execute(exe, [...base, '--out-dir', path.join(f.output, 'codegen')], { cwd: f.project, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  assertProbeReport(report, f.frontend, f.files);
  assert.equal(report.assetCount, 3); assert.equal(report.cacheCount, 2);
  assert.match(report.assets.find(a => a.key === '/index.html').transformedSha256, /^[a-f0-9]{64}$/);
  for (const mode of ['missing', 'extra', 'tampered', 'empty']) {
    const changed = structuredClone(report);
    if (mode === 'missing') changed.assets.pop();
    if (mode === 'extra') changed.assets.push(changed.assets[0]);
    if (mode === 'tampered') changed.assets[0].inputSha256 = '0'.repeat(64);
    if (mode === 'empty') { changed.assets = []; changed.assetCount = 0; }
    assert.throws(() => assertProbeReport(changed, f.frontend, f.files), /closure|frozen frontend/);
  }
  await writeFile(override, JSON.stringify({ ...config.override, build: { ...config.override.build, frontendDist: f.frontend } }));
  await assert.rejects(execute(exe, [...base, '--classify-only'], { windowsHide: true }), error => JSON.parse(error.stdout).frontendDistKind === 'Url');
  await assert.rejects(execute(exe, [...base, '--out-dir', path.join(f.output, 'url-codegen')], { windowsHide: true }), error => JSON.parse(error.stdout).frontendDistKind === 'Url');
  await assert.rejects(lstat(path.join(f.output, 'url-codegen')), /ENOENT/);
  await writeFile(override, JSON.stringify(config.override));
  await rename(f.frontend, path.join(f.candidate, 'retained-frontend'));
  await mkdir(f.frontend);
  await assert.rejects(execute(exe, [...base, '--out-dir', path.join(f.output, 'empty-codegen')], { windowsHide: true }), error => /nonempty/.test(JSON.parse(error.stdout).error));
});
test('embedding gate rejects missing dep-info and late candidate mutations', async t => {
  const f = await fixture(t), identity = await assertNativeFrontend(f.project, f.candidate, f.files);
  const proof = { schemaVersion: 1, kind: EMBEDDING_KIND, verified: true, frontendDistKind: 'Directory', target: TARGET, assetCount: f.files.length, assets: f.files.map(file => ({ ...file, key: '/' + file.path, inputPath: path.join(f.frontend, file.path) })), cacheCount: 1, frontendRoot: f.frontend, frontendTreeSha256: digest(f.files), compilerDepInfo: { path: path.join(f.output, 'cargo-target', TARGET, 'release/desktop-creatures.d') }, cacheRoot: path.join(f.output, 'cargo-target', TARGET, 'release/build/desktop-creatures-a/out/tauri-codegen-assets') };
  const verify = () => assertEmbeddingClosure({ proof, project: f.project, candidate: f.candidate, frontendFiles: f.files, executablePath: path.join(f.output, 'content/desktop-creatures.exe'), identities: identity });
  await assert.rejects(verify(), /ENOENT/);
  await writeFile(path.join(f.frontend, 'a.txt'), 'late mutation');
  await assert.rejects(verify(), /Tree changed/);
});
