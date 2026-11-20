// Model selection for the nine-step literature and research-question actions.
(function (root) {
  'use strict';
  const choices = {
    follow: '沿用本环节的对话助手',
    codex: '本机 Codex',
    deepseek: 'DeepSeek API',
    openai: 'OpenAI API',
    api: '设置中的模型分组 / 服务端 API',
    workbuddy: '腾讯 WorkBuddy（云端）'
  };

  function fields(mod) {
    if (root.Store.getState) {
      const current = root.Store.getState().modules.find(item => item.id === mod.id);
      if (!current) throw new Error('当前任务已切换，请在对应任务中重试。');
      mod = current;
    }
    let choice = mod.params?.researchBackend || 'follow';
    if (choice === 'follow') {
      if (root.CodexUI?.useCodex(mod)) choice = 'codex';
      else {
        const credential = root.ApiKeys?.getActiveCredential();
        if (credential) return { backend: 'api', credential };
        choice = 'api';
      }
    }
    if (choice === 'workbuddy') return { backend: 'workbuddy' };
    if (choice === 'codex') return { backend: 'codex', codexModel: root.CodexUI?.getModel(mod) || null };
    if (choice === 'deepseek' || choice === 'openai') {
      const credential = root.ApiKeys?.getCredential(choice);
      if (!credential) throw new Error('请在左下角「添加 API」中配置 ' + choices[choice] + '。');
      return { backend: 'api', credential };
    }
    if (choice !== 'api') throw new Error('请重新选择本环节的研究助手。');
    const groups = root.Store.llmSettings;
    const settings = groups.resolve(groups.read());
    return { backend: 'api', settings: settings || {} };
  }

  function build(mod) {
    const row = document.createElement('div');
    row.className = 'research-panel';
    const label = document.createElement('label');
    label.className = 'research-field';
    const title = document.createElement('span');
    title.textContent = '研究助手';
    const select = document.createElement('select');
    select.className = 'research-input';
    Object.entries(choices).forEach(([key, name]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = name;
      select.append(option);
    });
    select.value = mod.params?.researchBackend || 'follow';
    select.addEventListener('change', () => root.Store.setModuleParam(mod.id, 'researchBackend', select.value));
    label.append(title, select);
    row.append(label);
    if (select.value === 'workbuddy') {
      const hint = document.createElement('small');
      hint.textContent = '运行时会把本次提示和选用的文献材料发送至腾讯云端，需要服务端配置 WorkBuddy 授权。';
      row.append(hint);
    }
    return row;
  }
  root.ResearchModel = { fields, build };
})(window);
