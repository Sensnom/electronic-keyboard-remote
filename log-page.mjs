import {SignalLog} from './signal-log.mjs';

const time=value=>{
 const date=new Date(value);
 return date.toLocaleTimeString('zh-CN',{hour12:false})+'.'+String(date.getMilliseconds()).padStart(3,'0');
};
const names={connection:'连接',rx:'上行数据',tx:'下行请求',ack:'有效应答',error:'错误',frame:'其他有效帧'};

export function mountSignalLog({onMeasure}){
 const log=new SignalLog();
 const section=document.createElement('section');section.id='logs-page';section.hidden=true;section.setAttribute('aria-labelledby','logs-title');
 section.innerHTML=`<h2 id="logs-title">FPGA 计时日志</h2>
 <p class="hint">琴键采集 → 数字音频输出</p>
 <p id="latency-support" role="status">请连接乐器。</p>
 <div class="actions log-actions"><button id="latency-start" disabled>准备一次测量</button><button id="log-pause" class="secondary">暂停采集</button><button id="log-export" class="secondary">导出日志</button><button id="log-clear" class="secondary">清空日志</button></div>
 <p id="measurement-status" role="status" aria-live="polite">尚无设备测量结果。</p>
 <dl class="log-statistics"><div><dt>保留样本</dt><dd id="log-count">0</dd></div><div><dt>最小延迟</dt><dd id="log-min">—</dd></div><div><dt>最大延迟</dt><dd id="log-max">—</dd></div><div><dt>平均延迟</dt><dd id="log-average">—</dd></div></dl>
 <ol id="measurement-log" class="signal-records" aria-label="数字路径测量日志"><li class="hint">暂无测量记录。</li></ol>
 <p class="hint">不含触摸识别与模拟输出延迟。</p>
 <details><summary>通信记录</summary><label for="log-filter">显示内容</label><select id="log-filter"><option value="all">全部记录</option><option value="ack">有效应答</option><option value="error">错误</option><option value="rx">原始上行数据</option><option value="tx">下行请求</option></select><ol id="communication-log" class="signal-records" aria-label="通信日志"></ol></details>
 <p id="log-retention" role="status" hidden></p>`;
 document.querySelector('main').append(section);
 const $=id=>section.querySelector('#'+id);
 let ready=false,supported=false,busy=false,renderTimer=null;
 function updateControls(){
  $('latency-start').disabled=!ready||!supported||busy||log.paused;
  $('log-pause').disabled=busy;
  $('log-pause').textContent=log.paused?'继续采集':'暂停采集';
  $('log-export').disabled=log.entries.length===0&&log.measurements.length===0;
 }
 function render(){
  const summary=log.summary();$('log-count').textContent=String(summary.count);
  for(const [id,key]of [['log-min','min'],['log-max','max'],['log-average','average']])
   $(id).textContent=summary.count?summary[key].toFixed(3)+' ms':'—';
  const samples=log.measurements.slice().reverse().map(entry=>{
   const item=document.createElement('li');
   item.textContent=`[手机接收 ${time(entry.at)}] 按键采集 0 周期 → 数字音频发出 ${entry.cycles} 周期\n时间差 ${entry.milliseconds.toFixed(3)} ms · 计时时钟 ${entry.clockHz} Hz`;
   return item;
  });
  if(!samples.length){const empty=document.createElement('li');empty.className='hint';empty.textContent='暂无测量记录。';samples.push(empty);}
  $('measurement-log').replaceChildren(...samples);
  const filter=$('log-filter').value;
  const records=log.entries.filter(entry=>filter==='all'||entry.kind===filter).slice().reverse().map(entry=>{
   const item=document.createElement('li');
   let message=`[${time(entry.at)}] ${names[entry.kind]||'记录'}`;
   if(entry.requestType!==undefined)message+=` · 类型 ${entry.requestType} · 序号 ${entry.sequence}`;
   if(entry.kind==='ack')message+=` · 状态 ${entry.code}${entry.matched?'':' · 非当前请求，未采用'}`;
   if(entry.retained)message+=' · 历史保留消息，未采用';
   if(entry.message)message+=' · '+entry.message;
   if(entry.hex)message+=`\n${entry.hex}${entry.truncated?`（共${entry.byteLength}字节，仅保留前512字节）`:''}`;
   item.textContent=message;if(entry.kind==='error')item.className='signal-error';return item;
  });
  if(!records.length){const empty=document.createElement('li');empty.className='hint';empty.textContent='当前没有此类通信记录。';records.push(empty);}
  $('communication-log').replaceChildren(...records);
  $('log-retention').hidden=!log.droppedEntries&&!log.droppedMeasurements;
  $('log-retention').textContent=`已移出${log.droppedMeasurements}次旧测量、${log.droppedEntries}条旧通信记录。`;
  updateControls();
 }
 function schedule(){if(renderTimer===null)renderTimer=setTimeout(()=>{renderTimer=null;render();},100);}
 $('latency-start').onclick=onMeasure;
 $('log-pause').onclick=()=>{log.paused=!log.paused;updateControls();};
 $('log-filter').onchange=render;
 $('log-clear').onclick=()=>{log.clear();$('measurement-status').textContent='日志已清空。';render();};
 $('log-export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([log.exportJSON()],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download='fpga-digital-latency-'+new Date().toISOString().replaceAll(':','-')+'.json';
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 render();
 return {
  receive(event){log.add(event);schedule();},
  measurement(value){log.addMeasurement(value);render();},
  message(value){$('measurement-status').textContent=value;},
  update(value){
   ({ready,supported,busy}=value);
   $('latency-support').textContent=!ready?'请连接乐器。':supported?'请关闭 Loop、学习、和弦、效果和滑音，松开琴键并等待声音结束。':'当前设备暂不支持计时。';
   updateControls();
  }
 };
}
