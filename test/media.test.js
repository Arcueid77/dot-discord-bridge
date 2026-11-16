import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createProvider} from '../src/provider.js';
import {channel} from '../src/channel.js';
import {createHash} from 'node:crypto';

test('revoked authorization blocks media and text before their final provider request',async t=>{
  const fx=await fixture(t),before=fx.calls.length,authorize=()=>{throw new Error('fixture revoked');};
  await assert.rejects(fx.provider.sendMediaReply({message:fx.message,media:{type:'file',mimeType:'application/pdf',name:'a.pdf',data:Buffer.from('A')},idempotencyKey:'key',authorize}),/revoked/);
  await assert.rejects(fx.provider.sendReply({message:fx.message,text:'A reply',idempotencyKey:'key',authorize}),/revoked/);
  assert.equal(fx.calls.length,before);
});

const credentials={botToken:'synthetic.bot.token.abcdefghijklmnop',ownerId:'1000',conversationId:'2000'};
const response=value=>new Response(JSON.stringify(value));
const suspended=signal=>new Promise((_,reject)=>signal.aborted?reject(new Error('abort')):signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));
async function until(condition){for(let i=0;i<500;i++){if(condition())return;await delay(2);}assert.fail('condition timed out');}
async function fixture(t,options={}){
  let socket, received;
  const calls=[],values=new Map();
  const attachments=[
    {id:'4000',filename:'a.png',content_type:'image/png',size:4},
    {id:'4001',filename:'voice.ogg',content_type:'audio/ogg',size:4},
    {id:'4002',filename:'report.pdf',content_type:'application/pdf',size:4}
  ];
  const original={id:'3000',channel_id:'2000',type:0,author:{id:'1000',bot:false},content:'',attachments,...options.message};
  class Socket extends EventTarget{
    constructor(){super();socket=this;this.readyState=1;}
    send(){}
    frame(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
    close(){this.readyState=3;const event=new Event('close');Object.defineProperty(event,'code',{value:1000});queueMicrotask(()=>this.dispatchEvent(event));}
  }
  const fetch=async(url,init)=>{
    calls.push({url,init});assert.equal(init.redirect,'error');
    const parsed=new URL(url),path=parsed.pathname;
    if(['cdn.discordapp.com','media.discordapp.net'].includes(parsed.hostname)){
      assert.equal(init.headers,undefined);
      return options.download?options.download(url,init):new Response('DATA',{headers:{'content-type':'application/octet-stream'}});
    }
    assert.equal(parsed.origin,'https://discord.com');
    assert.equal(init.headers.authorization,'Bot '+credentials.botToken);
    if(path==='/api/v10/users/@me')return response({id:'9000',bot:true});
    if(path==='/api/v10/channels/2000')return response({id:'2000',type:1,recipients:[{id:'1000',bot:false}]});
    if(path==='/api/v10/gateway/bot')return response({url:'wss://gateway.discord.gg'});
    if(path==='/api/v10/channels/2000/messages/3000')return response(options.current??{...original,attachments:attachments.map(a=>({...a,url:`https://cdn.discordapp.com/attachments/2000/${a.id}/${a.filename}?ex=ffffffff&is=1234&hm=abcd`}))});
    if(path==='/api/v10/channels/2000/messages')return options.send?options.send(init):response({id:'8000',channel_id:'2000'});
    throw new Error('Unexpected synthetic endpoint');
  };
  const provider=createProvider({credentials,nativeVoice:options.nativeVoice===true,fetch,WebSocket:Socket,random:()=>1,state:{get:k=>values.get(k),set:(k,v)=>values.set(k,v),delete:k=>values.delete(k)},onMessage:async m=>{received=m;}});
  t.after(()=>provider.stop());await provider.start();
  socket.frame({op:10,d:{heartbeat_interval:10000}});
  socket.frame({op:0,t:'READY',s:1,d:{session_id:'test-session',resume_gateway_url:'wss://gateway.discord.gg',user:{id:'9000',bot:true}}});
  socket.frame({op:0,t:'MESSAGE_CREATE',s:2,d:original});
  await until(()=>received);
  return {provider,message:received,calls,original};
}

test('long answers use a single UTF-8 file reply with the same nonce and original message reference',async t=>{
  const fx=await fixture(t);
  const text='汉'.repeat(19998)+'🌏';
  await fx.provider.sendReply({message:fx.message,text,idempotencyKey:'long'});
  const call=fx.calls.at(-1),form=call.init.body;
  assert.ok(form instanceof FormData);
  assert.equal(await form.get('files[0]').text(),text);
  const body=JSON.parse(form.get('payload_json'));
  assert.deepEqual(body.attachments,[{id:0,filename:'answer.txt'}]);
  assert.equal(body.message_reference.message_id,'3000');
  assert.equal(body.enforce_nonce,true);
  const count=fx.calls.length;
  await assert.rejects(fx.provider.sendReply({message:fx.message,text:'x\uD800',idempotencyKey:'invalid'}));
  await assert.rejects(fx.provider.sendReply({message:fx.message,text:'x'.repeat(20001),idempotencyKey:'large'}));
  assert.equal(fx.calls.length,count);
});

test('reads each attachment via refreshed original-message URL with no CDN credentials',async t=>{
  const fx=await fixture(t);
  assert.deepEqual(channel.media,{read:['image','audio','file','video','sticker'],reply:['image','audio','file','video','sticker']});
  assert.equal(JSON.stringify(fx.message.attachments).includes('4000'),false);
  assert.deepEqual(fx.message.replyContext.attachments.map(a=>a.id),['4000','4001','4002']);
  for(let i=0;i<3;i++)assert.deepEqual((await fx.provider.readAttachment({message:fx.message,attachmentIndex:i})).data,Buffer.from('DATA'));
  assert.equal(fx.calls.filter(c=>c.url.endsWith('/messages/3000')).length,3);
  assert.equal(fx.calls.filter(c=>c.url.includes('cdn.discordapp.com')).length,3);
});

test('an uncertain long-answer file POST never retries or switches to a native text message',async t=>{
  const fx=await fixture(t,{send:async()=>{throw new Error('private uncertain result');}});
  await assert.rejects(fx.provider.sendReply({message:fx.message,text:'汉'.repeat(2001),idempotencyKey:'long'}));
  const sends=fx.calls.filter(call=>call.url.endsWith('/channels/2000/messages'));
  assert.equal(sends.length,1);
  assert.ok(sends[0].init.body instanceof FormData);
});

test('uploads all media kinds as bytes with bound reply reference and stable nonce',async t=>{
  const fx=await fixture(t);
  for(const [type,mimeType]of [['image','image/png'],['audio','audio/ogg'],['file','application/pdf']]){
    assert.deepEqual(await fx.provider.sendMediaReply({message:fx.message,media:{type,mimeType,name:'example.bin',data:Buffer.from('DATA')},text:'caption @everyone',idempotencyKey:'fixed'}),{providerMessageId:'8000'});
    const call=fx.calls.at(-1),form=call.init.body;
    assert.ok(form instanceof FormData);assert.equal(call.init.headers['content-type'],undefined);
    const body=JSON.parse(form.get('payload_json'));
    assert.deepEqual(body.allowed_mentions,{parse:[],replied_user:false});
    assert.deepEqual(body.attachments,[{id:0,filename:'example.bin'}]);
    assert.equal(body.message_reference.channel_id,'2000');assert.equal(body.message_reference.message_id,'3000');
    assert.equal(body.nonce.length,24);assert.equal(body.enforce_nonce,true);
    assert.equal(await form.get('files[0]').text(),'DATA');
  }
  const nonces=fx.calls.filter(c=>c.init.body instanceof FormData).map(c=>JSON.parse(c.init.body.get('payload_json')).nonce);
  assert.equal(new Set(nonces).size,1);
});

test('denies changed owner/channel and indexes before HTTP requests',async t=>{
  const fx=await fixture(t);const count=fx.calls.length;
  for(const message of [{...fx.message,senderId:'9999'},{...fx.message,conversationId:'9999'},{...fx.message,replyContext:{messageId:'9999'}}])await assert.rejects(fx.provider.readAttachment({message,attachmentIndex:0}),/binding/);
  for(const attachmentIndex of [-1,0.1,10])await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex}),/unavailable/);
  const message=structuredClone(fx.message);message.replyContext.attachments[0].size=5*1024*1024+1;
  await assert.rejects(fx.provider.readAttachment({message,attachmentIndex:0}),/5 MiB/);
  assert.equal(fx.calls.length,count);
});

