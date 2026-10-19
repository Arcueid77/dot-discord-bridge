import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import WebSocketClient,{WebSocketServer} from 'ws';
import {createProvider} from '../src/provider.js';

const credentials={botToken:'synthetic.bot.token.abcdefghijklmnop',ownerId:'1000',conversationId:'2000'};
function memory() { const data=new Map(); return {get:k=>data.get(k),set:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k)}; }
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function until(condition) { for(let i=0;i<500;i++){if(condition())return;await delay(5);}assert.fail('condition timed out'); }
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; }
function suspended(signal) { return new Promise((_,reject)=>{if(signal.aborted)reject(new Error('aborted'));else signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}); }

function fixture(options={}) {
  const sockets=[];
  const calls=[];
  class Socket extends EventTarget {
    constructor(url,transportOptions){super();this.url=url;this.transportOptions=transportOptions;this.readyState=1;this.sent=[];this.terminations=0;sockets.push(this);}
    send(value){this.sent.push(JSON.parse(value));}
    frame(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
    emitClose(code){this.readyState=3;queueMicrotask(()=>{const event=new Event('close');Object.defineProperty(event,'code',{value:code});this.dispatchEvent(event);});}
    close(code=1006){if(this.readyState===3)return;if(options.ignoreClose){this.readyState=2;return;}this.emitClose(code);}
    terminate(){this.terminations++;if(this.readyState!==3)this.emitClose(1006);}
  }
  const fetch=async(url,init)=>{
    assert.equal(new URL(url).origin,'https://discord.com');
    assert.equal(init.redirect,'error');
    const path=new URL(url).pathname;
    const body=init.body?JSON.parse(init.body):undefined;
    calls.push({path,body});
    if(path==='/api/v10/users/@me')return response({id:'9000',bot:true});
    if(path==='/api/v10/channels/2000')return response(options.channel??{id:'2000',type:1,recipients:[{id:'1000',bot:false}]});
    if(path==='/api/v10/gateway/bot')return response(options.gateway??{url:'wss://gateway.discord.gg'});
    if(path==='/api/v10/channels/2000/messages')return options.send?options.send(body,init.signal):response({id:'8000',channel_id:'2000'});
    throw new Error('unexpected endpoint');
  };
  return {WebSocket:Socket,fetch,sockets,calls};
}

function ready(socket){
  socket.frame({op:10,d:{heartbeat_interval:10000}});
  socket.frame({op:0,t:'READY',s:1,d:{session_id:'session-one',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg',user:{id:'9000',bot:true}}});
}
const message=(id='3000',text='hello')=>({id,channel_id:'2000',type:0,author:{id:'1000',bot:false},content:text,timestamp:'2026-10-19T00:00:00Z',attachments:[]});

test('checks private channel and identifies with direct-message intent only',async t=>{
  const fx=fixture();
  const state=memory();
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async()=>{}});
  t.after(()=>provider.stop());
  await provider.start();
  assert.equal(provider.status().connected,false);
  assert.equal(fx.sockets[0].url,'wss://gateway.discord.gg/?v=10&encoding=json');
  assert.deepEqual(fx.sockets[0].transportOptions,{followRedirects:false,maxPayload:1024*1024,handshakeTimeout:15000,perMessageDeflate:false,rejectUnauthorized:true});
  ready(fx.sockets[0]);
  await until(()=>provider.status().connected&&fx.sockets[0].sent.some(f=>f.op===2));
  assert.equal(fx.sockets[0].sent.find(f=>f.op===2).d.intents,4096);
  assert.equal(state.get('gatewaySession').sequence,1);
  assert.deepEqual(fx.calls.map(c=>c.path),['/api/v10/users/@me','/api/v10/channels/2000','/api/v10/gateway/bot']);
});

test('waits for ingestion before durable sequence; filters guild, bot and non-owner events',async t=>{
  const fx=fixture();
  const state=memory();
  const gate=deferred();
  const seen=[];
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async m=>{seen.push(m);await gate.promise;}});
  t.after(()=>provider.stop());
  await provider.start();
  const ws=fx.sockets[0];ready(ws);
  await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message()});
  ws.frame({op:0,t:'MESSAGE_CREATE',s:3,d:{...message('3001'),guild_id:'5000'}});
  ws.frame({op:0,t:'MESSAGE_CREATE',s:4,d:{...message('3002'),author:{id:'1000',bot:true}}});
  ws.frame({op:0,t:'MESSAGE_CREATE',s:5,d:{...message('3003'),author:{id:'1001',bot:false}}});
  await until(()=>seen.length===1);
  assert.equal(state.get('gatewaySession').sequence,1);
  gate.resolve();
  await until(()=>state.get('gatewaySession').sequence===5);
  assert.equal(seen.length,1);
});

