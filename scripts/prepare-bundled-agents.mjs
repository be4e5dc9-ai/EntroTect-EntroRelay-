import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const releases = {
  kimi: { version: '2.5.2', integrity: 'sha512-a7UuugqQuPBHB2ZMiu8ezAFIwJ0dn6xanuRnTqa2pXXu12ng7kvigAlXy47TxNKpnyj8vgaNStedTv4kbqSCuA==' },
  opencode: { version: '1.19.5', integrity: 'sha512-xCVbrA8A/qQTAdBIKyhK5tx3/mcq18yF82Mi8phry0MJb2631nnnpxF9m6FFfWAVHyer4qFGrO7hbWXesHQ1Gg==' },
  codex: { version: '0.167.0', integrity: 'sha512-duPCBwflc8qhQdLekbL8fDYF646tW4gj0/l9BDnsVhEzoqm6OwxMAJXDFwSOLUUJPCmjBeM+eHYAx4fP/hwfjg==' },
};
const notices = {
  opencode: { LICENSE: ['anomalyco/opencode/v1.19.5/LICENSE', '625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b'] },
  codex: {
    LICENSE: ['openai/codex/rust-v0.167.0/LICENSE', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
    NOTICE: ['openai/codex/rust-v0.167.0/NOTICE', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
  },
};

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function includeNotices(harness, directory) {
  for (const [name, [source, checksum]] of Object.entries(notices[harness] ?? {})) {
    const file = path.join(directory, name);
    const present = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (present && hash(present) === checksum) continue;
    const response = await fetch(`https://raw.githubusercontent.com/${source}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Unable to download ${harness} ${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== checksum) throw new Error(`Unexpected ${harness} ${name} checksum`);
    await writeFile(file, bytes);
  }
}

export async function prepareBundledAgents() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The bundled CLI releases target Windows x64');
  const project = path.resolve(import.meta.dirname, '..');
  const runtime = path.join(project, '.runtime');
  const manifest = path.join(runtime, 'versions.json');
  const versions = JSON.parse(await readFile(manifest, 'utf8'));
  const node = path.join(runtime, 'node', 'node.exe');
  const downloads = path.join(runtime, 'downloads');
  await mkdir(downloads, { recursive: true });
  const work = await mkdtemp(path.join(downloads, 'bundled-agents-'));
  try {
    const loader = path.join(work, 'prepare.cjs');
    await build({ stdin: { contents: `
      export { OfficialRuntimeSource, verifyNpmRuntime, verifyRuntime } from './backend/runtime-release';
      export { harnessEntry } from './backend/settings';
      export { atomicJson } from './backend/store';
    `, resolveDir: project }, outfile: loader, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
    const { OfficialRuntimeSource, verifyNpmRuntime, verifyRuntime, harnessEntry, atomicJson } = createRequire(import.meta.url)(loader);
    const source = new OfficialRuntimeSource(runtime, node);
    const signal = new AbortController().signal;
    const prepared = await Promise.allSettled(Object.entries(releases).map(async ([harness, release]) => {
      const directory = path.join(runtime, harness);
      const scratch = path.join(work, harness);
      await mkdir(scratch);
      const cached = await Promise.all([verifyNpmRuntime(harness, release, directory), access(harnessEntry(harness, directory))]).then(() => true, () => false);
      if (cached) {
        await includeNotices(harness, directory);
        await verifyRuntime(harness, node, directory, path.join(scratch, 'probe'), signal);
      } else {
        await source.prepare(harness, release, scratch, signal);
        const candidate = path.join(scratch, 'runtime');
        await includeNotices(harness, candidate);
        const backup = path.join(scratch, 'old');
        const moved = await rename(directory, backup).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
        try { await rename(candidate, directory); }
        catch (error) { if (moved) await rename(backup, directory); throw error; }
      }
      versions[harness] = release.version;
      console.log(`Bundled ${harness} ${release.version} verified`);
    }));
    const failed = prepared.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Could not prepare bundled CLI runtimes');
    await atomicJson(manifest, versions);
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareBundledAgents();
