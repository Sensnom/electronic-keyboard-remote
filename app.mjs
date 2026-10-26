import mqtt from './vendor/mqtt.esm.js';
import {connectInstrument} from './mqtt-link.mjs';
import {parseMidi} from './assets/midi.mjs';
import {compileTimeline} from './assets/timeline.mjs';
const $=id=>document.getElementById(id);
let raw=null,device=null,link=null,busy=false,fileGeneration=0,connectionGeneration=0;
const parameters=[['volume',1,'percent'],['patch',2],['effect',3],['wet',4,'percent'],['chord-enabled',5],['chord-type',6],['transpose',7,'signed'],['octave',8,'signed'],['glide',9]];
const configIds=['broker','up-topic','down-topic','username','password','qos'];
function compile(){
 if(!raw||!device)return null;
 return compileTimeline(raw,{tracks:[...document.querySelectorAll('#tracks input:checked')].map(x=>Number(x.value)),modules:device.modules,speed:Number($('speed').value)});
}
function update(){
 const ready=!!device&&!!link?.connected;
 for(const id of configIds)$(id).disabled=busy;
 $('connect').disabled=busy;$('disconnect').disabled=busy||!link;
 for(const id of ['file','speed'])$(id).disabled=busy;
 for(const input of document.querySelectorAll('#tracks input'))input.disabled=busy;
 for(const [id,number] of parameters)$(id).disabled=busy||!ready||!(device.parameterMask&(1<<(number-1)));
 for(const group of document.querySelectorAll('[data-params]'))group.hidden=ready&&group.dataset.params.split(',').every(id=>!(device.parameterMask&(1<<(Number(id)-1))));
 $('read-settings').hidden=ready&&!device.readback;$('read-settings').disabled=busy||!ready||!device.readback;
 $('builtin').disabled=busy||!ready||device.learning;
 $('upload').disabled=true;
 if(!raw)return;
 if(!ready){$('summary').textContent='已读取文件。请连接乐器，按实际12/24键编译曲目。';return;}
 try{
  const song=compile();$('summary').textContent=`${song.notes.length}个音符 · ${(song.endMs/1000).toFixed(2)}秒 · ${device.modules*12}键自动换八度，保留原曲音高。`;
  $('upload').disabled=busy||device.learning;
 }catch(error){$('summary').textContent=error.message;}
}
function displayDevice(value){
 if(![1,2].includes(value.modules))throw Error('乐器尚未识别到有效键盘，请检查琴键模块');
 device=value;$('connection').textContent=`已连接 · ${value.modules}块板 / ${value.modules*12}键 · ${value.learning?'学习中':value.stored?'已存上传曲目':'内置曲目'}`;
}
async function refresh(){if(link?.connected)displayDevice(await link.status());}
$('connect').onclick=async()=>{
 const generation=++connectionGeneration;busy=true;device=null;update();$('connection').textContent='正在连接乐器…';
 try{
  if(link)await link.close();link=null;
  link=await connectInstrument({url:$('broker').value.trim(),upTopic:$('up-topic').value.trim(),downTopic:$('down-topic').value.trim(),
   username:$('username').value,password:$('password').value,qos:Number($('qos').value),
   onDisconnect:()=>{if(generation===connectionGeneration){device=null;$('connection').textContent='连接已断开，请重新连接乐器。';update();}}},(url,options)=>mqtt.connectAsync(url,options));
  // Move past a possible cached STATUS from a previous phone session.
  await link.status();displayDevice(await link.status());
  $('connection-settings').open=false;
  if(location.pathname.endsWith('/parameters.html')&&device.readback)applySettings(await link.readParameters());
 }catch(error){
  device=null;$('connection').textContent=error.message+'；尚未连接乐器。';
  if(link){++connectionGeneration;await link.close();link=null;}
 }finally{busy=false;update();}
};
$('disconnect').onclick=async()=>{
 ++connectionGeneration;const old=link;link=null;device=null;busy=true;update();
 try{await old?.close();}finally{busy=false;$('connection').textContent='已断开连接。';update();}
};
$('file').onchange=async()=>{
 const current=++fileGeneration;raw=null;$('tracks').replaceChildren();$('result').textContent='';$('progress').value=0;update();
 const file=$('file').files[0];if(!file){$('file-info').textContent='请选择MIDI文件。';return;}
 try{
  if(file.size>1048576)throw Error('文件超过1MiB导入上限');
  const bytes=new Uint8Array(await file.arrayBuffer());if(current!==fileGeneration)return;
  const midi=parseMidi(bytes);raw=bytes;$('file-info').textContent=`${file.name} · ${bytes.length}字节 · 原文件保留在手机`;
  const legend=document.createElement('legend');legend.textContent='选择练习轨道';$('tracks').append(legend);
  midi.tracks.forEach((track,index)=>{
   if(!track.notes.length)return;
   const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=String(index);input.onchange=update;
   label.append(input,document.createTextNode(`轨道${index+1} ${track.name}（${track.notes.length}音）`));$('tracks').append(label);
  });update();
 }catch(error){$('file-info').textContent=error.message;}
};
$('speed').oninput=()=>{$('speed-value').textContent=$('speed').value+'%';update();};
$('upload').onclick=async()=>{
 if(busy||!link||!device)return;
 let song;try{song=compile();}catch(error){$('result').textContent=error.message;return;}if(!song)return;
 busy=true;update();$('progress').value=0;$('result').textContent='正在上传，等待乐器确认…';
 const progress=setInterval(()=>{if(link?.progress)$('progress').value=100*link.progress.sent/link.progress.total;},300);
 try{
  const ack=await link.upload(song);if(!ack.stored||ack.noteCount!==song.notes.length)throw Error('乐器未确认完整曲目提交');
  $('progress').value=100;$('result').textContent='曲目已由乐器校验并提交。短按琴上按钮9开始，漏弹会计错并继续。';
 }catch(error){$('result').textContent=error.message+'；未确认新曲目成功。';}
 finally{clearInterval(progress);try{await refresh();}catch(error){device=null;$('connection').textContent=error.message;}busy=false;update();}
};
$('builtin').onclick=async()=>{
 if(busy||!link)return;busy=true;update();
 try{await link.builtin();$('result').textContent='已切换到内置《小星星》。';await refresh();}
 catch(error){$('result').textContent=error.message;}finally{busy=false;update();}
};
function applyValue(id,number,kind,value){
 $(id).value=String(kind==='percent'?Math.round(value*100/65535):value);
 if(kind==='percent')$(id+'-value').textContent=$(id).value+'%';
 if(id==='transpose')$('transpose-value').textContent=Number(value)>0?'+'+value:String(value);
}
function applySettings(values){for(const [id,number,kind]of parameters)if(values[number]!==undefined)applyValue(id,number,kind,values[number]);}
async function readSettings(){
 if(busy||!link||!device?.readback)return;busy=true;update();
 try{applySettings(await link.readParameters());$('parameter-result').textContent='已读取乐器当前设置。';}
 catch(error){$('parameter-result').textContent=error.message;}finally{busy=false;update();}
}
$('read-settings').onclick=readSettings;
for(const [id,number,kind]of parameters){
 if(kind==='percent')$(id).oninput=()=>$(id+'-value').textContent=$(id).value+'%';
 if(id==='transpose')$(id).oninput=()=>{$('transpose-value').textContent=Number($(id).value)>0?'+'+$(id).value:$(id).value;};
 $(id).onchange=async()=>{
  if(busy||!link||!device)return;
  try{
   const value=kind==='percent'?Math.round(Number($(id).value)*65535/100):Number($(id).value);
   const ack=await link.parameter(number,value);applyValue(id,number,kind,ack.actual);$('parameter-result').textContent='乐器已确认设置。';
  }catch(error){$('parameter-result').textContent=error.message;}
 };
}
function showPage(){
 const isParameters=location.pathname.endsWith('/parameters.html');
 $('upload-page').hidden=isParameters;$('parameters-page').hidden=!isParameters;
 for(const [id,active]of [['nav-upload',!isParameters],['nav-parameters',isParameters]]){
  if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');
 }
 $('page-title').textContent=isParameters?'演奏参数':'曲目上传';
 $('page-description').textContent=isParameters?'调整声音与演奏方式。':'选择曲目，跟随琴上的提示练习。';
 document.title=isParameters?'演奏参数':'曲目上传';
}
for(const id of ['nav-upload','nav-parameters'])$(id).onclick=event=>{
 event.preventDefault();history.pushState(null,'',$(id).href);showPage();
 if(id==='nav-parameters')readSettings();
};
window.addEventListener('popstate',showPage);showPage();update();
