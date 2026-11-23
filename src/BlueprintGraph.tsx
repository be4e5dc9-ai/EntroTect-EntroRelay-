import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleDot, Focus, House, Minus, Plus } from 'lucide-react';
import { harnesses, type BlueprintRule, type BlueprintScope, type BlueprintTarget, type Harness, type NativeHistorySource } from '../shared/types';
import { blueprintParents, blueprintScopeKey as scopeKey, harnessScope } from '../shared/blueprint';
import { harnessNames } from '../shared/harnesses';
import { useI18n } from './i18n';
import { HarnessIcon } from './BrandIcon';

export const targets: BlueprintTarget[] = [...harnesses, 'workbench'];
type Point = {x: number; y: number};
type View = Point & {scale: number};
type Drawing = {pointer: number; scope: BlueprintScope; start: Point; client: Point};
type NodeKey = `sender:${Harness}` | `receiver:${BlueprintTarget}`;
type NodePositions = Partial<Record<NodeKey, Point>>;
type NodeMove = { pointer: number; key: NodeKey; button: HTMLButtonElement; node: HTMLElement; start: Point; offset: Point; destination?: Point };
const initialPoint = {x:0,y:0};
const layoutKey = 'entrotect.blueprint.node-positions';
const senderKey = (h: Harness): NodeKey => `sender:${h}`;
const receiverKey = (t: BlueprintTarget): NodeKey => `receiver:${t}`;
function loadPositions(): NodePositions {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) ?? '{}');
    return Object.fromEntries([...harnesses.map(senderKey),...targets.map(receiverKey)].flatMap(key=>{
      const point = saved?.[key];
      return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? [[key, {x:point.x,y:point.y}]] : [];
    }));
  } catch { return {}; }
}
function savePositions(positions: NodePositions) {
  try { localStorage.setItem(layoutKey, JSON.stringify(positions)); } catch { /* Layout stays available for this view. */ }
}
const translate = ({x,y}:Point) => `${x}px ${y}px`;
function curve(a: Point, b: Point) {
  const bend = Math.max(30, Math.min(220, Math.abs(b.x - a.x) * .48));
  return `M${a.x},${a.y} C${a.x+bend},${a.y} ${b.x-bend},${b.y} ${b.x},${b.y}`;
}
export type Port = (scope: BlueprintScope, title: string) => ReactNode;
export function BlueprintGraph({ expandedSources, sources, selected, rules, onToggleSource, onRaiseSource, onSelect, onConnect, disabled, children }: {
  expandedSources: readonly Harness[]; sources?: Record<Harness,NativeHistorySource>; selected?: BlueprintScope; rules: BlueprintRule[]; disabled: boolean;
  onToggleSource(harness: Harness): void; onRaiseSource(harness: Harness): void;
  onSelect(scope: BlueprintScope, title: string): void;
  onConnect(scope: BlueprintScope, target: BlueprintTarget): void; children(harness: Harness, port: Port): ReactNode;
}) {
  const {t} = useI18n();
  const canvas = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null), paths = useRef<SVGGElement>(null), preview = useRef<SVGPathElement>(null);
  const transform = useRef<View>({x:0,y:0,scale:1}), frame = useRef(0), lineFrame = useRef(0);
  const draw = useRef<Drawing | undefined>(undefined), pan = useRef<{pointer:number;start:Point;view:View}|undefined>(undefined);
  const suppressClick = useRef(false);
  const nodeMove = useRef<NodeMove|undefined>(undefined);
  const suppressNodeClick = useRef<HTMLButtonElement|undefined>(undefined);
  const [positions,setPositions] = useState(loadPositions);
  const [scale,setScale]=useState(1);
  const geometry = useRef({rules, selected}); geometry.current={rules,selected};

  const paintLinks = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current=0;
      if (!canvas.current || !paths.current) return;
      const board=canvas.current, base=board.getBoundingClientRect();
      const center=(el:Element,side?:'left'|'right'):Point=>{
        const r=el.getBoundingClientRect();
        return {x:(side==='left'?r.left:side==='right'?r.right:(r.left+r.right)/2)-base.left,y:(r.top+r.bottom)/2-base.top};
      };
      const ports=new Map<string,Element>();
      const portNodes=board.querySelectorAll<HTMLElement>('[data-scope-port]');
      const listRects=new Map<Element,DOMRect>();
      for (const port of portNodes) {
        const r=port.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const list=port.closest('.bp-tree-list');
        if (list && !listRects.has(list)) listRects.set(list,list.getBoundingClientRect());
        const bounds=list && listRects.get(list);
        if (port.hasAttribute('data-whole-harness') || bounds && r.top>=bounds.top-1 && r.bottom<=bounds.bottom+1) {
          ports.set(port.dataset.scopePort!,port);
        }
      }
      const {rules,selected}=geometry.current;
      const wires=new Map<string,{from:Element;to:Element;inherited:boolean;highlight:boolean}>();
      const senders=new Map(Array.from(board.querySelectorAll<HTMLElement>('[data-sender]'),node=>[node.dataset.sender,node]));
      const receivers=new Map(Array.from(board.querySelectorAll<HTMLElement>('[data-receiver]'),node=>[node.dataset.receiver,node]));
      function wire(rule:BlueprintRule, inherited=false) {
        const key=scopeKey(rule.scope), port=ports.get(key);
        const from=port??senders.get(rule.scope.source.harness), to=receivers.get(rule.target);
        if (from && to) wires.set(JSON.stringify([port?key:rule.scope.source.harness,rule.target]),{from,to,inherited,highlight:!!selected && scopeKey(selected)===key});
      }
      for(const rule of rules) if(rule.enabled)wire(rule);
      if(selected) {
        for(const target of targets) {
          if (rules.some(r=>r.target===target&&scopeKey(r.scope)===scopeKey(selected))) continue;
          const inherited=blueprintParents(selected).map(parent=>rules.find(r=>r.target===target&&scopeKey(r.scope)===scopeKey(parent))).find(r=>r!==undefined);
          if(inherited?.enabled)wire({...inherited,scope:selected},true);
        }
      }
      const fragment=document.createDocumentFragment();
      const connected=new Set<Element>();
      for(const w of wires.values()){
        connected.add(w.from);
        connected.add(w.to);
        const path=document.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('d',curve(center(w.from,w.from.hasAttribute('data-sender')?'right':undefined),center(w.to,'left')));
        path.setAttribute('class',`bp-wire ${w.highlight?'chosen':''} ${w.inherited?'inherited':''}`);
        fragment.append(path);
      }
      receivers.forEach(node=>node.toggleAttribute('data-linked',connected.has(node)));
      portNodes.forEach(node=>node.toggleAttribute('data-linked',connected.has(node)));
      paths.current.replaceChildren(fragment);
    });
  },[]);
  useLayoutEffect(()=>{paintLinks();});
  useEffect(()=>{
    const board=canvas.current!, layer=world.current!, observer=new ResizeObserver(paintLinks);
    let observedLists=new Set<Element>();
    function watchLists(){
      const lists=new Set<Element>(layer.querySelectorAll('.bp-tree-list'));
      for(const list of observedLists)if(!lists.has(list))observer.unobserve(list);
      for(const list of lists)if(!observedLists.has(list))observer.observe(list);
      observedLists=lists;
      paintLinks();
    }
    observer.observe(board);
    const changes=new MutationObserver(watchLists);
    changes.observe(layer,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
    watchLists();
    board.addEventListener('scroll',paintLinks,true);
    return ()=>{
      observer.disconnect();
      changes.disconnect();
      board.removeEventListener('scroll',paintLinks,true);
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(lineFrame.current);
      frame.current=0;
      lineFrame.current=0;
    };
  },[paintLinks]);
  const apply=useCallback((v:View)=>{
    transform.current=v;
    if(world.current)world.current.style.transform=`translate(${v.x}px,${v.y}px) scale(${v.scale})`;
    if(canvas.current) {
      canvas.current.style.backgroundPosition=`${v.x}px ${v.y}px`;
      canvas.current.style.backgroundSize=`${20*v.scale}px ${20*v.scale}px`;
    }
    paintLinks();
  },[paintLinks]);
  const zoom=useCallback((factor:number,at?:Point)=>{
    const v=transform.current, next=Math.max(.65,Math.min(1.6,Math.round(v.scale*factor*100)/100));
    const point=at??{x:(canvas.current?.clientWidth??0)/2,y:(canvas.current?.clientHeight??0)/2};
    const ratio=next/v.scale;
    apply({x:point.x+(v.x-point.x)*ratio,y:point.y+(v.y-point.y)*ratio,scale:next});
    setScale(next);
  },[apply]);
  function reset(){
    apply({x:0,y:0,scale:1});
    setScale(1);
    setPositions({});
  }
  useEffect(()=>{
    const board=canvas.current!;
    function wheel(e:WheelEvent){
      if(e.ctrlKey||e.metaKey){
        e.preventDefault();
        const rect=board.getBoundingClientRect();
        zoom(e.deltaY<0?1.1:1/1.1,{x:e.clientX-rect.left,y:e.clientY-rect.top});
      }
      else if(!(e.target as Element).closest('button,input,.bp-tree,.bp-dock')){e.preventDefault();const v=transform.current;apply({...v,x:v.x-e.deltaX,y:v.y-e.deltaY});}
    }
    board.addEventListener('wheel',wheel,{passive:false});return()=>board.removeEventListener('wheel',wheel);
  },[apply,zoom]);
  const cancel=useCallback(()=>{
    draw.current=undefined;pan.current=undefined;cancelAnimationFrame(lineFrame.current);lineFrame.current=0;
    preview.current?.removeAttribute('d');
    if(canvas.current){delete canvas.current.dataset.dragging;delete canvas.current.dataset.panning;}
  },[]);
  const endNodeMove=useCallback((commit=false)=>{
    const moving=nodeMove.current;
    nodeMove.current=undefined;
    if(!moving?.destination)return;
    moving.node.removeAttribute('data-moving');
    if(!commit)moving.node.style.translate=translate(moving.offset);
    suppressNodeClick.current=moving.button;
    const destination=moving.destination;
    if(commit)setPositions(previous=>({...previous,[moving.key]:destination}));
    paintLinks();
  },[paintLinks]);
  useEffect(()=>{savePositions(positions);},[positions]);
  useEffect(()=>{
    const abort=()=>{cancel();endNodeMove();};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape')abort();};
    window.addEventListener('keydown',key);window.addEventListener('blur',abort);
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('blur',abort);abort();};
  },[cancel,endNodeMove]);
  function nodeProps(key:NodeKey,click:()=>void){
    return {
      onPointerDown:(e:ReactPointerEvent<HTMLButtonElement>)=>{
        if(e.button!==0||draw.current||pan.current||nodeMove.current)return;
        const button=e.currentTarget;
        suppressNodeClick.current=undefined;
        const node=button.closest<HTMLElement>('.bp-sender-node')??button;
        nodeMove.current={pointer:e.pointerId,key,button,node,start:{x:e.clientX,y:e.clientY},offset:positions[key]??initialPoint};
        button.setPointerCapture(e.pointerId);
      },
      onClick:(e:React.MouseEvent<HTMLButtonElement>)=>{
        if(e.detail>0&&suppressNodeClick.current===e.currentTarget)return;
        click();
      },
    };
  }
  function startWire(e:ReactPointerEvent<HTMLButtonElement>,scope:BlueprintScope,title:string){
    if(e.button!==0||disabled||nodeMove.current||pan.current)return;
    e.stopPropagation();suppressClick.current=false;onSelect(scope,title);
    const r=e.currentTarget.getBoundingClientRect(), base=canvas.current!.getBoundingClientRect();
    draw.current={pointer:e.pointerId,scope,start:{x:(r.left+r.right)/2-base.left,y:(r.top+r.bottom)/2-base.top},client:{x:e.clientX,y:e.clientY}};
    e.currentTarget.setPointerCapture(e.pointerId);canvas.current!.dataset.dragging='';
  }
  function move(e:ReactPointerEvent){
    const moving=nodeMove.current;
    if(moving?.pointer===e.pointerId){
      const x=e.clientX-moving.start.x, y=e.clientY-moving.start.y;
      if(!moving.destination&&Math.hypot(x,y)<5)return;
      moving.node.setAttribute('data-moving','');
      const zoom=transform.current.scale;
      moving.destination={x:moving.offset.x+x/zoom,y:moving.offset.y+y/zoom};
      const offset=translate(moving.destination);
      moving.node.style.translate=offset;
      paintLinks();
      return;
    }
    const v=pan.current, d=draw.current;
    if(v?.pointer===e.pointerId){apply({...v.view,x:v.view.x+e.clientX-v.start.x,y:v.view.y+e.clientY-v.start.y});return;}
    if(!d||d.pointer!==e.pointerId)return;
    const {clientX:x,clientY:y}=e;d.client={x,y};
    if(lineFrame.current)return;
    lineFrame.current=requestAnimationFrame(()=>{
      lineFrame.current=0;if(draw.current!==d||!canvas.current)return;
      const b=canvas.current.getBoundingClientRect();preview.current?.setAttribute('d',curve(d.start,{x:d.client.x-b.left,y:d.client.y-b.top}));
    });
  }
  function up(e:ReactPointerEvent){
    if(nodeMove.current?.pointer===e.pointerId){endNodeMove(true);return;}
    const d=draw.current;
    if(d?.pointer===e.pointerId){
      const target=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-receiver]')?.dataset.receiver as BlueprintTarget|undefined;
      cancel();
      if(target&&!disabled){suppressClick.current=true;onConnect(d.scope,target);}
    } else if(pan.current?.pointer===e.pointerId)cancel();
  }
  const port:Port=(scope,title)=><button type="button" className="bp-port" disabled={disabled}
    data-scope-port={scopeKey(scope)} data-whole-harness={scope.wholeHarness ? '' : undefined}
    aria-label={t("连接 {0}",title)} title={scope.wholeHarness ? t("连接 {0}",title) : undefined} aria-pressed={!!selected&&scopeKey(selected)===scopeKey(scope)}
    onPointerDown={e=>startWire(e,scope,title)} onClick={()=>{if(!suppressClick.current)onSelect(scope,title);suppressClick.current=false;}}><i/></button>;
  return <div className="bp-canvas" ref={canvas} onPointerMove={move} onPointerUp={up}
    onPointerCancel={()=>{cancel();endNodeMove();}} onLostPointerCapture={()=>{cancel();endNodeMove();}}
    onPointerDown={e=>{
      if(e.button!==0&&e.button!==1||nodeMove.current||draw.current|| (e.target as Element).closest('button,input,.bp-tree,.bp-dock'))return;
      e.preventDefault();pan.current={pointer:e.pointerId,start:{x:e.clientX,y:e.clientY},view:{...transform.current}};
      e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.dataset.panning='';
    }}>
    <svg className="bp-wires" aria-hidden="true"><g ref={paths}/><path className="bp-wire preview" ref={preview}/></svg>
    <div className="bp-world" ref={world}>
    <div className="bp-dock bp-senders"><h2>{t("发送方")}</h2>{harnesses.map(harness=>{
      const layer=expandedSources.indexOf(harness)+1;
      const expanded=layer>0;
      const card=children(harness,port);
      const name=harnessNames[harness];
      const style={translate:translate(positions[senderKey(harness)]??initialPoint),'--bp-sender-order':layer} as CSSProperties;
      return <div className="bp-sender-node" key={harness} style={style}>
        <button className="bp-node" data-sender={harness} aria-label={t(expanded?"收起 {0} 来源":"展开 {0} 来源",name)}
          aria-expanded={expanded} aria-controls={card?`bp-source-${harness}`:undefined} {...nodeProps(senderKey(harness),()=>onToggleSource(harness))}>
          <HarnessIcon h={harness}/><span>{name}</span>{expanded?<ChevronLeft size={14}/>:<ChevronRight size={14}/>}</button>
        {sources&&port(harnessScope(sources[harness]),t("{0} 的全部原生对话",name))}
        {card&&<div className="bp-tree-position" id={`bp-source-${harness}`} hidden={!expanded}
          onPointerDownCapture={()=>onRaiseSource(harness)} onFocusCapture={()=>onRaiseSource(harness)}>{card}</div>}
      </div>;
    })}</div>
    <div className="bp-dock bp-receivers"><h2>{t("接收方")}</h2>{targets.map(target=><button key={target} className="bp-node" data-receiver={target}
        aria-label={t("连接到 {0}",target==='workbench'?t("EntroTect 工作台"):harnessNames[target])}
        aria-disabled={disabled||!selected} style={{translate:translate(positions[receiverKey(target)]??initialPoint)}} {...nodeProps(receiverKey(target),()=>{if(selected&&!disabled)onConnect(selected,target);})}>
        <i className="bp-input"/>{target==='workbench'?<House size={16}/>:<HarnessIcon h={target}/>}
        <span>{target==='workbench'?t("EntroTect 工作台"):harnessNames[target]}</span></button>)}</div>
    </div>
    <div className="bp-zoom"><button title={t("缩小画布")} onClick={()=>zoom(1/1.12)}><Minus size={15}/></button><span>{Math.round(scale*100)}%</span>
      <button title={t("放大画布")} onClick={()=>zoom(1.12)}><Plus size={15}/></button><button title={t("复位画布")} onClick={reset}><Focus size={15}/></button></div>
    {!expandedSources.length&&<div className="bp-empty"><CircleDot size={28}/><strong>{t("选择一个发送方")}</strong><span>{t("展开发送方，查看它的原生项目和对话。")}</span></div>}
  </div>;
}
