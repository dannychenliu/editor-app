/* ============================================================
   AI Novel Editor — src/app.js
   React 18 via CDN (no build step)
   ============================================================ */

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Constants ────────────────────────────────────────────────
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LS_KEY = 'novel_editor_v3';

const FALLBACK_MODELS = [
  { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'deepseek/deepseek-r2', name: 'DeepSeek R2' },
];

const DEFAULT_MODEL_ID = FALLBACK_MODELS[0].id;

// ── Helpers ──────────────────────────────────────────────────
function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function parseAgentMd(content, filename) {
  const lines = content.split('\n');
  const firstLine = lines[0].trim();
  const name = firstLine.startsWith('#')
    ? firstLine.replace(/^#+\s*/, '')
    : filename;
  const prompt = lines.slice(1).join('\n').trim();
  return { name, prompt };
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { }
  return null;
}

function saveState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (_) { }
}

// modelId is now per-tab
function makeTab(agentId, agentName, modelId) {
  return {
    id: genId(),
    agentId: agentId || null,
    agentName: agentName || '新對話',
    modelId: modelId || DEFAULT_MODEL_ID,
    temperature: 0.7,
    messages: [],
    field1: '',
    targetText: '',
    field2: '',
    wordCount: '',
    field1Enabled: false,   // ← 預設關閉
    streaming: false,
  };
}

// ── Toast hook ───────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((msg, type = 'info', duration = 8000) => {
    const id = genId();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);
  return { toasts, show };
}

