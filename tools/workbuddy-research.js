'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');

const TASKS = 'https://www.workbuddy.cn/openapi/v2/tasks';
const MAX_TEXT = 160000;

function officialChannel(link, sessionId) {
  let url;
  try { url = new URL(link); } catch { throw new Error('WorkBuddy 未返回有效的 ACP 地址'); }
  const gateway = url.hostname === 'acp.workbuddy.cn' && url.pathname === '/sessions/' + encodeURIComponent(sessionId);
  const sandbox = /^[a-z0-9-]+\.ap-[a-z0-9-]+\.agentos-run\.net$/.test(url.hostname) && url.pathname === '/acp';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search || !(gateway || sandbox)) {
    throw new Error('WorkBuddy 返回的 ACP 地址与受支持的官方任务通道不匹配');
  }
  return url.href;
}

function textPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('WorkBuddy 缺少待讨论的文本');
  const items = messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new Error('WorkBuddy 仅接收有角色的文本消息');
    }
    return { role: message.role, content: message.content };
  });
  const input = JSON.stringify(items);
  if (input.length > MAX_TEXT) throw new Error('WorkBuddy 本次讨论文本过长，请缩短后再试');
  return '请根据以下讨论记录回复最后的研究问题，仅回复文字，无需使用工具或访问文件。\n' + input;
}

// The reader belongs to one GET, never a shared account-wide message feed.
async function* readEvents(reader) {
  const decoder = new TextDecoder();
  let input = '', lines = [], size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('WorkBuddy 的 SSE 连接在回答完成前结束');
    input += decoder.decode(value, { stream: true });
    let offset;
    while ((offset = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, offset).replace(/\r$/, '');
      input = input.slice(offset + 1);
      if (line === '') {
        if (lines.length) {
          let message;
          try { message = JSON.parse(lines.join('\n')); }
          catch { throw new Error('WorkBuddy 返回了无法解析的 ACP 事件'); }
          lines = [];
          size = 0;
          yield message;
        }
      } else if (line === 'data' || line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        size += data.length + 1;
        if (size > MAX_TEXT) throw new Error('WorkBuddy 的单个 SSE 事件过大');
        lines.push(data);
      }
    }
    if (input.length > MAX_TEXT) throw new Error('WorkBuddy 的 SSE 消息行过长');
  }
}