test('failed ingestion reconnects/resumes from last committed sequence without skipping later frames',async t=>{
  const fx=fixture();
  const state=memory();
  let attempts=0;
  const provider=createProvider({...fx,credentials,state,random:()=>0,onMessage:async()=>{attempts++;throw new Error('synthetic secret');}});
  t.after(()=>provider.stop());
  await provider.start();ready(fx.sockets[0]);
  await until(()=>provider.status().connected);
  fx.sockets[0].frame({op:0,t:'MESSAGE_CREATE',s:2,d:message()});
  fx.sockets[0].frame({op:0,t:'MESSAGE_CREATE',s:3,d:message('3001')});
  await until(()=>fx.sockets.length===2);
  assert.equal(attempts,1);
  assert.equal(state.get('gatewaySession').sequence,1);
  assert.equal(fx.sockets[1].url,'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
  fx.sockets[1].frame({op:10,d:{heartbeat_interval:10000}});
  assert.deepEqual(fx.sockets[1].sent.find(f=>f.op===6).d,{token:credentials.botToken,session_id:'session-one',seq:1});
});

test('heartbeat requests/ACKs are processed while ingestion is pending',async t=>{
  const fx=fixture();
  const gate=deferred();
  let entered=false;
  const provider=createProvider({...fx,credentials,state:memory(),random:()=>1,onMessage:async()=>{entered=true;await gate.promise;}});
  t.after(()=>provider.stop());
  await provider.start();const ws=fx.sockets[0];ready(ws);
  await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message()});
  await until(()=>entered);
  ws.frame({op:1,d:null});
  assert.equal(ws.sent.find(f=>f.op===1).d,2);
  ws.frame({op:11,d:null});
  gate.resolve();
});

test('missing heartbeat ACK closes connection and stop aborts reconnect wait',async t=>{
  const fx=fixture();
  const provider=createProvider({...fx,credentials,state:memory(),random:()=>0,onMessage:async()=>{}});
  t.after(()=>provider.stop());
  await provider.start();const ws=fx.sockets[0];
  ws.frame({op:10,d:{heartbeat_interval:15}});
  await until(()=>ws.sent.some(f=>f.op===1));
  await until(()=>ws.readyState===3);
  assert.equal(ws.sent.filter(f=>f.op===1).length,1);
  await provider.stop();
  assert.equal(fx.sockets.length,1);
});

test('fatal gateway authentication close blocks reconnect and clears session',async t=>{
  const fx=fixture();
  const state=memory();
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async()=>{}});
  t.after(()=>provider.stop());
  await provider.start();ready(fx.sockets[0]);await until(()=>provider.status().connected);
  fx.sockets[0].close(4014);
  await until(()=>provider.status().blocked);
  assert.equal(state.get('gatewaySession'),undefined);
  assert.deepEqual(provider.status(),{connected:false,running:false,blocked:true});
});

