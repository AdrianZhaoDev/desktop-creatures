import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertPe, localPath } from './prepare-build.mjs';
import { relativeName } from './candidate-safety.mjs';

// This is static inspection, never proof of a build's origin, embedded frontend,
// signatures or successful execution. Only the controlled build caller may bind
// its own fixed output; accepting an arbitrary --exe remains an unbound operation.
// Format: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
// API sets: https://learn.microsoft.com/en-us/windows/win32/apiindex/windows-apisets
const executableName = 'desktop-creatures.exe';
const maxExecutableBytes = 1024 * 1024 * 1024;
const maxImportDescriptors = 4096;
const maxImportSymbols = 65536;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Error(`Invalid controlled native PE: ${message}`); };

// An explicit Windows 11 baseline. A new DLL or API-set contract requires review;
// an api-ms-/ext-ms- prefix alone never makes an unknown name trusted. These names
// do not prove loader resolution, API availability or absence of DLL side-loading.
const windowsDlls = new Set([
  'advapi32.dll', 'avrt.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'cfgmgr32.dll',
  'combase.dll', 'comctl32.dll', 'comdlg32.dll', 'crypt32.dll', 'd2d1.dll', 'd3d11.dll',
  'd3d12.dll', 'dbghelp.dll', 'dcomp.dll', 'dnsapi.dll', 'dwmapi.dll', 'dwrite.dll',
  'dxgi.dll', 'gdi32.dll', 'hid.dll', 'imm32.dll', 'iphlpapi.dll', 'kernel32.dll',
  'kernelbase.dll', 'msimg32.dll', 'msvcrt.dll', 'ncrypt.dll', 'netapi32.dll',
  'normaliz.dll', 'ntdll.dll', 'ole32.dll', 'oleacc.dll', 'oleaut32.dll', 'opengl32.dll',
  'powrprof.dll', 'propsys.dll', 'psapi.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll',
  'shell32.dll', 'shlwapi.dll', 'ucrtbase.dll', 'urlmon.dll', 'user32.dll', 'userenv.dll',
  'usp10.dll', 'uxtheme.dll', 'version.dll', 'windowscodecs.dll', 'winhttp.dll',
  'wininet.dll', 'winmm.dll', 'winspool.drv', 'wintrust.dll', 'wldap32.dll', 'ws2_32.dll',
  'wtsapi32.dll',
]);
const windowsApiSets = new Set([
  'api-ms-win-core-synch-l1-2-0.dll',
  'api-ms-win-core-winrt-l1-1-0.dll',
  'api-ms-win-core-winrt-string-l1-1-0.dll',
  'api-ms-win-core-winrt-error-l1-1-0.dll',
  ...['conio', 'convert', 'environment', 'filesystem', 'heap', 'locale', 'math',
    'multibyte', 'private', 'process', 'runtime', 'stdio', 'string', 'time', 'utility']
    .map(name => `api-ms-win-crt-${name}-l1-1-0.dll`),
]);

function classifyImport(name) {
  const canonical = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*\.(?:dll|drv)$/.test(canonical)) fail(`unsafe import DLL name: ${name}`);
  if (windowsDlls.has(canonical)) return { name: canonical, classification: 'windows-system' };
  if (windowsApiSets.has(canonical)) return { name: canonical, classification: 'windows-api-set' };
  const classification = /^steam_api(?:64)?\.dll$/.test(canonical) ? 'steam-sdk' :
    canonical === 'webview2loader.dll' ? 'webview2-loader' :
      /^(?:vcruntime|msvcp|msvcr|concrt)[0-9].*\.dll$/.test(canonical) ? 'vc-runtime-redistributable' :
        'unreviewed-external';
  const error = Error(`Unapproved native import DLL (${classification}): ${name}`);
  error.code = 'ERR_NATIVE_IMPORT_POLICY';
  error.import = { name: canonical, classification };
  throw error;
}

