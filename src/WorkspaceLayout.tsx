import { useI18n } from './i18n';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

type Side = 'left' | 'right';
type Widths = Record<Side, number>;
type Preferences = Partial<Widths>;
type Drag = {
  side: Side;
  pointerId: number;
  handle: HTMLDivElement;
  listeners: AbortController;
  origin: number;
  width: number;
  limit: number;
  edge: number;
};
const sides = ['left', 'right'] as const;
const minimum: Widths = { left: 180, right: 220 };
const maximum: Widths = { left: 440, right: 540 };
const defaults: Widths = { left: 246, right: 306 };
const centerMinimum = 440;
const storageKey = 'entrotect.workspacePaneWidths';
const labels: Record<Side, string> = { left: '调整左侧栏宽度', right: '调整右侧栏宽度' };
const clamp = (width: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, width)));
const other = (side: Side) => side === 'left' ? 'right' : 'left';
const direction = (side: Side) => side === 'left' ? 1 : -1;
const dragWidth = (drag: Drag, position: number) => clamp(drag.width + (position - drag.origin) * direction(drag.side), minimum[drag.side], drag.limit);

function readWidths(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return Object.fromEntries(sides.filter(side => Number.isFinite(value?.[side]))
      .map(side => [side, clamp(value[side], minimum[side], maximum[side])]));
  } catch { return {}; }
}