test('resumes persisted session after restart and stores attachment metadata without CDN URLs',async t=>{
  const fx=fixture();
  const state=memory();
  state.set('gatewaySession',{sessionId:'prior-session',gatewayUrl:'wss://gateway-us-east1-b.discord.gg',sequence:20,botId:'9000',ownerId:'1000',conversationId:'2000'});
  const seen=[];
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async m=>seen.push(m)});
  t.after(()=>provider.stop());
  await provider.start();const ws=fx.sockets[0];
  ws.frame({op:10,d:{heartbeat_interval:10000}});
  assert.equal(ws.sent.find(f=>f.op===6).d.seq,20);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:21,d:{...message(),content:'',attachments:[{filename:'voice.ogg',content_type:'audio/ogg',url:'https://cdn.discordapp.com/private'}]}});
  ws.frame({op:0,t:'RESUMED',s:22,d:{}});
  await until(()=>provider.status().connected);
  assert.equal(state.get('gatewaySession').sequence,22);
  assert.deepEqual(seen[0].attachments,[{kind:'audio',mimeType:'audio/ogg',name:'voice.ogg'}]);
  assert.equal(JSON.stringify(seen).includes('cdn.discordapp.com'),false);
});

test('reply fixes channel, disables mentions and maps stable idempotency to nonce',async t=>{
  const fx=fixture();
  let received;
  const provider=createProvider({...fx,credentials,state:memory(),random:()=>1,onMessage:async m=>{received=m;}});
  t.after(()=>provider.stop());
  await provider.start();const ws=fx.sockets[0];ready(ws);await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message()});await until(()=>received);
  const result=await provider.sendReply({message:received,text:'answer @everyone',idempotencyKey:'fixed-key'});
  assert.deepEqual(result,{providerMessageId:'8000'});
  const sent=fx.calls.find(c=>c.body).body;
  assert.equal(sent.nonce.length,24);
  assert.equal(sent.enforce_nonce,true);
  assert.deepEqual(sent.allowed_mentions,{parse:[],replied_user:false});
  assert.equal(sent.message_reference.channel_id,'2000');
  await assert.rejects(provider.sendReply({message:{...received,conversationId:'2001'},text:'answer',idempotencyKey:'fixed-key'}),/binding/);
  await assert.rejects(provider.sendReply({message:received,text:'x'.repeat(2001),idempotencyKey:'fixed-key'}),/2000/);
  assert.equal(fx.calls.filter(c=>c.body).length,1);
});

test('uncertain HTTP send is called once and shutdown aborts/drains it',async t=>{
  let sending=false;
  let received;
  const fx=fixture({send:(body,signal)=>{sending=true;return suspended(signal);}});
  const provider=createProvider({...fx,credentials,state:memory(),random:()=>1,onMessage:async m=>{received=m;}});
  t.after(()=>provider.stop());
  await provider.start();const ws=fx.sockets[0];ready(ws);await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message()});await until(()=>received);
  const rejected=assert.rejects(provider.sendReply({message:received,text:'answer',idempotencyKey:'fixed-key'}),/Discord transport failed/);
  await until(()=>sending);
  await provider.stop();await rejected;
  assert.equal(fx.calls.filter(c=>c.body).length,1);
});

test('invalid binding, hostile gateway, exhausted session quota and overlarge HTTP body fail closed',async()=>{
  for(const options of [
    {channel:{id:'2000',type:3,recipients:[{id:'1000'}]}},
    {channel:{id:'2000',type:1,recipients:[{id:'1001'}]}},
    {gateway:{url:'wss://gateway.discord.gg.evil.invalid'}},
    {gateway:{url:'wss://gateway.discord.gg',session_start_limit:{remaining:0}}}
  ]){
    const fx=fixture(options);const provider=createProvider({...fx,credentials,state:memory(),onMessage:async()=>{}});
    await assert.rejects(provider.start(),/initialization failed/);
    await provider.stop();assert.equal(fx.sockets.length,0);
  }
  const provider=createProvider({credentials,state:memory(),onMessage:async()=>{},fetch:async()=>new Response('x'.repeat(2*1024*1024+1))});
  await assert.rejects(provider.start(),/initialization failed/);await provider.stop();
});

