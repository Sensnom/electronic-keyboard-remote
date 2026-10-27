import {parseMidi} from './midi.mjs';
import {crc16} from './protocol.mjs';

function compileSelection(raw, {tracks, speed=100, maxNotes=32768,truncate=false}={}) {
  if(!Number.isInteger(maxNotes)||maxNotes<1||maxNotes>32768)throw Error('设备曲目容量无效');
  if (!Number.isInteger(speed) || speed<10 || speed>300) throw new Error('速度须为10～300%的整数');
  const midi=parseMidi(raw);
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('请显式选择旋律轨道');
  const selected=[...new Set(tracks)].flatMap(i=>{
    if (!Number.isInteger(i)||!midi.tracks[i]) throw new Error('轨道编号无效');
    return midi.tracks[i].notes;
  });
  if (!selected.length || (!truncate&&selected.length>maxNotes)) throw new Error(`练习须包含1～${maxNotes}个音符`);
  const tempos=[...midi.tempos].sort((a,b)=>a.tick-b.tick);
  for (let i=1;i<tempos.length;i++) if(tempos[i].tick===tempos[i-1].tick&&tempos[i].us!==tempos[i-1].us)
    throw new Error('同一时刻存在冲突速度事件');
  const segments=[{tick:0,us:500000,elapsed:0}];
  for(const t of tempos){
    const previous=segments.at(-1);
    if(t.tick===previous.tick)previous.us=t.us;
    else segments.push({...t,elapsed:previous.elapsed+(t.tick-previous.tick)*previous.us/midi.division});
  }
  const milliseconds=tick=>{
    let lo=0,hi=segments.length;
    while(lo+1<hi){const mid=(lo+hi)>>>1;if(segments[mid].tick<=tick)lo=mid;else hi=mid;}
    const t=segments[lo];
    return Math.round((t.elapsed+(tick-t.tick)*t.us/midi.division)/1000*100/speed);
  };
  let notes=selected.map(n=>{
    const start=milliseconds(n.tick),duration=n.endTick===null?null:milliseconds(n.endTick)-start;
    return {start,duration,note:n.note,velocity:n.velocity,shift:0,source:n};
  }).sort((a,b)=>a.start-b.start||a.note-b.note);
  if(notes.length>maxNotes){
    let keep=maxNotes;
    while(keep>0&&notes[keep-1].start===notes[keep].start)keep--;
    if(keep===0)throw Error('设备容量不足以保留开头的完整和弦，请选择更少轨道');
    notes=notes.slice(0,keep);
  }
  for(const n of notes){
    if(n.source.overlap)throw new Error('同轨道同音重叠重触，无法确定独立松开时刻');
    if(n.duration===null)throw new Error('存在缺少松开 Note Off 的音符');
    const {start,duration}=n;
    if(duration<1||duration>65535||start<0||start+duration>0xffffff-2000)
      throw new Error('音符时长或曲目时间超出范围');
    delete n.source;
  }
  return {notes,truncation:{truncated:notes.length<selected.length,originalNoteCount:selected.length,retainedNoteCount:notes.length,maxNotes}};
}

export function compileMidiNotes(raw,options){return compileSelection(raw,options).notes;}

export function compileTimeline(raw, {tracks, modules=2, speed=100, maxNotes=256,truncate=false}={}) {
  if (![1,2].includes(modules)) throw new Error('键盘数量须为1或2');
  const {notes,truncation}=compileSelection(raw,{tracks,speed,maxNotes,truncate});
  let previous=0,held=[];
  for(let i=0;i<notes.length;){
    let j=i+1;while(j<notes.length&&notes[j].start===notes[i].start)j++;
    const group=notes.slice(i,j),lo=Math.min(...group.map(n=>n.note)),hi=Math.max(...group.map(n=>n.note));
    if(new Set(group.map(n=>n.note)).size!==group.length)throw new Error('同起点存在重复音高，请选择不重复的轨道');
    const candidates=Array.from({length:11},(_,n)=>n-5).filter(s=>lo>=60+12*s&&hi<60+12*s+12*modules);
    if(!candidates.length)throw new Error('同一和弦无法映射到当前键盘音区，请换轨道或使用双板');
    held=held.filter(n=>n.start+n.duration>group[0].start);
    const playable=candidates.filter(s=>group.every(n=>held.every(h=>n.note-12*s!==h.note-12*h.shift)));
    if(!playable.length)throw new Error('换八度后与尚未结束的长音占用同一琴键，请换轨道或使用双板');
    playable.sort((a,b)=>Math.abs(a-previous)-Math.abs(b-previous)||Math.abs(a)-Math.abs(b));
    previous=playable[0];for(const n of group)n.shift=previous;
    held.push(...group);
    i=j;
  }
  return {version:1,modules,endMs:notes.reduce((end,n)=>Math.max(end,n.start+n.duration),0),notes,...(truncate?{truncation}:{})};
}

