import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cargoTarget } from './cargo-target.mjs';
import { version } from './release-info.mjs';
import { stagePackage } from './stage-package.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('EntroTect requires Windows x64 to build this installer.');
const repository = process.env.ENTROTECT_RELEASE_REPOSITORY?.trim();
const publicKey = process.env.ENTROTECT_UPDATER_PUBLIC_KEY?.trim();
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
const signed = !!(repository || publicKey || privateKey || process.argv.includes('--release'));
if (signed && (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').some(value => value === '.' || value === '..') || !publicKey || !privateKey)) {
  throw Error('A signed release needs ENTROTECT_RELEASE_REPOSITORY (owner/repo), ENTROTECT_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY.');
}
if (signed && !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw Error('Expected a stable version or a numbered beta version.');
const tauriConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
if (tauriConfig.version !== version) throw Error('The Tauri and package versions differ.');
const releaseUrl = signed ? `https://github.com/${repository}/releases` : undefined;
const updateFeed = version.includes('-beta.')
  ? `https://github.com/${repository}/raw/refs/heads/main/updates/beta.json`
  : `${releaseUrl}/latest/download/latest.json`;
const output = path.resolve('release', `windows-installer-${version}${signed ? '' : '-local'}`);
const local = await realpath(await mkdir('.local', { recursive: true }).then(() => '.local'));
if (path.dirname(local) !== await realpath('.')) throw Error('The installer staging directory must be inside the workspace.');
const stage = await mkdtemp(path.join(local, 'app-installer-'));
const windowsPath = file => file.replaceAll('\\', '/');
function run(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', ...args], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`Tauri exited with status ${code}`)));
  });
}
try {
  await stagePackage(stage);
  await writeFile(path.join(stage, 'installer-channel.txt'), 'nsis\n');
  const files = await readdir(stage);
  const resources = Object.fromEntries(await Promise.all(files.map(async name => {
    const source = path.join(stage, name);
    const suffix = (await stat(source)).isDirectory() ? '/' : '';
    return [windowsPath(source) + suffix, name + suffix];
  })));
  const config = {
    build: { beforeBuildCommand: null },
    bundle: { active: true, targets: ['nsis'], resources, createUpdaterArtifacts: signed, windows: {
      allowDowngrades: false,
      nsis: { installMode: 'currentUser', languages: ['SimpChinese', 'English'] },
    } },
    ...(signed ? { plugins: { updater: {
      pubkey: publicKey, requireSignedVersion: true,
      endpoints: [updateFeed],
      windows: { installMode: 'passive' },
    } } } : {}),
  };
  const configFile = path.join(stage, 'installer.conf.json');
  await writeFile(configFile, JSON.stringify(config));
  const compile = { build: config.build, ...(signed ? { plugins: config.plugins } : {}) };
  await run(['build', '--config', JSON.stringify(compile), '--no-bundle', '--ci']);
  await run(['bundle', '--config', configFile, '--bundles', 'nsis', '--ci']);
  const name = `EntroTect_${version}_x64-setup.exe`;
  const bundle = path.join(cargoTarget, 'release', 'bundle', 'nsis', name);
  await access(bundle);
  await mkdir(output, { recursive: true });
  await copyFile(bundle, path.join(output, name));
  if (signed) {
    const signature = (await readFile(`${bundle}.sig`, 'utf8')).trim();
    async function releaseNotes(file) {
      const changelog = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
      const section = changelog.split(/^## /m).find(entry => entry.startsWith(`${version}\n`));
      return section?.slice(version.length).trim();
    }
    const [chinese, english] = await Promise.all([releaseNotes('CHANGELOG.md'), releaseNotes('CHANGELOG.en.md')]);
    const notes = chinese && english ? `${chinese}\n\n<!-- entrotect:en -->\n\n${english}` : chinese ?? english;
    await copyFile(`${bundle}.sig`, path.join(output, `${name}.sig`));
    await writeFile(path.join(output, 'latest.json'), JSON.stringify({
      version, ...(notes ? { notes } : {}), pub_date: new Date().toISOString(),
      platforms: { 'windows-x86_64': { signature, url: `${releaseUrl}/download/v${version}/${name}` } },
    }, null, 2) + '\n');
  }
  console.log(`Installer ready: ${path.join(output, name)}`);
} finally {
  const directory = await realpath(stage);
  if (path.dirname(directory) === local && path.basename(directory).startsWith('app-installer-')) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}
