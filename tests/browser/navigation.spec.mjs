import {test,expect} from '@playwright/test';

// Only the broker is simulated. The real app, link, framing and MIDI parser run
// in the browser; no request reaches a public broker or a physical instrument.
const broker=`
import {frame} from '/assets/timeline.mjs';
window.instrument={connections:0,closes:0,requests:[],holdUpload:false,release:null,stallRead:false};
export default {async connectAsync(){
 const state=window.instrument;state.connections++;
 const listeners={};let noteCount=42,stored=false;
 const client={
  on(name,handler){(listeners[name]??=[]).push(handler);},
  async subscribeAsync(){},
  async endAsync(){state.closes++;for(const handler of listeners.close||[])handler();},
  async publishAsync(topic,bytes){
   state.requests.push([...bytes]);
   if(bytes[2]===7&&state.stallRead)await new Promise(()=>{});
   if(bytes[2]===1&&state.holdUpload)await new Promise(resolve=>state.release=resolve);
   if(bytes[2]===1)noteCount=bytes[7]+256*bytes[8];
   if(bytes[2]===3)stored=true;
   const actual=bytes[2]===5?0x8dff:bytes[2]===4?bytes[7]+256*bytes[8]:0;
   const ack=frame(128,bytes[3],Uint8Array.of(bytes[2],0,1,stored?1:0,noteCount&255,noteCount>>8,actual&255,actual>>8));
   for(const handler of listeners.message||[])handler('tof/flowmeter/data',ack,{retain:false});
  }
 };
 return client;
}};
`;
const midi=Buffer.from([
 ...Buffer.from('MThd'),0,0,0,6,0,0,0,1,1,224,
 ...Buffer.from('MTrk'),0,0,0,13,0,144,60,80,131,96,128,60,0,0,255,47,0,
]);
test.beforeEach(async({page})=>{
 await page.route('**/vendor/mqtt.esm.js',route=>route.fulfill({contentType:'text/javascript',body:broker}));
});
async function connect(page,path='/index.html'){
 await page.goto(path);
 await page.locator('#connect').click();
 await expect(page.locator('#connection')).toContainText('已连接');
}
test('navigation cannot load another document before the app is ready',async({page})=>{
 let release;
 const blocked=new Promise(resolve=>release=resolve);
 await page.route('**/app.mjs',async route=>{await blocked;await route.continue();});
 try{
  await page.goto('/index.html',{waitUntil:'commit'});
  const tab=page.locator('#nav-parameters');
  await expect(tab).toHaveAttribute('type','button');
  await expect(tab).toBeDisabled();
 }finally{release();}
 await expect(page.locator('#nav-parameters')).toBeEnabled();
});
test('repeated page switching retains one connection and sends no idle bend writes',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await connect(page);
 await page.evaluate(()=>window.sessionMarker={});
 for(let i=0;i<4;i++){
  for(const [tab,title]of [['parameters','演奏参数'],['logs','信号日志'],['upload','曲目上传']]){
   await page.locator('#nav-'+tab).click();
   await expect(page.locator('#page-title')).toHaveText(title);
   await expect(page.locator('#connect')).toBeEnabled();
  }
 }
 const state=await page.evaluate(()=>({connections:instrument.connections,closes:instrument.closes,
  writes:instrument.requests.filter(p=>p[2]===4).length,retained:!!window.sessionMarker}));
 expect(state).toEqual({connections:1,closes:0,writes:0,retained:true});
 expect(errors).toEqual([]);
 await page.locator('#connection-settings > summary').click();
 await page.locator('#disconnect').click();
 expect(await page.evaluate(()=>instrument.closes)).toBe(1);
});
test('navigation and browser history preserve a selected MIDI and an active upload',async({page})=>{
 await connect(page);
 await page.locator('#file').setInputFiles({name:'practice.mid',mimeType:'audio/midi',buffer:midi});
 await page.locator('#tracks input').check();
 await page.evaluate(()=>instrument.holdUpload=true);
 await page.locator('#upload').click();
 await expect.poll(()=>page.evaluate(()=>!!instrument.release)).toBe(true);
 await page.locator('#nav-parameters').click();
 await page.locator('#nav-logs').click();
 await page.goBack();
 await expect(page.locator('#parameters-page')).toBeVisible();
 await page.goBack();
 await expect(page.locator('#upload-page')).toBeVisible();
 await expect(page.locator('#tracks input')).toBeChecked();
 await page.evaluate(()=>instrument.release());
 await expect(page.locator('#result')).toContainText('曲目已由乐器校验并提交');
 await expect(page.locator('#progress')).toHaveAttribute('value','100');
 expect(await page.evaluate(()=>[instrument.connections,instrument.closes])).toEqual([1,0]);
});
test('all direct entry pages share navigation without reconnecting',async({page})=>{
 for(const path of ['/parameters.html','/logs.html']){
  await connect(page,path);
  await page.locator('#nav-upload').click();
  await expect(page.locator('#upload-page')).toBeVisible();
  await page.goBack();
  await page.goForward();
  expect(await page.evaluate(()=>[instrument.connections,instrument.closes])).toEqual([1,0]);
  await page.locator('#connection-settings > summary').click();
  await page.locator('#disconnect').click();
 }
});
test('leaving a page with active bend still returns pitch to zero',async({page})=>{
 await connect(page);
 await page.locator('#nav-parameters').click();
 await expect(page.locator('#bend-range')).toBeEnabled();
 await page.locator('#bend-range').evaluate(input=>{input.value='256';input.dispatchEvent(new Event('input'));});
 await expect.poll(()=>page.evaluate(()=>instrument.requests.some(p=>p[2]===4&&p[6]===11&&p[7]===0&&p[8]===1))).toBe(true);
 await page.goBack();
 await expect.poll(()=>page.evaluate(()=>instrument.requests.filter(p=>p[2]===4).at(-1)?.slice(6,9))).toEqual([11,0,0]);
 expect(await page.evaluate(()=>[instrument.connections,instrument.closes])).toEqual([1,0]);
});
test('switching to controls does not block writes on an automatic readback',async({page})=>{
 await connect(page);
 await page.evaluate(()=>instrument.stallRead=true);
 await page.locator('#nav-parameters').click();
 await expect(page.locator('#volume')).toBeEnabled();
 await page.locator('#patch').selectOption('1');
 await expect(page.locator('#parameter-result')).toHaveText('乐器已确认设置。');
 expect(await page.evaluate(()=>instrument.requests.filter(p=>p[2]===7).length)).toBe(0);
 expect(await page.evaluate(()=>[instrument.connections,instrument.closes])).toEqual([1,0]);
});
test('manual readback works and a stalled read releases controls after timeout',async({page})=>{
 await connect(page);
 await page.locator('#nav-parameters').click();
 await page.locator('#read-settings').click();
 await expect(page.locator('#parameter-result')).toHaveText('已读取乐器当前设置。');
 await expect(page.locator('#volume')).toHaveValue('0');
 await page.clock.install();
 await page.evaluate(()=>instrument.stallRead=true);
 await page.locator('#read-settings').click();
 await expect(page.locator('#parameter-result')).toHaveText('正在读取乐器设置…');
 await page.clock.runFor(31000);
 await expect(page.locator('#parameter-result')).toContainText('应答超时');
 await expect(page.locator('#volume')).toBeEnabled();
 await page.evaluate(()=>instrument.stallRead=false);
 await page.locator('#patch').selectOption('1');
 await expect(page.locator('#parameter-result')).toHaveText('乐器已确认设置。');
 expect(await page.evaluate(()=>[instrument.connections,instrument.closes])).toEqual([1,0]);
});