// ── Main App ─────────────────────────────────────────────────
function App() {
  const { toasts, show: toast } = useToast();

  const [apiKey, setApiKey] = useState('');
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [globalPrompt, setGlobalPrompt] = useState('');
  const [agents, setAgents] = useState([]);
  const [models, setModels] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState('');

  // per-tab model dropdown UI state
  const [openDropTabId, setOpenDropTabId] = useState(null);
  const [modelQuery, setModelQuery] = useState('');
  const [favoriteModels, setFavoriteModels] = useState([]);
  const [dragOverTabId, setDragOverTabId] = useState(null);

  // abortRef is a Map: tabId -> AbortController
  const abortMap = useRef({});
  const chatEndRef = useRef(null);
  const dropRef = useRef(null);

  // ── Init ──────────────────────────────────────────────────
  useEffect(() => {
    const saved = loadState();
    if (saved?.tabs?.length) {
      setTabs(saved.tabs.map(t => ({ ...t, streaming: false, temperature: t.temperature ?? 0.7 })));
      setActiveTabId(saved.activeTabId || saved.tabs[0]?.id || '');
    }
    if (saved?.favoriteModels) setFavoriteModels(saved.favoriteModels);
    initApp();
  }, []);

  async function initApp() {
    await fetchKey();
    await fetchAgents();
    await fetchModels();
  }

  async function fetchKey() {
    try {
      const res = await fetch('./key.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.openrouter_api_key && data.openrouter_api_key.startsWith('sk-or-')) {
        setApiKey(data.openrouter_api_key);
      }
    } catch (_) {
      // key.json 不存在或格式錯誤，稍後可透過 UI 手動輸入
    }
    // 無論 key.json 是否成功，都檢查 localStorage 是否有手動設定的 key
    const storedKey = localStorage.getItem('novel_editor_api_key');
    if (storedKey) {
      setApiKey(storedKey);
    } else if (!apiKey) {
      // 兩邊都沒有 key，彈出視窗讓使用者輸入
      setShowKeyModal(true);
    }
  }

  async function fetchAgents() {
    let list = [];
    try {
      const res = await fetch('./prompt-agents/list.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      list = await res.json();
    } catch (e) {
      toast('❌ 無法讀取 prompt-agents/list.json', 'error');
      return;
    }

    try {
      const res = await fetch('./prompt-agents/global_prompt.md');
      if (res.ok) setGlobalPrompt(await res.text());
    } catch (_) { }

    const loaded = [];
    await Promise.all(list.map(async (name) => {
      try {
        const res = await fetch(`./prompt-agents/${name}.md`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const parsed = parseAgentMd(text, name);
        loaded.push({ id: name, name: parsed.name, prompt: parsed.prompt });
      } catch (_) {
        toast(`⚠️ 無法載入 Agent：${name}`, 'warn');
      }
    }));

    const ordered = list.map(n => loaded.find(a => a.id === n)).filter(Boolean);
    setAgents(ordered);

    setTabs(prev => {
      if (prev.length === 0 && ordered.length > 0) {
        const newTabs = ordered.map(a => makeTab(a.id, a.name));
        setActiveTabId(newTabs[0].id);
        return newTabs;
      }
      return prev;
    });
  }

  async function fetchModels(showReloadMsg = false) {
    try {
      const res = await fetch(MODELS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = (data.data || [])
        .filter(m => m.id)
        .map(m => ({ id: m.id, name: m.name || m.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setModels(list);
      if (showReloadMsg) toast('✅ 模型清單已更新', 'info');
    } catch (e) {
      setModels(FALLBACK_MODELS);
      if (showReloadMsg) toast('❌ 無法獲取模型清單，使用預設清單', 'error');
      else toast('⚠️ 模型清單獲取失敗，已載入預設模型', 'warn');
    }
  }

  // ── Persist ───────────────────────────────────────────────
  useEffect(() => {
    if (tabs.length > 0) {
      saveState({ tabs, activeTabId, favoriteModels });
    }
  }, [tabs, activeTabId, favoriteModels]);

  // ── Auto-scroll ───────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [tabs, activeTabId]);

  // ── Close dropdown on outside click ───────────────────────
  useEffect(() => {
    function handler(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setOpenDropTabId(null);
        setModelQuery('');
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Tab helpers ───────────────────────────────────────────
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId]);

  function updateTab(id, patch) {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }

  function newTab() {
    const firstAgent = agents[0];
    // inherit model from active tab
    const inheritModel = activeTab?.modelId || DEFAULT_MODEL_ID;
    const tab = makeTab(firstAgent?.id, firstAgent?.name || '新對話', inheritModel);
    setTabs(prev => [tab, ...prev]);
    setActiveTabId(tab.id);
  }

  function closeTab(id, e) {
    e.stopPropagation();
    abortMap.current[id]?.abort();
    delete abortMap.current[id];
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (next.length === 0) {
        const fresh = makeTab(agents[0]?.id, agents[0]?.name || '新對話');
        setActiveTabId(fresh.id);
        return [fresh];
      }
      if (activeTabId === id) setActiveTabId(next[next.length - 1].id);
      return next;
    });
  }

  function moveTab(fromId, toId) {
    if (fromId === toId) return;
    setTabs(prev => {
      const fromIdx = prev.findIndex(t => t.id === fromId);
      const toIdx = prev.findIndex(t => t.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }

  function resetToDefault() {
    if (!confirm('確定要還原預設分頁？\n此操作將刪除所有目前分頁，並依照 Agent 清單重建。')) return;
    abortMap.current = {};
    const ordered = agents;
    if (ordered.length === 0) return;
    const newTabs = ordered.map(a => makeTab(a.id, a.name));
    setTabs(newTabs);
    setActiveTabId(newTabs[0].id);
  }

// ── Model dropdown helpers ─────────────────────────────────
  function getFilteredModels() {
    const q = modelQuery.toLowerCase();
    const list = q
      ? models.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      : [...models];
    const favs = list.filter(m => favoriteModels.includes(m.id));
    const rest = list.filter(m => !favoriteModels.includes(m.id));
    return [...favs, ...rest];
  }

  function toggleFavorite(modelId) {
    setFavoriteModels(prev => prev.includes(modelId) ? prev.filter(id => id !== modelId) : [...prev, modelId]);
  }

  // ── Send (per-tab, parallel-capable) ─────────────────────
  async function handleSend(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || tab.streaming) return;

    const { field1, targetText, field2, wordCount, field1Enabled, agentId, modelId } = tab;
    if (!field2.trim() && !(field1Enabled && field1.trim())) return;
    if (!apiKey) { toast('❌ 尚未設定 API Key，請點擊左上角 🔑 按鈕設定', 'error'); return; }

    const agent = agents.find(a => a.id === agentId);
    const systemMsg = [globalPrompt, agent?.prompt || ''].filter(Boolean).join('\n\n');

    const isRewriteAgent = ['改寫', '縮減', '精簡', '擴寫'].some(kw => agent?.name?.includes(kw));

    let userContent = '';
    if (field1Enabled && field1.trim()) {
      userContent += `以下為短篇小說內文：\n${field1.trim()}\n\n`;
    }
    if (isRewriteAgent && targetText?.trim()) {
      userContent += `以下為修改目標：\n${targetText.trim()}\n\n`;
    }
    if (field2.trim()) {
      if (userContent) userContent += '\n\n';
      userContent += `以下為指示：\n${field2.trim()}`;
    }
    if (wordCount?.trim()) {
      userContent += `\n\n你的字數目標是${wordCount.trim()}`;
    }

    // ── Console log ──────────────────────────────────────────
    console.group(`%c[Novel Editor] Tab: ${tab.agentName} | Model: ${modelId}`, 'color: #7c3aed; font-weight: bold;');
    console.log('%c── SYSTEM ──', 'color: #6b7280; font-weight: bold;');
    console.log(systemMsg);
    console.log('%c── USER ──', 'color: #2563eb; font-weight: bold;');
    console.log(userContent);
    console.log('%c── FULL PAYLOAD ──', 'color: #16a34a; font-weight: bold;');
    console.log({
      model: modelId,
      temperature: tab.temperature ?? 0.7,
      stream: true,
      messages: [
        { role: 'system', content: systemMsg },
        ...tab.messages.filter(m => !m._streaming).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userContent },
      ],
    });
    console.groupEnd();
    // ─────────────────────────────────────────────────────────

    const userMsg = { role: 'user', content: userContent, _display: { field1: field1Enabled ? field1 : '', targetText: isRewriteAgent ? targetText : '', field2, wordCount } };
    const aiId = genId();

    setTabs(prev => prev.map(t => t.id === tabId ? {
      ...t,
      streaming: true,
      field2: '',
      targetText: '',
      wordCount: '',          // ← 送出後清空目標字數
      field1Enabled: false,   // ← 送出後自動關閉原文
      messages: [...t.messages, userMsg, { role: 'assistant', content: '', _id: aiId, _streaming: true }],
    } : t));

    const ctrl = new AbortController();
    abortMap.current[tabId] = ctrl;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': window.location.href,
          'X-Title': 'AI Novel Editor',
        },
        body: JSON.stringify({
          model: modelId,
          temperature: tab.temperature ?? 0.7,
          stream: true,
          messages: [
            { role: 'system', content: systemMsg },
            ...tab.messages.filter(m => !m._streaming).map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userContent },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const json = JSON.parse(data);
            if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              setTabs(prev => prev.map(t => t.id !== tabId ? t : {
                ...t,
                messages: t.messages.map(m => m._id === aiId ? { ...m, content: accumulated } : m),
              }));
            }
          } catch (parseErr) {
            if (!parseErr.message?.includes('JSON')) throw parseErr;
          }
        }
      }

      // finalize
      setTabs(prev => prev.map(t => t.id !== tabId ? t : {
        ...t,
        streaming: false,
        messages: t.messages.map(m => m._id === aiId ? { ...m, _streaming: false } : m),
      }));

    } catch (e) {
      if (e.name === 'AbortError') {
        setTabs(prev => prev.map(t => t.id !== tabId ? t : {
          ...t,
          streaming: false,
          messages: t.messages.map(m => m._id === aiId ? { ...m, _streaming: false } : m),
        }));
      } else {
        toast(`❌ [${tab.agentName}] API 錯誤：${e.message}`, 'error');
        setTabs(prev => prev.map(t => t.id !== tabId ? t : {
          ...t,
          streaming: false,
          messages: t.messages.filter(m => m._id !== aiId),
        }));
      }
    } finally {
      delete abortMap.current[tabId];
    }
  }

  function handleStop(tabId) {
    abortMap.current[tabId]?.abort();
  }

  function handleKeyDown(e, tabId) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      const tab = tabs.find(t => t.id === tabId);
      if (tab && !tab.streaming) handleSend(tabId);
    }
  }

  // ── Render ─────────────────────────────────────────────────
  return React.createElement(React.Fragment, null,

    // Sidebar
    React.createElement('aside', { className: 'sidebar' },
      React.createElement('div', { className: 'sidebar-header' },
        React.createElement('div', { className: 'sidebar-logo' }, '✍️'),
        React.createElement('div', { className: 'sidebar-title-wrap' },
          React.createElement('div', { className: 'sidebar-title-row' },
            React.createElement('div', { className: 'sidebar-title' }, 'Novel Editor'),
            React.createElement('button', {
              className: `key-btn ${apiKey ? 'has-key' : ''}`,
              onClick: () => setShowKeyModal(true),
              title: apiKey ? '🔑 API Key 已設定 — 點擊編輯' : '🔑 設定 API Key',
            }, '🔑'),
          ),
          React.createElement('div', { className: 'sidebar-subtitle' }, 'AI 小說助手'),
        ),
      ),
      React.createElement('button', { className: 'sidebar-new-btn', onClick: newTab, id: 'btn-new-tab' },
        '＋ 新增對話'
      ),
      React.createElement('div', { className: 'sidebar-section' },
        React.createElement('span', null, '對話分頁'),
        React.createElement('button', {
          className: 'reset-default-btn',
          onClick: resetToDefault,
          title: '還原為預設分頁',
        }, '↺'),
      ),
      React.createElement('div', { className: 'tab-list' },
        tabs.map(tab =>
          React.createElement('div', {
            key: tab.id,
            className: `tab-item ${tab.id === activeTabId ? 'active' : ''} ${dragOverTabId === tab.id ? 'drag-over' : ''}`,
            onClick: () => setActiveTabId(tab.id),
            onDragOver: e => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOverTabId(tab.id);
            },
            onDragLeave: e => {
              if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget)) {
                setDragOverTabId(null);
              }
            },
            onDrop: e => {
              e.preventDefault();
              const fromId = e.dataTransfer.getData('text/plain');
              if (fromId) moveTab(fromId, tab.id);
              setDragOverTabId(null);
            },
          },
            React.createElement('span', {
              className: 'tab-drag-handle',
              draggable: true,
              onDragStart: e => {
                e.stopPropagation();
                e.dataTransfer.setData('text/plain', tab.id);
                e.dataTransfer.effectAllowed = 'move';
              },
              onDragEnd: () => setDragOverTabId(null),
              onClick: e => e.stopPropagation(),
              title: '長按拖曳調整順序',
            }, '⠿'),
            React.createElement('span', { className: 'tab-item-icon' }, tab.streaming ? '⏳' : '📄'),
            React.createElement('div', { className: 'tab-item-info' },
              React.createElement('div', { className: 'tab-item-name' }, tab.agentName || '新對話'),
              React.createElement('div', { className: 'tab-item-model' }, models.find(m => m.id === tab.modelId)?.name || '請選擇模型')
            ),
            React.createElement('button', {
              className: 'tab-item-close',
              onClick: e => closeTab(tab.id, e),
              title: '關閉',
            }, '✕'),
          )
        ),
      ),
    ),

    // Main
    React.createElement('div', { className: 'main' },

      // Header removed per request

      // Chat area
      React.createElement('div', { className: 'chat-area' },
        React.createElement('div', { className: 'chat-inner' },
          !activeTab || activeTab.messages.length === 0
            ? React.createElement('div', { className: 'empty-state' },
              React.createElement('div', { className: 'empty-state-icon' }, '✍️'),
              React.createElement('h2', null, '開始你的創作'),
              React.createElement('p', null, '在下方輸入指示，選擇 Agent 與 AI 模型後按送出，AI 將協助你潤飾、續寫或分析文字。'),
            )
            : (activeTab.messages || []).map((msg, i) =>
              msg.role === 'user'
                ? React.createElement(UserBubble, { key: i, msg })
                : React.createElement(AiBubble, { key: i, msg, toast })
            ),
          React.createElement('div', { ref: chatEndRef }),
        ),
      ),

      // Input panel
      React.createElement('div', { className: 'input-panel' },
        React.createElement('div', { className: 'input-panel-inner' },

          // Controls row: Agent + Model dropdown + Switch
          React.createElement('div', { className: 'input-controls' },

            // Agent select
            React.createElement('select', {
              className: 'agent-select',
              value: activeTab?.agentId || '',
              onChange: e => {
                const a = agents.find(x => x.id === e.target.value);
                if (a) updateTab(activeTabId, { agentId: a.id, agentName: a.name });
              },
              id: 'agent-select',
            },
              agents.length === 0
                ? React.createElement('option', null, '載入中...')
                : agents.map(a => React.createElement('option', { key: a.id, value: a.id }, a.name)),
            ),

            // Per-tab Model dropdown
            React.createElement('div', { className: 'model-dropdown-wrap', ref: dropRef },
              React.createElement('button', {
                className: 'model-badge',
                onClick: () => {
                  setOpenDropTabId(prev => prev === activeTabId ? null : activeTabId);
                  setModelQuery('');
                },
                id: 'btn-model-select',
                title: activeTab?.modelId || '選擇模型',
              },
                '🤖 ',
                (() => {
                  const m = models.find(x => x.id === activeTab?.modelId);
                  return m ? m.name : (activeTab?.modelId || '選擇模型');
                })(),
              ),
              openDropTabId === activeTabId && React.createElement('div', { className: 'model-dropdown' },
                React.createElement('div', { style: { padding: '8px' } },
                  React.createElement('input', {
                    className: 'model-search-input',
                    placeholder: '搜尋模型...',
                    value: modelQuery,
                    onChange: e => setModelQuery(e.target.value),
                    autoFocus: true,
                    style: { width: '100%' },
                  })
                ),
                getFilteredModels().map(m =>
                  React.createElement('div', {
                    key: m.id,
                    className: `model-option ${m.id === activeTab?.modelId ? 'selected' : ''}`,
                    onClick: () => {
                      updateTab(activeTabId, { modelId: m.id });
                      setOpenDropTabId(null);
                      setModelQuery('');
                    },
                  },
                    React.createElement('span', {
                      className: `model-star ${favoriteModels.includes(m.id) ? 'active' : ''}`,
                      onClick: e => { e.stopPropagation(); toggleFavorite(m.id); },
                    }, favoriteModels.includes(m.id) ? '★' : '☆'),
                    React.createElement('div', { style: { flex: 1 } },
                      React.createElement('div', null, m.name),
                      React.createElement('div', { className: 'model-option-id' }, m.id),
                    ),
                  )
                ),
              ),
            ),

            // Temperature dropdown
            React.createElement('select', {
              className: 'temp-select',
              value: activeTab?.temperature ?? 0.7,
              onChange: e => updateTab(activeTabId, { temperature: parseFloat(e.target.value) }),
              title: '嚴謹：0.2 | 普通：0.7 | 發想：1.0',
            },
              React.createElement('option', { value: 0.2 }, '🎯 嚴謹'),
              React.createElement('option', { value: 0.7 }, '✏️ 普通'),
              React.createElement('option', { value: 1.0 }, '💡 發想'),
            ),

            // Field1 switch
            React.createElement('label', { className: 'switch-wrap' },
              React.createElement('span', null, '原文'),
              React.createElement('div', { className: 'switch' },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: activeTab?.field1Enabled ?? false,
                  onChange: e => updateTab(activeTabId, { field1Enabled: e.target.checked }),
                  id: 'toggle-field1',
                }),
                React.createElement('div', { className: 'switch-track' }),
                React.createElement('div', { className: 'switch-thumb' }),
              ),
            ),

            // Clear Chat Button (Moved to rightmost side)
            React.createElement('button', {
              className: 'clear-chat-btn',
              onClick: () => updateTab(activeTabId, { messages: [] }),
              title: '清空並移除此分頁所有對話紀錄',
              style: { marginLeft: 'auto', position: 'static' },
            }, '🗑️ 清除聊天'),
          ),

          // Textareas
          React.createElement('div', { className: 'textareas-wrap' },
            activeTab?.field1Enabled && React.createElement('div', { className: 'field1-wrap' },
              React.createElement('textarea', {
                className: 'textarea-field1',
                placeholder: '貼上小說原文（作為 AI 的參考背景）...',
                value: activeTab?.field1 || '',
                onChange: e => updateTab(activeTabId, { field1: e.target.value }),
                onKeyDown: e => handleKeyDown(e, activeTabId),
                id: 'textarea-field1',
              })
            ),
            (() => {
              const a = agents.find(x => x.id === activeTab?.agentId);
              const isRewrite = a && ['改寫', '縮減', '精簡', '擴寫'].some(kw => a.name.includes(kw));
              return isRewrite ? React.createElement('textarea', {
                className: 'textarea-target',
                placeholder: '修改目標段落...',
                value: activeTab?.targetText || '',
                onChange: e => updateTab(activeTabId, { targetText: e.target.value }),
                onKeyDown: e => handleKeyDown(e, activeTabId),
              }) : null;
            })(),
            React.createElement('textarea', {
              className: 'textarea-field2',
              placeholder: '輸入指示（例如：讓這段描寫更有詩意）…   Cmd+Enter 送出',
              value: activeTab?.field2 || '',
              onChange: e => updateTab(activeTabId, { field2: e.target.value }),
              onKeyDown: e => handleKeyDown(e, activeTabId),
              id: 'textarea-field2',
            }),
          ),

          // Bottom row
          React.createElement('div', { className: 'input-bottom' },
            React.createElement('span', { className: 'input-hint' },
              activeTab?.streaming ? '⏳ 生成中...' : 'Cmd + Enter 送出'
            ),
            React.createElement('div', { className: 'bottom-actions' },
              React.createElement('input', {
                type: 'number',
                className: 'word-count-input',
                placeholder: '目標字數',
                value: activeTab?.wordCount || '',
                onChange: e => updateTab(activeTabId, { wordCount: e.target.value }),
                onKeyDown: e => handleKeyDown(e, activeTabId),
              }),
              activeTab?.streaming
                ? React.createElement('button', {
                  className: 'send-btn stop',
                  onClick: () => handleStop(activeTabId),
                  id: 'btn-stop',
                }, '⏹ 停止')
                : React.createElement('button', {
                  className: 'send-btn send',
                  onClick: () => handleSend(activeTabId),
                  disabled: !activeTab?.field2?.trim() && !(activeTab?.field1Enabled && activeTab?.field1?.trim()),
                  id: 'btn-send',
                }, '送出 ↑'),
            ),
          ),
        ),
      ),
    ),

    // Toast
    React.createElement('div', { className: 'toast-container' },
      toasts.map(t =>
        React.createElement('div', { key: t.id, className: `toast ${t.type}` }, t.msg)
      ),
    ),

    // Key Modal
    showKeyModal && React.createElement(KeyModal, {
      apiKey,
      onSave: (key) => {
        setApiKey(key);
        localStorage.setItem('novel_editor_api_key', key);
        setShowKeyModal(false);
        if (key) toast('✅ API Key 已儲存', 'success');
      },
      onClose: () => {
        if (!apiKey) {
          toast('⚠️ 尚未設定 API Key，部分功能無法使用', 'warn');
        }
        setShowKeyModal(false);
      },
    }),
  );
}

