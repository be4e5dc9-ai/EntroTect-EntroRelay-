import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { atomicJson } from '../backend/store';
import { launchTauri } from './tauri-launch';

test('follows Windows display language, switches in place, and persists the override', async () => {
  const root = path.resolve('.local', `desktop-language-${Date.now()}`);
  const settingsFile = path.join(root, 'settings.json');
  await atomicJson(settingsFile, { defaultWorkspace: root });
  const windowsLanguage = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-UICulture).Name'],
    { encoding: 'utf8', windowsHide: true }).trim();
  const system = /^zh(?:-|$)/i.test(windowsLanguage) ? 'zh-CN' : 'en';
  const override = system === 'en' ? 'zh-CN' : 'en';
  const env = { ...process.env, ENTROTECT_DATA_DIR: root, ENTROTECT_TEST_SYSTEM_LANGUAGE: '1' };
  const names = {
    en: { settings: 'Settings and connections', language: 'Display language', save: 'Save settings', task: 'Task input' },
    'zh-CN': { settings: '设置与连接', language: '显示语言', save: '保存设置', task: '任务输入' },
  };
  let desktop = await launchTauri(env);
  try {
    let page = await desktop.firstWindow();
    const openSettings = async (language: typeof system) => {
      await page.getByRole('button', { name: names[language].settings, exact: true }).click();
      return page.getByRole('dialog', { name: names[language].settings });
    };
    await expect(page.locator('html')).toHaveAttribute('lang', system);
    await expect(page.getByRole('textbox', { name: names[system].task })).toBeVisible();
    const draft = '原始草稿 / Original draft';
    await page.getByRole('textbox', { name: names[system].task }).fill(draft);
    let settings = await openSettings(system);
    const language = settings.getByRole('combobox', { name: names[system].language });
    await expect(language).toHaveValue('system');
    await language.selectOption(override);
    await settings.getByRole('button', { name: names[system].save, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', override);
    await expect(page.getByRole('textbox', { name: names[override].task })).toHaveValue(draft);
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).language).toBe(override);

    await desktop.close();
    desktop = await launchTauri(env);
    page = await desktop.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('lang', override);
    settings = await openSettings(override);
    await settings.getByRole('combobox', { name: names[override].language }).selectOption('system');
    await settings.getByRole('button', { name: names[override].save, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', system);
    await expect(page.getByRole('textbox', { name: names[system].task })).toBeVisible();
  } finally {
    await desktop.close();
  }
});
