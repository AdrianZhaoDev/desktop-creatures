import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readdir, lstat, link, unlink } from 'node:fs/promises';
import { uniqueNames } from './candidate-safety.mjs';
import { assertPlainPath } from './prepare-build.mjs';
import { TARGET, FEATURES, nativePath, inside, plain, snapshot, tree, records, sha256, digest, stable, sameFile, sameIdentity, newDirectory, copyRecords, assertRecords, assertTree, rejectAmbientEnvironment, rejectCargoConfigs, writeNew } from './native-safety.mjs';
import { POLICY_FILE, HOOK_WRAPPER_FILE, loadNativePolicy, nativeInputRecords, nativeConfig, assertNativeHookWrapper, assertNativeFrontend } from './native-policy.mjs';
import { command, prepareToolchain, verifyToolchain } from './native-toolchain.mjs';
import { EMBEDDING_KIND, createEmbeddingProof, assertEmbeddingClosure, verifyEmbeddingProbe } from './native-embedding.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_FILE = 'native-candidate-manifest.json';
export const MANIFEST_KIND = 'steam-controlled-native-candidate';
const GENERATED_METADATA = ['src-tauri/gen/schemas/acl-manifests.json', 'src-tauri/gen/schemas/capabilities.json', 'src-tauri/gen/schemas/desktop-schema.json', 'src-tauri/gen/schemas/windows-schema.json'];

