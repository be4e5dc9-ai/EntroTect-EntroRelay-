# Third-party notices

EntroTect uses Tauri 2 (MIT OR Apache-2.0), React, Vite and their dependencies
under their respective licenses. Windows displays the UI through Microsoft
WebView2; Electron and Chromium are not bundled by this application.

License and notice files from JavaScript dependencies and cached Rust crates are
included in the distribution's `licenses/` directory. Native runtimes retain their
own license and notice files under `runtimes/`.

## Native harnesses

DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness (MIT).
ZCode: https://github.com/zai-org/ZCode (Apache-2.0).
Kimi Code: https://github.com/MoonshotAI/kimi-code (MIT).
OpenCode: https://github.com/anomalyco/opencode (MIT).
Codex CLI: https://github.com/openai/codex (Apache-2.0).
The runtime packages and their license and notice files are under `runtimes/`.

## Node.js

Node.js v24.18.0 is bundled as the standalone harness runtime. Its license and
third-party notices are included in `runtimes/node/LICENSE`.

## Product identification icons

DeepSeek and Z.ai model marks are copied unchanged from their official website
favicon resources. DeepSeek Harness, ZCode, Kimi Code and OpenCode icons are copied
from their official source repositories at pinned commits. The Codex icon comes
from its official Windows package. These marks identify the
corresponding third-party products; ownership remains with their respective
owners. Original source URLs and SHA-256 values are recorded in
`licenses/brands/sources.json` in the distribution.
