import { useI18n } from './i18n';
import {useEffect,useState} from 'react';
import {Copy,Minus,Square,X} from 'lucide-react';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {isTauri} from '@tauri-apps/api/core';
import {closeWindow,message} from './api';

export function WindowControls({onError}:{onError(error:string):void}){
 const { t } = useI18n();
 const [maximized,setMaximized]=useState(false);
 useEffect(()=>{
  if(!isTauri())return;
  const win=getCurrentWindow();let active=true;
  const update=()=>win.isMaximized().then(value=>{if(active)setMaximized(value);}).catch(error=>{if(active)onError(message(error));});
  void update();const resized=win.onResized(()=>void update());
  return()=>{active=false;void resized.then(off=>off());};
 },[onError]);
 async function toggle(){
  if(!isTauri())return;
  try{const win=getCurrentWindow();await win.toggleMaximize();setMaximized(await win.isMaximized());}catch(error){onError(message(error));}
 }
 return <div className="window-controls">
  <button title={t("最小化")} onClick={()=>{if(isTauri())void getCurrentWindow().minimize().catch(error=>onError(message(error)));}}><Minus size={15}/></button>
  <button title={maximized?t("还原窗口"):t("最大化")} aria-pressed={maximized} onClick={()=>void toggle()}>{maximized?<Copy size={13}/>:<Square size={13}/>}</button>
  <button title={t("关闭窗口")} onClick={()=>void closeWindow().catch(error=>onError(message(error)))}><X size={16}/></button>
 </div>;
}
