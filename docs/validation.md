# Tauri 2 verification · 2026-11-06

- Rust 1.98 / MSVC 14.44 / SDK 10.0.26100 compiled, linked and executed a native Windows binary.
- Tauri 2 release build succeeded with WebView2 156.0.4314.58.
- Rust unit test: Windows DPAPI protect/unprotect round trip.
- Native integration: file write, read, PowerShell execution, in-flight tool pause and two-way context restoration.
- Real Tauri UI integration: selected GLM automatically switches to ZCode; manual ZCode retains the DeepSeek model ID in the actual model request; returning to automatic routing restores DeepSeek Harness.
- Desktop integration: immutable workspace, encrypted key storage, no keys in context, temporary provider cleanup, pause in both harnesses, startup cancellation, app restart and native continuation.
- Packaged Tauri EXE: both desktop tests passed using the bundled runtimes. Main EXE is 8,748,544 bytes; complete ZIP is approximately 297 MiB. EXE and backend match build outputs, ZIP CRC passes, and SHA-256 is recorded in release/SHA256SUMS-0.2.0.txt.
- Light interface and connection dialog screenshots visually inspected; native and API credential controls verified in the real Tauri WebView.

The 0.2 regression model responses use a local Messages / Chat Completions SSE fixture. Harnesses,
tools, context conversion and Tauri UI are real. Actual remote account authentication,
OAuth refresh and model quality were not verified for those releases.

That release used DSH 0.2.2-rc.1, ZCode CLI 0.17.1 from desktop 3.17.2,
harness-bridge 0.3.3 and standalone Node 24.18.0.

## 0.2.1 project sidebar

- Replaced the former status dashboard with a lazy file tree and real Git changes.
- Tested UTF-8 content, binary files, bounded large-file previews, staged/worktree diffs, Unicode renames, deletions, untracked and empty files.
- Verified workspace path boundaries and rejection of junctions pointing outside the project.
- Real Tauri UI tests open files and both diff sections, refresh externally created files and retain model routing controls.
- Context export and diagnostic logs are accessed through the conversation menu.
- Explicit data profiles use independent single-instance locks; the currently running default-profile application is preserved during tests.
- 0.2.1 packaged EXE passed all three desktop suites (conversation lifecycle, connection controls, project sidebar). Workspace service tests and ZIP CRC passed; packaged EXE and worker match current build outputs. Checksum is recorded in release/SHA256SUMS-0.2.1.txt.

## 0.2.2 window controls and official icons

- Native maximize/restore changes both the actual window size and the single/double-frame button glyph.
- Left and right sidebar controls expose distinct arrow directions and round-trip open/closed state.
- The redundant fixed runtime-ready sentence was removed.
- Official model/harness assets load successfully inside Tauri, including DeepSeek ICO and embedded SVG resources.
- Source URLs and original SHA-256 values are retained in the distributed brand notice file.
- The packaged 0.2.2 EXE passed all four desktop suites, including real maximize/restore, both sidebar directions and image loading. Packaged files match build outputs and the ZIP CRC passes. SHA-256 is recorded in release/SHA256SUMS-0.2.2.txt.

## 0.3.0 native history and file content

- Imported an existing user DSH session offline: 242 display items, including six
  user messages, 32 assistant messages and 117 tool entries. Cold restore succeeded;
  the import sends no model request. The source remains a separate native record.
- DeepSeek export creates different native IDs on each invocation and retains
  existing desktop project membership. Source transcript hashes remain unchanged
  after importing and continuing the application copy.
- The separately installed `D:\dsh\DeepSeek Harness.exe` (0.2.2-rc.1) restored an
  exported session using its own official SDK profile, including the Unicode path.
- Native history tests cover same-harness DSH/ZCode import/export, independent
  ZCode CLI continuation, cross-harness export and continuation, and backups.
- An additional live test reused the local `deepseek-account` login, obtained the
  requested marker from the real model, exported that newly created test session
  into the user's native `.dsh` home, and used the independently installed DSH CLI
  to answer the marker from the previous turn. Both real remote requests succeeded.
  Report: `.local/live-history-1793978342520/report.json`. This does not establish
  ZCode remote authentication or OAuth refresh behavior.
- Desktop tests exercise export and import dialogs, native-history selection,
  continued conversation and application restart, plus inline right-sidebar file
  content, expand/return controls, staged/worktree diffs and existing window controls.
- A real Windows file handle held without FILE_SHARE_DELETE reproduces the EPERM
  rename failure. The bounded retry completes after release, and a concurrent
  vendor update during the retry is detected and retained. Temporary files are
  cleaned; the old index is never unlinked.
- Native provider selection export, unsupported vendor registry rejection,
  missing-workspace rejection, and retention of unrelated project metadata and
  backup contents are covered by the native-history tests.
- The 0.3.0 packaged EXE passed all five desktop suites after the Windows sharing
  violation fix. ZIP executable, backend and README contents match the staging
  directory; staging EXE/backend match the build. ZIP CRC and SHA-256 checks pass;
  checksum is recorded in `release/SHA256SUMS-0.3.0.txt` (approximately 297 MiB).

## 0.4.0 automatic sync and reasoning · 2026-11-07

- Default-on discovery/import and stopped-turn export preserve one native ID per
  mapping. Own mirrors do not reimport as duplicate chats. Native continuation
  updates the original application conversation, including after restart.
- Concurrent local and native changes preserve separate branches. Turning both
  automatic options off leaves existing native data unchanged. Manual import and
  export remain available in settings with both automatic options disabled.
- Missing-project history imports offline without model requests. Reassigning a
  valid directory creates a cold-restorable native binding and retains the transcript.
- Native-client cache protection defers write-back, and guarded fingerprints stop
  updates to records changed after the last synchronization.
- Model menus expose distinct documented tiers, hide unverified IDs, reject GLM-5.3
  off in the backend, retain model/harness preferences and persist across restart.
- Actual native harness requests emit the selected low/max effort and DeepSeek
  thinking disabled. ZCode's native CLI honors the choice on its first turn.
- A separate real DeepSeek-account request succeeded with low effort; its native
  request header recorded the chosen level. Report:
  `.local/live-reasoning-1793984194725/report.json`.
- All six source-build desktop suites passed, including automatic discovery,
  native update without repeated copies, default settings, manual settings entries,
  unsupported-model menus and saved choices after restart. Model endpoints in the
  automated suites are local fixtures; native harnesses and Tauri EXEs are real.
- Automatic imports/exports also succeed with no application model credentials and
  send no model requests. Two data profiles sharing the same native stores do not
  repeatedly re-export each other's unchanged mirrors.
- Paused turns and a subsequent resumed turn update the same DSH and ZCode native
  IDs. Unpublished export staging folders do not accumulate. History-only options
  can be switched off during inference while connection changes remain guarded.
- The packaged 0.4.0 EXE passed all six desktop suites. The automatic-sync and
  manual-history suites were rerun against the packaged worker after the storage
  refinements. ZIP contents match staging, EXE/worker match build outputs, and
  checksums are recorded in `release/SHA256SUMS-0.4.0.txt`.
- Native-login model selection retains the canonical spelling from native
  defaults (for example `GLM-5.3`) when the app uses an equivalent lowercase ID;
  the native CLI first-turn low-effort test covers this configuration.
