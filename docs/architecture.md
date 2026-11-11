# Tauri 2 architecture

React UI → typed Tauri invoke → Rust process supervisor → anonymous stdio pipes →
Node harness service → native DeepSeek SDK / ZCode agent-server or standalone CLI.

Rust owns the WebView2 window, lifecycle, native file dialogs, local path opening,
Windows DPAPI and backend startup. The TypeScript service owns persistent
conversation IDs, run locks, journals, context conversion and native bindings.
Its JSON protocol permits asynchronous UI events, request/reply correlation and
private DPAPI callbacks. No HTTP daemon is exposed for application control.

The user-data directory remains %APPDATA%/EntroTectNative. Native account settings
stay in vendor homes, while sessions are isolated per application conversation.
New credentials use credentials.v2.json, encrypted by Windows DPAPI in Rust.
Legacy Electron credentials are retained and require re-entry because the previous
Chromium encryption envelope is not the same format.

Model ID and harnessMode persist on each conversation. Model selection resets
routing to the configured preferred harness; manual override preserves the model.
The model ID is applied to the actual native request and ZCode model selection.
Unsupported server/model/protocol combinations fail through native validation.

Imports run only while native execution is stopped. EntroTect reads the DeepSeek
message surface and ZCode compaction boundaries directly. Its native writers
preserve the main conversation archive separately from effective resume context.
Existing `.hbridge.json` checkpoints remain readable. The target regenerates environmental scaffolding. Manual copies preserve
the source; automatic updates use recorded fingerprints and conflict branches.
Failed harness conversions leave the source harness selected.

The distribution contains a Tauri executable, backend/worker.cjs and runtimes/.
Bundled paths are stored symbolically. Cargo target paths are discovered via cargo
metadata. Original Electron build artifacts under release/ are historical only;
0.2+ builds and dependencies contain no Electron.

HistoryService discovers native histories independently from the application index.
DSH discovery reads only the header frame and title cache; full import decodes all
concatenated Zstandard frames. Same-harness copies retain original events, sequence
numbers, compaction boundaries and metadata. New IDs also rebind native delivery
checkpoints. Exported DSH logs use a separate compressed header frame and register
a desktop session in the v2 workspace index with a v7 projection title cache.
Index updates use an application lock, change detection, atomic rename and backup.
Atomic JSON replacement retries short Windows sharing violations with bounded
backoff; vendor index preconditions are re-read on every retry. The existing file
is never deleted to work around a lock.

ZCode copies session/message/part/session_entry rows from a consistent read
transaction, remaps native IDs and references, and inserts them in one destination
transaction. SQLite's online backup includes committed WAL contents. Source-only
columns missing from the destination cause a compatibility error instead of silent
data loss. Native account configuration stays outside the copied data.

Manual imports that create a copy are staged and cold-restored before the conversation index is
published. Automatic imports read histories offline, including missing-project
records, and use fresh native bindings when refreshing an existing application
conversation. Canonical context is produced from the copied
native history, so it corresponds to the imported snapshot. Exports acquire the
conversation operation lock and stage any conversion before changing vendor stores.
Converted sessions receive fresh native IDs. Codex imports from its active profile
can retain the original thread ID, and manual continuation can reuse that thread
when the target already contains the current revision.

HistorySync runs after startup, at stopped turn boundaries, on a 15-second timer,
and on graceful shutdown. Both directions default to enabled. The durable link
index records native identity, last synchronized application revision and native
fingerprint. Own mirrors are recognized by provenance in a DSH sidecar or a ZCode
session_entry committed with the copied rows. Conflicting local/remote advances
fork instead of discarding either transcript. User actions wait for an active
sync operation on that conversation rather than failing with a busy error.

An external native desktop process can retain decoded histories while idle.
Automatic write-back defers while that client is running, rechecking immediately
before commit; the current worker's descendants are excluded. Unchanged record
fingerprints are checked again at atomic file replacement / SQLite transaction.
Automatic backups cover only the affected record and retain five versions per
mapping, under the application profile. Native account configuration is unchanged.
Automatic synchronization does not resume an agent: it copies persisted state,
initializing an empty ZCode schema without model credentials when needed. This
also keeps user plugins and retained goals from being started merely by syncing.
Mirrors owned by another application data profile are imported but are not
re-exported until the user continues them locally, preventing cross-profile echo
loops. Unpublished export staging directories are removed within a verified
application-data boundary; published conversation directories are retained.

Reasoning choices are declared separately from model execution. The UI lists only
documented distinct tiers, and the backend validates selections. DeepSeek SDK
initialize and ZCode native model-selection options apply the choice. See
reasoning-capabilities.md for primary sources, protocol maps and validation.
