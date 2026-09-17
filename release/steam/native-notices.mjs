// This module verifies local, reviewed inputs. Hashes are neither signatures nor
// proof against a hostile process changing inputs between this check and rustc.
import { open, lstat, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { sha256, safePath, writeNew } from './candidate-safety.mjs';

export const NATIVE_TARGET = 'x86_64-pc-windows-msvc';
export const nativeThirdPartyPolicyPath = fileURLToPath(new URL('./native-third-party-policy.json', import.meta.url));
const registrySource = 'registry+https://github.com/rust-lang/crates.io-index';
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sort = xs => [...xs].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => sha256(jsonBytes(value));
const hashPattern = /^[a-f0-9]{64}$/;
const packageKey = pkg => `${pkg.name}@${pkg.version}`;
const knownLicenses = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-3-Clause', '0BSD', 'MPL-2.0', 'Unicode-3.0', 'Unlicense', 'Zlib', 'CC0-1.0']);
const legacyExpressions = new Map([
  ['MIT/Apache-2.0', 'MIT OR Apache-2.0'], ['Apache-2.0 / MIT', 'Apache-2.0 OR MIT'],
  ['Unlicense/MIT', 'Unlicense OR MIT'], ['BSD-3-Clause/MIT', 'BSD-3-Clause OR MIT'],
]);

function relative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[\x00-\x1f\x7f:<>"|?*]/.test(name)) throw Error(`Unsafe native dependency path: ${name}`);
  for (const part of name.split('/')) if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw Error(`Unsafe native dependency path: ${name}`);
  return name;
}
function unique(names) {
  const seen = new Set();
  for (const name of names) { relative(name); const key = name.toLowerCase(); if (seen.has(key)) throw Error(`Dependency path case collision: ${name}`); seen.add(key); }
}
function textBytes(bytes, label) {
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Error(`Invalid UTF-8 notice: ${label}`); }
  if (!text.trim() || text.includes('\0')) throw Error(`Empty or invalid notice: ${label}`);
  return text;
}
async function readUnique(file, checkAncestors = true) {
  if (checkAncestors) await safePath(file);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error(`Non-unique dependency file: ${file}`);
  const handle = await open(file, 'r');
  try {
    const start = await handle.stat();
    if (!start.isFile() || start.nlink !== 1 || start.ino !== before.ino || start.dev !== before.dev) throw Error(`Dependency changed before open: ${file}`);
    const bytes = await handle.readFile();
    const end = await handle.stat();
    const after = await lstat(file);
    if (end.ino !== start.ino || end.dev !== start.dev || end.size !== bytes.length || start.size !== end.size || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || after.ino !== end.ino || after.dev !== end.dev || after.nlink !== 1 || after.isSymbolicLink() || after.size !== end.size || after.mtimeMs !== end.mtimeMs) throw Error(`Dependency changed during read: ${file}`);
    return bytes;
  } finally { await handle.close(); }
}

