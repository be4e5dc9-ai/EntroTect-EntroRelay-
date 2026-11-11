import deepseek from './assets/brands/deepseek.ico';
import deepseekHarness from './assets/brands/deepseek-harness.svg';
import glm from './assets/brands/zai.svg';
import zcode from './assets/brands/zcode.png';
import kimi from './assets/brands/kimi.png';
import opencode from './assets/brands/opencode.svg';
import codex from './assets/brands/codex.png';
import type {Harness} from '../shared/types';

const harnessMarks: Record<Harness, string> = { deepseek: deepseekHarness, zcode, kimi, opencode, codex };

export function ModelIcon({family}:{family:Harness}){
 if(family!=='deepseek'&&family!=='zcode')return <HarnessIcon h={family}/>;
 const brand=family==='deepseek'?'deepseek':'glm';
 return <span className="engine-icon official-brand model-brand" aria-hidden="true"><img data-brand={brand} src={family==='deepseek'?deepseek:glm} alt="" draggable={false}/></span>;
}
export function HarnessIcon({h}:{h:Harness}){
 return <span className="engine-icon official-brand harness-brand" aria-hidden="true"><img data-brand={h==='deepseek'?'deepseek-harness':h} src={harnessMarks[h]} alt="" draggable={false}/></span>;
}
