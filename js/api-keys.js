/* API provider picker and local key storage. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'research_api_keys_v1';
  var PROVIDERS = {
    deepseek: {
      label: 'DeepSeek',
      defaultModel: 'deepseek-flash',
      protocol: 'chat-completions',
      baseUrl: 'https://api.deepseek.com/v1'
    },
    openai: {
      label: 'OpenAI',
      defaultModel: 'gpt-5-mini',
      protocol: 'responses',
      baseUrl: 'https://api.openai.com/v1'
    }
  };

  var activeProvider = 'deepseek';
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  function readStore() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return { activeProvider: activeProvider, providers: {} };
      if (PROVIDERS[parsed.activeProvider]) activeProvider = parsed.activeProvider;
      return {
        activeProvider: activeProvider,
        providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {}
      };
    } catch (e) {
      return { activeProvider: activeProvider, providers: {} };
    }
  }

  function writeStore(data) {
    try {
      if (!root.localStorage) return false;
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  function toast(text) {
    var box = $('toast');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, 2600);
  }

  function closeMenu() {
    var menu = $('api-provider-menu');
    var button = $('add-api-button');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    var menu = $('api-provider-menu');
    var button = $('add-api-button');
    if (!menu || !button) return;
    var next = menu.hidden;
    menu.hidden = !next;
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
  }

  function openDialog(providerId) {
    if (!PROVIDERS[providerId]) return;
    activeProvider = providerId;
    closeMenu();
    var data = readStore();
    var saved = data.providers[providerId] || {};
    var provider = PROVIDERS[providerId];
    $('api-dialog-eyebrow').textContent = provider.label.toUpperCase();
    $('api-dialog-title').textContent = '添加 ' + provider.label + ' API';
    $('api-dialog-description').textContent = '保存后，AI 对话会优先使用这个 ' + provider.label + ' 密钥。';
    $('api-key-label').textContent = provider.label + ' API Key';
    $('api-key-input').value = saved.apiKey || '';
    $('api-model-input').value = saved.model || provider.defaultModel;
    $('api-dialog').showModal();
    $('api-key-input').focus();
  }

  function providerSnapshot() {
    var data = readStore();
    var saved = data.providers[data.activeProvider] || {};
    var provider = PROVIDERS[data.activeProvider];
    if (!provider || !saved.apiKey) return null;
    return {
      provider: data.activeProvider,
      apiKey: saved.apiKey,
      model: saved.model || provider.defaultModel,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl
    };
  }

  function saveDialog(event) {
    event.preventDefault();
    var provider = PROVIDERS[activeProvider];
    if (!provider) return;
    var key = $('api-key-input').value.trim();
    if (!key) {
      $('api-key-input').setCustomValidity('请粘贴 API Key');
      $('api-key-input').reportValidity();
      return;
    }
    var data = readStore();
    data.activeProvider = activeProvider;
    data.providers[activeProvider] = {
      apiKey: key,
      model: $('api-model-input').value.trim() || provider.defaultModel
    };
    $('api-key-input').setCustomValidity('');
    $('api-dialog').close();
    toast(writeStore(data) ? provider.label + ' API 已保存' : 'API 已保存到本次会话，当前浏览器无法持久保存');
  }

  function copyKey() {
    var input = $('api-key-input');
    if (!input || !input.value) return;
    input.select();
    input.setSelectionRange(0, input.value.length);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(function () { toast('API Key 已复制'); });
      return;
    }
    document.execCommand('copy');
    toast('API Key 已复制');
  }

  function pasteKey() {
    var input = $('api-key-input');
    if (!input || !navigator.clipboard || !navigator.clipboard.readText) {
      toast('浏览器不支持直接读取剪贴板，请手动粘贴');
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      input.value = text.trim();
      input.focus();
    }).catch(function () {
      toast('无法读取剪贴板，请手动粘贴');
    });
  }

  function bind() {
    var button = $('add-api-button');
    var menu = $('api-provider-menu');
    var dialog = $('api-dialog');
    if (!button || !menu || !dialog) return;
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleMenu();
    });
    menu.addEventListener('click', function (event) {
      var target = event.target.closest('[data-api-provider]');
      if (!target) return;
      openDialog(target.getAttribute('data-api-provider'));
    });
    document.addEventListener('click', function (event) {
      if (!event.target.closest('.api-menu')) closeMenu();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });
    $('api-form').addEventListener('submit', saveDialog);
    $('api-key-input').addEventListener('input', function () { $('api-key-input').setCustomValidity(''); });
    $('api-close-dialog').addEventListener('click', function () { dialog.close(); });
    $('api-cancel-dialog').addEventListener('click', function () { dialog.close(); });
    $('api-copy-key').addEventListener('click', copyKey);
    $('api-paste-key').addEventListener('click', pasteKey);
  }

  root.ApiKeys = {
    getActiveCredential: providerSnapshot,
    providers: PROVIDERS
  };
  bind();
})(typeof window !== 'undefined' ? window : this);
