import type { AccountUsage, Harness, Settings, UsageSection, UsageWindow, WalletBalance } from '../shared/types';
import type { SettingsStore } from './settings';
import { connectionFor } from '../shared/harnesses';
import type { KimiNativeUsage } from './kimi-usage';

type AccountWallet = { currency: string; balance: string };
export type DeepSeekAccountBalance =
  | { status: 'ready'; value: AccountWallet[]; bonusWallets: AccountWallet[] }
  | { status: 'failed' | 'unauthorized' }
  | null;

function wallet(name: string, currency: unknown, amount: unknown): WalletBalance[] {
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) &&
    typeof amount === 'string' && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(amount)
    ? [{ name, currency, amount }]
    : [];
}

function failure<T>(error: unknown): UsageSection<T> {
  const status = error instanceof UsageHttpError ? error.status : 0;
  if (status === 401 || status === 403) {
    return { status: 'error', detail: '供应商未接受此凭据，请检查登录或查询密钥。' };
  }
  if (status === 404) return { status: 'unavailable', detail: '此连接未提供该用量接口。' };
  return { status: 'error', detail: '暂时无法读取供应商数据，请稍后刷新。' };
}

class UsageHttpError extends Error {
  constructor(readonly status: number) { super('Usage request failed'); }
}

