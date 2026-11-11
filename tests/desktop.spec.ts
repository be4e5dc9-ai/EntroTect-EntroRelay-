import { test, expect } from '@playwright/test';
import { launchTauri } from './tauri-launch';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../backend/store';
import { modelFixture } from './fixture-server';
import { defaultAgentConnection } from '../backend/settings';
import { agentHarnesses, harnesses } from '../shared/types';

test('desktop opens official login commands with app-owned profile directories', async () => {
  const root = path.resolve('.local', `desktop-login-${Date.now()}`);
  const executable = path.join(root, 'mock-cli.cjs');
  await mkdir(root, { recursive: true });
  await writeFile(executable, `
    if (process.argv[2] === 'login') {
      const home = process.cwd();
      const path = require('node:path');
      const fs = require('node:fs');
      fs.writeFileSync(path.join(home, 'login-command.json'), JSON.stringify({
        home, configured: home.endsWith('codex-account') ? process.env.CODEX_HOME : process.env.KIMI_CODE_HOME,
      }));
    }
  `);
  await atomicJson(path.join(root, 'settings.json'), { defaultWorkspace: root, agents: {
    codex: { ...defaultAgentConnection('codex'), executable, home: path.join(root, 'standalone-codex') },
    kimi: { ...defaultAgentConnection('kimi'), executable, home: path.join(root, 'standalone-kimi') },
  } });
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root });
  try {
    const page = await desktop.firstWindow();
    const settingsButton = page.getByRole('button', { name: /设置与连接/ });
    const nav = page.getByRole('navigation', { name: '设置导航' });
    for (const [id, name] of [['codex', 'Codex'], ['kimi', 'Kimi Code']]) {
      const select = async () => { await settingsButton.click(); await nav.getByRole('button', { name, exact: true }).click(); };
      await select();
      const isolated = page.getByRole('switch', { name: '在 EntroTect 中独立登录' });
      const login = page.getByRole('button', { name: '打开登录' });
      await expect(isolated).not.toBeChecked();
      await isolated.click();
      await expect(login).toBeDisabled();
      await page.getByRole('button', { name: '保存连接' }).click();
      await expect(nav).toBeHidden();
      await select();
      await expect(isolated).toBeChecked();
      await login.click();
      await expect(page.getByText('请在登录窗口完成操作。')).toBeVisible();
      const home = path.join(root, 'agents', `${id}-account`);
      await expect.poll(() => readFile(path.join(home, 'login-command.json'), 'utf8').then(JSON.parse).catch(() => null))
        .toEqual({ home, configured: home });
      await page.getByRole('button', { name: '返回工作区' }).click();
    }
  } finally { await desktop.close(); }
});

test('selecting a Codex model routes the desktop composer to a real Codex CLI', async () => {
  const fixture = await modelFixture();
  const root = path.resolve('.local', `desktop-codex-${Date.now()}`), workspace = path.join(root, 'project');
  await mkdir(workspace, { recursive: true });
  await atomicJson(path.join(root, 'settings.json'), { defaultWorkspace: workspace, agents: { codex: {
    ...defaultAgentConnection('codex'), home: path.join(root, 'codex'), model: 'gpt-5.4', authMode: 'api', baseUrl: `${fixture.origin}/v1`,
  } } });
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root });
  try {
    const page = await desktop.firstWindow();
    await page.evaluate(async () => {
      const api = window.entrotect!;
      const { settings } = await api.bootstrap();
      await api.saveSettings(settings, { codex: 'local-fixture-only' });
    });
    await page.getByRole('combobox', { name: '选择模型', exact: true }).selectOption('gpt-5.4');
    await expect(page.locator('.active-harness')).toHaveText('Codex');
    const catalogues = page.evaluate(async workspace => Promise.all([
      window.entrotect!.nativeModels({ harness: 'codex', workspace, modelId: 'gpt-5.4' }),
      window.entrotect!.nativeModels({ harness: 'codex', workspace, modelId: 'gpt-5.4-mini' }),
    ]), workspace);
    await page.getByRole('textbox', { name: '任务输入' }).fill('DESKTOP-CODEX-QUESTION-79');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('ALPHA-731', { timeout: 30_000 });
    await expect(page.getByRole('status', { name: '运行状态', exact: true })).toHaveText('就绪', { timeout: 30_000 });
    await catalogues;
    expect(fixture.requests.some(request => request.path.endsWith('/responses') && JSON.stringify(request.body).includes('DESKTOP-CODEX-QUESTION-79'))).toBe(true);
  } finally { await desktop.close(); await fixture.close(); }
});

