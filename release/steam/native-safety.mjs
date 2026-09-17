import { open, lstat, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { localPath, assertPlainPath } from './prepare-build.mjs';
import { relativeName, uniqueNames, sha256, writeNew } from './candidate-safety.mjs';

export { sha256, writeNew };
export const TARGET = 'x86_64-pc-windows-msvc';
export const FEATURES = ['tauri/custom-protocol'];
export const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export const stable = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const digest = value => sha256(Buffer.from(stable(value)));

export function nativePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f%"&|<>^!`$]/.test(value)) throw Error('Unsafe native path / shell expansion');
  if (/^[a-z]:[^\\/]/i.test(value) || value.split(/[\\/]/).some(p => p === '.' || p === '..')) throw Error('Native path alias refused');
  return localPath(value);
}
export function inside(parent, child) {
  const r = path.relative(parent, child);
  return !r || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep));
}
export async function plain(file, kind = 'file') {
  file = nativePath(file);
  const info = await assertPlainPath(file);
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) throw Error(`Not a unique plain ${kind}: ${file}`);
  return info;
}
// Hash and copy use one handle. The pathname is revalidated after closing the read.
// Observable redirects/races fail; this is not an OS sandbox against a hostile same-user process.
export async function snapshot(file) {
  const info = await plain(file);
  const handle = await open(file, 'r');
  try {
    if (!sameFile(info, await handle.stat())) throw Error(`Input changed while opening: ${file}`);
    const bytes = await handle.readFile();
    if (!sameFile(info, await handle.stat()) || !sameFile(info, await plain(file))) throw Error(`Input changed while reading: ${file}`);
    return { bytes, info, sha256: sha256(bytes) };
  } finally { await handle.close(); }
}
export async function records(root, names) {
  uniqueNames(names);
  const result = [];
  for (const name of [...names].sort()) {
    relativeName(name);
    const s = await snapshot(path.join(root, name));
    result.push({ path: name, bytes: s.bytes.length, sha256: s.sha256 });
  }
  return result;
}
export async function tree(root) {
  const names = [];
  async function visit(dir, prefix) {
    const before = await plain(dir, 'directory');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      relativeName(name);
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), name);
      else { await plain(path.join(root, name)); names.push(name); }
    }
    if (!sameIdentity(before, await plain(dir, 'directory'))) throw Error(`Directory changed: ${dir}`);
  }
  await visit(root, '');
  return records(root, names);
}
export async function assertRecords(root, expected) {
  if (stable(await records(root, expected.map(f => f.path))) !== stable(expected)) throw Error(`Source/copy hash mismatch: ${root}`);
}
export async function assertTree(root, expected) {
  if (stable(await tree(root)) !== stable(expected)) throw Error(`Tree changed / extra or missing files: ${root}`);
}
export async function newDirectory(destination) {
  destination = nativePath(destination);
  await plain(path.dirname(destination), 'directory');
  if (await assertPlainPath(destination, { missingLeaf: true })) throw Error(`Output already exists (EEXIST): ${destination}`);
  await mkdir(destination);
  return plain(destination, 'directory');
}
export async function copyRecords(source, destination, expected) {
  const rootInfo = await plain(destination, 'directory');
  await assertRecords(source, expected);
  for (const file of expected) {
    if (!sameIdentity(rootInfo, await plain(destination, 'directory'))) throw Error('Copy directory replaced');
    const s = await snapshot(path.join(source, file.path));
    if (s.sha256 !== file.sha256 || s.bytes.length !== file.bytes) throw Error(`Source changed before copy: ${file.path}`);
    await writeNew(destination, file.path, s.bytes);
  }
  await assertRecords(source, expected);
  await assertRecords(destination, expected);
  if (!sameIdentity(rootInfo, await plain(destination, 'directory'))) throw Error('Copy directory replaced');
}
export async function rejectCargoConfigs(roots, cargoHome) {
  const checked = new Set();
  for (const root of roots) {
    for (let dir = nativePath(root); ; dir = path.dirname(dir)) {
      checked.add(path.join(dir, '.cargo', 'config'));
      checked.add(path.join(dir, '.cargo', 'config.toml'));
      if (dir === path.dirname(dir)) break;
    }
  }
  if (cargoHome) for (const name of ['config', 'config.toml']) checked.add(path.join(nativePath(cargoHome), name));
  for (const file of checked) {
    // Do not follow a .cargo junction even when its target config does not exist.
    try { await plain(path.dirname(file), 'directory'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try { await lstat(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    throw Error(`Unrecorded Cargo config refused: ${file}`);
  }
  return [...checked].sort();
}
export function rejectAmbientEnvironment(env) {
  const seen = new Set();
  for (const [name, value] of Object.entries(env)) {
    const key = name.toUpperCase();
    if (seen.has(key)) throw Error(`Case-aliased environment variable: ${key}`);
    seen.add(key);
    if (value === undefined) continue;
    if ((/^(?:TAURI|CARGO|RUST)/.test(key) || /^(?:CC|CXX|AR|ARFLAGS|LD|RC|LINKER|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|RCFLAGS|BINDGEN|VCPKG|PKG_CONFIG|CMAKE)(?:_|$)/.test(key)) && key !== 'RUST_LOG' ||
      /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTDOC|CL|_CL_|LINK|_LINK_|INCLUDE|LIB|LIBPATH|NODE_OPTIONS|NODE_PATH|NAPI_RS_NATIVE_LIBRARY_PATH|SCCACHE.*|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|SDKROOT|DEVELOPER_DIR|STATIC_VCRUNTIME)$/.test(key)) {
      throw Error(`Unrecorded environment injection refused: ${key}`);
    }
  }
}
export function baseEnvironment(env) {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS']);
  const result = {};
  for (const [key, value] of Object.entries(env)) if (allowed.has(key.toUpperCase())) result[key.toUpperCase()] = value;
  if (!result.SYSTEMROOT || !result.USERPROFILE) throw Error('Windows system/profile environment missing');
  // No inherited PATH, npm options, signing variables, proxy credentials or compiler flags.
  result.PATH = path.join(result.SYSTEMROOT, 'System32');
  result.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return result;
}
