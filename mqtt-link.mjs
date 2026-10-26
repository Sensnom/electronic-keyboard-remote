import {frame,uploadFrames,validateTimeline} from './assets/timeline.mjs';
import {crc16} from './assets/protocol.mjs';

const le16=(bytes,index)=>bytes[index]+256*bytes[index+1];
export async function connectInstrument(options,connectClient){
 const {url,upTopic,downTopic,qos=0,username='',password='',ackTimeoutMs=10000,onDisconnect=()=>{}}=options;
 let endpoint;try{endpoint=new URL(url);}catch{throw Error('请配置有效的WSS地址');}
 if(endpoint.protocol!=='wss:'||endpoint.username||endpoint.password)throw Error('WSS地址须使用wss://，用户名和密码在单独字段填写');
 if(![upTopic,downTopic].every(s=>typeof s==='string'&&s.length&&s.length<=256&&!/[#+\x00]/.test(s))||upTopic===downTopic)
  throw Error('请配置不同且不含通配符的设备上下行主题');
 if(!Number.isInteger(qos)||![0,1].includes(qos))throw Error('MQTT QoS须为0或1');
 const client=await connectClient(endpoint.href,{username,password,protocolVersion:4,clean:true,
  reconnectPeriod:0,connectTimeout:10000,resubscribe:false,queueQoSZero:false});
 const link=new InstrumentLink(client,{upTopic,downTopic,qos,ackTimeoutMs,onDisconnect});
 try{await client.subscribeAsync(upTopic,{qos});link.connected=true;return link;}
 catch(error){await client.endAsync();throw error;}
}
class InstrumentLink{
 constructor(client,options){
  Object.assign(this,options);this.client=client;this.connected=false;this.sequence=0;
  this.buffer=new Uint8Array();this.tail=Promise.resolve();this.queued=0;this.pending=null;this.progress=null;this.parameterMask=15;this.readback=false;
  client.on('message',(topic,data,packet)=>{if(topic===this.upTopic&&!packet?.retain)this.receive(data);});
  client.on('close',()=>{this.connected=false;this.buffer=new Uint8Array();this.pending?.reject(Error('MQTT连接已断开，未确认操作成功'));this.onDisconnect();});
  client.on('error',()=>{});
 }
 receive(data){
  const buffer=new Uint8Array(this.buffer.length+data.length);buffer.set(this.buffer);buffer.set(data,this.buffer.length);this.buffer=buffer;
  if(buffer.length>4096){this.buffer=new Uint8Array();return;}
  while(this.buffer.length>=8){
   let index=-1;for(let i=0;i<this.buffer.length-1;i++)if(this.buffer[i]===165&&this.buffer[i+1]===90){index=i;break;}
   if(index<0){this.buffer=this.buffer.slice(-1);return;}
   if(index)this.buffer=this.buffer.slice(index);if(this.buffer.length<8)return;
   const size=le16(this.buffer,4);if(size>64){this.buffer=this.buffer.slice(1);continue;}
   if(this.buffer.length<size+8)return;
   const packet=this.buffer.slice(0,size+8);this.buffer=this.buffer.slice(size+8);
   if(crc16(packet.subarray(2,-2))!==le16(packet,packet.length-2))continue;
   if(packet[2]!==128||size!==8||!this.pending||packet[3]!==this.pending.seq||packet[6]!==this.pending.type)continue;
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
    await this.client.publishAsync(this.downTopic,bytes,{qos:this.qos,retain:false});
    const ack=await answer;
    if(ack.code===5){this.sequence=ack.actual&255;continue;}
    if(ack.code===1)continue;
    this.sequence=(seq+1)&255;
    if(ack.code!==0)throw Object.assign(Error(['','CRC错误','数据格式错误','学习中不能覆盖曲目','参数或音域超出范围','序号错误','没有有效上传事务'][ack.code]||'乐器拒绝命令'),{deviceRejected:true});
    return ack;
   }catch(error){if(error.deviceRejected||attempt===2)throw error;}
   finally{clearTimeout(timer);this.pending=null;}
  }
  throw Error('设备序号未能同步，请重新连接');
 }
 status(){return this.enqueue(async()=>{
  const ack=await this.send(5);this.parameterMask=ack.actual===0?15:ack.actual&511;this.readback=!!(ack.actual&32768);
  return {...ack,parameterMask:this.parameterMask,readback:this.readback};
 });}
 parameter(id,value){
  if(!Number.isInteger(id)||!Number.isInteger(value)||id<1||id>9||
   (id<=4&&(value<0||value>65535))||(id===2&&value>4)||(id===3&&value>3)||
   ((id===5||id===9)&&(value<0||value>1))||(id===6&&(value<0||value>7))||
   (id===7&&(value< -12||value>12))||(id===8&&(value< -2||value>2)))throw Error('参数范围无效');
  if(!(this.parameterMask&(1<<(id-1))))throw Error('当前乐器不支持此设置');
  const wire=value&65535;
  return this.enqueue(async()=>this.decodeParameter(id,await this.send(4,new Uint8Array([id,wire&255,wire>>8]))));
 }
 decodeParameter(id,ack){return {...ack,actual:(id===7||id===8)&&ack.actual>=32768?ack.actual-65536:ack.actual};}
 readParameters(){
  if(!this.readback)return Promise.reject(Error('当前乐器不支持读取设置'));
  return this.enqueue(async()=>{
   const values={};for(let id=1;id<=9;id++)if(this.parameterMask&(1<<(id-1)))values[id]=this.decodeParameter(id,await this.send(7,new Uint8Array([id]))).actual;
   return values;
  });
 }
 builtin(){return this.enqueue(()=>this.send(6));}
 upload(song){
  validateTimeline(song);
  return this.enqueue(async()=>{
   const status=await this.send(5);if(status.modules!==song.modules)throw Error('实际键盘数量已变化，请重新编译曲目');
   const packets=uploadFrames(song,0);let ack;
   for(let i=0;i<packets.length;i++){
    this.progress={sent:i,total:packets.length};const p=packets[i];ack=await this.send(p[2],p.subarray(6,-2));
   }
   this.progress={sent:packets.length,total:packets.length};return ack;
  });
 }
 async close(){this.connected=false;this.pending?.reject(Error('MQTT连接已断开'));await this.client.endAsync();}
}