// Authorization comes from checked input bytes, never from what happens to exist
// in content when it is scanned. Clone bytes so later caller mutation cannot alter
// the plan, and freeze the records that the final writer/verifier must enforce.
export function nativeContentPlan(executableBytes, executable, frontendNotices, notices) {
  if (!Buffer.isBuffer(executableBytes) || executable.path !== 'desktop-creatures.exe' || executable.bytes !== executableBytes.length || executable.sha256 !== sha256(executableBytes)) throw Error('Checked executable bytes differ from PE result');
  if (!Buffer.isBuffer(frontendNotices) || !Buffer.isBuffer(notices.noticesBytes) || sha256(notices.noticesBytes) !== notices.noticesSha256 || !Array.isArray(notices.artifacts)) throw Error('Invalid checked native notices');
  const artifacts = [
    { path: 'desktop-creatures.exe', bytes: Buffer.from(executableBytes) },
    { path: 'THIRD-PARTY-NOTICES.txt', bytes: Buffer.concat([frontendNotices, Buffer.from('\n\n===== CONTROLLED NATIVE DEPENDENCIES =====\nPaths in the following section are relative to native-notices/.\n'), notices.noticesBytes]) },
    ...notices.artifacts.map(a => {
      if (!Buffer.isBuffer(a.bytes) || sha256(a.bytes) !== a.sha256) throw Error(`Native notice artifact hash mismatch: ${a.path}`);
      return { path: `native-notices/${a.path}`, bytes: Buffer.from(a.bytes) };
    }),
  ];
  uniqueNames(artifacts.map(a => a.path));
  const expectedContentRecords = Object.freeze(artifacts.map(a => Object.freeze({ path: a.path, bytes: a.bytes.length, sha256: sha256(a.bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { artifacts, expectedContentRecords };
}
export async function assertNativeContent(content, expectedContentRecords, identity) {
  const assertIdentity = async () => { if (!sameIdentity(identity, await plain(content, 'directory'))) throw Error('Native content directory identity changed'); };
  await assertIdentity();
  // Include directory names in the authorization check, including empty extras.
  const directories = new Set();
  for (const file of expectedContentRecords) for (let dir = path.posix.dirname(file.path); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
  async function visit(prefix = '') {
    for (const entry of await readdir(path.join(content, prefix), { withFileTypes: true })) if (entry.isDirectory()) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!directories.has(name)) throw Error(`Unauthorized native content directory: ${name}`);
      await plain(path.join(content, name), 'directory'); await visit(name);
    }
  }
  await visit(); await assertTree(content, expectedContentRecords); await assertIdentity();
}
export async function publishNativeManifest(output, manifest, expectedContentRecords, contentIdentity, outputIdentity, sourceGuard) {
  if (manifest.nativeExecutableBound === true && typeof sourceGuard !== 'function') throw Error('Native binding requires the final frontend/source guard');
  const content = path.join(output, 'content'), pending = path.join(output, '.native-manifest.pending'), final = path.join(output, MANIFEST_FILE);
  const guard = async () => {
    if (!sameIdentity(outputIdentity, await plain(output, 'directory'))) throw Error('Native output directory identity changed');
    await assertNativeContent(content, expectedContentRecords, contentIdentity);
    if (sourceGuard) await sourceGuard();
  };
  await guard();
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeNew(output, '.native-manifest.pending', bytes);
  const owned = await plain(pending);
  let published = false;
  try {
    await guard();
    // Hardlink publication is exclusive (unlike rename replacement). The pending
    // name is immediately removed, leaving a unique file. No existing file is replaced.
    await link(pending, final); published = true;
    if (!sameIdentity(owned, await assertPlainPath(pending))) throw Error('Pending manifest replaced');
    await unlink(pending);
    await guard();
    const result = await snapshot(final);
    if (result.sha256 !== sha256(bytes)) throw Error('Published native manifest changed');
    return result.sha256;
  } catch (error) {
    // Revoke only files created by this publication attempt, never old output or
    // a substituted pathname. A failed seal cannot leave a successful manifest.
    for (const file of [...(published ? [final] : []), pending]) {
      try { const info = await assertPlainPath(file); if (sameIdentity(owned, info) && info.isFile()) await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    throw error;
  }
}

export function parseNativeArgs(argv) {
  if (argv.length === 1 && ['--help', '--check-policy'].includes(argv[0])) return { mode: argv[0].slice(2) };
  const options = {};
  const allowed = new Set(['--candidate', '--output', '--verify', '--expected-manifest-sha256']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.has(key) || options[key] !== undefined || !value || value.startsWith('--')) throw Error('Invalid native CLI; --exe, runner/config/target/features overrides are not supported');
    options[key] = value;
  }
  if (options['--candidate'] && options['--output'] && Object.keys(options).length === 2) return { mode: 'build', candidate: options['--candidate'], output: options['--output'] };
  if (options['--candidate'] && options['--verify'] && options['--expected-manifest-sha256'] && Object.keys(options).length === 3) return { mode: 'verify', candidate: options['--candidate'], output: options['--verify'], expectedManifestSha256: options['--expected-manifest-sha256'] };
  throw Error('Supply exact --candidate DIR and --output NEW_DIR, or --verify DIR --candidate DIR --expected-manifest-sha256 independently-retained-hash');
}
export function nativeBuildArgv(project, output) {
  return [path.join(project, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', TARGET, '--no-bundle', '--no-sign', '--ci', '--config', path.join(output, 'tauri-override.json'), '--', '--locked', '--offline', '--verbose'];
}
export function metadataArgv(project) {
  return ['metadata', '--manifest-path', path.join(project, 'src-tauri/Cargo.toml'), '--format-version', '1', '--filter-platform', TARGET, '--features', FEATURES.join(','), '--locked', '--offline'];
}
export async function validateNewOutput(root, candidate, output) {
  for (const p of [root, candidate, output]) nativePath(p);
  await plain(candidate, 'directory'); await plain(path.dirname(output), 'directory');
  if (output.split(/[\\/]/).some(p => /^\.steam-(?:candidate|content)-/i.test(p)) || inside(candidate, output) || inside(output, root) || inside(output, candidate) || output === root) throw Error('Native output must be new, isolated, and outside protected candidate/content trees');
  if (await assertPlainPath(output, { missingLeaf: true })) throw Error('Output already exists (EEXIST)');
}
async function assertProject(project, expected, built = false) {
  const actual = await tree(project);
  const expectedNames = new Set(expected.map(f => f.path));
  const extra = actual.filter(f => !expectedNames.has(f.path));
  if (extra.some(f => !built || !GENERATED_METADATA.includes(f.path))) throw Error('Unexpected file in isolated project');
  await assertRecords(project, expected);
  return extra;
}
async function checkOriginal(root, candidate, source, candidateFiles, sourceInfo, candidateInfo) {
  if (!sameIdentity(sourceInfo, await plain(root, 'directory')) || !sameIdentity(candidateInfo, await plain(candidate, 'directory'))) throw Error('Source/candidate root replaced');
  await loadNativePolicy(root);
  await assertRecords(root, source.inputs);
  await assertTree(candidate, candidateFiles);
}
async function metadata(toolchain, project, name) {
  const result = await command(toolchain.cargo, metadataArgv(project), { cwd: path.join(project, 'src-tauri'), env: toolchain.env, logRoot: toolchain.logRoot, name });
  const data = JSON.parse(result.stdout);
  if (!data.resolve?.root || data.workspace_members?.length !== 1 || data.workspace_root !== path.join(project, 'src-tauri')) throw Error('Unexpected Cargo workspace/metadata root');
  const pkg = data.packages.find(p => p.id === data.resolve.root);
  if (pkg?.name !== 'desktop-creatures' || pkg.source !== null || pkg.manifest_path !== path.join(project, 'src-tauri/Cargo.toml')) throw Error('Wrong Cargo root package');
  for (const p of data.packages) if (p.id !== pkg.id && p.source !== 'registry+https://github.com/rust-lang/crates.io-index') throw Error(`Unreviewed Cargo dependency source: ${p.name}`);
  if (stable(pkg.targets.filter(t => t.kind.includes('bin')).map(t => t.name)) !== stable(['desktop-creatures'])) throw Error('Unexpected Cargo executable targets');
  await writeNew(path.dirname(toolchain.logRoot), `${name}.json`, JSON.stringify(data, null, 2) + '\n');
  return { data, command: result.record };
}
// Cargo may create hardlinks from deps into the fixed release path. The PE module
// first proves every alias is contained in this new release inventory. This copier
// then materializes unique bytes; external input hardlinks are never accepted.
async function materializeCargoExe(release, output, audit) {
  const file = path.join(release, 'desktop-creatures.exe');
  const before = await assertPlainPath(file);
  if (!before.isFile()) throw Error('Fixed Cargo EXE missing');
  if (before.nlink > 1 && !audit.hardlinkGroups?.some(g => g.paths.includes('desktop-creatures.exe') && g.linkCount === before.nlink)) throw Error('Cargo EXE hardlink aliases were not fully audited');
  const handle = await open(file, 'r');
  try {
    if (!sameFile(before, await handle.stat())) throw Error('Cargo EXE changed while opening');
    const bytes = await handle.readFile();
    const expected = audit.files.find(f => f.path === 'desktop-creatures.exe');
    if (!expected || expected.sha256 !== sha256(bytes) || !sameFile(before, await handle.stat()) || !sameFile(before, await assertPlainPath(file))) throw Error('Cargo EXE changed while copying');
    await writeNew(output, 'desktop-creatures.exe', bytes);
    return bytes;
  } finally { await handle.close(); }
}

export async function buildNativeCandidate({ candidate, output, root = projectRoot }) {
  rejectAmbientEnvironment(process.env);
  root = nativePath(root); candidate = nativePath(candidate); output = nativePath(output);
  await validateNewOutput(root, candidate, output);
  const sourceInfo = await plain(root, 'directory'), candidateInfo = await plain(candidate, 'directory');
  const originalFrontendInfo = await plain(path.join(candidate, 'frontend'), 'directory');
  const loaded = await loadNativePolicy(root);
  const cargoHome = path.join(process.env.USERPROFILE, '.cargo');
  const configProbes = await rejectCargoConfigs([root, path.join(root, 'src-tauri'), path.dirname(output)], cargoHome);
  const { verifyCandidate, loadPolicy } = await import('./build-candidate.mjs');
  const frontendPolicy = (await loadPolicy(root)).policy;
  const source = await nativeInputRecords(root, loaded, frontendPolicy);
  const frontend = await verifyCandidate(candidate, root);
  const candidateFiles = await tree(candidate);
  const candidateManifest = await snapshot(path.join(candidate, 'candidate-manifest.json'));
  await checkOriginal(root, candidate, source, candidateFiles, sourceInfo, candidateInfo);
  const outputInfo = await newDirectory(output);
  const ensureOutput = async () => { if (!sameIdentity(outputInfo, await plain(output, 'directory'))) throw Error('Output root replaced'); };
  // Failure deliberately leaves an incomplete diagnostic root. No cleanup, resume,
  // caller-supplied EXE or successful manifest is allowed on this path.
  for (const name of ['project', 'candidate', 'logs', 'temp', 'cargo-target']) { await ensureOutput(); await newDirectory(path.join(output, name)); }
  const project = path.join(output, 'project'), copiedCandidate = path.join(output, 'candidate');
  await copyRecords(root, project, source.inputs);
  await copyRecords(candidate, copiedCandidate, candidateFiles);
  await assertProject(project, source.inputs);
  await verifyCandidate(copiedCandidate, project);
  const frontendIdentities = await assertNativeFrontend(project, copiedCandidate, frontend.files);
  const toolchain = await prepareToolchain({ root: project, rustVersion: loaded.rustVersion, output, ambient: process.env });
  await rejectCargoConfigs([project, path.join(project, 'src-tauri')], toolchain.cargoHome);
  const before = await metadata(toolchain, project, 'cargo-metadata-before');
  const { generateNativeNotices } = await import('./native-notices.mjs');
  const noticeOptions = { metadata: before.data, cargoLockPath: path.join(project, 'src-tauri/Cargo.lock'), cargoHome: toolchain.cargoHome, rustToolchainRoot: toolchain.rustRoot, policyPath: path.join(project, 'release/steam/native-third-party-policy.json') };
  const notices = await generateNativeNotices(noticeOptions);
  const context = { schemaVersion: 1, kind: 'steam-native-build-context', output, project, candidate: copiedCandidate, frontendIdentities, node: toolchain.node, cargoHome: toolchain.cargoHome, beforeBuildWrapperPath: path.join(output, HOOK_WRAPPER_FILE),
    nativePolicySha256: loaded.policyFileSha256, inputs: source.inputs, candidateFiles, candidateManifestSha256: candidateManifest.sha256,
    frontendPolicySha256: frontend.policySha256, frontendTreeSha256: digest(frontend.files), environment: toolchain.env };
  const contextBytes = Buffer.from(JSON.stringify(context, null, 2) + '\n'), contextSha256 = sha256(contextBytes);
  const config = nativeConfig(loaded.defaultConfig, { project, candidate: copiedCandidate, context: path.join(output, 'build-context.json'), contextSha256, node: toolchain.node });
  await writeNew(output, HOOK_WRAPPER_FILE, config.beforeBuildWrapper.content);
  const wrapperIdentity = await assertNativeHookWrapper(config);
  await writeNew(output, 'build-context.json', contextBytes);
  await writeNew(output, 'tauri-override.json', JSON.stringify(config.override, null, 2) + '\n');
  await writeNew(output, 'tauri-effective.json', JSON.stringify(config.effective, null, 2) + '\n');
  await ensureOutput();
  await checkOriginal(root, candidate, source, candidateFiles, sourceInfo, candidateInfo);
  await assertProject(project, source.inputs);
  await assertNativeHookWrapper(config, wrapperIdentity);
  const build = await command(toolchain.node, nativeBuildArgv(project, output), { cwd: project, env: toolchain.env, logRoot: toolchain.logRoot, name: 'tauri-release-build' });
  await assertNativeHookWrapper(config, wrapperIdentity);
  const hook = JSON.parse((await snapshot(path.join(output, 'before-build-receipt.json'))).bytes);
  if (hook.kind !== 'steam-native-before-build-verification' || hook.contextSha256 !== contextSha256 || hook.effectiveConfigSha256 !== config.effectiveSha256 || hook.beforeBuildWrapperSha256 !== config.beforeBuildWrapper.sha256 || hook.verified !== true) throw Error('Missing or incorrect beforeBuild receipt');
  const after = await metadata(toolchain, project, 'cargo-metadata-after');
  if (digest(before.data) !== digest(after.data)) throw Error('Cargo graph changed during build');
  const afterNotices = await generateNativeNotices({ ...noticeOptions, metadata: after.data });
  if (notices.manifestSha256 !== afterNotices.manifestSha256 || notices.noticesSha256 !== afterNotices.noticesSha256) throw Error('Cargo source/library/license changed during build');
  await verifyToolchain(toolchain.evidence);
  await rejectCargoConfigs([root, path.join(root, 'src-tauri'), project, path.join(project, 'src-tauri')], toolchain.cargoHome);
  await checkOriginal(root, candidate, source, candidateFiles, sourceInfo, candidateInfo);
  const generatedBuildMetadata = await assertProject(project, source.inputs, true);
  await assertTree(copiedCandidate, candidateFiles);
  const { assertNativeOutputs, inspectNativeExecutable } = await import('./native-pe.mjs');
  const release = path.join(output, 'cargo-target', TARGET, 'release');
  const nativeOutputs = await assertNativeOutputs(release);
  await ensureOutput(); const contentIdentity = await newDirectory(path.join(output, 'content'));
  const executableBytes = await materializeCargoExe(release, path.join(output, 'content'), nativeOutputs);
  const executable = await inspectNativeExecutable(path.join(output, 'content/desktop-creatures.exe'));
  const embedding = await createEmbeddingProof({ project, output, candidate: copiedCandidate, frontendFiles: frontend.files, toolchain, executablePath: path.join(output, 'content/desktop-creatures.exe') });
  const frontendNotices = (await snapshot(path.join(copiedCandidate, 'frontend/THIRD-PARTY-NOTICES.txt'))).bytes;
  const contentPlan = nativeContentPlan(executableBytes, executable, frontendNotices, notices);
  const contentFiles = contentPlan.expectedContentRecords;
  for (const artifact of contentPlan.artifacts.filter(a => a.path !== 'desktop-creatures.exe')) {
    await ensureOutput();
    if (!sameIdentity(contentIdentity, await plain(path.join(output, 'content'), 'directory'))) throw Error('Native content directory identity changed');
    await writeNew(output, `content/${artifact.path}`, artifact.bytes);
  }
  await assertNativeContent(path.join(output, 'content'), contentFiles, contentIdentity);
  if (digest(await assertNativeOutputs(release)) !== digest(nativeOutputs)) throw Error('Cargo outputs changed while staging');
  await ensureOutput();
  await checkOriginal(root, candidate, source, candidateFiles, sourceInfo, candidateInfo);
  await assertProject(project, source.inputs, true);
  await assertTree(copiedCandidate, candidateFiles);
  const evidenceFiles = await evidenceInventory(output);
  const manifest = { schemaVersion: 2, kind: MANIFEST_KIND, nativeExecutableBound: true, bindingAssurance: 'controlled-local-build',
    releaseReady: false, steamSdkConnected: false, steamCmdInvoked: false, uploaded: false, codeSigned: false, rightsComplete: false,
    source: { root, candidate, candidateManifestSha256: candidateManifest.sha256, frontendPolicySha256: frontend.policySha256, frontendTreeSha256: digest(frontend.files), frontendFiles: frontend.files, candidateFiles, nativePolicySha256: loaded.policyFileSha256, nativeInputs: source.inputs, npmTooling: source.tooling },
    build: { output, project, profile: 'release', target: TARGET, features: FEATURES, cargoReleaseBehavior: 'Tauri 2.11.4 adds --release --bins and tauri/custom-protocol; raw argv and verbose log retained', contextSha256, configuration: config, command: build.record, metadataCommands: [before.command, after.command], cargoGraphSha256: digest(before.data), toolchain: toolchain.evidence, rejectedCargoConfigProbes: configProbes, generatedBuildMetadata, nativeOutputs, frontendEmbedding: embedding.proof },
    executable, notices: { manifestSha256: notices.manifestSha256, noticesSha256: notices.noticesSha256, closure: notices.closure, nativeLibraries: notices.nativeLibraries, rightsLimits: notices.rightsLimits },
    contentFiles, contentTreeSha256: digest(contentFiles), evidenceFiles,
    assuranceLimits: ['Controlled local build observation, not a digital signature or independently reproducible binary proof.', 'Persisted verification requires a manifest SHA-256 retained outside this editable output; a colocated JSON/hash is not authority.', 'Visible path aliases, hardlinks and changed inputs fail; hostile same-user/kernel/toolchain compromise and all TOCTOU races are outside this process boundary.', 'No native manual matrix, 15-person playtest, Steam identity/SDK/account/AppID/upload/Valve approval or release authorization is supplied by this build.'] };
  validateNativeManifest(manifest);
  await assertNativeHookWrapper(config, wrapperIdentity);
  // Final exclusive write only after every source, config, PE, notice and content gate.
  const hash = await publishNativeManifest(output, manifest, contentFiles, contentIdentity, outputInfo, async () => {
    if (!sameIdentity(originalFrontendInfo, await plain(path.join(candidate, 'frontend'), 'directory'))) throw Error('Original frontend root replaced');
    await checkOriginal(root, candidate, source, candidateFiles, sourceInfo, candidateInfo);
    await assertProject(project, source.inputs, true);
    await assertTree(copiedCandidate, candidateFiles);
    await assertNativeFrontend(project, copiedCandidate, frontend.files, frontendIdentities);
    await assertNativeHookWrapper(config, wrapperIdentity);
    await assertEmbeddingClosure({ proof: embedding.proof, project, candidate: copiedCandidate, frontendFiles: frontend.files, executablePath: path.join(output, 'content/desktop-creatures.exe'), identities: embedding.identities });
  });
  return { manifest, manifestSha256: hash, output, instruction: 'Retain manifestSha256 outside this output for later verification; it is not code signing.' };
}

async function evidenceInventory(output) {
  const allowedFiles = ['build-context.json', 'tauri-override.json', 'tauri-effective.json', 'before-build-receipt.json', 'cargo-metadata-before.json', 'cargo-metadata-after.json', HOOK_WRAPPER_FILE];
  const allowedDirs = ['project', 'candidate', 'logs', 'temp', 'cargo-target', 'content', 'embedding-probe'];
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE) { await plain(path.join(output, entry.name)); continue; }
    if (entry.isDirectory() ? !allowedDirs.includes(entry.name) : !allowedFiles.includes(entry.name)) throw Error(`Unknown native output entry: ${entry.name}`);
    await plain(path.join(output, entry.name), entry.isDirectory() ? 'directory' : 'file');
  }
  return [...await records(output, allowedFiles), ...(await tree(path.join(output, 'logs'))).map(f => ({ ...f, path: `logs/${f.path}` })), ...(await tree(path.join(output, 'embedding-probe'))).map(f => ({ ...f, path: `embedding-probe/${f.path}` }))].sort((a, b) => a.path.localeCompare(b.path));
}
export function validateNativeManifest(m) {
  if (m?.schemaVersion !== 2 || m.kind !== MANIFEST_KIND || m.nativeExecutableBound !== true || m.bindingAssurance !== 'controlled-local-build') throw Error('Not a controlled native manifest with proven frontend embedding; legacy r2 binding is revoked');
  if (m.build?.frontendEmbedding?.kind !== EMBEDDING_KIND || m.build.frontendEmbedding.verified !== true || m.build.frontendEmbedding.frontendDistKind !== 'Directory' || !m.build.frontendEmbedding.assetCount || m.build.frontendEmbedding.assetCount !== m.source?.frontendFiles?.length) throw Error('Missing complete native frontend embedding proof');
  for (const key of ['releaseReady', 'steamSdkConnected', 'steamCmdInvoked', 'uploaded', 'codeSigned', 'rightsComplete']) if (m[key] !== false) throw Error(`Invalid native gate: ${key}`);
  if (m.build?.target !== TARGET || m.build?.profile !== 'release' || stable(m.build.features) !== stable(FEATURES) || m.build?.configuration?.effective?.bundle?.active !== false) throw Error('Invalid controlled build configuration');
  for (const key of ['source', 'build', 'executable', 'notices', 'contentFiles', 'evidenceFiles', 'assuranceLimits']) if (!m[key]) throw Error(`Missing native provenance: ${key}`);
  if (m.executable.sha256 !== m.contentFiles.find(f => f.path === 'desktop-creatures.exe')?.sha256 || digest(m.contentFiles) !== m.contentTreeSha256) throw Error('Invalid native content binding');
}
export async function verifyNativeCandidate({ output, candidate, expectedManifestSha256, root = projectRoot }) {
  rejectAmbientEnvironment(process.env);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '')) throw Error('Independent expected manifest SHA-256 is required; editable JSON is not authority');
  root = nativePath(root); output = nativePath(output); candidate = nativePath(candidate);
  const s = await snapshot(path.join(output, MANIFEST_FILE));
  if (s.sha256 !== expectedManifestSha256) throw Error('Independent manifest SHA-256 mismatch');
  const m = JSON.parse(s.bytes); validateNativeManifest(m);
  const contentIdentity = await plain(path.join(output, 'content'), 'directory');
  const outputIdentity = await plain(output, 'directory');
  const sourceIdentity = await plain(root, 'directory'), candidateIdentity = await plain(candidate, 'directory'), originalFrontendIdentity = await plain(path.join(candidate, 'frontend'), 'directory');
  if (m.source.root !== root || m.source.candidate !== candidate || m.build.output !== output || m.build.project !== path.join(output, 'project')) throw Error('Native origin paths do not match explicit verifier inputs');
  const loaded = await loadNativePolicy(root);
  if (loaded.policyFileSha256 !== m.source.nativePolicySha256) throw Error('Reviewed native policy changed');
  const { verifyCandidate, loadPolicy } = await import('./build-candidate.mjs');
  const frontend = await verifyCandidate(candidate, root);
  const frontendIdentities = await assertNativeFrontend(m.build.project, path.join(output, 'candidate'), frontend.files);
  const sources = await nativeInputRecords(root, loaded, (await loadPolicy(root)).policy);
  if (digest(sources.inputs) !== digest(m.source.nativeInputs) || frontend.policySha256 !== m.source.frontendPolicySha256 || digest(frontend.files) !== m.source.frontendTreeSha256) throw Error('Reviewed source/frontend no longer matches native build');
  if ((await snapshot(path.join(candidate, 'candidate-manifest.json'))).sha256 !== m.source.candidateManifestSha256) throw Error('Candidate manifest changed');
  await assertTree(candidate, m.source.candidateFiles);
  await assertTree(path.join(output, 'candidate'), m.source.candidateFiles);
  const generated = await assertProject(m.build.project, m.source.nativeInputs, true);
  if (digest(generated) !== digest(m.build.generatedBuildMetadata)) throw Error('Generated build metadata changed');
  await assertTree(path.join(output, 'content'), m.contentFiles);
  if (digest(await evidenceInventory(output)) !== digest(m.evidenceFiles)) throw Error('Native evidence changed');
  await rejectCargoConfigs([root, path.join(root, 'src-tauri'), m.build.project, path.join(m.build.project, 'src-tauri')], m.build.toolchain.environment.CARGO_HOME);
  await verifyToolchain(m.build.toolchain);
  const { inspectNativeExecutable, assertNativeOutputs } = await import('./native-pe.mjs');
  if (digest(await inspectNativeExecutable(path.join(output, 'content/desktop-creatures.exe'))) !== digest(m.executable)) throw Error('Native PE changed');
  if (digest(await assertNativeOutputs(path.join(output, 'cargo-target', TARGET, 'release'))) !== digest(m.build.nativeOutputs)) throw Error('Fixed Cargo outputs changed');
  const config = nativeConfig(loaded.defaultConfig, { project: m.build.project, candidate: path.join(output, 'candidate'), context: path.join(output, 'build-context.json'), contextSha256: m.build.contextSha256, node: m.build.toolchain.files.find(f => f.path.toLowerCase().endsWith('node.exe'))?.path });
  if (digest(config) !== digest(m.build.configuration)) throw Error('Tauri merge/effective config mismatch');
  await assertNativeHookWrapper(config);
  await verifyEmbeddingProbe({ proof: m.build.frontendEmbedding, project: m.build.project, output, candidate: path.join(output, 'candidate'), frontendFiles: frontend.files, env: m.build.toolchain.environment });
  const { generateNativeNotices } = await import('./native-notices.mjs');
  const metadata = JSON.parse((await snapshot(path.join(output, 'cargo-metadata-before.json'))).bytes);
  const notices = await generateNativeNotices({ metadata, cargoLockPath: path.join(m.build.project, 'src-tauri/Cargo.lock'), cargoHome: m.build.toolchain.environment.CARGO_HOME, rustToolchainRoot: m.build.toolchain.rustRoot, policyPath: path.join(m.build.project, 'release/steam/native-third-party-policy.json') });
  if (notices.manifestSha256 !== m.notices.manifestSha256 || notices.noticesSha256 !== m.notices.noticesSha256) throw Error('Native dependency/notice verification mismatch');
  const checkedExe = await inspectNativeExecutable(path.join(output, 'content/desktop-creatures.exe'));
  const executableBytes = (await snapshot(path.join(output, 'content/desktop-creatures.exe'))).bytes;
  const frontendNotices = (await snapshot(path.join(output, 'candidate/frontend/THIRD-PARTY-NOTICES.txt'))).bytes;
  const expectedContentRecords = nativeContentPlan(executableBytes, checkedExe, frontendNotices, notices).expectedContentRecords;
  if (stable(expectedContentRecords) !== stable(m.contentFiles)) throw Error('Native manifest content differs from regenerated authorized content');
  await assertNativeContent(path.join(output, 'content'), expectedContentRecords, contentIdentity);
  await assertEmbeddingClosure({ proof: m.build.frontendEmbedding, project: m.build.project, candidate: path.join(output, 'candidate'), frontendFiles: frontend.files, executablePath: path.join(output, 'content/desktop-creatures.exe'), identities: frontendIdentities });
  if (!sameIdentity(outputIdentity, await plain(output, 'directory'))) throw Error('Native output directory identity changed');
  if (!sameIdentity(sourceIdentity, await plain(root, 'directory')) || !sameIdentity(candidateIdentity, await plain(candidate, 'directory')) || !sameIdentity(originalFrontendIdentity, await plain(path.join(candidate, 'frontend'), 'directory'))) throw Error('Native verification source/frontend root replaced');
  await assertRecords(root, m.source.nativeInputs);
  await assertTree(candidate, m.source.candidateFiles);
  if ((await snapshot(path.join(output, MANIFEST_FILE))).sha256 !== expectedManifestSha256) throw Error('Manifest changed during verification');
  return { verified: true, kind: 'steam-controlled-native-verification', nativeExecutableBound: true, bindingAssurance: 'controlled-local-build', manifestSha256: expectedManifestSha256, releaseReady: false, steamSdkConnected: false, uploaded: false, codeSigned: false, verificationScope: 'Pinned prior local-build record and currently matching sources, tools, configuration, PE, content and notices; no claim of a new native rebuild.' };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseNativeArgs(argv);
  if (options.mode === 'help') return { usage: ['node release/steam/build-native-candidate.mjs --check-policy', 'node release/steam/build-native-candidate.mjs --candidate EXACT_CANDIDATE --output NEW_NATIVE_DIR', 'node release/steam/build-native-candidate.mjs --verify NATIVE_DIR --candidate EXACT_CANDIDATE --expected-manifest-sha256 INDEPENDENT_HASH'], phase1: 'Implement and test only. Wait for frozen source and an explicitly supplied new candidate before executing build.' };
  if (options.mode === 'check-policy') { const p = await loadNativePolicy(projectRoot); return { kind: 'steam-native-policy-check', target: TARGET, files: p.policy.files.length, policySha256: p.policyFileSha256, nativeExecutableBound: false, releaseReady: false }; }
  return options.mode === 'build' ? buildNativeCandidate(options) : verifyNativeCandidate(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const r = await main(); console.log(JSON.stringify(r.manifest ? { output: r.output, manifestSha256: r.manifestSha256, instruction: r.instruction, nativeExecutableBound: true, bindingAssurance: 'controlled-local-build', releaseReady: false, uploaded: false } : r, null, 2)); }
  catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
