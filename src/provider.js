import {createHash} from 'node:crypto';
import WebSocketClient from 'ws';
import {channel} from './channel.js';
import {conversationRoute,interactionPolicy} from '@dot-bridge/core/channels/experience-policy.js';
import {clipText,splitMarkdown} from '@dot-bridge/core/channels/formatting.js';
import {MAX_MEDIA_BYTES as MAX_MEDIA} from '@dot-bridge/core/channels/media.js';

const API = 'https://discord.com/api/v10';
const MAX_BODY = 2 * 1024 * 1024;
const snowflake = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const fail = () => new Error('Discord transport failed.');
const mime = value => typeof value === 'string' && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value) && value.length <= 127;

function validateMediaReply({media, text = ''} = {}) {
  if (!media || !['image', 'audio', 'file'].includes(media.type) || !Buffer.isBuffer(media.data) || media.data.length < 1 || media.data.length > MAX_MEDIA) throw new Error('Discord media must contain 1 byte to 5 MiB.');
  if (!mime(media.mimeType) || typeof media.name !== 'string' || !media.name || media.name.length > 255 || /[\u0000-\u001f\u007f/\\]|\p{Surrogate}/u.test(media.name) || ['.', '..'].includes(media.name)) throw new Error('Discord media name or MIME type is invalid.');
  if (media.type === 'image' && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(media.mimeType)) throw new Error('Discord image replies require JPEG, PNG, GIF or WebP.');
  if (media.type === 'audio' && !['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/flac'].includes(media.mimeType)) throw new Error('Discord audio format is unsupported; send it as a file.');
  if (typeof text !== 'string' || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Surrogate}/u.test(text)) throw new Error('Discord media caption must contain at most 2000 characters.');
}

function attachmentUrl(value, conversationId, attachmentId) {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw fail();
    const url = new URL(value);
    const prefix = `/attachments/${conversationId}/${attachmentId}/`;
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)) throw fail();
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!name || /[/\\\u0000-\u001f\u007f]/u.test(name) || ['.', '..'].includes(name)) throw fail();
    for (const [key, entry] of url.searchParams) if (!['ex', 'is', 'hm'].includes(key) || !/^[a-fA-F0-9]{1,128}$/.test(entry)) throw fail();
    return url.href;
  } catch { throw new Error('Discord attachment address is invalid.'); }
}

function optionalMetadata(value, limit) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]|\p{Surrogate}/u.test(value)) return undefined;
  let clipped = value.slice(0, limit);
  // A UTF-16 bound may land between the two halves of the final emoji.
  if (/\p{Surrogate}$/u.test(clipped)) clipped = clipped.slice(0, -1);
  return clipped || undefined;
}

function gatewayUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw fail();
    url.search = '?v=10&encoding=json';
    return url.href;
  } catch { throw new Error('Discord Gateway address is invalid.'); }
}

