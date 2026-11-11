import {test,expect} from '@playwright/test';
import path from 'node:path';
import {launchTauri} from './tauri-launch';

test('native maximize state, sidebar directions and official brand assets',async()=>{
 const desktop=await launchTauri({...process.env,ENTROTECT_DATA_DIR:path.resolve('.local',`controls-e2e-${Date.now()}`)});
 try{
  const page=await desktop.firstWindow();
  await page.emulateMedia({reducedMotion:'no-preference'});
  await expect(page.getByRole('heading',{name:'想法，从这里展开。'})).toBeVisible();
  await expect(page.getByText('原生执行环境已就绪',{exact:true})).toHaveCount(0);
  const original=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  const maximize=page.getByRole('button',{name:'最大化',exact:true});
  await expect(maximize.locator('.lucide-square')).toBeVisible();await expect(maximize.locator('.lucide-copy')).toHaveCount(0);
  await maximize.click();
  const restore=page.getByRole('button',{name:'还原窗口',exact:true});
  await expect(restore).toHaveAttribute('aria-pressed','true');await expect(restore.locator('.lucide-copy')).toBeVisible();
  await expect.poll(()=>page.evaluate(size=>innerWidth>size.width||innerHeight>size.height,original)).toBe(true);
  await page.screenshot({path:'.local/screenshots/window-maximized.png'});
  await restore.click();await expect(maximize).toHaveAttribute('aria-pressed','false');await expect(maximize.locator('.lucide-square')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(original.width);
  const collapseLeft=page.getByRole('button',{name:'收起侧边栏',exact:true});
  const leftPane=page.locator('.workspace-pane').first(),rightPane=page.locator('.project-pane');
  const width=(pane:typeof leftPane)=>pane.evaluate(node=>node.getBoundingClientRect().width);
  const workspace=page.locator('.workspace-layout');
  await expect(workspace).toHaveCSS('transition-property','--left-open, --right-open');
  await expect(collapseLeft.locator('.lucide-panel-left-close')).toBeVisible();await collapseLeft.click();
  await expect.poll(()=>width(leftPane)).toBe(0);
  const expandLeft=page.getByRole('button',{name:'展开侧边栏',exact:true});
  await expect(expandLeft.locator('.lucide-panel-left-open')).toBeVisible();await expandLeft.click();
  await expect(collapseLeft).toBeVisible();
  await expect.poll(()=>width(leftPane)).toBeGreaterThan(200);
  await expect(page.getByRole('complementary',{name:'项目侧栏'})).toBeHidden();
  const expandRight=page.getByRole('button',{name:'展开项目侧栏',exact:true});
  await expect(expandRight.locator('.lucide-panel-right-open')).toBeVisible();await expandRight.click();
  await expect(page.getByRole('complementary',{name:'项目侧栏'})).toBeVisible();
  await expect.poll(()=>width(rightPane)).toBeGreaterThan(250);
  const leftHandle=page.getByRole('separator',{name:'调整左侧栏宽度'});
  const rightHandle=page.getByRole('separator',{name:'调整右侧栏宽度'});
  const leftStart=Number(await leftHandle.getAttribute('aria-valuenow'));
  const rightStart=Number(await rightHandle.getAttribute('aria-valuenow'));
  const guide=workspace.locator('.pane-resize-guide');
  await expect.poll(()=>width(rightPane)).toBe(rightStart);
  for(const [handle,pane,distance] of [[leftHandle,leftPane,-24],[rightHandle,rightPane,24]] as const){
   const initial=await width(pane);
   const box=(await handle.boundingBox())!;
   const x=box.x+box.width/2,y=box.y+100;
   await handle.evaluate(element=>element.addEventListener('pointerdown',event=>{
    element.dataset.testPointerId=String(event.pointerId);
   },{once:true}));
   await page.mouse.move(x,y);
   await page.mouse.down();
   await expect(guide).toBeVisible();
   const guideStart=(await guide.boundingBox())!.x;
   // Exercise the same drag when WebView2 delivers moves to the content under the pointer.
   await handle.evaluate(element=>{
    const id=Number(element.dataset.testPointerId);
    if(element.hasPointerCapture(id))element.releasePointerCapture(id);
    delete element.dataset.testPointerId;
   });
   await page.mouse.move(x-distance,y,{steps:5});
   await expect.poll(async()=>(await guide.boundingBox())?.x).toBe(guideStart-distance);
   await page.mouse.move(x+distance,y,{steps:5});
   await expect.poll(async()=>(await guide.boundingBox())?.x).toBe(guideStart+distance);
   expect(await width(pane)).toBe(initial);
   await page.mouse.up();
   await expect(guide).toBeHidden();
  }
  await expect.poll(()=>width(leftPane)).toBe(leftStart-24);
  await expect.poll(()=>width(rightPane)).toBe(rightStart-24);
  await leftHandle.press('ArrowRight');
  await expect.poll(()=>width(leftPane)).toBe(leftStart-12);
  await page.reload();
  await expect.poll(()=>width(leftPane)).toBe(leftStart-12);
  await expect(rightHandle).toBeHidden();
  await expandRight.click();
  await expect.poll(()=>width(rightPane)).toBe(rightStart-24);
  await rightHandle.dblclick();
  await expect.poll(()=>width(rightPane)).toBe(rightStart);
  const collapseRight=page.getByRole('button',{name:'收起项目侧栏',exact:true});
  await expect(collapseRight.locator('.lucide-panel-right-close')).toBeVisible();await collapseRight.click();
  await expect(page.getByRole('complementary',{name:'项目侧栏'})).toBeHidden();
  await expect.poll(()=>width(rightPane)).toBe(0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(workspace).toHaveCSS('transition-duration','0s, 0s');
  async function loaded(brand:string){
   const image=page.locator(`img[data-brand="${brand}"]`).first();
   await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await loaded('deepseek');await loaded('deepseek-harness');
  await page.screenshot({path:'.local/screenshots/official-deepseek.png'});
  await page.getByRole('combobox',{name:'选择模型',exact:true}).selectOption('glm-5.3');
  await loaded('glm');await loaded('zcode');
  await page.screenshot({path:'.local/screenshots/official-glm-zcode.png'});
  await page.getByRole('button',{name:/设置与连接/}).click();
  const settings=page.getByRole('dialog',{name:'设置与连接'});
  await expect(settings.locator('img[data-brand="deepseek-harness"]')).toBeVisible();await expect(settings.locator('img[data-brand="zcode"]')).toBeVisible();
 }finally{await desktop.close();}
});
