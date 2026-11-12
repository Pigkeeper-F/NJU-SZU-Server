'use strict';
// 账号与权限入口：白名单、忙态与前后端接线（不启动浏览器）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiteratureConnector } = require('./literature-connector');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanxu-access-'));
  try {
    const connector = new LiteratureConnector(root, { prepare: async () => 'fixture-python' });

    for (const bad of ['https://evil.example/', 'institution2', 'wos2', '', null, 'INSTITUTION']) {
      await assert.rejects(connector.openAccessPage(bad), /只能打开白名单内的登录或购买页面/,
        '任意目标必须被拒绝: ' + bad);
    }

    connector.jobs.set('running-job', { status: 'running' });
    await assert.rejects(connector.openAccessPage('cnki'), /检索浏览器正在使用/,
      '任务运行中不得抢占检索浏览器');
    connector.jobs.delete('running-job');

    // 只验证参数接线：把 Python 调用替换为固定回包，不启动浏览器。
    const calls = [];
    connector.runAccessScript = async (args, timeout) => {
      calls.push({ args, timeout });
      if (args[0] === '--status') {
        return JSON.stringify({ checked: true, source: args[1], message: 'fixture' });
      }
      return JSON.stringify({ opened: true, target: args[1], label: 'fixture', message: 'fixture' });
    };
    await connector.openAccessPage('cnki');
    await connector.accessStatus('cnki');
    await connector.accessStatus('all');
    assert.deepEqual(calls[0].args, ['--open', 'cnki'], '打开入口只传枚举目标');
    assert.deepEqual(calls[1].args, ['--status', 'cnki'], '状态查询只传枚举来源');
    assert.equal(calls[1].timeout, 60000, '单库状态查询 60 秒');
    assert.equal(calls[2].timeout, 330000, '全部来源查询 330 秒');
    await assert.rejects(connector.accessStatus('cnki2'), /只能读取白名单内的登录状态/,
      '任意状态来源必须被拒绝');

    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(server.includes("'/api/literature/access-page'"), '服务端应提供登录页入口路由');
    assert.ok(server.includes("'/api/literature/access-status'"), '服务端应提供登录状态路由');
    assert.ok(server.includes("['institution', 'purchase', 'cnki', 'wos', 'scopus', 'ezproxy'].includes(data.target)"),
      '登录页路由只接受六项白名单目标');
    assert.ok(server.includes("['wanfang', 'cnki', 'wos', 'scopus', 'ezproxy', 'all'].includes(data.source)"),
      '状态路由只接受白名单来源');
    assert.ok(server.includes('Object.keys(data).length !== 1'),
      '登录页路由拒绝多余字段，避免夹带任意 URL');

    const ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
    // 【2026-11-12 界面简化】七个入口收进「管理登录」折叠区，但入口本身必须仍在；
    // 首屏只保留标题 + 一行状态 + 检查按钮。
    for (const text of ['账号与权限', '管理登录', '打开机构登录', '知网机构登录',
      'Web of Science 登录', 'Scopus 登录', 'EZproxy 统一登录', '打开万方会员', '检查登录状态']) {
      assert.ok(ui.includes(text), '界面应提供: ' + text);
    }
    assert.ok(ui.includes('literature-access-body') && ui.includes('literature-access-toggle'),
      '登录入口应放在可折叠的「管理登录」区，避免占据首屏');
    assert.ok(!ui.includes('账号与权限（登录一次，后续任务复用）'),
      '旧的常驻长标题不应再出现在首屏');
    assert.ok(ui.includes("body: JSON.stringify({ target })"), '界面只提交枚举目标');
    assert.ok(ui.includes("body: JSON.stringify({ source: 'all' })"), '界面状态查询只提交枚举来源');
    assert.ok(ui.includes('/api/literature/access-page') && ui.includes('/api/literature/access-status'),
      '界面应接入两个新路由');

    console.log('LITERATURE_ACCESS_ROUTE_TESTS_PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
