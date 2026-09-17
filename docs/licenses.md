# Software and asset licenses

Desktop Creatures application code is MIT licensed; see [`LICENSE`](../LICENSE).

This MIT grant applies to application code, not automatically to every asset,
reference image, screenshot or third-party source included in the working tree.
The curated public snapshot grants CC BY 4.0 for project-created original
assets listed in [`ASSETS-LICENSE.md`](../ASSETS-LICENSE.md); existing CC0
dedications remain in effect. The full development working tree is broader than
that snapshot and must not be uploaded as-is. Its R19 cleaner runtime is marked
**noncommercial validation only** and is excluded from the curated snapshot.
Historical Sadako/Kunkun-themed assets and user reference images are excluded
as well; their presence in the development tree does not grant public rights.

| Component | Version | License/source |
| --- | --- | --- |
| Tauri | 2.11.5 | Apache-2.0 / MIT |
| tauri-plugin-global-shortcut | 2.3.2 | Apache-2.0 / MIT |
| Three.js | 0.186.0 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| Vite | 8.2.2 | MIT |
| Vitest | 5.0.0 | MIT |
| Roach asset package | revision 2 | Original project work, CC0-1.0; see package `license.txt` |
| Emerald beetle asset package | revision 1 | Original project work, CC0-1.0; see package `license.txt` |

Rust transitive dependencies are locked by `src-tauri/Cargo.lock`; npm dependencies are locked by `package-lock.json`. No remote artwork, telemetry SDK, desktop capture library or advertising dependency is included.
