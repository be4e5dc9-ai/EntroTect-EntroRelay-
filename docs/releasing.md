# Windows 发布

发布版本号需要在 package.json、src-tauri/Cargo.toml 和 src-tauri/tauri.conf.json 中保持一致。Beta 使用 0.8.0-beta.1 这样的 SemVer 版本，Git 标签增加 v 前缀。

## 签名配置

在工作区之外保存长期 Tauri 更新签名私钥，并保留离线备份。GitHub Actions 使用以下配置。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | ENTROTECT_UPDATER_PUBLIC_KEY | Tauri 公钥文件内容 |
| Secret | TAURI_SIGNING_PRIVATE_KEY | Tauri 私钥文件内容 |
| Secret | TAURI_SIGNING_PRIVATE_KEY_PASSWORD | 设置私钥口令时填写 |

签名身份需在后续版本中保持一致。应用内更新会校验签名、下载仓库和版本号。

## 发布步骤

1. 更新版本号与 CHANGELOG.md，完成构建和回归测试。
2. 推送源代码及对应版本标签。
3. 在该标签上手动运行 Windows release 工作流，或在本机配置以下环境变量后运行 pnpm desktop:installer --release。

本机环境变量为 ENTROTECT_RELEASE_REPOSITORY、ENTROTECT_UPDATER_PUBLIC_KEY、TAURI_SIGNING_PRIVATE_KEY，以及需要时的 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。仓库值为 be4e5dc9-ai/EntroTect-EntroRelay-。

工作流使用手动触发，发布前检查版本标签，生成安装包、更新签名、便携 ZIP 和 SHA-256 校验文件。已有公开版本会停止重复发布。

Beta 发布设置 prerelease 标记，并把对应 latest.json 写入主分支 updates/beta.json。客户端从该地址获取 Beta 更新。稳定版使用 GitHub 最新正式 Release 中的 latest.json。

发布顺序为创建草稿、上传全部产物、公开 Release、更新 Beta 清单。用户获取到的更新清单将指向已经公开的安装包。

Tauri 更新签名与 Windows Authenticode 发布者证书是两套机制。当前构建配置包含前者。