async function snapshotPath(file, kind = 'file', allowHardlinks = false) {
  const absolute = localPath(file);
  const chain = [];
  for (let current = absolute; ; current = path.dirname(current)) {
    chain.unshift(current);
    if (current === path.dirname(current)) break;
  }
  const snapshots = [];
  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink() || !samePath(path.resolve(await realpath(current)), current)) {
      throw Error(`Symlink, junction or redirected native path refused: ${current}`);
    }
    if (i < chain.length - 1 || kind === 'directory') {
      if (!info.isDirectory()) throw Error(`Native path must be a directory: ${current}`);
    } else if (!info.isFile() || !info.ino || info.nlink < 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      (!allowHardlinks && info.nlink !== 1n)) {
      throw Error(`Native input must be a unique regular file (no hardlinks): ${current}`);
    }
    snapshots.push({ path: current, info });
  }
  return { path: absolute, chain: snapshots, info: snapshots.at(-1).info, kind, allowHardlinks };
}

async function assertSnapshot(snapshot) {
  const current = await snapshotPath(snapshot.path, snapshot.kind, snapshot.allowHardlinks);
  if (current.chain.length !== snapshot.chain.length || current.chain.some((entry, index) =>
    !sameIdentity(entry.info, snapshot.chain[index].info))) {
    throw Error(`Native path identity changed during inspection: ${snapshot.path}`);
  }
  if (snapshot.kind === 'file' && !sameFile(snapshot.info, current.info)) {
    throw Error(`Native file changed during inspection: ${snapshot.path}`);
  }
}

async function withSafeHandle(file, action, { allowHardlinks = false, expected } = {}) {
  const snapshot = await snapshotPath(file, 'file', allowHardlinks);
  if (expected && !sameFile(expected, snapshot.info)) throw Error(`Native output changed before opening: ${file}`);
  const handle = await open(snapshot.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(snapshot.info, await handle.stat({ bigint: true }))) throw Error(`Native file changed while opening: ${file}`);
    await assertSnapshot(snapshot);
    const result = await action(handle, snapshot.info);
    if (!sameFile(snapshot.info, await handle.stat({ bigint: true }))) throw Error(`Native file changed while reading: ${file}`);
    await assertSnapshot(snapshot);
    return result;
  } finally {
    await handle.close();
  }
}

