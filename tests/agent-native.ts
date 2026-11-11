import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { on } from 'node:events';
import { AgentClient } from '../backend/agent-client';
import { readCodexHistory, writeCodexHistory } from '../backend/codex-history';
import { bridgeEntries, bridgeMessages, bundledContext, messagesToBridge, portableHistoryFingerprint, type PortableEntry, type PortableMessage } from '../backend/portable-history';
import { readDeepSeekContext, writeDeepSeekContext } from '../backend/dsh-context';
import { readKimiHistory, writeKimiHistory } from '../backend/kimi-history';
import { appendOpenCodeHistory, readOpenCodeHistory, readOpenCodeStorage, writeOpenCodeHistory } from '../backend/opencode-history';
import { Controller } from '../backend/controller';
import { SettingsStore, defaultAgentConnection } from '../backend/settings';
import { atomicJson, Store } from '../backend/store';
import { modelFixture } from './fixture-server';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoryService } from '../backend/history';
import { HistorySync } from '../backend/history-sync';
import { catalogModelId } from '../shared/harnesses';
import { TokenActivity } from '../backend/token-activity';
import { AccountUsageService } from '../backend/account-usage';
import { kimiNativeUsage } from '../backend/kimi-usage';

async function idle(controller: Controller, store: Store, id: string) {
  for (let n = 0; n < 500 && controller.isBusy(id); n++) await delay(50);
  const chat = store.get(id);
  assert.equal(chat.state, 'idle', chat.error);
  return chat;
}

async function profile() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'entrotect-agent-native-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|SystemDrive|ComSpec|Path|PATHEXT|windir|ProgramFiles)$/i.test(key)));
  Object.assign(env, { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root });
  return { root, home, cwd, env, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }) };
}

const codex = process.env.ENTROTECT_TEST_CODEX;

test('Kimi and OpenCode usage routes distinguish plan limits from API wallets', async t => {
  const { root, cleanup } = await profile();
  t.after(cleanup);
  const settings = new SettingsStore(root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
  await settings.init();
  const usage = new AccountUsageService(settings, async () => null, undefined, async () => ({
    kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.25, resetAt: '2030-01-01T00:00:00Z' } }, extraUsage: { currency: 'USD', balanceCents: 765 } },
  }));
  const native = await usage.read('kimi');
  assert.deepEqual(native.plan, { status: 'ready', source: 'Kimi Code', rows: [{ name: '5 小时额度', remainingPercent: 75, resetAt: Date.UTC(2030, 0, 1) }] });
  assert.deepEqual(native.balance, { status: 'ready', source: 'Kimi Code', rows: [{ name: '加量包余额', currency: 'USD', amount: '7.65' }] });
  const requests: [string, string | null][] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    requests.push([url.href, new Headers(init.headers).get('authorization')]);
    return Response.json(url.pathname.endsWith('/usages')
      ? { usages: { limit_7d: { used_ratio: '0.40' } } }
      : { code: 0, data: { available_balance: 12.345, cash_balance: -2.50, voucher_balance: 12.345 } });
  });
  const configure = (kimi: string, opencode: string) => settings.save({ ...settings.value, agents: { ...settings.value.agents,
    kimi: { ...defaultAgentConnection('kimi'), authMode: 'api', baseUrl: kimi },
    opencode: { ...defaultAgentConnection('opencode'), authMode: 'api', baseUrl: opencode },
  } }, { kimi: 'fixture-kimi', opencode: 'fixture-opencode' });
  await configure('https://api.kimi.com/coding/v1', 'https://api.moonshot.ai/v1');
  const [coding, platform] = await Promise.all([usage.read('kimi'), usage.read('opencode')]);
  assert.deepEqual(coding.plan, { status: 'ready', source: 'Kimi Code', rows: [{ name: '每周额度', remainingPercent: 60 }] });
  assert(platform.balance.status === 'ready');
  assert.deepEqual(platform.balance.rows.map(({ currency, amount }) => [currency, amount]), [['USD', '12.345'], ['USD', '-2.5'], ['USD', '12.345']]);
  assert.deepEqual(requests, [
    ['https://api.kimi.com/coding/v1/usages', 'Bearer fixture-kimi'],
    ['https://api.moonshot.ai/v1/users/me/balance', 'Bearer fixture-opencode'],
  ]);
  await configure('https://api.moonshot.cn/v1', 'https://api.moonshot.ai.example.invalid/v1');
  const china = await usage.read('kimi');
  assert(china.balance.status === 'ready' && china.balance.rows.every(row => row.currency === 'CNY'));
  assert.equal((await usage.read('opencode')).balance.status, 'unavailable');
  assert.equal(requests.length, 3);
});

test('the native Kimi usage service handles a fresh profile without logging in', { skip: !process.env.ENTROTECT_TEST_KIMI }, async t => {
  const { home, env, cleanup } = await profile();
  t.after(cleanup);
  const executable = process.env.ENTROTECT_TEST_KIMI!;
  const command = executable.endsWith('.mjs') ? [process.execPath, [executable]] as const : [executable, []] as const;
  const result = await kimiNativeUsage(command[0], [...command[1]], home, { ...env, KIMI_CODE_HOME: home, NO_COLOR: '1' });
  assert(result.kind === 'error' && /no token for/i.test(result.message ?? ''));
});

