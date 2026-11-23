# Changelog

[简体中文](CHANGELOG.md) · English

## 0.8.1-beta.1

- Added the EntroRelay sync blueprint. Connect an entire Harness, a project, or a chat to the EntroTect workspace or a standalone Harness. Project and chat rules can override inherited connections.
- Move sender nodes and open each node's own source card to its right. Keep multiple cards open and browse, search, or review origins in each one independently.
- First launch offers an import entry point. Background sync follows enabled connections. Sync copies are identified by native session IDs, and older chats with uncertain origins can be reviewed by chat, project, or Harness.
- Continue a linked chat from either endpoint. If both endpoints add new turns, compare the branches and choose which to keep. Repeated saves to the same standalone Codex profile reuse the destination thread.
- Codex and Kimi Code can reuse standalone sign-in while keeping workspace chat history in separate runtime directories. A connection can publish those chats to the standalone client.

## 0.8.0-beta.2

- Added an English interface for EntroTect and its EntroRelay workflows. Choose Follow system, Simplified Chinese, or English in Settings and connections → General → Interface language. The change takes effect when you save.
- Localized the workspace, project sidebar, history sync, usage, connection settings, updates, and app messages. Existing chat content, native Harness output, and resume context retain their original language.
- Added a full English README, an English changelog, and bilingual Beta release notes.

## 0.8.0-beta.1

- First public Windows x64 beta of EntroTect and EntroRelay under Apache-2.0. The installer and portable ZIP include DeepSeek Harness, ZCode, Kimi Code, OpenCode, and Codex CLI.
- Switch Harnesses between turns with EntroRelay. Keep full chat archives alongside compacted resume context, and choose sync targets per project or chat.
- Browse project files, Git diffs, and web pages in the sidebar. Open referenced files at their line numbers.
- Reuse warm Harness processes and pause tasks through native cancellation. Reduce project list renders during streaming and skip history scans when there are no selected sync targets.
- The Windows installer supports signed updates from the GitHub Beta channel.
