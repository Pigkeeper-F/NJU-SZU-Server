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
    },
    // 【自定义 · 2026-11-26】任何 OpenAI 兼容网关（自建代理、第三方中转、本地 vLLM 等）。
    // 地址、模型、协议都由用户填，不再写死。
    // 默认空 baseUrl：强制用户自己填，避免误用成某个具体厂商。
    custom: {
      label: '自定义',
      defaultModel: '',
      protocol: 'chat-completions',
      baseUrl: '',
      custom: true
    }
  };

  var activeProvider = 'deepseek';
  var toastTimer = null;
  // 【本地/服务器 API · 2026-11-26】服务器公共 API 的可用性缓存
  var serverApiStatus = { checked: false, ready: false, model: '', models: [], message: '' };
  // 用户上次选的服务器模型（记住选择，下次打开不用重挑）
  var SERVER_MODEL_KEY = 'yanxu_server_model';

  function $(id) { return document.getElementById(id); }

  /** 查询服务器公共 API 是否可用（只回状态，不含 Key）。 */
  function fetchServerApiStatus(done) {
    var cb = (typeof done === 'function') ? done : function () {};
    fetch('/api/literature/public-api', { headers: { 'X-Workbench': '1' } })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          serverApiStatus = {
            checked: true,
            ready: response.ok && data.ready === true,
            model: data.model || '',
            models: Array.isArray(data.models) ? data.models : [],
            message: data.message || ''
          };
          cb(serverApiStatus);
        });
      })
      .catch(function () {
        serverApiStatus = { checked: true, ready: false, model: '', models: [], message: '无法连接服务器，公共 API 状态未知' };
        cb(serverApiStatus);
      });
  }

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
    $('api-dialog-description').textContent = provider.custom
      ? '填任意 OpenAI 兼容接口：地址、模型、协议都按你用的网关来。密钥只保存在当前浏览器。'
      : '保存后，AI 对话会优先使用这个 ' + provider.label + ' 密钥。';
    $('api-key-label').textContent = provider.label + ' API Key';
    $('api-key-input').value = saved.apiKey || '';
    $('api-model-input').value = saved.model || provider.defaultModel;

    // 【自定义 · 2026-11-26】只有自定义才显示这两个字段，内置供应商的地址/协议是固定的
    var customBox = $('api-custom-fields');
    if (customBox) {
      customBox.hidden = !provider.custom;
      if (provider.custom) {
        $('api-baseurl-input').value = saved.baseUrl || '';
        $('api-protocol-input').value = saved.protocol || provider.protocol;
        $('api-model-input').placeholder = '例如 deepseek-chat / gpt-4o-mini';
      }
    }

    // 【本地/服务器 API · 2026-11-26】只有自定义才有这个选择：
    // 内置的 DeepSeek/OpenAI 一定是本地（用用户自己的 Key）。
    var scopePicker = document.querySelector('.api-scope-picker');
    if (scopePicker) {
      scopePicker.hidden = !provider.custom;
      if (provider.custom) {
        var scope = saved.scope === 'server' ? 'server' : 'local';
        var radio = document.querySelector('input[name="api-scope"][value="' + scope + '"]');
        if (radio) radio.checked = true;
        applyScopeUi(scope);
      }
    }

    $('api-dialog').showModal();
    if (provider.custom && saved.scope === 'server') {
      // 选服务器 API 时不需要聚焦 Key 输入
      $('api-dialog').querySelector('.primary-button').focus();
    } else {
      $('api-key-input').focus();
    }
  }

  /** 按当前选中的 scope 显示/隐藏字段，并说明服务器 API 是否可用。 */
  function applyScopeUi(scope) {
    var isServer = scope === 'server';
    var keyRow = $('api-key-input') ? $('api-key-input').closest('.api-key-row') || $('api-key-input') : null;
    var keyLabel = $('api-key-label');
    var customFields = $('api-custom-fields');
    var modelLabel = document.querySelector('label[for="api-model-input"]');
    var statusBox = $('api-server-status');

    // 服务器 API：隐藏 Key 与地址/协议（都用管理员的），模型改由服务器清单决定
    if (keyLabel) keyLabel.hidden = isServer;
    if (keyRow) keyRow.hidden = isServer;
    if (customFields) customFields.hidden = isServer;
    if (modelLabel) modelLabel.hidden = isServer;
    if ($('api-model-input')) $('api-model-input').hidden = isServer;

    var modelRow = $('api-server-model-row');
    if (modelRow) modelRow.hidden = !isServer;

    if (!statusBox) return;
    if (!isServer) { statusBox.hidden = true; statusBox.textContent = ''; return; }
    statusBox.hidden = false;
    statusBox.textContent = '正在查询服务器公共 API…';
    statusBox.removeAttribute('data-tone');
    fetchServerApiStatus(function (status) {
      if (status.ready) {
        statusBox.setAttribute('data-tone', 'ok');
        statusBox.textContent = '✓ 服务器公共 API 可用';
        renderServerModels(status.models || [], status.model || '');
      } else {
        statusBox.setAttribute('data-tone', 'error');
        statusBox.textContent = status.message || '服务器公共 API 不可用';
        if (modelRow) modelRow.hidden = true;
      }
    });
  }

  /**
   * 【多模型 · 2026-11-26】渲染服务器提供的模型下拉。
   * 每个模型可以带一句提示（管理员配的），选中时用红字显示出来 ——
   * 免费模型不稳、性能差，得让用户在用之前就知道，而不是跑完才纳闷。
   */
  function renderServerModels(models, defaultModel) {
    var select = $('api-server-model-select');
    var note = $('api-server-model-note');
    if (!select) return;
    select.textContent = '';
    if (!models.length) {
      var opt = document.createElement('option');
      opt.value = defaultModel || '';
      opt.textContent = defaultModel || '（服务器未提供模型清单）';
      select.appendChild(opt);
      if (note) { note.hidden = true; note.textContent = ''; }
      return;
    }
    models.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.name;
      option.textContent = item.name;
      select.appendChild(option);
    });
    // 记住上次选的（如果还在清单里）
    var saved = '';
    try { saved = localStorage.getItem(SERVER_MODEL_KEY) || ''; } catch (e) { saved = ''; }
    select.value = models.some(function (m) { return m.name === saved; })
      ? saved
      : (defaultModel || models[0].name);

    function syncNote() {
      var picked = models.filter(function (m) { return m.name === select.value; })[0];
      if (!note) return;
      if (picked && picked.note) {
        note.hidden = false;
        note.textContent = picked.note;
        note.setAttribute('data-tone', 'warn');
      } else {
        note.hidden = true;
        note.textContent = '';
        note.removeAttribute('data-tone');
      }
      try { localStorage.setItem(SERVER_MODEL_KEY, select.value); } catch (e) { /* 忽略 */ }
    }
    select.onchange = syncNote;
    syncNote();
  }

  function providerSnapshot(providerId) {
    var data = readStore();
    var selected = providerId || data.activeProvider;
    var saved = data.providers[selected] || {};
    var provider = PROVIDERS[selected];
    if (!provider) return null;

    // 【本地/服务器 API · 2026-11-26】选服务器公共 API：不传任何 Key，
    // 只带一个标记，由服务端补上公共配置（Key 永不下发浏览器）。
    if (provider.custom && saved.useServer === true) {
      // 把用户选的模型带上；服务端只接受白名单内的名字，选了别的会退回默认
      return { provider: selected, useServer: true, scope: 'server', model: saved.model || '' };
    }

    if (!saved.apiKey) return null;
    var snapshot = {
      provider: selected,
      apiKey: saved.apiKey,
      model: saved.model || provider.defaultModel,
      protocol: provider.custom ? (saved.protocol || provider.protocol) : provider.protocol,
      baseUrl: provider.custom ? (saved.baseUrl || '') : provider.baseUrl
    };
    // 自定义没填地址 → 视为未配置完成，不能拿去发请求
    if (provider.custom && !snapshot.baseUrl) return null;
    return snapshot;
  }

  function saveDialog(event) {
    event.preventDefault();
    var provider = PROVIDERS[activeProvider];
    if (!provider) return;

    // 【本地/服务器 API · 2026-11-26】自定义可以选"用服务器公共 API"：
    // 这时不需要 Key、地址、模型，只记一个 useServer 标记。
    var scopeRadio = document.querySelector('input[name="api-scope"]:checked');
    var useServer = Boolean(provider.custom && scopeRadio && scopeRadio.value === 'server');

    if (useServer) {
      if (!serverApiStatus.checked || !serverApiStatus.ready) {
        var box = $('api-server-status');
        if (box) {
          box.setAttribute('data-tone', 'error');
          box.textContent = serverApiStatus.message || '服务器公共 API 不可用，无法保存；请改用「本地 API」填自己的 Key。';
        }
        return;   // 不保存不可用的配置，避免之后请求莫名失败
      }
      var dataServer = readStore();
      dataServer.activeProvider = activeProvider;
      var pickedModel = $('api-server-model-select') ? $('api-server-model-select').value : '';
      dataServer.providers[activeProvider] = { useServer: true, scope: 'server', model: pickedModel || '' };
      $('api-dialog').close();
      toast(writeStore(dataServer) ? '已启用服务器公共 API' : '已启用（当前浏览器无法持久保存）');
      return;
    }

    var key = $('api-key-input').value.trim();
    if (!key) {
      $('api-key-input').setCustomValidity('请粘贴 API Key');
      $('api-key-input').reportValidity();
      return;
    }
    // 自定义必须填地址和模型，否则请求发不到地方
    if (provider.custom) {
      var baseUrl = ($('api-baseurl-input').value || '').trim();
      if (!/^https?:\/\//i.test(baseUrl)) {
        $('api-baseurl-input').setCustomValidity('请填完整的接口地址，例如 https://your-gateway/v1');
        $('api-baseurl-input').reportValidity();
        return;
      }
      if (!($('api-model-input').value || '').trim()) {
        $('api-model-input').setCustomValidity('请填写模型名');
        $('api-model-input').reportValidity();
        return;
      }
    }
    var data = readStore();
    data.activeProvider = activeProvider;
    var record = {
      apiKey: key,
      model: $('api-model-input').value.trim() || provider.defaultModel
    };
    if (provider.custom) {
      record.baseUrl = ($('api-baseurl-input').value || '').trim().replace(/\/+$/, '');
      record.protocol = $('api-protocol-input').value === 'responses' ? 'responses' : 'chat-completions';
      record.scope = 'local';
    }
    data.providers[activeProvider] = record;
    $('api-key-input').setCustomValidity('');
    if (provider.custom) {
      $('api-baseurl-input').setCustomValidity('');
      $('api-model-input').setCustomValidity('');
    }
    $('api-dialog').close();
    toast(writeStore(data) ? provider.label + ' API 已保存' : 'API 已保存到本次会话，当前浏览器无法持久保存');
  }

  /**
   * 【测试连接 · 2026-11-26】用当前表单里的配置发一次最小请求，验证地址/Key/模型是否真的能用。
   * 为什么不复用「设置」里的测试：那里用表单外的已保存配置，而用户常常是
   * "刚填完想先试一下再保存"，测的必须是**眼前这份输入**。
   * 服务端接口 /api/ai/test 会走同一条解析与重试链路，所以这里通过 = 保存后能用。
   */
  function testConnection() {
    var btn = $('api-test-button');
    var status = $('api-test-status');
    if (!btn || !status) return;
    var provider = PROVIDERS[activeProvider];
    if (!provider) return;

    var scopeRadio = document.querySelector('input[name="api-scope"]:checked');
    var useServer = Boolean(provider.custom && scopeRadio && scopeRadio.value === 'server');

    var body;
    if (useServer) {
      // 服务器公共 API：不带 Key，让服务端补；顺带验证公共通道是否真的可用。
      // 带上用户选中的模型，测的就正是他要用的那个。
      var pickedModel = $('api-server-model-select') ? $('api-server-model-select').value : '';
      body = { credential: { useServer: true, model: pickedModel || '' } };
    } else {
      var key = ($('api-key-input').value || '').trim();
      if (!key) {
        status.setAttribute('data-tone', 'error');
        status.textContent = '请先填写 API Key 再测试';
        return;
      }
      if (provider.custom) {
        var baseUrl = ($('api-baseurl-input').value || '').trim();
        if (!/^https?:\/\//i.test(baseUrl)) {
          status.setAttribute('data-tone', 'error');
          status.textContent = '请先填写完整的接口地址再测试';
          return;
        }
        if (!($('api-model-input').value || '').trim()) {
          status.setAttribute('data-tone', 'error');
          status.textContent = '请先填写模型名再测试';
          return;
        }
      }
      body = {
        credential: {
          provider: activeProvider,
          apiKey: key,
          model: ($('api-model-input').value || '').trim() || provider.defaultModel,
          baseUrl: provider.custom
            ? ($('api-baseurl-input').value || '').trim().replace(/\/+$/, '')
            : provider.baseUrl,
          protocol: provider.custom
            ? ($('api-protocol-input').value === 'responses' ? 'responses' : 'chat-completions')
            : provider.protocol
        }
      };
    }

    btn.disabled = true;
    status.removeAttribute('data-tone');
    // reasoning 模型（deepseek-v4.1 之类）要"想"十几秒，先说明白，别让人以为卡死
    status.textContent = '正在测试…（推理型模型可能需要十几秒）';
    var started = Date.now();
    fetch('/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || ('HTTP ' + response.status));
          throw error;
        }
        return data;
      });
    }).then(function (data) {
      btn.disabled = false;
      status.setAttribute('data-tone', 'ok');
      var cost = typeof data.latencyMs === 'number' ? data.latencyMs : (Date.now() - started);
      status.textContent = '✓ 连接成功（' + Math.round(cost) + ' ms'
        + (data.model ? '，模型 ' + data.model : '') + '）'
        + (data.reply ? ' 回复：' + data.reply : '');
    }).catch(function (error) {
      btn.disabled = false;
      status.setAttribute('data-tone', 'error');
      status.textContent = '✗ 测试失败：' + (error && error.message ? error.message : '网络异常');
    });
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

  /**
   * 移除已存密钥（2026-10-21）。
   * 「添加 API」原来只能存不能删，删不掉就会一直盖住「设置」里的模型分组——
   * 症状是「测试连通」通过、AI 对话却报"无法连接 AI 服务"。这里给一条正常的清除入口。
   */
  function removeKey() {
    var data = readStore();
    var provider = data.activeProvider;
    var existed = Boolean(data.providers[provider]);
    if (!existed) {
      // 该 provider 本来就没有凭证：直接清掉整条记录，避免留下半截状态
      try { root.localStorage.removeItem(STORAGE_KEY); } catch (error) { /* 忽略 */ }
      toast('没有可移除的密钥');
      return;
    }
    delete data.providers[provider];
    if (!Object.keys(data.providers).length) {
      try { root.localStorage.removeItem(STORAGE_KEY); } catch (error) { /* 忽略 */ }
    } else {
      writeStore(data);
    }
    var label = (PROVIDERS[provider] && PROVIDERS[provider].label) || '该';
    toast('已移除 ' + label + ' 密钥，改用设置里的模型配置');
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
    var removeBtn = $('api-remove-key');
    if (removeBtn) removeBtn.addEventListener('click', function () { removeKey(); });

    // 【本地/服务器 API · 2026-11-26】切换 scope 时立刻调整可见字段
    document.querySelectorAll('input[name="api-scope"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) {
          applyScopeUi(radio.value);
          // 换了通道，之前的测试结果就不作数了，清掉免得误导
          var st = $('api-test-status');
          if (st) { st.textContent = ''; st.removeAttribute('data-tone'); }
        }
      });
    });

    var testBtn = $('api-test-button');
    if (testBtn) testBtn.addEventListener('click', testConnection);

    $('api-paste-key').addEventListener('click', pasteKey);
  }

  root.ApiKeys = {
    getActiveCredential: function () { return providerSnapshot(); },
    getCredential: providerSnapshot,
    providers: PROVIDERS
  };
  bind();
})(typeof window !== 'undefined' ? window : this);
