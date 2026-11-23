import {test,expect} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Store,atomicJson} from '../backend/store';
import {SettingsStore} from '../backend/settings';
import {Controller} from '../backend/controller';
import {HistoryService} from '../backend/history';
import {modelFixture} from './fixture-server';
import {launchTauri} from './tauri-launch';

test('automatic history defaults, native updates, reasoning menu and settings manual controls',async()=>{
 const fixture=await modelFixture(),root=path.resolve('.local',`auto-sync-ui-${Date.now()}`),workspace=path.join(root,'project'),native=path.join(root,'independent-dsh'),data=path.join(root,'app');await mkdir(workspace,{recursive:true});await mkdir(path.join(native,'sessions'),{recursive:true});
 const runtime=path.resolve('.runtime'),store=new Store(path.join(root,'seed'));await store.init();const settings=new SettingsStore(store.root,runtime,path.join(runtime,'node/node.exe'),{protect:async s=>s,unprotect:async s=>s});await settings.init();
 await settings.save({...settings.value,defaultWorkspace:workspace,deepseek:{...settings.value.deepseek,home:path.join(root,'seed-home'),provider:'deepseek-official',model:'deepseek-flash',authMode:'api',baseUrl:fixture.origin}},{deepseek:'local-fixture'});
 const controller=new Controller(store,settings,()=>{}),history=new HistoryService(controller);
 async function seed(title:string,directory=workspace){
  const c=await controller.create(directory,'deepseek');
  try{
   await controller.send(c.id,title);
   await expect(async()=>{expect(store.get(c.id).error).toBeUndefined();expect(store.get(c.id).state).toBe('idle');}).toPass();
   return await history.export({conversationId:c.id,target:{harness:'deepseek',location:native}});
  }finally{await controller.releaseRuntime(c.id);}
 }
 const initial=await seed('历史测试 ALPHA-731');
 await atomicJson(path.join(data,'settings.json'),{defaultWorkspace:workspace,deepseek:{executable:'@bundled/node',args:['@bundled/deepseek','--profile','sdk'],home:native,provider:'deepseek-official',model:'deepseek-flash',authMode:'api',baseUrl:fixture.origin},zcode:{home:path.join(root,'zcode-home'),model:'glm-5.3'}});
 const env={...process.env,ENTROTECT_DATA_DIR:data,ENTROTECT_TEST_SYNC:'1'};let desktop=await launchTauri(env);
 try{
  let page=await desktop.firstWindow();const initialBoot=await page.evaluate(()=>window.entrotect!.bootstrap());expect(initialBoot.settings.history).toMatchObject({autoImport:true,autoExport:true});
  await page.evaluate(async()=>{const b=await window.entrotect!.bootstrap();await window.entrotect!.saveSettings(b.settings,{deepseek:'local-fixture'});});
  await expect(page.locator('.conversation-row')).toHaveCount(0);
  await page.getByTitle('导入历史对话',{exact:true}).click();
  const graph=page.getByRole('main',{name:'同步蓝图'});
  await graph.locator('[data-sender="deepseek"]').click();
  const whole=graph.locator('.bp-sender-node:has([data-sender="deepseek"]) [data-whole-harness]');
  await whole.click();
  await graph.locator('[data-receiver="workbench"]').click();
  await expect(graph.locator('footer[role="status"]')).toContainText('已连接到');
  await graph.getByRole('button',{name:'立即同步',exact:true}).click();
  await expect(graph.locator('footer[role="status"]')).toHaveText('已检查已连接的项目和对话');
  const stillEmpty=await page.evaluate(()=>window.entrotect!.bootstrap());
  expect(stillEmpty.conversations).toHaveLength(0);
  await graph.getByRole('button',{name:/^来源待确认/}).click();
  await graph.getByRole('button',{name:'将全部 1 条确认为原生',exact:true}).click();
  await expect(graph.getByText('没有待确认的记录')).toBeVisible();
  await graph.getByRole('button',{name:'原生项目',exact:true}).click();
  await graph.getByRole('button',{name:'立即同步',exact:true}).click();
  await graph.getByTitle('返回工作区').click();
  await expect(page.locator('.conversation-row')).toHaveCount(1);
  await page.getByRole('button',{name:'设置 project 的项目同步'}).click();
  await expect(graph.getByRole('region',{name:'连接详情'})).toContainText('EntroTect 工作台');
  await graph.getByTitle('返回工作区').click();
  await page.locator('.conversation-row').first().click();
  await expect(page.locator('.message.user')).toContainText('ALPHA-731');
  await page.getByTitle('会话菜单',{exact:true}).click();
  await page.getByRole('menuitem',{name:'设置对话同步'}).click();
  await expect(graph.locator('.bp-target-rule').filter({hasText:'EntroTect 工作台'})).toContainText('继承 Harness');
  await graph.getByTitle('返回工作区').click();
  const strength=page.getByRole('slider',{name:'思考强度',exact:true}),strengthButton=page.getByRole('button',{name:/^选择思考强度/});
  await strengthButton.click();await expect(strength).toHaveAccessibleDescription(/auto、off、low、high、max/);
  await strength.press('End');await expect(strength).toHaveAttribute('aria-valuetext','max');await strength.press('Escape');
  fixture.reply('最高强度续聊 BETA-842');await page.getByRole('textbox',{name:'任务输入'}).fill('保留 ALPHA-731，追加 BETA-842');await page.getByRole('button',{name:'发送任务',exact:true}).click();await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('就绪');expect(fixture.requests.at(-1)!.body.output_config.effort).toBe('max');
  await expect(async()=>{const metadata=await history.inspect({harness:'deepseek',location:native},initial.sessionId);expect(metadata.provenance?.revision).toBe(2);expect(metadata.provenance?.fingerprint).toBe(metadata.fingerprint);}).toPass();
  expect((await history.list({harness:'deepseek',location:native})).sessions).toHaveLength(1);
  await page.screenshot({path:'.local/screenshots/reasoning-max.png'});
  // History preferences can be disabled while inference is running; connection
  // changes still use the existing stopped-turn restriction.
  fixture.hold(true);await page.getByRole('textbox',{name:'任务输入'}).fill('暂停前关闭自动导出');await page.getByRole('button',{name:'发送任务',exact:true}).click();await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('正在工作');
  await page.getByRole('button',{name:/设置与连接/}).click();let livePreferences=page.getByRole('dialog',{name:'设置与连接'});await livePreferences.getByRole('button',{name:'历史与同步',exact:true}).click();await livePreferences.getByRole('switch',{name:'自动导出对话'}).click();await livePreferences.getByRole('button',{name:'保存设置'}).click();await expect(livePreferences).toBeHidden();
  await page.getByRole('button',{name:'暂停任务'}).click();await expect(page.getByRole('status',{name:'运行状态'})).toHaveText('就绪');fixture.hold(false);
  expect((await page.evaluate(()=>window.entrotect!.bootstrap())).settings.history?.autoExport).toBe(false);
  await page.getByRole('button',{name:/设置与连接/}).click();livePreferences=page.getByRole('dialog',{name:'设置与连接'});await livePreferences.getByRole('button',{name:'历史与同步',exact:true}).click();await livePreferences.getByRole('switch',{name:'自动导出对话'}).click();await livePreferences.getByRole('button',{name:'保存设置'}).click();
  const nextProject=path.join(root,'another-project');
  await mkdir(nextProject);
  await seed('独立端新增 HISTORY-SECOND',nextProject);
  await expect(page.getByRole('region',{name:'another-project',exact:true}).locator('.conversation-row')).toHaveCount(1);
  await expect(page.locator('.conversation-row')).toHaveCount(2);
  await page.getByRole('button',{name:'新对话',exact:false}).click();await page.getByRole('combobox',{name:'选择模型'}).selectOption('glm-5.3');await strengthButton.click();await expect(strength).toHaveAccessibleDescription(/auto、low、high、max/);
  await page.getByRole('button',{name:/设置与连接/}).click();let preferences=page.getByRole('dialog',{name:'设置与连接'});await preferences.getByRole('button',{name:'GLM / ZCode',exact:true}).click();await preferences.locator('label').filter({hasText:'模型 ID'}).locator('input').fill('unknown-custom-model');await preferences.getByRole('button',{name:'保存连接'}).click();
  await page.getByRole('combobox',{name:'选择模型'}).selectOption('unknown-custom-model');await expect(strength).toHaveCount(0);
  await page.getByRole('button',{name:/设置与连接/}).click();preferences=page.getByRole('dialog',{name:'设置与连接'});await preferences.getByRole('button',{name:'历史与同步',exact:true}).click();await expect(preferences.getByRole('switch',{name:'自动导入历史对话'})).toHaveAttribute('aria-checked','true');await expect(preferences.getByRole('switch',{name:'自动导出对话'})).toHaveAttribute('aria-checked','true');await preferences.screenshot({path:'.local/screenshots/automatic-history-settings.png'});
  await preferences.getByRole('switch',{name:'自动导入历史对话'}).click();await preferences.getByRole('switch',{name:'自动导出对话'}).click();await preferences.getByRole('button',{name:'保存设置'}).click();
  await seed('关闭自动后 HISTORY-THIRD');await page.waitForTimeout(16_000);await expect(page.locator('.conversation-row')).toHaveCount(2);
  // Explicit import remains available in settings with both automatic paths off.
  await page.getByRole('button',{name:/设置与连接/}).click();preferences=page.getByRole('dialog',{name:'设置与连接'});await preferences.getByRole('button',{name:'历史与同步',exact:true}).click();await preferences.getByRole('button',{name:'手动导入历史',exact:true}).click();
  await graph.locator('[data-sender="deepseek"]').click();
  await graph.getByRole('button',{name:'立即同步',exact:true}).click();
  await expect(graph.locator('footer[role="status"]')).toContainText('已检查已连接的项目和对话');
  await graph.getByTitle('返回设置').click();
  const saved=JSON.parse(await readFile(path.join(data,'settings.json'),'utf8'));
  expect(saved.history).toMatchObject({autoImport:false,autoExport:false});
  await preferences.getByRole('combobox',{name:'手动导出对话'}).selectOption({label:'历史测试 ALPHA-731'});
  await preferences.getByRole('button',{name:'手动导出续聊',exact:true}).click();
  await expect(graph.getByRole('region',{name:'连接详情'})).toContainText('ALPHA-731');
  await graph.getByRole('button',{name:'立即同步',exact:true}).click();
  await expect(graph.locator('footer[role="status"]')).toContainText('已检查已连接的项目和对话');
  await graph.getByTitle('返回设置').click();
  await desktop.close();desktop=await launchTauri(env);page=await desktop.firstWindow();await expect(page.locator('.conversation-row')).toHaveCount(3);
  await page.locator('.conversation-row').filter({hasText:'历史测试 ALPHA-731'}).click();await expect(page.getByRole('button',{name:/^选择思考强度/})).toHaveAccessibleName(/max/);
 }finally{await desktop.close();await controller.close();await fixture.close();}
});