// ── KeyModal ──────────────────────────────────────────────────
function KeyModal({ apiKey, onSave, onClose }) {
  const [inputVal, setInputVal] = useState(apiKey || '');
  const [showKey, setShowKey] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSave() {
    const trimmed = inputVal.trim();
    if (trimmed && !trimmed.startsWith('sk-or-')) {
      alert('⚠️ 請輸入有效的 OpenRouter API Key（開頭為 sk-or-）');
      return;
    }
    onSave(trimmed);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') onClose();
  }

  return React.createElement('div', { className: 'modal-overlay', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
    React.createElement('div', { className: 'modal' },
      React.createElement('div', { className: 'modal-header' },
        React.createElement('h3', null, '🔑 API Key 設定'),
        React.createElement('button', { className: 'modal-close', onClick: onClose }, '✕'),
      ),
      React.createElement('div', { className: 'modal-body' },
        React.createElement('p', { className: 'modal-desc' },
          '請輸入你的 OpenRouter API Key。Key 只會儲存在瀏覽器 localStorage 中，不會上傳到任何伺服器。'
        ),
        React.createElement('div', { style: { position: 'relative' } },
          React.createElement('input', {
            ref: inputRef,
            className: 'modal-input',
            type: showKey ? 'text' : 'password',
            placeholder: 'sk-or-v1-...',
            value: inputVal,
            onChange: e => setInputVal(e.target.value),
            onKeyDown: handleKeyDown,
          }),
          React.createElement('button', {
            onClick: () => setShowKey(prev => !prev),
            style: {
              position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--text-3)', padding: '4px',
            },
            title: showKey ? '隱藏 Key' : '顯示 Key',
          }, showKey ? '🙈' : '👁️'),
        ),
      ),
      React.createElement('div', { className: 'modal-footer' },
        React.createElement('button', {
          className: 'modal-btn modal-btn-secondary',
          onClick: onClose,
        }, apiKey ? '取消' : '略過'),
        React.createElement('button', {
          className: 'modal-btn modal-btn-primary',
          onClick: handleSave,
        }, '儲存'),
      ),
    ),
  );
}

