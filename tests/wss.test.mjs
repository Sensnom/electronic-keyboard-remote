import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';import net from 'node:net';import https from 'node:https';
import {once} from 'node:events';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import mqtt from 'mqtt';import {WebSocketServer} from 'ws';
import {connectInstrument} from '../mqtt-link.mjs';import {frame} from '../assets/timeline.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('real local WSS with trusted test CA: binary MIDI commit and parameter acknowledgements', {timeout:20000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'piano-wss-'));const port=await freePort();
 const broker=spawn('mosquitto',['-p',String(port)],{stdio:'ignore'});let device,link,server,wss;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',directory+'/key.pem','-out',directory+'/cert.pem','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{stdio:'ignore'});
  const key=await readFile(directory+'/key.pem'),cert=await readFile(directory+'/cert.pem');
  await delay(100);device=await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`,{reconnectPeriod:0});
  await device.subscribeAsync('wss-test/down',{qos:0});const requests=[],settings={1:65535,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0};let count=42,staged=0,stored=false;
  device.on('message',async(_topic,data)=>{
   requests.push(Buffer.from(data));if(data[2]===1)staged=data[7]+256*data[8];if(data[2]===3){stored=true;count=staged;}
   if(data[2]===4)settings[data[6]]=data[7]+256*data[8];
   const value=data[2]===5?0x81ff:(data[2]===4||data[2]===7)?settings[data[6]]:0;
   const ack=frame(128,data[3],new Uint8Array([data[2],0,1,stored?1:0,count&255,count>>8,value&255,value>>8]));
   await device.publishAsync('wss-test/up',ack.subarray(0,4),{qos:0});
   await device.publishAsync('wss-test/up',ack.subarray(4),{qos:0});
  });
  server=https.createServer({key,cert});wss=new WebSocketServer({server,path:'/mqtt'});
  wss.on('connection',socket=>{
   const tcp=net.connect(port,'127.0.0.1');socket.on('message',data=>tcp.write(data));tcp.on('data',data=>{if(socket.readyState===1)socket.send(data);});
   socket.on('close',()=>tcp.destroy());tcp.on('close',()=>socket.close());tcp.on('error',()=>socket.close());
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  link=await connectInstrument({url:`wss://127.0.0.1:${server.address().port}/mqtt`,upTopic:'wss-test/up',downTopic:'wss-test/down',qos:0,ackTimeoutMs:1000},(url,options)=>mqtt.connectAsync(url,{...options,ca:cert}));
  const sent=[];link.client.on('packetsend',packet=>{if(packet.cmd==='publish')sent.push(packet);});
  assert.equal((await link.status()).modules,1);assert.equal((await link.parameter(2,4)).actual,4);
  for(const [id,value]of [[5,1],[6,7],[7,-12],[8,-2],[9,1]])assert.equal((await link.parameter(id,value)).actual,value);
  const values=await link.readParameters();assert.equal(values[7],-12);assert.equal(values[8],-2);assert.equal(values[6],7);
  const song={modules:1,endMs:200,notes:[{start:0,duration:100,note:84,velocity:90,shift:2},{start:100,duration:100,note:0,velocity:90,shift:-5}]};
  const committed=await link.upload(song);assert.equal(committed.stored,true);assert.equal(committed.noteCount,2);
  assert.deepEqual(requests.slice(-4).map(p=>p[2]),[5,1,2,3]);assert.equal(requests.filter(p=>p[2]===7).length,9);assert.ok(sent.length>0&&sent.every(p=>p.qos===0&&!p.retain));
  assert.deepEqual(link.progress,{sent:3,total:3});
 }finally{
  await link?.close();await device?.endAsync();for(const client of wss?.clients||[])client.terminate();
  if(wss)await new Promise(r=>wss.close(r));if(server)await new Promise(r=>server.close(r));
  broker.kill();await once(broker,'exit');await rm(directory,{recursive:true,force:true});
 }
});
