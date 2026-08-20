// 对话区模型栏：provider 下拉 + 模型下拉（候选来自 provider 的 /models）
// 切换 provider = 改激活项；改模型 = 写回 provider 配置，即时生效
// 模型下拉拉空时显示当前模型 + 「自定义…」手填入口

async function fetchProviders() {
  const res = await fetch('/api/config/providers');
  const data = await res.json();
  return data.ok ? data : { providers: [], activeProviderId: null };
}

const CUSTOM_VALUE = '__custom__';

export function initModelBar() {
  const providerSel = document.getElementById('provider-select');
  const modelSel = document.getElementById('model-select');
  const modelInput = document.getElementById('model-input');
  const stateEl = document.getElementById('model-bar-state');
  let providers = [];

  async function refresh() {
    const data = await fetchProviders();
    providers = data.providers;
    providerSel.innerHTML = providers.length
      ? providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
      : '<option value="">（无 provider，请先在设置里添加）</option>';
    const active = providers.find(p => p.id === data.activeProviderId) || providers[0];
    if (active) {
      providerSel.value = active.id;
      await loadModels(active);
    } else {
      modelSel.innerHTML = '<option value="">—</option>';
    }
    updateState();
  }

  function currentProvider() {
    return providers.find(x => x.id === providerSel.value) || null;
  }

  async function loadModels(p) {
    modelSel.innerHTML = '<option value="">加载中…</option>';
    stateEl.textContent = '';
    let models = [], warning = '';
    try {
      const res = await fetch(`/api/config/models?providerId=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      if (data.ok) {
        models = data.models || [];
        warning = data.warning || '';
      }
    } catch (err) { warning = '模型列表拉取失败: ' + err.message; }
    // 当前模型要在列表里（即使 /models 没返回它）
    const current = p.model || '';
    const options = [...new Set([...(current ? [current] : []), ...models])];
    modelSel.innerHTML =
      (options.length
        ? options.map(m => `<option value="${m}">${m}</option>`).join('')
        : '<option value="">（未拉取到模型列表）</option>') +
      `<option value="${CUSTOM_VALUE}">✎ 自定义…</option>`;
    modelSel.value = current;
    if (!options.includes(current)) modelSel.value = options[0] || CUSTOM_VALUE;
    modelInput.classList.add('hidden');
    modelSel.classList.remove('hidden');
    // 拉取失败要看得见原因（如 LiteLLM 401 = 缺 API Key）
    if (warning) {
      stateEl.textContent = '⚠ ' + warning;
      stateEl.title = warning;
    } else if (!models.length && p.type !== 'copilot' && !p.hasKey) {
      stateEl.textContent = '⚠ 该 provider 未配置 API Key（设置里填）';
    }
  }

  function updateState() {
    const p = currentProvider();
    const model = modelSel.value && modelSel.value !== CUSTOM_VALUE ? modelSel.value : modelInput.value.trim();
    stateEl.textContent = p && !model ? '⚠ 未选模型' : '';
  }

  async function save(reloadModels) {
    const p = currentProvider();
    const model = modelSel.value === CUSTOM_VALUE ? modelInput.value.trim() : modelSel.value;
    const body = {
      providers: providers.map(x => x.id === p?.id ? { ...x, model } : x),
      activeProviderId: providerSel.value,
    };
    await fetch('/api/config/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    providers = body.providers;
    if (reloadModels && p) await loadModels({ ...p, model });
    updateState();
  }

  providerSel.addEventListener('change', () => {
    const p = currentProvider();
    if (p) loadModels(p);
    save(false);
  });

  modelSel.addEventListener('change', () => {
    if (modelSel.value === CUSTOM_VALUE) {
      modelSel.classList.add('hidden');
      modelInput.classList.remove('hidden');
      modelInput.value = currentProvider()?.model || '';
      modelInput.focus();
      return;
    }
    save(false);
  });

  modelInput.addEventListener('change', () => save(false));
  modelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      modelInput.classList.add('hidden');
      modelSel.classList.remove('hidden');
    }
  });

  // 设置面板保存后刷新模型栏
  window.addEventListener('providers-changed', refresh);
  refresh();
}