test('refresh cannot replace the private source message or attachment identifier',async t=>{
  for(const extra of [{author:{id:'9999'}},{channel_id:'9999'},{guild_id:'9999'},{attachments:[{id:'4999',size:4,url:'https://cdn.discordapp.com/attachments/2000/4999/a.png'}]}]){
    const fx=await fixture(t,{current:{id:'3000',channel_id:'2000',author:{id:'1000'},attachments:[],...extra}});
    await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:0}),/Discord transport failed/);
    assert.equal(fx.calls.filter(c=>c.url.includes('cdn.discordapp.com')).length,0);await fx.provider.stop();
  }
});

test('rejects hostile CDN hosts, cross-channel paths, traversal and unexpected query parameters',async t=>{
  for(const url of ['http://cdn.discordapp.com/attachments/2000/4000/a.png','https://cdn.discordapp.com.evil.invalid/attachments/2000/4000/a.png','https://user@cdn.discordapp.com/attachments/2000/4000/a.png','https://cdn.discordapp.com/attachments/9999/4000/a.png','https://cdn.discordapp.com/attachments/2000/4001/a.png','https://cdn.discordapp.com/attachments/2000/4000/%2e%2e','https://cdn.discordapp.com/attachments/2000/4000/a%2fb.png','https://cdn.discordapp.com/attachments/2000/4000/a.png?redirect=https://evil.invalid']){
    const fx=await fixture(t,{current:{id:'3000',channel_id:'2000',author:{id:'1000'},attachments:[{id:'4000',size:4,url}]}});
    await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:0}),/attachment address/);
    assert.equal(fx.calls.filter(c=>c.url.includes('cdn.discordapp.com')).length,0);await fx.provider.stop();
  }
});

