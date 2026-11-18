'use strict';

/**
 * 更新日志：把 GitHub 上的提交整理成「老师能看懂」的时间线。
 *
 * 为什么要在服务端做而不是浏览器直接调 GitHub：
 *   1. 浏览器直连 api.github.com 有 CORS 与未认证限流（60 次/小时/IP）问题，
 *      一个班级同时刷新就把额度刷没了；
 *   2. 服务端可以缓存（默认 5 分钟），老师刷新多少次都只打一次 GitHub；
 *   3. 仓库私有或日后加 token 时，token 只在服务端，不进浏览器。
 *
 * 设计约束：
 *   - 没有 GITHUB_TOKEN 也必须能用（公开仓库匿名读，60 次/小时足够配合缓存）；
 *   - GitHub 不可达时**不能**让页面白屏：返回 lastError + 上一次成功的缓存，
 *     并明确标注 stale，绝不假装数据是新的。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

// 中文提交常用的 conventional-commit 前缀 → 展示用的分类标签。
// 命中不了就归到「其他」，不臆造分类。
const TYPE_LABELS = Object.freeze({
  feat: '新功能',
  fix: '修复',
  docs: '文档',
  refactor: '重构',
  perf: '性能',
  test: '测试',
  chore: '杂项',
  style: '样式',
  build: '构建',
  ci: '持续集成',
  revert: '回滚',
  merge: '合并'
});

const TYPE_ORDER = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'style', 'chore', 'merge', 'revert', 'other'];

/**
 * 解析 conventional commit 风格的标题。
 * 例："feat(literature): add Wanfang adapter" → { type: 'feat', scope: 'literature', summary: 'add Wanfang adapter' }
 * 解析不出来时 type 归 'other'，summary 保留原标题（不丢信息）。
 */
function parseSubject(subject) {
  const raw = String(subject || '').trim();
  const match = raw.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?!?\s*:\s*(.+)$/);
  if (!match) return { type: 'other', scope: '', summary: raw, raw };
  const type = match[1].toLowerCase();
  return {
    type: TYPE_LABELS[type] ? type : 'other',
    scope: String(match[2] || '').trim(),
    summary: String(match[3] || '').trim(),
    raw
  };
}

/** 把一条 GitHub commit API 记录压成前端要的字段，去掉用不上的噪音。 */
function shapeCommit(item) {
  const commit = (item && item.commit) || {};
  const parsed = parseSubject(commit.message ? String(commit.message).split('\n')[0] : '');
  return {
    sha: String(item.sha || '').slice(0, 40),
    shortSha: String(item.sha || '').slice(0, 7),
    subject: parsed.raw,
    type: parsed.type,
    typeLabel: TYPE_LABELS[parsed.type] || '其他',
    scope: parsed.scope,
    summary: parsed.summary,
    author: (commit.author && commit.author.name) || (item.author && item.author.login) || '未知',
    date: (commit.author && commit.author.date) || (commit.committer && commit.committer.date) || '',
    url: (item.html_url && /^https:\/\/github\.com\//.test(item.html_url)) ? item.html_url : ''
  };
}

/** 按天分组，最近的一天排最前。页面按天渲染，老师扫一眼就知道「哪天改了什么」。 */
function groupByDay(commits) {
  const days = new Map();
  for (const item of commits) {
    const day = item.date ? item.date.slice(0, 10) : '未知日期';
    if (!days.has(day)) days.set(day, { date: day, commits: [] });
    days.get(day).commits.push(item);
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 统计每个类型多少条，给页面顶部做概览。 */
function summarizeTypes(commits) {
  const counts = new Map();
  for (const item of commits) counts.set(item.type, (counts.get(item.type) || 0) + 1);
  return TYPE_ORDER
    .filter(type => counts.has(type))
    .map(type => ({ type, label: TYPE_LABELS[type] || '其他', count: counts.get(type) }));
}

class Changelog {
  /**
   * @param {object} options
   * @param {string} options.repository 形如 "owner/repo"
   * @param {string} [options.branch]   分支名，默认 main
   * @param {string} [options.token]    GitHub token（可选，私有仓库或提高限额）
   * @param {number} [options.limit]    最多取多少条提交
   * @param {number} [options.pageUrl]  仓库网页地址（用于「在 GitHub 上查看」按钮）
   */
  constructor(options = {}) {
    this.repository = String(options.repository || '').trim();
    this.branch = String(options.branch || 'main').trim();
    this.token = String(options.token || '').trim();
    this.limit = Math.min(Math.max(Number(options.limit) || 60, 1), 200);
    this.pageUrl = String(options.pageUrl || '').trim()
      || (this.repository ? 'https://github.com/' + this.repository : '');
    this.cache = null;       // { at: number, payload: object }
    this.inflight = null;    // 并发请求合并，避免瞬间打出多次上游请求
  }

  get enabled() { return Boolean(this.repository); }

  /** 缓存是否还能用。 */
  fresh() { return this.cache && (Date.now() - this.cache.at) < CACHE_TTL_MS; }

  async fetchFromGitHub() {
    const url = 'https://api.github.com/repos/' + this.repository
      + '/commits?sha=' + encodeURIComponent(this.branch) + '&per_page=' + this.limit;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'yanxu-workbench-changelog',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error('GitHub 返回 HTTP ' + response.status + (text ? '：' + text.slice(0, 200) : ''));
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('GitHub 返回格式异常');
    return data.map(shapeCommit).filter(item => item.sha);
  }

  /**
   * 取更新日志。
   * @param {object} [options]
   * @param {boolean} [options.force] 跳过缓存强制刷新（页面上的「立即刷新」按钮）
   */
  async get(options = {}) {
    if (!this.enabled) {
      return { ok: false, enabled: false, error: '未配置仓库地址（CHANGELOG_REPO）。', commits: [], days: [], types: [] };
    }
    const build = (commits, extra) => ({
      ok: true,
      enabled: true,
      repository: this.repository,
      branch: this.branch,
      pageUrl: this.pageUrl,
      commits,
      days: groupByDay(commits),
      types: summarizeTypes(commits),
      count: commits.length,
      fetchedAt: new Date().toISOString(),
      ...extra
    });

    if (!options.force && this.fresh()) {
      return { ...this.cache.payload, cached: true };
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const commits = await this.fetchFromGitHub();
        const payload = build(commits, { cached: false });
        this.cache = { at: Date.now(), payload };
        return payload;
      } catch (error) {
        // 上游失败：有旧缓存就带着 stale 标记返回，没有就报错——两种情况都不编数据。
        if (this.cache) {
          return {
            ...this.cache.payload,
            cached: true,
            stale: true,
            lastError: error.message,
            fetchedAt: new Date(this.cache.at).toISOString()
          };
        }
        return {
          ok: false,
          enabled: true,
          repository: this.repository,
          branch: this.branch,
          pageUrl: this.pageUrl,
          error: error.message,
          commits: [],
          days: [],
          types: []
        };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

module.exports = { Changelog, parseSubject, shapeCommit, groupByDay, summarizeTypes, CACHE_TTL_MS };
