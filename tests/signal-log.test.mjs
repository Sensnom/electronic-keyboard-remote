import test from 'node:test';
import assert from 'node:assert/strict';

test('only valid device cycle reports enter the measurement log; phone receipt time is separate',async()=>{
 const {SignalLog}=await import('../signal-log.mjs');
 const log=new SignalLog({now:()=>Date.UTC(2026,9,27,12)});
 const sample=log.addMeasurement({state:3,cycles:73729,clockHz:24576271,scope:'sampled-key-to-digital-audio'});
 assert.equal(sample.at,'2026-10-27T12:00:00.000Z');
 assert.equal(sample.startCycles,0);assert.equal(sample.endCycles,73729);
 assert.equal(sample.milliseconds,73729*1000/24576271);
 for(const result of [{state:1},{state:3,cycles:0,clockHz:24576271},{state:3,cycles:1,clockHz:0},{state:3,cycles:NaN,clockHz:1}])
  assert.throws(()=>log.addMeasurement(result),/测量|周期|时钟/);
 assert.equal(log.measurements.length,1);
});
test('bounded logs and paused capture keep memory predictable and export excludes credentials',async()=>{
 const {SignalLog}=await import('../signal-log.mjs');
 const log=new SignalLog({limit:2,measurementLimit:2,byteLimit:4});
 log.add({kind:'rx',data:Uint8Array.from([1,2,3,4,5]),username:'secret-user',password:'secret-pass',url:'wss://secret.example'});
 assert.equal(log.entries[0].hex,'01 02 03 04');assert.equal(log.entries[0].byteLength,5);assert.equal(log.entries[0].truncated,true);
 log.add({kind:'ack',code:0,matched:true});log.add({kind:'connection',message:'connected'});
 assert.equal(log.entries.length,2);assert.equal(log.droppedEntries,1);
 log.paused=true;log.add({kind:'error',message:'not stored'});assert.equal(log.entries.length,2);
 log.paused=false;
 for(const cycles of [10,20,30])log.addMeasurement({state:3,cycles,clockHz:1000000,scope:'sampled-key-to-digital-audio'});
 assert.equal(log.measurements.length,2);assert.equal(log.droppedMeasurements,1);
 assert.deepEqual(log.summary(),{count:2,min:0.02,max:0.03,average:0.025});
 const exported=log.exportJSON();assert.ok(!/secret-user|secret-pass|secret.example/.test(exported));
 assert.equal(JSON.parse(exported).scope,'sampled-key-to-digital-audio');
 log.clear();assert.equal(log.entries.length,0);assert.equal(log.measurements.length,0);assert.equal(log.summary().count,0);
});
