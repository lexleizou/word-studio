// 右栏对话：流式输出 + 工具时间轴 + diff 确认卡 + 选区 chip（选区由 selection.js 维护）
import * as model from './model.js';

// 解析 SSE 流（fetch ReadableStream 版）
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const event = /event: (.+)/.exec(part)?.[1];
      const data = /data: ([\s\S]+)/.exec(part)?.[1];
      if (event && data) {
        try { onEvent(event, JSON.parse(data)); } catch { /* 忽略坏包 */ }
      }
    }
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// onModelUpdated(): AI 改动落盘后重载文档
export function initChat(onModelUpdated) {
  const stream = document.getElementById('chat-stream');
  const input = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnMention = document.getElementById('btn-mention');
  const popup = document.getElementById('mention-popup');
  const chipsBox = document.getElementById('ref-chips');
  const refFileInput = document.getElementById('ref-file-input');
  let busy = false;
  let pendingRefs = []; // 待发送的引用 [{id, name}]

  model.subscribe('docModel', (m) => {
    input.disabled = !m;
    btnSend.disabled = !m;
    btnMention.disabled = !m;
    if (m && stream.querySelector('.placeholder')) stream.innerHTML = '';
    if (!m) { pendingRefs = []; renderChips(); }
  });

  // ---------- @ 引用 ----------
  function renderChips() {
    chipsBox.innerHTML = pendingRefs.map((r, i) =>
      `<span class="chip ref-chip">${escapeHtml(r.name)}<button class="chip-close" data-i="${i}">×</button></span>`).join('');
    chipsBox.querySelectorAll('.chip-close').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingRefs.splice(Number(btn.dataset.i), 1);
        renderChips();
      });
    });
  }

  async function openMentionPopup() {
    const doc = model.get('doc');
    if (!doc) return;
    const res = await fetch(`/api/docs/${doc.id}/refs`);
    const { refs } = await res.json();
    popup.innerHTML =
      (refs || []).map(r => `<div class="mention-item" data-id="${r.id}" data-name="${escapeHtml(r.name)}">📄 ${escapeHtml(r.name)}<span class="mention-meta">${r.isImage ? '图片' : r.chars + ' 字'}</span></div>`).join('') +
      '<div class="mention-item upload" data-upload="1">⬆ 上传新文件…</div>';
    popup.classList.remove('hidden');
    popup.querySelectorAll('.mention-item').forEach(item => {
      item.addEventListener('click', () => {
        popup.classList.add('hidden');
        if (item.dataset.upload) { refFileInput.click(); return; }
        if (!pendingRefs.some(r => r.id === item.dataset.id)) {
          pendingRefs.push({ id: item.dataset.id, name: item.dataset.name });
          renderChips();
        }
      });
    });
  }
  btnMention.addEventListener('click', openMentionPopup);
  document.addEventListener('click', (e) => {
    if (!popup.contains(e.target) && e.target !== btnMention) popup.classList.add('hidden');
  });
  refFileInput.addEventListener('change', async () => {
    const file = refFileInput.files[0];
    refFileInput.value = '';
    const doc = model.get('doc');
    if (!file || !doc) return;
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/docs/${doc.id}/refs`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) {
      pendingRefs.push({ id: data.ref.id, name: data.ref.name });
      renderChips();
    } else {
      addMsg('error', '上传失败: ' + (data.message || data.error));
    }
  });

  function addMsg(role, text) {
    const msg = el('div', `chat-msg ${role}`, text);
    stream.appendChild(msg);
    stream.scrollTop = stream.scrollHeight;
    return msg;
  }

  function addTimeline(name) {
    const item = el('div', 'tool-item', `⚙ ${name}`);
    stream.appendChild(item);
    stream.scrollTop = stream.scrollHeight;
  }

  function addProposalCard(ev) {
    const card = el('div', 'proposal-card');
    card.appendChild(el('div', 'proposal-title', `提案：${ev.summary}`));
    const diffBox = el('div', 'diff-box');
    for (const c of ev.diff.slice(0, 12)) {
      const label = { add: '新增', modify: '修改', remove: '删除', styles: '样式表', pageSetup: '页面设置' }[c.type] || c.type;
      const row = el('div', `diff-row ${c.type}`);
      row.appendChild(el('span', 'diff-tag', label));
      const body = el('div', 'diff-body');
      if (c.before) body.appendChild(el('div', 'diff-before', c.before.slice(0, 120)));
      if (c.after) body.appendChild(el('div', 'diff-after', c.after.slice(0, 120)));
      row.appendChild(body);
      diffBox.appendChild(row);
    }
    if (ev.diff.length > 12) diffBox.appendChild(el('div', 'diff-more', `…共 ${ev.diff.length} 处变化`));
    card.appendChild(diffBox);
    const btns = el('div', 'proposal-btns');
    const ok = el('button', 'btn primary', '确认落盘');
    const no = el('button', 'btn', '拒绝');
    btns.appendChild(ok);
    btns.appendChild(no);
    card.appendChild(btns);
    stream.appendChild(card);
    stream.scrollTop = stream.scrollHeight;

    const decide = async (accept) => {
      ok.disabled = no.disabled = true;
      await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: ev.proposalId, accept }),
      });
      card.classList.add(accept ? 'accepted' : 'rejected');
      btns.remove();
    };
    ok.addEventListener('click', () => decide(true));
    no.addEventListener('click', () => decide(false));
  }

  async function send() {
    const text = input.value.trim();
    const doc = model.get('doc');
    if (!text || !doc || busy) return;
    busy = true;
    btnSend.disabled = true;
    input.value = '';
    const refNames = pendingRefs.map(r => r.name);
    addMsg('user', text + (refNames.length ? `\n📎 ${refNames.join('、')}` : ''));
    const refIds = pendingRefs.map(r => r.id);
    pendingRefs = [];
    renderChips();
    const assistant = addMsg('assistant', '');
    const sel = model.get('selection');

    try {
      const res = await fetch(`/api/docs/${doc.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, selection: sel, refIds }),
      });
      await readSSE(res, (event, data) => {
        switch (event) {
          case 'delta':
            assistant.textContent += data.text;
            stream.scrollTop = stream.scrollHeight;
            break;
          case 'tool':
            addTimeline(data.name);
            break;
          case 'proposal':
            addProposalCard(data);
            break;
          case 'applied':
            addTimeline(`✓ ${data.message}`);
            onModelUpdated();
            break;
          case 'rejected':
            addTimeline(`✗ 已拒绝：${data.summary}`);
            break;
          case 'error':
            addMsg('error', data.message);
            break;
          case 'done':
            break;
        }
      });
    } catch (err) {
      addMsg('error', '请求失败: ' + err.message);
    }
    busy = false;
    btnSend.disabled = false;
    input.focus();
  }

  btnSend.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}