function inspectPeBytes(bytes) {
  const coff = bytes.readUInt32LE(60);
  const optional = coff + 24;
  const sectionCount = bytes.readUInt16LE(coff + 6);
  const optionalSize = bytes.readUInt16LE(coff + 20);
  const characteristics = bytes.readUInt16LE(coff + 22);
  if (bytes.readUInt16LE(coff + 4) !== 0x8664 || bytes.readUInt16LE(optional) !== 0x20b) {
    fail('expected AMD64 / PE32+ for the fixed x86_64-pc-windows-msvc target');
  }
  if (characteristics & 0x0100) fail('PE32+ image has the 32-bit-machine flag');
  const imageBase = bytes.readBigUInt64LE(optional + 24);
  const imageSize = bytes.readUInt32LE(optional + 56);
  if (!imageBase || imageBase % 65536n || imageBase + BigInt(imageSize) > 0xffffffffffffffffn) fail('invalid image base');
  const entryPointRva = bytes.readUInt32LE(optional + 16);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = optional + optionalSize + index * 40;
    sections.push({
      name: bytes.subarray(at, at + 8).toString('latin1').replace(/\0.*$/, ''),
      virtualSize: bytes.readUInt32LE(at + 8), rva: bytes.readUInt32LE(at + 12),
      rawSize: bytes.readUInt32LE(at + 16), raw: bytes.readUInt32LE(at + 20),
      characteristics: bytes.readUInt32LE(at + 36),
    });
  }
  if (!sections.some(section => (section.characteristics & 0x20000000) &&
    entryPointRva >= section.rva && entryPointRva < section.rva +
    Math.min(section.rawSize, section.virtualSize || section.rawSize))) {
    fail('entry point is outside initialized executable section content');
  }
  function mapped(rva, length = 1) {
    if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(length) || rva <= 0 || length <= 0 || rva + length > 0x100000000) {
      fail('invalid import RVA extent');
    }
    const section = sections.find(section => rva >= section.rva && rva + length <= section.rva +
      Math.min(section.rawSize, section.virtualSize || section.rawSize));
    if (!section) fail('import RVA is outside initialized section content');
    const offset = section.raw + rva - section.rva;
    return { offset, available: Math.min(section.rawSize, section.virtualSize || section.rawSize) - (rva - section.rva) };
  }
  function stringAt(rva, limit, label) {
    const { offset, available } = mapped(rva);
    const candidate = bytes.subarray(offset, offset + Math.min(available, limit + 1));
    const end = candidate.indexOf(0);
    if (end <= 0) fail(`unterminated or invalid ${label}`);
    const value = candidate.subarray(0, end);
    if (value.some(byte => byte < 0x21 || byte > 0x7e)) fail(`non-ASCII or unsafe ${label}`);
    return value.toString('ascii');
  }
  const directoryCount = bytes.readUInt32LE(optional + 108);
  function directory(index) {
    if (index >= directoryCount) return { rva: 0, size: 0 };
    const at = optional + 112 + index * 8;
    return { rva: bytes.readUInt32LE(at), size: bytes.readUInt32LE(at + 4) };
  }
  if (directory(11).rva) fail('bound imports are unsupported in a fresh controlled native build');
  if (directory(14).rva) fail('managed CLR images are not a controlled native executable');
  let totalSymbols = 0;
  function inspectThunks(rva, label) {
    if (rva % 8) fail(`unaligned ${label}`);
    const { offset, available } = mapped(rva, 8);
    let count = 0;
    let ordinalCount = 0;
    for (let at = offset; at + 8 <= offset + available; at += 8) {
      const value = bytes.readBigUInt64LE(at);
      if (!value) {
        if (!count) fail(`empty ${label}`);
        return { count, ordinalCount };
      }
      if (++totalSymbols > maxImportSymbols) fail('too many imported symbols');
      count++;
      if (value & 0x8000000000000000n) {
        if (value & 0x7fffffffffff0000n || !(value & 0xffffn)) fail('invalid ordinal import');
        ordinalCount++;
      } else {
        if (value > 0x7fffffffn) fail('invalid PE32+ import-name RVA');
        const nameRva = Number(value);
        mapped(nameRva, 3);
        stringAt(nameRva + 2, 4096, 'import symbol name');
      }
    }
    fail(`unterminated ${label}`);
  }
  function inspectAddressTable(rva, count, label, lookupRva) {
    if (rva % 8) fail(`unaligned ${label}`);
    const { offset } = mapped(rva, (count + 1) * 8);
    if (bytes.readBigUInt64LE(offset + count * 8)) fail(`unterminated ${label}`);
    for (let index = 0; index < count; index++) {
      if (!bytes.readBigUInt64LE(offset + index * 8)) fail(`truncated ${label}`);
    }
    if (lookupRva) {
      const lookup = mapped(lookupRva, (count + 1) * 8).offset;
      if (!bytes.subarray(offset, offset + (count + 1) * 8).equals(bytes.subarray(lookup, lookup + (count + 1) * 8))) {
        fail('normal IAT differs from the unbound import lookup table');
      }
    }
  }
  const imports = [];
  for (const [kind, index, descriptorSize] of [['normal', 1, 20], ['delay', 13, 32]]) {
    const { rva, size } = directory(index);
    if (!rva) continue;
    if (rva % 4 || size < descriptorSize || size > maxImportDescriptors * descriptorSize) fail(`invalid ${kind} import directory size/alignment`);
    const table = mapped(rva, size).offset;
    let terminated = false;
    for (let offset = 0; offset + descriptorSize <= size; offset += descriptorSize) {
      const at = table + offset;
      const descriptor = bytes.subarray(at, at + descriptorSize);
      if (descriptor.every(byte => byte === 0)) {
        if (bytes.subarray(at, table + size).some(byte => byte !== 0)) fail(`nonzero data after ${kind} import terminator`);
        terminated = true;
        break;
      }
      let nameRva, lookupRva, addressRva, unloadRva = 0;
      if (kind === 'normal') {
        lookupRva = bytes.readUInt32LE(at);
        const timestamp = bytes.readUInt32LE(at + 4);
        const forwarder = bytes.readUInt32LE(at + 8);
        if (timestamp || ![0, 0xffffffff].includes(forwarder)) fail('bound/forwarded imports are unsupported in a fresh build');
        nameRva = bytes.readUInt32LE(at + 12);
        addressRva = bytes.readUInt32LE(at + 16);
        // A zero OriginalFirstThunk uses FirstThunk as the lookup table.
        lookupRva ||= addressRva;
      } else {
        if (bytes.readUInt32LE(at) !== 1) fail('delay imports must use modern RVA-based descriptors');
        nameRva = bytes.readUInt32LE(at + 4);
        const moduleRva = bytes.readUInt32LE(at + 8);
        if (!moduleRva || moduleRva % 8 || !sections.some(section => moduleRva >= section.rva &&
          moduleRva + 8 <= section.rva + (section.virtualSize || section.rawSize))) fail('invalid delay module-handle RVA');
        addressRva = bytes.readUInt32LE(at + 12);
        lookupRva = bytes.readUInt32LE(at + 16);
        if (bytes.readUInt32LE(at + 20) || bytes.readUInt32LE(at + 28)) fail('bound delay imports are unsupported in a fresh build');
        unloadRva = bytes.readUInt32LE(at + 24);
      }
      const dependency = classifyImport(stringAt(nameRva, 255, 'import DLL name'));
      if (imports.some(item => item.kind === kind && item.name === dependency.name)) fail(`duplicate ${kind} import DLL: ${dependency.name}`);
      const thunks = inspectThunks(lookupRva, `${kind} import lookup table`);
      inspectAddressTable(addressRva, thunks.count, `${kind} import address table`, kind === 'normal' ? lookupRva : 0);
      if (unloadRva) inspectAddressTable(unloadRva, thunks.count, 'delay unload address table');
      imports.push({ ...dependency, kind, symbolCount: thunks.count, ordinalCount: thunks.ordinalCount });
    }
    if (!terminated) fail(`unterminated ${kind} import directory`);
  }
  if (directory(12).rva && !imports.length) fail('orphan import address table');
  return {
    pe: {
      machine: 'AMD64', machineValue: 0x8664, format: 'PE32+', characteristics,
      isDll: false, entryPointRva, imageBase: `0x${imageBase.toString(16)}`, imageSize,
      subsystem: bytes.readUInt16LE(optional + 68), sectionCount, sections,
    },
    imports: imports.sort((a, b) => a.kind.localeCompare(b.kind, 'en') || a.name.localeCompare(b.name, 'en')),
    importPolicy: {
      id: 'windows-11-x64-system-imports-v1', unapprovedDllCount: 0,
      loaderResolutionVerified: false, runtimeLoadedModulesInspected: false,
    },
  };
}

