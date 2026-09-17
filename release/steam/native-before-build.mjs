import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, snapshot, sha256, nativePath, assertTree, assertRecords, rejectCargoConfigs, digest, stable, writeNew } from './native-safety.mjs';
import { HOOK_WRAPPER_FILE, loadNativePolicy, nativeConfig, assertNativeHookWrapper, assertNativeFrontend } from './native-policy.mjs';

export async function verifyBeforeBuild(contextPath, expectedSha256, observedEnv = process.env) {
  contextPath = nativePath(contextPath);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw Error('beforeBuild requires builder-supplied context SHA-256');
  const bytes = (await snapshot(contextPath)).bytes;
  if (sha256(bytes) !== expectedSha256) throw Error('beforeBuild context hash mismatch');
  const c = JSON.parse(bytes);
  if (c.kind !== 'steam-native-build-context' || c.schemaVersion !== 1 || path.resolve(c.output, 'build-context.json') !== contextPath || path.resolve(c.output, 'project') !== c.project || path.resolve(c.output, 'candidate') !== c.candidate) throw Error('Invalid build context paths');
  const policy = await loadNativePolicy(c.project);
  if (policy.policyFileSha256 !== c.nativePolicySha256) throw Error('beforeBuild native policy changed');
  await rejectCargoConfigs([c.project, path.join(c.project, 'src-tauri')], c.cargoHome);
  await assertRecords(c.project, c.inputs);
  await assertTree(c.candidate, c.candidateFiles);
  const frontendFiles = c.candidateFiles.filter(f => f.path.startsWith('frontend/')).map(f => ({ ...f, path: f.path.slice(9) }));
  const frontendIdentities = await assertNativeFrontend(c.project, c.candidate, frontendFiles, c.frontendIdentities);
  const configuration = nativeConfig(policy.defaultConfig, { project: c.project, candidate: c.candidate, context: contextPath, contextSha256: expectedSha256, node: c.node });
  if (c.beforeBuildWrapperPath !== path.join(c.output, HOOK_WRAPPER_FILE)) throw Error('Invalid native hook wrapper context path');
  const wrapperIdentity = await assertNativeHookWrapper(configuration);
  const override = JSON.parse((await snapshot(path.join(c.output, 'tauri-override.json'))).bytes);
  if (stable(override) !== stable(configuration.override)) throw Error('beforeBuild override changed');
  const envConfig = JSON.parse(observedEnv.TAURI_CONFIG ?? 'null');
  if (stable(envConfig) !== stable(configuration.override)) throw Error('Tauri runtime merge input differs from controlled override');
  // Only the CLI may add its documented hook variables. Every controlled compiler
  // and PATH value is compared with the parent process snapshot, case-insensitively.
  const observed = Object.fromEntries(Object.entries(observedEnv).map(([k, v]) => [k.toUpperCase(), v]));
  if (observed.TAURI_ENV_TARGET_TRIPLE !== TARGET) throw Error('Tauri hook target triple differs from controlled target');
  // The pinned CLI writes its default verbosity into the hook environment.
  // No CLI -v is authorized and ambient TAURI_* was rejected by the builder.
  if (observed.TAURI_CLI_VERBOSITY !== '0') throw Error('Tauri CLI verbosity differs from fixed command');
  for (const [k, v] of Object.entries(c.environment)) if (observed[k.toUpperCase()] !== v) throw Error(`beforeBuild environment changed: ${k}`);
  for (const key of Object.keys(observed)) if (/^(?:TAURI|CARGO|RUST|NODE_|CC_|CXX_|AR_|LD_|CL$|_CL_|LINK$|_LINK_|BINDGEN|VCPKG|CMAKE|PKG_CONFIG)/.test(key) &&
    !Object.keys(c.environment).some(k => k.toUpperCase() === key) && !['TAURI_CONFIG', 'TAURI_CLI_VERBOSITY'].includes(key) && !/^TAURI_ENV_(?:PLATFORM|ARCH|FAMILY|PLATFORM_VERSION|PLATFORM_TYPE|DEBUG|TARGET_TRIPLE)$/.test(key)) throw Error(`Unexpected beforeBuild environment: ${key}`);
  const { verifyCandidate } = await import('./build-candidate.mjs');
  const frontend = await verifyCandidate(c.candidate, c.project);
  if (frontend.policySha256 !== c.frontendPolicySha256 || digest(frontend.files) !== c.frontendTreeSha256) throw Error('beforeBuild candidate changed');
  await assertRecords(c.project, c.inputs);
  await assertTree(c.candidate, c.candidateFiles);
  await assertNativeHookWrapper(configuration, wrapperIdentity);
  await assertNativeFrontend(c.project, c.candidate, frontendFiles, frontendIdentities);
  const receipt = { schemaVersion: 1, kind: 'steam-native-before-build-verification', contextSha256: expectedSha256, candidateManifestSha256: c.candidateManifestSha256, frontendTreeSha256: c.frontendTreeSha256, effectiveConfigSha256: configuration.effectiveSha256, beforeBuildWrapperSha256: configuration.beforeBuildWrapper.sha256, observedTauriConfigSha256: digest(envConfig), tauriHookEnvironment: Object.fromEntries(Object.entries(observed).filter(([k]) => k.startsWith('TAURI_ENV_'))), verified: true, nativeExecutableBound: false };
  await writeNew(c.output, 'before-build-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--context' || process.argv[4] !== '--sha256') throw Error('Internal hook: --context FILE --sha256 BUILDER_CONTEXT_HASH');
    console.log(JSON.stringify(await verifyBeforeBuild(process.argv[3], process.argv[5])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
