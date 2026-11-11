import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../backend/store';
import { modelFixture } from './fixture-server';
import { launchTauri } from './tauri-launch';

test('native history export, import UI, and continuation survive desktop restart', async () => {
  const fixture = await modelFixture(), root = path.resolve('.local', `history-e2e-${Date.now()}`), workspace = path.join(root, 'project'), external = path.join(root, 'standalone-dsh');
  await mkdir(workspace, { recursive: true }); await mkdir(external);
  await atomicJson(path.join(root, 'settings.json'), { defaultWorkspace: workspace, deepseek: { executable: '@bundled/node', args: ['@bundled/deepseek', '--profile', 'sdk'], home: path.join(root, 'dsh-home'), provider: 'deepseek-official', model: 'deepseek-flash', authMode: 'api', baseUrl: fixture.origin } });
  const launch = () => launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root });
  let desktop = await launch();
  try {
    let page = await desktop.firstWindow();
    await page.evaluate(async () => { const b = await window.entrotect!.bootstrap(); await window.entrotect!.saveSettings(b.settings, { deepseek: 'local-fixture-only' }); });
    await page.getByRole('textbox', { name: '任务输入' }).fill('请记住迁移标记 ALPHA-731'); await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByRole('status', { name: '运行状态' })).toHaveText('就绪');
    await page.getByTitle('会话菜单', { exact: true }).click(); await page.getByRole('menuitem', { name: '在独立 Harness 中继续' }).click();
    const exportDialog = page.getByRole('dialog', { name: '在独立 Harness 中继续', exact: true });
    await exportDialog.getByRole('textbox', { name: '原生历史路径' }).fill(external);
    await exportDialog.getByRole('button', { name: '创建原生会话', exact: true }).click();
    await expect(exportDialog.getByRole('status')).toContainText('已创建独立原生会话');
    await exportDialog.screenshot({ path: '.local/screenshots/history-export.png' });
    await exportDialog.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '导入历史对话', exact: true }).click();
    const importDialog = page.getByRole('dialog', { name: '导入历史对话', exact: true });
    await importDialog.getByRole('textbox', { name: '原生历史路径' }).fill(external); await importDialog.getByTitle('读取历史对话', { exact: true }).click();
    await importDialog.locator('.history-list button').first().click();
    await expect(importDialog.locator('.history-list button')).toHaveCount(1);
    await importDialog.screenshot({ path: '.local/screenshots/history-import.png' });
    await importDialog.getByRole('button', { name: '导入对话', exact: true }).click(); await expect(importDialog).toBeHidden();
    await expect(page.getByRole('region', { name: 'project', exact: true }).locator('.conversation-row')).toHaveCount(2);
    await expect(page.locator('.message.user')).toContainText('ALPHA-731');
    fixture.reply('导入后继续成功 BETA-842'); await page.getByRole('textbox', { name: '任务输入' }).fill('核对历史并记住 BETA-842'); await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByRole('status', { name: '运行状态' })).toHaveText('就绪');
    await expect(page.locator('.message.assistant').last()).toContainText('BETA-842');
    expect(JSON.stringify(fixture.requests.at(-1)!.body.messages)).toContain('ALPHA-731');
    await page.screenshot({ path: '.local/screenshots/history-continued.png' });
    const saved = JSON.parse(await readFile(path.join(root, 'conversations.json'), 'utf8')); expect(saved.filter((c: any) => c.importedFrom)).toHaveLength(1);
    await desktop.close(); desktop = await launch(); page = await desktop.firstWindow(); await page.locator('.conversation-row').first().click();
    await expect(page.locator('.message.assistant').last()).toContainText('BETA-842');
  } finally { await desktop.close(); await fixture.close(); }
});