for (const harness of ['kimi', 'opencode', 'codex'] as const) {
  const executable = harness === 'codex' ? codex : process.env[harness === 'kimi' ? 'ENTROTECT_TEST_KIMI' : 'ENTROTECT_TEST_OPENCODE'];
  test(`${harness} exposes its model options and runs native commands`, { skip: !executable, timeout: 90_000 }, async () => {
    const { root, home, cwd, cleanup } = await profile();
    const fixture = await modelFixture();
    const store = new Store(path.join(root, 'app'));
    await store.init();
    const settings = new SettingsStore(store.root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
    await settings.init();
    const connection = { ...defaultAgentConnection(harness), executable: executable!, home };
    settings.value = { ...settings.value, defaultWorkspace: cwd, agents: { ...settings.value.agents, [harness]: connection } };
    if (harness === 'kimi') await writeFile(path.join(home, 'config.toml'), [
      'default_model="think"', '[providers.fixture]', 'type="openai"', `base_url="${fixture.origin}/v1"`, 'api_key="fixture"',
      '[models.think]', 'provider="fixture"', 'model="think"', 'max_context_size=32768', 'capabilities=["thinking"]', 'support_efforts=["low","high"]',
      '[models.plain]', 'provider="fixture"', 'model="plain"', 'max_context_size=32768',
    ].join('\n'));
    if (harness === 'opencode') await atomicJson(path.join(cwd, 'opencode.json'), { model: 'fixture/think', provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL: `${fixture.origin}/v1`, apiKey: 'fixture' },
      models: { think: { name: 'Think', reasoning: true, limit: { context: 32768, output: 4096 } }, plain: { name: 'Plain', reasoning: false } },
    } }, command: { 'fixture-command': { template: 'Execute the native fixture command with $ARGUMENTS', description: 'Native test command' } } });
    const controller = new Controller(store, settings, event => {
      if (event.type === 'approval') void controller.answer(event.approval.id, true).catch(() => {});
    });
    try {
      const defaultId = `${harness}:default`;
      const native = await controller.nativeModels(harness, cwd, defaultId);
      const levels = native.reasoning.levels.map(level => level.id);
      assert(levels.includes('high'), JSON.stringify(native));
      const chosenModel = catalogModelId(harness, native.currentModel!);
      assert(native.models.some(model => model.id === native.currentModel));
      const { id } = await controller.create(cwd, 'deepseek');
      await controller.selectModel(id, chosenModel);
      assert.equal(store.get(id).harness, harness);
      await assert.rejects(controller.selectReasoning(id, 'not-an-effort'), /没有经过核实/);
      const effort = native.reasoning.defaultLevel === 'high' ? 'low' : 'high';
      await controller.selectReasoning(id, effort);
      const available = await controller.listCommands(harness, cwd, chosenModel, id);
      if (harness === 'codex') {
        assert.deepEqual(available.map(command => command.name), ['compact', 'review']);
        assert.equal(fixture.requests.length, 0);
        await settings.save({ ...settings.value, agents: { ...settings.value.agents, codex: {
          ...connection, model: native.currentModel!, authMode: 'api', baseUrl: `${fixture.origin}/v1`,
        } } }, { codex: 'local-fixture-only' });
        await controller.send(id, 'CODEX-CAPABILITY-TURN-22');
        await idle(controller, store, id);
        assert.equal((await new TokenActivity(store).read()).reduce((sum, day) => sum + day.codex, 0), 100);
        assert(fixture.requests.some(request => request.body?.reasoning?.effort === effort && JSON.stringify(request.body).includes('CODEX-CAPABILITY-TURN-22')));
        fixture.reply('COMPACTED-CAPABILITY-24');
        await controller.send(id, '/compact');
        await idle(controller, store, id);
        assert((await store.items(id)).some(item => item.kind === 'command' && item.commandName === 'compact' && item.status === 'done'));
        assert(fixture.requests.every(request => !JSON.stringify(request.body?.input ?? []).includes('"text":"/compact"')));
        fixture.reply(JSON.stringify({ findings: [], overall_correctness: 'patch is correct', overall_explanation: 'NATIVE-REVIEW-26', overall_confidence_score: 1 }));
        await controller.send(id, '/review Check the fixture scope NATIVE-REVIEW-25');
        await idle(controller, store, id);
        assert(fixture.requests.some(request => JSON.stringify(request.body).includes('NATIVE-REVIEW-25')));
        assert((await store.items(id)).some(item => item.kind === 'assistant' && item.text.includes('NATIVE-REVIEW-26')));
        return;
      }
      const plain = await controller.nativeModels(harness, cwd, catalogModelId(harness, harness === 'kimi' ? 'plain' : 'fixture/plain'));
      assert.deepEqual(plain.reasoning.levels, []);
      if (harness === 'kimi') {
        assert.deepEqual(levels, ['off', 'low', 'high']);
        assert.equal((await controller.agents.list(harness, home)).length, 0, 'probing must not leave visible sessions');
        assert(available.some(command => command.name === 'help'));
        await controller.send(id, '/help');
        await idle(controller, store, id);
        assert.equal(fixture.requests.length, 0, '/help must be handled by Kimi ACP');
        assert((await store.items(id)).some(item => item.kind === 'command' && item.commandName === 'help' && item.status === 'done'));
        assert((await store.items(id)).some(item => item.kind === 'assistant' && item.text.includes('/status')));
      } else {
        assert(available.some(command => command.name === 'fixture-command'));
        await controller.send(id, '/fixture-command COMMAND-ARG-20');
        await idle(controller, store, id);
        assert(fixture.requests.some(request => JSON.stringify(request.body).includes('Execute the native fixture command with COMMAND-ARG-20')));
      }
      const file = path.join(cwd, 'tool-fixture.txt');
      await writeFile(file, 'LOCAL-TOOL-OUTPUT-42');
      fixture.readFile(file);
      fixture.reply('NATIVE-TOOL-COMPLETE-44');
      await controller.send(id, 'Read the fixture file.');
      const chat = await idle(controller, store, id);
      assert((await store.items(id)).some(item => item.kind === 'tool' && item.text.includes('LOCAL-TOOL-OUTPUT-42')));
      const archive = bridgeEntries(JSON.parse(await readFile(chat.canonicalPath!, 'utf8')), 'archive');
      const recoveredTool = archive.some(entry => 'kind' in entry && entry.kind === 'tool' && entry.output?.includes('LOCAL-TOOL-OUTPUT-42'));
      if (harness === 'kimi' && !recoveredTool) {
        const native = await readKimiHistory(home, cwd, chat.bindings.kimi!.sessionId);
        assert.fail(native.wireRaw.split('\n').filter(row => row.includes('LOCAL-TOOL-OUTPUT-42') || row.includes('call_entrotect_fixture_read')).slice(-9).join('\n'));
      }
      assert(recoveredTool);
      const measured = (await new TokenActivity(store).read()).reduce((sum, day) => sum + day[harness], 0);
      const expected = harness === 'kimi' ? 200 : 300;
      if (measured !== expected && harness === 'kimi') {
        const native = await readKimiHistory(home, cwd, chat.bindings.kimi!.sessionId);
        const rows = native.wireRaw.split('\n').filter(line => line.includes('step.end'));
        const ledger = (await readFile(path.join(store.directory(id), 'native.jsonl'), 'utf8')).split('\n').filter(line => line.includes('model-usage'));
        assert.fail(JSON.stringify({ measured, native: native.tokenReports, rows, ledger }));
      }
      assert.equal(measured, expected);
      assert(chat.contextUsage && chat.contextUsage.windowTokens === 32768);
      const runtime = (controller as any).residents.get(id);
      const client: AgentClient = await runtime.agent;
      const session = await client.open(cwd, chat.bindings[harness]!.sessionId);
      assert.equal(session.configOptions?.find(option => option.category === 'thought_level')?.currentValue, effort);
      await controller.selectReasoning(id);
      fixture.hold(true);
      await controller.send(id, 'PAUSE-NATIVE-47');
      for (let n = 0; n < 240 && !fixture.requests.some(request => JSON.stringify(request.body).includes('PAUSE-NATIVE-47')); n++) await delay(50);
      assert(fixture.requests.some(request => JSON.stringify(request.body).includes('PAUSE-NATIVE-47')));
      await controller.stop(id);
      assert.equal((await idle(controller, store, id)).bindings[harness]!.sessionId, session.id);
      assert.equal((controller as any).residents.get(id), runtime, 'pausing must retain the native process');
      assert.equal(session.configOptions?.find(option => option.category === 'thought_level')?.currentValue, native.reasoning.defaultLevel);
    } finally { await controller.close(); await fixture.close(); await cleanup(); }
  });
}

