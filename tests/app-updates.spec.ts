import { test, expect } from '@playwright/test';
import path from 'node:path';
import { launchTauri } from './tauri-launch';
import type { AppUpdateStatus } from '../shared/types';

test('application update preference persists independently of Harness updates', async () => {
  const root = path.resolve('.local', `desktop-app-updates-${Date.now()}`);
  const env = { ...process.env, ENTROTECT_DATA_DIR: root };
  let desktop = await launchTauri(env);
  try {
    let page = await desktop.firstWindow();
    await page.getByRole('button', { name: /设置与连接/ }).click();
    const portable = process.env.ENTROTECT_TEST_APP_INSTALLER !== '1';
    await expect(page.getByRole('status', { name: '应用更新状态' }))
      .toContainText(portable ? '当前为解压版' : '尚未绑定 GitHub 发布源');
    await expect(page.getByRole('button', { name: '检查应用更新' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: '自动更新 EntroTect' })).toBeChecked();
    await expect(page.getByRole('switch', { name: '自动更新 Codex', exact: true })).not.toBeChecked();
    await page.getByRole('switch', { name: '自动更新 EntroTect' }).click();
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByRole('dialog', { name: '设置与连接' })).toBeHidden();
    await desktop.close();
    desktop = await launchTauri(env);
    page = await desktop.firstWindow();
    await page.getByRole('button', { name: /设置与连接/ }).click();
    await expect(page.getByRole('switch', { name: '自动更新 EntroTect' })).not.toBeChecked();
  } finally { await desktop.close(); }
});

test('detected updates appear at the lower left with release notes and disappear when current', async () => {
  const root = path.resolve('.local', `desktop-update-notice-${Date.now()}`);
  const desktop = await launchTauri({ ...process.env, ENTROTECT_DATA_DIR: root });
  try {
    const page = await desktop.firstWindow();
    const notice = page.getByRole('button', { name: /查看更新日志/ });
    const log = page.getByRole('dialog', { name: '更新日志' });
    const emit = (status: AppUpdateStatus) => page.evaluate(async status => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke(method: string, args: unknown): Promise<void> } }).__TAURI_INTERNALS__;
      await internals.invoke('plugin:event|emit', { event: 'entrotect:event', payload: { type: 'app-update', status } });
    }, status);
    await expect(page.getByRole('button', { name: '设置与连接' })).toBeEnabled();
    const { version } = await page.evaluate(() => window.entrotect!.appUpdateStatus());
    await expect(notice).toHaveCount(0);
    await emit({ version, state: 'checking' });
    await expect(notice).toHaveCount(0);
    await emit({ version, state: 'downloading', available: '0.7.9', downloaded: 25, total: 100, notes: '### 测试版说明\n\n- **新增更新提醒**。' });
    await expect(page.locator('.sidebar').getByRole('button', { name: /正在下载更新.*25%.*查看更新日志/ })).toBeVisible();
    await notice.click();
    await expect(log.getByRole('heading', { name: '新版 v0.7.9' })).toBeVisible();
    await expect(log.getByText('新增更新提醒', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(log).toBeHidden();
    await page.getByRole('button', { name: '收起侧边栏' }).click();
    await emit({ version, state: 'ready', available: '0.7.9' });
    await expect(page.locator('.app-rail').getByRole('button', { name: /更新已就绪.*0\.7\.9/ })).toBeVisible();
    await emit({ version, state: 'current' });
    await expect(notice).toHaveCount(0);
    await emit({ version, state: 'error', detail: '连接失败' });
    await expect(notice).toHaveCount(0);
    const settings = page.getByRole('dialog', { name: '设置与连接' });
    await page.getByRole('button', { name: '设置与连接' }).click();
    await settings.getByRole('button', { name: '查看更新日志' }).click();
    await expect(log.getByRole('heading', { name: '0.7.8', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(log).toBeHidden();
    await expect(settings).toBeVisible();
  } finally { await desktop.close(); }
});