async function getJson(url: URL, authorization: string) {
  const response = await fetch(url, {
    headers: { Authorization: authorization, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new UsageHttpError(response.status);
  return response.json();
}

function endpoint(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}

const isLoopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
const zai = 'https://api.z.ai';
const bigmodel = 'https://bigmodel.cn';
const isBigmodel = (origin: string | undefined) => origin === bigmodel || origin === 'https://open.bigmodel.cn';
const moonshotPlatforms: Record<string, { currency: string; consoleUrl: string }> = {
  'https://api.moonshot.cn': { currency: 'CNY', consoleUrl: 'https://platform.kimi.com/console' },
  'https://api.moonshot.ai': { currency: 'USD', consoleUrl: 'https://platform.kimi.ai/console' },
};
const kimiCodeOrigins = new Set(['https://api.kimi.com', 'https://api.kimi.ai']);
const kimiWindows = [
  ['5 小时额度', 'limit5h', 'limit_5h'], ['每周额度', 'limit7d', 'limit_7d'],
  ['月度总额度', 'monthTotal', 'limit_month_total'], ['月度代码额度', 'monthCode', 'limit_month_code'],
] as const;

function kimiQuota(usages: any, native: boolean): UsageSection<UsageWindow> {
  const rows = kimiWindows.flatMap(([name, nativeKey, apiKey]) => {
    const row = usages?.[native ? nativeKey : apiKey];
    const used = native ? row?.usedRatio : row?.used_ratio;
    const ratio = typeof used === 'number' || typeof used === 'string' && used.trim() ? Number(used) : NaN;
    if (!Number.isFinite(ratio) || ratio < 0) return [];
    const reset = native ? row?.resetAt : row?.reset_time;
    const resetAt = typeof reset === 'string' ? Date.parse(reset) : NaN;
    return [{ name, remainingPercent: Math.max(0, 100 * (1 - ratio)), ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}) }];
  });
  return rows.length ? { status: 'ready', source: 'Kimi Code', rows }
    : { status: 'unavailable', detail: 'Kimi Code 暂未返回可显示的套餐额度。' };
}

function quotaWindows(limits: unknown): UsageWindow[] {
  if (!Array.isArray(limits)) return [];
  return limits.flatMap(limit => {
    if (!limit || !['CREDIT_LIMIT', 'TOKENS_LIMIT', 'TIME_LIMIT'].includes(limit.type)) return [];
    const { unit, number, nextResetTime } = limit;
    const name = limit.type === 'TIME_LIMIT' ? unit === 5 && number === 1 ? 'MCP 额度' : undefined
      : unit === 3 && number === 5 ? '5 小时额度' : unit === 6 && number === 1 ? '每周额度' : unit === 5 && number === 1 ? '月度额度' : undefined;
    if (!name) return [];
    const used = limit.percentage;
    const left = typeof used === 'number' && Number.isFinite(used) && used >= 0 ? 100 - used
      : typeof limit.remaining === 'number' && Number.isFinite(limit.remaining) && Number.isFinite(limit.usage) && limit.usage > 0
        ? 100 * limit.remaining / limit.usage : undefined;
    if (left === undefined) return [];
    const resetAt = typeof nextResetTime === 'number' && nextResetTime >= 1e12 && nextResetTime < 1e14 ? nextResetTime : undefined;
    return [{ name, remainingPercent: Math.max(0, Math.min(100, left)), ...(resetAt ? { resetAt } : {}) }];
  });
}

/** Only reads the relevant account data on request, and never returns credentials. */
export class AccountUsageService {
  private cache = new Map<Harness, { settings: Settings; expires: number; result: Promise<AccountUsage> }>();
  constructor(private settings: SettingsStore, private nativeDeepSeekBalance: () => Promise<DeepSeekAccountBalance>,
    private nativeCodexLimits?: () => Promise<any>, private nativeKimiLimits?: () => Promise<KimiNativeUsage | undefined>) {}

  read(harness: Harness, refresh = false) {
    const settings = this.settings.value;
    const current = this.cache.get(harness);
    if (!refresh && current?.settings === settings && Date.now() < current.expires) return current.result;
    const result = harness === 'deepseek' ? this.deepseek(settings) : harness === 'zcode' ? this.zcode(settings)
      : harness === 'codex' ? this.codex(settings) : this.agentProvider(harness, settings);
    this.cache.set(harness, { settings, expires: Date.now() + 90_000, result });
    return result;
  }

  private async agentProvider(harness: 'kimi' | 'opencode', settings: Settings): Promise<AccountUsage> {
    const config = connectionFor(settings, harness);
    const authMode = config?.authMode ?? 'native';
    const unavailable = { status: 'unavailable', detail: '此连接的用量和余额由对应供应商提供。' } as const;
    const result: AccountUsage = { harness, authMode, checkedAt: Date.now(), plan: unavailable, balance: unavailable };
    if (authMode === 'native') {
      if (harness !== 'kimi' || !this.nativeKimiLimits) return result;
      try {
        const native = await this.nativeKimiLimits();
        if (!native || native.kind === 'error' && /no token for/i.test(native.message ?? '')) {
          result.plan = { status: 'not-connected', detail: '请先登录 Kimi Code 套餐账号。' };
        } else if (native.kind === 'error') {
          result.plan = failure(native.status ? new UsageHttpError(native.status) : undefined);
        } else {
          result.plan = kimiQuota(native.quota.usages, true);
          const extra = native.quota.extraUsage;
          if (typeof extra?.balanceCents === 'number' && Number.isSafeInteger(extra.balanceCents)) {
            const rows = wallet('加量包余额', extra.currency, (extra.balanceCents / 100).toFixed(2));
            if (rows.length) result.balance = { status: 'ready', source: 'Kimi Code', rows };
          }
        }
      } catch (error) { result.plan = failure(error); }
      return result;
    }

    const base = endpoint(config?.baseUrl ?? '');
    if (!base) return result;
    const platform = moonshotPlatforms[base.origin];
    const coding = kimiCodeOrigins.has(base.origin) && base.pathname.replace(/\/+$/, '') === '/coding/v1';
    if (!platform && !coding) return result;
    const section = coding ? 'plan' : 'balance';
    try {
      const key = await this.settings.key(harness);
      if (!key) {
        result[section] = { status: 'not-connected', detail: '请先保存此连接的 API Key。' };
      } else if (coding) {
        const payload = await getJson(new URL('/coding/v1/usages', base), `Bearer ${key}`);
        result.plan = kimiQuota(payload?.usages, false);
      } else {
        const payload = await getJson(new URL('/v1/users/me/balance', base), `Bearer ${key}`);
        if (payload?.code !== 0 || !payload?.data) throw new Error('Missing Kimi balance data');
        const rows = [['可用余额', 'available_balance'], ['现金余额', 'cash_balance'], ['代金券余额', 'voucher_balance']].flatMap(([label, field]) => {
          const amount = payload.data[field];
          return wallet(label, platform.currency, typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : amount);
        });
        result.balance = rows.length ? { status: 'ready', source: 'Kimi API 开放平台', rows } : unavailable;
      }
    } catch (error) {
      if (coding) result.plan = failure(error);
      else result.balance = failure(error);
    }
    if (platform) result.consoleUrl = platform.consoleUrl;
    return result;
  }

  private async codex(settings: Settings): Promise<AccountUsage> {
    const authMode = settings.agents?.codex?.authMode ?? 'native';
    let plan: UsageSection<UsageWindow> = { status: 'unavailable', detail: 'ChatGPT 套餐额度由 Codex 原生登录提供。' };
    if (authMode === 'native' && this.nativeCodexLimits) {
      try {
        const result = await this.nativeCodexLimits();
        if (!result) plan = { status: 'not-connected', detail: '请先在 Codex CLI 中登录 ChatGPT 账号。' };
        else {
          const limits = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
          const rows: UsageWindow[] = [limits?.primary, limits?.secondary].flatMap((window, index) => {
            if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
            const duration = window.windowDurationMins;
            const name = duration === 300 ? '5 小时额度' : duration === 10_080 ? '每周额度' : index ? '次要额度' : '主要额度';
            const resetAt = Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt * 1000 : undefined;
            return [{ name, remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)), resetAt }];
          });
          plan = rows.length ? { status: 'ready', source: 'Codex', rows } : { status: 'unavailable', detail: 'Codex 暂未返回可显示的套餐额度。' };
        }
      } catch { plan = { status: 'error', detail: '暂时无法读取 Codex 套餐额度。' }; }
    }
    const official = endpoint(settings.agents?.codex?.baseUrl ?? '')?.origin === 'https://api.openai.com';
    return { harness: 'codex', authMode, checkedAt: Date.now(), plan,
      balance: { status: 'unavailable', detail: authMode === 'native' ? '此连接使用 ChatGPT 套餐额度。' : 'API 余额由当前供应商提供。' },
      ...(authMode === 'api' && official ? { consoleUrl: 'https://platform.openai.com/usage' } : {}) };
  }

  private async deepseek(settings: Settings): Promise<AccountUsage> {
    const config = settings.deepseek;
    const plan: UsageSection<UsageWindow> = { status: 'unavailable', detail: '此连接使用账户余额计费。' };
    let balance: UsageSection<WalletBalance>;
    try {
      if (config.authMode === 'native') {
        const native = await this.nativeDeepSeekBalance();
        if (!native) balance = { status: 'not-connected', detail: '请在 DeepSeek Harness 中登录。' };
        else if (native.status === 'unauthorized') balance = { status: 'error', detail: 'DeepSeek 未接受原生登录，请检查登录状态。' };
        else if (native.status !== 'ready') balance = { status: 'error', detail: 'DeepSeek Harness 暂未返回账户余额。' };
        else balance = {
          status: 'ready', source: 'DeepSeek Harness',
          rows: [
            ...native.value.flatMap(row => wallet('充值余额', row.currency, row.balance)),
            ...native.bonusWallets.flatMap(row => wallet('赠金余额', row.currency, row.balance)),
          ],
        };
      } else {
        const base = endpoint(config.baseUrl);
        const key = await this.settings.key('deepseek');
        if (!key) balance = { status: 'not-connected', detail: '请先保存 DeepSeek API Key。' };
        else if (!base || (base.origin !== 'https://api.deepseek.com' && !isLoopback(base))) {
          balance = { status: 'unavailable', detail: '第三方连接的余额请在对应供应商控制台查看。' };
        } else {
          const data = await getJson(new URL('/user/balance', base), `Bearer ${key}`);
          if (!Array.isArray(data?.balance_infos)) throw new Error('Missing wallet data');
          balance = {
            status: 'ready', source: 'DeepSeek API',
            rows: data.balance_infos.flatMap((row: any) => row ? [
              ...wallet('可用余额', row.currency, row.total_balance),
              ...wallet('充值余额', row.currency, row.topped_up_balance),
              ...wallet('赠金余额', row.currency, row.granted_balance),
            ] : []),
          };
        }
      }
    } catch (error) { balance = failure(error); }
    const official = config.authMode === 'native' || endpoint(config.baseUrl)?.origin === 'https://api.deepseek.com';
    return { harness: 'deepseek', authMode: config.authMode, checkedAt: Date.now(), plan, balance, ...(official ? { consoleUrl: 'https://platform.deepseek.com/' } : {}) };
  }

  private async zcode(settings: Settings): Promise<AccountUsage> {
    const config = settings.zcode;
    const base = endpoint(config.baseUrl);
    const official = base?.origin === zai || isBigmodel(base?.origin);
    const codingRoute = !!base && /\/api\/coding(?:\/|$)/i.test(base.pathname);
    const region = settings.quotaRegion === 'auto' || !settings.quotaRegion
      ? isBigmodel(base?.origin) ? 'bigmodel' : 'zai'
      : settings.quotaRegion;
    const origin = region === 'bigmodel' ? bigmodel : zai;
    const canReuse = config.authMode === 'api' && codingRoute && !!base && (official || isLoopback(base));
    let plan: UsageSection<UsageWindow>;
    try {
      const usageKey = await this.settings.key('zcodeUsage');
      const key = usageKey || (canReuse ? await this.settings.key('zcode') : undefined);
      if (!key) {
        plan = { status: 'not-connected', detail: '在「用量」中配置 Coding Plan 查询密钥，或连接官方 Coding Plan API。' };
      } else {
        // An inference key is only reused on its own origin. An explicitly
        // configured quota key belongs to the user's selected official region.
        const quotaOrigin = usageKey ? origin : base!.origin;
        const data = await getJson(new URL('/api/monitor/usage/quota/limit', quotaOrigin), key);
        if (data?.code === 401 || data?.code === 403) throw new UsageHttpError(data.code);
        if (data?.code !== 200 || !Array.isArray(data?.data?.limits)) throw new Error('Missing quota data');
        const rows = quotaWindows(data.data.limits);
        const tier = typeof data.data.level === 'string' && /^[\w-]{1,24}$/.test(data.data.level) ? ` · ${data.data.level}` : '';
        plan = rows.length ? { status: 'ready', source: `GLM Coding Plan${tier}`, rows }
          : { status: 'unavailable', detail: '该密钥未返回可显示的套餐额度。' };
      }
    } catch (error) { plan = failure(error); }
    const consoleUrl = config.authMode === 'native' || official || plan.status === 'ready'
      ? region === 'bigmodel' ? 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' : 'https://z.ai/manage-apikey/apikey-list'
      : undefined;
    return {
      harness: 'zcode', authMode: config.authMode, checkedAt: Date.now(), plan, consoleUrl,
      balance: { status: 'unavailable', detail: 'GLM 的预付 API 余额请在供应商控制台查看。套餐额度单独显示。' },
    };
  }
}
