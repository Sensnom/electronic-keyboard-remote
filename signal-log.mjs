export const MEASUREMENT_SCOPE='sampled-key-to-digital-audio';

export class SignalLog{
 constructor({limit=500,measurementLimit=100,byteLimit=512,now=()=>Date.now()}={}){
  if(![limit,measurementLimit,byteLimit].every(value=>Number.isInteger(value)&&value>0))throw Error('日志容量无效');
  Object.assign(this,{limit,measurementLimit,byteLimit,now});
  this.entries=[];this.measurements=[];this.droppedEntries=0;this.droppedMeasurements=0;this.paused=false;this.nextId=1;
 }
 add(event){
  if(this.paused)return null;
  const entry={id:this.nextId++,at:new Date(this.now()).toISOString(),kind:event.kind};
  for(const key of ['sequence','requestType','code','matched','retained'])if(event[key]!==undefined)entry[key]=event[key];
  if(event.message!==undefined)entry.message=String(event.message).slice(0,512);
  if(event.data){
   entry.byteLength=event.data.length;entry.truncated=event.data.length>this.byteLimit;
   entry.hex=Array.from(event.data.slice(0,this.byteLimit),byte=>byte.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  }
  this.entries.push(entry);
  if(this.entries.length>this.limit){this.entries.shift();this.droppedEntries++;}
  return entry;
 }
 addMeasurement(result){
  if(result.state!==3||result.scope!==MEASUREMENT_SCOPE)throw Error('尚无有效设备测量');
  if(!Number.isInteger(result.clockHz)||result.clockHz<=0||result.clockHz>0xffffffff)throw Error('计时时钟无效');
  if(!Number.isInteger(result.cycles)||result.cycles<=0||result.cycles>Math.ceil(result.clockHz/50))throw Error('测量周期无效');
  if(this.paused)return null;
  const entry={at:new Date(this.now()).toISOString(),startCycles:0,endCycles:result.cycles,cycles:result.cycles,
   clockHz:result.clockHz,milliseconds:result.cycles*1000/result.clockHz,scope:MEASUREMENT_SCOPE};
  this.measurements.push(entry);
  if(this.measurements.length>this.measurementLimit){this.measurements.shift();this.droppedMeasurements++;}
  return entry;
 }
 summary(){
  const values=this.measurements.map(x=>x.milliseconds);
  if(!values.length)return {count:0};
  return {count:values.length,min:Math.min(...values),max:Math.max(...values),average:values.reduce((sum,value)=>sum+value,0)/values.length};
 }
 clear(){this.entries=[];this.measurements=[];this.droppedEntries=0;this.droppedMeasurements=0;}
 exportJSON(){return JSON.stringify({format:'electronic-keyboard-latency-log',version:1,exportedAt:new Date(this.now()).toISOString(),
  scope:MEASUREMENT_SCOPE,timeOrigin:'FPGA首次采到测试琴键变化；数字音频字发送完成为终点；at为手机收到报告的时间',
  summary:this.summary(),droppedEntries:this.droppedEntries,droppedMeasurements:this.droppedMeasurements,
  measurements:this.measurements,communication:this.entries},null,2);}
}