export function encodeRecords(notes) {
  const bytes=new Uint8Array(notes.length*8);
  notes.forEach((n,i)=>{
    let word=(BigInt(n.start)<<40n)|(BigInt(n.duration)<<24n)|(BigInt(n.note)<<17n)|
      (BigInt(n.velocity)<<10n)|(BigInt(n.shift&15)<<6n);
    for(let j=7;j>=0;j--){bytes[i*8+j]=Number(word&255n);word>>=8n;}
  });return bytes;
}
export function decodeRecord(bytes){
  let w=0n;for(const b of bytes)w=(w<<8n)|BigInt(b);
  const s=Number((w>>6n)&15n);
  return {start:Number(w>>40n),duration:Number((w>>24n)&65535n),note:Number((w>>17n)&127n),
    velocity:Number((w>>10n)&127n),shift:s>=8?s-16:s};
}
export function frame(type,seq,payload=new Uint8Array()){
  if(payload.length>64)throw new Error('串口帧负载超限');
  const b=new Uint8Array(payload.length+8);b.set([165,90,type,seq&255,payload.length&255,payload.length>>8]);
  b.set(payload,6);const crc=crc16(b.subarray(2,-2));b[b.length-2]=crc&255;b[b.length-1]=crc>>8;return b;
}
export function uploadFrames(song,firstSeq=0,{maxNotes=256}={}){
  validateTimeline(song,{maxNotes});
  const bytes=encodeRecords(song.notes),crc=crc16(bytes),n=song.notes.length,end=song.endMs;
  const packets=[frame(1,firstSeq++,new Uint8Array([song.modules,n&255,n>>8,end&255,(end>>8)&255,end>>16,crc&255,crc>>8]))];
  for(let i=0;i<n;i+=7){const part=bytes.subarray(i*8,Math.min(n,i+7)*8),p=new Uint8Array(part.length+2);
    p.set([i&255,i>>8]);p.set(part,2);packets.push(frame(2,firstSeq++,p));}
  packets.push(frame(3,firstSeq++));return packets;
}
export function validateTimeline(song,{maxNotes=256}={}){
  if(!Number.isInteger(maxNotes)||maxNotes<1||maxNotes>32768)throw Error('设备曲目容量无效');
  if(!song||![1,2].includes(song.modules)||!Array.isArray(song.notes)||song.notes.length<1||song.notes.length>maxNotes)
    throw Error(`曲目需为1～${maxNotes}个音符及实际键盘数量`);
  let last=-1,shift=0,mask=0,maxEnd=0,held=[];
  for(const n of song.notes){
    if(!['start','duration','note','velocity','shift'].every(k=>Number.isSafeInteger(n[k]))||
      n.start<0||n.start<last||n.duration<1||n.duration>65535||n.note<0||n.note>127||n.velocity<1||n.velocity>127||n.shift< -5||n.shift>5)
      throw Error('音符记录范围或时间顺序无效');
    const key=n.note-60-12*n.shift;
    if(key<0||key>=12*song.modules)throw Error('音符超出映射键盘范围');
    if(n.start!==last){mask=0;shift=n.shift;}
    if(n.shift!==shift||(mask&(1<<key)))throw Error('同起点和弦音区或重复音符错误');
    held=held.filter(h=>h.start+h.duration>n.start);
    if(held.some(h=>n.note-12*n.shift===h.note-12*h.shift))throw Error('长音与后续音符占用同一琴键');
    held.push(n);
    mask|=1<<key;last=n.start;maxEnd=Math.max(maxEnd,n.start+n.duration);
  }
  if(song.endMs!==maxEnd||maxEnd>0xffffff-2000)throw Error('曲目结束时间错误');
  return song;
}