async function composeWorkBuddy(messages, options = {}) {
  const accessToken = (options.accessToken ?? process.env.WORKBUDDY_ACCESS_TOKEN ?? '').trim();
  if (!accessToken) throw new Error('WorkBuddy 尚未授权，请在服务端配置 WORKBUDDY_ACCESS_TOKEN');
  const prompt = textPrompt(messages);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const signal = controller.signal;
  const timeout = options.timeoutMs ?? 120000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error('WorkBuddy 超时参数无效');
  const cancel = () => controller.abort(new Error('WorkBuddy 调用已取消'));
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('WorkBuddy 调用超时')), timeout);
  let reader, sessionId, channel, rpcHeaders, turnStarted = false;
  const stopReading = () => { if (reader) reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stopReading, { once: true });

  async function request(url, init) {
    signal.throwIfAborted();
    let response;
    try { response = await fetchImpl(url, { ...init, signal, redirect: 'error' }); }
    catch { signal.throwIfAborted(); throw new Error('WorkBuddy 网络连接失败'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status)) throw new Error('WorkBuddy 授权已失效或权限不足（HTTP ' + response.status + '）');
      throw new Error('WorkBuddy 请求失败（HTTP ' + response.status + '）');
    }
    return response;
  }
  const apiHeaders = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json' };
  async function taskData(url, init) {
    const response = await request(url, { headers: apiHeaders, ...init });
    let body;
    try { body = await response.json(); } catch { throw new Error('WorkBuddy 任务响应格式异常'); }
    return body?.task_id ? body : body?.data;
  }
  async function post(message) {
    const response = await request(channel, { method: 'POST', headers: rpcHeaders, body: JSON.stringify({ jsonrpc: '2.0', ...message }) });
    await response.body?.cancel();
  }
  try {
    let task = await taskData(TASKS, { method: 'POST', body: JSON.stringify({
      name: '科研讨论', prompt: '准备独立文本会话，请等待下一条研究问题。无需使用工具。'
    }) });
    sessionId = task?.task_id;
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('WorkBuddy 创建任务后未返回有效会话标识');
    while (!task.link || !task.token) {
      if (['failed', 'archived', 'deleted', 'completed'].includes(task.status)) throw new Error('WorkBuddy 云端任务未能建立 ACP 通道');
      await wait(500, undefined, { signal });
      task = await taskData(TASKS + '/' + encodeURIComponent(sessionId), { method: 'GET' });
      if (task?.task_id !== sessionId) throw new Error('WorkBuddy 返回的会话标识发生变化');
    }
    channel = officialChannel(task.link, sessionId);
    const ticketHeader = { Authorization: 'Bearer ' + task.token };
    const stream = await request(channel, { method: 'GET', headers: { ...ticketHeader, Accept: 'text/event-stream' } });
    const connection = stream.headers.get('Acp-Connection-Id');
    if (!connection || !stream.body || !/^text\/event-stream(?:;|$)/i.test(stream.headers.get('Content-Type') || '')) {
      await stream.body?.cancel();
      throw new Error('WorkBuddy 未建立可关联的 SSE 接收通道');
    }
    rpcHeaders = { ...ticketHeader, 'Content-Type': 'application/json', 'Acp-Connection-Id': connection };
    reader = stream.body.getReader();
    const events = readEvents(reader);
    const replayed = new Set();
    let lastMessageId, answer = '', responseSize = 0;
    async function call(method, params) {
      const id = randomUUID();
      await post({ id, method, params });
      for (;;) {
        const event = (await events.next()).value;
        if (!event || event.jsonrpc !== '2.0') continue;
        if (!event.method) {
          if (event.id !== id) continue;
          if (event.error || !event.result || (event.result.sessionId && event.result.sessionId !== sessionId)) {
            throw new Error('WorkBuddy 未完成 ' + method);
          }
          return event.result;
        }
        if (event.params?.sessionId !== sessionId) continue;
        if (event.id != null) {
          if (event.method === 'session/request_permission') {
            await post({ id: event.id, result: { outcome: { outcome: 'cancelled' } } });
            throw new Error('WorkBuddy 请求了工具授权，本次纯文本讨论已取消');
          }
          await post({ id: event.id, error: { code: -32601, message: 'Client method unavailable' } });
          throw new Error('WorkBuddy 请求了此文本通道不支持的客户端操作');
        }
        if (event.method !== 'session/update') continue;
        const update = event.params.update;
        if (update?.sessionUpdate === 'tool_call' && turnStarted) throw new Error('WorkBuddy 尝试调用工具，本次纯文本讨论已停止');
        if (update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text' || typeof update.content.text !== 'string') continue;
        if (method !== 'session/prompt') {
          if (update.messageId) replayed.add(update.messageId);
          continue;
        }
        if (replayed.has(update.messageId)) continue;
        if (update.messageId && update.messageId !== lastMessageId) {
          // A later assistant message supersedes its earlier progress narration.
          if (lastMessageId) replayed.add(lastMessageId);
          lastMessageId = update.messageId;
          answer = '';
        }
        if (!update.messageId && lastMessageId) continue;
        responseSize += update.content.text.length;
        if (responseSize > MAX_TEXT) throw new Error('WorkBuddy 回复超过接收上限');
        answer += update.content.text;
      }
    }
    const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (initialized.protocolVersion !== 1) throw new Error('WorkBuddy 返回了不兼容的 ACP 版本');
    await call('session/load', { sessionId, cwd: '/workspace', mcpServers: [] });
    turnStarted = true;
    const end = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    turnStarted = false;
    if (end.stopReason !== 'end_turn') throw new Error('WorkBuddy 本轮没有正常完成');
    if (!answer.trim()) throw new Error('WorkBuddy 本轮未返回助手正文');
    return answer.trim();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if (turnStarted && channel && rpcHeaders) {
      // Bound cleanup independently because the caller's signal may already be aborted.
      const cleanup = new AbortController();
      const end = setTimeout(() => cleanup.abort(), 1000);
      try {
        const response = await fetchImpl(channel, { method: 'POST', headers: rpcHeaders, redirect: 'error',
          signal: cleanup.signal, body: JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) });
        await response.body?.cancel();
      } catch { /* The channel may already have closed. */ }
      finally { clearTimeout(end); }
    }
    signal.removeEventListener('abort', stopReading);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

module.exports = { composeWorkBuddy };
