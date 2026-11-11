import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Controller } from '../backend/controller';
import { Store, atomicJson } from '../backend/store';
import { RpcProcess } from '../backend/rpc';
import type { Settings } from '../shared/types';

// Real vendor harnesses and real codec; only the remote model is substituted.
const root = path.resolve('.local', `native-smoke-${Date.now()}`);
const workspace = path.join(root, 'project'); await mkdir(workspace, { recursive: true });
// A malformed transport frame must still terminate the underlying process.
const broken = new RpcProcess({ executable: process.execPath, args: ['-e', "console.log('not-json');setInterval(()=>{},1000)"], home: root, provider: '', model: '', authMode: 'native', baseUrl: '' }, workspace, process.env, false);
await new Promise<void>(resolve => broken.once('closed', () => resolve()));
assert.equal(broken.exited, false);await broken.close();assert.equal(broken.exited, true);
await writeFile(path.join(workspace, 'evidence.txt'), 'fixture-evidence');
const requests: { path: string; body: any }[] = [];
let reply = 'DeepSeek 第一轮已完成。标记 ALPHA-731。';
let toolPlan: 'write' | 'read' | 'shell' | null = 'write';
let toolIssued = false;
let slowShell = false;
let onHeldModelClose: (() => void) | undefined;
const generatedFile = path.join(workspace, 'created-by-harness.txt');
const shellStarted = path.join(workspace, 'shell-started.txt');
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  requests.push({ path: req.url!, body });
  if (req.method === 'GET') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'glm-5.3' }] })); return; }
  if (onHeldModelClose) {
    res.once('close', onHeldModelClose);
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    return;
  }
  console.log('MODEL_REQUEST', req.url, body.model, JSON.stringify(body.messages).length);
  let tool: { id: string; name: string; input: Record<string, unknown> } | undefined;
  if (toolPlan && !toolIssued) {
    const available = (body.tools ?? []).map((t: any) => ({ name: t.name ?? t.function?.name, schema: t.input_schema ?? t.function?.parameters }));
    const chosen = available.find((t: any) => toolPlan === 'write' ? /^(write|write_file)$/i.test(t.name) : toolPlan === 'read' ? /^(read|read_file)$/i.test(t.name) : /^(pwsh|powershell|bash)$/i.test(t.name));
    assert(chosen, `Native ${toolPlan} tool missing: ${available.map((t: any) => t.name).join(', ')}`);
    const props = chosen.schema?.properties ?? {};
    const key = Object.hasOwn(props, 'file_path') ? 'file_path' : 'path';
    tool = { id: `call_fixture_${Date.now()}`, name: chosen.name, input: toolPlan === 'shell' ? { command: slowShell ? `Set-Content -LiteralPath '${shellStarted}' -Value started; Start-Sleep -Seconds 30; Write-Output TOO_LATE` : /bash/i.test(chosen.name) ? 'printf SHELL_EXECUTED' : 'Write-Output SHELL_EXECUTED', description: 'Print a harmless integration-test marker' } : { [key]: generatedFile, ...(toolPlan === 'write' ? { content: 'NATIVE_WRITE_OK' } : {}) } };
    console.log('NATIVE_TOOL', tool.name, JSON.stringify(tool.input)); toolIssued = true;
  } else if (toolIssued && toolPlan) toolPlan = null;
  res.setHeader('Content-Type', 'text/event-stream');
  if (req.url?.includes('messages')) {
    const event = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    event('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: reply } });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    event('message_stop', { type: 'message_stop' }); res.end();
  } else {
    const base = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: body.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const dshHome = path.join(root, 'dsh-home'), zcodeHome = path.join(root, 'zcode-home');
const providerFile = path.join(root, 'provider.json');
await atomicJson(providerFile, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'test-local', providerName: 'Local Fixture', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'local-fixture-only' }, api: { type: 'openai-chat-completions', baseUrl: origin + '/v1' }, personalModelIds: ['glm-5.3'] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'test-local', modelId: 'glm-5.3' } } });
const settings: Settings = {
  deepseek: { executable: process.execPath, args: [path.resolve('.runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'sdk'], home: dshHome, provider: 'deepseek-official', model: 'deepseek-flash', authMode: 'native', baseUrl: origin },
  zcode: { executable: process.execPath, args: [path.resolve('.runtime/zcode/resources/glm/zcode.cjs'), 'agent-server', '--stdio'], home: zcodeHome, provider: 'test-local', model: 'glm-5.3', reasoning: 'high', authMode: 'api', baseUrl: origin },
  defaultWorkspace: workspace,
};
const fakeSettings = {
  value: settings,
  usesBundledLauncher: () => true,
  async environment(h: string, nativeRoot: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: origin, DSH_HOME: dshHome, ZCODE_DATA_BASE_DIR: zcodeHome, ZCODE_SESSION_DB_PATH: path.join(nativeRoot, 'zcode', 'db.sqlite'), ZCODE_STORAGE_DIR: path.join(nativeRoot, 'zcode') };
    await mkdir(path.join(nativeRoot,'zcode'), { recursive:true });
    if (h === 'zcode' && settings.zcode.authMode === 'api') {
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(nativeRoot, 'zcode', 'provider.runtime.json');
      await copyFile(providerFile, env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
    } else delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    delete env.ELECTRON_RUN_AS_NODE; return env;
  },
  async cleanupRuntime(nativeRoot: string) {
    await unlink(path.join(nativeRoot, 'zcode', 'provider.runtime.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  },
};
const store = new Store(path.join(root, 'app')); await store.init();
const controller = new Controller(store, fakeSettings as any, event => {
  if (event.type === 'conversation') console.log('STATE', event.conversation.harness, event.conversation.state, event.conversation.error ?? '');
  if (event.type === 'item') console.log('ITEM', event.item.kind, event.item.text.slice(0,120));
  if (event.type === 'diagnostic') void writeFile(path.join(root, 'last-diagnostic.txt'), event.message);
});
async function idle(id: string, owner = controller) {
  const start = Date.now();
  while (Date.now()-start < 100_000) { const c = owner.store.get(id); if (c.state === 'error') throw new Error(c.error); if (c.state === 'idle' && !owner.isBusy(id)) return; await new Promise(r=>setTimeout(r,150)); }
  throw new Error('Native run did not finish');
}
async function resident(id: string, owner = controller) {
  const runtime = owner['residents'].get(id);
  assert(runtime, 'Missing resident harness for ' + id);
  const rpc = await runtime.ready;
  assert(rpc.available && rpc.child.pid, 'Resident harness has already exited');
  return rpc;
}
async function pauseHeldModel(id: string, prompt: string) {
  const beforeHold = requests.length;
  const heldModel = new Promise<void>(resolve => { onHeldModelClose = resolve; });
  try {
    await controller.send(id, prompt);
    const started = Date.now();
    while (requests.length === beforeHold && Date.now() - started < 15_000) await new Promise(r => setTimeout(r, 50));
    assert(requests.length > beforeHold, 'The held request must reach the local model');
    await Promise.all([controller.stop(id), controller.stop(id)]);
    await idle(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([heldModel, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Pause did not abort the model stream')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  } finally { onHeldModelClose = undefined; }
}
try {
  const c = await controller.create(workspace, 'deepseek');
  await controller.send(c.id, '请记住原始标记 ALPHA-731，并创建指定的测试文件。'); await idle(c.id);
  assert.equal(await readFile(generatedFile, 'utf8'), 'NATIVE_WRITE_OK', 'DeepSeek did not execute the native write tool');
  assert((await store.items(c.id)).some(i=>i.text.includes('DeepSeek 第一轮')));
  assert(c.canonicalPath); const first = JSON.parse(await readFile(c.canonicalPath,'utf8'));
  assert(JSON.stringify(first).includes('ALPHA-731'));
  console.log('FIRST_SNAPSHOT_OK');
  const deepseek = await resident(c.id);
  reply = '同一 DeepSeek 进程里的第二轮。';
  await controller.send(c.id, '继续使用这个 DeepSeek 会话。'); await idle(c.id);
  assert.equal((await resident(c.id)).child.pid, deepseek.child.pid);
  assert.equal((await store.items(c.id)).filter(item => item.text === reply).length, 1);
  console.log('DEEPSEEK_REUSED_PID', deepseek.child.pid);
  await controller.switchHarness(c.id, 'zcode');
  assert(deepseek.exited, 'Switch must retire the previous DeepSeek process');
  toolPlan = 'read'; toolIssued = false;
  reply = 'ZCode 已读取 ALPHA-731，追加标记 BETA-842。';
  await controller.send(c.id, '请读取之前的标记，并记住新增标记 BETA-842。'); await idle(c.id);
  const zcodeRequest = requests.find(r=>r.path.includes('chat/completions'));
  assert(zcodeRequest, 'ZCode never reached the local model');
  assert(JSON.stringify(zcodeRequest.body.messages).includes('ALPHA-731'), 'Original context missing from ZCode model request');
  const zcodeToolResult = requests.filter(r=>r.path.includes('chat/completions')).at(-1)!;
  assert(zcodeToolResult.body.messages.some((m: any)=>m.role === 'tool' && JSON.stringify(m.content).includes('NATIVE_WRITE_OK')), 'ZCode did not execute its native read tool');
  assert(!JSON.stringify(zcodeRequest.body.messages).includes('You are an AI agent powered by DeepSeek Harness'), 'Source harness instructions leaked into target model context');
  console.log('DEEPSEEK_TO_ZCODE_OK');
  const zcode = await resident(c.id);
  const runtimeConfig = path.join(controller.codec.nativeRoot(c), 'zcode', 'provider.runtime.json');
  await assert.rejects(readFile(runtimeConfig), { code: 'ENOENT' });
  reply = '同一 ZCode 进程里的第二轮。';
  await controller.send(c.id, '继续使用这个 ZCode 会话。'); await idle(c.id);
  assert.equal((await resident(c.id)).child.pid, zcode.child.pid);
  assert.equal((await store.items(c.id)).filter(item => item.text === reply).length, 1);
  await assert.rejects(readFile(runtimeConfig), { code: 'ENOENT' });
  console.log('ZCODE_REUSED_PID', zcode.child.pid);
  const zcodeSessionId = c.bindings.zcode!.sessionId;
  await pauseHeldModel(c.id, '取消本轮 ZCode 请求。');
  assert.equal((await resident(c.id)).child.pid, zcode.child.pid);
  assert.equal(c.bindings.zcode!.revision, c.revision);
  reply = '暂停后 ZCode 原进程继续。';
  await controller.send(c.id, '取消后继续使用原 ZCode 会话。'); await idle(c.id);
  assert.equal((await resident(c.id)).child.pid, zcode.child.pid);
  assert.equal(c.bindings.zcode!.sessionId, zcodeSessionId);
  assert((await store.items(c.id)).some(item => item.text === reply));
  console.log('ZCODE_NATIVE_PAUSE_REUSED_PID', zcode.child.pid);
  const request = zcode.request.bind(zcode);
  zcode.request = (method, params, timeout) => method === 'session/stop'
    ? Promise.reject(new Error('Injected native stop failure')) : request(method, params, timeout);
  await pauseHeldModel(c.id, '验证原生暂停失败时安全关闭。');
  assert(zcode.exited, 'An unconfirmed pause must retire the process');
  reply = '取消失败后的冷恢复已完成。';
  await controller.send(c.id, '从已保存的 ZCode 会话继续。'); await idle(c.id);
  assert.notEqual((await resident(c.id)).child.pid, zcode.child.pid);
  assert.equal(c.bindings.zcode!.sessionId, zcodeSessionId);
  assert((await store.items(c.id)).some(item => item.text === reply));
  console.log('PAUSE_FAILURE_FALLBACK_OK');
  await controller.switchHarness(c.id, 'deepseek'); reply = 'DeepSeek 已恢复 ALPHA-731 和 BETA-842。';
  await controller.send(c.id, '请核对两个历史标记。'); await idle(c.id);
  const last = requests.filter(r=>r.path.includes('messages')).at(-1)!;
  assert(JSON.stringify(last.body.messages).includes('BETA-842'), 'ZCode additions missing from restored DeepSeek request');
  assert(JSON.stringify(last.body.messages).includes('ALPHA-731'));
  // The native-login path uses the vendor's standalone account/config loader.
  const provider = JSON.parse(await readFile(providerFile,'utf8')); provider.config.defaultModelSelection.options={reasoningLevel:'high'}; await atomicJson(providerFile,provider);
  await atomicJson(path.join(zcodeHome,'.zcode','v2','provider_config.json'),provider);
  settings.zcode.authMode='native';settings.zcode.provider='';settings.zcode.model='';
  await controller.switchHarness(c.id,'zcode');reply='原生配置模式的 ZCode 已继续。';
  await controller.send(c.id,'使用原生配置继续当前任务。');await idle(c.id);
  assert((await store.items(c.id)).some(i=>i.text.includes('原生配置模式')));
  console.log('ZCODE_NATIVE_CONFIG_OK');
  await controller.switchHarness(c.id,'deepseek');toolPlan='shell';toolIssued=false;reply='原生命令已执行。';
  await controller.send(c.id,'请执行一个只输出测试标记的命令。');await idle(c.id);
  assert((await store.items(c.id)).some(i=>i.kind==='tool' && i.text.includes('SHELL_EXECUTED')),'Native shell did not execute');
  console.log('NATIVE_SHELL_OK');
  const pausingDeepSeek = await resident(c.id);
  slowShell=true;toolPlan='shell';toolIssued=false;
  await controller.send(c.id,'启动一个命令，准备主动暂停。');
  const waiting=Date.now();while(Date.now()-waiting<15000){try{await readFile(shellStarted);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.equal((await readFile(shellStarted,'utf8')).trim(),'started');
  await controller.stop(c.id);await idle(c.id);
  assert.equal((await resident(c.id)).child.pid, pausingDeepSeek.child.pid);
  assert.equal(c.bindings.deepseek!.revision, c.revision);
  toolPlan = null; slowShell = false; reply = '暂停后 DeepSeek 原进程继续。';
  await controller.send(c.id, '取消工具后继续原 DeepSeek 会话。'); await idle(c.id);
  assert.equal((await resident(c.id)).child.pid, pausingDeepSeek.child.pid);
  assert((await store.items(c.id)).some(item => item.text === reply));
  console.log('DEEPSEEK_NATIVE_PAUSE_REUSED_PID', pausingDeepSeek.child.pid);
  reply='暂停后由 ZCode 继续。';
  await controller.switchHarness(c.id,'zcode');await controller.send(c.id,'在暂停后继续。');await idle(c.id);
  await controller.switchHarness(c.id,'deepseek');
  console.log('IN_FLIGHT_TOOL_PAUSE_OK');

  await controller.close();
  settings.zcode.authMode = 'api'; settings.zcode.provider = 'test-local'; settings.zcode.model = 'glm-5.3';
  settings.startup = { followLast: true, additional: ['deepseek', 'zcode'] };
  const reopenedStore = new Store(store.root); await reopenedStore.init();
  const reopened = new Controller(reopenedStore, fakeSettings as any, () => {});
  try {
    await reopened.initStartup();
    assert.deepEqual(reopened.startupRoute, { harness: 'deepseek', conversationId: c.id });
    const beforePrewarming = requests.length;
    reopened.startPrewarming();
    await reopened['prewarming'];
    assert.equal(requests.length, beforePrewarming, 'Startup must not invoke a model');
    const warmedDeepSeek = await resident(c.id, reopened);
    const warmedDraft = reopened['drafts'].get('zcode');
    assert(warmedDraft);
    const warmedZCode = await resident(warmedDraft.id, reopened);
    assert.equal(reopenedStore.list().length, 1, 'Warm drafts should not appear in chat history');
    reply = '复用预热后的 DeepSeek 进程。';
    await reopened.send(c.id, '应用重启后继续 DeepSeek 对话。'); await idle(c.id, reopened);
    assert.equal((await resident(c.id, reopened)).child.pid, warmedDeepSeek.child.pid);
    const chat = await reopened.create(workspace, 'zcode');
    assert.equal(chat.id, warmedDraft.id);
    reply = '复用预热后的 ZCode 进程。';
    await reopened.send(chat.id, '使用预热后的 ZCode。'); await idle(chat.id, reopened);
    assert.equal((await resident(chat.id, reopened)).child.pid, warmedZCode.child.pid);
    await reopened.close();
    assert(warmedDeepSeek.exited && warmedZCode.exited, 'Shutdown must close both idle processes');
    console.log('STARTUP_PREWARMS_BOTH_HARNESSES');
  } finally { await reopened.close(); }
  await atomicJson(path.join(root, 'report.json'), { success:true, conversation:c, requests:requests.map(r=>({path:r.path,model:r.body.model})), assertions:['native DeepSeek file write','canonical export','native ZCode file read','native DeepSeek round-trip with added context','ZCode standalone native provider config','native shell execution','pause an in-flight shell and switch twice'] });
  console.log('ROUND_TRIP_OK', root);
} finally { await controller.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
