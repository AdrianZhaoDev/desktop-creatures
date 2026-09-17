# Windows 原生候选 / Windows native candidate

此仓库的源码候选使用明确的文件清单。原生工具从前端候选和固定 Rust 源码编译 EXE，并复核嵌入内容。它输出本地测试包，`releaseReady` 仍为 `false`；Windows 交互需人工验收。

在装好 README 所列工具链和 `npm ci` 后，于 PowerShell 运行：

```powershell
npm run check
npm run steam:candidate -- --output .steam-candidate-public
$candidate = (Resolve-Path .steam-candidate-public).Path
$nativeOutput = Join-Path (Get-Location) '.steam-native-public'
node release/steam/build-native-candidate.mjs --candidate $candidate --output $nativeOutput
& (Join-Path $nativeOutput 'content/desktop-creatures.exe') --steam-preview
```

候选目录与原生输出目录必须事先不存在；构建失败后改用新名称。原生工具使用固定 Windows x64 MSVC 目标、锁定依赖与离线 Cargo 缓存。它也需要 PowerShell 7、Visual Studio C++ x64 工具和 Windows 11 SDK 26100。`F12` 可紧急隐藏覆盖层。

This source candidate uses an explicit file inventory. The native tool builds an EXE from the frontend candidate and pinned Rust sources, then verifies the embedded content. Its output is a local test build with `releaseReady: false`; native interaction still requires manual Windows checks. The commands above require a new candidate and native output path, a populated offline Cargo cache, PowerShell 7, MSVC x64 tools, and Windows 11 SDK 26100. Use `F12` to hide the overlay immediately.