test('stop drains ingestion before returning and preserves only the completed sequence',async()=>{
  const fx=fixture();const state=memory();const gate=deferred();let entered=false;
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async()=>{entered=true;await gate.promise;}});
  await provider.start();const ws=fx.sockets[0];ready(ws);await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message()});await until(()=>entered);
  let stopped=false;const stop=provider.stop().then(()=>{stopped=true;});
  await delay(10);assert.equal(stopped,false);gate.resolve();await stop;
  assert.equal(state.get('gatewaySession').sequence,2);
});

test('stop force-terminates a peer that never completes the close handshake',async()=>{
  const fx=fixture({ignoreClose:true});
  const provider=createProvider({...fx,credentials,state:memory(),random:()=>1,timing:{closeGraceMs:10},onMessage:async()=>{}});
  await provider.start();const ws=fx.sockets[0];ready(ws);await until(()=>provider.status().connected);
  await provider.stop();
  assert.equal(ws.terminations,1);
  assert.equal(ws.readyState,3);
  assert.equal(provider.status().running,false);
  assert.equal(fx.sockets.length,1);
});

test('unsafe optional attachment metadata cannot poison durable ingestion',async t=>{
  const fx=fixture();const state=memory();const seen=[];
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async m=>{
    for(const attachment of m.attachments){
      for(const key of ['name','mimeType'])if(attachment[key]!==undefined){
        assert.notEqual(attachment[key],'');assert.doesNotMatch(attachment[key],/[\u0000-\u001f\u007f]|\p{Surrogate}/u);
      }
    }
    seen.push(m);
  }});
  t.after(()=>provider.stop());await provider.start();const ws=fx.sockets[0];ready(ws);await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:{...message(),attachments:[
    {filename:'',content_type:''},
    {filename:'private\nfilename',content_type:'audio/ogg\r'},
    {filename:'a'.repeat(254)+'😀.ogg',content_type:'audio/ogg'}
  ]}});
  ws.frame({op:0,t:'MESSAGE_CREATE',s:3,d:message('3001','Next message')});
  await until(()=>state.get('gatewaySession').sequence===3);
  assert.equal(seen.length,2);
  assert.deepEqual(seen[0].attachments.slice(0,2),[{kind:'file'},{kind:'file'}]);
  assert.equal(seen[0].attachments[2].name,'a'.repeat(254));
});

test('unsupported invalid text does not permanently block the durable sequence',async t=>{
  const fx=fixture();const state=memory();const seen=[];
  const provider=createProvider({...fx,credentials,state,random:()=>1,onMessage:async m=>seen.push(m)});
  t.after(()=>provider.stop());await provider.start();const ws=fx.sockets[0];ready(ws);await until(()=>provider.status().connected);
  ws.frame({op:0,t:'MESSAGE_CREATE',s:2,d:message('3000','Unsupported\u0000text')});
  ws.frame({op:0,t:'MESSAGE_CREATE',s:3,d:message('3001','Valid next message\nwith a line break')});
  await until(()=>state.get('gatewaySession').sequence===3);
  assert.equal(seen.length,1);assert.equal(seen[0].id,'3001');
});

test('real ws parser rejects an over-limit wire message before application dispatch',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:false});
  await once(server,'listening');
  const wireClients=[];
  const closes=[];
  const transportErrors=[];
  class LocalSocket extends WebSocketClient{
    constructor(_officialUrl,options){
      super(`ws://127.0.0.1:${server.address().port}`,options);
      wireClients.push(this);
      this.on('close',code=>closes.push(code));
      this.on('error',error=>transportErrors.push(error.code));
    }
  }
  const fx=fixture();
  const provider=createProvider({...fx,WebSocket:LocalSocket,credentials,state:memory(),onMessage:async()=>assert.fail('oversize payload must not reach ingestion')});
  t.after(async()=>{await provider.stop();for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));});
  server.on('connection',client=>{client.on('error',()=>{});client.send('x'.repeat(1024*1024+1));});
  await provider.start();
  await until(()=>closes.length===1);
  assert.equal(wireClients[0].readyState,3);
  assert.deepEqual(transportErrors,['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']);
});