test('automatic harness updates default on and each switch persists independently', async () => {
  const root=path.resolve('.local',`desktop-updates-${Date.now()}`);
  const desktop=await launchTauri({...process.env,ENTROTECT_DATA_DIR:root,ENTROTECT_TEST_UPDATES:'1'});
  try {
    const page=await desktop.firstWindow();
    await page.getByRole('button',{name:/设置与连接/}).click();
    const settings=page.getByRole('dialog',{name:'设置与连接'});
    const deepseek=settings.getByRole('switch',{name:'自动更新 DeepSeek Harness'});
    const zcode=settings.getByRole('switch',{name:'自动更新 ZCode'});
    await expect(deepseek).toBeChecked();
    await expect(zcode).toBeChecked();
    const codex=settings.getByRole('switch',{name:'自动更新 Codex'});
    await expect(codex).toBeChecked();
    await expect(settings.getByRole('switch',{name:'自动更新 Kimi Code'})).toBeChecked();
    await expect(settings.getByRole('switch',{name:'自动更新 OpenCode'})).toBeChecked();
    await deepseek.click();
    await codex.click();
    await settings.getByRole('button',{name:'保存设置'}).click();
    await expect(settings).not.toBeVisible();
    expect(JSON.parse(await readFile(path.join(root,'settings.json'),'utf8')).harnessUpdates)
      .toEqual({deepseek:false,zcode:true,kimi:true,opencode:true,codex:false});
    await page.getByRole('button',{name:/设置与连接/}).click();
    await expect(deepseek).not.toBeChecked();
    await expect(zcode).toBeChecked();
    await expect(codex).not.toBeChecked();
  } finally { await desktop.close(); }
});

test('closing the desktop does not start a second history scan', async () => {
  const root = path.resolve('.local', `desktop-close-sync-${Date.now()}`);
  const home = path.join(root, 'codex');
  const calls = path.join(root, 'history-list.log');
  const executable = path.join(root, 'mock-codex.cjs');
  await mkdir(home, { recursive: true });
  await writeFile(executable, `
    const fs = require('node:fs');
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      if (request.method === 'thread/list') fs.appendFileSync(${JSON.stringify(calls)}, 'scan\\n');
      const result = request.method === 'thread/list' ? {data: []} : {};
      process.stdout.write(JSON.stringify({id: request.id, result}) + '\\n');
    });
  `);
  await atomicJson(path.join(root, 'settings.json'), { defaultWorkspace: root, history: { autoImport: true, autoExport: false, importScope: 'all' },
    startup: { followLast: false }, agents: { codex: { ...defaultAgentConnection('codex'), executable, home } } });
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root, ENTROTECT_TEST_SYNC: '1', ENTROTECT_TEST_UPDATES: '0' });
  let closed = false;
  try {
    const page = await desktop.firstWindow();
    await expect.poll(() => page.evaluate(async () => {
      const status = await window.entrotect!.historySyncStatus();
      return !!status.lastSyncAt && !status.running;
    })).toBe(true);
    expect(await readFile(calls, 'utf8')).toBe('scan\n');
    const start = Date.now();
    await desktop.close();
    closed = true;
    expect(Date.now() - start).toBeLessThan(7_000);
    expect(await readFile(calls, 'utf8')).toBe('scan\n');
  } finally { if (!closed) await desktop.close(); }
});