export function WorkspaceLayout({ leftOpen, rightOpen, hidden, inactive, left, right, children }: {
  leftOpen: boolean; rightOpen: boolean; hidden: boolean; inactive: boolean;
  left: ReactNode; right: ReactNode; children: ReactNode;
}) {
  const { t } = useI18n();
  const layout = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const leftHandle = useRef<HTMLDivElement>(null);
  const rightHandle = useRef<HTMLDivElement>(null);
  const [initial] = useState(readWidths);
  const preferences = useRef(initial);
  const preferredDefaults = useRef(defaults);
  const current = useRef<Widths>(defaults);
  const budget = useRef(0);
  const drag = useRef<Drag | null>(null);
  const shown = { left: leftOpen, right: rightOpen };

  function available(side: Side, widths: Widths) {
    return clamp(budget.current - (shown[other(side)] ? widths[other(side)] : 0), minimum[side], maximum[side]);
  }
  function apply(widths: Widths) {
    current.current = widths;
    for (const side of sides) {
      const handle = (side === 'left' ? leftHandle : rightHandle).current;
      layout.current?.style.setProperty(`--${side}-width`, `${widths[side]}px`);
      handle?.setAttribute('aria-valuenow', String(widths[side]));
      handle?.setAttribute('aria-valuemax', String(available(side, widths)));
    }
  }
  function persist(side: Side, width?: number) {
    const next = { ...preferences.current };
    if (width === undefined) delete next[side];
    else next[side] = width;
    preferences.current = next;
    try { localStorage.setItem(storageKey, JSON.stringify(preferences.current)); } catch {}
  }
  function drawGuide(active: Drag, position: number) {
    const x = active.edge + (dragWidth(active, position) - active.width) * direction(active.side);
    const transform = `translateX(${x}px)`;
    const line = guide.current;
    if (line && line.style.transform !== transform) line.style.transform = transform;
  }
  function endDrag(position?: number) {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    active.listeners.abort();
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    if (position !== undefined) {
      const width = dragWidth(active, position);
      if (width !== active.width) {
        apply({ ...current.current, [active.side]: width });
        persist(active.side, width);
      }
    }
    layout.current?.removeAttribute('data-resizing');
  }

  useLayoutEffect(() => {
    const root = layout.current!;
    if (hidden) return;
    let lastWidth = 0;
    function fit() {
      const width = root.clientWidth;
      if (!width || width === lastWidth) return;
      lastWidth = width;
      endDrag();
      const style = getComputedStyle(root);
      preferredDefaults.current = {
        left: parseFloat(style.getPropertyValue('--sidebar-width')) || defaults.left,
        right: parseFloat(style.getPropertyValue('--inspector-width')) || defaults.right,
      };
      const desired = { ...preferredDefaults.current, ...preferences.current };
      const visible = sides.filter(side => shown[side]);
      const minTotal = visible.reduce((sum, side) => sum + minimum[side], 0);
      const desiredTotal = visible.reduce((sum, side) => sum + desired[side], 0);
      budget.current = Math.max(minTotal, width - centerMinimum);
      if (desiredTotal > budget.current) {
        for (const side of visible) {
          const share = (desired[side] - minimum[side]) / (desiredTotal - minTotal);
          desired[side] = Math.floor(minimum[side] + share * (budget.current - minTotal));
        }
      }
      apply(desired);
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => { observer.disconnect(); endDrag(); };
  }, [leftOpen, rightOpen, hidden]);

  useLayoutEffect(() => {
    if (inactive) endDrag();
  }, [inactive]);

  function start(side: Side, event: PointerEvent<HTMLDivElement>) {
    const root = layout.current;
    if (!root || !event.isPrimary || event.button !== 0 || drag.current) return;
    const width = current.current[side];
    const active: Drag = {
      side, pointerId: event.pointerId, handle: event.currentTarget, listeners: new AbortController(),
      origin: event.clientX, width, limit: available(side, current.current),
      edge: side === 'left' ? width : root.clientWidth - width,
    };
    event.preventDefault();
    active.handle.focus({ preventScroll: true });
    active.handle.setPointerCapture(active.pointerId);
    drag.current = active;
    drawGuide(active, active.origin);
    root.setAttribute('data-resizing', side);

    // WebView2 can retarget moves to the workspace even after pointer capture.
    const options = { capture: true, passive: true, signal: active.listeners.signal };
    window.addEventListener('pointermove', move => {
      if (move.pointerId !== active.pointerId) return;
      if (move.pointerType === 'mouse' && (move.buttons & 1) === 0) endDrag();
      else drawGuide(active, move.clientX);
    }, options);
    window.addEventListener('pointerup', up => {
      if (up.pointerId === active.pointerId) endDrag(up.clientX);
    }, options);
    window.addEventListener('pointercancel', cancel => {
      if (cancel.pointerId === active.pointerId) endDrag();
    }, options);
    window.addEventListener('blur', () => endDrag(), { signal: active.listeners.signal });
  }
  function resizeWithKey(side: Side, event: KeyboardEvent<HTMLDivElement>) {
    if (drag.current) return;
    const step = event.shiftKey ? 32 : 12;
    let target = current.current[side];
    switch (event.key) {
      case 'ArrowLeft': target -= step * direction(side); break;
      case 'ArrowRight': target += step * direction(side); break;
      case 'Home': target = minimum[side]; break;
      case 'End': target = available(side, current.current); break;
      default: return;
    }
    event.preventDefault();
    const width = clamp(target, minimum[side], available(side, current.current));
    apply({ ...current.current, [side]: width });
    persist(side, width);
  }
  function handle(side: Side) {
    return <div ref={side === 'left' ? leftHandle : rightHandle} className={`pane-handle pane-handle-${side}`}
      role="separator" tabIndex={0} aria-orientation="vertical" aria-label={labels[side]}
      aria-controls={`workspace-${side}`} aria-valuemin={minimum[side]} title={t("{0} · 双击恢复默认", labels[side])}
      onPointerDown={event => start(side, event)}
      onKeyDown={event => resizeWithKey(side, event)}
      onDoubleClick={() => {
        const width = clamp(preferredDefaults.current[side], minimum[side], available(side, current.current));
        apply({ ...current.current, [side]: width });
        persist(side);
      }}/>;
  }
  return <div ref={layout} className={`workspace-layout ${leftOpen ? '' : 'sidebar-hidden'} ${rightOpen ? '' : 'inspector-hidden'}`}
    hidden={hidden} inert={inactive}>
    <div id="workspace-left" className="workspace-pane" inert={!leftOpen}>
      {left}
      {handle('left')}
    </div>
    {children}
    <div id="workspace-right" className="workspace-pane project-pane" inert={!rightOpen}>
      {right}
      {handle('right')}
    </div>
    <div ref={guide} className="pane-resize-guide" aria-hidden="true"/>
  </div>;
}
