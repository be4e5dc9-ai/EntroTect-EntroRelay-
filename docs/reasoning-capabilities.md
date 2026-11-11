# Model reasoning declarations · 2026-11-07

The application exposes distinct model capabilities, then delegates execution to
the existing harness. It does not implement another agent loop or route requests
through a separate model proxy.

## Primary sources

- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/):
  thinking on/off and low/high/max. Several other accepted strings map to those
  same values and are not independent tiers.
- [ZCode provider/model configuration](https://github.com/zai-org/ZCode/blob/main/config/provider/zcode-builtin.json):
  GLM-5.3 is declared low/high/max; GLM-5.2 has disabled/high/max; several earlier
  GLM models expose enabled/disabled. API-specific maps live alongside the values.
- [Z.ai thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode):
  GLM-5.3 and GLM-5.3-Flash require thinking; a disable option would be misleading.
- [CC Switch transform](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/transform.rs)
  and [routing guide](https://github.com/farion1231/cc-switch/blob/main/docs/guides/codex-deepseek-routing-guide-en.md):
  upstream reasoning support and request dialect must be considered. A common
  effort string does not establish that every upstream has the same tier.

No CC Switch code is incorporated. The reference informs the separation between
capability declarations and provider-specific wire settings. Primary source model
declarations are recorded in `shared/reasoning.ts`, with their verification date.
Unknown IDs inherit harness defaults instead of receiving guessed menu entries.

## Native execution

- DeepSeek uses the SDK `initialize.reasoningEffort`. The native SDK validates it,
  selects the model route on both fresh and resumed sessions, and produces Messages
  `thinking` / `output_config.effort` parameters. The off value is `off`.
- ZCode uses `modelSelection.options.reasoningLevel` through `session/setModel`
  or its persisted native model selection. Off maps to the native `disabled` value.
  The native-login CLI receives a persisted empty root session and the chosen
  model selection before its first prompt; it owns authentication and execution.
- API mode declares the known model's values and mapping in ZCode's supported
  personal provider configuration. This avoids forwarding effort when thinking is
  disabled and avoids inventing strength tiers for a toggle-only model. ZCode
  performs the actual request serialization.
- Preferences are keyed by harness and model. The backend rejects unlisted levels
  even if an IPC client bypasses the menu. Invalid defaults from an older model's
  configuration are not forwarded as a choice for a different model.

These declarations describe the documented models and native interfaces. A third
party's compatible endpoint can expose fewer controls; model naming alone cannot
guarantee an upstream proxy implements every parameter correctly.

## Verification

Native integration tests capture actual requests emitted by both pinned harnesses
against a local Messages / Chat Completions server, covering low/max, DeepSeek off,
GLM rejection of off, model switching and native CLI first-turn selection.
Desktop tests verify exact menu options, the absent menu for unknown IDs and
selection persistence after restart. A separate live DeepSeek-account request
succeeded at low effort and recorded `reasoningEffort: low` in its native request
header (`.local/live-reasoning-1793984194725/report.json`). Remote model quality and
token/latency differences between tiers were not benchmarked.
