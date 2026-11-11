// The SDK's session/query supports a subset of built-ins. This plugin gives
// our desktop client access to the registry of the same SDK-owned agent.
export const dshIntegration = String.raw`
export const name = 'entrotect-desktop';
export const inject = ['agents', 'sessions'];
async function readBalance(account) {
  // The SDK's getBalance may expire the stored native grant on 401. Keep
  // this background lookup read-only by using the SDK's session descriptor.
  const session = await account.getPlatformSession();
  if (!session) return null;
  const url = new URL('/api/v0/users/get_user_summary', session.origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  if (url.origin !== 'https://platform.deepseek.com' && !local) return { status: 'failed' };
  const headers = new Headers(session.requestHeaders);
  headers.set('accept', 'application/json');
  headers.set('x-dsh-auth-token', session.token);
  headers.set('x-client-platform', 'web');
  headers.set('x-client-bundle-id', '');
  headers.set('x-client-version', '0.6.4');
  headers.set('x-client-locale', 'zh_CN');
  headers.set('x-client-timezone-offset', String(-new Date().getTimezoneOffset() * 60));
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8_000) });
  if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
  if (!response.ok) return { status: 'failed' };
  const result = await response.json();
  if (result?.code === 40003) return { status: 'unauthorized' };
  const data = result?.data?.biz_data;
  if (result?.code !== 0 || result?.data?.biz_code !== 0 || !Array.isArray(data?.normal_wallets) || !Array.isArray(data?.bonus_wallets)) {
    return { status: 'failed' };
  }
  const amounts = rows => rows.flatMap(row => typeof row?.currency === 'string' && typeof row.balance === 'string'
    ? [{ currency: row.currency, balance: row.balance }] : []);
  return { status: 'ready', value: amounts(data.normal_wallets), bonusWallets: amounts(data.bonus_wallets) };
}
export function apply(ctx) {
  if (process.env.ENTROTECT_DSH_KEEP_IMPORTED_ARCHIVE_LOCAL === '1') {
    ctx.inject(['sessionLogDeepSeek'], (child) => {
      child.sessionLogDeepSeek.registerExclusion(() => true);
    });
  }
  const lifetime = new AbortController();
  const runningCommands = new Map();
  const stream = ({ agent, frame }) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'entrotect.stream', params: { sessionId: String(agent.session.id), frame } }) + '\n');
  };
  const receive = async (request) => {
    if (request?.channel !== 'entrotect.commands') return;
    const { id, action, sessionId, line } = request;
    if (action === 'cancel') { lifetime.abort(); return; }
    const reply = (body) => {
      if (process.connected) process.send({ channel: request.channel, id, ...body }, () => {});
    };
    try {
      if (action === 'balance') {
        const account = ctx.get('deepseekAccount');
        if (!account?.getPlatformSession) throw new Error('DeepSeek 运行时没有账户服务');
        reply({ result: await readBalance(account) });
        return;
      }
      if (action === 'flush') {
        const agent = ctx.agents.get(sessionId);
        if (!agent || !await ctx.sessions.flush(agent.session)) throw new Error('DeepSeek 会话没有完成持久化');
        reply({ result: true });
        return;
      }
      if (action === 'pause') {
        const agent = ctx.agents.get(sessionId);
        if (!agent) throw new Error('DeepSeek 会话尚未就绪');
        const command = runningCommands.get(sessionId);
        // Match the native session controller. Keep queued input and leave
        // separately managed background sessions to the harness.
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        command?.controller.abort();
        await command?.execution.catch(() => {});
        await agent.whenIdle();
        reply({ result: true });
        return;
      }
      if (action === 'context') {
        const agent = ctx.agents.get(sessionId), meter = ctx.get('tokenMeter');
        if (!agent || !meter) { reply({ result: null }); return; }
        const { contextWindow } = meter.contextPressure(agent.session);
        const measured = contextWindow ? meter.measure(agent.session) : null;
        reply({ result: measured ? { usedTokens: measured.totalTokens, windowTokens: contextWindow } : null });
        return;
      }
      const agent = ctx.agents.get(sessionId), commands = ctx.get('commands');
      if (!agent || !commands) throw new Error('当前 DeepSeek SDK 配置没有可用的命令注册表');
      if (action === 'list') {
        reply({ result: commands.list(agent).map(({ name, description, input }) => ({ name, description, inputHint: input?.hint })) });
      } else if (action === 'execute') {
        const controller = new AbortController();
        const execution = commands.execute(agent, line, [], AbortSignal.any([lifetime.signal, controller.signal]));
        runningCommands.set(sessionId, { controller, execution });
        try {
          const result = await execution;
          if (!result) throw new Error('当前会话没有这条斜杠命令');
          reply({ result: result.result });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          reply({ result: null });
        } finally {
          runningCommands.delete(sessionId);
        }
      }
    } catch (error) {
      reply({ error: error?.message ?? String(error) });
    }
  };
  ctx.on('agent/assistant-stream', stream);
  const abort = () => lifetime.abort();
  process.on('message', receive);
  process.once('disconnect', abort);
  ctx.on('dispose', () => {
    abort();
    process.off('message', receive);
    process.off('disconnect', abort);
  });
}
`;