export function parseLicenseExpression(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw Error('Missing license expression');
  const normalized = legacyExpressions.get(expression) ?? expression;
  const tokens = normalized.match(/[A-Za-z0-9.+-]+|\(|\)|\S/g) ?? [];
  let at = 0;
  function atom() {
    const token = tokens[at++];
    if (token === '(') { const node = or(); if (tokens[at++] !== ')') throw Error(`Unbalanced license expression: ${expression}`); return node; }
    if (!knownLicenses.has(token)) throw Error(`Unknown license or expression operator: ${token}`);
    return { license: token };
  }
  function and() { let node = atom(); while (tokens[at] === 'AND') { at++; node = { and: [node, atom()] }; } return node; }
  function or() { let node = and(); while (tokens[at] === 'OR') { at++; node = { or: [node, and()] }; } return node; }
  const tree = or(); if (at !== tokens.length) throw Error(`Invalid license expression: ${expression}`);
  return { declared: expression, normalized, tree };
}
export function chooseLicenseBranch(tree, available) {
  const choices = node => {
    if (node.license) return available.has(node.license) ? [[node.license]] : [];
    if (node.or) return node.or.flatMap(choices);
    return node.and.reduce((left, right) => left.flatMap(a => choices(right).map(b => sort(new Set([...a, ...b])))), [[]]);
  };
  const preference = ['MIT', '0BSD', 'BSD-3-Clause', 'Zlib', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'MIT-0', 'Unicode-3.0', 'MPL-2.0'];
  const options = choices(tree);
  if (!options.length) throw Error('Missing complete license text for a required AND/OR branch');
  options.sort((a, b) => a.length - b.length || a.reduce((s, x) => s + preference.indexOf(x), 0) - b.reduce((s, x) => s + preference.indexOf(x), 0) || a.join().localeCompare(b.join(), 'en'));
  return options[0];
}
// Recognition is used only on bytes tied to an authenticated-by-lockfile crate
// archive or an explicit reviewed supplement. It is not legal approval.
export function recognizeLicenseTexts(text) {
  const t = text.replace(/\s+/g, ' '), found = new Set();
  const has = (...rx) => rx.every(r => r.test(t));
  if (t.length > 600 && has(/Permission is hereby granted, free of charge/i, /THE SOFTWARE IS PROVIDED ["“]?AS IS/i, /copyright notice and this permission notice (?:shall be included|appear)/i)) found.add('MIT');
  if (t.length > 9500 && has(/Apache License/i, /Version 2\.0/, /END OF TERMS AND CONDITIONS/)) found.add('Apache-2.0');
  if (t.length > 1000 && has(/Redistribution and use in source and binary forms/i, /endorse or promote/i, /THIS SOFTWARE IS PROVIDED/i, /disclaimer/i)) found.add('BSD-3-Clause');
  if (t.length > 550 && has(/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i, /THE SOFTWARE IS PROVIDED/i)) found.add('0BSD');
  if (t.length > 15000 && has(/Mozilla Public License (?:Version |version )?2\.0/i, /Exhibit A/, /Exhibit B/, /Distribution of Executable Form/)) found.add('MPL-2.0');
  if (t.length > 1500 && has(/UNICODE LICENSE V3/, /COPYRIGHT AND PERMISSION NOTICE/, /THE DATA FILES AND SOFTWARE ARE PROVIDED/i)) found.add('Unicode-3.0');
  if (t.length > 700 && has(/origin of this software must not be misrepresented/i, /[Aa]ltered source versions/, /notice may not be removed or altered/i)) found.add('Zlib');
  if (t.length > 900 && has(/free and unencumbered software released into the public domain/i, /THE SOFTWARE IS PROVIDED/i)) found.add('Unlicense');
  if (t.length > 6000 && has(/CC0 1\.0 Universal/, /Waiver/, /Public License Fallback/)) found.add('CC0-1.0');
  if (t.length > 500 && has(/MIT No Attribution/, /Permission is hereby granted, free of charge/i, /THE SOFTWARE IS PROVIDED/i)) found.add('MIT-0');
  return found;
}

// Evaluate target predicates independently instead of trusting a caller-supplied
// closure. Host and target are both the fixed Windows MSVC x64 triple.
export function matchesNativeTarget(value) {
  if (value == null) return true;
  if (!value.startsWith('cfg(')) return value === NATIVE_TARGET;
  const tokens = value.match(/"[^"\\]*"|[A-Za-z0-9_]+|[(),=]|\S/g) ?? [];
  const cfg = {
    target_arch: ['x86_64'], target_os: ['windows'], target_env: ['msvc'], target_family: ['windows'],
    target_vendor: ['pc'], target_endian: ['little'], target_pointer_width: ['64'], target_abi: [''],
    target_has_atomic: ['8', '16', '32', '64', 'ptr'], target_feature: ['fxsr', 'sse', 'sse2'],
  };
  let at = 0;
  function expect(t) { if (tokens[at++] !== t) throw Error(`Unsupported target predicate: ${value}`); }
  function expr() {
    const name = tokens[at++];
    if (['all', 'any', 'not', 'cfg'].includes(name)) {
      expect('('); const values = [];
      while (tokens[at] !== ')') { values.push(expr()); if (tokens[at] !== ')') expect(','); }
      expect(')');
      if ((name === 'not' || name === 'cfg') && values.length !== 1) throw Error(`Invalid target predicate: ${value}`);
      return name === 'all' ? values.every(Boolean) : name === 'any' ? values.some(Boolean) : name === 'not' ? !values[0] : values[0];
    }
    if (tokens[at] === '=') { at++; const val = tokens[at++]; if (!/^".*"$/.test(val) || !Object.hasOwn(cfg, name)) throw Error(`Unknown target cfg: ${name}`); return cfg[name].includes(val.slice(1, -1)); }
    if (name === 'windows') return true;
    if (name === 'unix') return false;
    // RUSTFLAGS/encoded flags are refused by the builder. This reviewed Tokio
    // opt-in cfg is absent in the fixed release build, including in any(...).
    if (name === 'tokio_unstable' || name === 'windows_raw_dylib') return false;
    throw Error(`Unknown target cfg: ${name}`);
  }
  const result = expr(); if (at !== tokens.length) throw Error(`Invalid target predicate: ${value}`); return result;
}

export function deriveNativeClosure(metadata, { target = NATIVE_TARGET, rootPackageId = metadata?.resolve?.root } = {}) {
  if (target !== NATIVE_TARGET || metadata?.version !== 1 || !Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes) || !rootPackageId) throw Error('Full format-1 fixed Windows target Cargo metadata is required');
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
  if (packages.size !== metadata.packages.length || nodes.size !== metadata.resolve.nodes.length || !packages.has(rootPackageId) || !nodes.has(rootPackageId)) throw Error('Duplicate or missing Cargo package/node');
  if (!same(metadata.workspace_members, [rootPackageId]) || packages.get(rootPackageId).source !== null) throw Error('Only the reviewed single local root package is supported');
  const states = new Map(), edgeMap = new Map();
  const queue = [[rootPackageId, 'runtime']];
  while (queue.length) {
    const [id, role] = queue.shift(), p = packages.get(id), node = nodes.get(id);
    if (!p || !node || !Array.isArray(node.deps) || !Array.isArray(node.features)) throw Error(`Incomplete resolved Cargo node: ${id}`);
    if (id !== rootPackageId && p.source !== registrySource) throw Error(`Non-root dependency is not a locked crates.io package: ${id}`);
    const roles = states.get(id) ?? new Set(); if (roles.has(role)) continue; roles.add(role); states.set(id, roles);
    for (const dep of node.deps) {
      if (!Array.isArray(dep.dep_kinds) || !dep.dep_kinds.length || !packages.has(dep.pkg)) throw Error('Missing dependency kinds or package');
      for (const kind of dep.dep_kinds) {
        if (![null, 'build', 'dev'].includes(kind.kind)) throw Error(`Unknown Cargo dependency kind: ${kind.kind}`);
        if (kind.kind === 'dev' || !matchesNativeTarget(kind.target)) continue;
        const child = packages.get(dep.pkg), procMacro = child.targets?.some(t => t.kind?.includes('proc-macro'));
        const nextRole = procMacro ? 'proc-macro' : kind.kind === 'build' ? 'build' : role;
        const edge = { from: packageKey(p), to: packageKey(child), name: dep.name, kind: kind.kind ?? 'runtime', target: kind.target ?? null };
        edgeMap.set(JSON.stringify(edge), edge); queue.push([dep.pkg, nextRole]);
      }
    }
  }
  const closure = [...states].map(([id, roles]) => {
    const p = packages.get(id), n = nodes.get(id);
    return { package: packageKey(p), name: p.name, version: p.version, source: p.source, roles: sort(roles), features: sort(new Set(n.features)), hasBuildScript: !!p.targets?.some(t => t.kind?.includes('custom-build')), procMacro: !!p.targets?.some(t => t.kind?.includes('proc-macro')) };
  }).sort((a, b) => a.package.localeCompare(b.package, 'en'));
  if (new Set(closure.map(p => p.package)).size !== closure.length) throw Error('Ambiguous package identity');
  return { rootPackageId, root: packageKey(packages.get(rootPackageId)), closure, edges: [...edgeMap.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')), packages: [...states.keys()].map(id => packages.get(id)) };
}

export function parseCargoLock(bytes) {
  const text = textBytes(bytes, 'Cargo.lock');
  if (!/^version = (3|4)$/m.test(text)) throw Error('Unsupported Cargo.lock format');
  const records = new Map();
  for (const section of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const values = {};
    for (const key of ['name', 'version', 'source', 'checksum']) {
      const matches = [...section.matchAll(new RegExp(`^${key} = "([^"\\\\\\r\\n]*)"$`, 'gm'))];
      if (matches.length > 1) throw Error(`Duplicate Cargo.lock ${key}`);
      if (matches.length) values[key] = matches[0][1];
    }
    if (!values.name || !values.version) throw Error('Incomplete Cargo.lock package');
    const key = `${values.name}@${values.version}`;
    if (records.has(key)) throw Error(`Ambiguous Cargo.lock package: ${key}`);
    if (values.source && (values.source !== registrySource || !hashPattern.test(values.checksum))) throw Error(`Unsupported or unchecked Cargo source: ${key}`);
    records.set(key, values);
  }
  if (!records.size) throw Error('Empty Cargo.lock graph'); return records;
}

function tarNumber(field) { const s = field.toString('ascii').replace(/\0.*$/, '').trim(); if (!/^[0-7]+$/.test(s)) throw Error('Invalid crate tar number'); const n = parseInt(s, 8); if (!Number.isSafeInteger(n)) throw Error('Oversized crate tar number'); return n; }
export function readCrateArchive(bytes, cratePrefix) {
  relative(cratePrefix);
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map(), dirs = new Set(); let offset = 0, pendingName = null, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) { if (tar.subarray(offset).some(b => b !== 0)) throw Error('Data after crate tar end marker'); ended = true; break; }
    const checksum = tarNumber(header.subarray(148, 156));
    if (header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0) !== checksum) throw Error('Crate tar header checksum mismatch');
    const size = tarNumber(header.subarray(124, 136));
    if (offset + size > tar.length) throw Error('Truncated crate tar entry');
    const body = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'L') { if (pendingName) throw Error('Repeated crate tar long name'); pendingName = body.toString('utf8').replace(/\0$/, ''); continue; }
    if (!['0', '5'].includes(type)) throw Error(`Crate tar link or unsupported entry refused: ${type}`);
    const field = b => b.toString('utf8').replace(/\0.*$/, '');
    const prefix = header.toString('ascii', 257, 263) === 'ustar\0' ? field(header.subarray(345, 500)) : '';
    const raw = pendingName ?? [prefix, field(header.subarray(0, 100))].filter(Boolean).join('/'); pendingName = null;
    const name = type === '5' ? raw.replace(/\/$/, '') : raw; relative(name);
    if (name === cratePrefix && type === '5') continue;
    if (!name.startsWith(cratePrefix + '/')) throw Error('Crate tar root does not match locked package');
    const inner = relative(name.slice(cratePrefix.length + 1));
    if (['.cargo-ok', '.cargo-checksum.json'].includes(inner)) throw Error('Crate archive contains a reserved Cargo extraction control file');
    if (files.has(inner) || dirs.has(inner)) throw Error(`Duplicate crate tar path: ${inner}`);
    if (type === '5') { if (size) throw Error('Nonempty crate tar directory'); dirs.add(inner); } else files.set(inner, Buffer.from(body));
  }
  if (!ended || pendingName || !files.has('Cargo.toml')) throw Error('Incomplete crate archive');
  unique([...files.keys(), ...dirs]);
  for (const name of files.keys()) for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) { if (files.has(dir)) throw Error('Crate file/directory collision'); dirs.add(dir); }
  return { files, dirs };
}