test('desktop finds all bundled CLIs with updates disabled and no external CLI on PATH', async () => {
  const root = path.resolve('.local', `desktop-bundled-clis-${Date.now()}`);
  await atomicJson(path.join(root, 'settings.json'), { defaultWorkspace: root });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const systemPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const desktop = await launchTauri({ ...env, PATH: systemPath, ENTROTECT_DATA_DIR: root, ENTROTECT_TEST_UPDATES: '0', OPENCODE_DISABLE_MODELS_FETCH: 'true' });
  try {
    const page = await desktop.firstWindow();
    const state = await page.evaluate(async () => ({ boot: await window.entrotect!.bootstrap(), updates: await window.entrotect!.harnessUpdateStatus() }));
    expect(state.boot.health.filter(runtime => runtime.available).map(runtime => runtime.harness)).toEqual([...harnesses]);
    const runtimeRoot = process.env.ENTROTECT_TEST_EXE ? path.join(path.dirname(process.env.ENTROTECT_TEST_EXE), 'runtimes') : path.resolve('.runtime');
    const versions = JSON.parse(await readFile(path.join(runtimeRoot, 'versions.json'), 'utf8'));
    const route = page.getByRole('combobox', { name: '选择 Harness' });
    await page.getByRole('textbox', { name: '任务输入' }).fill('内置 Harness 启动检查');
    for (const harness of agentHarnesses) {
      expect(state.updates[harness]).toEqual({ state: 'idle', version: versions[harness] });
      const runtime = state.boot.health.find(entry => entry.harness === harness);
      expect(runtime?.executable).toContain(path.join(runtimeRoot, harness) + path.sep);
      expect(await readdir(path.join(root, 'harness-runtimes', harness))).toEqual([]);
      await route.selectOption(harness);
      await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  } finally { await desktop.close(); }
});


test('desktop executes both native harnesses, switches context, pauses, and restores from disk', async () => {
  const fixture = await modelFixture();
  const root=path.resolve('.local',`desktop-e2e-${Date.now()}`),workspace=path.join(root,'project with spaces');
  await mkdir(workspace,{recursive:true});
  const settings = {
    deepseek:{executable:'@bundled/node',args:['@bundled/deepseek','--profile','sdk'],home:path.join(root,'dsh-home'),provider:'deepseek-official',model:'deepseek-flash',authMode:'api',baseUrl:fixture.origin},
    zcode:{executable:'@bundled/node',args:['@bundled/zcode','agent-server','--stdio'],home:path.join(root,'zcode-home'),provider:'test-local',model:'glm-5.3',reasoning:'high',authMode:'api',baseUrl:fixture.origin+'/v1'},
    defaultWorkspace:workspace,
  };
  await atomicJson(path.join(root,'settings.json'),settings);
  const env={...process.env,ENTROTECT_DATA_DIR:root};delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.ENTROTECT_TEST_EXE;
  const launch = () => launchTauri(env);
  let desktop=await launch();
  try {
    let page=await desktop.firstWindow();
    await page.getByRole('heading',{name:'想法，从这里展开。'}).waitFor();
    const initial=await page.evaluate(()=>window.entrotect!.bootstrap());
    expect(initial.health.filter(runtime => ['deepseek', 'zcode'].includes(runtime.harness)).every(runtime=>runtime.available)).toBe(true);
    if(packaged) expect(initial.settings.deepseek.args[0]).toContain('runtimes');
    await page.evaluate(async()=>{const boot=await window.entrotect!.bootstrap();await window.entrotect!.saveSettings(boot.settings,{deepseek:'local-dpapi-deepseek-key',zcode:'local-dpapi-zcode-key'});});
    expect(await readFile(path.join(root,'settings.json'),'utf8')).toContain('@bundled/node');
    await page.getByRole('button',{name:/设置与连接/}).click();
    const preferences=page.getByRole('dialog',{name:'设置与连接'});
    await expect(preferences.getByRole('switch',{name:'启动上次使用的 Harness'})).toBeChecked();
    await preferences.getByRole('switch',{name:'随应用启动 DeepSeek Harness'}).click();
    await preferences.getByRole('switch',{name:'随应用启动 ZCode'}).click();
    await preferences.getByRole('button',{name:'保存设置'}).click();
    await expect(preferences).not.toBeVisible();
    expect(JSON.parse(await readFile(path.join(root,'settings.json'),'utf8')).startup)
      .toEqual({followLast:true,additional:['deepseek','zcode']});
    await page.getByRole('textbox',{name:'任务输入'}).fill('请记住 ALPHA-731，并简短确认。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('combobox',{name:'选择模型',exact:true})).toBeDisabled();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await expect(page.locator('.message.assistant')).toContainText('第一轮确认完成');
    const encrypted=await readFile(path.join(root,'credentials.v2.json'),'utf8');
    expect(encrypted).not.toContain('local-dpapi');
    fixture.reply('第二轮 ZCode 已读到 ALPHA-731，新增 BETA-842。');
    await page.getByRole('combobox',{name:'选择模型',exact:true}).selectOption('glm-5.3');
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    await page.getByRole('textbox',{name:'任务输入'}).fill('新增 BETA-842，请继续。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await expect(page.locator('.message.assistant').last()).toContainText('第二轮 ZCode');
    expect(JSON.stringify(fixture.requests.find(r=>r.path.includes('chat/completions'))?.body.messages)).toContain('ALPHA-731');
    await page.getByTitle('会话菜单',{exact:true}).click();
    await page.getByRole('menuitem',{name:'查看统一上下文'}).click();
    await expect(page.locator('.context-modal pre')).toContainText('BETA-842');
    await page.locator('.context-modal header button').click();
    fixture.reply('第三轮 DeepSeek 已恢复 ALPHA-731 与 BETA-842。');
    await page.getByRole('combobox',{name:'选择模型',exact:true}).selectOption('deepseek-flash');
    await expect(page.locator('.active-harness')).toHaveText('DeepSeek Harness');
    await page.getByRole('textbox',{name:'任务输入'}).fill('检查全部历史。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await expect(page.locator('.message.assistant').last()).toContainText('第三轮 DeepSeek');
    expect(JSON.stringify(fixture.requests.filter(r=>r.path.includes('messages')).at(-1)?.body.messages)).toContain('BETA-842');
    const context=await page.evaluate(async()=>{const b=await window.entrotect!.bootstrap();return window.entrotect!.context(b.conversations[0].id);});
    expect(JSON.stringify(context.canonical)).not.toContain('local-dpapi');
    await expect(async()=>{const file=path.join(root,'conversations',(await page.evaluate(async()=>(await window.entrotect!.bootstrap()).conversations[0].id)),'native','zcode','provider.runtime.json');await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});}).toPass();
    await page.screenshot({path:'.local/screenshots/conversation.png'});
    // Manual override keeps the selected model; the local provider supports both.
    fixture.reply('手动 ZCode 执行 DeepSeek 模型，仍然保留全部历史。');
    await page.getByRole('combobox',{name:'选择 Harness',exact:true}).selectOption('zcode');
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    await expect(page.getByRole('combobox',{name:'选择模型',exact:true})).toHaveValue('deepseek-flash');
    await page.getByRole('textbox',{name:'任务输入'}).fill('保持模型，使用手动选择的 harness。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await expect(page.locator('.message.assistant').last()).toContainText('手动 ZCode 执行 DeepSeek 模型');
    expect(fixture.requests.filter(r=>r.path.includes('chat/completions')).at(-1)?.body.model).toBe('deepseek-flash');
    await page.getByRole('combobox',{name:'选择 Harness',exact:true}).selectOption('auto');
    await expect(page.locator('.active-harness')).toHaveText('DeepSeek Harness');
    // Pause a real in-flight SDK request and prohibit switching until it settles.
    fixture.hold(true);
    await page.getByRole('textbox',{name:'任务输入'}).fill('这是一轮将被主动暂停的工作。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('正在工作');
    await page.getByRole('button',{name:'暂停任务'}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await page.getByRole('combobox',{name:'选择模型',exact:true}).selectOption('glm-5.3');
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    await page.getByRole('textbox',{name:'任务输入'}).fill('这轮 ZCode 也将暂停。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('正在工作');
    await page.getByRole('button',{name:'暂停任务'}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    fixture.hold(false);
    // Restart the desktop and restore the last open native session.
    await desktop.close();
    desktop=await launch();page=await desktop.firstWindow();
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    await expect(page.locator('.message.assistant').last()).toContainText('手动 ZCode');
    await page.getByRole('combobox',{name:'选择模型',exact:true}).selectOption('deepseek-flash');
    await expect(page.locator('.active-harness')).toHaveText('DeepSeek Harness');
    fixture.reply('重启后的原生会话已继续。');
    await page.getByRole('textbox',{name:'任务输入'}).fill('恢复并继续。');await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await expect(page.locator('.message.assistant').last()).toContainText('重启后的原生会话');
    // A settings change invalidates the warm route so this exercises cold startup.
    await page.evaluate(async()=>{
      const api=window.entrotect!;
      await api.selectReasoning((await api.bootstrap()).conversations[0].id,'max');
    });
    await page.getByRole('textbox',{name:'任务输入'}).fill('这条输入会在执行器启动时取消。');
    await page.getByRole('button',{name:'发送任务',exact:true}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('正在启动');
    await page.getByRole('button',{name:'暂停任务'}).click();
    await expect(page.getByRole('status',{name:'运行状态',exact:true})).toHaveText('就绪');
    await page.getByRole('combobox',{name:'选择模型',exact:true}).selectOption('glm-5.3');
    await expect(page.locator('.active-harness')).toHaveText('ZCode');
    console.log('DESKTOP_NATIVE_ROUND_TRIP_OK',root);
  } finally {await desktop.close();await fixture.close();}
});
