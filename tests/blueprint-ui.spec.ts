import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import type { BlueprintRule, BlueprintScope, BlueprintTarget, DesktopApi, Harness } from '../shared/types';

test('blueprint supports lazy browsing, connections, source review, conflicts, and returning to a draft', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(),'entrotect-blueprint-'));
  const config = { build:{outDir}, logLevel:'error' as const };
  let vite: Awaited<ReturnType<typeof preview>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await build(config);
    vite = await preview({...config, preview:{host:'127.0.0.1',port:0}});
    browser = await chromium.launch(process.platform==='win32'?{channel:'msedge'}:{});
    for (const language of ['en','zh-CN'] as const) {
      const page = await browser.newPage({ viewport:{width:1100,height:720} });
      const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(({language})=>{
        const scans:Harness[]=[]; const rules:BlueprintRule[]=[];const pending=['Legacy one','Legacy two'];
        const resolutions:string[]=[];
        const workspace='D:/demo',source={harness:'codex' as const,location:'D:/profiles/codex'};
        const sources=Object.fromEntries(['deepseek','zcode','kimi','opencode','codex'].map(h=>[h,{harness:h,location:'D:/profiles/'+h}]));
        const oldSource={...source,location:'D:/older-codex'};
        const scope=(id:string):BlueprintScope=>({source,workspace,sessionId:id});
        const equal=(a:BlueprintScope,b:BlueprintScope)=>a.source.location===b.source.location&&a.workspace===b.workspace&&a.sessionId===b.sessionId&&a.wholeHarness===b.wholeHarness;
        const state=()=>({onboarded:true,rules:structuredClone(rules),conflicts:resolutions.length?[]:[{
          id:'branch-1',appId:'app-1',source,title:'Two branch edits',local:['Workbench edit'],remote:['Native edit'],
        }]});
        const api={
          bootstrap:async()=>({conversations:[],projects:[],settings:{defaultWorkspace:workspace,theme:language==='en'?'dark':'light',language,deepseek:{model:'deepseek-flash'},zcode:{model:'glm-5.3'}},health:[],reasoning:[],historySync:{issues:[]},blueprintOnboarded:false}),
          blueprintDismiss:async()=>{},onEvent:()=>()=>{},rememberRuntime:async()=>{},
          accountUsage:async()=>({authMode:'native',plan:{status:'not-connected'},balance:{status:'not-connected'}}),
          blueprint:async()=>state(),historyDefaults:async()=>sources,blueprintCatalog:async(h:Harness)=>{
            scans.push(h);
            if (h!=='codex')return {source:sources[h],projects:[],pending:[],warnings:[]};
            return { source,projects:[
              {workspace,chats:Array.from({length:85},(_,i)=>({scope:scope('c'+i),title:'Native chat '+i,updatedAt:i}))},
              {workspace,source:oldSource,chats:[{scope:{...scope('old'),source:oldSource},title:'Old profile chat',updatedAt:0}]},
            ],
              pending:pending.map(id=>({scope:scope(id),title:id,updatedAt:0})),warnings:[]};
          },
          blueprintRule:async(input:BlueprintScope,target:BlueprintTarget,enabled:boolean|null)=>{
            const idx=rules.findIndex(r=>equal(r.scope,input)&&r.target===target);if(idx>=0)rules.splice(idx,1);
            if(enabled!==null)rules.push({scope:input,target,enabled});return state();
          },
          blueprintConfirm:async(items:BlueprintScope[])=>{for(const item of items)pending.splice(pending.indexOf(item.sessionId!),1);},
          blueprintResolve:async(id:string,choice:string)=>{resolutions.push(id+':'+choice);return state();},
        };
        Object.assign(window,{entrotect:api as unknown as DesktopApi,blueprintTest:{scans,rules,resolutions}});
      },{language});
      await page.goto(vite.resolvedUrls!.local[0]);
      const en=language==='en';
      const input=page.getByRole('textbox',{name:en?'Task input':'任务输入'});
      await input.fill('preserved draft');
      await page.getByRole('button',{name:en?'Choose chats to import':'前往导入历史对话'}).click();
      const graph=page.getByRole('main',{name:en?'Sync blueprint':'同步蓝图'});
      await expect(graph).toBeVisible();
      const data=()=>page.evaluate(()=>(window as unknown as {blueprintTest:{scans:string[];rules:BlueprintRule[];resolutions:string[]}}).blueprintTest);
      expect((await data()).scans).toEqual([]);
      const sender=graph.locator('[data-sender="codex"]');
      const codexCard=graph.locator('#bp-source-codex');
      const deepseek=graph.locator('[data-sender="deepseek"]');
      const deepseekCard=graph.locator('#bp-source-deepseek');
      await sender.click();
      await expect(codexCard).toContainText('demo');
      expect((await data()).scans).toEqual(['codex']);
      const projects=codexCard.locator('.bp-project');
      await expect(projects).toHaveCount(2);
      await expect(projects.last()).toContainText('D:/older-codex');
      await projects.last().locator('.bp-item').first().click();
      await expect(projects.last().locator('.bp-chat')).toContainText('Old profile chat');
      expect(await projects.last().locator('.bp-port').first().getAttribute('data-scope-port')).toContain('older-codex');
      await projects.last().locator('.bp-item').first().click();
      await projects.first().locator('.bp-item').first().click();
      await expect(codexCard.locator('.bp-chat')).toHaveCount(35);
      const port=projects.first().locator('.bp-port').first(), receiver=graph.locator('[data-receiver="kimi"]');
      const a=await port.boundingBox(),b=await receiver.boundingBox();
      await page.mouse.move(a!.x+a!.width/2,a!.y+a!.height/2);await page.mouse.down();
      await page.mouse.move(b!.x+b!.width/2,b!.y+b!.height/2,{steps:7});await page.mouse.up();
      await expect.poll(async()=>(await data()).rules.filter(r=>r.target==='kimi'&&r.enabled)).toHaveLength(1);
      await expect(receiver).toHaveAttribute('data-linked','');
      await expect(port).toHaveAttribute('data-linked','');
      const drag=async (start:{x:number;y:number},x:number,y:number)=>{
        await page.mouse.move(start.x,start.y);await page.mouse.down();
        await page.mouse.move(start.x+x,start.y+y,{steps:6});await page.mouse.up();
      };
      const anchor=async(node:typeof sender,card:typeof codexCard)=>{
        const button=(await node.boundingBox())!, panel=(await card.boundingBox())!;
        return {gap:Math.round(panel.x-button.x-button.width),top:Math.round(panel.y-button.y)};
      };
      const senderStart=(await sender.boundingBox())!, receiverStart=(await receiver.boundingBox())!;
      const treeStart=(await codexCard.boundingBox())!;
      const relativeStart=await anchor(sender,codexCard);
      expect(relativeStart.gap).toBeGreaterThan(0);
      expect(relativeStart.top).toBe(0);
      const wire=graph.locator('.bp-wire.chosen');
      const originalPath=await wire.getAttribute('d');
      await drag({x:receiverStart.x+30,y:receiverStart.y+16},-44,14);
      await expect.poll(async()=>Math.round((await receiver.boundingBox())!.x-receiverStart.x)).toBe(-44);
      await expect(wire).not.toHaveAttribute('d',originalPath!);
      expect((await data()).rules).toHaveLength(1);
      await drag({x:senderStart.x+38,y:senderStart.y+17},22,-13);
      await expect.poll(async()=>Math.round((await sender.boundingBox())!.x-senderStart.x)).toBe(22);
      const movedTree=(await codexCard.boundingBox())!;
      expect([Math.round(movedTree.x-treeStart.x),Math.round(movedTree.y-treeStart.y)]).toEqual([22,-13]);
      expect(await anchor(sender,codexCard)).toEqual(relativeStart);
      expect((await data()).scans).toEqual(['codex']);
      await deepseek.click();
      await expect(deepseekCard.locator('.bp-location')).toHaveText('D:/profiles/deepseek');
      await expect(codexCard).toBeVisible();
      expect(await anchor(deepseek,deepseekCard)).toEqual(relativeStart);
      expect(await anchor(sender,codexCard)).toEqual(relativeStart);
      const codexSearch=codexCard.locator('.bp-search input'), deepseekSearch=deepseekCard.locator('.bp-search input');
      await codexSearch.fill('Native chat 84');
      await expect(codexCard.locator('.bp-chat')).toHaveCount(1);
      await deepseekSearch.fill('other search');
      await expect(codexSearch).toHaveValue('Native chat 84');
      await deepseekCard.getByTitle(en?'Collapse DeepSeek Harness sources':'收起 DeepSeek Harness 来源').click();
      await expect(deepseekCard).toBeHidden();
      await expect(codexCard).toBeVisible();
      await deepseek.click();
      await expect(deepseekSearch).toHaveValue('other search');
      expect((await data()).scans).toEqual(['codex','deepseek']);
      await deepseek.click();
      await codexSearch.fill('');
      const canvas=(await graph.locator('.bp-canvas').boundingBox())!;
      await drag({x:canvas.x+8,y:canvas.y+canvas.height-60},35,20);
      await expect.poll(async()=>Math.round((await sender.boundingBox())!.x-senderStart.x)).toBe(57);
      await expect.poll(async()=>Math.round((await receiver.boundingBox())!.x-receiverStart.x)).toBe(-9);
      await graph.locator('.bp-zoom button').nth(1).click();
      await expect.poll(async()=>Math.round((await sender.boundingBox())!.width/senderStart.width*100)).toBe(112);
      await expect.poll(async()=>Math.round((await receiver.boundingBox())!.width/receiverStart.width*100)).toBe(112);
      expect((await anchor(sender,codexCard)).top).toBe(0);
      await graph.getByTitle(en?'Back to workspace':'返回工作区').click();
      await page.getByTitle(en?'Import chat history':'导入历史对话').click();
      await expect.poll(async()=>Math.round((await receiver.boundingBox())!.x-receiverStart.x)).toBe(-44);
      await graph.locator('.bp-zoom button').last().click();
      await expect.poll(async()=>Math.round((await receiver.boundingBox())!.x-receiverStart.x)).toBe(0);
      await sender.click();
      await projects.first().locator('.bp-item').first().click();
      const list=codexCard.locator('.bp-tree-list');
      for(const count of [70,85]){
        await list.evaluate(element=>element.scrollTop=element.scrollHeight);
        await codexCard.locator('.bp-more').click();
        await expect(codexCard.locator('.bp-chat')).toHaveCount(count);
      }
      await list.evaluate(element=>element.scrollTop=0);
      const chat=codexCard.locator('.bp-chat').first();await chat.locator('.bp-port').focus();await page.keyboard.press('Enter');
      await expect(graph.locator('.bp-target-rule').filter({hasText:'Kimi'})).toContainText(en?'Inherited':'继承项目');
      await graph.locator('[data-receiver="workbench"]').focus();await page.keyboard.press('Enter');
      await expect.poll(async()=>(await data()).rules.some(r=>r.scope.sessionId==='c0'&&r.target==='workbench')).toBe(true);
      await graph.locator('.bp-target-rule').filter({hasText:'Kimi'}).getByRole('button').first().click();
      await expect(graph.locator('.bp-target-rule').filter({hasText:'Kimi'})).toContainText(en?'Excluded':'已排除');
      await codexSearch.fill('Native chat 84');await expect(codexCard.locator('.bp-chat')).toHaveCount(1);
      await codexSearch.fill('');
      await codexCard.locator('.bp-tabs button').last().click();await codexCard.getByRole('button',{name:en?'Confirm all 2 as native':'将全部 2 条确认为原生'}).click();
      await expect(list).toContainText(en?'No origins to review':'没有待确认的记录');
      const whole=graph.locator('.bp-sender-node:has([data-sender="codex"]) [data-whole-harness]');
      const wholeStart=(await whole.boundingBox())!, zcode=(await graph.locator('[data-receiver="zcode"]').boundingBox())!;
      const start={x:wholeStart.x+wholeStart.width/2,y:wholeStart.y+wholeStart.height/2};
      await drag(start,zcode.x+zcode.width/2-start.x,zcode.y+zcode.height/2-start.y);
      await expect.poll(async()=>(await data()).rules.some(r=>r.scope.wholeHarness&&r.target==='zcode')).toBe(true);
      await expect(whole).toHaveAttribute('data-linked','');
      await codexCard.locator('.bp-tabs button').first().click();await graph.locator('.bp-zoom button').nth(1).click();
      await expect(graph.locator('.bp-zoom')).toContainText('112%');await graph.locator('.bp-zoom button').last().click();
      await graph.getByRole('button',{name:'Two branch edits'}).click();
      const conflict=graph.getByRole('region',{name:en?'Resolve sync conflict':'处理同步冲突'});
      await expect(conflict).toContainText('Workbench edit');
      await expect(conflict).toContainText('Native edit');
      await conflict.getByRole('button',{name:en?'Keep both branches':'保留两个分支'}).click();
      await expect.poll(async()=>(await data()).resolutions).toEqual(['branch-1:both']);
      await expect(conflict).toBeHidden();
      await deepseek.click();
      await graph.screenshot({path:`.local/screenshots/blueprint-${language}.png`});
      await graph.getByTitle(en?'Back to workspace':'返回工作区').click();await expect(input).toHaveValue('preserved draft');
      expect(errors).toEqual([]);await page.close();
    }
  } finally {
    await browser?.close();
    vite?.httpServer.close();
    await rm(outDir,{recursive:true,force:true});
  }
});
