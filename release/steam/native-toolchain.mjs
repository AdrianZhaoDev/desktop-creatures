import { spawn } from 'node:child_process';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { TARGET, snapshot, plain, tree, records, digest, sha256, baseEnvironment, inside, nativePath, writeNew } from './native-safety.mjs';

export async function command(executable, args, { cwd, env, logRoot, name }) {
  await plain(executable);
  await plain(cwd, 'directory');
  const result = await new Promise(resolve => {
    const stdout = [], stderr = [];
    let total = 0, overflow = false;
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = destination => data => {
      total += data.length;
      if (total > 256 * 1024 * 1024) { overflow = true; child.kill(); } else destination.push(data);
    };
    child.stdout.on('data', append(stdout)); child.stderr.on('data', append(stderr));
    child.once('error', error => resolve({ code: null, stdout: '', stderr: error.message, spawnError: error.code }));
    child.once('close', (code, signal) => resolve({ code, signal, overflow, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  const record = { executable, args, cwd, exitCode: result.code, signal: result.signal ?? null, environmentSha256: digest(env) };
  const log = Buffer.from(JSON.stringify(record) + '\n# stdout\n' + result.stdout + '\n# stderr\n' + result.stderr);
  if (logRoot) await writeNew(logRoot, `${name}.log`, log);
  if (result.code !== 0 || result.overflow || result.spawnError) throw Error(`Controlled command failed (${name}, exit ${result.code}); ${result.stderr.slice(-1800)}`);
  return { ...result, record: { ...record, log: `${name}.log`, logSha256: digestLog(log) } };
}
function digestLog(bytes) { return sha256(bytes); }

export async function prepareToolchain({ root, rustVersion, output, ambient }) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !/^v24\./.test(process.version)) throw Error('Native builder requires Windows x64 and Node 24');
  const system = baseEnvironment(ambient);
  const rustRoot = nativePath(path.join(system.USERPROFILE, '.rustup/toolchains', `${rustVersion}-${TARGET}`));
  const cargoHome = nativePath(path.join(system.USERPROFILE, '.cargo'));
  await plain(rustRoot, 'directory'); await plain(cargoHome, 'directory');
  // Windows PowerShell in WinSxS is normally hard-linked. Require the installed
  // PowerShell 7 executable instead of weakening the unique-input rule.
  const ps = path.join(system.PROGRAMFILES, 'PowerShell/7/pwsh.exe');
  const node = nativePath(process.execPath);
  const logRoot = path.join(output, 'logs');
  const probe = await command(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'release/steam/native-msvc-environment.ps1'), '-RustToolchainRoot', rustRoot, '-NodeExecutable', node], {
    cwd: root, env: { ...system, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') }, logRoot, name: 'msvc-bootstrap',
  });
  const bootstrap = JSON.parse(probe.stdout.trim());
  if (bootstrap.kind !== 'controlled-msvc-environment' || bootstrap.environment.VSCMD_ARG_TGT_ARCH !== 'x64' || bootstrap.environment.VSCMD_ARG_HOST_ARCH !== 'x64') throw Error('Invalid MSVC environment report');
  const vc = nativePath(bootstrap.environment.VCToolsInstallDir.replace(/[\\/]+$/, ''));
  const sdk = nativePath(bootstrap.environment.WindowsSdkDir.replace(/[\\/]+$/, ''));
  const sdkVersion = bootstrap.environment.WindowsSDKVersion.replace(/[\\/]+$/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(sdkVersion)) throw Error('Invalid Windows SDK version');
  for (const name of ['cl.exe', 'link.exe', 'lib.exe']) if (!inside(vc, nativePath(bootstrap.tools[name]))) throw Error('MSVC executable escaped installation');
  for (const name of ['rc.exe', 'mt.exe']) if (!inside(sdk, nativePath(bootstrap.tools[name]))) throw Error('SDK executable escaped installation');
  const includes = [path.join(vc, 'include'), ...['ucrt', 'shared', 'um', 'winrt', 'cppwinrt'].map(n => path.join(sdk, 'Include', sdkVersion, n))];
  const libs = [path.join(vc, 'lib/x64'), ...['ucrt', 'um'].map(n => path.join(sdk, 'Lib', sdkVersion, n, 'x64'))];
  for (const dir of [...includes, ...libs]) await plain(dir, 'directory');
  const cargo = path.join(rustRoot, 'bin/cargo.exe'), rustc = path.join(rustRoot, 'bin/rustc.exe');
  const env = {
    ...system,
    PATH: [path.join(rustRoot, 'bin'), path.dirname(node), path.dirname(bootstrap.tools['cl.exe']), path.dirname(bootstrap.tools['rc.exe']), path.join(system.SYSTEMROOT, 'System32')].join(';'),
    INCLUDE: includes.join(';'), LIB: libs.join(';'), LIBPATH: libs.join(';'),
    VCINSTALLDIR: path.join(bootstrap.installationPath, 'VC') + path.sep, VSCMD_ARG_TGT_ARCH: 'x64', VSCMD_ARG_HOST_ARCH: 'x64',
    CC: bootstrap.tools['cl.exe'], CXX: bootstrap.tools['cl.exe'], AR: bootstrap.tools['lib.exe'],
    RC: bootstrap.tools['rc.exe'], RC_x86_64_pc_windows_msvc: bootstrap.tools['rc.exe'],
    VCToolsInstallDir: vc + path.sep, VCToolsVersion: bootstrap.environment.VCToolsVersion,
    WindowsSdkDir: sdk + path.sep, WindowsSDKVersion: sdkVersion + path.sep,
    UniversalCRTSdkDir: sdk + path.sep, UCRTVersion: sdkVersion,
    TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'),
    CARGO_HOME: cargoHome, CARGO_TARGET_DIR: path.join(output, 'cargo-target'), CARGO_NET_OFFLINE: 'true',
    CARGO_INCREMENTAL: '0', CARGO_TERM_COLOR: 'never', RUSTC: rustc, RUSTDOC: path.join(rustRoot, 'bin/rustdoc.exe'),
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: bootstrap.tools['link.exe'], STATIC_VCRUNTIME: 'true', CI: 'true',
  };
  const rustVersionResult = await command(rustc, ['-vV'], { cwd: root, env, logRoot, name: 'rustc-version' });
  if (!rustVersionResult.stdout.includes(`release: ${rustVersion}\n`) || !rustVersionResult.stdout.includes(`host: ${TARGET}`)) throw Error('Rust compiler version/host mismatch');
  const cargoVersion = await command(cargo, ['-Vv'], { cwd: root, env, logRoot, name: 'cargo-version' });
  if (!cargoVersion.stdout.startsWith(`cargo ${rustVersion} `)) throw Error('Cargo version mismatch');
  const cfg = await command(rustc, ['--print', 'cfg', '--target', TARGET], { cwd: root, env, logRoot, name: 'rust-target-cfg' });
  const tauri = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const tauriVersion = await command(node, [tauri, '--version'], { cwd: root, env, logRoot, name: 'tauri-version' });
  if (tauriVersion.stdout.trim() !== 'tauri-cli 2.11.4') throw Error('Tauri CLI version mismatch');
  const toolNames = [node, ps, cargo, rustc, env.RUSTDOC, ...Object.values(bootstrap.tools), ...bootstrap.bootstrapFiles];
  const files = [];
  for (const file of [...new Set(toolNames)].sort()) { const s = await snapshot(file); files.push({ path: file, bytes: s.bytes.length, sha256: s.sha256 }); }
  // These reviewed external toolchain directories are not project source allowlist expansion.
  const directories = [...new Set([...includes, ...libs, path.dirname(bootstrap.tools['cl.exe']), path.dirname(bootstrap.tools['rc.exe'])])];
  const directoryRecords = [];
  for (const dir of directories) directoryRecords.push({ path: dir, files: await tree(dir) });
  const rustFiles = [];
  for (const name of await readdir(path.join(rustRoot, 'bin'))) if (/\.(?:exe|dll)$/.test(name)) rustFiles.push(`bin/${name}`);
  for (const f of await tree(path.join(rustRoot, 'lib/rustlib', TARGET, 'lib'))) rustFiles.push(`lib/rustlib/${TARGET}/lib/${f.path}`);
  const rustLibraries = await records(rustRoot, rustFiles);
  return { node, cargo, rustc, rustRoot, cargoHome, env, logRoot,
    evidence: { node: process.version, tauri: tauriVersion.stdout.trim(), rustc: rustVersionResult.stdout.trim(), cargo: cargoVersion.stdout.trim(), rustTargetCfg: cfg.stdout.trim().split(/\r?\n/), target: TARGET, bootstrap, files, directories: directoryRecords, rustRoot, rustLibraries, environment: env, filteredOutNames: Object.keys(ambient).filter(n => !Object.keys(env).some(k => k.toLowerCase() === n.toLowerCase())).sort(), commands: [probe, rustVersionResult, cargoVersion, cfg, tauriVersion].map(v => v.record) } };
}
export async function verifyToolchain(evidence) {
  for (const file of evidence.files) { const s = await snapshot(file.path); if (s.sha256 !== file.sha256 || s.bytes.length !== file.bytes) throw Error(`Tool changed: ${file.path}`); }
  for (const dir of evidence.directories) if (digest(await tree(dir.path)) !== digest(dir.files)) throw Error(`MSVC/SDK input changed: ${dir.path}`);
  if (digest(await records(evidence.rustRoot, evidence.rustLibraries.map(f => f.path))) !== digest(evidence.rustLibraries)) throw Error('Rust toolchain input changed');
}