test('blocks CDN redirects, final URL changes and streamed oversize bodies',async t=>{
  for(const download of [
    ()=>{const r=new Response('DATA');Object.defineProperty(r,'redirected',{value:true});return r;},
    ()=>{const r=new Response('DATA');Object.defineProperty(r,'url',{value:'https://evil.invalid/file'});return r;},
    ()=>new Response('DATA',{headers:{'content-length':String(5*1024*1024+1)}}),
    ()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5*1024*1024));c.enqueue(new Uint8Array(1));c.close();}}))
  ]){const fx=await fixture(t,{download});await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:0}),/Discord transport failed/);await fx.provider.stop();}
});

test('validates bytes, names, MIME and caption synchronously before queueing',async t=>{
  const fx=await fixture(t);const base={type:'file',mimeType:'application/pdf',name:'a.pdf',data:Buffer.from('A')};
  for(const media of [{...base,data:'https://evil.invalid/x'},{...base,data:Buffer.alloc(0)},{...base,data:Buffer.alloc(5*1024*1024+1)},{...base,name:'../x'},{...base,name:'a\r\nb'},{...base,mimeType:'text/html\r\nX: y'},{...base,type:'image'},{...base,type:'audio'}])assert.throws(()=>fx.provider.validateMediaReply({media}));
  assert.throws(()=>fx.provider.validateMediaReply({media:base,text:'x'.repeat(2001)}),/2000/);
});

test('uncertain multipart send happens once and stop drains pending upload',async t=>{
  let sending=false;const fx=await fixture(t,{send:init=>{sending=true;return suspended(init.signal);}});
  const pending=assert.rejects(fx.provider.sendMediaReply({message:fx.message,media:{type:'file',mimeType:'application/pdf',name:'file.pdf',data:Buffer.from('A')},idempotencyKey:'fixed'}),/Discord transport failed/);
  await until(()=>sending);await fx.provider.stop();await pending;
  assert.equal(fx.calls.filter(c=>c.init.body instanceof FormData).length,1);
});


test('native Discord voice uses actual checked metadata and never drops a caption',async t=>{
  const fx=await fixture(t,{nativeVoice:true});
  const data=Buffer.concat([Buffer.from('OggS'),Buffer.alloc(24),Buffer.from('OpusHead'),Buffer.alloc(20)]);
  const media={type:'audio',mimeType:'audio/ogg',name:'voice.ogg',data,voice:{durationSeconds:2,waveform:Buffer.alloc(20,80).toString('base64'),sha256:createHash('sha256').update(data).digest('hex')}};
  await fx.provider.sendMediaReply({message:fx.message,media,idempotencyKey:'voice'});
  const payload=JSON.parse(fx.calls.at(-1).init.body.get('payload_json'));
  assert.equal(payload.flags,8192);assert.equal(Object.hasOwn(payload,'content'),false);
  assert.equal(payload.attachments[0].duration_secs,2);
  assert.equal(payload.attachments[0].waveform,media.voice.waveform);
  const count=fx.calls.length;
  await assert.rejects(fx.provider.sendMediaReply({message:fx.message,media:{...media,voice:{...media.voice,sha256:'0'.repeat(64)}},idempotencyKey:'bad'}));
  assert.equal(fx.calls.length,count);
  await fx.provider.sendMediaReply({message:fx.message,media,text:'caption',idempotencyKey:'caption'});
  const regular=JSON.parse(fx.calls.at(-1).init.body.get('payload_json'));
  assert.equal(regular.flags,undefined);assert.equal(regular.content,'caption');
});

test('Discord sticker bytes are refreshed against the original source before a fixed CDN read',async t=>{
  const fx=await fixture(t,{message:{attachments:[],sticker_items:[{id:'5000',format_type:4,name:'sticker'}]}});
  assert.equal(fx.message.attachments[0].kind,'sticker');
  const result=await fx.provider.readAttachment({message:fx.message,attachmentIndex:0});
  assert.equal(result.mimeType,'image/gif');
  assert.equal(fx.calls.at(-1).url,'https://media.discordapp.net/stickers/5000.gif');
  assert.equal(fx.calls.at(-1).init.headers,undefined);
  await fx.provider.sendMediaReply({message:fx.message,media:{type:'sticker',mimeType:'image/gif',name:'sticker.gif',data:result.data},idempotencyKey:'one-sticker'});
  const payload=JSON.parse(fx.calls.at(-1).init.body.get('payload_json'));
  assert.equal(payload.sticker_ids,undefined);assert.equal(payload.attachments.length,1);
});
