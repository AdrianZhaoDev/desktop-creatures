import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { candidateConfig } from './vite.candidate.mjs';
import { forbidden, relativeName, uniqueNames, safePath, readSafe, writeNew, sha256, inventory } from './candidate-safety.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policyPath = 'release/steam/candidate-policy.json';
const tools = ['release/steam/build-candidate.mjs', 'release/steam/candidate-safety.mjs', 'release/steam/vite.candidate.mjs'];
const generatedPath = name => /^(?:index|trash|shortcuts)\.html$/.test(name) || /^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(name);
const deniedCode = /(?:companion\.(?:mimi|sadako|kunkun)|home\.(?:mimi|sadako|kunkun)|\/companions\/|\/src\/main\.ts|campaign-gray|game-assets-preview)/i;

export async function loadPolicy(root = projectRoot) {
  root = path.resolve(root);
  const bytes = await readSafe(path.join(root, policyPath));
  const policy = JSON.parse(bytes);
  if (policy.schemaVersion !== 1 || policy.releaseReady !== false || !policy.files?.length || !policy.notices?.length || !policy.inputs?.length) throw Error('Invalid candidate policy');
  uniqueNames(policy.files.map(f => f.path));
  uniqueNames(policy.files.map(f => f.source));
  uniqueNames(policy.notices.map(f => f.source));
  uniqueNames(policy.inputs);
  uniqueNames(policy.dependencyModules ?? []);
  if (!policy.dependencyModules?.length || policy.dependencyModules.some(name => !/^node_modules\/(?:three|@tauri-apps\/api)\//.test(name))) throw Error('Invalid dependency module allowlist');
  const tsconfig = (await readSafe(path.join(root, 'tsconfig.json'))).toString('utf8');
  if (/"(?:extends|references)"\s*:/.test(tsconfig)) throw Error('Unreviewed tsconfig dependency chain');
  // Vite resolves the closest tsconfig per module, not only the root config.
  const configDirs = new Set();
  for (const name of [...policy.inputs, ...policy.dependencyModules]) {
    if (!/\.(?:ts|js)$/.test(name)) continue;
    for (let dir = path.dirname(path.join(root, name)); dir !== root; dir = path.dirname(dir)) configDirs.add(dir);
  }
  for (const dir of configDirs) for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    try { await lstat(path.join(dir, configName)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Error(`Unreviewed nested compiler config: ${path.relative(root, path.join(dir, configName))}`);
  }
  for (const file of [...policy.files, ...policy.notices]) {
    relativeName(file.source);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw Error(`Invalid SHA-256: ${file.source}`);
    if (forbidden.test(file.source) || (file.path && (forbidden.test(file.path) || file.source !== `assets/${file.path}`))) throw Error(`Forbidden candidate resource: ${file.source}`);
  }
  for (const input of policy.inputs) {
    if (/(?:^|\/)(?:companions?|lab)(?:\/|-)|\.(?:test|spec)\.|\/runtime\.ts$/.test(input) && !input.startsWith('src/campaign/app/') && input !== 'src/companion/types.ts') throw Error(`Forbidden source input: ${input}`);
  }
  return { policy, policySha256: sha256(bytes) };
}

export async function checkedResources(root, policy) {
  const resources = new Map();
  for (const file of [...policy.files, ...policy.notices]) {
    const bytes = await readSafe(path.join(root, file.source));
    if (sha256(bytes) !== file.sha256) throw Error(`Resource hash mismatch: ${file.source}`);
    if (file.path?.endsWith('.glb')) {
      if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw Error(`Invalid GLB: ${file.path}`);
      const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
      for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) if (item.uri) throw Error(`External GLB dependency refused: ${file.path}`);
    }
    resources.set(file.source, bytes);
  }
  return resources;
}
export async function validateRuntimePaths(root, policy) {
  const allowed = new Map(policy.files.map(f => [f.path, f.sha256]));
  const json = async name => JSON.parse(await readSafe(path.join(root, 'assets', name)));
  function requireFile(name, hash) {
    relativeName(name);
    if (!allowed.has(name) || forbidden.test(name)) throw Error(`Unlisted runtime dependency: ${name}`);
    if (hash && allowed.get(name) !== hash) throw Error(`Runtime metadata hash mismatch: ${name}`);
  }
  function relative(base, ref) {
    if (typeof ref !== 'string' || /[\\:%?#]/.test(ref) || ref.startsWith('/')) throw Error('Unsafe runtime reference');
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(base), ref));
    requireFile(name); return name;
  }
  for (const base of ['s06/cleaner-female/', 's06/cleaner-male/', 's06/frog/']) {
    const manifest = await json(base + 'manifest.json');
    requireFile(base + relativeName(manifest.model));
    for (const attachment of Object.values(manifest.attachments ?? {})) requireFile(base + relativeName(attachment.model));
  }
  for (const species of ['germanica', 'americana', 'brownbanded', 'hissing', 'orientalis']) {
    const base = `game/${species}/`, manifest = await json(base + 'manifest.json');
    if (manifest.speciesId !== species) throw Error('Changed species URL identity');
    for (const form of Object.values(manifest.forms)) for (const model of [form.model, form.lods.lod1]) requireFile(base + relativeName(model));
  }
  for (const group of ['s07-s08', 's07-s09', 's07-four-states']) {
    const base = `steam-v1/${group}/`, manifest = await json(base + 'manifest.json');
    uniqueNames(manifest.assets.map(a => a.model));
    for (const asset of manifest.assets) {
      requireFile(base + relativeName(asset.model), asset.sha256?.model);
      const individual = await json(base + relativeName(asset.manifest));
      if (individual.id !== asset.id || `${asset.slug}/${individual.model}` !== asset.model) throw Error(`Individual manifest mismatch: ${asset.id}`);
    }
  }
  const fourStates = await json('steam-v1/s07-four-states/manifest.json');
  for (const kind of ['cleaner', 'frog']) for (const state of ['normal', 'light-damaged', 'heavy-damaged', 'destroyed']) {
    const entry = fourStates.stateMapping?.[kind]?.[state];
    const suffix = state === 'normal' ? '' : `.${state}`;
    const folder = state === 'normal' ? `../s07-s08/${kind}-home` : state === 'destroyed' ? `../s07-s09/${kind}-home-destroyed` : `${kind}-home-${state}`;
    if (entry?.id !== `home.${kind}${suffix}` || entry.model !== `${folder}/model.glb` || entry.manifest !== `${folder}/manifest.json`) throw Error('Four-state mapping differs from reviewed identity');
    const model = path.posix.normalize(`steam-v1/s07-four-states/${entry.model}`);
    requireFile(model);
    const individual = await json(path.posix.normalize(`steam-v1/s07-four-states/${entry.manifest}`));
    if (individual.id !== entry.id) throw Error('Four-state mapping manifest identity mismatch');
  }
  const props = await json('game/props/manifest.json');
  requireFile('game/props/bin.glb');
  requireFile('game/props/bin-cat.glb');
  for (const cue of ['open', 'close', 'receive']) requireFile(`game/props/cat-bin-${cue}.wav`);
  for (const food of props.foods) for (const model of Object.values(food.states)) requireFile('game/props/' + relativeName(model));
  for (const sound of ['open', 'close', 'garbage', 'egg', 'roach']) requireFile(`game/props/${sound}.wav`);
  const index = 'game/germanica/crowd/adult/vat.json'; requireFile(index);
  const germanica = await json('game/germanica/manifest.json');
  requireFile('game/germanica/' + germanica.forms.adult.lods.lod2);
  if ('game/germanica/' + germanica.forms.adult.crowd.metadata !== index) throw Error('Unexpected runtime VAT index');
  for (const lod of (await json(index)).lods) {
    requireFile(relative(index, lod.sourceModel), lod.sourceModelHash);
    const vatPath = relative(index, lod.vat), vat = await json(vatPath);
    for (const binary of [vat.position, vat.normal]) requireFile(relative(vatPath, binary.file), binary.sha256);
    const meshPath = relative(index, lod.mesh); relative(meshPath, (await json(meshPath)).data);
  }
}
async function records(root, names) {
  const result = [];
  for (const name of [...new Set(names)].sort()) { const bytes = await readSafe(path.join(root, name)); result.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  return result;
}
function noticeBytes(policy, resources) {
  return Buffer.from('Desktop Creatures LOCAL CANDIDATE — not approved for release.\n' +
    'Asset art/rights signoff and complete final native dependency notices remain release gates.\n' +
    policy.notices.map(f => `\n===== ${f.source} | SHA-256 ${f.sha256} =====\n${resources.get(f.source).toString('utf8')}`).join('\n'));
}

async function compileFrontend(root, policy) {
  const modules = new Set();
  const plugin = {
    name: 'steam-candidate-boundary',
    transformIndexHtml: { order: 'pre', handler(html, context) {
      if (path.resolve(context.filename) === path.join(root, 'index.html')) html = html.replace('/src/main.ts', '/release/steam/entry.ts');
      // Unreviewed historical branding is not part of the runtime candidate.
      return html.replace(/<link\b[^>]*rel="icon"[^>]*>/g, '').replace(/<img\b[^>]*class="game-logo"[^>]*>/g, '');
    } },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (!generatedPath(item.fileName)) throw Error(`Unexpected emitted file: ${item.fileName}`);
        if (item.type === 'chunk') for (const id of Object.keys(item.modules)) {
          if (id.startsWith('\0')) { if (!/^\0(?:vite\/|rolldown\/)/.test(id)) throw Error(`Unknown virtual module: ${id}`); continue; }
          const name = path.relative(root, id.split('?')[0]).replaceAll('\\', '/');
          relativeName(name);
          if (name.startsWith('src/companion/') || (!policy.inputs.includes(name) && !policy.dependencyModules.includes(name))) throw Error(`Unreviewed source module: ${name}`);
          modules.add(name);
        }
      }
    },
  };
  const built = await build(candidateConfig(root, plugin));
  if (Array.isArray(built) || !built.output) throw Error('Unexpected Vite result');
  return { built, modules };
}

export async function buildCandidate(output, root = projectRoot) {
  const { policy, policySha256 } = await loadPolicy(root);
  const resources = await checkedResources(root, policy);
  await validateRuntimePaths(root, policy);
  const inputNames = [...policy.inputs, ...policy.dependencyModules, ...tools];
  const initialInputs = await records(root, inputNames);
  output = path.resolve(output);
  relativeName(path.basename(output));
  await safePath(path.dirname(output), 'directory');
  // Exclusive creation also refuses pre-existing empty directories and output symlinks.
  await mkdir(output);
  const { built, modules } = await compileFrontend(root, policy);
  const frontend = path.join(output, 'frontend');
  await mkdir(frontend);
  uniqueNames([...built.output.map(f => f.fileName), ...policy.files.map(f => f.path), 'THIRD-PARTY-NOTICES.txt']);
  for (const file of built.output) {
    const bytes = file.type === 'chunk' ? Buffer.from(file.code) : Buffer.from(file.source);
    if (deniedCode.test(bytes.toString('utf8'))) throw Error(`Forbidden code reference: ${file.fileName}`);
    await writeNew(frontend, file.fileName, bytes);
  }
  for (const file of policy.files) await writeNew(frontend, file.path, resources.get(file.source));
  const notices = noticeBytes(policy, resources);
  await writeNew(frontend, 'THIRD-PARTY-NOTICES.txt', notices);
  // Inputs/resources changed concurrently => leave an incomplete directory, never a manifest.
  if (JSON.stringify(initialInputs) !== JSON.stringify(await records(root, inputNames))) throw Error('Source changed during candidate build');
  await checkedResources(root, policy);
  const manifest = { schemaVersion: 1, kind: 'steam-local-frontend-candidate', releaseReady: false,
    steamSdkConnected: false, nativeExecutableBound: false, policySha256,
    toolchain: { node: process.version, platform: process.platform, arch: process.arch },
    inputs: await records(root, [...inputNames, ...modules]),
    resources: policy.files, notices: policy.notices,
    generated: built.output.map(f => f.fileName).sort(), files: await inventory(frontend) };
  await writeNew(output, 'candidate-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  await verifyCandidate(output, root);
  return manifest;
}

export async function verifyCandidate(output, root = projectRoot) {
  await safePath(output, 'directory');
  const { policy, policySha256 } = await loadPolicy(root);
  await validateRuntimePaths(root, policy);
  const manifest = JSON.parse(await readSafe(path.join(output, 'candidate-manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'steam-local-frontend-candidate' || manifest.releaseReady !== false || manifest.steamSdkConnected !== false || manifest.nativeExecutableBound !== false || manifest.policySha256 !== policySha256) throw Error('Invalid candidate manifest/policy');
  const sourceNames = manifest.inputs?.map(f => f.path) ?? [];
  uniqueNames(sourceNames);
  for (const name of [...policy.inputs, ...policy.dependencyModules, ...tools]) if (!sourceNames.includes(name)) throw Error(`Missing source provenance: ${name}`);
  for (const name of sourceNames) if (![...policy.inputs, ...policy.dependencyModules, ...tools].includes(name)) throw Error(`Unknown source provenance: ${name}`);
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(await records(root, sourceNames))) throw Error('Source provenance hash mismatch');
  if (JSON.stringify(manifest.resources) !== JSON.stringify(policy.files) || JSON.stringify(manifest.notices) !== JSON.stringify(policy.notices)) throw Error('Candidate inventory differs from policy');
  if (!Array.isArray(manifest.generated) || !manifest.generated.length || manifest.generated.some(f => !generatedPath(f) || forbidden.test(f))) throw Error('Invalid generated file list');
  for (const page of ['index.html', 'trash.html', 'shortcuts.html']) if (!manifest.generated.includes(page)) throw Error(`Missing page: ${page}`);
  const names = [...manifest.generated, ...policy.files.map(f => f.path), 'THIRD-PARTY-NOTICES.txt'];
  uniqueNames(names);
  const actual = await inventory(path.join(output, 'frontend'));
  if (JSON.stringify(actual.map(f => f.path).sort()) !== JSON.stringify(names.sort())) throw Error('Unknown/extra/missing frontend files');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw Error('Candidate hash mismatch');
  for (const file of policy.files) if (actual.find(f => f.path === file.path)?.sha256 !== file.sha256) throw Error(`Pinned resource hash mismatch: ${file.path}`);
  const resources = await checkedResources(root, policy);
  if (actual.find(f => f.path === 'THIRD-PARTY-NOTICES.txt')?.sha256 !== sha256(noticeBytes(policy, resources))) throw Error('Notices differ from reviewed sources');
  // A colocated editable manifest is not an authority for generated JS/HTML/CSS.
  // Recompile from the reviewed module graph and compare exact names and bytes.
  const { built, modules } = await compileFrontend(root, policy);
  if (JSON.stringify(manifest.generated) !== JSON.stringify(built.output.map(f => f.fileName).sort())) throw Error('Generated files differ from rebuilt frontend');
  for (const file of built.output) {
    const bytes = file.type === 'chunk' ? Buffer.from(file.code) : Buffer.from(file.source);
    if (actual.find(f => f.path === file.fileName)?.sha256 !== sha256(bytes)) throw Error(`Generated bytes differ from rebuilt frontend: ${file.fileName}`);
  }
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(await records(root, [...policy.inputs, ...policy.dependencyModules, ...tools, ...modules]))) throw Error('Module provenance differs from rebuilt frontend');
  for (const name of manifest.generated) if (deniedCode.test((await readSafe(path.join(output, 'frontend', name))).toString('utf8'))) throw Error(`Forbidden code reference: ${name}`);
  const whole = await inventory(output);
  if (whole.length !== actual.length + 1 || whole.some(f => f.path !== 'candidate-manifest.json' && !f.path.startsWith('frontend/'))) throw Error('Extra candidate root content');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || !['--output', '--verify'].includes(process.argv[2])) throw Error('Usage: node release/steam/build-candidate.mjs --output NEW_DIR | --verify CANDIDATE_DIR');
    const manifest = await (process.argv[2] === '--output' ? buildCandidate(process.argv[3]) : verifyCandidate(process.argv[3]));
    console.log(JSON.stringify({ candidate: path.resolve(process.argv[3]), files: manifest.files.length, releaseReady: false, nativeExecutableBound: false }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
