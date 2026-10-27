import {frame,uploadFrames,validateTimeline} from './assets/timeline.mjs';
import {crc16} from './assets/protocol.mjs';

const le16=(bytes,index)=>bytes[index]+256*bytes[index+1];
export async function connectInstrument(options,connectClient){
 const {url,upTopic,downTopic,qos=0,username='',password='',ackTimeoutMs=10000,onDisconnect=()=>{},onLog=()=>{}}=options;
 let endpoint;try{endpoint=new URL(url);}catch{throw Error('请配置有效的WSS地址');}
 if(endpoint.protocol!=='wss:'||endpoint.username||endpoint.password)throw Error('WSS地址须使用wss://，用户名和密码在单独字段填写');
 if(![upTopic,downTopic].every(s=>typeof s==='string'&&s.length&&s.length<=256&&!/[#+\x00]/.test(s))||upTopic===downTopic)
  throw Error('请配置不同且不含通配符的设备上下行主题');
 if(!Number.isInteger(qos)||![0,1].includes(qos))throw Error('MQTT QoS须为0或1');
 const client=await connectClient(endpoint.href,{username,password,protocolVersion:4,clean:true,
  reconnectPeriod:0,connectTimeout:10000,resubscribe:false,queueQoSZero:false});
 const link=new InstrumentLink(client,{upTopic,downTopic,qos,ackTimeoutMs,onDisconnect,onLog});
 try{await client.subscribeAsync(upTopic,{qos});link.connected=true;link.observe({kind:'connection',message:'已订阅设备上行，等待乐器应答'});return link;}
 catch(error){await client.endAsync();throw error;}
}
class InstrumentLink{
 constructor(client,options){
  Object.assign(this,options);this.client=client;this.connected=false;this.sequence=0;
  this.buffer=new Uint8Array();this.tail=Promise.resolve();this.queued=0;this.pending=null;this.progress=null;this.parameterMask=15;this.readback=false;this.maxNotes=256;this.latencySupported=false;
  client.on('message',(topic,data,packet)=>{
   if(topic!==this.upTopic)return;
   this.observe({kind:'rx',data,retained:!!packet?.retain});
   if(!packet?.retain)this.receive(data);
  });
  client.on('close',()=>{this.connected=false;this.buffer=new Uint8Array();this.latencySupported=false;this.pending?.reject(Error('MQTT连接已断开，未确认操作成功'));this.observe({kind:'connection',message:'连接已断开'});this.onDisconnect();});
  client.on('error',()=>{});
 }
 observe(event){try{this.onLog({...event,...(event.data?{data:Uint8Array.from(event.data)}:{})});}catch{ /* Logging must never block instrument control. */ }}
 receive(data){
  const buffer=new Uint8Array(this.buffer.length+data.length);buffer.set(this.buffer);buffer.set(data,this.buffer.length);this.buffer=buffer;
  if(buffer.length>4096){this.buffer=new Uint8Array();this.observe({kind:'error',message:'接收缓存超过上限，已重新寻找帧头'});return;}
  while(this.buffer.length>=8){
   let index=-1;for(let i=0;i<this.buffer.length-1;i++)if(this.buffer[i]===165&&this.buffer[i+1]===90){index=i;break;}
   if(index<0){this.buffer=this.buffer.slice(-1);return;}
   if(index)this.buffer=this.buffer.slice(index);if(this.buffer.length<8)return;
   const size=le16(this.buffer,4);if(size>64){this.buffer=this.buffer.slice(1);continue;}
   if(this.buffer.length<size+8)return;
   const packet=this.buffer.slice(0,size+8);this.buffer=this.buffer.slice(size+8);
   if(crc16(packet.subarray(2,-2))!==le16(packet,packet.length-2)){this.observe({kind:'error',message:'CRC校验失败，未采用此帧',data:packet});continue;}
   if(packet[2]!==128||size!==8){this.observe({kind:'frame',message:'收到尚未解析的有效帧',data:packet});continue;}
   const matched=!!this.pending&&packet[3]===this.pending.seq&&packet[6]===this.pending.type;
   this.observe({kind:'ack',sequence:packet[3],requestType:packet[6],code:packet[7],matched,data:packet});
   if(!matched)continue;
   this.pending.resolve({code:packet[7],modules:packet[8],stored:!!(packet[9]&1),learning:!!(packet[9]&2),
    noteCount:le16(packet,10),actual:le16(packet,12)});
  }
 }
 enqueue(work){
  if(this.queued>=8)return Promise.reject(Error('已有过多设备操作，请等待完成'));
  this.queued++;const result=this.tail.then(work);this.tail=result.catch(()=>{}).finally(()=>this.queued--);return result;
 }
 async send(type,payload=new Uint8Array()){
  for(let attempt=0;attempt<3;attempt++){
   if(!this.connected)throw Error('MQTT连接已断开，请重新连接');
   const seq=this.sequence,bytes=frame(type,seq,payload);let timer;
   const answer=new Promise((resolve,reject)=>{this.pending={seq,type,resolve,reject};timer=setTimeout(()=>reject(Error('乐器应答超时，请检查DTU联网、主题和串口')),this.ackTimeoutMs);});
   answer.catch(()=>{});
   try{
    this.observe({kind:'tx',sequence:seq,requestType:type,data:bytes});
    await this.client.publishAsync(this.downTopic,bytes,{qos:this.qos,retain:false});
    const ack=await answer;
    if(ack.code===5){this.sequence=ack.actual&255;continue;}
    if(ack.code===1)continue;
    this.sequence=(seq+1)&255;
    if(ack.code!==0)throw Object.assign(Error(['','CRC错误','数据格式错误','学习中不能覆盖曲目','参数或音域超出范围','序号错误','没有有效上传事务'][ack.code]||'乐器拒绝命令'),{deviceRejected:true});
    return ack;
   }catch(error){this.observe({kind:'error',sequence:seq,requestType:type,message:error.message});if(error.deviceRejected||attempt===2)throw error;}
   finally{clearTimeout(timer);this.pending=null;}
  }
  throw Error('设备序号未能同步，请重新连接');
 }
 status(){return this.enqueue(async()=>{
  const ack=await this.send(5);this.parameterMask=ack.actual===0?15:(ack.actual&4095)&~512;this.readback=!!(ack.actual&32768);
  this.loopControl=!!(ack.actual&16384);
  this.latencySupported=!!(ack.actual&4096);
  this.maxNotes=256;
  if(ack.actual&8192){
   const capacity=await this.send(10);
   if(capacity.actual<1||capacity.actual>32768)throw Error('乐器返回的曲目容量无效');
   this.maxNotes=capacity.actual;
  }
  return {...ack,parameterMask:this.parameterMask,readback:this.readback,loopControl:this.loopControl,maxNotes:this.maxNotes,latencySupported:this.latencySupported};
 });}
 startLatency(){
  if(!this.latencySupported)return Promise.reject(Error('当前固件不支持数字路径计时'));
  return this.enqueue(async()=>{
   const current=(await this.send(11,Uint8Array.of(0))).actual;
   if(current===1||current===2)return {state:current,continued:true};
   if(![0,3,4,5].includes(current))throw Error('乐器返回的测量状态无效');
   const state=(await this.send(11,Uint8Array.of(1))).actual;
   if(state!==1&&state!==2)throw Error('乐器未进入测量准备状态');
   return {state};
  });
 }
 readLatency(){
  if(!this.latencySupported)return Promise.reject(Error('当前固件不支持数字路径计时'));
  return this.enqueue(async()=>{
   const state=(await this.send(11,Uint8Array.of(0))).actual;
   if(![0,1,2,3,4,5].includes(state))throw Error('乐器返回的测量状态无效');
   if(state!==3)return {state};
   const words=[];for(const op of [2,3,4,5])words.push((await this.send(11,Uint8Array.of(op))).actual);
   const cycles=words[0]+65536*words[1],clockHz=words[2]+65536*words[3];
   if(clockHz===0)throw Error('乐器返回的计时时钟无效');
   if(cycles===0||cycles>Math.ceil(clockHz/50))throw Error('乐器返回的测量周期无效');
   return {state,cycles,clockHz,milliseconds:cycles*1000/clockHz,scope:'sampled-key-to-digital-audio'};
  });
 }
 parameter(id,value){
  if(!Number.isInteger(id)||!Number.isInteger(value)||id<1||id>12||id===10||
   (id<=4&&(value<0||value>65535))||(id===2&&(value>4||value===3))||(id===3&&value>3)||
   ((id===5||id===9||id===12)&&(value<0||value>1))||(id===6&&(value<0||value>7))||
   (id===7&&(value< -12||value>12))||(id===8&&(value< -2||value>2))||
   (id===11&&(value< -512||value>512)))throw Error('参数范围无效');
  if(!(this.parameterMask&(1<<(id-1))))throw Error('当前乐器不支持此设置');
  const wire=value&65535;
  return this.enqueue(async()=>this.decodeParameter(id,await this.send(4,new Uint8Array([id,wire&255,wire>>8]))));
 }
 decodeParameter(id,ack){return {...ack,actual:(id===7||id===8||id===11)&&ack.actual>=32768?ack.actual-65536:ack.actual};}
 decodeLoop(ack){return {...ack,layers:ack.actual&7,playing:!!(ack.actual&8),recording:!!(ack.actual&16),armed:!!(ack.actual&32),lessonActive:!!(ack.actual&64),lessonComplete:!!(ack.actual&128)};}
 loop(action){
  const id={record:1,undo:2,play:3,clear:4}[action];if(!id)throw Error('Loop操作无效');
  if(!this.loopControl)throw Error('当前乐器不支持手机Loop操作');
  return this.enqueue(async()=>this.decodeLoop(await this.send(8,new Uint8Array([id]))));
 }
 loopStatus(){
  if(!this.loopControl)throw Error('当前乐器不支持手机Loop操作');
  return this.enqueue(async()=>this.decodeLoop(await this.send(9)));
 }
 readParameters(){
  if(!this.readback)return Promise.reject(Error('当前乐器不支持读取设置'));
  return this.enqueue(async()=>{
   const values={};for(let id=1;id<=12;id++)if(id!==10&&(this.parameterMask&(1<<(id-1))))values[id]=this.decodeParameter(id,await this.send(7,new Uint8Array([id]))).actual;
   return values;
  });
 }
 builtin(){return this.enqueue(()=>this.send(6));}
 upload(song){
  validateTimeline(song,{maxNotes:this.maxNotes});
  return this.enqueue(async()=>{
   const status=await this.send(5);if(status.modules!==song.modules)throw Error('实际键盘数量已变化，请重新编译曲目');
   const packets=uploadFrames(song,0,{maxNotes:this.maxNotes});let ack;
   for(let i=0;i<packets.length;i++){
    this.progress={sent:i,total:packets.length};const p=packets[i];ack=await this.send(p[2],p.subarray(6,-2));
   }
   this.progress={sent:packets.length,total:packets.length};return ack;
  });
 }
 async close(){this.connected=false;this.pending?.reject(Error('MQTT连接已断开'));await this.client.endAsync();}
}
