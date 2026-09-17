import { createHash } from 'node:crypto';
import { open, readFile, readdir, realpath, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'node prepare-build.mjs --product game|demo --app-id ID --depot-id ID [--base-app-id ID] --content DIR --output NEW_DIR --confirm-real-ids steamworks-console [--description TEXT]';
const allowed = new Set(['product', 'app-id', 'depot-id', 'base-app-id', 'content', 'output', 'confirm-real-ids', 'description']);
const knownUnsafeIds = new Set(['480']);
const args = {};
function vdfValue(value) {
  if (/["\x00-\x1f\x7f]/.test(value)) throw new Error('VDF values cannot contain quotes or control characters.');
  return value.replaceAll('\\', '/');
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function localPath(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Paths cannot contain control characters.');
  // Device namespaces, ADS, reserved names and trailing-dot/space aliases bypass ordinary Windows names.
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(value)) throw new Error('Windows device and network paths are refused.');
    const components = value.replace(/^[a-z]:/i, '').split(/[\\/]/).filter(Boolean);
    if (components.some(part => part !== '.' && part !== '..' &&
      (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) {
      throw new Error('Windows path aliases, reserved names and alternate data streams are refused.');
    }
  }
  return path.resolve(value);
}

export async function assertPlainPath(target, { missingLeaf = false } = {}) {
  const root = path.parse(target).root;
  const components = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = path.join(current, components[i]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && i === components.length - 1) return null;
      throw error;
    }
    if (info.isSymbolicLink() || !samePath(await realpath(current), current)) {
      throw new Error(`Symlink, junction or redirected path is refused: ${current}`);
    }
    if (i < components.length - 1 && !info.isDirectory()) throw new Error(`Path ancestor must be a directory: ${current}`);
    if (i === components.length - 1) return info;
  }
  return lstat(root);
}

// Structural validation only: this does not certify code, signatures, embedded assets or runtime behavior.
// Layout reference: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export async function assertPe(handle, fileSize) {
  const fail = message => { throw new Error(`Invalid Windows PE executable: ${message}`); };
  async function bytes(offset, length) {
    if (offset < 0 || length < 0 || offset + length > fileSize) fail('truncated header or section data.');
    const buffer = Buffer.alloc(length);
    if ((await handle.read(buffer, 0, length, offset)).bytesRead !== length) fail('truncated file.');
    return buffer;
  }
  const dos = await bytes(0, 64);
  if (dos.readUInt16LE(0) !== 0x5a4d) fail('missing MZ signature.');
  const peOffset = dos.readUInt32LE(60);
  if (peOffset < 64) fail('invalid PE header offset.');
  const coff = await bytes(peOffset, 24);
  if (coff.readUInt32LE(0) !== 0x00004550) fail('missing PE signature.');
  const machine = coff.readUInt16LE(4);
  const sectionCount = coff.readUInt16LE(6);
  const optionalSize = coff.readUInt16LE(20);
  const flags = coff.readUInt16LE(22);
  if (!(flags & 0x0002) || flags & 0x2000) fail('must be an executable image, not a DLL or object file.');
  if (!sectionCount || sectionCount > 96) fail('invalid section count.');
  if (optionalSize < 2) fail('missing optional header.');
  const optional = await bytes(peOffset + 24, optionalSize);
  const magic = optional.readUInt16LE(0);
  const fixedSize = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  if (!fixedSize || optionalSize < fixedSize) fail('invalid or truncated optional header.');
  if (!((machine === 0x014c && magic === 0x10b) || ([0x8664, 0xaa64].includes(machine) && magic === 0x20b))) {
    fail('unsupported or inconsistent Windows machine type.');
  }
  const directoryCount = optional.readUInt32LE(fixedSize - 4);
  if (directoryCount > 16 || fixedSize + directoryCount * 8 > optionalSize) fail('truncated data directory table.');
  const entry = optional.readUInt32LE(16);
  const sectionAlignment = optional.readUInt32LE(32);
  const fileAlignment = optional.readUInt32LE(36);
  const imageSize = optional.readUInt32LE(56);
  const headersSize = optional.readUInt32LE(60);
  const powerOfTwo = n => n > 0 && (n & (n - 1)) === 0;
  if (!powerOfTwo(fileAlignment) || !powerOfTwo(sectionAlignment) || fileAlignment > 65536 ||
    sectionAlignment < fileAlignment || (sectionAlignment < 4096 ? fileAlignment !== sectionAlignment : fileAlignment < 512)) {
    fail('invalid file or section alignment.');
  }
  if (![2, 3].includes(optional.readUInt16LE(68))) fail('expected a Windows GUI or console subsystem.');
  const tableOffset = peOffset + 24 + optionalSize;
  if (headersSize < tableOffset + sectionCount * 40 || headersSize > fileSize || headersSize % fileAlignment ||
    !imageSize || imageSize % sectionAlignment || imageSize < headersSize) fail('invalid image/header size.');
  const table = await bytes(tableOffset, sectionCount * 40);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const offset = i * 40;
    const virtualSize = table.readUInt32LE(offset + 8);
    const rva = table.readUInt32LE(offset + 12);
    const rawSize = table.readUInt32LE(offset + 16);
    const raw = table.readUInt32LE(offset + 20);
    const size = Math.max(virtualSize, rawSize);
    if (!size || rva < headersSize || rva % sectionAlignment || rva + size > imageSize) fail('invalid virtual section extent.');
    if (rawSize && (raw < headersSize || raw % fileAlignment || rawSize % fileAlignment || raw + rawSize > fileSize)) {
      fail('truncated or invalid raw section extent.');
    }
    if (sections.some(s => (rva < s.rva + s.size && s.rva < rva + size) ||
      (rawSize && s.rawSize && raw < s.raw + s.rawSize && s.raw < raw + rawSize))) fail('overlapping sections.');
    sections.push({ rva, size, raw, rawSize, flags: table.readUInt32LE(offset + 36) });
  }
  if (!entry || !sections.some(s => (s.flags & 0x20000000) && entry >= s.rva && entry < s.rva + s.rawSize)) {
    fail('entry point must be backed by an executable section.');
  }
  for (let i = 0; i < directoryCount; i++) {
    const address = optional.readUInt32LE(fixedSize + i * 8);
    const size = optional.readUInt32LE(fixedSize + i * 8 + 4);
    if (!address && !size) continue;
    if (!address || !size) fail('invalid data directory extent.');
    if (i === 4) {
      if (address % 8 || size < 8 || address < headersSize || address + size > fileSize ||
        sections.some(s => s.rawSize && address < s.raw + s.rawSize && s.raw < address + size)) fail('truncated or overlapping certificate table.');
    } else if (!(address + size <= headersSize || sections.some(s => address >= s.rva && address + size <= s.rva + s.rawSize))) {
      fail('data directory is outside image sections.');
    }
  }
}

