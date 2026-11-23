import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Folder, GitBranch, House, Link2Off, LoaderCircle, MessageSquare, RefreshCw, Workflow, X } from 'lucide-react';
import type { BlueprintConflict, BlueprintScope, BlueprintState, BlueprintTarget, Harness, NativeHistorySource } from '../shared/types';
import { blueprintParents, blueprintScopeKey as scopeKey } from '../shared/blueprint';
import { harnessNames } from '../shared/harnesses';
import { api, message } from './api';
import { HarnessIcon } from './BrandIcon';
import { BlueprintGraph, targets } from './BlueprintGraph';
import { BlueprintSourceCard, type BlueprintFocus } from './BlueprintSourceCard';
import { useI18n } from './i18n';
import './Blueprint.css';

export type { BlueprintFocus };

type SourcePanels = { expanded: Harness[]; visited: ReadonlySet<Harness> };

function expandSource(panels:SourcePanels,harness:Harness):SourcePanels {
  if(panels.expanded.at(-1)===harness)return panels;
  return {expanded:[...panels.expanded.filter(source=>source!==harness),harness],visited:new Set([...panels.visited,harness])};
}

export function BlueprintPage({focus,returnToSettings,onBack}:{focus:BlueprintFocus;returnToSettings:boolean;onBack():void}) {
  const {t}=useI18n();
  const [graph,setGraph]=useState<BlueprintState>();
  const [sources,setSources]=useState<Record<Harness,NativeHistorySource>>();
  const [panels,setPanels]=useState<SourcePanels>(()=>focus.harness
    ? {expanded:[focus.harness],visited:new Set([focus.harness])}
    : {expanded:[],visited:new Set()});
  const [refreshVersion,setRefreshVersion]=useState(0);
  const [selected,setSelected]=useState<{scope:BlueprintScope;title:string}>();
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const [conflict,setConflict]=useState<string>();
  const stateVersion=useRef(0), mutating=useRef(false);
  const targetName=(target:BlueprintTarget)=>target==='workbench'?t("EntroTect 工作台"):harnessNames[target];
  const reloadState=useCallback(async()=>{
    const ticket=++stateVersion.current;
    const value=await api!.blueprint();
    if(ticket===stateVersion.current)setGraph(value);
  },[]);
  useEffect(()=>{
    let mounted=true;
    void reloadState().catch(e=>{if(mounted)setError(message(e));});
    void api!.historyDefaults().then(value=>{if(mounted)setSources(value);},e=>{if(mounted)setError(message(e));});
    const unsubscribe=api!.onEvent(e=>{
      if(e.type==='history-sync'&&!e.status.running&&!mutating.current){
        void reloadState().catch(error=>{if(mounted)setError(message(error));});
      }
    });
    return()=>{mounted=false;stateVersion.current++;unsubscribe();};
  },[reloadState]);
  useEffect(()=>{
    const harness=focus.harness;
    if(harness)setPanels(previous=>expandSource(previous,harness));
  },[focus]);

  function toggleSource(harness:Harness){
    setPanels(previous=>previous.expanded.includes(harness)
      ? {...previous,expanded:previous.expanded.filter(source=>source!==harness)}
      : expandSource(previous,harness));
  }
  function raiseSource(harness:Harness){
    setPanels(previous=>previous.expanded.includes(harness)?expandSource(previous,harness):previous);
  }
  const select=useCallback((scope:BlueprintScope,title:string)=>{
    setConflict(undefined);
    setSelected({scope,title});
  },[]);

  async function action(fn:()=>Promise<void>){
    if(mutating.current)return false;
    mutating.current=true;
    setBusy(true);
    setError('');
    setNotice('');
    stateVersion.current++;
    try{await fn();return true;}
    catch(e){setError(message(e));return false;}
    finally{mutating.current=false;setBusy(false);}
  }
  function rule(scope:BlueprintScope,target:BlueprintTarget,enabled:boolean|null){
    void action(async()=>{
      setGraph(await api!.blueprintRule(scope,target,enabled));
      setNotice(enabled?t("已连接到 {0}",targetName(target)):t("已更新连接"));
    });
  }
  function confirm(scopes:BlueprintScope[],classification:'native'|'copy'){
    return action(async()=>{
      await api!.blueprintConfirm(scopes,classification);
      await reloadState();
      setNotice(t("已更新 {0} 条记录的归属",scopes.length));
    });
  }
  function sync(){
    return action(async()=>{
      const status=await api!.syncHistory();
      await reloadState();
      setRefreshVersion(previous=>previous+1);
      if(status.issues.length)setError(status.issues.map(issue=>t(issue)).join('\n'));
      else setNotice(t("已检查已连接的项目和对话"));
    });
  }
  const currentConflict=graph?.conflicts.find(item=>item.id===conflict);
  const allRules=graph?.rules??[];

  return <main className="blueprint-page" aria-label={t("同步蓝图")}>
    <header className="bp-header"><button className="icon-button" title={returnToSettings?t("返回设置"):t("返回工作区")} onClick={onBack}><ArrowLeft size={18}/></button>
      <Workflow size={20}/><h1>{t("同步蓝图")}</h1><button className="secondary-button" disabled={busy||!graph} onClick={()=>void sync()}>{busy?<LoaderCircle size={14} className="spin"/>:<RefreshCw size={14}/>} {t("立即同步")}</button></header>
    {!!graph?.conflicts.length&&<div className="bp-conflicts"><GitBranch size={16}/><strong>{t("同步冲突")}</strong>{graph.conflicts.map(c=><button key={c.id} aria-pressed={conflict===c.id} onClick={()=>setConflict(c.id)}>{c.title} <ChevronRight size={12}/></button>)}</div>}
    <BlueprintGraph expandedSources={panels.expanded} sources={sources} selected={selected?.scope} rules={allRules}
      disabled={busy||!graph} onToggleSource={toggleSource} onRaiseSource={raiseSource} onSelect={select}
      onConnect={(scope,target)=>rule(scope,target,true)}>
      {(harness,port)=>panels.visited.has(harness)?<BlueprintSourceCard harness={harness} port={port} visible={panels.expanded.includes(harness)}
        refreshVersion={refreshVersion} focus={focus.harness===harness?focus:undefined} selected={selected?.scope}
        busy={busy} onClose={()=>toggleSource(harness)} onSelect={select} onConfirm={confirm}/>:null}
    </BlueprintGraph>
    {currentConflict?<ConflictPanel conflict={currentConflict} busy={busy} onClose={()=>setConflict(undefined)} onResolve={choice=>void action(async()=>{
      setGraph(await api!.blueprintResolve(currentConflict.id,choice));
      setConflict(undefined);
      setNotice(t("已保存分支选择"));
      setRefreshVersion(previous=>previous+1);
    })}/>:selected&&<section className="bp-selection" aria-label={t("连接详情")}>
      <div className="bp-selection-head">{selected.scope.wholeHarness?<HarnessIcon h={selected.scope.source.harness}/>:selected.scope.sessionId?<MessageSquare size={15}/>:<Folder size={16}/>}<strong title={selected.title}>{selected.title}</strong>
        <span>{t("接收方")}</span><button className="icon-button" title={t("关闭连接详情")} onClick={()=>setSelected(undefined)}><X size={14}/></button></div>
      <div className="bp-target-options">{targets.map(target=>{
        const ruleAt=(scope:BlueprintScope)=>allRules.find(r=>r.target===target&&scopeKey(r.scope)===scopeKey(scope));
        const direct=ruleAt(selected.scope);
        const inherited=blueprintParents(selected.scope).map(ruleAt).find(r=>r!==undefined);
        const enabled=direct?.enabled??inherited?.enabled;
        return <div className="bp-target-rule" key={target} data-enabled={enabled}>
          <button disabled={busy||!graph} aria-label={t("{0} · {1}",targetName(target),enabled?t("断开连接"):t("添加连接"))} title={enabled?t("断开连接"):t("添加连接")} onClick={()=>rule(selected.scope,target,enabled?(inherited?.enabled?false:null):true)}>
            {enabled?<Check size={13}/>:target==='workbench'?<House size={13}/>:<HarnessIcon h={target}/>}<span>{targetName(target)}</span>
            {enabled&&<small>{direct?t("单独连接"):inherited?.scope.wholeHarness?t("继承 Harness"):t("继承项目")}</small>}{direct?.enabled===false&&<small>{t("已排除")}</small>}
          </button>{direct&&!selected.scope.wholeHarness&&<button disabled={busy} title={t("恢复上级规则")} aria-label={t("{0} · 恢复上级规则",targetName(target))} onClick={()=>rule(selected.scope,target,null)}><Link2Off size={12}/></button>}</div>;
      })}</div>
    </section>}
    <footer className="bp-status" role="status">{error?<span className="bp-error" role="alert">{t(error)}</span>:notice?<><Check size={13}/>{notice}</>:<><ArrowRight size={13}/>{t("拖动发送方端口可连接整个 Harness，也可连接单个项目或对话。")}</>}</footer>
  </main>;
}

function ConflictPanel({conflict,busy,onClose,onResolve}:{conflict:BlueprintConflict;busy:boolean;onClose():void;onResolve(choice:'local'|'remote'|'both'):void}){
  const {t}=useI18n();
  return <section className="bp-conflict-panel" aria-label={t("处理同步冲突")}>
    <header><GitBranch size={16}/><strong>{conflict.title}</strong><button className="icon-button" title={t("关闭")} onClick={onClose}><X size={15}/></button></header>
    <div className="bp-diffs">{([['local',t("EntroTect 工作台"),conflict.local],['remote',harnessNames[conflict.source.harness],conflict.remote]] as const).map(([choice,label,lines])=>
      <div key={choice}><h3>{label}</h3><pre>{lines.join('\n')||t("没有新增内容")}</pre><button className="secondary-button" disabled={busy} onClick={()=>onResolve(choice)}>{t("仅保留 {0} 分支",label)}</button></div>)}</div>
    <button className="primary-button" disabled={busy} onClick={()=>onResolve('both')}><GitBranch size={14}/>{t("保留两个分支")}</button>
  </section>;
}
