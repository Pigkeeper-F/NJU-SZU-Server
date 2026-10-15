'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workflowPrompt } = require('../server');

assert.equal(typeof workflowPrompt, 'function', '工作流提示词应可单独检查');
const prompt = workflowPrompt({ type: 'literature-mining' }, 'codex');
assert.ok(prompt.includes('首批候选检索只需研究主题'), '应使用已确认的最小启动规则');
assert.ok(prompt.includes('互不依赖且真正必需的问题一次性提出'), '互不依赖的关键问题应合并提问');
assert.ok(prompt.includes('不要求年份、地区、语言、来源、文献类型、目标数量或停止条件逐项确认'), '目标数量不能成为首批检索前的额外关口');
assert.ok(prompt.includes('研究者核对后点击后者才会真正检索'), '应明确检索由按钮启动，不由对话自动触发');
assert.ok(!prompt.includes('不要一次性要求回答全部待对齐项'), '文献挖掘不能同时收到相反的提问指令');

const codexUi = fs.readFileSync(path.join(__dirname, '..', 'js', 'codex.js'), 'utf8');
assert.ok(codexUi.includes('从对话整理规则') && codexUi.includes('确认配置并检索'), '界面应先整理并核对运行配置');

console.log('LITERATURE_GUIDANCE_TESTS_PASS');