/** Inspect one unique regular file without executing or binding it. Hashing and
 * both PE passes use the same open file handle; directory and file identities are
 * checked before/after. Visible replacement, redirects and hardlinks are refused.
 * Node does not provide a Windows deny-write/delete share mode or handle-relative
 * traversal here, so this is not a hostile same-user race-proof filesystem seal.
 */
export async function inspectNativeExecutable(file) {
  return withSafeHandle(file, async (handle, info) => {
    if (!info.size || info.size > BigInt(maxExecutableBytes)) fail('empty or oversized executable');
    await assertPe(handle, Number(info.size));
    const bytes = await handle.readFile();
    if (bytes.length !== Number(info.size)) fail('executable changed size during inspection');
    // Run the same full structural validator on the exact bytes being hashed too.
    await assertPe({ read: async (buffer, offset, length, position) => ({
      bytesRead: bytes.copy(buffer, offset, position, position + length),
    }) }, bytes.length);
    return { path: path.basename(file), bytes: bytes.length, sha256: digest(bytes), ...inspectPeBytes(bytes) };
  });
}

const rootBuildFiles = new Set([
  '.cargo-lock', '.cargo-artifact-lock', '.cargo-build-lock',
  'desktop-creatures.d', 'desktop_creatures_lib.d',
  'desktop-creatures.pdb', 'desktop_creatures.pdb', 'desktop_creatures_lib.pdb',
  'desktop_creatures_lib.dll', 'desktop_creatures_lib.dll.lib', 'desktop_creatures_lib.dll.exp',
  'desktop_creatures_lib.lib', 'desktop_creatures_lib.exp',
  'desktop_creatures_lib.rlib', 'libdesktop_creatures_lib.rlib',
]);
const cargoDirectories = new Set(['deps', 'build', '.fingerprint', 'incremental', 'examples']);
const bundleFile = /\.(?:msi|msix|msixbundle|appx|appxbundle|msm|msp|msu|nupkg|zip|7z|rar|cab|dmg|appimage)$/i;