test('official Codex persists translated history and a separate process reads the same native thread', { skip: !codex }, async t => {
  const { root, home, cwd, env, cleanup } = await profile();
  t.after(cleanup);
  await writeFile(path.join(home, 'config.toml'), [
    'cli_auth_credentials_store = "file"', 'model = "entrotect-offline-probe"', 'model_provider = "entrotect_probe"',
    '[model_providers.entrotect_probe]', 'name = "EntroTect Offline Probe"', 'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"',
  ].join('\n'));
  const open = () => AgentClient.connect('codex', { executable: codex!, args: ['app-server', '--listen', 'stdio://'] }, cwd, { ...env, CODEX_HOME: home });
  const stamp = Date.now();
  const fixture: PortableMessage[] = [
    { role: 'user', text: 'PORTABLE-USER-19', time: stamp },
    { role: 'assistant', text: 'PORTABLE-REPLY-34', time: stamp + 1 },
  ];
  const entries: PortableEntry[] = [fixture[0], { kind: 'reasoning', text: 'VISIBLE-SUMMARY-30', time: stamp },
    { kind: 'tool', callId: 'call_history_31', name: 'history_read', arguments: '{"path":"example.txt"}', output: 'TOOL-OUTPUT-32', time: stamp },
    { kind: 'tool', callId: 'call_unfinished_33', name: 'history_write', arguments: '{}', time: stamp }, fixture[1]];
  const bundle = messagesToBridge(entries, { id: randomUUID(), title: 'Codex import smoke', cwd, createdAt: stamp, updatedAt: stamp + 1 });
  const incoming = bridgeMessages(bundle);
  assert.deepEqual(incoming, fixture);
  const first = await open();
  const session = await writeCodexHistory(first, cwd, 'Codex import smoke', bridgeEntries(bundle)).finally(() => first.close());
  const second = await open();
  try {
    const read = await readCodexHistory(second, home, session.id);
    assert.deepEqual(read.resume.map(({ role, text }) => [role, text]), fixture.map(({ role, text }) => [role, text]));
    assert.equal(portableHistoryFingerprint(read.history), portableHistoryFingerprint(entries));
    assert(!read.history.some(entry => 'kind' in entry && entry.kind === 'tool' && entry.callId === 'call_unfinished_33'));
    assert.equal((await second.open(cwd, session.id)).id, session.id);
    const portable = messagesToBridge(entries, { id: session.id, title: 'Codex export smoke', cwd, createdAt: stamp, updatedAt: Date.now() });
    const dsh = path.join(root, 'dsh');
    const id = await writeDeepSeekContext(dsh, cwd, 'codex', stamp, bundledContext(portable));
    const translated = await readDeepSeekContext(dsh, cwd, id, stamp);
    assert.equal(portableHistoryFingerprint(translated.retained), portableHistoryFingerprint(entries));
  } finally { await second.close(); }
});

