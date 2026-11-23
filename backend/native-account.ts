import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectKey } from '../shared/project-path';
import { atomicFile } from './store';

export const sharedRuntimeHome = (root: string, harness: 'codex' | 'kimi', nativeHome: string) => {
  const profile = createHash('sha256').update(projectKey(path.resolve(nativeHome))).digest('hex').slice(0, 32);
  return path.join(root, 'agents', harness + '-shared', profile);
};

async function optionalRead(file: string) {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

// The runtime still needs provider/model configuration. Project only this
// file into the application's private profile. No session index is shared.
export async function prepareSharedHome(harness: 'codex' | 'kimi', nativeHome: string, runtime: string) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const file = path.join(runtime, 'config.toml');
  const [source, local] = await Promise.all([optionalRead(path.join(nativeHome, 'config.toml')), optionalRead(file)]);
  if (source && !source.equals(local ?? Buffer.alloc(0))) await atomicFile(file, source);
  if (!source && local) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (harness !== 'kimi') return;
  const credentials = path.join(nativeHome, 'credentials');
  const target = await realpath(credentials).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!target) return;
  // Kimi atomically replaces token files after refresh. Point the directory,
  // never an individual token file, at the account's live credential store.
  const mounted = path.join(runtime, 'credentials');
  try { await symlink(target, mounted, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await lstat(mounted)).isSymbolicLink() || projectKey(await realpath(mounted)) !== projectKey(target))
      throw new Error('Kimi Code 运行目录的账号绑定不匹配');
  }
}

export type CodexAccount =
  | { type: 'apiKey'; apiKey: string }
  | { type: 'chatgptAuthTokens'; accessToken: string; chatgptAccountId: string; chatgptPlanType?: string };

export function codexAccess(token: string, accountId?: string): CodexAccount {
  let claims: Record<string, unknown> = {};
  try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))['https://api.openai.com/auth'] ?? {}; } catch {}
  const id = accountId || claims.chatgpt_account_id;
  if (typeof id !== 'string' || !id) throw new Error('无法从 Codex 登录中识别工作区账号');
  return { type: 'chatgptAuthTokens', accessToken: token, chatgptAccountId: id,
    ...(typeof claims.chatgpt_plan_type === 'string' ? { chatgptPlanType: claims.chatgpt_plan_type } : {}) };
}

export async function cachedCodexAccount(home: string): Promise<CodexAccount | undefined> {
  const body = await optionalRead(path.join(home, 'auth.json'));
  if (!body) return;
  let auth;
  try { auth = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('无法读取 Codex 原生登录凭据，请检查独立端登录状态'); }
  if (typeof auth?.tokens?.access_token === 'string' && auth.tokens.access_token &&
    (auth.auth_mode === 'chatgpt' || auth.auth_mode === 'chatgptAuthTokens' || !auth.auth_mode))
    return codexAccess(auth.tokens.access_token, auth.tokens.account_id);
  if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) return { type: 'apiKey', apiKey: auth.OPENAI_API_KEY };
}

export async function codexCredentialStore(home: string) {
  const config = await optionalRead(path.join(home, 'config.toml'));
  // This top-level option selects the CLI's OS credential store. The CLI
  // defaults to file, and auto prefers keyring before falling back to file.
  const topLevel = (config?.toString('utf8') ?? '').split(/^\s*\[/m, 1)[0];
  return /^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/m.exec(topLevel)?.[1] ?? 'file';
}
