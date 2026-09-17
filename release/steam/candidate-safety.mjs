import { createHash } from 'node:crypto';
import { lstat, realpath, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const forbidden = /(?:mimi|sadako|kunkun|贞子|companions\/|(?:^|\/)(?:preview|reference|evidence|blender-source)(?:\/|\.)|\.(?:blend\d*|map|zip|psd|ts|tsx)$)/i;
export function relativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 220 || !/^[A-Za-z0-9_@./-]+$/.test(name)) throw Error(`Unsafe relative path: ${name}`);
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw Error(`Unsafe relative path: ${name}`);
  }
  return name;
}
export function uniqueNames(names) {
  const seen = new Set();
  for (const name of names) {
    relativeName(name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw Error(`Duplicate/case collision: ${name}`);
    for (const previous of seen) if (key.startsWith(previous + '/') || previous.startsWith(key + '/')) throw Error(`File/directory collision: ${name}`);
    seen.add(key);
  }
}
// Check lexical ancestors before realpath can follow a junction. Recheck before writes.
// This protects against visible redirects, not a hostile same-user process racing I/O.
export async function safePath(file, kind = 'file', missing = false) {
  const absolute = path.resolve(file);
  const chain = [];
  for (let p = absolute; ; p = path.dirname(p)) { chain.unshift(p); if (p === path.dirname(p)) break; }
  for (const p of chain) {
    let info;
    try { info = await lstat(p); } catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) throw Error(`Symlink/junction refused: ${p}`);
    if (p !== absolute || kind === 'directory') { if (!info.isDirectory()) throw Error(`Not a directory: ${p}`); }
    else if (!info.isFile() || info.nlink !== 1) throw Error(`Not a unique regular file: ${p}`);
    if (path.resolve(await realpath(p)).toLowerCase() !== p.toLowerCase()) throw Error(`Redirected path refused: ${p}`);
  }
  return absolute;
}
export async function readSafe(file) {
  await safePath(file);
  const bytes = await readFile(file);
  await safePath(file);
  if (!bytes.length) throw Error(`Empty file: ${file}`);
  return bytes;
}
export async function writeNew(root, name, bytes) {
  relativeName(name);
  const destination = path.join(root, name);
  await safePath(root, 'directory');
  await safePath(path.dirname(destination), 'directory', true);
  await mkdir(path.dirname(destination), { recursive: true });
  await safePath(path.dirname(destination), 'directory');
  await writeFile(destination, bytes, { flag: 'wx' });
  await safePath(destination);
}
export async function inventory(root) {
  await safePath(root, 'directory');
  const files = [];
  async function visit(prefix) {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
    if (prefix && !entries.length) throw Error(`Unexpected empty directory: ${prefix}`);
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      relativeName(name);
      await safePath(path.join(root, name), entry.isDirectory() ? 'directory' : 'file');
      if (entry.isDirectory()) await visit(name);
      else { const bytes = await readSafe(path.join(root, name)); files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
  }
  await visit('');
  uniqueNames(files.map(file => file.path));
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
