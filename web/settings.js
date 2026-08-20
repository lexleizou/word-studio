// 设置面板：provider 管理（OpenAI 兼容 endpoint 增删改 + 激活）
// Skills / MCP / Copilot 的管理界面在后续阶段并入此面板
import { openModal } from './format-menu.js';

function providerRow(p, activeId) {
  return `
    <div class="provider-row" data-id="${p.id}" data-type="${p.type || ''}">
      <label class="provider-active"><input type="radio" name="activeProvider" value="${p.id}" ${p.id === activeId ? 'checked' : ''}> 激活</label>
      <input name="name" placeholder="名称" value="${p.name || ''}">
      <input name="baseUrl" placeholder="baseURL，如 http://127.0.0.1:4000" value="${p.baseUrl || ''}">
      <input name="model" placeholder="模型名" value="${p.model || ''}">
      <input name="apiKey" type="password" placeholder="${p.hasKey ? '已配置（留空不变）' : 'API Key'}" value="">
      <button class="btn" data-del>删除</button>
    </div>`;
}

async function openSettings() {
  const res = await (await fetch('/api/config/providers')).json();
  let { providers, activeProviderId } = res.ok ? res : { providers: [], activeProviderId: null };
  if (!providers.length) providers = [];
  const skillsRes = await (await fetch('/api/skills')).json();
  const skills = skillsRes.ok ? skillsRes.skills : [];
  const mcpRes = await (await fetch('/api/mcp')).json();
  const mcpServers = mcpRes.ok ? (mcpRes.config.servers || {}) : {};
  const mcpStatus = mcpRes.ok ? (mcpRes.status || {}) : {};
  const copilotRes = await (await fetch('/api/copilot/status')).json();
  const copilotLoggedIn = copilotRes.ok && copilotRes.loggedIn;

  const mcpRow = (name, s) => {
    const st = mcpStatus[name];
    const stText = st?.ok ? `✓ ${st.toolCount} 个工具` : st?.disabled ? '已停用' : st?.error ? `✗ ${st.error}` : '';
    return `
    <div class="mcp-row" data-name="${name || ''}">
      <input name="mcpName" placeholder="服务名" value="${name || ''}">
      <select name="mcpType">
        <option value="stdio" ${s.type !== 'http' ? 'selected' : ''}>stdio</option>
        <option value="http" ${s.type === 'http' ? 'selected' : ''}>http</option>
      </select>
      <input name="mcpCommand" placeholder="命令（stdio）" value="${s.command || ''}" style="${s.type === 'http' ? 'display:none' : ''}">
      <input name="mcpArgs" placeholder="参数（空格分隔）" value="${(s.args || []).join(' ')}" style="${s.type === 'http' ? 'display:none' : ''}">
      <input name="mcpUrl" placeholder="URL（http）" value="${s.url || ''}" style="${s.type === 'http' ? '' : 'display:none'}">
      <label class="mcp-enabled"><input type="checkbox" name="mcpEnabled" ${s.enabled !== false ? 'checked' : ''}> 启用</label>
      <span class="mcp-status">${stText}</span>
      <button class="btn" data-del>删除</button>
    </div>`;
  };

  const { overlay, onSave } = openModal('设置', `
    <h4 class="settings-h">LLM Provider</h4>
    <div id="provider-list">${providers.map(p => providerRow(p, activeProviderId)).join('')}</div>
    <button class="btn" id="add-provider" style="margin-top:10px">+ 添加 endpoint</button>
    <h4 class="settings-h">Skills 技能</h4>
    <div id="skill-list">
      ${skills.length ? skills.map(s => `
        <div class="skill-row">
          <label><input type="checkbox" data-skill="${s.name}" ${s.enabled ? 'checked' : ''}> <b>${s.name}</b></label>
          <span class="skill-desc">${s.description}</span>
        </div>`).join('') : '<div class="placeholder">暂无技能，导入 .md 文件即可添加</div>'}
    </div>
    <button class="btn" id="import-skill" style="margin-top:10px">导入技能 .md</button>
    <input type="file" id="skill-file-input" accept=".md" hidden>
    <h4 class="settings-h">MCP 服务</h4>
    <div id="mcp-list">${Object.entries(mcpServers).map(([n, s]) => mcpRow(n, s)).join('')}</div>
    <button class="btn" id="add-mcp" style="margin-top:10px">+ 添加 MCP 服务</button>
    <h4 class="settings-h">GitHub Copilot</h4>
    <div id="copilot-box">
      <div class="copilot-status">${copilotLoggedIn ? '✓ 已登录（可作为 provider 激活）' : '未登录'}</div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn" id="copilot-login" ${copilotLoggedIn ? 'disabled' : ''}>设备码登录</button>
        <button class="btn" id="copilot-logout" ${copilotLoggedIn ? '' : 'disabled'}>登出</button>
      </div>
      <div id="copilot-device" class="hidden" style="margin-top:8px"></div>
      <p class="hint" style="margin-top:6px;color:var(--text-dim);font-size:12px">
        使用 GitHub 非公开 API 方案（同灵犀 Codex 现状），政策变动可能导致失效。登录成功后请保存本设置并激活 copilot provider。
      </p>
    </div>
    <p class="hint" style="margin-top:10px;color:var(--text-dim);font-size:12px">
      默认预填本机 OpenAI 兼容端点（127.0.0.1:4000）。
    </p>`);
  overlay.querySelector('.modal').style.width = '720px';

  const list = overlay.querySelector('#provider-list');
  overlay.querySelector('#add-provider').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = providerRow({ id: 'p' + Date.now().toString(36), name: '', baseUrl: '', model: '' }, null);
    const row = div.firstElementChild;
    bindDel(row);
    list.appendChild(row);
  });
  const bindDel = (row) => row.querySelector('[data-del]').addEventListener('click', () => row.remove());
  list.querySelectorAll('.provider-row').forEach(bindDel);

  // 技能启停即时生效（无需点保存）
  overlay.querySelectorAll('[data-skill]').forEach(cb => {
    cb.addEventListener('change', () => {
      fetch('/api/skills/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cb.dataset.skill, enabled: cb.checked }),
      });
    });
  });
  // 导入技能
  const skillFileInput = overlay.querySelector('#skill-file-input');
  overlay.querySelector('#import-skill').addEventListener('click', () => skillFileInput.click());
  skillFileInput.addEventListener('change', async () => {
    const file = skillFileInput.files[0];
    if (!file) return;
    const content = await file.text();
    await fetch('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, content }),
    });
    overlay.remove();
    openSettings(); // 重开刷新列表
  });

  // MCP：类型切换显示对应字段；删除行
  const mcpList = overlay.querySelector('#mcp-list');
  const bindMcpRow = (row) => {
    const typeSel = row.querySelector('[name=mcpType]');
    const toggleFields = () => {
      const isHttp = typeSel.value === 'http';
      row.querySelector('[name=mcpCommand]').style.display = isHttp ? 'none' : '';
      row.querySelector('[name=mcpArgs]').style.display = isHttp ? 'none' : '';
      row.querySelector('[name=mcpUrl]').style.display = isHttp ? '' : 'none';
    };
    typeSel.addEventListener('change', toggleFields);
    row.querySelector('[data-del]').addEventListener('click', () => row.remove());
  };
  mcpList.querySelectorAll('.mcp-row').forEach(bindMcpRow);
  overlay.querySelector('#add-mcp').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = mcpRow('', {});
    const row = div.firstElementChild;
    bindMcpRow(row);
    mcpList.appendChild(row);
  });

  // Copilot 设备码登录
  const deviceBox = overlay.querySelector('#copilot-device');
  overlay.querySelector('#copilot-login')?.addEventListener('click', async () => {
    const r = await (await fetch('/api/copilot/login/start', { method: 'POST' })).json();
    if (!r.ok) { deviceBox.className = ''; deviceBox.textContent = '发起失败: ' + (r.message || r.error); return; }
    deviceBox.className = '';
    deviceBox.innerHTML = `请打开 <a href="${r.verificationUri}" target="_blank">${r.verificationUri}</a> 并输入验证码：<b style="font-size:16px">${r.userCode}</b><br><span id="copilot-poll-state">等待授权…</span>`;
    const timer = setInterval(async () => {
      const p = await (await fetch('/api/copilot/login/poll', { method: 'POST' })).json();
      if (p.status === 'ok') {
        clearInterval(timer);
        deviceBox.innerHTML = '✓ 登录成功！已自动添加 copilot provider，点「保存」生效。';
        // 自动补一行 copilot provider 并选中激活
        if (![...overlay.querySelectorAll('.provider-row')].some(row => row.dataset.id === 'copilot')) {
          const div = document.createElement('div');
          div.innerHTML = providerRow({ id: 'copilot', name: 'GitHub Copilot', baseUrl: '(api.githubcopilot.com)', model: 'gpt-4o' }, null);
          const row = div.firstElementChild;
          row.dataset.type = 'copilot';
          row.querySelector('[name=baseUrl]').disabled = true;
          row.querySelector('[name=apiKey]').remove();
          bindDel(row);
          list.appendChild(row);
        }
      } else if (p.status === 'error') {
        clearInterval(timer);
        deviceBox.textContent = '登录失败: ' + p.message;
      }
    }, 5500);
  });
  overlay.querySelector('#copilot-logout')?.addEventListener('click', async () => {
    await fetch('/api/copilot/logout', { method: 'POST' });
    overlay.remove();
    openSettings();
  });

  onSave(async (ov) => {
    const rows = [...ov.querySelectorAll('.provider-row')];
    const providers = rows.map(row => ({
      id: row.dataset.id,
      name: row.querySelector('[name=name]').value.trim(),
      type: row.dataset.type || 'openai-compat',
      baseUrl: row.querySelector('[name=baseUrl]').value.trim(),
      model: row.querySelector('[name=model]').value.trim(),
      apiKey: row.querySelector('[name=apiKey]')?.value, // 空 = 服务端沿用原值
    })).filter(p => p.baseUrl || p.type === 'copilot');
    const active = ov.querySelector('[name=activeProvider]:checked')?.value || providers[0]?.id;
    await fetch('/api/config/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers, activeProviderId: active }),
    });
    // MCP 配置一并保存（服务端会重连）
    const servers = {};
    for (const row of ov.querySelectorAll('.mcp-row')) {
      const name = row.querySelector('[name=mcpName]').value.trim();
      if (!name) continue;
      const type = row.querySelector('[name=mcpType]').value;
      servers[name] = {
        type,
        enabled: row.querySelector('[name=mcpEnabled]').checked,
        ...(type === 'http'
          ? { url: row.querySelector('[name=mcpUrl]').value.trim() }
          : { command: row.querySelector('[name=mcpCommand]').value.trim(), args: row.querySelector('[name=mcpArgs]').value.trim().split(/\s+/).filter(Boolean) }),
      };
    }
    await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { servers } }),
    });
    ov.remove();
    window.dispatchEvent(new CustomEvent('providers-changed'));
  });
}

export function initSettings() {
  document.getElementById('btn-settings').disabled = false;
  document.getElementById('btn-settings').addEventListener('click', openSettings);
}
