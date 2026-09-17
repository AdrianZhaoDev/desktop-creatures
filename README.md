# 桌面生物 / Desktop Creatures

[简体中文（默认）](README.md) · [English](README.en.md)

Windows 透明桌面 3D 生物游戏的公开源码快照，基于 r21 全屏菜单版代码。人偶与青蛙会清洁桌面、捕虫、守护房屋；玩家可以使用工具、升级并保存本地进度。此快照只包含当前生产候选所需源码与运行素材，不包含历史角色、非商用 R19 模型、参考图或开发压缩包。

> **状态**：已提供 Windows 预览下载，但尚未通过完整原生人工验收，也不是 Steam 发行版。代码为 [MIT](LICENSE)；项目原创素材按 [CC BY 4.0](ASSETS-LICENSE.md) 发布，原已标 CC0 的素材继续按 CC0，第三方组件依各自许可。详情见 [许可说明](docs/licenses.md)。

## Windows 下载

在 [Releases 页面](https://github.com/AdrianZhaoDev/desktop-creatures/releases/tag/v1.1.0-preview.1) 下载 `Desktop-Creatures-v1.1.0-preview.1-Windows-x64.zip`，完整解压后双击 `desktop-creatures.exe`。需要 Windows 11 x64 与 WebView2 Runtime；此预览版未签名，可能出现 Windows SmartScreen 提示。按 `F12` 可紧急隐藏覆盖层。压缩包包含许可证和第三方组件声明。

## 实际画面

![桌面生物密集场景：虫群、垃圾、人偶、青蛙与房屋](docs/screenshots/gameplay-dense.gif)

GIF 使用公开版真实游戏渲染器与素材录制，展示 72 只虫、28 份垃圾、两名角色和两座房屋的密集演示状态；为便于展示，场景使用预置状态并加速回放，不代表默认开局。画面没有打开菜单，背景为中性演示底色。

## 构建并运行

需要 Windows 11 x64、Node.js 24、npm 11、Rust 1.98.1 MSVC、Visual Studio C++ x64 工具、Windows 11 SDK 26100 和 WebView2 Runtime。先在**完整克隆**中执行：

```powershell
npm ci
npm run check
npm run steam:candidate -- --output .steam-candidate-public
```

如需自行构建，原生受控构建需要本机已缓存的锁定 Rust 依赖，且输出目录必须尚不存在。具体参数和环境要求见 [原生候选说明](release/steam/NATIVE-CANDIDATE.md)：

```powershell
$candidate = (Resolve-Path .steam-candidate-public).Path
$nativeOutput = Join-Path (Get-Location) '.steam-native-public'
node release/steam/build-native-candidate.mjs --candidate $candidate --output $nativeOutput
& (Join-Path $nativeOutput 'content/desktop-creatures.exe') --steam-preview
```

若只想验证前端候选，可运行 `npm run steam:candidate -- --verify .steam-candidate-public`。候选会校验逐文件 SHA-256、依赖闭包和生成结果。Windows 覆盖层的鼠标穿透、焦点和托盘行为还需在实际桌面人工检查；紧急隐藏键为 `F12`。

## 源码结构与贡献

- `src/campaign/`：战役规则、渲染和中英 UI；`src-tauri/`：Windows 原生层。
- `assets/`：受控运行素材；`release/steam/`：固定清单和构建验证器。
- [贡献指南](CONTRIBUTING.md) · [许可证](LICENSE) · [英文 README](README.en.md)