function manifestScalar(bytes, key) {
  const packageSection = textBytes(bytes, 'crate Cargo.toml').split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  if (!packageSection) throw Error('Missing registry Cargo.toml package section');
  const values = [...packageSection.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"\\\\\\r\\n]*)"\\s*$`, 'gm'))];
  if (values.length > 1) throw Error(`Ambiguous registry manifest ${key}`); return values[0]?.[1] ?? null;
}
async function checkSourceTree(root, archive, checksum) {
  await safePath(root, 'directory'); const seen = new Set(), files = [];
  async function visit(dir = '') {
    const absolute = path.join(root, dir); await safePath(absolute, 'directory');
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const name = relative(dir ? dir + '/' + entry.name : entry.name), file = path.join(root, name);
      if (entry.isDirectory()) { if (!archive.dirs.has(name)) throw Error(`Unlisted crate directory: ${name}`); await visit(name); continue; }
      const bytes = await readUnique(file, false); seen.add(name);
      if (name === '.cargo-ok') { if (bytes.toString() !== '{"v":1}') throw Error('Unexpected Cargo extraction marker'); continue; }
      if (name === '.cargo-checksum.json') {
        const data = JSON.parse(bytes); const expected = Object.fromEntries([...archive.files].map(([n, b]) => [n, sha256(b)]));
        if (data.package !== checksum || !same(sort(Object.keys(data.files ?? {})), sort(Object.keys(expected))) || Object.keys(expected).some(n => data.files[n] !== expected[n])) throw Error('Cargo source checksum metadata mismatch');
        continue;
      }
      const expected = archive.files.get(name);
      if (!expected || bytes.length !== expected.length || sha256(bytes) !== sha256(expected)) throw Error(`Modified or extra crate file: ${name}`);
      files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit();
  for (const name of archive.files.keys()) if (!seen.has(name)) throw Error(`Missing crate source file: ${name}`);
  unique(files.map(f => f.path)); return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function verifyRegistryPackage(pkg, { cargoHome, lockPackages }) {
  const key = packageKey(pkg), locked = lockPackages.get(key);
  if (pkg.source !== registrySource || locked?.source !== pkg.source || !hashPattern.test(locked.checksum)) throw Error(`Unreviewed registry or unlocked package: ${key}`);
  relative(pkg.name); relative(pkg.version);
  const crateName = `${pkg.name}-${pkg.version}`;
  const manifestPath = path.resolve(pkg.manifest_path), rel = path.relative(path.resolve(cargoHome), manifestPath).replaceAll('\\', '/');
  const match = /^registry\/src\/(index\.crates\.io-[a-f0-9]+)\/([^/]+)\/Cargo\.toml$/.exec(rel);
  if (!match || match[2] !== crateName) throw Error(`Crate source outside exact Cargo home registry path: ${key}`);
  const archivePath = path.join(cargoHome, 'registry/cache', match[1], crateName + '.crate');
  const archiveBytes = await readUnique(archivePath);
  if (sha256(archiveBytes) !== locked.checksum) throw Error(`Registry archive checksum mismatch: ${key}`);
  const archive = readCrateArchive(archiveBytes, crateName);
  const manifest = archive.files.get('Cargo.toml');
  if (manifestScalar(manifest, 'name') !== pkg.name || manifestScalar(manifest, 'version') !== pkg.version || manifestScalar(manifest, 'license') !== pkg.license || manifestScalar(manifest, 'license-file') !== (pkg.license_file ?? null)) throw Error(`Cargo metadata differs from locked manifest: ${key}`);
  const files = await checkSourceTree(path.dirname(manifestPath), archive, locked.checksum);
  if (sha256(await readUnique(archivePath)) !== locked.checksum) throw Error(`Registry archive changed during verification: ${key}`);
  return { package: key, archiveBytes, archiveFiles: archive.files, files, crateSha256: locked.checksum, crateBytes: archiveBytes.length, sourceTreeSha256: digest(files), sourceUrl: `https://static.crates.io/crates/${pkg.name}/${crateName}.crate` };
}

async function loadPolicy(policyPath) {
  const bytes = await readUnique(policyPath), policy = JSON.parse(bytes);
  if (policy.kind !== 'desktop-creatures-native-third-party-policy' || policy.schemaVersion !== 1 || policy.target !== NATIVE_TARGET || policy.releaseReady !== false || !Array.isArray(policy.supplements) || !Array.isArray(policy.nativeLibraries) || !policy.rustToolchain) throw Error('Invalid native third-party policy');
  return { policy, policySha256: sha256(bytes), policyRoot: path.dirname(path.resolve(policyPath)) };
}
async function policyText(root, record) {
  relative(record.path);
  const bytes = await readUnique(path.join(root, record.path));
  if (!hashPattern.test(record.sha256) || sha256(bytes) !== record.sha256 || bytes.length !== record.bytes) throw Error(`Reviewed notice text changed: ${record.path}`);
  textBytes(bytes, record.path); return bytes;
}
async function rustInputs(rustToolchainRoot, policy) {
  if (!rustToolchainRoot) throw Error('Pinned Rust toolchain root is required for std/compiler runtime notices');
  await safePath(rustToolchainRoot, 'directory');
  if (!Array.isArray(policy.files) || !policy.files.length || !Array.isArray(policy.licenseFiles) || !policy.licenseFiles.length) throw Error('Missing pinned Rust toolchain inventory');
  const files = [], artifacts = [];
  unique(policy.files.map(f => f.path));
  for (const item of policy.files) {
    relative(item.path); const bytes = await readUnique(path.join(rustToolchainRoot, item.path));
    if (sha256(bytes) !== item.sha256 || bytes.length !== item.bytes) throw Error(`Pinned Rust toolchain file changed: ${item.path}`);
    files.push({ path: item.path, bytes: bytes.length, sha256: sha256(bytes) });
    if (policy.licenseFiles.includes(item.path)) { textBytes(bytes, item.path); artifacts.push({ path: 'rust/' + path.posix.basename(item.path), bytes, sha256: sha256(bytes) }); }
  }
  const libDirectory = `lib/rustlib/${NATIVE_TARGET}/lib`;
  const actual = sort((await readdir(path.join(rustToolchainRoot, libDirectory))).map(name => `${libDirectory}/${name}`));
  if (!same(actual, sort(policy.files.filter(f => f.path.startsWith(libDirectory + '/')).map(f => f.path)))) throw Error('Unexpected Rust target library inventory');
  if (policy.licenseFiles.some(name => !files.some(f => f.path === name))) throw Error('Rust notice missing from pinned files');
  return { record: { channel: policy.channel, target: NATIVE_TARGET, files, filesSha256: digest(files), licenseFiles: policy.licenseFiles, provenance: policy.provenance, scope: 'Complete installed target library inventory; not a claim that every item is linked. Library copyright and compiler-runtime license material are supplied separately from registry crates.' }, artifacts };
}

export async function generateNativeNotices({ metadata, cargoLockPath, cargoHome, outputDir, rootPackageId, rustToolchainRoot, target = NATIVE_TARGET, policyPath = nativeThirdPartyPolicyPath }) {
  if (target !== NATIVE_TARGET || !cargoLockPath || !cargoHome) throw Error('Fixed target, Cargo.lock and Cargo home are required');
  if (outputDir) { await safePath(outputDir, 'directory', true); try { await lstat(outputDir); throw Error('Native notices output directory must not exist'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const loaded = await loadPolicy(policyPath), { policy, policyRoot, policySha256 } = loaded;
  const lockBytes = await readUnique(cargoLockPath), lockPackages = parseCargoLock(lockBytes);
  const graph = deriveNativeClosure(metadata, { target, rootPackageId });
  if (!lockPackages.has(graph.root) || lockPackages.get(graph.root).source) throw Error('Local root does not match Cargo.lock');
  const artifacts = [], packages = [], nativeLibraries = [], sections = [];
  for (const pkg of graph.packages.filter(p => p.source !== null).sort((a, b) => packageKey(a).localeCompare(packageKey(b), 'en'))) {
    const checked = await verifyRegistryPackage(pkg, { cargoHome, lockPackages });
    const expression = parseLicenseExpression(pkg.license), noticeTexts = [], available = new Set();
    for (const [name, bytes] of checked.archiveFiles) {
      if (!/^(?:licen[cs]e|copying|notice|copyright|authors)(?:$|[._-])/i.test(path.posix.basename(name)) && name !== pkg.license_file) continue;
      const text = textBytes(bytes, checked.package + '/' + name);
      for (const id of recognizeLicenseTexts(text)) available.add(id);
      noticeTexts.push({ source: `crate:${name}`, sha256: sha256(bytes), bytes: bytes.length, content: bytes });
    }
    for (const supplement of policy.supplements.filter(s => s.package === checked.package)) {
      const vcs = JSON.parse(checked.archiveFiles.get('.cargo_vcs_info.json') ?? '{}');
      if (supplement.crateSha256 !== checked.crateSha256 || supplement.declaredLicense !== pkg.license || supplement.vcsCommit !== vcs.git?.sha1) throw Error(`Supplement does not match locked crate: ${checked.package}`);
      const bytes = await policyText(policyRoot, supplement);
      if (supplement.license && !recognizeLicenseTexts(textBytes(bytes, supplement.path)).has(supplement.license)) throw Error(`Unrecognized reviewed license supplement: ${supplement.path}`);
      if (supplement.license) available.add(supplement.license);
      noticeTexts.push({ source: supplement.sourceUrl, sourceKind: supplement.sourceKind, sha256: sha256(bytes), bytes: bytes.length, content: bytes });
    }
    let selectedLicenses;
    try { selectedLicenses = chooseLicenseBranch(expression.tree, available); } catch (error) { throw Error(`${checked.package}: ${error.message} (${pkg.license}; recognized: ${[...available].join(', ')})`); }
    if (!noticeTexts.length) throw Error(`No license texts: ${checked.package}`);
    let sourceAvailability = null;
    if (selectedLicenses.includes('MPL-2.0')) {
      const sourcePath = `sources/${pkg.name}-${pkg.version}.crate`;
      artifacts.push({ path: sourcePath, bytes: checked.archiveBytes, sha256: checked.crateSha256 });
      sourceAvailability = { path: sourcePath, contentPath: 'native-notices/' + sourcePath, sourceUrl: checked.sourceUrl, sha256: checked.crateSha256, unmodified: true, license: 'MPL-2.0' };
    }
    for (const file of checked.files.filter(f => {
      const bytes = checked.archiveFiles.get(f.path);
      return /\.(?:lib|dll|a|o|obj|so|dylib|rlib|exe|node|wasm)$/i.test(f.path) || bytes.subarray(0, 2).toString('ascii') === 'MZ' || bytes.subarray(0, 8).toString('ascii') === '!<arch>\n' || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    })) {
      const allowed = policy.nativeLibraries.find(p => p.package === checked.package && p.path === file.path);
      if (!allowed || allowed.sha256 !== file.sha256 || allowed.bytes !== file.bytes || allowed.crateSha256 !== checked.crateSha256) throw Error(`Unknown or modified native library: ${checked.package}/${file.path}`);
      nativeLibraries.push({ ...allowed });
    }
    const record = { package: checked.package, declaredLicense: pkg.license, normalizedLicense: expression.normalized, selectedLicenses, crateSha256: checked.crateSha256, crateBytes: checked.crateBytes, sourceUrl: checked.sourceUrl, sourceTreeSha256: checked.sourceTreeSha256, sourceFiles: checked.files, noticeTexts: noticeTexts.map(({ content, ...r }) => r), sourceAvailability };
    packages.push(record);
    sections.push(`\n===== ${checked.package} | ${pkg.license} | selected: ${selectedLicenses.join(' AND ')} =====\nCrate SHA-256: ${checked.crateSha256}\n${sourceAvailability ? `Unmodified MPL-2.0 Source Code Form: ${sourceAvailability.contentPath} (relative to the EXE); ${sourceAvailability.path} relative to this notice file. Recipients retain the MPL-2.0 rights in these sources.\n` : ''}`);
    for (const notice of noticeTexts) sections.push(`\n--- ${notice.source} | SHA-256 ${notice.sha256} ---\n${textBytes(notice.content, notice.source)}\n`);
  }
  // A package declaration of MIT does not license its embedded Microsoft SDK.
  const webviewPresent = graph.closure.some(p => p.package === policy.webview2?.crate);
  let webview2 = null;
  if (webviewPresent) {
    const sdk = policy.webview2;
    if (sdk.packageId !== 'Microsoft.Web.WebView2' || sdk.version !== '1.0.3650.58' || !sdk.sourceUrl?.startsWith('https://api.nuget.org/') || !hashPattern.test(sdk.packageSha256)) throw Error('Unreviewed WebView2 SDK provenance');
    for (const file of sdk.files) {
      if (file.cratePath) {
        const lib = nativeLibraries.find(l => l.package === sdk.crate && l.path === file.cratePath);
        if (!lib || lib.sha256 !== file.sha256 || lib.bytes !== file.bytes) throw Error('Official NuGet and crate loader library mismatch');
      } else { const bytes = await policyText(policyRoot, file); if (/\-(?:LICENSE|NOTICE)\.txt$/.test(file.path)) sections.push(`\n===== ${sdk.packageId} ${sdk.version} / ${file.packagePath} | SHA-256 ${file.sha256} =====\n${textBytes(bytes, file.path)}\n`); }
    }
    if (!sdk.files.some(f => f.packagePath === 'LICENSE.txt') || !sdk.files.some(f => f.packagePath === 'NOTICE.txt') || !sdk.files.some(f => f.cratePath === 'x64/WebView2LoaderStatic.lib')) throw Error('Incomplete official WebView2 license/notices/loader evidence');
    webview2 = sdk;
  }
  const rust = await rustInputs(rustToolchainRoot, policy.rustToolchain); artifacts.push(...rust.artifacts);
  const rightsLimits = [
    'Local dependency inventory and notice/source delivery only; releaseReady=false. Compilation is not legal approval or proof that all release rights are complete.',
    'Cargo metadata was requested for the fixed Windows target and release features by the controlled builder. The non-dev dependency closure includes runtime, build dependencies and proc macros; Cargo resolver feature unification can conservatively include a superset of compiled units.',
    'Only crates.io archives matching the reviewed Cargo.lock and unmodified extracted trees are accepted. Hashes establish local byte equality, not a publisher signature, code signing, trust in the editable policy, or protection from a hostile same-user I/O race.',
    'Rust standard library and compiler runtime are outside Cargo.lock. Pinned installed target files and the Rust distribution copyright/license material are recorded; registry notices do not replace them. rust/COPYRIGHT-library.html contains library component attribution; rust/COPYRIGHT.html conservatively retains compiler/build-tool attribution too.',
    'MSVC runtime and Windows SDK/import libraries are separate Microsoft toolchain inputs. Their version/hash inventory, installed license terms, redistribution eligibility and any VC redistributable delivery remain distinct builder/release evidence; this file does not grant Microsoft redistribution rights.',
    'Windows system DLL imports identify OS dependencies and are not bundled components. The Evergreen WebView2 Runtime is an external prerequisite, not the bundled loader or an included fixed runtime. Missing-runtime/clean-machine testing and prerequisite delivery remain release gates.',
    'The Microsoft WebView2 SDK loader is a native component separate from the MIT Rust bindings. Its exact NuGet LICENSE.txt and NOTICE.txt are preserved; no unrelated SDK or Runtime license version is substituted.',
    'MPL source archives are unmodified and supplied with the content. Future modifications, a different dependency graph, added native outputs, or omitted source/notice artifacts invalidate this inventory and require fresh review.',
  ];
  const noticesBytes = Buffer.from('Desktop Creatures — local native dependency notices\nNot approved for Steam release.\n\n' + rightsLimits.join('\n\n') + '\n\nRust distribution material accompanies this file under rust/. Paths in this file are relative to native-notices/ unless explicitly stated relative to the EXE.\n' + sections.join(''));
  artifacts.push({ path: 'NATIVE-THIRD-PARTY-NOTICES.txt', bytes: noticesBytes, sha256: sha256(noticesBytes) });
  const manifest = {
    kind: 'desktop-creatures-native-notices', schemaVersion: 1, target, releaseReady: false, rightsComplete: false,
    policySha256, cargoLockSha256: sha256(lockBytes), root: graph.root,
    closure: graph.closure, edges: graph.edges, cargoGraphSha256: digest({ closure: graph.closure, edges: graph.edges }),
    packages, nativeLibraries, webview2, rustToolchain: rust.record, rightsLimits,
    noticesSha256: sha256(noticesBytes), artifacts: artifacts.map(({ path: p, bytes, sha256: h }) => ({ path: p, bytes: bytes.length, sha256: h })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
  };
  const manifestBytes = jsonBytes(manifest), manifestSha256 = sha256(manifestBytes);
  artifacts.push({ path: 'native-notices.json', bytes: manifestBytes, sha256: manifestSha256 });
  unique(artifacts.map(a => a.path));
  if (sha256(await readUnique(cargoLockPath)) !== manifest.cargoLockSha256 || sha256(await readUnique(policyPath)) !== policySha256) throw Error('Cargo lock or notices policy changed during verification');
  if (outputDir) { await safePath(outputDir, 'directory', true); await mkdir(outputDir); for (const artifact of artifacts) await writeNew(outputDir, artifact.path, artifact.bytes); }
  return { manifest, manifestBytes, manifestSha256, noticesBytes, noticesSha256: sha256(noticesBytes), files: artifacts.map(({ path: p, bytes, sha256: h }) => ({ path: p, bytes: bytes.length, sha256: h })).sort((a, b) => a.path.localeCompare(b.path, 'en')), artifacts, closure: manifest.closure, nativeLibraries, rightsLimits };
}

// Never accept the editable generated manifest as the authority. Regenerate
// from current policy, locked archives, complete source trees and toolchain.
export async function verifyNativeNotices({ noticesDir, expectedManifestSha256, ...inputs }) {
  if (!noticesDir || inputs.outputDir || !hashPattern.test(expectedManifestSha256 ?? '')) throw Error('Read-only verification needs noticesDir, an independently retained expectedManifestSha256, and no outputDir');
  const regenerated = await generateNativeNotices(inputs);
  if (regenerated.manifestSha256 !== expectedManifestSha256) throw Error('Regenerated notices differ from the independently retained manifest hash');
  await safePath(noticesDir, 'directory');
  const actual = [];
  async function visit(prefix = '') {
    await safePath(path.join(noticesDir, prefix), 'directory');
    const entries = await readdir(path.join(noticesDir, prefix), { withFileTypes: true });
    if (prefix && !entries.length) throw Error('Unexpected empty notices directory');
    for (const entry of entries) { const name = relative(prefix ? prefix + '/' + entry.name : entry.name); if (entry.isDirectory()) await visit(name); else { const bytes = await readUnique(path.join(noticesDir, name)); actual.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); } }
  }
  await visit(); unique(actual.map(f => f.path)); actual.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!same(actual, regenerated.files)) throw Error('Native notices differ from regenerated reviewed inputs');
  return regenerated;
}