test('Codex prewarms the last conversation and keeps its process after interruption', { skip: !codex, timeout: 45_000 }, async t => {
  const { root, home, cwd, cleanup } = await profile();
  t.after(cleanup);
  await writeFile(path.join(home, 'config.toml'), [
    'model = "gpt-5.4"', 'model_provider = "fixture"',
    '[model_providers.fixture]', 'name = "Offline fixture"', 'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"', 'stream_max_retries = 0', 'request_max_retries = 0',
  ].join('\n'));
  const store = new Store(path.join(root, 'app'));
  await store.init();
  const settings = new SettingsStore(store.root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
  await settings.init();
  settings.value.defaultWorkspace = cwd;
  settings.value.agents = { ...settings.value.agents, codex: { ...defaultAgentConnection('codex'), executable: codex!, home } };
  const before = new Controller(store, settings, () => {});
  const chat = await before.create(cwd, 'codex');
  before.rememberRuntime('codex', chat.id);
  await before.close();

  const reopenedStore = new Store(store.root);
  await reopenedStore.init();
  const controller = new Controller(reopenedStore, settings, () => {});
  try {
    await controller.initStartup();
    assert.deepEqual(controller.startupRoute, { harness: 'codex', conversationId: chat.id });
    controller.startPrewarming();
    await controller['prewarming'];
    const runtime = controller['residents'].get(chat.id);
    assert(runtime);
    const rpc = await runtime.ready;
    const pid = rpc.child.pid;
    assert(pid && rpc.available);
    assert.equal(runtime.sessionId, undefined, 'startup should initialize the server before opening a native thread');

    for (const text of ['Pause the first turn', 'Continue with the same process']) {
      const notifications = on(rpc, 'notification', { signal: AbortSignal.timeout(10_000) });
      try {
        await controller.send(chat.id, text);
        for await (const [frame] of notifications) {
          if (frame.method === 'turn/started') break;
        }
      } finally { await notifications.return?.(); }
      await controller.stop(chat.id);
      assert.equal((await idle(controller, reopenedStore, chat.id)).bindings.codex?.sessionId, runtime.sessionId);
      assert.equal(controller['residents'].get(chat.id), runtime);
      assert.equal(rpc.child.pid, pid);
      assert(rpc.available);
    }
    const native = (await readFile(path.join(store.directory(chat.id), 'native.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(native.filter(row => row.frame.method === 'turn/completed' && row.frame.params.turn.status === 'interrupted').length, 2);
  } finally { await controller.close(); }
});

test('Codex history import and manual continuation reuse the original thread in the same profile', { skip: !codex, timeout: 90_000 }, async t => {
  const { root, home, cwd, cleanup } = await profile();
  t.after(cleanup);
  const store = new Store(path.join(root, 'app'));
  await store.init();
  const settings = new SettingsStore(store.root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
  await settings.init();
  settings.value.defaultWorkspace = cwd;
  settings.value.agents = { ...settings.value.agents, codex: { ...defaultAgentConnection('codex'), executable: codex!, home } };
  const controller = new Controller(store, settings, () => {});
  const history = new HistoryService(controller);
  const sync = new HistorySync(controller, history, () => {});
  await sync.init();
  const source = { harness: 'codex' as const, location: home };
  try {
    for (const automatic of [false, true]) {
      const chat = await controller.create(cwd, 'deepseek');
      const time = Date.now();
      chat.title = automatic ? 'Automatically discovered history' : 'Manually imported history';
      chat.revision = 1;
      if (automatic) chat.bindings.codex = { sessionId: randomUUID(), revision: chat.revision, location: home };
      chat.canonicalPath = path.join(store.directory(chat.id), 'context', 'fixture.entrotect.json');
      await atomicJson(chat.canonicalPath, messagesToBridge([{ role: 'user', text: chat.title, time }], {
        id: chat.id, title: chat.title, cwd, createdAt: time, updatedAt: time,
      }));
      await store.save(chat);
      const copy = await history.export({ conversationId: chat.id, target: source });
      assert.equal(copy.reused, undefined);
      const published = await controller.agents.read('codex', home, cwd, copy.sessionId);
      assert('file' in published);
      if (automatic) {
        // Newer Codex records its visible user turns as completed items.
        const rollout = (await readFile(published.file, 'utf8')).trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
        const user = rollout.find(row => row.type === 'event_msg' && row.payload.type === 'user_message');
        user.payload = {
          type: 'item_completed', thread_id: copy.sessionId, turn_id: randomUUID(),
          item: { type: 'UserMessage', id: randomUUID(), content: [{ type: 'text', text: chat.title }] },
          started_at_ms: time, completed_at_ms: time,
        };
        await writeFile(published.file, rollout.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
      const native = await controller.agents.read('codex', home, cwd, copy.sessionId);
      assert('listed' in native && native.listed);
      const request = { source, sessionId: copy.sessionId };
      const imported = automatic ? await history.import(request, undefined, true) : await sync.importManually(request);
      assert.equal(imported.bindings.codex?.sessionId, copy.sessionId);
      assert.equal(imported.bindings.codex?.revision, imported.revision);
      assert.equal((await sync.importManually(request)).id, imported.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const receipt = await history.export({ conversationId: imported.id, target: source });
        assert.equal(receipt.sessionId, copy.sessionId);
        assert.equal(receipt.reused, true);
      }
      assert.equal((await controller.agents.read('codex', home, cwd, copy.sessionId)).version, native.version);
      if (automatic) {
        const resident: AgentClient = await (controller as any).prepareRuntime(imported, false).agent;
        await resident.open(cwd, copy.sessionId);
        assert.equal((await history.export({ conversationId: imported.id, target: source })).sessionId, copy.sessionId);
        assert.equal(resident.rpc.available, false);
      }
      await controller.verifyNative(imported);
    }
    assert.equal((await history.list(source)).sessions.length, 2);
  } finally { await sync.stop(); await controller.close(); }
});

for (const harness of ['kimi', 'opencode'] as const) {
  const executable = process.env[harness === 'kimi' ? 'ENTROTECT_TEST_KIMI' : 'ENTROTECT_TEST_OPENCODE'];
  test(`${harness} lists and resumes a translated native conversation over ACP`, { skip: !executable }, async t => {
    const { root, home, cwd, env, cleanup } = await profile();
    t.after(cleanup);
    const nodeEntry = executable!.endsWith('.mjs');
    const config = { executable: nodeEntry ? process.execPath : executable!, args: nodeEntry ? [executable!, 'acp'] : ['acp'] };
    Object.assign(env, {
      KIMI_CODE_HOME: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
      XDG_STATE_HOME: root, OPENCODE_DB: path.join(root, 'opencode.db'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
    });
    const stamp = Date.now();
    const messages: PortableMessage[] = [
      { role: 'user', text: 'PORTABLE-QUESTION-62', time: stamp },
      { role: 'assistant', text: 'PORTABLE-ANSWER-71', time: stamp + 1 },
    ];
    let id: string;
    if (harness === 'kimi') {
      await writeFile(path.join(home, 'config.toml'), [
        'default_model = "fixture"', '[providers.fixture]', 'type = "openai"', 'base_url = "http://127.0.0.1:9/v1"',
        'api_key = "local-fixture-only"', '[models.fixture]', 'provider = "fixture"', 'model = "fixture"', 'max_context_size = 32768',
      ].join('\n'));
      id = (await writeKimiHistory(home, cwd, 'Kimi import smoke', messages)).id;
      assert.deepEqual((await readKimiHistory(home, cwd, id)).archived.map(({ text }) => text), messages.map(({ text }) => text));
    } else {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'fixture/fixture', provider: { fixture: {
        npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'local-fixture-only' },
        models: { fixture: { name: 'Fixture' } },
      } } });
      const cli = { executable: executable!, env };
      id = await writeOpenCodeHistory(cli, cwd, 'OpenCode import smoke', messages, { providerID: 'fixture', modelID: 'fixture' });
      assert.deepEqual((await readOpenCodeHistory(cli, cwd, id)).archived.map(({ text }) => text), messages.map(({ text }) => text));
    }
    const client = await AgentClient.connect(harness, config, cwd, env);
    try {
      assert((await client.list(cwd)).some(row => row.id === id));
      assert.equal((await client.open(cwd, id)).id, id);
    }
    finally { await client.close(); }
    if (harness === 'kimi') {
      const implicit = await readKimiHistory(home, cwd, id);
      const managed = path.join(home, 'sessions', `wm_${randomUUID()}`, id);
      await mkdir(path.dirname(managed));
      await rename(implicit.directory, managed);
      await mkdir(path.join(managed, 'session-meta'));
      await rename(path.join(managed, 'state.json'), path.join(managed, 'session-meta', 'state.json'));
      const recovered = await readKimiHistory(home, cwd, id);
      assert.deepEqual(recovered.archived.map(({ text }) => text), messages.map(({ text }) => text));
      assert.equal(recovered.directory, managed);
    }
  });
}

for (const harness of ['kimi', 'codex'] as const) {
  const executable = harness === 'codex' ? codex : process.env.ENTROTECT_TEST_KIMI;
  test(`${harness} recognizes its shared native checkpoint and pulls an independent turn without forking`, { skip: !executable, timeout: 90_000 }, async t => {
    const previousProxy = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
    process.env.NO_PROXY = '127.0.0.1';
    process.env.no_proxy = '127.0.0.1';
    t.after(() => {
      for (const [key, value] of Object.entries({ NO_PROXY: previousProxy.upper, no_proxy: previousProxy.lower })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const { root, home, cwd, env, cleanup } = await profile();
    const fixture = await modelFixture();
    const store = new Store(path.join(root, 'app'));
    await store.init();
    const settings = new SettingsStore(store.root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
    await settings.init();
    const config = { ...defaultAgentConnection(harness), executable: executable!, home, model: 'fixture' };
    await settings.save({
      ...settings.value, defaultWorkspace: cwd, history: { autoImport: true, autoExport: true, importScope: 'all', exportScope: 'all', sources: {
        deepseek: path.join(root, 'absent-deepseek'), zcode: path.join(root, 'absent-zcode.db'),
        kimi: path.join(root, 'absent-kimi'), opencode: path.join(root, 'absent-opencode'),
        codex: path.join(root, 'absent-codex'), [harness]: home,
      } },
      agents: { ...settings.value.agents, [harness]: config },
    });
    const provider = harness === 'kimi' ? [
      'default_model = "fixture"', '[providers.fixture]', 'type = "openai"', `base_url = "${fixture.origin}/v1"`,
      'api_key = "local-fixture-only"', '[models.fixture]', 'provider = "fixture"', 'model = "fixture"', 'max_context_size = 32768',
    ] : [
      'model = "fixture"', 'model_provider = "fixture"', '[model_providers.fixture]', 'name = "Fixture"',
      `base_url = "${fixture.origin}/v1"`, 'wire_api = "responses"', 'stream_max_retries = 0', 'request_max_retries = 0',
    ];
    await writeFile(path.join(home, 'config.toml'), provider.join('\n'));
    const controller = new Controller(store, settings, () => {});
    const history = new HistoryService(controller);
    const sync = new HistorySync(controller, history, () => {}, async () => ({}));
    const readLinks = () => readFile(path.join(store.root, 'history-sync.json'), 'utf8').then(JSON.parse);
    try {
      await sync.init();
      const { id } = await controller.create(cwd, harness);
      const send = async (marker: string) => {
        fixture.reply(marker + '-REPLY');
        await controller.send(id, marker + '-QUESTION');
        const chat = await idle(controller, store, id).catch(async error => {
          if (harness !== 'kimi') throw error;
          const binding = store.get(id).bindings.kimi;
          const native = binding && await readKimiHistory(home, cwd, binding.sessionId).catch(() => undefined);
          throw new Error(`${error.message}\nFixture calls: ${fixture.requests.length}\n${native?.wireRaw.split('\n').slice(-9).join('\n') ?? ''}`);
        });
        const result = await sync.run(true);
        assert.deepEqual(result.issues, []);
        assert.equal(store.list().length, 1);
        assert.equal((await readLinks()).links.length, 1);
        assert.equal((await readLinks()).links[0].revision, chat.revision);
        return chat.bindings[harness]!.sessionId;
      };
      const nativeId = await send('DESKTOP-SHARED-FIRST');
      assert.equal(await send('DESKTOP-SHARED-SECOND'), nativeId);
      await controller.releaseRuntime(id);

      const command = executable!.endsWith('.mjs') ? { executable: process.execPath, args: [executable!, ...config.args] } : config;
      const native = await AgentClient.connect(harness, command, cwd, { ...env, KIMI_CODE_HOME: home, CODEX_HOME: home, NO_PROXY: '127.0.0.1' });
      try {
        fixture.reply('INDEPENDENT-SHARED-REPLY');
        await native.turn(await native.open(cwd, nativeId), 'INDEPENDENT-SHARED-QUESTION', { signal: AbortSignal.timeout(30_000) });
      } finally { await native.close(); }
      const imported = await sync.run(true);
      assert.deepEqual(imported.issues, []);
      assert.equal(imported.imported, 1);
      assert((await store.items(id)).some(item => item.text === 'INDEPENDENT-SHARED-REPLY'));
      assert.equal(await send('DESKTOP-SHARED-THIRD'), nativeId);
      const source = { harness, location: home };
      const listed = await history.list(source);
      assert.deepEqual(listed.sessions.map(session => session.id), [nativeId]);
      const fingerprint = (await history.inspect(source, nativeId)).fingerprint;
      await controller.updateConnections(() => settings.save({
        ...settings.value,
        history: { ...settings.value.history, autoImport: false, autoExport: false },
        agents: { ...settings.value.agents, [harness]: { ...config, isolatedNative: true } },
      }));
      const login = await controller.agents.loginCommand(harness);
      assert.equal(login.args.at(-1), 'login');
      assert.equal(login.home, path.join(store.root, 'agents', `${harness}-account`));
      await writeFile(path.join(login.home, 'config.toml'), provider.join('\n'));
      fixture.reply('DESKTOP-ISOLATED-ACCOUNT-REPLY');
      await controller.send(id, 'DESKTOP-ISOLATED-ACCOUNT-QUESTION');
      const accountChat = await idle(controller, store, id);
      assert.equal(accountChat.bindings[harness]!.location, login.home);
      assert.notEqual(accountChat.bindings[harness]!.sessionId, nativeId);
      assert.equal((await history.inspect(source, nativeId)).fingerprint, fingerprint);
      assert(fixture.requests.some(request => JSON.stringify(request.body).includes('DESKTOP-ISOLATED-ACCOUNT-QUESTION') &&
        JSON.stringify(request.body).includes('INDEPENDENT-SHARED-REPLY')));
      settings.value.history = { ...settings.value.history, autoImport: false, autoExport: true };
      assert.deepEqual((await sync.run(true)).issues, []);
      assert.equal((await readLinks()).links[0].sessionId, nativeId);
      const published = await controller.agents.read(harness, home, cwd, nativeId);
      assert(published.archived.some(entry => entry.text === 'DESKTOP-ISOLATED-ACCOUNT-REPLY'));
      const publishedFingerprint = (await history.inspect(source, nativeId)).fingerprint;

      await controller.updateConnections(() => settings.save({
        ...settings.value,
        history: { ...settings.value.history, autoImport: false, autoExport: false },
        agents: { ...settings.value.agents, [harness]: { ...config, authMode: 'api', baseUrl: `${fixture.origin}/v1` } },
      }, { [harness]: 'local-fixture-only' }));
      fixture.reply('DESKTOP-ISOLATED-REPLY');
      await controller.send(id, 'DESKTOP-ISOLATED-QUESTION');
      const isolated = await idle(controller, store, id);
      assert.notEqual(isolated.bindings[harness]!.sessionId, nativeId);
      assert.notEqual(isolated.bindings[harness]!.location, login.home);
      assert.equal((await history.inspect(source, nativeId)).fingerprint, publishedFingerprint);
      assert(fixture.requests.some(request => JSON.stringify(request.body).includes('DESKTOP-ISOLATED-QUESTION') &&
        JSON.stringify(request.body).includes('INDEPENDENT-SHARED-REPLY')));
    } finally { await sync.stop(); await controller.close(); await fixture.close(); await cleanup(); }
  });
}

test('Codex resumes imported compacted history and recovers a legacy overflow before retry or switch', { skip: !codex, timeout: 90_000 }, async () => {
  const { root, home, cwd, cleanup } = await profile();
  const fixture = await modelFixture();
  const store = new Store(root);
  await store.init();
  const settings = new SettingsStore(root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
  await settings.init();
  await settings.save({ ...settings.value, defaultWorkspace: cwd,
    deepseek: { ...settings.value.deepseek, home: path.join(root, 'dsh'), authMode: 'api', baseUrl: fixture.origin + '/anthropic' },
    zcode: { ...settings.value.zcode, home: path.join(root, 'zcode'), authMode: 'api', baseUrl: `${fixture.origin}/v1`, provider: 'fixture', model: 'glm-5.3' },
    agents: { ...settings.value.agents, codex: {
    ...defaultAgentConnection('codex'), executable: codex!, home, authMode: 'api', model: 'gpt-5.4', baseUrl: `${fixture.origin}/v1`,
    args: ['-c', 'model_providers.entrotect_api.request_max_retries=0', '-c', 'model_providers.entrotect_api.stream_max_retries=0', 'app-server', '--listen', 'stdio://'],
  } } }, { codex: 'local-fixture-only', deepseek: 'local-fixture-only', zcode: 'local-fixture-only' });
  const controller = new Controller(store, settings, () => {});
  const time = Date.now();
  const archive: PortableEntry[] = [
    { role: 'user', text: 'ARCHIVED-ORIGINAL-QUESTION', time },
    { kind: 'tool', callId: 'archived_tool', name: 'read', arguments: '{}', output: 'ARCHIVE-ONLY-TOOL-OUTPUT', time },
    { role: 'assistant', text: 'ARCHIVED-ANSWER', time },
  ];
  const resume: PortableEntry[] = [{ role: 'assistant', text: 'COMPACTED-CONTINUATION-SUMMARY', time }];
  async function imported() {
    const c = await controller.create(cwd, 'codex');
    c.revision = 1;
    c.canonicalPath = path.join(store.directory(c.id), 'context', 'seed.hbridge.json');
    const bundle = messagesToBridge(archive, { id: c.id, title: c.title, cwd, createdAt: time, updatedAt: time }, resume);
    await atomicJson(c.canonicalPath, { ...bundle, format: 'harness-bridge-session' });
    await store.save(c);
    return c;
  }
  async function assertContinued(id: string, prompt: string) {
    const c = await idle(controller, store, id);
    const requests = fixture.requests.filter(({ body }) => JSON.stringify(body).includes(prompt));
    assert(requests.length > 0);
    for (const request of requests) {
      const content = JSON.stringify(request.body.input);
      assert(content.includes('COMPACTED-CONTINUATION-SUMMARY'));
      assert(!content.includes('ARCHIVE-ONLY-TOOL-OUTPUT'));
    }
    const bundle = JSON.parse(await readFile(c.canonicalPath!, 'utf8'));
    assert(bridgeEntries(bundle, 'archive').some(entry => 'kind' in entry && entry.kind === 'tool' && entry.output === 'ARCHIVE-ONLY-TOOL-OUTPUT'));
    assert.equal(c.bindings.codex?.seed?.view, 'resume');
  }
  async function rejectLegacyArchive() {
    const legacy = await imported();
    legacy.bindings.codex = await controller.agents.import(legacy, 'codex', legacy.canonicalPath!, undefined, 'archive');
    await store.save(legacy);
    fixture.codexContextOverflow(true);
    await controller.send(legacy.id, 'LEGACY-REJECTED-PROMPT');
    for (let n = 0; n < 500 && controller.isBusy(legacy.id); n++) await delay(50);
    assert.equal(store.get(legacy.id).state, 'error');
    assert.match(store.get(legacy.id).error ?? '', /上下文已满/);
    fixture.codexContextOverflow(false);
    return legacy;
  }
  try {
    const first = await imported();
    await controller.send(first.id, 'NEW-IMPORT-CONTINUATION');
    await assertContinued(first.id, 'NEW-IMPORT-CONTINUATION');

    const legacy = await rejectLegacyArchive();
    const failedSession = legacy.bindings.codex!.sessionId;
    await controller.send(legacy.id, 'LEGACY-RETRY-WITH-SHORT-CONTEXT');
    await assertContinued(legacy.id, 'LEGACY-RETRY-WITH-SHORT-CONTEXT');
    assert.notEqual(store.get(legacy.id).bindings.codex?.sessionId, failedSession);
    assert((await store.items(legacy.id)).some(item => item.kind === 'user' && item.text === 'LEGACY-REJECTED-PROMPT'));

    const switching = await rejectLegacyArchive();
    const before = fixture.requests.length;
    await controller.switchHarness(switching.id, 'deepseek');
    assert.equal(fixture.requests.length, before);
    const repaired = JSON.parse(await readFile(switching.canonicalPath!, 'utf8'));
    assert(bridgeMessages(repaired).some(entry => entry.text === 'COMPACTED-CONTINUATION-SUMMARY'));
    assert(bridgeEntries(repaired, 'archive').some(entry => 'kind' in entry && entry.kind === 'tool' && entry.output === 'ARCHIVE-ONLY-TOOL-OUTPUT'));
    await controller.send(switching.id, 'DEEPSEEK-AFTER-LEGACY-OVERFLOW');
    await idle(controller, store, switching.id);
    const request = fixture.requests.slice(before).find(({ path, body }) => path.includes('messages') && JSON.stringify(body).includes('DEEPSEEK-AFTER-LEGACY-OVERFLOW'));
    assert(request && JSON.stringify(request.body).includes('COMPACTED-CONTINUATION-SUMMARY'));
    assert(!JSON.stringify(request.body).includes('ARCHIVE-ONLY-TOOL-OUTPUT'));
    assert.equal(request.body.dsh_session_log, undefined);

    const zcode = await imported();
    await controller.switchHarness(zcode.id, 'zcode');
    await controller.send(zcode.id, 'ZCODE-AFTER-COMPACTION');
    const continued = await idle(controller, store, zcode.id);
    const zcodeRequest = fixture.requests.find(({ path, body }) => path.includes('chat/completions') && JSON.stringify(body).includes('ZCODE-AFTER-COMPACTION'));
    assert(zcodeRequest && JSON.stringify(zcodeRequest.body).includes('COMPACTED-CONTINUATION-SUMMARY'));
    assert(!JSON.stringify(zcodeRequest.body).includes('ARCHIVE-ONLY-TOOL-OUTPUT'));
    const zcodeArchive = JSON.parse(await readFile(continued.canonicalPath!, 'utf8'));
    assert(bridgeEntries(zcodeArchive, 'archive').some(entry => 'kind' in entry && entry.kind === 'tool' && entry.output === 'ARCHIVE-ONLY-TOOL-OUTPUT'));
  } finally { await controller.close(); await fixture.close(); await cleanup(); }
});

test('native conversion prunes oversized tool output from DeepSeek resume while retaining it in the archive', async t => {
  const { root, cwd, cleanup } = await profile();
  t.after(cleanup);
  const store = new Store(root);
  await store.init();
  const runtime = path.resolve('.runtime');
  const settings = new SettingsStore(root, runtime, path.join(runtime, 'node', 'node.exe'), { protect: async value => value, unprotect: async value => value });
  await settings.init();
  await settings.save({ ...settings.value, deepseek: { ...settings.value.deepseek, home: path.join(root, 'dsh'), authMode: 'api',
    provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:9/anthropic' } }, { deepseek: 'local-fixture-only' });
  const controller = new Controller(store, settings, () => {});
  t.after(() => controller.close());
  const c = await controller.create(cwd, 'deepseek');
  const time = Date.now();
  const output = 'ARCHIVED-TOOL-OUTPUT-' + 'x'.repeat(800_000);
  const entries: PortableEntry[] = [
    { role: 'user', text: 'SAFE-USER-QUESTION', time },
    { kind: 'tool', callId: 'long-tool', name: 'Read', arguments: '{}', output, time },
    { role: 'assistant', text: 'SAFE-ANSWER', time },
  ];
  c.revision = 1;
  const source = path.join(store.directory(c.id), 'context', 'large.hbridge.json');
  c.canonicalPath = source;
  await atomicJson(source, messagesToBridge(entries, { id: c.id, title: c.title, cwd, createdAt: time, updatedAt: time }));
  c.bindings.deepseek = await controller.codec.import(c, 'deepseek');
  await controller.verifyNative(c);
  const exported = JSON.parse(await readFile(await controller.codec.snapshot(c), 'utf8'));
  assert(bridgeEntries(exported, 'archive').some(entry => 'kind' in entry && entry.kind === 'tool' && entry.output?.includes(output)));
  assert(!bridgeEntries(exported).some(entry => 'kind' in entry && entry.kind === 'tool' && entry.output?.includes(output)));
  assert(bridgeMessages(exported).some(entry => entry.text === 'SAFE-USER-QUESTION'));
  assert((await readFile(source, 'utf8')).includes(output));
});

test('desktop controller runs Codex via API settings and sends translated history to the next harness', { skip: !codex, timeout: 90_000 }, async () => {
  const { root, home, cwd, cleanup } = await profile();
  const fixture = await modelFixture();
  const runtime = path.resolve('.runtime');
  const store = new Store(root);
  await store.init();
  const settings = new SettingsStore(root, runtime, process.execPath, { protect: async value => value, unprotect: async value => value });
  await settings.init();
  await settings.save({ ...settings.value, defaultWorkspace: cwd, deepseek: { ...settings.value.deepseek, home: path.join(root, 'dsh'), authMode: 'api', baseUrl: fixture.origin + '/anthropic' },
    agents: { ...settings.value.agents, codex: { ...defaultAgentConnection('codex'),
      args: ['-c', 'model_providers.entrotect_api.request_max_retries=0', '-c', 'model_providers.entrotect_api.stream_max_retries=0', 'app-server', '--listen', 'stdio://'],
      executable: codex!, home, authMode: 'api', model: 'gpt-5.4', baseUrl: fixture.origin + '/v1' } },
  }, { codex: 'local-fixture-only', deepseek: 'local-fixture-only' });
  const controller = new Controller(store, settings, () => {});
  async function settled(id: string) {
    for (let n = 0; n < 600 && controller.isBusy(id); n++) await delay(50);
    const chat = store.get(id);
    if (chat.state !== 'idle') {
      const log = await readFile(path.join(store.directory(id), 'native.jsonl'), 'utf8').catch(() => '');
      const errors = log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).frame).filter(frame => frame.method === 'error').map(frame => frame.params.error);
      assert.fail(chat.error ?? `Unsettled ${chat.state}. Requests: ${fixture.requests.map(request => request.path).join(', ')}. Errors: ${JSON.stringify(errors)}`);
    }
    return chat;
  }
  try {
    const chat = await controller.create(cwd, 'deepseek');
    const { id } = chat;
    const time = Date.now();
    const source: PortableEntry[] = [
      { role: 'user', text: 'PREVIOUS-QUESTION-71', time },
      { kind: 'reasoning', text: 'ARCHIVED-REASONING-71', time },
      { kind: 'tool', callId: 'call_fixture_71', name: 'history_read', arguments: '{}', output: 'PREVIOUS-TOOL-RESULT-71', time },
      { kind: 'tool', callId: 'call_unfinished_72', name: 'history_read', arguments: '{}', time },
      { role: 'assistant', text: 'PREVIOUS-ANSWER-72', time },
    ];
    chat.revision = 1;
    chat.canonicalPath = path.join(store.directory(id), 'context', 'seed.hbridge.json');
    await atomicJson(chat.canonicalPath, messagesToBridge(source, { id, title: chat.title, cwd, createdAt: time, updatedAt: time }));
    await store.save(chat);
    await controller.selectModel(id, 'gpt-5.4');
    assert.equal(store.get(id).harness, 'codex');
    fixture.reply('CODEX-FIRST-REPLY-73');
    await controller.send(id, 'CODEX-FIRST-QUESTION-73');
    const first = await settled(id);
    assert((await store.items(id)).some(item => item.kind === 'assistant' && item.text.includes('CODEX-FIRST-REPLY-73')));
    const request = fixture.requests.find(entry => JSON.stringify(entry.body).includes('CODEX-FIRST-QUESTION-73'));
    assert(request?.body.input.some((item: any) => item.type === 'function_call_output' && item.output === 'PREVIOUS-TOOL-RESULT-71'));
    assert(!JSON.stringify(request.body).includes('call_unfinished_72'));
    assert(!JSON.stringify(request.body).includes('ARCHIVED-REASONING-71'));
    const archive = bridgeEntries(JSON.parse(await readFile(first.canonicalPath!, 'utf8')), 'archive');
    assert(archive.some(entry => 'kind' in entry && entry.kind === 'reasoning' && entry.text === 'ARCHIVED-REASONING-71'));
    assert(archive.some(entry => 'kind' in entry && entry.kind === 'tool' && entry.callId === 'call_unfinished_72' && entry.output === undefined));
    const nativeId = first.bindings.codex!.sessionId;
    fixture.hold(true);
    await controller.send(id, 'CODEX-PAUSE-74');
    for (let n = 0; n < 300 && !fixture.requests.some(request => JSON.stringify(request.body).includes('CODEX-PAUSE-74')); n++) await delay(50);
    assert(fixture.requests.some(request => JSON.stringify(request.body).includes('CODEX-PAUSE-74')));
    await controller.stop(id);
    assert.equal((await settled(id)).bindings.codex!.sessionId, nativeId);
    fixture.hold(false);
    fixture.reply('DEEPSEEK-CONTINUATION-75');
    await controller.selectModel(id, 'deepseek-flash');
    await controller.send(id, 'DEEPSEEK-CONTINUATION-QUESTION-75');
    await settled(id);
    assert(fixture.requests.some(request => request.path.includes('messages') && JSON.stringify(request.body).includes('CODEX-FIRST-REPLY-73')));
  } finally { await controller.close(); await fixture.close(); await cleanup(); }
});

for (const harness of ['kimi', 'opencode', 'codex'] as const) {
  const executable = harness === 'codex' ? codex : process.env[harness === 'kimi' ? 'ENTROTECT_TEST_KIMI' : 'ENTROTECT_TEST_OPENCODE'];
  test(`${harness} automatically syncs additions to the same native session and imports the independent reply`, { skip: !executable, timeout: 90_000 }, async () => {
    const { root, home, cwd, env, cleanup } = await profile();
    const fixture = await modelFixture();
    const store = new Store(path.join(root, 'app'));
    await store.init();
    const settings = new SettingsStore(store.root, path.resolve('.runtime'), process.execPath, { protect: async value => value, unprotect: async value => value });
    await settings.init();
    const configuration = { ...defaultAgentConnection(harness), executable: executable!, home, model: harness === 'opencode' ? 'fixture/fixture' : 'fixture', provider: 'fixture' };
    settings.value = { ...settings.value, defaultWorkspace: cwd, history: { autoImport: true, autoExport: true, importScope: 'all', exportScope: 'all' }, deepseek: { ...settings.value.deepseek, home: path.join(root, 'absent-dsh') },
      zcode: { ...settings.value.zcode, home: path.join(root, 'absent-zcode') }, agents: {
        kimi: { ...defaultAgentConnection('kimi'), home: path.join(root, 'absent-kimi') }, opencode: { ...defaultAgentConnection('opencode'), home: path.join(root, 'absent-opencode') },
        codex: { ...defaultAgentConnection('codex'), home: path.join(root, 'absent-codex') }, [harness]: configuration,
      } };
    const controller = new Controller(store, settings, () => {});
    let opened: AgentClient | undefined;
    const history = new HistoryService(controller);
    const sync = new HistorySync(controller, history, () => {}, async () => ({
      opencode: harness === 'opencode' && !!opened,
      codex: harness === 'codex' && !!opened,
      ...(harness === 'codex' && opened ? { codexWriters: [executable!] } : {}),
    }));
    await sync.init();
    Object.assign(env, { NO_PROXY: '127.0.0.1', KIMI_CODE_HOME: home, CODEX_HOME: home, XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root, OPENCODE_DB: path.join(home, 'opencode.db'), OPENCODE_DISABLE_MODELS_FETCH: 'true' });
    if (harness === 'kimi') await writeFile(path.join(home, 'config.toml'), [
      'default_model = "fixture"', '[providers.fixture]', 'type = "openai"', `base_url = "${fixture.origin}/v1"`, 'api_key = "local-fixture-only"',
      '[models.fixture]', 'provider = "fixture"', 'model = "fixture"', 'max_context_size = 32768',
    ].join('\n'));
    if (harness === 'codex') await writeFile(path.join(home, 'config.toml'), [
      'model = "fixture"', 'model_provider = "fixture"', '[model_providers.fixture]', 'name = "Fixture"',
      `base_url = "${fixture.origin}/v1"`, 'wire_api = "responses"', 'stream_max_retries = 0', 'request_max_retries = 0',
    ].join('\n'));
    if (harness === 'opencode') env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'fixture/fixture', provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL: `${fixture.origin}/v1`, apiKey: 'local-fixture-only' }, models: { fixture: { name: 'Fixture' } },
    } } });
    const open = () => AgentClient.connect(harness, { executable: executable!.endsWith('.mjs') ? process.execPath : executable!, args: executable!.endsWith('.mjs') ? [executable!, ...configuration.args] : configuration.args }, cwd, env);
    try {
      const chat = await controller.create(cwd, 'deepseek');
      chat.title = 'Synchronization fixture';
      chat.canonicalPath = path.join(store.directory(chat.id), 'context', 'fixture.hbridge.json');
      const start = Date.now();
      const messages: PortableEntry[] = [{ role: 'user', text: 'APP-START-19', time: start },
        { kind: 'tool', callId: 'call_history_read_20', name: 'history_read', arguments: '{"path":"first.txt"}', output: 'APP-INITIAL-TOOL-20', time: start },
        { role: 'assistant', text: 'APP-FIRST-REPLY-21', time: start + 1 }];
      const persist = async () => {
        chat.revision++;
        await atomicJson(chat.canonicalPath!, messagesToBridge(messages, { id: chat.id, title: chat.title, cwd, createdAt: start, updatedAt: Date.now() }));
        await store.save(chat);
      };
      await persist();
      const initial = await sync.run(true);
      assert.deepEqual(initial.issues, []);
      assert.equal(initial.exported, 1);
      const index = () => readFile(path.join(store.root, 'history-sync.json'), 'utf8').then(JSON.parse);
      const id = (await index()).links[0].sessionId;
      if (harness === 'opencode') {
        opened = await open();
        await opened.open(cwd, id);
      } else if (harness === 'codex') {
        opened = await open();
        await opened.open(cwd); // An unrelated thread must not block a safe append.
      }
      messages.push({ role: 'user', text: 'APP-APPEND-32', time: start + 2 },
        { kind: 'tool', callId: 'call_history_read_33', name: 'history_read', arguments: '{"path":"second.txt"}', output: 'APP-APPENDED-TOOL-33', time: start + 2 },
        { role: 'assistant', text: 'APP-APPEND-REPLY-34', time: start + 3 });
      await persist();
      const updated = await sync.run(true);
      assert.deepEqual(updated.issues, []);
      assert.equal(updated.exported, 2);
      assert.equal((await index()).links[0].sessionId, id);
      assert.equal(fixture.requests.length, 0, 'history sync must not call a model');
      const native = opened ?? await open();
      try {
        assert((await native.list(cwd)).some(row => row.id === id), 'the exported session must appear in the native project picker');
        assert((await native.list()).some(row => row.id === id), 'the exported session must appear in the global native list');
        const session = await native.open(cwd, id);
        if (harness === 'codex') {
          const current = await controller.agents.read('codex', home, cwd, id);
          const attempted: PortableEntry[] = [...current.history, { role: 'user', text: 'LOCKED-WRITE-40', time: Date.now() }];
          await assert.rejects(controller.agents.append(chat, 'codex', home, id, current.version, attempted,
            async () => ({ externalOpen: true, codexWriters: [null] })), /其他启动程序/);
          await assert.rejects(controller.agents.append(chat, 'codex', home, id, current.version, attempted,
            async () => ({ externalOpen: true, codexWriters: [executable!] })), /已在独立 Codex 中打开/);
          assert.equal((await controller.agents.read('codex', home, cwd, id)).version, current.version);
        }
        if (harness === 'opencode') {
          fixture.hold(true);
          const stop = new AbortController();
          const working = native.turn(session, 'OPEN-WRITE-GUARD-40', { signal: stop.signal });
          try {
            for (let n = 0; n < 300 && !fixture.requests.some(request => JSON.stringify(request.body).includes('OPEN-WRITE-GUARD-40')); n++) await delay(50);
            assert(fixture.requests.some(request => JSON.stringify(request.body).includes('OPEN-WRITE-GUARD-40')));
            const database = path.join(home, 'opencode.db');
            const current = await readOpenCodeStorage(database, id);
            assert.equal(current.openTurn, true);
            await assert.rejects(appendOpenCodeHistory(database, cwd, id, current.version, [
              ...current.history, { role: 'user', text: 'OUT-OF-BAND-WRITE-40', time: Date.now() },
            ], true), /此会话正在运行/);
            assert(!(await readOpenCodeStorage(database, id)).archived.some(item => item.text === 'OUT-OF-BAND-WRITE-40'));
          } finally { stop.abort(); await working; fixture.hold(false); }
        }
        fixture.reply('STANDALONE-REPLY-43');
        await native.turn(session, 'STANDALONE-QUESTION-41', { signal: AbortSignal.timeout(30_000) });
      } finally { await native.close(); opened = undefined; }
      assert(fixture.requests.some(request => JSON.stringify(request.body).includes('APP-APPEND-REPLY-34')));
      assert(fixture.requests.some(request => {
        const history = harness === 'codex' ? request.body.input : request.body.messages;
        return history?.some((item: any) => (item.type === 'function_call_output' || item.role === 'tool') && JSON.stringify(item).includes('APP-APPENDED-TOOL-33'));
      }), 'standalone model request must receive the structured tool result');
      if (harness === 'kimi') {
        const saved = await readKimiHistory(home, cwd, id);
        assert(saved.archived.some(message => message.text.includes('STANDALONE-REPLY-43')), saved.wireRaw.split('\n').slice(-9).join('\n'));
      }
      const imported = await sync.run(true);
      assert.deepEqual(imported.issues, []);
      assert.equal(store.list().length, 1);
      assert.equal(store.list()[0].id, chat.id);
      assert((await store.items(chat.id)).some(item => item.text.includes('STANDALONE-REPLY-43')));
      assert((await store.items(chat.id)).some(item => item.kind === 'tool' && item.toolName === 'history_read' && item.text === 'APP-APPENDED-TOOL-33'));
      await settings.save({ ...settings.value, agents: { ...settings.value.agents, [harness]: {
        ...configuration, authMode: 'api', baseUrl: `${fixture.origin}/v1`,
      } } }, { [harness]: 'local-fixture-only' });
      fixture.reply('DESKTOP-REPLY-55');
      await controller.send(chat.id, 'DESKTOP-CONTINUATION-53');
      for (let n = 0; n < 600 && controller.isBusy(chat.id); n++) await delay(50);
      const continued = store.get(chat.id);
      assert.equal(continued.state, 'idle', continued.error);
      assert(fixture.requests.some(request => JSON.stringify(request.body).includes('DESKTOP-CONTINUATION-53') && JSON.stringify(request.body).includes('STANDALONE-REPLY-43')));
      const republished = await sync.run(true);
      assert.deepEqual(republished.issues, []);
      assert.equal((await index()).links[0].sessionId, id);
      const source = { harness, location: home };
      const fingerprint = (await history.inspect(source, id)).fingerprint;
      settings.value.history = { autoExport: false, autoImport: false };
      fixture.reply('DESKTOP-PRIVATE-65');
      await controller.send(chat.id, 'DESKTOP-PRIVATE-63');
      for (let n = 0; n < 600 && controller.isBusy(chat.id); n++) await delay(50);
      assert.equal(store.get(chat.id).state, 'idle', store.get(chat.id).error);
      await sync.run(true);
      assert.equal((await history.inspect(source, id)).fingerprint, fingerprint);
      assert.equal(store.list().length, 1);
      const divergent = await open();
      try {
        fixture.reply('STANDALONE-BRANCH-77');
        await divergent.turn(await divergent.open(cwd, id), 'STANDALONE-BRANCH-75', { signal: AbortSignal.timeout(30_000) });
      } finally { await divergent.close(); }
      await sync.run(true);
      assert.equal(store.list().length, 1, 'disabled imports must not add the independent branch');
      const recovered = new HistorySync(controller, history, () => {}, async () => ({}));
      await recovered.init();
      settings.value.history = { autoExport: false, autoImport: true };
      try {
        assert.deepEqual((await recovered.run(true)).issues, []);
        const branch = store.list().find(entry => entry.id !== chat.id);
        assert(branch && (await store.items(branch.id)).some(item => item.text.includes('STANDALONE-BRANCH-77')));
        assert((await store.items(chat.id)).some(item => item.text.includes('DESKTOP-PRIVATE-65')));
        await recovered.run(true);
        assert.equal(store.list().length, 2, 'a recovered sync index must not import the branch twice');
      } finally { await recovered.stop(); }
    } finally { await opened?.close(); await sync.stop(); await controller.close(); await fixture.close(); await cleanup(); }
  });
}