function requireRealId(key) {
  const value = args[key] ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 4294967295 || knownUnsafeIds.has(value)) {
    throw new Error(`Provide the real Steamworks ${key}; missing, placeholder, and public test IDs are refused.\n${usage}`);
  }
  return value;
}

export async function assertPreparedFileShape(content, name, snapshots = new Map()) {
  if (!['desktop-creatures.exe', 'THIRD-PARTY-NOTICES.txt'].includes(name)) throw new Error('Prepared filename is not allowlisted.');
  content = localPath(content);
  const file = path.join(content, name);
  const info = await assertPlainPath(file);
  if (!info.isFile() || !info.size || info.nlink !== 1) throw new Error(`Empty, hard-linked or invalid prepared file: ${name}`);
  const handle = await open(file, 'r');
  try {
    if (!sameFile(info, await handle.stat())) throw new Error(`Prepared file changed while opening: ${name}`);
    if (name === 'desktop-creatures.exe') await assertPe(handle, info.size);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      if (name === 'THIRD-PARTY-NOTICES.txt' && chunk.includes(0)) {
        throw new Error('THIRD-PARTY-NOTICES.txt must be a plain text file without NUL bytes.');
      }
      hash.update(chunk);
    }
    if (!sameFile(info, await handle.stat()) || !sameFile(info, await assertPlainPath(file))) {
      throw new Error(`Prepared file changed during verification: ${name}`);
    }
    snapshots.set(name, info);
    return { path: name, bytes: info.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function main() {
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '');
    const value = process.argv[i + 1];
    if (!process.argv[i].startsWith('--') || !allowed.has(key) || value === undefined || value.startsWith('--') || key in args) throw new Error(usage);
    args[key] = value;
  }
  if (!['game', 'demo'].includes(args.product)) throw new Error(`Select --product game or --product demo.\n${usage}`);
  if (args['confirm-real-ids'] !== 'steamworks-console') {
    throw new Error(`Explicitly confirm that IDs were copied from Steamworks with --confirm-real-ids steamworks-console.\n${usage}`);
  }
  const appId = requireRealId('app-id');
  const depotId = requireRealId('depot-id');
  if (appId === depotId) throw new Error('AppID and DepotID must be different Steamworks identifiers.');
  let baseAppId = null;
  if (args.product === 'demo') {
    baseAppId = requireRealId('base-app-id');
    if (baseAppId === appId || baseAppId === depotId) {
      throw new Error('Demo AppID, base-game AppID, and Demo DepotID must be distinct.');
    }
  } else if (args['base-app-id'] !== undefined) {
    throw new Error('--base-app-id is only valid for --product demo.');
  }
  if (!args.content || !args.output) throw new Error(usage);
  const content = localPath(args.content);
  const output = localPath(args.output);
  const contentInfo = await assertPlainPath(content);
  if (!contentInfo.isDirectory()) throw new Error('Content must be a dedicated directory.');
  if (await assertPlainPath(output, { missingLeaf: true })) throw new Error('Output already exists (EEXIST); refusing to overwrite it.');
  const relativeOutput = path.relative(content, output);
  if (!relativeOutput || (!relativeOutput.startsWith('..' + path.sep) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) {
    throw new Error('Output must be outside the prepared content directory.');
  }
  const names = ['desktop-creatures.exe', 'THIRD-PARTY-NOTICES.txt'];
  const entries = await readdir(content, { withFileTypes: true });
  if (entries.length !== names.length || entries.some(entry => !entry.isFile() || !names.includes(entry.name))) {
    throw new Error(`The dedicated content directory must contain exactly: ${names.join(', ')}.`);
  }
  const files = [];
  const snapshots = new Map();
  for (const name of names) {
    files.push(await assertPreparedFileShape(content, name, snapshots));
  }
  async function assertInventoryUnchanged() {
    if (!sameFile(contentInfo, await assertPlainPath(content))) throw new Error('Content directory changed during preparation.');
    const current = await readdir(content, { withFileTypes: true });
    if (current.length !== names.length || current.some(entry => !entry.isFile() || !names.includes(entry.name))) {
      throw new Error('Content inventory changed during preparation.');
    }
    for (const [name, info] of snapshots) {
      if (!sameFile(info, await assertPlainPath(path.join(content, name)))) throw new Error(`Prepared file changed: ${name}`);
    }
  }
  const values = {
    APP_ID: appId, DEPOT_ID: depotId,
    BUILD_DESCRIPTION: args.description ?? 'Desktop Creatures local preview',
    CONTENT_ROOT: content, BUILD_OUTPUT: path.join(output, 'build-cache'),
  };
  const root = path.dirname(fileURLToPath(import.meta.url));
  const rendered = [];
  for (const [source, destination] of [['app_build.vdf.template', 'app_build.vdf'], ['depot_windows.vdf.template', 'depot_windows.vdf']]) {
    const template = await readFile(path.join(root, source), 'utf8');
    const body = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`Unknown template field ${key}`);
      return vdfValue(values[key]);
    });
    rendered.push([destination, body]);
  }
  // Refuse to overwrite any existing output; never run SteamCMD or change a branch.
  await assertInventoryUnchanged();
  await assertPlainPath(output, { missingLeaf: true });
  await mkdir(output);
  const outputInfo = await assertPlainPath(output);
  async function writePrepared(name, body) {
    const current = await assertPlainPath(output);
    if (!current.isDirectory() || current.dev !== outputInfo.dev || current.ino !== outputInfo.ino) {
      throw new Error('Output directory changed during preparation.');
    }
    const target = path.join(output, name);
    if (await assertPlainPath(target, { missingLeaf: true })) throw new Error(`Output file already exists: ${name}`);
    await writeFile(target, body, { flag: 'wx' });
    await assertPlainPath(target);
  }
  for (const [name, body] of rendered) await writePrepared(name, body);
  await assertInventoryUnchanged();
  await writePrepared('prepared-files.json', JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    product: args.product,
    appId,
    depotId,
    baseAppId,
    idSourceConfirmation: 'operator-confirmed-from-steamworks-console',
    previewOnly: true,
    steamCmdInvoked: false,
    uploaded: false,
    branchChanged: false,
    embeddedAssetAudit: 'required-before-release',
    configurationFiles: rendered.map(([name, body]) => ({
      path: name,
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    })),
    files,
  }, null, 2) + '\n');
  console.log(`Prepared local preview scripts at ${output}. No login, upload, or branch change was performed.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
