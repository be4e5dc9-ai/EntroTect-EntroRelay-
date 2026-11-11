import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentHarness } from '../shared/types';
import { harnessNames } from '../shared/harnesses';
import { AgentClient } from './agent-client';
import { publishCodexHistory, readCodexHistory, writeCodexHistory } from './codex-history';
import { readKimiHistory, writeKimiHistory } from './kimi-history';
import { readOpenCodeStorage, writeOpenCodeHistory } from './opencode-history';
import type { PortableMessage } from './portable-history';

export async function verifyAgentRuntime(harness: AgentHarness, node: string, entry: string, directory: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const cwd = path.join(directory, 'project');
  const home = path.join(directory, 'profile');
  await Promise.all([mkdir(cwd), mkdir(home)]);
  const script = /\.(?:js|mjs|cjs)$/i.test(entry);
  const executable = script ? node : entry;
  const prefix = script ? [entry] : [];
  const args = harness === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['acp'];
  const stamp = Date.now();
  const history: PortableMessage[] = [
    { role: 'user', text: 'EntroTect compatibility probe', time: stamp },
    { role: 'assistant', text: 'Native history compatibility confirmed', time: stamp + 1 },
  ];
  const title = 'EntroTect update probe';
  const baseUrl = 'http://127.0.0.1:9/v1';
  const database = path.join(home, 'opencode.db');
  Object.assign(env, { CODEX_HOME: home, CODEX_SQLITE_HOME: home, KIMI_CODE_HOME: home,
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, XDG_CACHE_HOME: directory, XDG_STATE_HOME: directory });

  if (harness === 'kimi') {
    await writeFile(path.join(home, 'config.toml'), [
      'default_model="fixture"', '[providers.fixture]', 'type="openai"', `base_url="${baseUrl}"`, 'api_key="update-probe-only"',
      '[models.fixture]', 'provider="fixture"', 'model="fixture"', 'max_context_size=32768',
    ].join('\n'));
  } else if (harness === 'codex') {
    await writeFile(path.join(home, 'config.toml'), [
      'model="fixture"', 'model_provider="fixture"', '[model_providers.fixture]', 'name="Fixture"', `base_url="${baseUrl}"`, 'wire_api="responses"',
    ].join('\n'));
  } else {
    env.OPENCODE_DB = database;
    env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: 'fixture/fixture', provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture',
        options: { baseURL: baseUrl, apiKey: 'update-probe-only' }, models: { fixture: { name: 'Fixture' } } } },
    });
  }

  async function withClient<T>(action: (client: AgentClient) => Promise<T>) {
    signal.throwIfAborted();
    const client = await AgentClient.connect(harness, { executable, args: [...prefix, ...args] }, cwd, env);
    const abort = () => { void client.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); return await action(client); }
    finally { signal.removeEventListener('abort', abort); await client.close(); }
  }

  let id: string;
  let archived: PortableMessage[];
  if (harness === 'codex') {
    const native = await withClient(async client => {
      const session = await writeCodexHistory(client, cwd, title, history);
      return { id: session.id, saved: await readCodexHistory(client, home, session.id) };
    });
    id = native.id;
    archived = native.saved.archived;
    await publishCodexHistory(home, native.saved, id);
  } else if (harness === 'kimi') {
    id = (await writeKimiHistory(home, cwd, title, history)).id;
    archived = (await readKimiHistory(home, cwd, id)).archived;
  } else {
    id = await writeOpenCodeHistory({ executable, prefix, env }, cwd, title, history, { providerID: 'fixture', modelID: 'fixture' });
    archived = (await readOpenCodeStorage(database, id)).archived;
  }
  if (archived.length !== history.length || history.some((item, i) => item.role !== archived[i].role || item.text !== archived[i].text)) {
    throw new Error(`${harnessNames[harness]} 的历史格式与当前 EntroTect 不兼容`);
  }
  await withClient(async client => {
    if (!(await client.list(cwd)).some(row => row.id === id) || (await client.open(cwd, id)).id !== id) {
      throw new Error(`${harnessNames[harness]} 无法重新打开转译后的原生会话`);
    }
  });
  signal.throwIfAborted();
}
