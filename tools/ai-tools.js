'use strict';

// API 对话的工具层（2026-11-12）
// ---------------------------------------------------------------------------
// 让「API 接入的模型」也能真的做事，而不只是给建议。
//
// 设计原则（参考 DeepTutor 的 capability 增补思路，但只用最小协议）：
//   1. 工具只做「平台已有的安全动作」，不新增权限。每个工具都对应一个现有
//      HTTP 端点或本地只读查询，等价于用户自己点那个按钮。
//   2. 写操作必须先得到用户同意：打开登录页、改任务状态这类会改变外部世界的
//      动作，模型只能「提议」，由前端渲染成确认按钮，用户点了才真执行。
//   3. 不碰宿主文件系统、不执行任意代码、不联网抓任意 URL。参数一律白名单校验。
//
// 生命周期：一次对话轮次内，模型可以连续调用工具（最多 MAX_ROUNDS 轮），
// 每轮工具结果回灌给模型，直到模型不再调用工具、给出最终答复。

const MAX_ROUNDS = 4;          // 单轮对话最多几次「调用工具 → 回灌」
const MAX_CALLS_PER_ROUND = 3; // 单轮最多并行几个工具调用

const ACCESS_TARGETS = ['institution', 'purchase', 'cnki', 'wos', 'scopus', 'ezproxy'];
const SOURCES = ['wanfang', 'cnki', 'wos', 'scopus', 'ezproxy'];

