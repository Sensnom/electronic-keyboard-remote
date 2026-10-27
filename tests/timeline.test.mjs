import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTimeline, encodeRecords, decodeRecord, frame, uploadFrames} from '../assets/timeline.mjs';
import {crc16} from '../assets/protocol.mjs';
const vlq=n=>{const a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;};
const be32=n=>[n>>>24,(n>>>16)&255,(n>>>8)&255,n&255];
const chunk=(s,b)=>[...Buffer.from(s),...be32(b.length),...b];
const smf=(tracks,division=480)=>new Uint8Array([...chunk('MThd',[0,tracks.length>1?1:0,0,tracks.length,division>>8,division&255]),...tracks.flatMap(t=>chunk('MTrk',[...t,0,255,47,0]))]);
const on=(delta,n,v=80,ch=0)=>[...vlq(delta),0x90|ch,n,v];
const off=(delta,n,ch=0)=>[...vlq(delta),0x80|ch,n,0];

test('original pitch and each Note Off survive tempo changes and automatic octaves',()=>{
 const raw=smf([[...on(0,84),...on(0,88,90),...off(240,84),0,255,81,3,15,66,64,...off(240,88)]]);
 const song=compileTimeline(raw,{tracks:[0],modules:1});
 assert.equal(song.notes.length,2);
 assert.deepEqual(song.notes.map(n=>[n.start,n.duration,n.note,n.velocity,n.shift]),[[0,250,84,80,2],[0,750,88,90,2]]);
 assert.equal(song.endMs,750);
 assert.deepEqual(decodeRecord(encodeRecords(song.notes).subarray(0,8)),song.notes[0]);
 assert.deepEqual(raw,smf([[...on(0,84),...on(0,88,90),...off(240,84),0,255,81,3,15,66,64,...off(240,88)]]));
});
test('single/dual boards choose one octave window per chord, no folding',()=>{
 const raw=smf([[...on(0,71),...on(0,72),...off(480,71),...off(0,72)]]);
 assert.throws(()=>compileTimeline(raw,{tracks:[0],modules:1}),/和弦|音区/);
 const song=compileTimeline(raw,{tracks:[0],modules:2});
 assert.deepEqual(song.notes.map(n=>n.shift),[0,0]);
});
test('low/high MIDI notes, repeated notes and zero-velocity Note Off',()=>{
 const song=compileTimeline(smf([[...on(0,0),...on(480,0,0),...on(0,127),...off(480,127)]]),{tracks:[0],modules:1});
 assert.deepEqual(song.notes.map(n=>[n.note,n.shift,n.duration]),[[0,-5,500],[127,5,500]]);
 assert.equal(compileTimeline(smf([[...on(0,60),...off(480,60),...on(0,60),...off(480,60)]]),{tracks:[0],modules:1}).notes.length,2);
});
test('reject missing releases, ambiguous overlapping retriggers and bad selections',()=>{
 assert.throws(()=>compileTimeline(smf([[...on(0,60)]]),{tracks:[0],modules:1}),/松开|Note Off/);
 assert.throws(()=>compileTimeline(smf([[...on(0,60),...on(20,60),...off(20,60),...off(20,60)]]),{tracks:[0],modules:1}),/重叠/);
 assert.throws(()=>compileTimeline(smf([[...on(0,60),...off(480,60)]]),{tracks:[],modules:1}),/轨道/);
});
test('selected melodic tracks only, speed scaling, exact byte/CRC framing',()=>{
 const song=compileTimeline(smf([[...on(0,60),...off(480,60)],[...on(0,36,90,9),...off(480,36,9)]]),{tracks:[0],modules:2,speed:50});
 assert.equal(song.notes[0].duration,1000);
 const records=encodeRecords(song.notes),packets=uploadFrames(song,254);
 assert.equal(packets.length,3);assert.equal(packets[2][3],0);
 assert.deepEqual([...packets[0].subarray(0,4)],[165,90,1,254]);
 const p=frame(5,42,new Uint8Array());
 assert.equal(p[6]|p[7]<<8,crc16(p.subarray(2,6)));
 assert.equal(records.length,8);
});

test('range changes must not reuse a physical key while its earlier note is held',()=>{
 const raw=smf([[...on(0,60),...on(240,84),...off(240,60),...off(240,84)]]);
 assert.throws(()=>compileTimeline(raw,{tracks:[0],modules:1}),/长音|同一琴键/);
 const song=compileTimeline(raw,{tracks:[0],modules:2});
 assert.equal(song.notes[0].shift,0);assert.equal(song.notes[1].shift,1);
});

