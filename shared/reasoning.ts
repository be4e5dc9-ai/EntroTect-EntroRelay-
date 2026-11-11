import type { Conversation, Harness, ModelReasoning, Settings } from './types';
import { connectionFor, defaultModel, isAgentHarness } from './harnesses';

export const reasoningKey = (model: string, harness: Harness) => `${harness}:${model.toLowerCase()}`;

// Only real, distinct tiers are declared. API aliases such as DeepSeek medium /
// xhigh are deliberately absent. Unknown models inherit their harness settings.
export function modelReasoning(modelId: string, harness: Harness): ModelReasoning {
  if (isAgentHarness(harness)) return { modelId, harness, levels: [] };
  const id = modelId.toLowerCase(); let levels: string[] = [], sourceUrl: string | undefined;
  if (['deepseek-flash','deepseek-v4.1-flash','deepseek-v4-flash','deepseek-v4-flash-0731','deepseek-v4-pro','deepseek-v4-pro-0813'].includes(id)) {
    levels = ['off','low','high','max']; sourceUrl = 'https://api-docs.deepseek.com/guides/thinking_mode/';
  } else if (['glm-5.3','glm-5.3-flash','glm-5.3-flashx'].includes(id)) {
    levels = ['low','high','max']; sourceUrl = 'https://github.com/zai-org/ZCode/blob/main/config/provider/zcode-builtin.json';
  } else if (id === 'glm-5.2') {
    levels = ['off','high','max']; sourceUrl = 'https://github.com/zai-org/ZCode/blob/main/config/provider/zcode-builtin.json';
  } else if (harness === 'zcode' && ['glm-5','glm-5.1','glm-5.1-highspeed','glm-5-turbo','glm-4.7','glm-4.7-flash','glm-4.7-flashx'].includes(id)) {
    levels = ['off','enabled']; sourceUrl = 'https://github.com/zai-org/ZCode/blob/main/config/provider/zcode-builtin.json';
  }
  return { modelId, harness, levels: levels.map(level => ({ id:level, label:level, nativeValue:level==='off' && harness==='zcode'?'disabled':level })), ...(levels.length ? {defaultLevel:levels.includes('high')?'high':'enabled',sourceUrl,verifiedAt:'2026-11-07'} : {}) };
}
export function reasoningCatalog(settings: Settings) {
  const ids = [...new Set([settings.deepseek.model || 'deepseek-flash', settings.zcode.model || 'glm-5.3'])];
  return ids.flatMap(id => (['deepseek','zcode'] as const).map(h => modelReasoning(id,h)));
}
export function zcodeReasoningRules(model: string, providerId: string) {
  const declaration=modelReasoning(model,'zcode'); if(!declaration.levels.length)return [];
  const toggleOnly=declaration.levels.some(l=>l.id==='enabled');
  const map=toggleOnly?'{"thinking":{"type":reasoningLevel == "disabled" ? "disabled" : "enabled"}}':
    'reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"}} : {"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}';
  return [{providerId,modelId:model,config:{optionSpecs:{reasoningLevel:{values:declaration.levels.map(l=>l.nativeValue),map}}}}];
}
export function effectiveReasoning(c: Conversation, settings: Settings): string | undefined {
  const model = c.modelId || defaultModel(settings, c.harness);
  const catalog = modelReasoning(model,c.harness), saved = c.reasoningByModel?.[reasoningKey(model,c.harness)];
  const configured = connectionFor(settings, c.harness)?.reasoning;
  const chosen = saved || (catalog.levels.find(l=>l.id===configured || l.nativeValue===configured)?.id);
  return catalog.levels.find(level=>level.id===chosen)?.nativeValue;
}
