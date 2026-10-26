import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {connectInstrument} from '../mqtt-link.mjs';
import {frame} from '../assets/timeline.mjs';

class Client extends EventEmitter {
 constructor(){super();this.frames=[];this.closed=false;}
 async subscribeAsync(topic,options){this.subscription={topic,options};}
 async publishAsync(topic,payload,options){this.frames.push({topic,payload:Uint8Array.from(payload),options});this.respond?.(payload,this.frames.length);}
 async endAsync(){this.closed=true;this.emit('close');}
 ack(p,{code=0,actual=0,modules=1,stored=false,noteCount=42,retain=false,seq=p[3]}={}){
  const bytes=frame(128,seq,new Uint8Array([p[2],code,modules,stored?1:0,noteCount&255,noteCount>>8,actual&255,actual>>8]));
  this.emit('message','piano/up',bytes.subarray(0,5),{retain});this.emit('message','piano/up',bytes.subarray(5),{retain});
 }
}
const config={url:'wss://broker.example/mqtt',upTopic:'piano/up',downTopic:'piano/down',qos:0,ackTimeoutMs:20};
test('configuration rejects TCP, insecure WS, URL credentials and wildcard topics before connecting',async()=>{
 for(const change of [{url:'mqtt://host:1883'},{url:'ws://host/mqtt'},{url:'wss://user:password@host/mqtt'},{upTopic:'#'},{downTopic:'piano/up'},{qos:2}])
  await assert.rejects(connectInstrument({...config,...change},()=>{throw Error('connector must not be reached');}),/配置|WSS|QoS/);
});
test('browser binary link: sequence recovery, exact retry, split ACK, four presets and atomic upload',async()=>{
 const client=new Client();let firstStatus=true,dropped=false,stored=false,noteCount=42,count=0;
 client.respond=(p)=>{
  if(firstStatus){firstStatus=false;client.ack(p,{code:5,actual:250});return;}
  if(p[2]===4&&!dropped){dropped=true;client.ack(p,{retain:true});client.ack(p,{seq:(p[3]+1)&255});return;}
  if(p[2]===1)count=p[7]+256*p[8];if(p[2]===3){stored=true;noteCount=count;}
  if(p[2]===6){stored=false;noteCount=42;}
  client.ack(p,{stored,noteCount,actual:p[2]===4?p[7]+256*p[8]:0});
 };
 let receivedConfig;
 const link=await connectInstrument(config,async(url,options)=>{receivedConfig={url,options};return client;});
 assert.equal(receivedConfig.url,config.url);assert.equal(receivedConfig.options.protocolVersion,4);assert.equal(receivedConfig.options.reconnectPeriod,0);
 assert.equal(client.subscription.options.qos,0);
 assert.equal((await link.status()).modules,1);assert.equal(client.frames[1].payload[3],250);
 const start=client.frames.length;
 const values=await Promise.all([link.parameter(1,40000),link.parameter(2,2),link.parameter(2,4)]);
 assert.deepEqual(values.map(x=>x.actual),[40000,2,4]);
 assert.deepEqual(client.frames[start].payload,client.frames[start+1].payload,'retry must be byte-identical');
 assert.ok(client.frames.every(x=>x.options.qos===0&&x.options.retain===false));
 assert.throws(()=>link.parameter(2,5),/范围/);assert.throws(()=>link.parameter(2,3),/范围/);
 const song={modules:1,endMs:100,notes:[{start:0,duration:100,note:84,velocity:90,shift:2}]};
 const first=client.frames.length;const ack=await link.upload(song);assert.equal(ack.stored,true);assert.equal(ack.noteCount,1);
 assert.deepEqual(client.frames.slice(first).map(x=>x.payload[2]),[5,1,2,3]);
 assert.deepEqual(link.progress,{sent:3,total:3});assert.equal((await link.builtin()).stored,false);
 await link.close();assert.equal(client.closed,true);await assert.rejects(link.status(),/断开|连接/);
});
test('CRC-corrupted and retained ACKs cannot confirm a command',async()=>{
 const client=new Client();client.respond=p=>{
  const bytes=frame(128,p[3],new Uint8Array([p[2],0,1,0,42,0,0,0]));bytes[15]^=1;
  client.emit('message','piano/up',bytes,{retain:false});
  client.ack(p,{retain:true});
 };
 const link=await connectInstrument({...config,ackTimeoutMs:5},async()=>client);
 await assert.rejects(link.status(),/超时/);assert.equal(client.frames.length,3);await link.close();
});
test('changed board count rejects upload before BEGIN; device refusal consumes sequence once',async()=>{
 const client=new Client();client.respond=p=>client.ack(p,{modules:2,code:p[2]===4?4:0});
 const link=await connectInstrument(config,async()=>client);
 await assert.rejects(link.upload({modules:1,endMs:100,notes:[{start:0,duration:100,note:60,velocity:90,shift:0}]}),/数量/);
 assert.deepEqual(client.frames.map(x=>x.payload[2]),[5]);
 await assert.rejects(link.parameter(2,4),/范围/);await link.status();assert.equal(client.frames.at(-1).payload[3],2);await link.close();
});

test('extended parameters preserve signed values, read current settings and gate legacy firmware',async()=>{
 const client=new Client(),settings={1:65535,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0};
 client.respond=p=>{
  if(p[2]===5){client.ack(p,{actual:0x81ff});return;}
  const id=p[6];if(p[2]===4)settings[id]=p[7]+256*p[8];client.ack(p,{actual:settings[id]});
 };
 const link=await connectInstrument(config,async()=>client);const status=await link.status();assert.equal(status.parameterMask,511);assert.equal(status.readback,true);
 for(const [id,value]of [[5,1],[6,7],[7,-12],[8,-2],[9,1]])assert.equal((await link.parameter(id,value)).actual,value);
 for(const [id,value]of [[5,2],[6,8],[7,-13],[7,13],[8,-3],[8,3],[9,2]])assert.throws(()=>link.parameter(id,value),/范围/);
 const values=await link.readParameters();assert.equal(values[7],-12);assert.equal(values[8],-2);assert.equal(values[6],7);assert.equal(values[5],1);assert.equal(values[9],1);
 assert.equal(client.frames.filter(f=>f.payload[2]===7).length,9);await link.close();
 const old=new Client();old.respond=p=>old.ack(p);
 const legacy=await connectInstrument(config,async()=>old);assert.equal((await legacy.status()).parameterMask,15);
 assert.throws(()=>legacy.parameter(5,1),/不支持/);await assert.rejects(legacy.readParameters(),/不支持/);assert.equal(old.frames.length,1);await legacy.close();
});