test('practice speed accepts every integer from 10 to 300 without changing pitch or tracks',()=>{
 const raw=smf([[...on(0,60),...off(480,60),...on(0,60),...off(480,60)],
  [...on(0,67),...off(480,67)]]);
 for(const speed of [10,11,25,50,75,100,150,200,299,300]){
  const song=compileTimeline(raw,{tracks:[0],modules:1,speed});
  const end=Math.round(100000/speed),firstEnd=Math.round(50000/speed);
  assert.deepEqual(song.notes.map(n=>[n.start,n.duration,n.note]),[[0,firstEnd,60],[firstEnd,end-firstEnd,60]]);
  assert.equal(song.endMs,end);
 }
 for(const speed of [0,9,301,100.5,NaN,Infinity,'100'])
  assert.throws(()=>compileTimeline(raw,{tracks:[0],modules:1,speed}),/10.*300/);
 assert.deepEqual(compileTimeline(raw,{tracks:[1],modules:1,speed:10}).notes.map(n=>n.note),[67]);
});

test('extreme speed preserves tempo segments and refuses duration overflow or zero quantization',()=>{
 const changing=smf([[...on(0,60),...vlq(240),255,81,3,15,66,64,...off(240,60)]]);
 assert.equal(compileTimeline(changing,{tracks:[0],modules:1,speed:10}).notes[0].duration,7500);
 assert.equal(compileTimeline(changing,{tracks:[0],modules:1,speed:300}).notes[0].duration,250);
 assert.throws(()=>compileTimeline(smf([[...on(0,60),...off(9600,60)]]),{tracks:[0],modules:1,speed:10}),/时长|时间/);
 assert.throws(()=>compileTimeline(smf([[...on(0,60),...off(1,60)]],32767),{tracks:[0],modules:1,speed:300}),/时长|时间/);
});

test('long-song capacity must be negotiated;32768 records preserve offsets beyond256',()=>{
 const notes=Array.from({length:32768},(_,i)=>({start:i*10,duration:10,note:60,velocity:80,shift:0}));
 const song={version:1,modules:1,endMs:327680,notes};
 assert.throws(()=>uploadFrames(song),/256/);
 const packets=uploadFrames(song,250,{maxNotes:32768});
 assert.equal(packets[0][7]|packets[0][8]<<8,32768);
 const lastData=packets.at(-2),offset=lastData[6]|lastData[7]<<8;
 assert.equal(offset,32767);
 assert.equal(decodeRecord(lastData.subarray(8,16)).start,327670);
 const track=[];for(let i=0;i<257;i++)track.push(...on(0,60),...off(10,60));
 const raw=smf([track]);assert.throws(()=>compileTimeline(raw,{tracks:[0],modules:1}),/256/);
 assert.equal(compileTimeline(raw,{tracks:[0],modules:1,maxNotes:32768}).notes.length,257);
});

test('explicit overflow truncation keeps complete onset groups and full note lifetimes',()=>{
 const raw=smf([[...on(0,60),...off(960,60),...on(0,62),...on(0,65),...off(480,62),...off(0,65),...on(0,67),...off(480,67)]]);
 const original=Uint8Array.from(raw);
 const song=compileTimeline(raw,{tracks:[0],modules:1,maxNotes:2,truncate:true});
 assert.equal(song.notes.length,1);assert.equal(song.notes[0].duration,1000);assert.equal(song.endMs,1000);
 assert.deepEqual(song.truncation,{truncated:true,originalNoteCount:4,retainedNoteCount:1,maxNotes:2});
 assert.deepEqual(raw,original);
 const packets=uploadFrames(song,0,{maxNotes:2});assert.equal(packets[0][7],1);
 assert.throws(()=>compileTimeline(raw,{tracks:[0],modules:1,maxNotes:2}),/2/);
 const chord=smf([[...on(0,60),...on(0,64),...off(480,60),...off(0,64)]]);
 assert.throws(()=>compileTimeline(chord,{tracks:[0],modules:1,maxNotes:1,truncate:true}),/和弦|容量/);
});
test('2048-note RAM prefix and exact-capacity songs report truncation accurately',()=>{
 const track=[];for(let i=0;i<2050;i++)track.push(...on(0,60),...off(10,60));
 const song=compileTimeline(smf([track]),{tracks:[0],modules:1,maxNotes:2048,truncate:true});
 assert.equal(song.notes.length,2048);assert.equal(song.truncation.originalNoteCount,2050);assert.equal(song.truncation.truncated,true);
 const exact=compileTimeline(smf([[...on(0,60),...off(480,60)]]),{tracks:[0],modules:1,maxNotes:1,truncate:true});
 assert.equal(exact.truncation.truncated,false);assert.equal(exact.notes.length,1);
});
