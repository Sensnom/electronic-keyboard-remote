import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {connectInstrument} from '../mqtt-link.mjs';
import {frame} from '../assets/timeline.mjs';

const options={url:'wss://test.example/mqtt',upTopic:'test/up',downTopic:'test/down',ackTimeoutMs:10};
class Client extends EventEmitter{
 constructor(){super();this.sent=[];this.capability=0xddff;this.state=0;this.cycles=73729;this.clockHz=24576271;}
 async subscribeAsync(){}
 async publishAsync(topic,bytes){
  this.sent.push(Uint8Array.from(bytes));
  let actual=0;
  if(bytes[2]===5)actual=this.capability;
  if(bytes[2]===11){
   const op=bytes[6];
   if(op===1){this.state=1;actual=1;}
   else actual=[this.state,0,this.cycles%65536,Math.floor(this.cycles/65536),this.clockHz%65536,Math.floor(this.clockHz/65536)][op];
  }
  const ack=frame(128,bytes[3],Uint8Array.from([bytes[2],0,1,0,42,0,actual&255,actual>>>8]));
  this.emit('message','test/up',ack.subarray(0,5),{retain:false});
  this.emit('message','test/up',ack.subarray(5),{retain:false});
 }
 async endAsync(){this.emit('close');}
}
test('latency commands are capability gated and preserve existing parameter bits',async()=>{
 const client=new Client();client.capability=0xcdff;
 const link=await connectInstrument(options,async()=>client);
 try{
  const status=await link.status();assert.equal(status.latencySupported,false);
  await assert.rejects(async()=>link.startLatency(),/不支持/);
  await assert.rejects(async()=>link.readLatency(),/不支持/);
  assert.deepEqual(client.sent.map(x=>x[2]),[5]);
  client.capability=0xddff;
  const supported=await link.status();assert.equal(supported.latencySupported,true);assert.equal(supported.parameterMask,0xdff&~512);
 }finally{await link.close();}
});
test('frozen cycle result is read serially and converted using the reported audio clock',async()=>{
 const client=new Client(),events=[];
 const link=await connectInstrument({...options,onLog:event=>events.push(event)},async()=>client);
 try{
  await link.status();assert.equal((await link.startLatency()).state,1);
  const armCount=client.sent.filter(x=>x[2]===11&&x[6]===1).length;
  assert.equal((await link.startLatency()).continued,true);
  assert.equal(client.sent.filter(x=>x[2]===11&&x[6]===1).length,armCount,'continue waiting without restarting the counter');
  const pending=await link.readLatency();assert.equal(pending.state,1);assert.equal(pending.cycles,undefined);
  client.state=3;
  const result=await link.readLatency();
  assert.equal(result.cycles,73729);assert.equal(result.clockHz,24576271);
  assert.equal(result.scope,'sampled-key-to-digital-audio');
  assert.equal(result.milliseconds,73729*1000/24576271);
  assert.deepEqual(client.sent.slice(-5).map(x=>[x[2],x[6]]),[[11,0],[11,2],[11,3],[11,4],[11,5]]);
  assert.ok(events.some(x=>x.kind==='ack'&&x.matched&&x.requestType===11));
  assert.ok(events.some(x=>x.kind==='rx'&&x.data.length===5));
 }finally{await link.close();}
});
test('invalid, timed out and malformed reports never produce delay samples',async()=>{
 const client=new Client();
 const link=await connectInstrument(options,async()=>client);
 try{
  await link.status();
  for(const state of [0,4,5]){client.state=state;assert.deepEqual(await link.readLatency(),{state});}
  client.state=6;await assert.rejects(link.readLatency(),/状态/);
  client.state=3;client.clockHz=0;await assert.rejects(link.readLatency(),/时钟/);
  client.clockHz=24576271;client.cycles=0;await assert.rejects(link.readLatency(),/周期/);
  client.cycles=1000000;await assert.rejects(link.readLatency(),/周期/);
 }finally{await link.close();}
});
test('retained or CRC-corrupt data stays observable but cannot satisfy a measurement request',async()=>{
 const client=new Client(),events=[];
 const link=await connectInstrument({...options,onLog:event=>events.push(event)},async()=>client);
 try{
  await link.status();
  client.publishAsync=async(_topic,bytes)=>{
   const ack=frame(128,bytes[3],Uint8Array.from([bytes[2],0,1,0,42,0,3,0]));
   client.emit('message','test/up',ack,{retain:true});
   ack[15]^=1;client.emit('message','test/up',ack,{retain:false});
  };
  await assert.rejects(link.readLatency(),/超时/);
  assert.ok(events.some(x=>x.kind==='rx'&&x.retained));
  assert.ok(events.some(x=>x.kind==='error'&&x.message.includes('CRC')));
 }finally{await link.close();}
});
test('a failing log observer cannot interrupt device commands',async()=>{
 const client=new Client();
 const link=await connectInstrument({...options,onLog:()=>{throw Error('observer failed');}},async()=>client);
 try{assert.equal((await link.status()).modules,1);}finally{await link.close();}
});