// ── UserBubble ───────────────────────────────────────────────
function UserBubble({ msg }) {
  const { _display } = msg;
  const preview = msg.content;
  const displayContent = _display
    ? (() => {
        let parts = [];
        if (_display.field1) parts.push(`【原文】\n${_display.field1.length > 80 ? _display.field1.slice(0, 80) + '…' : _display.field1}`);
        if (_display.targetText) parts.push(`【修改目標】\n${_display.targetText}`);
        if (_display.field2) parts.push(`【指示】\n${_display.field2}`);
        if (_display.wordCount) parts.push(`【字數目標】 ${_display.wordCount}`);
        return parts.join('\n\n');
      })()
    : preview;
  const mdHtml = marked.parse(displayContent || '', { breaks: true });

  return React.createElement('div', { className: 'message message-user' },
    React.createElement('div', { className: 'bubble' },
      React.createElement('div', { className: 'bubble-meta' }, '送出內容'),
      React.createElement('div', {
        className: 'md-content',
        dangerouslySetInnerHTML: { __html: mdHtml },
      }),
    ),
  );
}

// ── AiBubble ─────────────────────────────────────────────────
function AiBubble({ msg, toast }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => toast('❌ 複製失敗', 'error'));
  }

  const mdHtml = !msg._streaming && msg.content ? marked.parse(msg.content, { breaks: true }) : '';

  return React.createElement('div', { className: 'message message-ai' },
    React.createElement('div', { className: 'ai-avatar' }, '✦'),
    React.createElement('div', { className: 'bubble-wrap' },
      React.createElement('div', { className: 'bubble-label' }, 'AI 助手'),
      React.createElement('div', { className: 'bubble' },
        msg._streaming
          ? React.createElement(React.Fragment, null,
              React.createElement('span', { style: { whiteSpace: 'pre-wrap' } }, msg.content),
              React.createElement('span', { className: 'cursor' }),
            )
          : msg.content
            ? React.createElement('div', {
                className: 'md-content',
                dangerouslySetInnerHTML: { __html: mdHtml },
              })
            : '（空回應）',
      ),
      !msg._streaming && msg.content && React.createElement('div', { className: 'bubble-actions' },
        React.createElement('span', { className: 'bubble-word-count' }, `字數：${msg.content.replace(/\\s/g, '').length}`),
        React.createElement('button', {
          className: `copy-btn ${copied ? 'copied' : ''}`,
          onClick: copy,
          id: `btn-copy-${msg._id || 'x'}`,
        },
          copied ? '✓ 已複製' : '📋 複製',
        ),
      ),
    ),
  );
}

// ── Mount ────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
