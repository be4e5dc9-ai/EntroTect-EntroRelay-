import {test,expect} from '@playwright/test';
import path from 'node:path';
import {launchTauri} from './tauri-launch';
import { mkdir, writeFile } from 'node:fs/promises';
import { atomicJson } from '../backend/store';
test('Tauri interface exposes automatic model routing and both connection modes',async()=>{
 const desktop=await launchTauri({...process.env,ENTROTECT_DATA_DIR:path.resolve('.local',`tauri-ui-${Date.now()}`)});
 try {
  const page=await desktop.firstWindow();
  await expect(page.getByRole('heading',{name:'想法，从这里展开。'})).toBeVisible();
  await page.screenshot({path:'.local/screenshots/desktop-tauri.png'});
  const model=page.getByRole('combobox',{name:'选择模型',exact:true});
  const harness=page.getByRole('combobox',{name:'选择 Harness',exact:true});
  await harness.click();
  await expect.poll(()=>harness.evaluate(element=>element.matches(':open'))).toBe(true);
  const automatic=harness.getByRole('option',{name:'自动 · DeepSeek Harness',exact:true});
  await expect(automatic).toHaveCSS('background-color','rgb(250, 238, 244)');
  const optionBox=(await automatic.boundingBox())!;
  const triggerBox=(await harness.boundingBox())!;
  expect(optionBox.y+optionBox.height).toBeLessThan(triggerBox.y);
  await page.keyboard.press('Escape');
  await expect(harness).toHaveValue('auto');
  await expect.poll(()=>harness.evaluate(element=>element.matches(':open'))).toBe(false);
  await model.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.active-harness')).toHaveText('ZCode');
  await harness.click();
  await harness.getByRole('option',{name:'DeepSeek Harness',exact:true}).click();
  await expect(page.locator('.active-harness')).toHaveText('DeepSeek Harness');
  await expect(model).toHaveValue('glm-5.3');
  for (const [id, name] of [['kimi', 'Kimi Code'], ['opencode', 'OpenCode'], ['codex', 'Codex']]) {
    await model.selectOption(`${id}:default`);
    await expect(page.locator('.active-harness')).toHaveText(name);
    await expect(harness).toHaveValue('auto');
  }
  await page.getByRole('button',{name:'配置 Codex',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'设置导航'}).getByRole('button',{name:'Codex',exact:true})).toHaveAttribute('aria-current','page');
  await page.getByRole('button',{name:'返回工作区',exact:true}).click();
  await model.selectOption('deepseek-flash');
  await expect(harness).toHaveValue('auto');
  await page.getByRole('button',{name:/设置与连接/}).click();
  const nav=page.getByRole('navigation',{name:'设置导航'});
  await nav.getByRole('button',{name:'外观',exact:true}).click();
  await page.getByRole('button',{name:/^月之暗面/}).click();
  await nav.getByRole('button',{name:'用量',exact:true}).click();
  await page.locator('[aria-label="用量来源"]').getByRole('button',{name:'GLM / ZCode'}).click();
  const region=page.getByRole('combobox',{name:'查询区域'});
  await region.click();
  await expect.poll(()=>region.evaluate(element=>element.matches(':open'))).toBe(true);
  await expect(region.getByRole('option',{name:'Z.ai 国际版'})).toHaveCSS('background-color','rgb(30, 30, 30)');
  await page.keyboard.press('Escape');
  await expect(region).toBeVisible();
  await expect.poll(()=>region.evaluate(element=>element.matches(':open'))).toBe(false);
  await nav.getByRole('button',{name:'DeepSeek',exact:true}).click();
  await expect(page.getByRole('button',{name:'复用原生登录',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'使用 API Key',exact:true}).click();
  await page.locator('input[type=password]').fill('test-interface-deepseek-not-a-real-key');
  await page.getByRole('textbox',{name:'API 地址'}).fill('https://example.invalid/deepseek');
  await page.screenshot({path:'.local/screenshots/settings-tauri.png'});
  await page.getByRole('dialog',{name:'设置与连接'}).getByRole('button',{name:'GLM / ZCode',exact:true}).click();
  await page.getByRole('button',{name:'使用 API Key',exact:true}).click();
  await page.locator('input[type=password]').fill('test-interface-zcode-not-a-real-key');
  await page.getByRole('textbox',{name:'API 地址'}).fill('https://example.invalid/glm');
  await page.getByRole('button',{name:'保存连接',exact:true}).click();
  await expect(page.locator('.settings-modal')).toBeHidden();
  const boot=await page.evaluate(()=>window.entrotect!.bootstrap());
  expect(boot.settings.hasDeepseekKey&&boot.settings.hasZcodeKey).toBe(true);
 }finally{await desktop.close();}
});

test('native model groups update the reasoning picker and the slash command menu', async () => {
 const executable = process.env.ENTROTECT_TEST_KIMI;
 test.skip(!executable, 'Set ENTROTECT_TEST_KIMI to the Kimi Code native entry');
 const root = path.resolve('.local', `native-options-ui-${Date.now()}`), workspace = path.join(root, 'project'), home = path.join(root, 'kimi');
 await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true })]);
 await writeFile(path.join(home, 'config.toml'), [
  'default_model="think"', '[providers.fixture]', 'type="openai"', 'base_url="http://127.0.0.1:9/v1"', 'api_key="local-fixture"',
  '[models.think]', 'provider="fixture"', 'model="think"', 'max_context_size=32768', 'capabilities=["thinking"]', 'support_efforts=["low","high"]',
  '[models.plain]', 'provider="fixture"', 'model="plain"', 'max_context_size=32768',
 ].join('\n'));
 await atomicJson(path.join(root, 'settings.json'), { defaultWorkspace: workspace, agents: { kimi: { executable, home } } });
 const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root });
 try {
  const page = await desktop.firstWindow();
  const models = page.getByRole('combobox', { name: '选择模型', exact: true });
  await models.focus();
  await models.selectOption('kimi:model:think', { timeout: 15_000 });
  await expect(page.locator('.active-harness')).toHaveText('Kimi Code');
  const thinking = page.getByRole('button', { name: /^选择思考强度/ });
  await thinking.click();
  await expect(page.getByRole('slider', { name: '思考强度', exact: true })).toHaveAccessibleDescription(/auto、off、low、high/);
  await page.keyboard.press('Escape');
  await models.selectOption('kimi:model:plain');
  await expect(thinking).toHaveCount(0);
  const input = page.getByRole('textbox', { name: '任务输入' });
  await input.fill('/');
  await expect(page.getByRole('option', { name: /\/help/ })).toBeVisible();
  await page.getByRole('option', { name: /\/help/ }).click();
  await expect(input).toHaveValue('/help');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.message.assistant')).toContainText('/status');
 } finally { await desktop.close(); }
});