async function json(response) {
  if(!response.ok||response.redirected)throw Object.assign(fail(),{rejected:response.status>=400&&response.status<500&&response.status!==429});
  if(response.status===204)return {};
  if(!response.body)throw fail();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) throw fail();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createProvider({credentials, interaction, state, onMessage, onChoice, signal, fetch = globalThis.fetch, WebSocket = WebSocketClient, random = Math.random, timing = {}}) {
  const {botToken, ownerId, conversationId} = credentials ?? {};
  if (typeof botToken !== 'string' || !/^[A-Za-z0-9_.-]{20,256}$/.test(botToken) || !snowflake(ownerId) || !snowflake(conversationId)) throw new Error('Discord credentials require a bot token, owner user ID and private channel ID.');
  const policy=interaction??interactionPolicy({},channel);
  const groups=policy.groups.filter(group=>group.enabled),threadChannels=new Map();
  const gatewayIntents=4096|(groups.length?512:0)|(groups.some(group=>group.autoReply!=='off')?32768:0);
  const controller = new AbortController();
  const requests = new Set();
  let running = false;
  let connected = false;
  let blocked = false;
  let started = false;
  let loop = Promise.resolve();
  let socket;
  let initialGateway;
  let selfId;
  let resume;
  let lastIdentifyAt = 0;
  let remainingIdentifies = Infinity;
  const abort = () => { controller.abort(); socket?.close(4000); };
  signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) controller.abort();

  function request(path, payload, {method,timeout=15000}={}) {
    const task = (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeout);
      timer.unref?.();
      try {
        const response = await fetch(`${API}${path}`, {
          method:method??(payload === undefined ? 'GET' : 'POST'), redirect:'error',
          headers:{authorization:`Bot ${botToken}`, ...(payload instanceof FormData ? {} : {'content-type':'application/json'}), 'user-agent':'DiscordBot (https://github.com/Arcueid77/dot-discord-bridge, 0.1.0)'},
          ...(payload === undefined ? {} : {body:payload instanceof FormData ? payload : JSON.stringify(payload)}),
          signal:AbortSignal.any([controller.signal, deadline.signal])
        });
        return await json(response);
      } catch(error) { throw Object.assign(fail(),{rejected:error?.rejected===true}); }
      finally { clearTimeout(timer); deadline.abort(); }
    })();
    requests.add(task);
    task.then(() => requests.delete(task), () => requests.delete(task));
    return task;
  }

  function binding(message) {
    if(!running||controller.signal.aborted||!conversationRoute({channel,credentials,interaction:policy},message)||!snowflake(message.id)||message.replyContext?.messageId!==message.id)throw new Error('Discord reply binding is invalid.');
    const target=message.replyContext.channelId??message.conversationId;
    if(!snowflake(target)||target!==(message.threadId??message.conversationId))throw new Error('Discord reply binding is invalid.');
    return target;
  }
  function checkedMessage(value,target) {if(!snowflake(value?.id)||value.channel_id!==target)throw fail();return value;}

  function replyPayload(message, idempotencyKey, content) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 1024) throw new Error('Discord reply requires a stable idempotency key.');
    return {content, nonce:createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24), enforce_nonce:true,
      allowed_mentions:{parse:[], replied_user:false},
      message_reference:{message_id:message.id, channel_id:binding(message), fail_if_not_exists:false}};
  }

  function download(url) {
    const task = (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 30000);
      timer.unref?.();
      try {
        // CDN requests never receive the bot token or API authorization headers.
        const response = await fetch(url, {redirect:'error', signal:AbortSignal.any([controller.signal, deadline.signal])});
        if (!response.ok || response.redirected || !response.body || (response.url && response.url !== url)) throw fail();
        const size = response.headers.get('content-length');
        if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_MEDIA)) throw fail();
        const reader = response.body.getReader();
        let length = 0;
        const chunks = [];
        try {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_MEDIA || controller.signal.aborted || deadline.signal.aborted) throw fail();
            chunks.push(Buffer.from(value));
          }
          if (!length) throw fail();
          return {data:Buffer.concat(chunks), mimeType:response.headers.get('content-type')?.split(';')[0]?.trim()};
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch { throw fail(); }
      finally { clearTimeout(timer); deadline.abort(); }
    })();
    requests.add(task);
    task.then(() => requests.delete(task), () => requests.delete(task));
    return task;
  }

  function wait(ms) {
    return new Promise(resolve => {
      if (controller.signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener('abort', done, {once:true});
    });
  }

  function clearSession() { resume = undefined; state.delete('gatewaySession'); }
  function persist(sequence) {
    if (!resume || sequence < resume.sequence) return;
    resume.sequence = sequence;
    state.set('gatewaySession', {...resume, botId:selfId, ownerId, conversationId, intents:gatewayIntents});
  }

  async function ingest(data) {
    if (!data || data.webhook_id || data.author?.bot || data.author?.system || data.author?.id === selfId || !snowflake(data.author?.id) || !snowflake(data.channel_id) || ![0,19].includes(data.type) || !snowflake(data.id))return;
    let sourceConversation=data.channel_id,threadId;
    const chatType=data.guild_id?'group':'private';
    if(chatType==='private'){if(data.author.id!==ownerId||data.channel_id!==conversationId)return;}else{
      if(!snowflake(data.guild_id)||!groups.length)return;
      if(!groups.some(group=>group.conversationId===sourceConversation)){
        let info=threadChannels.get(data.channel_id);if(info===false)return;
        if(!info){try{info=await request('/channels/'+data.channel_id);}catch(error){if(error.rejected){if(threadChannels.size>=1000)threadChannels.clear();threadChannels.set(data.channel_id,false);return;}throw error;}if(info?.id!==data.channel_id||![10,11,12].includes(info.type)||!snowflake(info.parent_id)||info.guild_id!==data.guild_id){if(threadChannels.size>=1000)threadChannels.clear();threadChannels.set(data.channel_id,false);return;}if(threadChannels.size>=1000)threadChannels.clear();threadChannels.set(data.channel_id,info);}
        if(!groups.some(group=>group.conversationId===info.parent_id))return;sourceConversation=info.parent_id;threadId=data.channel_id;
      }
    }
    const text = typeof data.content === 'string' ? data.content : '';
    if (text.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Surrogate}/u.test(text)) return;
    const attachments = Array.isArray(data.attachments) ? data.attachments.slice(0, 10).map(value => {
      const mime = optionalMetadata(value?.content_type, 127);
      const item = {kind:mime?.startsWith('image/') ? 'image' : mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('video/') ? 'video' : 'file'};
      if (mime) item.mimeType = mime;
      const name = optionalMetadata(value?.filename, 255);
      if (name) item.name = name;
      return item;
    }) : [];
    const references = Array.isArray(data.attachments) ? data.attachments.slice(0, 10).map(value => snowflake(value?.id) ? {id:value.id, ...(Number.isSafeInteger(value.size) && value.size >= 0 ? {size:value.size} : {})} : null) : [];
    if (!text && !attachments.length) return;
    const message={id:data.id,senderId:data.author.id,conversationId:sourceConversation,chatType,text,botMentioned:Array.isArray(data.mentions)&&data.mentions.some(user=>user?.id===selfId)||data.referenced_message?.channel_id===data.channel_id&&data.referenced_message?.author?.id===selfId,forwarded:Array.isArray(data.message_snapshots)&&data.message_snapshots.length>0,...(threadId?{threadId}:{}),replyContext:{messageId:data.id,channelId:data.channel_id,...(data.guild_id?{guildId:data.guild_id}:{}),attachments:references},attachments};
    if(!conversationRoute({channel,credentials,interaction:policy},message))return;
    const quoted=data.referenced_message;if(quoted?.channel_id===data.channel_id&&typeof quoted.content==='string'&&quoted.content)message.quote={text:clipText(quoted.content.toWellFormed(),4000),truncated:quoted.content.length>4000};
    const timestamp = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN;
    if (Number.isFinite(timestamp) && timestamp > 0) message.timestamp = timestamp;
    await onMessage(message);
  }

  async function choiceInteraction(data) {
    const user=data?.member?.user??data?.user;
    const token=data?.data?.component_type===3?data.data.values?.[0]:data?.data?.custom_id;
    if(typeof onChoice!=='function'||data?.type!==3||!snowflake(data.id)||!snowflake(user?.id)||user.bot||!snowflake(data.channel_id)||!snowflake(data.message?.id)||data.message.author?.id!==selfId||typeof token!=='string'||!/^db_[A-Za-z0-9_-]{24}$/.test(token)||typeof data.token!=='string'||!/^[A-Za-z0-9_.-]{1,512}$/.test(data.token))return;
    let sourceConversation=data.channel_id,threadId;
    if(data.guild_id&&!groups.some(group=>group.conversationId===sourceConversation)){
      const info=threadChannels.get(data.channel_id)??await request('/channels/'+data.channel_id);
      if(!info||![10,11,12].includes(info.type)||info.guild_id!==data.guild_id||!groups.some(group=>group.conversationId===info.parent_id))return;
      sourceConversation=info.parent_id;threadId=data.channel_id;
    }
    const message={id:data.message.id,senderId:user.id,conversationId:sourceConversation,botMentioned:true,text:'',...(threadId?{threadId}:{}),replyContext:{messageId:data.message.id,channelId:data.channel_id,...(data.guild_id?{guildId:data.guild_id}:{})},attachments:[]};
    const result=await onChoice({token,senderId:user.id,conversationId:sourceConversation,threadId:message.threadId,message});
    await request('/interactions/'+data.id+'/'+encodeURIComponent(data.token)+'/callback',{type:6},{timeout:2500});
    return result;
  }

  function connect() {
    return new Promise(resolve => {
      const ws = new WebSocket(gatewayUrl(resume?.gatewayUrl ?? initialGateway), {
        followRedirects:false, maxPayload:1024 * 1024, handshakeTimeout:15000,
        perMessageDeflate:false, rejectUnauthorized:true
      });
      socket = ws;
      let closed = false;
      let failed = false;
      let hello = false;
      let heartbeat;
      let awaitingAck = false;
      let receivedSequence = resume?.sequence ?? null;
      let queued = 0;
      let dispatch = Promise.resolve();
      let closeTimer;
      let identifyTimer;
      const readyTimer = setTimeout(() => disconnect(), 20000);

      function send(op, d) {
        if (ws.readyState !== 1) throw fail();
        ws.send(JSON.stringify({op, d}));
      }
      function finish() {
        if (closed) return;
        closed = true;
        connected = false;
        clearTimeout(readyTimer);
        clearTimeout(heartbeat);
        clearTimeout(closeTimer);
        clearTimeout(identifyTimer);
        controller.signal.removeEventListener('abort', shutdown);
        ws.removeEventListener('message', receive);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
        if (socket === ws) socket = undefined;
        dispatch.catch(() => {}).then(resolve);
      }
      function disconnect() {
        if (closed) return;
        failed = true;
        connected = false;
        clearTimeout(readyTimer);
        clearTimeout(heartbeat);
        clearTimeout(identifyTimer);
        try { ws.close(4000); } catch { /* Already closed. */ }
        if (!closeTimer) closeTimer = setTimeout(() => {
          // A peer may never acknowledge the closing handshake. The default ws
          // client can destroy its owned connection; do not merely forget it.
          if (typeof ws.terminate === 'function') {
            try { ws.terminate(); } catch { /* An already closed socket is safe. */ }
            if (ws.readyState === 3) finish();
          } else {
            // Compatibility for injected EventTarget fixtures. Production uses
            // the pinned, terminable ws client above.
            finish();
          }
        }, timing.closeGraceMs ?? 5000);
      }
      function shutdown() { disconnect(); }
      function onError() { disconnect(); }
      function onClose(event) {
        try {
          if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
            blocked = true;
            running = false;
            clearSession();
          } else if ([1000, 1001, 4003, 4005, 4007, 4009].includes(event.code)) clearSession();
        } catch { blocked = true; running = false; }
        finally { finish(); }
      }
      function heartbeatNow(force = false) {
        try {
          if (!force && awaitingAck) return disconnect();
          send(1, receivedSequence);
          awaitingAck = true;
        } catch { disconnect(); }
      }
      function scheduleHeartbeat(interval) {
        heartbeat = setTimeout(() => {
          heartbeatNow();
          if (!failed && !closed) scheduleHeartbeat(interval);
        }, interval);
      }
      function receive(event) {
        if (closed || failed) return;
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > 1024 * 1024) throw fail();
          const frame = JSON.parse(event.data);
          if (!Number.isInteger(frame?.op)) throw fail();
          if (frame.op === 10) {
            if (hello || !Number.isSafeInteger(frame.d?.heartbeat_interval) || frame.d.heartbeat_interval <= 0 || frame.d.heartbeat_interval > 300000) throw fail();
            hello = true;
            const interval = frame.d.heartbeat_interval;
            heartbeat = setTimeout(() => { heartbeatNow(); if (!failed && !closed) scheduleHeartbeat(interval); }, Math.floor(Math.max(0, Math.min(1, random())) * interval));
            if (resume) send(6, {token:botToken, session_id:resume.sessionId, seq:resume.sequence});
            else identifyTimer = setTimeout(() => {
              if (closed || failed) return;
              try {
                if (remainingIdentifies <= 0) { blocked = true; running = false; disconnect(); return; }
                remainingIdentifies--;
                lastIdentifyAt = Date.now();
                state.set('gatewayIdentifyAt', lastIdentifyAt);
                send(2, {token:botToken, intents:gatewayIntents, properties:{os:process.platform, browser:'dot-bridge', device:'dot-bridge'}});
              } catch { disconnect(); }
            }, Math.max(0, 5000 - (Date.now() - lastIdentifyAt)));
          } else if (frame.op === 11) awaitingAck = false;
          else if (frame.op === 1) heartbeatNow(true);
          else if (frame.op === 7) disconnect();
          else if (frame.op === 9) { if (frame.d !== true) clearSession(); disconnect(); }
          else if (frame.op === 0) {
            if (!hello || !Number.isSafeInteger(frame.s) || frame.s < 0 || typeof frame.t !== 'string' || ++queued > 256) throw fail();
            receivedSequence = frame.s;
            dispatch = dispatch.then(async () => {
              if (failed || closed) return;
              if (frame.t === 'READY') {
                if (typeof frame.d?.session_id !== 'string' || !frame.d.session_id || frame.d.session_id.length > 512 || frame.d.user?.id !== selfId || frame.d.user?.bot !== true) throw fail();
                gatewayUrl(frame.d.resume_gateway_url);
                resume = {sessionId:frame.d.session_id, gatewayUrl:frame.d.resume_gateway_url, sequence:frame.s};
                connected = true;
                clearTimeout(readyTimer);
              } else if (frame.t === 'RESUMED') {
                if (!resume) throw fail();
                connected = true;
                clearTimeout(readyTimer);
              } else if (frame.t === 'MESSAGE_CREATE') {
                if (!resume) throw fail();
                await ingest(frame.d);
              } else if(frame.t==='INTERACTION_CREATE'){
                if(!resume)throw fail();
                await choiceInteraction(frame.d);
              }
              persist(frame.s);
            }).catch(() => { disconnect(); }).finally(() => { queued--; });
          }
        } catch { disconnect(); }
      }
      ws.addEventListener('message', receive);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
      controller.signal.addEventListener('abort', shutdown, {once:true});
      if (controller.signal.aborted) shutdown();
    });
  }

  async function connections() {
    let backoff = 1000;
    while (running && !controller.signal.aborted) {
      const began = Date.now();
      try { await connect(); } catch { connected = false; }
      if (!running || controller.signal.aborted) break;
      if (Date.now() - began > 60000) backoff = 1000;
      await wait(backoff + Math.floor(Math.max(0, Math.min(1, random())) * 250));
      backoff = Math.min(30000, backoff * 2);
    }
    connected = false;
  }

  const provider = {
    async start() {
      if (started || controller.signal.aborted) throw new Error('Discord provider cannot be started.');
      started = true;
      try {
        const me = await request('/users/@me');
        if (me?.bot !== true || !snowflake(me.id) || me.id === ownerId) throw fail();
        selfId = me.id;
        const channel = await request(`/channels/${conversationId}`);
        if (channel?.id !== conversationId || channel.type !== 1 || !Array.isArray(channel.recipients) || channel.recipients.length !== 1 || channel.recipients[0]?.id !== ownerId || channel.recipients[0]?.bot === true) throw fail();
        const gateway = await request('/gateway/bot');
        gatewayUrl(gateway?.url);
        if (gateway.session_start_limit !== undefined) {
          const remaining = gateway.session_start_limit?.remaining;
          if (!Number.isSafeInteger(remaining) || remaining < 0) throw fail();
          remainingIdentifies = remaining;
        }
        initialGateway = gateway.url;
        const identifiedAt = state.get('gatewayIdentifyAt');
        if (identifiedAt !== undefined) {
          if (!Number.isSafeInteger(identifiedAt) || identifiedAt < 0) throw fail();
          lastIdentifyAt = Math.min(identifiedAt, Date.now());
        }
        const prior = state.get('gatewaySession');
        if (prior !== undefined) {
          if (prior?.botId !== selfId || prior?.ownerId !== ownerId || prior?.conversationId !== conversationId || typeof prior.sessionId !== 'string' || !prior.sessionId || prior.sessionId.length > 512 || !Number.isSafeInteger(prior.sequence) || prior.sequence < 0) throw fail();
          gatewayUrl(prior.gatewayUrl);
          if((prior.intents??4096)===gatewayIntents)resume={...prior};else clearSession();
        }
        if (!resume && remainingIdentifies === 0) throw fail();
        if (controller.signal.aborted) throw fail();
        running = true;
        loop = connections().catch(() => { running = false; connected = false; blocked = true; });
      } catch { blocked = true; throw new Error('Discord initialization failed; verify the bot and bound private channel.'); }
    },
    async stop() {
      running = false;
      connected = false;
      abort();
      signal?.removeEventListener('abort', abort);
      await loop;
      await Promise.allSettled([...requests]);
    },
    status() { return {connected, running, blocked}; },
    async sendOwnerMessage({text, idempotencyKey, authorize}) {
      if (!running || controller.signal.aborted || typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > 2000) throw fail();
      const nonce = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
      authorize();
      const sent = await request(`/channels/${conversationId}/messages`, {content:text, allowed_mentions:{parse:[], users:[], roles:[], replied_user:false}, nonce, enforce_nonce:true});
      if (!snowflake(sent?.id) || sent.channel_id !== conversationId) throw fail();
      return {};
    },
    async setFeedback({message,active,authorize}) {const target=binding(message);authorize();await request('/channels/'+target+'/messages/'+message.id+'/reactions/'+encodeURIComponent('👀')+'/@me',undefined,{method:active?'PUT':'DELETE',timeout:5000});return null;},
    async setTyping({message,active,authorize}) {const target=binding(message);if(!active)return;authorize();await request('/channels/'+target+'/typing',{}, {timeout:5000});},
    canProgressFinal({text}) {return text.length<=channel.nativeMaxReplyText;},
    async sendChoiceReply({message,text,choices,presentation,reference,idempotencyKey,authorize}) {
      const target=binding(message);
      let components;
      if(presentation==='select')components=[{type:1,components:[{type:3,custom_id:'dotbridge_select',min_values:1,max_values:1,placeholder:'选择一个选项',options:choices.map(choice=>({label:choice.label,value:choice.token}))}]}];
      else{
        components=[];
        for(let index=0;index<choices.length;index+=5)components.push({type:1,components:choices.slice(index,index+5).map(choice=>({type:2,style:1,label:choice.label,custom_id:choice.token}))});
      }
      const payload={...replyPayload(message,idempotencyKey,text),components};
      authorize();
      if(reference){
        if(reference.conversationId!==target||!snowflake(reference.id))throw fail();
        checkedMessage(await request('/channels/'+target+'/messages/'+reference.id,{content:text,components,allowed_mentions:{parse:[],replied_user:false}},{method:'PATCH'}),target);
        return reference;
      }
      const sent=checkedMessage(await request('/channels/'+target+'/messages',payload),target);
      return {id:sent.id,conversationId:target};
    },
    async sendProgress({message,text,reference,final=false,idempotencyKey,authorize}) {
      const target=binding(message);if(!final&&text.length>1900)text=clipText(text,1850)+'\n…（完整回答将在完成后发送 / full answer follows）';
      if(text.length>channel.nativeMaxReplyText)throw new Error('Native progress text exceeds its limit');authorize();
      if(reference){if(reference.conversationId!==target||!snowflake(reference.id))throw fail();checkedMessage(await request('/channels/'+target+'/messages/'+reference.id,{content:text,allowed_mentions:{parse:[],replied_user:false}},{method:'PATCH'}),target);return reference;}
      const sent=checkedMessage(await request('/channels/'+target+'/messages',replyPayload(message,idempotencyKey,text)),target);return {id:sent.id,conversationId:target};
    },
    async finishProgress({message,reference,cancelled,authorize}) {if(!cancelled)return;const target=binding(message);if(reference.conversationId!==target||!snowflake(reference.id))throw fail();authorize();await request('/channels/'+target+'/messages/'+reference.id,undefined,{method:'DELETE'});},
    planTextReply(text) {return splitMarkdown(text,1900).map(text=>({text,format:'text'}));},
    async sendTextPart({message,text,idempotencyKey,authorize}) {const target=binding(message);if(text.length>2000)throw fail();authorize();const sent=checkedMessage(await request('/channels/'+target+'/messages',replyPayload(message,idempotencyKey,text)),target);return {providerMessageId:sent.id};},
    validateMediaReply,
    async readAttachment({message, attachmentIndex}) {
      binding(message);
      if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex >= (message.attachments?.length ?? 0) || attachmentIndex >= 10) throw new Error('Discord attachment is unavailable.');
      const ref = message.replyContext.attachments?.[attachmentIndex];
      const item = message.attachments[attachmentIndex];
      if (!snowflake(ref?.id) || !['image', 'audio', 'file'].includes(item.kind) || (ref.size !== undefined && (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_MEDIA))) throw new Error('Discord attachment is unavailable or exceeds 5 MiB.');
      // Refresh this original private message to obtain a current signed CDN URL.
      const target=binding(message);
      const current = await request(`/channels/${target}/messages/${message.id}`);
      if (current?.id !== message.id || current.channel_id !== target || (current.guild_id??null)!==(message.replyContext.guildId??null) || current.webhook_id || current.author?.id !== message.senderId || current.author?.bot || current.author?.system || !Array.isArray(current.attachments)) throw fail();
      const file = current.attachments.find(value => value?.id === ref.id);
      if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_MEDIA) throw fail();
      const result = await download(attachmentUrl(file.url, target, ref.id));
      return {...result, mimeType:mime(result.mimeType) && result.mimeType !== 'application/octet-stream' ? result.mimeType : mime(file.content_type) ? file.content_type : 'application/octet-stream', ...(item.name ? {name:item.name} : {})};
    },
    async sendMediaReply({message, media, text = '', idempotencyKey, authorize = () => {}}) {
      binding(message);
      validateMediaReply({media, text});
      const payload = replyPayload(message, idempotencyKey, text);
      payload.attachments = [{id:0, filename:media.name}];
      const form = new FormData();
      form.set('payload_json', JSON.stringify(payload));
      form.set('files[0]', new Blob([media.data], {type:media.mimeType}), media.name);
      authorize();
      const sent = await request(`/channels/${binding(message)}/messages`, form);
      if (!snowflake(sent?.id) || sent.channel_id !== binding(message)) throw fail();
      return {providerMessageId:sent.id};
    },
    async sendReply({message, text, idempotencyKey, authorize = () => {}}) {
      binding(message);
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > channel.maxReplyText || Buffer.byteLength(text) > 60000) throw new Error('Discord reply must contain 1 to 20,000 characters.');
      if (text.length > channel.nativeMaxReplyText) {
        const data = Buffer.from(text, 'utf8');
        try { return await provider.sendMediaReply({message, media: {type: 'file', data, mimeType: 'text/plain', name: 'answer.txt'}, idempotencyKey, authorize}); }
        finally { data.fill(0); }
      }
      authorize();
      const sent = await request(`/channels/${binding(message)}/messages`, replyPayload(message, idempotencyKey, text));
      if (!snowflake(sent?.id) || sent.channel_id !== binding(message)) throw fail();
      return {providerMessageId:sent.id};
    }
  };
  return provider;
}
