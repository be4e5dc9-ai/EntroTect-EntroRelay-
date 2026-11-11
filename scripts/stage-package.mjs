import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectNotices } from './notices.mjs';
import { prepareBundledAgents } from './prepare-bundled-agents.mjs';

export async function stagePackage(root) {
  await prepareBundledAgents();
  await mkdir(path.join(root, 'backend'), { recursive: true });
  await copyFile('dist-backend/worker.cjs', path.join(root, 'backend/worker.cjs'));
  await cp('.runtime', path.join(root, 'runtimes'), { recursive: true, force: true, filter: source => {
    const relative = path.relative('.runtime', source).replaceAll('\\', '/');
    return !/^(downloads(?:\/|$)|bridge(?:\/|$)|node\/node-v)/.test(relative) && !relative.includes('/.cache/') && !relative.endsWith('package-lock.json');
  } });
  const manifest = path.join(root, 'runtimes', 'versions.json');
  const versions = JSON.parse(await readFile(manifest, 'utf8'));
  if (Object.hasOwn(versions, 'bridge')) {
    delete versions.bridge;
    await writeFile(manifest, JSON.stringify(versions, null, 2));
  }
  for (const file of ['README.md', 'README.en.md', 'CHANGELOG.md', 'CHANGELOG.en.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    await copyFile(file, path.join(root, file));
  }
  await cp('docs', path.join(root, 'docs'), { recursive: true, force: true });
  await collectNotices(path.join(root, 'licenses'));
  await mkdir(path.join(root, 'licenses', 'brands'), { recursive: true });
  await copyFile('src/assets/brands/sources.json', path.join(root, 'licenses', 'brands', 'sources.json'));
}
