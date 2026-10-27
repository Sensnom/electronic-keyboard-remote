import mqtt from './vendor/mqtt.esm.js';
import {connectInstrument} from './mqtt-link.mjs';
import {parseMidi} from './assets/midi.mjs';
import {compileTimeline} from './assets/timeline.mjs';
import {mountSignalLog} from './log-page.mjs';
const $=id=>document.getElementById(id);
let raw=null,device=null,link=null,busy=false,fileGeneration=0,connectionGeneration=0;
let measurementRunning=false,measurementOwner=null;
const signalLog=mountSignalLog({onMeasure:measureLatency});
const parameters=[['volume',1,'percent'],['patch',2],['effect',3],['wet',4,'percent'],['chord-enabled',5],['chord-type',6],['transpose',7,'signed'],['octave',8,'signed'],['glide',9],['sustain',12]];
const configIds=['broker','up-topic','down-topic','username','password','qos'];
function compile(){
 if(!raw||!device)return null;
 if(!$('speed-number').checkValidity())throw Error('速度须为10～300%的整数');
 return compileTimeline(raw,{tracks:[...document.querySelectorAll('#tracks input:checked')].map(x=>Number(x.value)),modules:device.modules,speed:Number($('speed').value),maxNotes:device.maxNotes||256,truncate:true});
}
function update(){
 const ready=!!device&&!!link?.connected;
 for(const id of configIds)$(id).disabled=busy;
 $('connect').disabled=busy;$('disconnect').disabled=(busy&&!measurementRunning)||!link;
 signalLog.update({ready,supported:!!device?.latencySupported,busy});
 for(const id of ['file','speed','speed-number'])$(id).disabled=busy;
 for(const input of document.querySelectorAll('#tracks input'))input.disabled=busy;
 for(const [id,number] of parameters)$(id).disabled=busy||!ready||!(device.parameterMask&(1<<(number-1)));
 for(const group of document.querySelectorAll('[data-params]'))group.hidden=ready&&group.dataset.params.split(',').every(id=>!(device.parameterMask&(1<<(Number(id)-1))));
 $('read-settings').hidden=ready&&!device.readback;$('read-settings').disabled=busy||!ready||!device.readback;
 $('builtin').disabled=busy||!ready||device.learning;
 $('phone-loop').hidden=!ready||!device.loopControl;
 for(const button of document.querySelectorAll('[data-loop]'))button.disabled=busy||!ready||!device.loopControl||(device.learning&&button.dataset.loop!=='play');
 for(const button of document.querySelectorAll('[data-bend]'))button.disabled=busy||!ready||!(device.parameterMask&1024);
 $('bend-range').disabled=busy||!ready||!(device.parameterMask&1024);
 $('upload').disabled=true;
 if(!raw)return;
 if(!ready){$('summary').textContent='已读取文件。请连接乐器，按实际12/24键编译曲目。';return;}
 try{
  const song=compile();$('summary').textContent=`${song.notes.length}个音符 · ${(song.endMs/1000).toFixed(2)}秒 · ${device.modules*12}键自动换八度，保留原曲音高。`+(song.truncation.truncated?` 已截断：原${song.truncation.originalNoteCount}个音符，保留${song.notes.length}个，设备容量${device.maxNotes}；结尾保留完整音符与和弦。`:'');
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
   onLog:event=>{if(generation===connectionGeneration)signalLog.receive(event);},
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
  const midi=parseMidi(bytes);raw=bytes;$('file-info').textContent=`${file.name} · ${bytes.length}字节`;
  const legend=document.createElement('legend');legend.textContent='选择练习轨道';$('tracks').append(legend);
  midi.tracks.forEach((track,index)=>{
   if(!track.notes.length)return;
   const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=String(index);input.onchange=update;
   label.append(input,document.createTextNode(`轨道${index+1} ${track.name}（${track.notes.length}音）`));$('tracks').append(label);
  });update();
 }catch(error){$('file-info').textContent=error.message;}
};
function setSpeed(value){
 const valid=Number.isInteger(Number(value))&&Number(value)>=10&&Number(value)<=300&&value!=='';
 $('speed-number').setCustomValidity(valid?'':'请输入10～300的整数');
 if(valid){$('speed').value=value;$('speed-value').textContent=value+'%';}
 $('speed-number').value=value;update();
}
$('speed').oninput=()=>setSpeed($('speed').value);
$('speed-number').oninput=()=>setSpeed($('speed-number').value);
for(const button of document.querySelectorAll('[data-speed]'))button.onclick=()=>{if(!busy)setSpeed(button.dataset.speed);};
$('upload').onclick=async()=>{
 if(busy||!link||!device)return;
 let song;try{song=compile();}catch(error){$('result').textContent=error.message;return;}if(!song)return;
 busy=true;update();$('progress').value=0;$('result').textContent='正在上传，等待乐器确认…';
 const progress=setInterval(()=>{if(link?.progress)$('progress').value=100*link.progress.sent/link.progress.total;},300);
 try{
  const ack=await link.upload(song);if(!ack.stored||ack.noteCount!==song.notes.length)throw Error('乐器未确认完整曲目提交');
  $('progress').value=100;$('result').textContent=(song.truncation.truncated?`已提交截断片段：保留${song.notes.length}/${song.truncation.originalNoteCount}个音符。`:'曲目已由乐器校验并提交。')+'短按琴上按钮9开始，漏弹会计错并继续。';
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
 try{applySettings(await link.readParameters());if(device.loopControl)showLoop(await link.loopStatus());$('parameter-result').textContent='已读取乐器当前设置。';}
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
 const isLogs=location.pathname.endsWith('/logs.html');
 $('upload-page').hidden=isParameters||isLogs;$('parameters-page').hidden=!isParameters;$('logs-page').hidden=!isLogs;
 for(const [id,active]of [['nav-upload',!isParameters&&!isLogs],['nav-parameters',isParameters],['nav-logs',isLogs]]){
  if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');
 }
 $('page-title').textContent=isLogs?'信号日志':isParameters?'演奏参数':'曲目上传';
 $('page-description').textContent=isLogs?'查看设备应答，保存数字路径计时记录。':isParameters?'调整声音与演奏方式。':'选择曲目，跟随琴上的提示练习。';
 document.title=$('page-title').textContent;
}
for(const id of ['nav-upload','nav-parameters','nav-logs'])$(id).onclick=event=>{
 event.preventDefault();holdBend(0);history.pushState(null,'',$(id).href);showPage();
 if(id==='nav-parameters')readSettings();
};
window.addEventListener('popstate',showPage);showPage();update();

async function measureLatency(){
 if(busy||!link?.connected||!device?.latencySupported)return;
 const current=link;measurementOwner=current;measurementRunning=true;busy=true;update();
 try{
  const prepared=await current.startLatency();
  signalLog.message(prepared.continued?'继续等待已准备的测量，请按测试琴键。':'已准备，请按测试琴键。');
  const waitStarted=Date.now();
  while(current===link&&current.connected&&Date.now()-waitStarted<30000){
   const result=await current.readLatency();
   if(current!==link||!current.connected)return;
   if(result.state===3){signalLog.measurement(result);signalLog.message('已收到设备周期计数并保存。本次测量已结束。');return;}
   if(result.state===4)throw Error('本次测量无效，未生成延迟数值。请检查测试条件后重新准备。');
   if(result.state===5)throw Error('设备计时超时，未生成延迟数值。');
   if(result.state===0)throw Error('设备已退出测量准备，未生成延迟数值。');
   signalLog.message(result.state===2?'FPGA 正在本地计时，等待结果…':'已准备，请按测试琴键。');
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error(current!==link||!current.connected?'连接已断开，本次未确认测量结果。':'手机等待已结束。设备可能仍在等待按键，再次点击将继续读取。');
 }catch(error){if(current===link){signalLog.message(error.message);signalLog.receive({kind:'error',message:error.message});}}
 finally{if(measurementOwner===current){measurementOwner=null;measurementRunning=false;if(current===link){busy=false;update();}}}
}

function showLoop(state){
 $('loop-state').textContent=state.lessonActive?(state.lessonComplete?'学习已结束':'学习进行中'):`${state.layers}层 · ${state.recording?'录制中':state.armed?'等待下一圈叠录':state.playing?'播放中':'已停止'}`;
 $('loop-play').textContent=state.lessonActive?'退出学习':state.layers===0?'进入学习':'播放 / 停止';
 if(device)device.learning=state.lessonActive&&!state.lessonComplete;
}
for(const button of document.querySelectorAll('[data-loop]'))button.onclick=async()=>{
 if(busy||!link||!device?.loopControl)return;busy=true;update();
 try{showLoop(await link.loop(button.dataset.loop));$('parameter-result').textContent='乐器已确认操作。';}
 catch(error){$('parameter-result').textContent=error.message;}
 finally{busy=false;update();}
};
let bendDirection=0,bendTask=null;
function holdBend(value){
 bendDirection=value;$('bend-range').value=String(value);$('bend-value').textContent=`${(value/256).toFixed(2)} 半音`;if(bendTask||!link?.connected||!device||(device.parameterMask&1024)===0)return;
 const current=link;
 bendTask=(async()=>{
  try{do{
   const value=bendDirection;await current.parameter(11,value);
   if(value===0&&bendDirection===0)break;
   await new Promise(resolve=>setTimeout(resolve,150));
  }while(current===link&&current.connected);}
  catch(error){bendDirection=0;$('parameter-result').textContent=error.message;}
  finally{bendTask=null;}
 })();
}
for(const button of document.querySelectorAll('[data-bend]')){
 button.style.touchAction='none';
 button.onpointerdown=event=>{if(button.disabled)return;event.preventDefault();button.setPointerCapture(event.pointerId);holdBend(Number(button.dataset.bend));};
 button.onpointerup=button.onpointercancel=button.onlostpointercapture=()=>holdBend(0);
 button.onblur=()=>holdBend(0);
 button.onkeydown=event=>{if((event.key===' '||event.key==='Enter')&&!event.repeat&&!button.disabled){event.preventDefault();holdBend(Number(button.dataset.bend));}};
 button.onkeyup=event=>{if(event.key===' '||event.key==='Enter')holdBend(0);};
}
const bendRange=$('bend-range');
bendRange.oninput=()=>holdBend(Number(bendRange.value));
bendRange.onchange=bendRange.onpointerup=bendRange.onpointercancel=bendRange.onblur=bendRange.onlostpointercapture=()=>holdBend(0);
bendRange.onkeyup=event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))holdBend(0);};
window.addEventListener('blur',()=>holdBend(0));
document.addEventListener('visibilitychange',()=>{if(document.hidden)holdBend(0);});
setInterval(async()=>{
 if(document.hidden||busy||!device?.loopControl||!link?.connected||link.queued)return;
 try{showLoop(await link.loopStatus());update();}catch{}
},2000);
