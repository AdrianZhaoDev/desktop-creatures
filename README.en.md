# Desktop Creatures / 桌面生物

[简体中文 (default)](README.md) · [English](README.en.md)

A public source snapshot of the Windows transparent 3D desktop game, based on the r21 full-screen-menu code. A cleaner and a frog clear litter, catch insects, and defend their homes while the player uses tools, upgrades, and local saves. This snapshot contains only current production candidate source and runtime assets. Historical characters, the noncommercial R19 model, reference art, and development archives are excluded.

> **Status:** local playtest source, not a Steam release or a fully accepted native build. Code is [MIT licensed](LICENSE). Project-created original assets are [CC BY 4.0](ASSETS-LICENSE.md), existing CC0 assets remain CC0, and third-party components keep their own licenses. See the [license notes](docs/licenses.md).

## Screenshots

| r21 full-screen menu | 200% scaling |
| --- | --- |
| ![r21 desktop menu](docs/screenshots/r21-menu-desktop.png) | ![r21 menu at 200% scale](docs/screenshots/r21-menu-200-percent.png) |

![r21 menu in a narrow viewport](docs/screenshots/r21-menu-narrow.png)

These are r21 browser menu verification captures. The public snapshot replaces the R19 runtime character with the original S06 model, so the images show only the unchanged menu, not the current character appearance.

## Build and run

Requirements: Windows 11 x64, Node.js 24, npm 11, Rust 1.98.1 MSVC, Visual Studio C++ x64 tools, Windows 11 SDK 26100, and WebView2 Runtime. In a **complete clone**:

```powershell
npm ci
npm run check
npm run steam:candidate -- --output .steam-candidate-public
```

The controlled native build needs cached locked Rust dependencies and a new output path. See the [native candidate guide](release/steam/NATIVE-CANDIDATE.md) for requirements and parameters:

```powershell
$candidate = (Resolve-Path .steam-candidate-public).Path
$nativeOutput = Join-Path (Get-Location) '.steam-native-public'
node release/steam/build-native-candidate.mjs --candidate $candidate --output $nativeOutput
& (Join-Path $nativeOutput 'content/desktop-creatures.exe') --steam-preview
```

To verify only the frontend candidate, run `npm run steam:candidate -- --verify .steam-candidate-public`. The candidate process checks per-file SHA-256 hashes, dependency closure, and generated output. Windows click-through, focus, and tray behavior still need manual desktop verification. `F12` is the emergency-hide shortcut.

## Source and contributions

- `src/campaign/`: campaign rules, rendering, and bilingual UI; `src-tauri/`: native Windows layer.
- `assets/`: controlled runtime assets; `release/steam/`: fixed inventory and build verification.
- [Contributing](CONTRIBUTING.md) · [License](LICENSE) · [中文 README](README.md)
