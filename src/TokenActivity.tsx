import { useI18n } from './i18n';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { harnesses, type TokenDay } from '../shared/types';
import { harnessNames } from '../shared/harnesses';
import { api, message } from './api';

const modes = [{ id: 'day', label: '每天' }, { id: 'week', label: '每周' }, { id: 'total', label: '累计总量' }] as const;
const dayFormat = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });
const count = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const dateAfter = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);

function activityWeeks(days: TokenDay[], locale: string) {
  const month = new Intl.DateTimeFormat(locale, { month: 'short' });
  const perDay = new Map(days.map(day => [day.day, harnesses.reduce((sum, harness) => sum + (day[harness] ?? 0), 0)]));
  const today = dateAfter(new Date(), 0);
  const monday = dateAfter(today, -((today.getDay() + 6) % 7));
  const start = dateAfter(monday, -52 * 7);
  return Array.from({ length: 53 }, (_, index) => {
    const first = dateAfter(start, index * 7);
    const last = dateAfter(first, 6);
    const cells = Array.from({ length: 7 }, (_, offset) => {
      const date = dateAfter(first, offset), day = dayFormat.format(date);
      return { day, tokens: perDay.get(day) ?? 0, future: date > today };
    });
    return {
      first: dayFormat.format(first), last: dayFormat.format(last), cells,
      month: index === 0 || first.getMonth() !== dateAfter(first, -7).getMonth() ? month.format(first) : '',
      tokens: cells.reduce((sum, day) => sum + day.tokens, 0),
    };
  });
}

export function TokenActivity() {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<(typeof modes)[number]['id']>('day');
  const [days, setDays] = useState<TokenDay[]>([]);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void api!.tokenActivity().then(data => { if (active) setDays(data); }, error => {
      if (active) setError(message(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [version]);
  const weeks = activityWeeks(days, locale);
  const max = mode === 'week' ? Math.max(1, ...weeks.map(week => week.tokens))
    : Math.max(1, ...weeks.flatMap(week => week.cells.map(day => day.tokens)));
  const intensity = (tokens: number) => Math.ceil(4 * Math.sqrt(tokens / max));
  const totals = harnesses.map(harness => ({ name: harnessNames[harness], tokens: days.reduce((sum, day) => sum + (day[harness] ?? 0), 0) }));
  return <section className="settings-card token-activity" aria-label={t("Token 活动")}>
    <header>
      <h3>{t("Token 活动")}</h3>
      <div className="activity-modes" aria-label={t("活动周期")}>
        {modes.map(option => <button key={option.id} aria-pressed={mode === option.id} onClick={() => setMode(option.id)}>{t(option.label)}</button>)}
        <button className="icon-button" title={t("刷新 Token 活动")} disabled={loading} onClick={() => setVersion(current => current + 1)}><RefreshCw className={loading ? 'spin' : ''} size={13}/></button>
      </div>
    </header>
    {mode === 'total' ? <div className="activity-totals">
      {[{ name: t("全部 Harness"), tokens: totals.reduce((sum, item) => sum + item.tokens, 0) }, ...totals].map(({ name, tokens }) =>
        <div key={name}><span>{name}</span><strong>{count.format(tokens)}</strong><small>tokens</small></div>)}
    </div> : <>
      <div className={`activity-grid ${mode}`} role="img" aria-label={t("最近 53 周{0} Token 活动", mode === 'day' ? t("每日") : t("每周"))}>
        {weeks.map(week => <div key={week.first} className="activity-week">
          {mode === 'day' ? week.cells.map(cell => <span key={cell.day} className="activity-cell" data-level={intensity(cell.tokens)}
            data-future={cell.future} title={cell.future ? undefined : `${cell.day} · ${count.format(cell.tokens)} tokens`}/>)
            : <div className="activity-bar-track" title={t("{0} 至 {1} · {2} tokens", week.first, week.last, count.format(week.tokens))}>
              <span className="activity-cell" data-level={intensity(week.tokens)} style={{ height: `${Math.sqrt(week.tokens / max) * 100}%` }}/>
            </div>}
          <span className="activity-month">{week.month}</span>
        </div>)}
      </div>
      <div className="activity-foot"><span>{t("近 53 周")}</span><strong title={count.format(weeks.reduce((sum, week) => sum + week.tokens, 0))}>{compact.format(weeks.reduce((sum, week) => sum + week.tokens, 0))} tokens</strong></div>
    </>}
    {error ? <p className="form-error" role="alert">{t(error)}</p>
      : <small>{loading ? t("正在统计本机请求…") : t("统计在 EntroTect 中执行、由各 Harness 回报的模型用量。")}</small>}
  </section>;
}
