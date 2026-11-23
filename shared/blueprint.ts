import { projectKey } from './project-path';
import type { BlueprintScope, NativeHistorySource } from './types';

export const harnessScope = (source: NativeHistorySource): BlueprintScope => ({source,workspace:'',wholeHarness:true});

export function blueprintScopeKey(scope: BlueprintScope) {
  if (scope.wholeHarness) return JSON.stringify(['harness',scope.source.harness]);
  const source = scope.source.harness + ':' + projectKey(scope.source.location);
  return JSON.stringify([source,scope.sessionId ? ['chat',scope.sessionId] : ['project',projectKey(scope.workspace)]]);
}

// Nearest rule first. A disabled rule overrides all wider rules.
export function blueprintParents(scope: BlueprintScope): BlueprintScope[] {
  if (scope.wholeHarness) return [];
  const harness = harnessScope(scope.source);
  return scope.sessionId && scope.workspace ? [{source:scope.source,workspace:scope.workspace},harness] : [harness];
}