//: 工具表。write=true 表示会改变外部世界（打开页面等），需要用户确认。
const TOOLS = Object.freeze([
  {
    name: 'check_login_status',
    write: false,
    description: '读取五个文献数据库当前的登录/机构权限状态。返回每个来源是否就绪及原因。用户问"登录了吗""为什么下不了"时先调用它。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'list_literature_jobs',
    write: false,
    description: '列出该任务下已有的文献任务（含状态、阶段、候选数）。用户问"我之前的检索到哪了""有哪些任务"时调用。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '返回条数，1-50，默认 10' } },
      required: []
    }
  },
  {
    name: 'open_login_page',
    write: true,
    description: '在平台专用浏览器打开某个数据库的官方登录页。target 取值：cnki=知网机构登录、institution=万方机构登录、wos=Web of Science、scopus=Scopus、ezproxy=学校统一登录、purchase=万方会员。会打开真实页面，需用户先确认。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ACCESS_TARGETS, description: '要打开哪一个登录入口' }
      },
      required: ['target']
    }
  },
  {
    name: 'explain_failure',
    write: false,
    description: '解释某个来源上一次失败的常见原因与处理步骤（不发请求，只根据来源给排查清单）。用户说"为什么万方下不了""知网报错"时调用。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: SOURCES, description: '哪个来源' }
      },
      required: ['source']
    }
  }
]);

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** OpenAI 风格的 tools 声明。 */
function toolSchemas() {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ---------------------------------------------------------------------------
// 只读工具
// ---------------------------------------------------------------------------

const FAILURE_GUIDE = Object.freeze({
  cnki: '知网常见原因：① 未登录或机构权限过期 → 点「知网机构登录」重新认证；② 同名文献有多个版本 → 平台按安全规则暂停，需要在原页面人工确认目标文献；③ 下载返回 CAJ 而非 PDF → 平台只收 PDF，该样本需人工处理；④ 访问过频被限流（HTTP 403）→ 等半小时再试。',
  wanfang: '万方常见原因：① 会话过期（勾了「7天免登录」也会到期）→ 点「打开机构登录」重登，可能先出现滑块；② 页面要求安全验证 → 在专用浏览器完成滑块；③ 学校未订购该刊 → 会记为访问受限，平台不绕过。',
  wos: 'Web of Science 常见原因：① 校外通道会话过期 → 点「EZproxy 统一登录」或「Web of Science 登录」；② 这篇文献没有 DOI（多为 2015 年前）→ 平台无法定位出版社，只能回退到摘要；③ 结果列表未加载完 → 稍等后点「检查并继续」。',
  scopus: 'Scopus 常见原因：① 校外通道会话过期 → 点「Scopus 登录」；② 记录页没有暴露 DOI → 平台回退到题名反查，可能失败；③ 仅显示 Scopus Preview → 说明没有机构权限，需重新登录。',
  ezproxy: 'EZproxy 常见原因：① 需要统一身份认证或多因子验证 → 点「EZproxy 统一登录」完成一次；② 学校未订阅该资源 → 不属于登录问题，只能换来源。'
});

async function runReadTool(name, args, ctx) {
  if (name === 'check_login_status') {
    const result = await ctx.accessStatus('all');
    const list = Array.isArray(result.results) ? result.results : [];
    return {
      ok: true,
      summary: list.map((item) => item.label + '：' + (item.message || '未判定')).join('；'),
      sources: list.map((item) => ({ label: item.label, signedIn: item.signedIn === true, message: item.message || '' }))
    };
  }
  if (name === 'list_literature_jobs') {
    const limit = clampInt(args && args.limit, 1, 50, 10);
    const payload = ctx.listJobs(limit);
    const jobs = Array.isArray(payload && payload.jobs) ? payload.jobs : [];
    return {
      ok: true,
      summary: jobs.length ? '共有 ' + jobs.length + ' 个文献任务' : '当前还没有文献任务',
      jobs: jobs.slice(0, limit).map((job) => ({
        id: job.id,
        name: job.name || job.config?.topic || '',
        status: job.status || '',
        stage: job.stage || '',
        candidates: job.counters?.candidates ?? null,
        updatedAt: job.updatedAt || ''
      }))
    };
  }
  if (name === 'explain_failure') {
    const source = args && args.source;
    if (!SOURCES.includes(source)) return { ok: false, error: 'source 必须是 ' + SOURCES.join(' / ') };
    return { ok: true, summary: FAILURE_GUIDE[source], source };
  }
  return { ok: false, error: '未知工具' };
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 跑一轮带工具的对话。
 *
 * @param {object} cfg      模型配置（走已有的 callModel 语义，但这里需要原始 message）
 * @param {Array} messages  已归一化的对话
 * @param {object} ctx      { accessStatus(source), listJobs(limit), openAccessPage(target), systemPrompt }
 * @returns {Promise<{text:string, toolEvents:Array}>}
 */
async function runWithTools(cfg, messages, ctx) {
  const events = [];
  // 工具轮次只在 chat-completions 协议下可用（responses 协议的工具格式不同）。
  if (cfg.protocol !== 'chat-completions') {
    const text = await ctx.callPlain(cfg, messages);
    return { text, toolEvents: events };
  }
  const conversation = messages.slice();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await ctx.callRaw(cfg, conversation, toolSchemas());
    const message = response && response.choices && response.choices[0] && response.choices[0].message;
    if (!message) throw ctx.upstreamError('AI 服务没有返回消息。');
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, MAX_CALLS_PER_ROUND) : [];
    if (!calls.length) {
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (!text) throw ctx.upstreamError('AI 服务没有返回可显示的文本。');
      return { text, toolEvents: events };
    }
    conversation.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function?.name || '', arguments: call.function?.arguments || '{}' }
      }))
    });
    for (const call of calls) {
      const name = call.function?.name || '';
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) { args = {}; }
      const spec = TOOL_MAP.get(name);
      let output;
      if (!spec) {
        output = { ok: false, error: '未注册的工具：' + name };
      } else if (spec.write) {
        // 写操作不在这里执行：交给前端渲染成确认按钮，用户点了才真调端点。
        output = {
          ok: false,
          needs_user_confirmation: true,
          pending_action: { tool: name, args },
          error: '这个操作会打开真实页面，需要用户先确认。已把确认按钮显示给用户。'
        };
      } else {
        try { output = await runReadTool(name, args, ctx); }
        catch (error) { output = { ok: false, error: String((error && error.message) || error).slice(0, 200) }; }
      }
      events.push({ name, args, ok: output.ok === true, pending: output.needs_user_confirmation === true });
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output).slice(0, 4000)
      });
    }
  }
  // 轮次用尽：让模型基于已有工具结果直接收尾（不再挂工具）。
  const final = await ctx.callRaw(cfg, conversation, null);
  const message = final && final.choices && final.choices[0] && final.choices[0].message;
  const text = message && typeof message.content === 'string' ? message.content.trim() : '';
  return { text: text || '（工具调用轮次已达上限，请补充说明后继续。）', toolEvents: events };
}

module.exports = { TOOLS, TOOL_MAP, toolSchemas, runWithTools, MAX_ROUNDS };
