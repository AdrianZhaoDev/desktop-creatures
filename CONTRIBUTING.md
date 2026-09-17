# 参与贡献 / Contributing

欢迎提交可复现的问题和聚焦的代码补丁。请附 Windows 版本、复现步骤和检查结果；不要上传个人桌面截图、真实存档、账号信息或未经许可的素材。代码提交前运行 `npm run steam:candidate:test` 与 `cargo test --manifest-path src-tauri/Cargo.toml`，涉及覆盖层交互时再做 Windows 人工验证。

Reproducible issues and focused patches are welcome. Include the Windows version, steps, and verification results. Do not upload private desktop captures, real saves, account information, or unlicensed assets. Before sending code, run `npm run steam:candidate:test` and `cargo test --manifest-path src-tauri/Cargo.toml`; manually verify native overlay behavior when it changes.
