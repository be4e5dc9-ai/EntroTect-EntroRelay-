import { useI18n } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RotateCcw, Zap } from 'lucide-react';
import type { ModelReasoning } from '../shared/types';

type SliderProps = {
  levels: ModelReasoning['levels'];
  value: string;
  label?: string;
  disabled?: boolean;
  onChange(value: string): void;
};

export function ReasoningSlider({ levels, value, label, disabled, onChange, summary }: SliderProps & {
  summary?: { modelId: string; effectiveLevel: string };
}) {
  const { t } = useI18n();
  const stops = [{ id: '', label: 'auto' }, ...levels];
  const selected = Math.max(0, stops.findIndex(stop => stop.id === value));
  const [preview, setPreview] = useState<number>();
  const dragging = useRef(false);
  const index = preview ?? selected;
  const fill = index / Math.max(1, stops.length - 1);
  function commit(next: number) {
    if (next !== selected && stops[next]) onChange(stops[next].id);
  }
  return <div className="reasoning-slider">
    {summary && <header>
      <Zap size={14} aria-hidden="true"/>
      <div><strong>{preview === undefined ? summary.effectiveLevel : stops[index]?.label}</strong><span title={summary.modelId}>{summary.modelId}</span></div>
      <button className="icon-button" type="button" title={t("恢复自动档位")} disabled={disabled || !value} onClick={() => commit(0)}><RotateCcw size={13}/></button>
    </header>}
    <div className="reasoning-track" data-dragging={preview !== undefined}>
      <span className="reasoning-fill" style={{ transform: `scaleX(${fill})` }} aria-hidden="true"/>
      <div className="reasoning-dots" aria-hidden="true">{stops.map((stop, position) => <i key={stop.id} data-filled={position < index}/>)}</div>
      <input type="range" min={0} max={stops.length - 1} step={1} value={index}
        aria-label={label ?? t("思考强度")} aria-valuetext={stops[index]?.label} disabled={disabled}
        aria-description={summary ? t("可选档位 {0}。auto 使用连接设置或 Harness 默认值。", stops.map(stop => stop.label).join('、')) : undefined}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={event => { dragging.current = false; setPreview(undefined); commit(event.currentTarget.valueAsNumber); }}
        onPointerCancel={() => { dragging.current = false; setPreview(undefined); }}
        onBlur={() => { dragging.current = false; setPreview(undefined); }}
        onChange={event => {
          const next = event.currentTarget.valueAsNumber;
          if (dragging.current) setPreview(next);
          else commit(next);
        }}/>
    </div>
    {!summary && <div className="reasoning-stops">
      {stops.map((stop, stopIndex) => <button key={stop.label} type="button" disabled={disabled}
        aria-pressed={stopIndex === index} onClick={() => commit(stopIndex)}>{stop.label}</button>)}
    </div>}
  </div>;
}

export function ReasoningControl({ levels, value, fallback, modelId, disabled, onChange }: SliderProps & { fallback?: string; modelId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function dismiss(event: Event) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function key(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('focusin', dismiss);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('focusin', dismiss);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const displayed = levels.find(level => level.id === value)?.label ?? fallback ?? 'auto';
  return <div className="reasoning-control" ref={root}>
    <button ref={trigger} className="control-button reasoning-trigger" type="button" disabled={disabled}
      title={t("选择思考强度")} aria-label={t("选择思考强度 · {0}", displayed)} aria-expanded={open}
      onClick={() => setOpen(previous => !previous)}><span>{t("思考强度")}</span><strong>{displayed}</strong><ChevronDown size={12}/></button>
    <section className="popover reasoning-popover" aria-label={t("思考强度选项")} inert={!open}>
      <ReasoningSlider levels={levels} value={value} disabled={disabled} onChange={onChange} summary={{ modelId, effectiveLevel: displayed }}/>
    </section>
  </div>;
}
