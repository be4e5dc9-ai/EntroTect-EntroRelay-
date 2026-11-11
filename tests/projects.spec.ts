import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '../backend/store';
import type { Conversation } from '../shared/types';
import { modelFixture } from './fixture-server';
import { launchTauri } from './tauri-launch';

test('existing conversations group by directory and new chats use the selected project', async () => {
  const root = path.resolve('.local', `projects-e2e-${Date.now()}`);
  const data = path.join(root, 'app');
  const existing = path.join(root, 'existing-project');
  const other = path.join(root, 'other-project');
  const added = path.join(root, 'added-project');
  const empty = path.join(root, 'empty-project');
  const created = path.join(root, 'new-project');
  for (const directory of [existing, other, added, empty]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(added, 'only-in-added.txt'), 'Project marker');

  const now = Date.now();
  const old: Conversation[] = [
    { id: randomUUID(), workspace: existing, harness: 'deepseek', title: '已有 DeepSeek 对话' },
    { id: randomUUID(), workspace: existing.toUpperCase().replaceAll('\\', '/') + '/', harness: 'zcode', title: '已有 ZCode 对话' },
    { id: randomUUID(), workspace: other, harness: 'deepseek', title: '其他项目对话' },
  ].map(row => ({ ...row, harness: row.harness as Conversation['harness'], createdAt: now, updatedAt: now, revision: 0, state: 'idle', bindings: {} }));
  await atomicJson(path.join(data, 'conversations.json'), old);
  const fixture = await modelFixture();
  await atomicJson(path.join(data, 'settings.json'), {
    defaultWorkspace: existing,
    deepseek: { home: path.join(root, 'dsh'), provider: 'deepseek-official', authMode: 'api', baseUrl: fixture.origin },
  });
  const env = { ...process.env, ENTROTECT_DATA_DIR: data };
  let desktop = await launchTauri(env);
  try {
    let page = await desktop.firstWindow();
    const existingGroup = page.getByRole('region', { name: 'existing-project', exact: true });
    await expect(existingGroup.locator('.conversation-row')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'other-project', exact: true }).locator('.conversation-row')).toHaveCount(1);
    await existingGroup.getByRole('button', { name: '收起项目 existing-project' }).click();
    await expect(existingGroup.locator('.conversation-row')).toHaveCount(0);
    const search = page.getByPlaceholder('搜索项目或对话');
    await search.fill('已有 ZCode');
    await expect(existingGroup.locator('.conversation-row')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'other-project', exact: true })).toHaveCount(0);
    await search.clear();
    await existingGroup.getByRole('button', { name: '展开项目 existing-project' }).click();
    await expect(existingGroup.locator('.conversation-row')).toHaveCount(2);

    // Stub the native picker result only. Project registration and execution
    // still run through Tauri and the actual worker.
    for (const directory of [empty, added]) {
      await page.evaluate(directory => { window.entrotect!.chooseDirectory = async () => directory; }, directory);
      await page.getByRole('button', { name: '添加项目', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '添加项目', exact: true });
      await dialog.getByRole('button', { name: '选择目录' }).click();
      await dialog.getByRole('button', { name: '打开项目' }).click();
      await expect(page.getByRole('region', { name: path.basename(directory), exact: true })).toContainText('还没有对话');
    }
    await page.evaluate(directory => { window.entrotect!.chooseDirectory = async () => directory; }, root);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    const create = page.getByRole('dialog', { name: '添加项目', exact: true });
    await create.getByRole('button', { name: '新建目录' }).click();
    const projectName = create.getByRole('textbox', { name: '项目名称' });
    await projectName.fill('..\\escape');
    await create.getByRole('button', { name: '选择目录' }).click();
    await create.getByRole('button', { name: '创建项目' }).click();
    await expect(create.getByRole('alert')).toContainText('有效的 Windows 文件夹名称');
    await projectName.fill('added-project');
    await create.getByRole('button', { name: '创建项目' }).click();
    await expect(create.getByRole('alert')).toContainText('该目录已存在');
    await projectName.fill(path.basename(created));
    await create.screenshot({ path: '.local/screenshots/project-create.png' });
    await create.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('region', { name: path.basename(created), exact: true })).toContainText('还没有对话');
    expect((await stat(created)).isDirectory()).toBe(true);
    const addedGroup = page.getByRole('region', { name: 'added-project', exact: true });
    await addedGroup.getByRole('button', { name: 'added-project', exact: true }).click();
    await page.getByRole('button', { name: '展开项目侧栏' }).click();
    const panel = page.getByRole('complementary', { name: '项目侧栏' });
    await expect(panel.getByTitle('only-in-added.txt', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const boot = await window.entrotect!.bootstrap();
      await window.entrotect!.saveSettings(boot.settings, { deepseek: 'local-test-project-key' });
    });
    await page.getByRole('region', { name: 'other-project', exact: true }).getByRole('button', { name: 'other-project', exact: true }).click();
    await addedGroup.getByRole('button', { name: '在 added-project 中开启对话' }).click();
    await expect(panel.getByTitle('only-in-added.txt', { exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: '任务输入' });
    await input.fill('在已选项目中开始工作');
    await input.press('Enter');
    await expect(page.getByRole('status', { name: '运行状态' })).toHaveText('就绪');
    await expect(addedGroup.locator('.conversation-row')).toHaveText(/在已选项目中开始工作/);
    const boot = await page.evaluate(() => window.entrotect!.bootstrap());
    expect(boot.conversations.find(chat => chat.title === '在已选项目中开始工作')?.workspace).toBe(added);
    await page.keyboard.press('Control+n');
    await expect(page.getByRole('heading', { name: '想法，从这里展开。' })).toBeVisible();
    await expect(panel.getByTitle('only-in-added.txt', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.local/screenshots/project-groups.png' });

    await desktop.close();
    desktop = await launchTauri(env);
    page = await desktop.firstWindow();
    await expect(page.getByRole('region', { name: 'empty-project', exact: true })).toContainText('还没有对话');
    await expect(page.getByRole('region', { name: 'new-project', exact: true })).toContainText('还没有对话');
    await expect(page.getByRole('region', { name: 'added-project', exact: true }).locator('.conversation-row')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'existing-project', exact: true }).locator('.conversation-row')).toHaveCount(2);
  } finally {
    await desktop.close();
    await fixture.close();
  }
});
