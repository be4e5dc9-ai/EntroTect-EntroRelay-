import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { harnesses, type Conversation, type HistoryExportRules, type HistoryExportScope, type HistoryImportRule, type NativeHistorySource } from '../shared/types';
import { isHarness } from '../shared/harnesses';
import { projectKey } from '../shared/project-path';
import { atomicJson } from './store';

type ImportSelection = HistoryImportRule & { enabled: boolean };
type Selection = { imports: ImportSelection[]; exports: Record<string, HistoryExportRules> };

export const historySourceKey = (source: NativeHistorySource) => `${source.harness}:${projectKey(path.resolve(source.location))}`;
const projectScope = (workspace: string) => `project:${projectKey(path.resolve(workspace))}`;
const exportKey = (scope: HistoryExportScope) => scope.kind === 'project' ? projectScope(scope.workspace) : `conversation:${scope.id}`;
const importKey = (rule: HistoryImportRule) => JSON.stringify([historySourceKey(rule.source), 'sessionId' in rule ? ['session', rule.sessionId] : ['project', projectScope(rule.workspace)]]);

export class HistorySelection {
  private state: Selection = { imports: [], exports: {} };
  private write: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(root: string) { this.file = path.join(root, 'history-selection.json'); }

  async init() {
    this.state = await readFile(this.file, 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return this.state;
    });
  }

  private save(update: (state: Selection) => Selection) {
    const task = this.write.catch(() => {}).then(async () => {
      const next = update(this.state);
      await atomicJson(this.file, next);
      this.state = next;
    });
    this.write = task;
    return task;
  }

  importSources() { return this.state.imports.filter(rule => rule.enabled).map(rule => rule.source); }

  importRules(source: NativeHistorySource, sessionId: string, workspace: string) {
    const rules = this.state.imports.filter(rule => historySourceKey(rule.source) === historySourceKey(source));
    return {
      session: rules.find(rule => 'sessionId' in rule && rule.sessionId === sessionId)?.enabled,
      project: workspace && path.isAbsolute(workspace) ? rules.find(rule => 'workspace' in rule && projectScope(rule.workspace) === projectScope(workspace))?.enabled : undefined,
    };
  }

  setImport(rule: HistoryImportRule) {
    if (!isHarness(rule?.source?.harness) || typeof rule.source.location !== 'string' || !path.isAbsolute(rule.source.location) ||
      !(rule.enabled === null || typeof rule.enabled === 'boolean') || ('sessionId' in rule ? typeof rule.sessionId !== 'string' || !rule.sessionId : typeof rule.workspace !== 'string' || !path.isAbsolute(rule.workspace))) {
      throw new Error('原生历史同步范围无效');
    }
    const entry = { ...rule, source: { ...rule.source, location: path.resolve(rule.source.location) } };
    return this.save(state => {
      const imports = state.imports.filter(old => importKey(old) !== importKey(entry));
      if (entry.enabled !== null) imports.push({ ...entry, enabled: entry.enabled });
      return { ...state, imports };
    });
  }

  exportRules(scope: HistoryExportScope) { return this.state.exports[exportKey(scope)] ?? {}; }

  exportAllowed(c: Conversation, harness: NativeHistorySource['harness'], fallback: boolean) {
    return this.exportRules({ kind: 'conversation', id: c.id })[harness] ?? this.exportRules({ kind: 'project', workspace: c.workspace })[harness] ?? fallback;
  }

  setExport(scope: HistoryExportScope, rules: HistoryExportRules) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).some(harness => !isHarness(harness)) || Object.values(rules).some(value => typeof value !== 'boolean')) throw new Error('目标 Harness 同步设置无效');
    const selected = Object.fromEntries(harnesses.flatMap(harness => rules[harness] === undefined ? [] : [[harness, rules[harness]]]));
    return this.save(state => {
      const exports = { ...state.exports, [exportKey(scope)]: selected };
      if (!Object.keys(selected).length) delete exports[exportKey(scope)];
      return { ...state, exports };
    });
  }
}
