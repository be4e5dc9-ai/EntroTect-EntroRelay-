import { agentHarnesses, harnesses, type AgentHarness, type Harness, type Settings } from './types';

export const harnessNames: Record<Harness, string> = { deepseek: 'DeepSeek Harness', zcode: 'ZCode', kimi: 'Kimi Code', opencode: 'OpenCode', codex: 'Codex' };

export function isHarness(value: unknown): value is Harness { return harnesses.some(harness => harness === value); }
export function isAgentHarness(harness: Harness): harness is AgentHarness { return agentHarnesses.some(agent => agent === harness); }
export function supportsIsolatedLogin(harness: Harness): harness is 'kimi' | 'codex' { return harness === 'kimi' || harness === 'codex'; }

export function connectionFor(settings: Settings | undefined, harness: Harness) {
  return isAgentHarness(harness) ? settings?.agents?.[harness] : settings?.[harness];
}

export function defaultModel(settings: Settings | undefined, harness: Harness) {
  return connectionFor(settings, harness)?.model || (harness === 'deepseek' ? 'deepseek-flash' : harness === 'zcode' ? 'glm-5.3' : `${harness}:default`);
}

export function nativeModel(model: string | undefined) {
  if (!model || agentHarnesses.some(harness => model === `${harness}:default`)) return undefined;
  return catalogModel(model)?.id ?? model;
}

export function modelHarness(settings: Settings | undefined, model: string) {
  return catalogModel(model)?.harness ?? harnesses.find(harness => defaultModel(settings, harness) === model);
}

export const catalogModelId = (harness: AgentHarness, id: string) => `${harness}:model:${id}`;

export function catalogModel(value: string) {
  for (const harness of agentHarnesses) {
    const prefix = catalogModelId(harness, '');
    if (value.startsWith(prefix) && value.length > prefix.length) return { harness, id: value.slice(prefix.length) };
  }
}
