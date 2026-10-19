import {createHash} from 'node:crypto';
import WebSocketClient from 'ws';

const API = 'https://discord.com/api/v10';
const MAX_BODY = 2 * 1024 * 1024;
const snowflake = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const fail = () => new Error('Discord transport failed.');

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
  if (!response.ok || response.redirected || !response.body) throw fail();
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

export function createProvider({credentials, state, onMessage, signal, fetch = globalThis.fetch, WebSocket = WebSocketClient, random = Math.random, timing = {}}) {
  const {botToken, ownerId, conversationId} = credentials ?? {};
  if (typeof botToken !== 'string' || !/^[A-Za-z0-9_.-]{20,256}$/.test(botToken) || !snowflake(ownerId) || !snowflake(conversationId)) throw new Error('Discord credentials require a bot token, owner user ID and private channel ID.');
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

  function request(path, payload) {
    const task = (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 15000);
      timer.unref?.();
      try {
        const response = await fetch(`${API}${path}`, {
          method:payload === undefined ? 'GET' : 'POST', redirect:'error',
          headers:{authorization:`Bot ${botToken}`, 'content-type':'application/json', 'user-agent':'DiscordBot (https://github.com/Arcueid77/dot-discord-bridge, 0.1.0)'},
          ...(payload === undefined ? {} : {body:JSON.stringify(payload)}),
          signal:AbortSignal.any([controller.signal, deadline.signal])
        });
        return await json(response);
      } catch { throw fail(); }
      finally { clearTimeout(timer); }
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
    state.set('gatewaySession', {...resume, botId:selfId, ownerId, conversationId});
  }

  async function ingest(data) {
    if (!data || data.guild_id || data.webhook_id || data.author?.bot || data.author?.system || data.author?.id !== ownerId || data.author.id === selfId || data.channel_id !== conversationId || ![0, 19].includes(data.type) || !snowflake(data.id)) return;
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
    if (!text && !attachments.length) return;
    const message = {id:data.id, senderId:ownerId, conversationId, text, replyContext:{messageId:data.id}, attachments};
    const timestamp = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN;
    if (Number.isFinite(timestamp) && timestamp > 0) message.timestamp = timestamp;
    await onMessage(message);
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
                send(2, {token:botToken, intents:4096, properties:{os:process.platform, browser:'dot-bridge', device:'dot-bridge'}});
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

  return {
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
          resume = {...prior};
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
    async sendReply({message, text, idempotencyKey}) {
      if (!running || controller.signal.aborted) throw new Error('Discord provider is not running.');
      if (message?.senderId !== ownerId || message?.conversationId !== conversationId || !snowflake(message.id) || message.replyContext?.messageId !== message.id) throw new Error('Discord reply binding is invalid.');
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Discord reply must contain 1 to 2000 characters.');
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 1024) throw new Error('Discord reply requires a stable idempotency key.');
      const sent = await request(`/channels/${conversationId}/messages`, {
        content:text,
        nonce:createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24), enforce_nonce:true,
        allowed_mentions:{parse:[], replied_user:false},
        message_reference:{message_id:message.id, channel_id:conversationId, fail_if_not_exists:false}
      });
      if (!snowflake(sent?.id) || sent.channel_id !== conversationId) throw fail();
      return {providerMessageId:sent.id};
    }
  };
}
