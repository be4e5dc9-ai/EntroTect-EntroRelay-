import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Conversation, Harness, Settings } from '../shared/types';
import { isAgentHarness, nativeModel } from '../shared/harnesses';
import { Store } from './store';
import { effectiveReasoning } from '../shared/reasoning';
import { nativeSqlite } from './native-sqlite';
import { bundledContext, contextSuffix, messagesToBridge } from './portable-history';
import { readDeepSeekContext, writeDeepSeekContext } from './dsh-context';
import { readZCodeContext, zcodeContextMessages } from './zcode-context';
import type { Agents } from './agents';
import type { AgentClient } from './agent-client';
import type { KimiCheckpoint } from './kimi-history';

export class ContextCodec {
  constructor(private store: Store, private settings: () => Settings, private node = process.execPath, private agents?: Agents) {}
  nativeRoot(c: Conversation) { return path.join(this.store.directory(c.id), 'native'); }
  private deepSeekHome(c: Conversation) { return path.join(this.nativeRoot(c), 'deepseek'); }
  database(c: Conversation) { return path.join(this.nativeRoot(c), 'zcode', 'db.sqlite'); }

  async snapshot(c: Conversation, publish = true, resident?: AgentClient, checkpoint?: KimiCheckpoint, usageCursor?: number | string) {
    const binding = c.bindings[c.harness];
    if (!binding) throw new Error('尚未创建原生会话');
    const dir = path.join(this.store.directory(c.id), 'context');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `revision-${c.revision}-${randomUUID()}${contextSuffix}`);
    if (isAgentHarness(c.harness)) {
      if (!this.agents) throw new Error('原生执行器尚未配置');
      const { bundle, reports, checkpoint: saved } = await this.agents.snapshot(c, c.harness, binding, resident, checkpoint, usageCursor);
      await writeFile(file, JSON.stringify(bundle), { flag: 'wx' });
      if (reports.length) await this.store.append(c.id, 'native', { kind: 'model-usage', harness: c.harness, runSessionId: binding.sessionId, reports });
      binding.nativeCheckpoint = saved;
    } else {
      const native = c.harness === 'deepseek'
        ? await readDeepSeekContext(this.deepSeekHome(c), c.workspace, binding.sessionId, c.createdAt)
        : await readZCodeContext(this.node, this.database(c), binding.sessionId);
      const bundle = messagesToBridge(native.history, {
        id: binding.sessionId, title: c.title, cwd: c.workspace, createdAt: c.createdAt, updatedAt: c.updatedAt, source: c.harness,
      }, native.retained);
      await writeFile(file, JSON.stringify(bundle), { flag: 'wx' });
    }
    c.canonicalPath = file; c.lastSyncAt = Date.now(); binding.revision = c.revision;
    if (publish) await this.store.save(c);
    return file;
  }

  async import(c: Conversation, target: Harness) {
    if (!c.canonicalPath) throw new Error('当前对话尚无可转换的上下文');
    if (isAgentHarness(target)) {
      if (!this.agents) throw new Error('原生执行器尚未配置');
      return this.agents.import(c, target, c.canonicalPath);
    }
    const context = bundledContext(JSON.parse(await readFile(c.canonicalPath, 'utf8')));
    if (target === 'deepseek') {
      const sessionId = await writeDeepSeekContext(this.deepSeekHome(c), c.workspace, c.harness, c.createdAt, context);
      return { sessionId, revision: c.revision, translated: true as const };
    }
    const sessionId = `sess_${randomUUID()}`;
    const modelSelection = await this.zcodeModelSelection(c);
    await nativeSqlite(this.node, {
      action: 'create', target: this.database(c), sessionId, workspace: c.workspace, title: c.title,
      modelSelection, messages: zcodeContextMessages(context), createdAt: c.createdAt,
    });
    return { sessionId, revision: c.revision };
  }

  async configureZcodeModel(c: Conversation, sessionId: string) {
    const modelSelection = await this.zcodeModelSelection(c);
    await nativeSqlite(this.node, { action: 'configureModel', target: this.database(c), sessionId, modelSelection });
  }

  private async zcodeModelSelection(c: Conversation) {
    const selected = nativeModel(c.modelId);
    const config = { ...this.settings().zcode, ...(selected ? { model: selected } : {}), reasoning: effectiveReasoning({ ...c, harness: 'zcode' }, this.settings()) };
    let selection: any = config.provider && config.model ? { providerId: config.provider, modelId: config.model } : undefined;
    if (!selection && config.authMode === 'api') selection = { providerId: config.provider || 'entrotect-glm', modelId: config.model || 'glm-5.3' };
    if (!selection) {
      try { selection = JSON.parse(await readFile(path.join(config.home, '.zcode', 'v2', 'provider_config.json'), 'utf8')).config?.defaultModelSelection; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!selection) throw new Error('请在 ZCode 原生配置中选择默认模型，或在连接设置中填写 Provider ID 和模型 ID');
    const nativeAlias = config.authMode === 'native' && selection.modelId?.toLowerCase() === selected?.toLowerCase();
    if (selected && !nativeAlias) selection = { ...selection, modelId: selected };
    if (config.reasoning) selection = { ...selection, options: { ...selection.options, reasoningLevel: config.reasoning } };
    return selection;
  }
}
