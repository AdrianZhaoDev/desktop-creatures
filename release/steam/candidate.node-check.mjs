import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, build } from 'vite';
import { candidateConfig } from './vite.candidate.mjs';
import { buildCandidate, verifyCandidate, loadPolicy, checkedResources, validateRuntimePaths, projectRoot } from './build-candidate.mjs';
import { relativeName, uniqueNames, safePath, inventory, writeNew, sha256 } from './candidate-safety.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'steam-candidate-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^steam-candidate-test-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
test('rejects traversal, absolute/UNC/ADS, URL encoding, Windows aliases and trailing dot/space', () => {
  for (const value of ['../a', '/a', 'C:/a', '//server/share', 'a\\b', 'a:b', 'a//b', 'a/./b', 'a/../b', 'a%2fb', 'a\0b', 'con', 'AUX.txt', 'a/LPT1.bin', 'a.', 'a ', 'a/COM0.txt', 'a/']) {
    assert.throws(() => relativeName(value), /Unsafe/);
  }
});
test('rejects duplicate, casefold, and file/directory collisions', () => {
  for (const names of [['a.bin', 'a.bin'], ['A.bin', 'a.bin'], ['assets', 'assets/a.bin'], ['assets/a.bin', 'ASSETS']]) assert.throws(() => uniqueNames(names), /collision/);
});
test('source and destination ancestors reject real junctions; root links and hardlinks fail', async t => {
  const root = await temporary(t), source = path.join(root, 'source'), redirected = path.join(root, 'redirected');
  await mkdir(source); await writeFile(path.join(source, 'file.bin'), 'sentinel');
  await symlink(source, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(safePath(redirected, 'directory'), /Symlink|junction/);
    await assert.rejects(safePath(path.join(redirected, 'file.bin')), /Symlink|junction/);
    await assert.rejects(writeNew(redirected, 'injected.bin', Buffer.from('bad')), /Symlink|junction/);
    await assert.rejects(inventory(root), /Symlink|junction/);
  } finally { await unlink(redirected); }
  const alias = path.join(root, 'alias.bin'); await link(path.join(source, 'file.bin'), alias);
  try { await assert.rejects(safePath(alias), /unique regular file/); } finally { await unlink(alias); }
  assert.equal(await readFile(path.join(source, 'file.bin'), 'utf8'), 'sentinel');
});
test('policy rejects forbidden, duplicate, remapped, and traversal entries', async t => {
  const root = await temporary(t); await mkdir(path.join(root, 'release/steam'), { recursive: true });
  await writeFile(path.join(root, 'tsconfig.json'), '{}');
  const original = (await loadPolicy()).policy;
  for (const mutate of [
    p => p.files.push(p.files[0]),
    p => p.files[0].path = '../escape.bin',
    p => p.files[0].source = 'assets/companions/companion.mimi/model.glb',
    p => p.files[0].path = 's06/source.blend',
    p => p.files[0].path = 's06/preview/model.glb',
    p => p.files[0].path = 's06/other.glb',
    p => p.files[0].sha256 = 'not-a-hash',
  ]) {
    const policy = structuredClone(original); mutate(policy);
    await writeFile(path.join(root, 'release/steam/candidate-policy.json'), JSON.stringify(policy));
    await assert.rejects(loadPolicy(root));
  }
  await writeFile(path.join(root, 'release/steam/candidate-policy.json'), JSON.stringify(original));
  await mkdir(path.join(root, 'src/campaign'), { recursive: true });
  await writeFile(path.join(root, 'src/campaign/tsconfig.json'), '{}');
  await assert.rejects(loadPolicy(root), /nested compiler config/);
  await unlink(path.join(root, 'src/campaign/tsconfig.json'));
  await writeFile(path.join(root, 'tsconfig.json'), '{"extends":"../external.json"}');
  await assert.rejects(loadPolicy(root), /tsconfig dependency chain/);
});
test('ambient PostCSS config cannot execute in candidate builds', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'postcss.config.mjs'), 'throw new Error("UNREVIEWED_POSTCSS_EXECUTED");');
  await writeFile(path.join(root, 'style.css'), 'body { color: red; }');
  await writeFile(path.join(root, 'main.js'), 'import "./style.css";');
  for (const page of ['index', 'trash', 'shortcuts']) await writeFile(path.join(root, `${page}.html`), '<html><body><script type="module" src="./main.js"></script></body></html>');
  const output = await build(candidateConfig(root, { name: 'test-boundary' }));
  assert.ok(output.output.some(file => file.fileName.endsWith('.css')));
});
test('resource reads reject missing, tampered, redirected and external-dependency models', async t => {
  const root = await temporary(t); const bytes = Buffer.from('reviewed binary');
  const policy = { files: [{ source: 'model.bin', path: 'model.bin', sha256: sha256(bytes) }], notices: [] };
  await assert.rejects(checkedResources(root, policy), /ENOENT/);
  await writeFile(path.join(root, 'model.bin'), 'changed');
  await assert.rejects(checkedResources(root, policy), /hash mismatch/);
  await writeFile(path.join(root, 'model.bin'), bytes); await checkedResources(root, policy);
  const json = Buffer.from(JSON.stringify({ buffers: [{ uri: '../../secret.bin' }] }).padEnd(80, ' '));
  const glb = Buffer.alloc(20 + json.length); glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  await writeFile(path.join(root, 'model.glb'), glb);
  await assert.rejects(checkedResources(root, { files: [{ source: 'model.glb', path: 'model.glb', sha256: sha256(glb) }], notices: [] }), /External GLB/);
});
test('independent live resource registry and VAT/bin dependency closure are included', async () => {
  const { policy } = await loadPolicy(); const files = new Set(policy.files.map(f => `/${f.path}`));
  const server = await createServer({ configFile: false, root: projectRoot, publicDir: false, envDir: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { DEFAULT_CAMPAIGN_RESOURCES } = await server.ssrLoadModule('/src/campaign/rendering/resources.ts');
    assert.equal(DEFAULT_CAMPAIGN_RESOURCES.female.url, '/s06/cleaner-female/model.glb');
    for (const resource of Object.values(DEFAULT_CAMPAIGN_RESOURCES)) {
      assert.ok(files.has(resource.url), resource.url);
      for (const a of Object.values(resource.attachments ?? {})) assert.ok(files.has(a.url), a.url);
    }
  } finally { await server.close(); }
  const json = async name => JSON.parse(await readFile(path.join(projectRoot, 'assets', name), 'utf8'));
  const vatBase = 'game/germanica/crowd/adult/';
  const resolve = (base, ref) => path.posix.normalize(path.posix.join(path.posix.dirname(base), ref));
  const required = [vatBase + 'vat.json', 'game/props/bin.glb'];
  for (const lod of (await json(vatBase + 'vat.json')).lods) {
    for (const ref of [lod.mesh, lod.vat, lod.sourceModel]) required.push(resolve(vatBase + 'vat.json', ref));
    const vat = resolve(vatBase + 'vat.json', lod.vat), meta = await json(vat);
    for (const ref of [meta.position.file, meta.normal.file]) required.push(resolve(vat, ref));
    const mesh = resolve(vatBase + 'vat.json', lod.mesh); required.push(resolve(mesh, (await json(mesh)).data));
  }
  for (const food of (await json('game/props/manifest.json')).foods) for (const model of Object.values(food.states)) required.push('game/props/' + model);
  for (const effect of (await json('game/props/audio-record.json')).effects) {
    required.push(`game/props/${effect.name}.wav`);
    assert.equal(policy.files.find(f => f.path === `game/props/${effect.name}.wav`)?.sha256, effect.sha256);
  }
  for (const name of required) assert.ok(files.has('/' + name), name);
  assert.equal(policy.files.filter(f => f.path.startsWith('steam-v1/s07-s08/')).length, 9);
  assert.equal(policy.files.filter(f => f.path.startsWith('steam-v1/s07-four-states/')).length, 4);
  assert.ok(policy.notices.some(f => f.source === 'node_modules/three/LICENSE'));
  assert.ok(policy.notices.some(f => f.source === 'assets/s06/cleaner-female/license.txt'));
  assert.ok(policy.notices.some(f => f.source === 'assets/s06/cleaner-female/source-record.md'));
  assert.ok(policy.inputs.includes('assets/s06/cleaner-female/manifest.json'));
  assert.ok(!policy.files.some(f => f.path.startsWith('maintenance-r19/')));
});
test('changed runtime metadata cannot redirect to unlisted/traversing files or a wrong hash', async t => {
  const root = await temporary(t), { policy } = await loadPolicy();
  const names = new Set([...policy.inputs.filter(n => n.startsWith('assets/') && n.endsWith('.json')),
    ...policy.files.filter(f => f.source.endsWith('.json')).map(f => f.source)]);
  for (const name of names) await writeNew(root, name, await readFile(path.join(projectRoot, name)));
  await validateRuntimePaths(root, policy);
  for (const [name, mutate, expected] of [
    ['assets/s06/cleaner-female/manifest.json', m => m.model = 'unknown.glb', /Unlisted runtime/],
    ['assets/s06/cleaner-female/manifest.json', m => m.model = '../../secret.glb', /Unsafe relative/],
    ['assets/s06/cleaner-female/manifest.json', m => m.attachments.clean.model = 'unknown-tool.glb', /Unlisted runtime/],
    ['assets/steam-v1/s07-s09/manifest.json', m => m.assets[0].sha256.model = '0'.repeat(64), /metadata hash mismatch/],
    ['assets/steam-v1/s07-four-states/manifest.json', m => m.assets[0].model = '../unreviewed/model.glb', /Unsafe relative/],
    ['assets/steam-v1/s07-four-states/manifest.json', m => m.assets[0].sha256.model = '0'.repeat(64), /metadata hash mismatch/],
    ['assets/steam-v1/s07-four-states/cleaner-home-light-damaged/manifest.json', m => m.id = 'home.frog.light-damaged', /Individual manifest mismatch/],
    ['assets/steam-v1/s07-four-states/manifest.json', m => m.stateMapping.cleaner.normal.model = '../s07-s08/frog-home/model.glb', /Four-state mapping/],
    ['assets/game/germanica/crowd/adult/lod1/vat.json', m => m.position.file = 'https://example.com/x', /Unsafe runtime/],
  ]) {
    const file = path.join(root, name), original = await readFile(file), json = JSON.parse(original); mutate(json);
    await writeFile(file, JSON.stringify(json)); await assert.rejects(validateRuntimePaths(root, policy), expected); await writeFile(file, original);
  }
});
test('real candidate build is reproducible, closed, hashed, and detects injected content', async t => {
  const root = await temporary(t), first = path.join(root, 'one'), second = path.join(root, 'two');
  const a = await buildCandidate(first), b = await buildCandidate(second);
  assert.deepEqual(a, b, 'Two builds of unchanged inputs must produce identical manifests and bytes');
  assert.equal(a.releaseReady, false); assert.equal(a.nativeExecutableBound, false);
  for (const file of a.files) {
    assert.doesNotMatch(file.path, /mimi|sadako|kunkun|companions|preview|evidence|\.blend|\.ts$|\.map$/i);
    const actual = await readFile(path.join(first, 'frontend', file.path));
    assert.equal(file.sha256, createHash('sha256').update(actual).digest('hex'));
  }
  await assert.rejects(buildCandidate(first), /EEXIST/);
  for (const extra of ['unknown.bin', 'companions/companion.mimi/model.glb', 'preview.html', 'source.blend', 'assets/unknown.js']) {
    const destination = path.join(first, 'frontend', extra); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, 'injected');
    await assert.rejects(verifyCandidate(first), /Unknown|extra/);
    await unlink(destination);
    // Use a fresh known-good tree for subsequent mutations (no cleanup of arbitrary paths).
    if (extra.includes('companions/')) {
      const owned = path.resolve(first, 'frontend/companions'); assert.ok(owned.startsWith(root + path.sep));
      await safePath(owned, 'directory'); await rm(owned, { recursive: true });
    }
  }
  const target = path.join(first, 'frontend/index.html'), original = await readFile(target);
  await writeFile(target, 'tampered'); await assert.rejects(verifyCandidate(first), /hash mismatch/); await writeFile(target, original);
  await unlink(target); await assert.rejects(verifyCandidate(first), /missing/); await writeFile(target, original);
  const extraRoot = path.join(first, 'unexpected.txt'); await writeFile(extraRoot, 'extra'); await assert.rejects(verifyCandidate(first), /Extra candidate root/); await unlink(extraRoot);
  const linked = path.join(first, 'frontend/linked'); await symlink(path.join(second, 'frontend'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(verifyCandidate(first), /Symlink|junction/); } finally { await unlink(linked); }
  await verifyCandidate(first);
  const manifestPath = path.join(first, 'candidate-manifest.json'), originalManifest = await readFile(manifestPath);
  // Rehashing an editable manifest must not authorize arbitrary newly generated code.
  const extraJs = path.join(first, 'frontend/assets/extra.js'); await writeFile(extraJs, 'globalThis.injected = true;');
  const rehashed = structuredClone(a); rehashed.generated.push('assets/extra.js'); rehashed.generated.sort(); rehashed.files = await inventory(path.join(first, 'frontend'));
  await writeFile(manifestPath, JSON.stringify(rehashed));
  await assert.rejects(verifyCandidate(first), /differ from rebuilt frontend/);
  await unlink(extraJs); await writeFile(manifestPath, originalManifest);
  await writeFile(target, '<html>replaced</html>');
  const replaced = structuredClone(a); replaced.files = await inventory(path.join(first, 'frontend'));
  await writeFile(manifestPath, JSON.stringify(replaced));
  await assert.rejects(verifyCandidate(first), /bytes differ from rebuilt frontend/);
  await writeFile(target, original); await writeFile(manifestPath, originalManifest);
  const missingDependency = structuredClone(a); missingDependency.inputs = missingDependency.inputs.filter(f => !f.path.startsWith('node_modules/'));
  await writeFile(manifestPath, JSON.stringify(missingDependency));
  await assert.rejects(verifyCandidate(first), /Missing source provenance/);
  await writeFile(manifestPath, originalManifest);
});