/** Audit the complete fresh, isolated Cargo release tree. Only the fixed root EXE
 * is a distribution input. All other root files are hashed build-only records.
 * Cargo's normal deps/build programs and proc-macro DLLs are internal, not payload.
 * Cargo hardlinks are permitted only when every link is accounted for inside this
 * release tree. Copy the fixed EXE to a NEW unique regular file before calling
 * inspectNativeExecutable; this audit never relaxes that inspector's no-hardlink rule.
 */
export async function assertNativeOutputs(targetReleaseDir) {
  const root = await snapshotPath(targetReleaseDir, 'directory');
  const directories = [];
  const entries = [];
  const seen = new Set();
  async function visit(directory, prefix = '') {
    const snapshot = await snapshotPath(directory, 'directory');
    const names = (await readdir(directory)).sort();
    directories.push({ snapshot, names });
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      relativeName(relative);
      if (seen.has(relative.toLowerCase())) throw Error(`Native output case collision: ${relative}`);
      seen.add(relative.toLowerCase());
      const file = path.join(directory, name);
      const info = await lstat(file, { bigint: true });
      if (info.isSymbolicLink()) throw Error(`Symlink/junction in native outputs: ${relative}`);
      if (info.isDirectory()) {
        if (/^(?:bundle|nsis|wix)$/i.test(name) || (!prefix && !cargoDirectories.has(name))) {
          throw Error(`Unexpected native output directory/bundle: ${relative}`);
        }
        await visit(file, relative);
        continue;
      }
      if (!info.isFile()) throw Error(`Native output is not a regular file: ${relative}`);
      if (bundleFile.test(name)) throw Error(`Unexpected native output bundle/archive: ${relative}`);
      const internal = Boolean(prefix);
      if (!internal && name !== executableName && !rootBuildFiles.has(name)) throw Error(`Unexpected native output file: ${relative}`);
      if (internal && /\.(?:exe|dll)$/i.test(name) && !['deps', 'build'].includes(relative.split('/')[0])) {
        throw Error(`Unexpected native output EXE/DLL: ${relative}`);
      }
      const safe = await snapshotPath(file, 'file', true);
      if (!sameFile(info, safe.info)) throw Error(`Native output changed during inventory: ${relative}`);
      entries.push({ relative, snapshot: safe, internal });
    }
    await assertSnapshot(snapshot);
  }
  await visit(root.path);
  const main = entries.find(entry => entry.relative === executableName);
  if (!main || !main.snapshot.info.size) throw Error(`Missing or empty fixed native output: ${executableName}`);
  const identities = new Map();
  for (const entry of entries) {
    const { dev, ino, nlink } = entry.snapshot.info;
    if (!ino || nlink < 1n) throw Error(`Native output has unavailable identity/link count: ${entry.relative}`);
    const key = `${dev}:${ino}`;
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(entry);
  }
  const hardlinkGroups = [];
  for (const group of identities.values()) {
    const info = group[0].snapshot.info;
    if (BigInt(group.length) !== info.nlink || group.some(entry => !sameFile(info, entry.snapshot.info))) {
      throw Error(`Native output hardlink escapes the isolated release tree: ${group[0].relative}`);
    }
    if (group.length > 1) hardlinkGroups.push({ paths: group.map(entry => entry.relative).sort(), linkCount: group.length });
  }
  const files = [];
  for (const entry of entries.filter(entry => !entry.internal)) {
    const record = await withSafeHandle(entry.snapshot.path, async (handle, info) => {
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      return { path: entry.relative, bytes: Number(info.size), sha256: hash.digest('hex'),
        role: entry.relative === executableName ? 'executable' : 'build-only' };
    }, { allowHardlinks: true, expected: entry.snapshot.info });
    files.push(record);
  }
  for (const entry of entries) await assertSnapshot(entry.snapshot);
  for (const { snapshot, names } of directories) {
    await assertSnapshot(snapshot);
    if (JSON.stringify((await readdir(snapshot.path)).sort()) !== JSON.stringify(names)) {
      throw Error(`Native output inventory changed: ${snapshot.path}`);
    }
  }
  await assertSnapshot(root);
  return {
    executable: executableName, files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    cargoInternal: {
      fileCount: entries.filter(entry => entry.internal).length,
      executableCount: entries.filter(entry => entry.internal && /\.exe$/i.test(entry.relative)).length,
      dllCount: entries.filter(entry => entry.internal && /\.dll$/i.test(entry.relative)).length,
      contentHashed: false,
    },
    hardlinkGroups,
  };
}
