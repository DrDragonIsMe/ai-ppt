(function () {
  'use strict';

  let currentProject = null;
  let projects = [];
  let currentConfig = null;

  const themes = [
    { id: 'web-ui', name: 'Web UI', desc: '专业克制的默认主题', color: '#0D9488' },
    { id: 'business-blue', name: '商务蓝', desc: '稳重专业的商务风', color: '#2563EB' },
    { id: 'elegant-purple', name: '优雅紫', desc: '高端创意的艺术风', color: '#7C3AED' },
    { id: 'warm-orange', name: '温暖橙', desc: '活力亲切的生活风', color: '#EA580C' },
    { id: 'sunset-red', name: '日落红', desc: '热情有冲击力', color: '#E11D48' },
    { id: 'tech-green', name: '科技绿', desc: '环保可持续', color: '#65A30D' },
    { id: 'minimal-gray', name: '极简灰', desc: '克制高级', color: '#171717' },
    { id: 'dark-mode', name: '暗黑模式', desc: '沉浸护眼', color: '#22D3EE' }
  ];

  const animations = [
    { id: 'none', name: '无动画', desc: '元素直接显示', icon: '➡️' },
    { id: 'fade', name: '渐入', desc: '柔和优雅的淡入', icon: '✨' },
    { id: 'slide', name: '滑入', desc: '从下方滑入的层次感', icon: '⬆️' },
    { id: 'bounce', name: '弹性弹出', desc: '活泼有活力的弹出', icon: '🚀' },
    { id: 'zoom', name: '缩放', desc: '放大淡入', icon: '🔍' },
    { id: 'blur', name: '模糊淡入', desc: '从模糊到清晰', icon: '💨' },
    { id: 'flip', name: '翻转', desc: '3D 翻转切换', icon: '🔄' }
  ];

  const THEME_VAR_DEFAULTS = {
    '--teal': '#0D9488',
    '--ink': '#1A2332',
    '--cream': '#F7F8FA'
  };

  const components = [
    {
      id: 'cover',
      name: '封面页',
      desc: 'kicker + 大标题 + 副标题',
      html: `<section class="slide">
  <div class="slide-content" style="text-align: center;">
    <div class="kicker">Section</div>
    <h1>封面标题</h1>
    <p class="lead">一句话副标题说明</p>
    <div class="divider" style="margin: 32px auto; max-width: 120px;"></div>
    <p style="font-size: 16px; opacity: 0.55;">补充说明文字</p>
  </div>
</section>`
    },
    {
      id: 'hero-stats',
      name: '大数字统计',
      desc: 'split-visual + 4 个 hero-stat',
      html: `<section class="slide">
  <div class="slide-content">
    <div class="section-title">Data</div>
    <h2>关键数据</h2>
    <div class="split-visual" style="margin-top: 32px;">
      <div class="hero-stat">
        <div class="big-number">0%</div>
        <div class="big-number-label">指标一</div>
      </div>
      <div class="hero-stat">
        <div class="big-number">0%</div>
        <div class="big-number-label">指标二</div>
      </div>
      <div class="hero-stat">
        <div class="big-number">0</div>
        <div class="big-number-label">指标三</div>
      </div>
      <div class="hero-stat">
        <div class="big-number">0</div>
        <div class="big-number-label">指标四</div>
      </div>
    </div>
  </div>
</section>`
    },
    {
      id: 'table',
      name: '表格页',
      desc: '三列 ppt-table 数据表',
      html: `<section class="slide">
  <div class="slide-content">
    <div class="section-title">Table</div>
    <h2>数据表格</h2>
    <table class="ppt-table small">
      <thead>
        <tr>
          <th style="width: 30%;">项目</th>
          <th style="width: 40%;">说明</th>
          <th style="width: 30%;">备注</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>项目一</strong></td>
          <td>说明文字</td>
          <td>备注</td>
        </tr>
        <tr>
          <td><strong>项目二</strong></td>
          <td>说明文字</td>
          <td>备注</td>
        </tr>
        <tr>
          <td><strong>项目三</strong></td>
          <td>说明文字</td>
          <td>备注</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>`
    },
    {
      id: 'progress-ring',
      name: '进度环',
      desc: '3 个 progress-ring 百分比环',
      html: `<section class="slide">
  <div class="slide-content">
    <div class="section-title">Progress</div>
    <h2>完成度概览</h2>
    <div class="progress-ring">
      <div class="progress-ring-item">
        <svg class="progress-ring-svg" viewBox="0 0 120 120">
          <circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle>
          <circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct: 75;"></circle>
        </svg>
        <div class="progress-ring-value">75%</div>
        <div class="progress-ring-label">维度一</div>
      </div>
      <div class="progress-ring-item">
        <svg class="progress-ring-svg" viewBox="0 0 120 120">
          <circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle>
          <circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct: 60;"></circle>
        </svg>
        <div class="progress-ring-value">60%</div>
        <div class="progress-ring-label">维度二</div>
      </div>
      <div class="progress-ring-item">
        <svg class="progress-ring-svg" viewBox="0 0 120 120">
          <circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle>
          <circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct: 45;"></circle>
        </svg>
        <div class="progress-ring-value">45%</div>
        <div class="progress-ring-label">维度三</div>
      </div>
    </div>
  </div>
</section>`
    },
    {
      id: 'timeline',
      name: '时间线',
      desc: 'timeline-horizontal 横向里程碑',
      html: `<section class="slide">
  <div class="slide-content">
    <div class="section-title">Roadmap</div>
    <h2>发展里程碑</h2>
    <div class="timeline-horizontal">
      <div class="timeline-horizontal-item">
        <div class="timeline-horizontal-dot"></div>
        <div class="timeline-horizontal-content">
          <div class="timeline-horizontal-title">阶段一</div>
          <div class="timeline-horizontal-desc">里程碑事件</div>
        </div>
      </div>
      <div class="timeline-horizontal-item">
        <div class="timeline-horizontal-dot"></div>
        <div class="timeline-horizontal-content">
          <div class="timeline-horizontal-title">阶段二</div>
          <div class="timeline-horizontal-desc">里程碑事件</div>
        </div>
      </div>
      <div class="timeline-horizontal-item">
        <div class="timeline-horizontal-dot"></div>
        <div class="timeline-horizontal-content">
          <div class="timeline-horizontal-title">阶段三</div>
          <div class="timeline-horizontal-desc">里程碑事件</div>
        </div>
      </div>
      <div class="timeline-horizontal-item">
        <div class="timeline-horizontal-dot"></div>
        <div class="timeline-horizontal-content">
          <div class="timeline-horizontal-title">阶段四</div>
          <div class="timeline-horizontal-desc">里程碑事件</div>
        </div>
      </div>
    </div>
  </div>
</section>`
    },
    {
      id: 'waterfall',
      name: '瀑布图',
      desc: 'waterfall 增减构成分析',
      html: `<section class="slide">
  <div class="slide-content">
    <div class="section-title">Analysis</div>
    <h2>构成分析</h2>
    <div class="waterfall">
      <div class="waterfall-item">
        <div class="waterfall-label">初始值</div>
        <div class="waterfall-bar">
          <div class="waterfall-fill neutral" style="--width: 40%; width: 40%;"></div>
        </div>
        <div class="waterfall-value">100</div>
      </div>
      <div class="waterfall-item">
        <div class="waterfall-label">因素一</div>
        <div class="waterfall-bar">
          <div class="waterfall-fill negative" style="--width: 25%; width: 25%;"></div>
        </div>
        <div class="waterfall-value">-40</div>
      </div>
      <div class="waterfall-item">
        <div class="waterfall-label">因素二</div>
        <div class="waterfall-bar">
          <div class="waterfall-fill negative" style="--width: 18%; width: 18%;"></div>
        </div>
        <div class="waterfall-value">-30</div>
      </div>
      <div class="waterfall-item">
        <div class="waterfall-label">因素三</div>
        <div class="waterfall-bar">
          <div class="waterfall-fill negative" style="--width: 12%; width: 12%;"></div>
        </div>
        <div class="waterfall-value">-20</div>
      </div>
      <div class="waterfall-item">
        <div class="waterfall-label">最终值</div>
        <div class="waterfall-bar">
          <div class="waterfall-fill positive" style="--width: 10%; width: 10%;"></div>
        </div>
        <div class="waterfall-value">10</div>
      </div>
    </div>
  </div>
</section>`
    },
    {
      id: 'steps',
      name: '步骤流程',
      desc: 'chart-steps 四步流程',
      html: `<section class="slide">
  <div class="slide-content">
    <div class="section-title">Workflow</div>
    <h2>实施流程</h2>
    <div class="chart-steps">
      <div class="chart-step">
        <div class="chart-step-number">1</div>
        <div class="chart-step-content">
          <div class="chart-step-title">步骤一</div>
          <div class="chart-step-desc">步骤说明文字</div>
        </div>
      </div>
      <div class="chart-step">
        <div class="chart-step-number">2</div>
        <div class="chart-step-content">
          <div class="chart-step-title">步骤二</div>
          <div class="chart-step-desc">步骤说明文字</div>
        </div>
      </div>
      <div class="chart-step">
        <div class="chart-step-number">3</div>
        <div class="chart-step-content">
          <div class="chart-step-title">步骤三</div>
          <div class="chart-step-desc">步骤说明文字</div>
        </div>
      </div>
      <div class="chart-step">
        <div class="chart-step-number">4</div>
        <div class="chart-step-content">
          <div class="chart-step-title">步骤四</div>
          <div class="chart-step-desc">步骤说明文字</div>
        </div>
      </div>
    </div>
  </div>
</section>`
    },
    {
      id: 'thanks',
      name: '结尾页',
      desc: 'Thank You 致谢页',
      html: `<section class="slide">
  <div class="slide-content" style="text-align: center;">
    <div class="kicker">Thank You</div>
    <h1>谢谢</h1>
    <p class="lead">感谢聆听，欢迎交流探讨。</p>
  </div>
</section>`
    }
  ];

  const els = {
    projectList: document.getElementById('project-list'),
    emptyState: document.getElementById('empty-state'),
    projectPanel: document.getElementById('project-panel'),
    projectTitle: document.getElementById('project-title'),
    projectStatus: document.getElementById('project-status'),
    tabs: document.querySelectorAll('.tab'),
    fieldUrl: document.getElementById('field-url'),
    fieldArticle: document.getElementById('field-article'),
    inputUrl: document.getElementById('input-url'),
    inputArticle: document.getElementById('input-article'),
    inputTitle: document.getElementById('input-title'),
    inputAudience: document.getElementById('input-audience'),
    inputStyle: document.getElementById('input-style'),
    inputSlideCount: document.getElementById('input-slide-count'),
    inputLanguage: document.getElementById('input-language'),
    inputModelPreset: document.getElementById('input-model-preset'),
    inputModelProvider: document.getElementById('input-model-provider'),
    inputModelName: document.getElementById('input-model-name'),
    inputModelBaseUrl: document.getElementById('input-model-base-url'),
    inputModelApiKey: document.getElementById('input-model-api-key'),
    btnSave: document.getElementById('btn-save'),
    btnGenerate: document.getElementById('btn-generate'),
    btnPreview: document.getElementById('btn-preview'),
    btnExportPptx: document.getElementById('btn-export-pptx'),
    btnExportPptxImage: document.getElementById('btn-export-pptx-image'),
    progressCard: document.getElementById('progress-card'),
    progressSteps: document.getElementById('progress-steps'),
    progressLog: document.getElementById('progress-log'),
    createModal: document.getElementById('create-modal'),
    btnCreate: document.getElementById('btn-create'),
    btnCancelCreate: document.getElementById('btn-cancel-create'),
    btnConfirmCreate: document.getElementById('btn-confirm-create'),
    newProjectName: document.getElementById('new-project-name'),
    newProjectTitle: document.getElementById('new-project-title'),
    exportModal: document.getElementById('export-modal'),
    btnCloseExport: document.getElementById('btn-close-export'),
    exportPdf: document.getElementById('export-pdf'),
    exportPptxModal: document.getElementById('export-pptx'),
    exportPptxImageModal: document.getElementById('export-pptx-image'),
    toast: document.getElementById('toast'),
    btnHelp: document.getElementById('btn-help'),
    helpPanel: document.getElementById('help-panel'),
    btnCloseHelp: document.getElementById('btn-close-help'),
    helpOverlay: document.querySelector('.help-panel-overlay'),
    btnRefreshModels: document.getElementById('btn-refresh-models'),
    lmstudioHint: document.getElementById('lmstudio-hint'),
    inputGlobalSearch: document.getElementById('input-global-search'),
    searchResults: document.getElementById('search-results'),
    btnCreateSnapshot: document.getElementById('btn-create-snapshot'),
    snapshotDescription: document.getElementById('snapshot-description'),
    snapshotList: document.getElementById('snapshot-list'),
    btnImportMd: document.getElementById('btn-import-md'),
    inputMdFile: document.getElementById('input-md-file'),
    btnToggleChat: document.getElementById('btn-toggle-chat'),
    chatDock: document.getElementById('chat-dock'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    btnChatSend: document.getElementById('btn-chat-send'),

    configTabs: document.querySelectorAll('.config-tab'),
    themeGrid: document.getElementById('theme-grid'),
    btnSaveTheme: document.getElementById('btn-save-theme'),
    inputVarTeal: document.getElementById('input-var-teal'),
    inputVarInk: document.getElementById('input-var-ink'),
    inputVarCream: document.getElementById('input-var-cream'),
    inputVarFontHeading: document.getElementById('input-var-font-heading'),
    inputVarFontBody: document.getElementById('input-var-font-body'),
    btnApplyThemeVars: document.getElementById('btn-apply-theme-vars'),
    btnClearThemeVars: document.getElementById('btn-clear-theme-vars'),
    componentGrid: document.getElementById('component-grid'),
    exportHtmlModal: document.getElementById('export-html'),
    animationOptions: document.getElementById('animation-options'),
    animationSpeed: document.getElementById('animation-speed'),
    btnSaveAnimation: document.getElementById('btn-save-animation'),
    publishStatusTitle: document.getElementById('publish-status-title'),
    publishStatusDesc: document.getElementById('publish-status-desc'),
    btnPublish: document.getElementById('btn-publish'),
    publishLatest: document.getElementById('publish-latest'),
    publishList: document.getElementById('publish-list'),

    previewFrame: document.getElementById('preview-frame'),
    btnOpenPreview: document.getElementById('btn-open-preview')
  };

  const steps = [
    { key: 'start', label: '启动' },
    { key: 'extract', label: '提取内容' },
    { key: 'prompt', label: '构建提示' },
    { key: 'llm', label: 'LLM 生成' },
    { key: 'fallback', label: '模板兜底' },
    { key: 'build', label: '写入文件' },
    { key: 'ready', label: '完成' }
  ];

  let models = [];

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `${method} ${path} failed`);
    }
    return res.status === 204 ? null : res.json();
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusLabel(status) {
    const map = { draft: '草稿', generating: '生成中', ready: '就绪', error: '错误' };
    return map[status] || status;
  }

  async function loadModels() {
    const select = els.inputModelPreset;
    try {
      models = await api('GET', '/api/models');
    } catch {
      models = [];
      select.innerHTML = '<option value="">加载失败，请检查服务</option>';
      return;
    }
    select.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  }

  async function loadProjects(selectName = null) {
    projects = await api('GET', '/api/projects');
    renderProjects();
    if (selectName) selectProject(selectName);
  }

  function renderProjects() {
    els.projectList.innerHTML = '';
    projects.forEach((p, idx) => {
      const item = document.createElement('div');
      item.className = 'project-item' + (p.name === currentProject ? ' active' : '');
      item.dataset.index = idx;
      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:11px;font-family:var(--font-mono);background:${idx < 9 ? 'var(--tile)' : 'transparent'};border-radius:4px;color:var(--ink);opacity:0.6;">
            ${idx < 9 ? idx + 1 : ''}
          </div>
          <div>
            <div class="project-name">${escapeHtml(p.title || p.name)}</div>
            <div class="project-meta">${escapeHtml(p.name)} · ${statusLabel(p.status)}</div>
          </div>
        </div>
        <button class="project-delete" title="删除">×</button>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('project-delete')) {
          e.stopPropagation();
          deleteProject(p.name);
        } else {
          selectProject(p.name);
        }
      });
      els.projectList.appendChild(item);
    });
  }

  async function selectProject(name) {
    currentProject = name;
    renderProjects();
    els.emptyState.classList.add('hidden');
    els.projectPanel.classList.remove('hidden');
    els.chatMessages.innerHTML = '';
    const cfg = await api('GET', `/api/projects/${encodeURIComponent(name)}/config`);
    currentConfig = cfg;
    renderConfig(cfg);
    renderThemeOptions();
    renderThemeOverrides(cfg);
    renderAnimationOptions();
    renderComponents();
    loadPublishHistory();
    loadSnapshots();
    updatePreview();
  }

  function renderConfig(cfg) {
    els.projectTitle.textContent = cfg.params?.title || cfg.name;
    els.projectStatus.textContent = statusLabel(cfg.status);
    els.projectStatus.className = 'status ' + cfg.status;

    setSourceTab(cfg.sourceType || 'article');
    els.inputUrl.value = cfg.sourceUrl || '';
    els.inputArticle.value = cfg.articleText || '';
    els.inputTitle.value = cfg.params?.title || '';
    els.inputAudience.value = cfg.params?.audience || '';
    els.inputStyle.value = cfg.params?.style || '商业汇报';
    els.inputSlideCount.value = cfg.params?.slideCount || 8;
    els.inputLanguage.value = cfg.params?.language || 'zh-CN';

    const mcfg = cfg.modelConfig || {};
    const presetId = mcfg.presetId || 'kimi-code';
    if (models.some((m) => m.id === presetId)) {
      els.inputModelPreset.value = presetId;
    } else {
      els.inputModelPreset.value = 'custom';
    }
    els.inputModelProvider.value = mcfg.provider || '';
    els.inputModelName.value = mcfg.model || '';
    els.inputModelBaseUrl.value = mcfg.baseUrl || '';
    els.inputModelApiKey.value = mcfg.apiKey || '';

    updateModelPresetUI(presetId);

    const canExport = cfg.status === 'ready';
    els.btnPreview.disabled = !canExport;
    els.btnExportPptx.disabled = !canExport;
    els.btnExportPptxImage.disabled = !canExport;
    els.progressCard.classList.add('hidden');

    checkProjectFiles();
  }

  function updateModelPresetUI(presetId) {
    const preset = models.find((m) => m.id === presetId);
    if (presetId === 'lmstudio') {
      els.lmstudioHint.classList.remove('hidden');
    } else {
      els.lmstudioHint.classList.add('hidden');
    }
  }

  async function refreshModelList() {
    const baseUrl = els.inputModelBaseUrl.value;
    const apiKey = els.inputModelApiKey.value;
    if (!baseUrl) {
      showToast('请先填写 Base URL');
      return;
    }
    try {
      showToast('正在获取模型列表...');
      const remoteModels = await api('POST', '/api/models/list-remote', { baseUrl, apiKey });
      const currentValue = els.inputModelName.value;
      els.inputModelName.innerHTML = '<option value="">选择或输入模型...</option>' +
        remoteModels.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('');
      if (currentValue) {
        els.inputModelName.value = currentValue;
      }
      showToast(`获取到 ${remoteModels.length} 个模型`);
    } catch (err) {
      showToast('获取模型列表失败: ' + err.message);
    }
  }

  let searchTimer = null;

  async function performSearch(query) {
    if (!query.trim()) {
      els.searchResults.classList.add('hidden');
      return;
    }
    try {
      const results = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
      renderSearchResults(results);
    } catch {
      els.searchResults.classList.add('hidden');
    }
  }

  function renderSearchResults(results) {
    if (!results || results.length === 0) {
      els.searchResults.innerHTML = '<div class="search-result-empty">无匹配结果</div>';
      els.searchResults.classList.remove('hidden');
      return;
    }
    els.searchResults.innerHTML = results.map((r) => `
      <div class="search-result-item" data-name="${escapeHtml(r.name)}">
        <div class="search-result-title">${escapeHtml(r.title || r.name)}</div>
        <div class="search-result-meta">${escapeHtml(r.name)} · ${statusLabel(r.status)}</div>
      </div>
    `).join('');
    els.searchResults.classList.remove('hidden');

    els.searchResults.querySelectorAll('.search-result-item').forEach((item) => {
      item.addEventListener('click', () => {
        els.searchResults.classList.add('hidden');
        els.inputGlobalSearch.value = '';
        selectProject(item.dataset.name);
      });
    });
  }

  function closeSearchResults() {
    els.searchResults.classList.add('hidden');
  }

  function toggleChatDock() {
    els.chatDock.classList.toggle('hidden');
  }

  function appendChatMessage(text, role) {
    const div = document.createElement('div');
    div.className = 'chat-message ' + role;
    div.textContent = text;
    els.chatMessages.appendChild(div);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    return div;
  }

  let chatBusy = false;

  async function sendChatMessage() {
    const instruction = els.chatInput.value.trim();
    if (!instruction || !currentProject || chatBusy) return;

    appendChatMessage(instruction, 'user');
    els.chatInput.value = '';
    chatBusy = true;
    els.btnChatSend.disabled = true;
    const pendingMsg = appendChatMessage('正在修改，请稍候…', 'system');

    try {
      const sessionApiKey = els.inputModelApiKey.value.trim();
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/chat`, {
        instruction,
        ...(sessionApiKey ? { apiKey: sessionApiKey } : {}),
      });
      pendingMsg.remove();
      appendChatMessage('修改已完成，预览已刷新。', 'assistant');
      updatePreview();
      loadSnapshots();
    } catch (err) {
      pendingMsg.remove();
      appendChatMessage('修改失败：' + err.message, 'assistant');
    } finally {
      chatBusy = false;
      els.btnChatSend.disabled = false;
    }
  }

  async function checkProjectFiles() {
    if (!currentProject) return;
    try {
      const res = await fetch(`/projects/${encodeURIComponent(currentProject)}/index.html`, { method: 'HEAD' });
      if (res.ok) {
        els.btnPreview.disabled = false;
        els.btnExportPptx.disabled = false;
        els.btnExportPptxImage.disabled = false;
      }
    } catch {}
  }

  function setSourceTab(type) {
    els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.source === type));
    if (type === 'url') {
      els.fieldUrl.classList.remove('hidden');
      els.fieldArticle.classList.add('hidden');
    } else {
      els.fieldUrl.classList.add('hidden');
      els.fieldArticle.classList.remove('hidden');
    }
  }

  function renderThemeOptions() {
    els.themeGrid.innerHTML = '';
    const currentTheme = currentConfig?.theme || 'web-ui';

    themes.forEach((theme) => {
      const card = document.createElement('div');
      card.className = 'theme-card' + (theme.id === currentTheme ? ' active' : '');
      card.innerHTML = `
        <div class="theme-preview">
          <div class="theme-preview-bar" style="background: ${theme.color};"></div>
        </div>
        <div class="theme-name">${escapeHtml(theme.name)}</div>
        <div class="theme-desc">${escapeHtml(theme.desc)}</div>
      `;
      card.addEventListener('click', () => selectTheme(theme.id));
      els.themeGrid.appendChild(card);
    });
  }

  function selectTheme(themeId) {
    const cards = els.themeGrid.querySelectorAll('.theme-card');
    cards.forEach((card, i) => {
      card.classList.toggle('active', themes[i].id === themeId);
    });
    // Save and update preview
    saveAndRefreshPreview();
  }

  function setFontSelect(select, value) {
    if (!value) return;
    select.querySelectorAll('option[data-custom]').forEach((opt) => opt.remove());
    const found = Array.from(select.options).some((opt) => opt.value === value);
    if (!found) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = '自定义 · ' + value;
      opt.dataset.custom = 'true';
      select.appendChild(opt);
    }
    select.value = value;
  }

  function renderThemeOverrides(cfg) {
    const overrides = cfg.themeOverrides || {};
    els.inputVarTeal.value = overrides['--teal'] || THEME_VAR_DEFAULTS['--teal'];
    els.inputVarInk.value = overrides['--ink'] || THEME_VAR_DEFAULTS['--ink'];
    els.inputVarCream.value = overrides['--cream'] || THEME_VAR_DEFAULTS['--cream'];
    setFontSelect(els.inputVarFontHeading, overrides['--font-heading']);
    setFontSelect(els.inputVarFontBody, overrides['--font-body']);
  }

  async function applyThemeOverrides() {
    if (!currentProject) return;
    const overrides = {
      '--teal': els.inputVarTeal.value,
      '--ink': els.inputVarInk.value,
      '--cream': els.inputVarCream.value,
      '--font-heading': els.inputVarFontHeading.value,
      '--font-body': els.inputVarFontBody.value
    };
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/theme-overrides`, { overrides });
      showToast('变量已应用');
      updatePreview();
    } catch (err) {
      showToast('应用变量失败：' + err.message);
    }
  }

  async function clearThemeOverrides() {
    if (!currentProject) return;
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/theme-overrides`, { overrides: {} });
      els.inputVarTeal.value = THEME_VAR_DEFAULTS['--teal'];
      els.inputVarInk.value = THEME_VAR_DEFAULTS['--ink'];
      els.inputVarCream.value = THEME_VAR_DEFAULTS['--cream'];
      els.inputVarFontHeading.selectedIndex = 0;
      els.inputVarFontBody.selectedIndex = 1;
      showToast('变量已清除');
      updatePreview();
    } catch (err) {
      showToast('清除变量失败：' + err.message);
    }
  }

  function renderComponents() {
    els.componentGrid.innerHTML = '';
    components.forEach((comp) => {
      const card = document.createElement('div');
      card.className = 'component-card';
      card.innerHTML = `
        <div class="component-preview">${escapeHtml(comp.desc)}</div>
        <div class="component-name">${escapeHtml(comp.name)}</div>
        <button class="btn-secondary component-insert">插入</button>
      `;
      card.querySelector('.component-insert').addEventListener('click', () => insertComponent(comp));
      els.componentGrid.appendChild(card);
    });
  }

  async function insertComponent(comp) {
    if (!currentProject) return;
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/component`, { html: comp.html });
      showToast(`已插入「${comp.name}」`);
      updatePreview();
    } catch (err) {
      showToast('插入组件失败：' + err.message);
    }
  }

  function renderAnimationOptions() {
    els.animationOptions.innerHTML = '';
    const currentAnim = currentConfig?.animation || 'slide';

    animations.forEach((anim) => {
      const option = document.createElement('div');
      option.className = 'animation-option' + (anim.id === currentAnim ? ' active' : '');
      option.innerHTML = `
        <div class="animation-icon">${anim.icon}</div>
        <div class="animation-info">
          <div class="animation-title">${escapeHtml(anim.name)}</div>
          <div class="animation-desc">${escapeHtml(anim.desc)}</div>
        </div>
      `;
      option.addEventListener('click', () => selectAnimation(anim.id));
      els.animationOptions.appendChild(option);
    });
  }

  function selectAnimation(animId) {
    const options = els.animationOptions.querySelectorAll('.animation-option');
    options.forEach((option, i) => {
      option.classList.toggle('active', animations[i].id === animId);
    });
    // Save and update preview
    saveAndRefreshPreview();
  }

  async function saveAndRefreshPreview() {
    if (!currentProject) return;

    try {
      const payload = getConfigPayload();
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/config`, payload);

      // Refresh preview
      const timestamp = Date.now();
      els.previewFrame.src = `/projects/${encodeURIComponent(currentProject)}/index.html?t=${timestamp}`;
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  async function loadPublishHistory() {
    try {
      const history = await api('GET', `/api/projects/${encodeURIComponent(currentProject)}/publish`);
      renderPublishHistory(history);
    } catch {
      renderPublishHistory([]);
    }
  }

  async function loadSnapshots() {
    if (!currentProject) return;
    try {
      const snapshots = await api('GET', `/api/projects/${encodeURIComponent(currentProject)}/snapshots`);
      renderSnapshots(snapshots);
    } catch {
      renderSnapshots([]);
    }
  }

  function renderSnapshots(snapshots) {
    if (!snapshots || snapshots.length === 0) {
      els.snapshotList.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; opacity: 0.5; font-size: 13px;">
          暂无快照
        </div>
      `;
      return;
    }
    els.snapshotList.innerHTML = snapshots.map((s) => `
      <div class="publish-item">
        <div class="publish-version">${escapeHtml(new Date(s.createdAt).toLocaleString())}</div>
        <div class="publish-info">
          <div class="publish-time">${escapeHtml(s.description || '（无说明）')}</div>
          <div class="publish-meta">${escapeHtml(s.title || s.name)} · ${statusLabel(s.status)}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-secondary snapshot-restore" data-id="${escapeHtml(s.id)}" style="padding:6px 10px;font-size:12px;">恢复</button>
          <button class="btn-secondary snapshot-delete" data-id="${escapeHtml(s.id)}" style="padding:6px 10px;font-size:12px;">删除</button>
        </div>
      </div>
    `).join('');

    els.snapshotList.querySelectorAll('.snapshot-restore').forEach((btn) => {
      btn.addEventListener('click', () => restoreSnapshotById(btn.dataset.id));
    });
    els.snapshotList.querySelectorAll('.snapshot-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteSnapshotById(btn.dataset.id));
    });
  }

  async function createSnapshotNow() {
    if (!currentProject) return;
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/snapshots`, {
        description: els.snapshotDescription.value.trim(),
      });
      els.snapshotDescription.value = '';
      showToast('快照已保存');
      loadSnapshots();
    } catch (err) {
      showToast('保存快照失败：' + err.message);
    }
  }

  async function restoreSnapshotById(id) {
    if (!confirm('恢复此快照将覆盖当前项目内容，确定吗？')) return;
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/snapshots/${encodeURIComponent(id)}/restore`);
      showToast('已恢复快照');
      const cfg = await api('GET', `/api/projects/${encodeURIComponent(currentProject)}/config`);
      currentConfig = cfg;
      renderConfig(cfg);
      updatePreview();
    } catch (err) {
      showToast('恢复失败：' + err.message);
    }
  }

  async function deleteSnapshotById(id) {
    if (!confirm('确定删除此快照吗？')) return;
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(currentProject)}/snapshots/${encodeURIComponent(id)}`);
      showToast('快照已删除');
      loadSnapshots();
    } catch (err) {
      showToast('删除失败：' + err.message);
    }
  }

  function renderPublishHistory(history) {
    if (history && history.length > 0) {
      const latest = history[0];
      els.publishStatusTitle.textContent = '已发布';
      els.publishStatusDesc.textContent = `最新版本: ${latest.version}`;
      els.publishLatest.textContent = `${window.location.origin}/published/${encodeURIComponent(currentProject)}/latest/index.html`;

      els.publishList.innerHTML = history.map((item) => `
        <div class="publish-item">
          <div class="publish-version">${escapeHtml(item.version)}</div>
          <div class="publish-info">
            <div class="publish-time">${new Date(item.publishedAt).toLocaleString()}</div>
            <div class="publish-meta">主题: ${escapeHtml(item.theme || 'web-ui')} · 动画: ${escapeHtml(item.animation || 'slide')}</div>
          </div>
          <a href="/published/${encodeURIComponent(currentProject)}/${encodeURIComponent(item.version)}/index.html" target="_blank" class="publish-link">
            打开
          </a>
        </div>
      `).join('');
    } else {
      els.publishStatusTitle.textContent = '草稿状态';
      els.publishStatusDesc.textContent = '尚未发布过任何版本';
      els.publishLatest.textContent = '暂未发布';
      els.publishList.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; opacity: 0.5; font-size: 13px;">
          暂无发布历史
        </div>
      `;
    }
  }

  function updatePreview() {
    if (!currentProject) return;
    els.previewFrame.src = `/projects/${encodeURIComponent(currentProject)}/index.html?t=${Date.now()}`;
  }

  function getConfigPayload() {
    const activeTab = document.querySelector('.tab.active');
    const sourceType = activeTab ? activeTab.dataset.source : 'article';
    const presetId = els.inputModelPreset.value;
    const preset = models.find((m) => m.id === presetId);

    const selectedTheme = themes.find((t, i) =>
      els.themeGrid.querySelectorAll('.theme-card')[i]?.classList.contains('active')
    );
    const selectedAnim = animations.find((t, i) =>
      els.animationOptions.querySelectorAll('.animation-option')[i]?.classList.contains('active')
    );

    return {
      sourceType,
      sourceUrl: els.inputUrl.value.trim(),
      articleText: els.inputArticle.value.trim(),
      params: {
        title: els.inputTitle.value.trim(),
        audience: els.inputAudience.value.trim(),
        style: els.inputStyle.value,
        slideCount: parseInt(els.inputSlideCount.value, 10) || 8,
        language: els.inputLanguage.value
      },
      modelConfig: {
        presetId,
        provider: els.inputModelProvider.value.trim() || (preset?.provider || ''),
        model: els.inputModelName.value.trim() || (preset?.model || ''),
        baseUrl: els.inputModelBaseUrl.value.trim() || (preset?.baseUrl || '')
      },
      theme: selectedTheme?.id || currentConfig?.theme || 'web-ui',
      animation: selectedAnim?.id || currentConfig?.animation || 'slide'
    };
  }

  async function saveConfig() {
    if (!currentProject) return;
    const payload = getConfigPayload();
    await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/config`, payload);
    showToast('配置已保存');
    currentConfig = await api('GET', `/api/projects/${encodeURIComponent(currentProject)}/config`);
    renderConfig(currentConfig);
    updatePreview();
  }

  function initProgress() {
    els.progressCard.classList.remove('hidden');
    els.progressSteps.innerHTML = steps.map((s) => `
      <div class="step pending" data-step="${s.key}">
        <span>${escapeHtml(s.label)}</span>
      </div>
    `).join('');
    els.progressLog.textContent = '';
  }

  function updateProgress(step, state, message) {
    const el = els.progressSteps.querySelector(`[data-step="${step}"]`);
    if (el) {
      el.className = 'step ' + state;
    }
    if (message) {
      const line = `[${new Date().toLocaleTimeString()}] ${message}`;
      els.progressLog.textContent += line + '\n';
      els.progressLog.scrollTop = els.progressLog.scrollHeight;
    }
  }

  async function generate() {
    if (!currentProject) return;
    const sessionApiKey = els.inputModelApiKey.value.trim();
    await saveConfig();
    initProgress();
    els.btnGenerate.disabled = true;
    updateProgress('start', 'active', '开始生成');

    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/generate`, sessionApiKey ? { apiKey: sessionApiKey } : undefined);
    } catch (err) {
      updateProgress('start', 'error', err.message);
      els.btnGenerate.disabled = false;
      return;
    }

    const es = new EventSource(`/api/projects/${encodeURIComponent(currentProject)}/generate/events`);
    es.onmessage = (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        event = { type: 'log', message: e.data };
      }
      if (event.type === 'progress') {
        updateProgress(event.step, 'done', event.message);
        const idx = steps.findIndex((s) => s.key === event.step);
        if (idx >= 0 && idx < steps.length - 1) {
          updateProgress(steps[idx + 1].key, 'active');
        }
      } else if (event.type === 'log' || event.type === 'stderr') {
        els.progressLog.textContent += event.message + '\n';
      } else if (event.type === 'error') {
        updateProgress(event.step || 'ready', 'error', event.message);
        es.close();
        els.btnGenerate.disabled = false;
        showToast('生成失败：' + event.message);
      } else if (event.type === 'done') {
        updateProgress('ready', 'done', '生成完成');
        es.close();
        els.btnGenerate.disabled = false;
        loadProjects(currentProject).then(() => {
          updatePreview();
        });
      }
    };
    es.onerror = () => {
      es.close();
      els.btnGenerate.disabled = false;
      updateProgress('ready', 'error', '生成连接中断');
      showToast('生成连接中断，请重试');
    };
  }

  function openPreview() {
    window.open(`/projects/${encodeURIComponent(currentProject)}/`, '_blank');
  }

  async function exportPptx() {
    if (!currentProject) return;
    showToast('正在生成 PPTX...');
    try {
      const res = await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/export/pptx`);
      if (res.downloadUrl) {
        const a = document.createElement('a');
        a.href = res.downloadUrl;
        a.download = `${currentProject}.pptx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast('PPTX 已下载');
      }
    } catch (err) {
      showToast('PPTX 导出失败：' + err.message);
    }
  }

  async function exportPptxImage() {
    if (!currentProject) return;
    showToast('正在生成高清图片 PPTX...');
    try {
      const res = await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/export/pptx-image`);
      if (res.downloadUrl) {
        const a = document.createElement('a');
        a.href = res.downloadUrl;
        a.download = `${currentProject}-image.pptx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast('高清图片 PPTX 已下载');
      }
    } catch (err) {
      showToast('高清图片 PPTX 导出失败：' + err.message);
    }
  }

  async function exportHtml() {
    if (!currentProject) return;
    showToast('正在生成单文件 HTML...');
    try {
      const res = await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/export/html`);
      if (res.downloadUrl) {
        const a = document.createElement('a');
        a.href = res.downloadUrl;
        a.download = `${currentProject}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast('单文件 HTML 已下载');
      }
    } catch (err) {
      showToast('单文件 HTML 导出失败：' + err.message);
    }
  }

  async function publish() {
    if (!currentProject) return;
    showToast('正在发布...');
    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/publish`);
      showToast('发布成功！');
      loadPublishHistory();
    } catch (err) {
      showToast('发布失败：' + err.message);
    }
  }

  function openExportModal() {
    els.exportModal.classList.remove('hidden');
  }

  function closeExportModal() {
    els.exportModal.classList.add('hidden');
  }

  function openHelpPanel() {
    els.helpPanel.classList.remove('hidden');
  }

  function closeHelpPanel() {
    els.helpPanel.classList.add('hidden');
  }

  function isInputActive() {
    const active = document.activeElement;
    return active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  }

  async function createProject() {
    const name = els.newProjectName.value.trim();
    const title = els.newProjectTitle.value.trim();
    if (!name) {
      showToast('请输入项目标识');
      return;
    }
    try {
      await api('POST', '/api/projects', { name, title });
      els.createModal.classList.add('hidden');
      els.newProjectName.value = '';
      els.newProjectTitle.value = '';
      await loadProjects(name);
      showToast('项目已创建');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function deleteProject(name) {
    if (!confirm(`确定删除项目 ${name} 吗？`)) return;
    await api('DELETE', `/api/projects/${encodeURIComponent(name)}`);
    if (currentProject === name) {
      currentProject = null;
      els.projectPanel.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
    }
    await loadProjects();
    showToast('项目已删除');
  }

  function bindEvents() {
    els.tabs.forEach((t) => {
      t.addEventListener('click', () => setSourceTab(t.dataset.source));
    });
    els.inputModelPreset.addEventListener('change', () => {
      const preset = models.find((m) => m.id === els.inputModelPreset.value);
      if (!preset) return;
      if (preset.id === 'custom') {
        els.inputModelProvider.value = 'openai';
        els.inputModelName.value = '';
        els.inputModelBaseUrl.value = '';
      } else {
        els.inputModelProvider.value = preset.provider || '';
        els.inputModelName.value = preset.model || '';
        els.inputModelBaseUrl.value = preset.baseUrl || '';
      }
      updateModelPresetUI(preset.id);
    });

    els.btnRefreshModels.addEventListener('click', refreshModelList);
    els.btnCreateSnapshot.addEventListener('click', createSnapshotNow);

    els.btnToggleChat.addEventListener('click', toggleChatDock);
    els.btnChatSend.addEventListener('click', sendChatMessage);
    els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        sendChatMessage();
      }
    });

    els.btnImportMd.addEventListener('click', () => els.inputMdFile.click());
    els.inputMdFile.addEventListener('change', () => {
      const file = els.inputMdFile.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        els.inputArticle.value = reader.result || '';
        showToast(`已导入 ${file.name}`);
        els.inputMdFile.value = '';
      };
      reader.onerror = () => showToast('文件读取失败');
      reader.readAsText(file);
    });

    els.inputGlobalSearch.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => performSearch(e.target.value), 300);
    });
    els.inputGlobalSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSearchResults();
        els.inputGlobalSearch.blur();
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.topbar-search')) closeSearchResults();
    });

    els.configTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        els.configTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');

        const panelId = tab.dataset.tab;
        document.querySelectorAll('.config-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.panel === panelId);
        });
      });
    });

    els.btnSave.addEventListener('click', saveConfig);
    els.btnSaveTheme.addEventListener('click', saveConfig);
    els.btnSaveAnimation.addEventListener('click', saveConfig);
    els.btnApplyThemeVars.addEventListener('click', applyThemeOverrides);
    els.btnClearThemeVars.addEventListener('click', clearThemeOverrides);
    els.btnGenerate.addEventListener('click', generate);
    els.btnPreview.addEventListener('click', openPreview);
    els.btnOpenPreview.addEventListener('click', openPreview);
    els.btnExportPptx.addEventListener('click', exportPptx);
    els.btnExportPptxImage.addEventListener('click', exportPptxImage);
    els.btnPublish.addEventListener('click', publish);

    els.btnCreate.addEventListener('click', () => els.createModal.classList.remove('hidden'));
    els.btnCancelCreate.addEventListener('click', () => els.createModal.classList.add('hidden'));
    els.btnConfirmCreate.addEventListener('click', createProject);
    els.btnCloseExport.addEventListener('click', closeExportModal);

    els.exportPdf.addEventListener('click', () => {
      closeExportModal();
      if (currentProject) window.open(`/projects/${encodeURIComponent(currentProject)}/`, '_blank');
    });
    els.exportPptxModal.addEventListener('click', () => {
      closeExportModal();
      exportPptx();
    });
    els.exportPptxImageModal.addEventListener('click', () => {
      closeExportModal();
      exportPptxImage();
    });
    els.exportHtmlModal.addEventListener('click', () => {
      closeExportModal();
      exportHtml();
    });

    els.btnHelp.addEventListener('click', openHelpPanel);
    els.btnCloseHelp.addEventListener('click', closeHelpPanel);
    els.helpOverlay.addEventListener('click', closeHelpPanel);

    document.addEventListener('keydown', (e) => {
      // 如果在输入框中，只处理 Esc 和 ?
      if (isInputActive()) {
        if (e.key === 'Escape') {
          if (!els.helpPanel.classList.contains('hidden')) {
            closeHelpPanel();
          } else if (!els.exportModal.classList.contains('hidden')) {
            closeExportModal();
          } else if (!els.createModal.classList.contains('hidden')) {
            els.createModal.classList.add('hidden');
          }
        }
        return;
      }

      const key = e.key.toLowerCase();
      const isMod = e.ctrlKey || e.metaKey;

      // 帮助面板
      if (key === '?') {
        e.preventDefault();
        if (els.helpPanel.classList.contains('hidden')) {
          openHelpPanel();
        } else {
          closeHelpPanel();
        }
        return;
      }

      // Esc 关闭面板
      if (key === 'escape') {
        if (!els.helpPanel.classList.contains('hidden')) {
          closeHelpPanel();
        } else if (!els.exportModal.classList.contains('hidden')) {
          closeExportModal();
        } else if (!els.createModal.classList.contains('hidden')) {
          els.createModal.classList.add('hidden');
        }
        return;
      }

      // 新建项目
      if (isMod && key === 'n') {
        e.preventDefault();
        els.createModal.classList.remove('hidden');
        return;
      }

      // 聚焦搜索框
      if (isMod && key === 'k') {
        e.preventDefault();
        els.inputGlobalSearch.focus();
        return;
      }

      // 保存配置
      if (isMod && key === 's') {
        e.preventDefault();
        saveConfig();
        return;
      }

      // 导出面板
      if (isMod && key === 'p') {
        e.preventDefault();
        openExportModal();
        return;
      }

      // 生成幻灯片
      if (isMod && key === 'g') {
        e.preventDefault();
        if (currentProject && !els.btnGenerate.disabled) {
          generate();
        }
        return;
      }

      // 打开预览
      if (isMod && key === 'o') {
        e.preventDefault();
        if (currentProject && !els.btnPreview.disabled) {
          openPreview();
        }
        return;
      }

      // 数字键 1-9 快速切换项目
      if (/^[1-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        if (projects[idx]) {
          selectProject(projects[idx].name);
        }
        return;
      }

      // Tab 切换配置标签
      if (key === 'tab' && !e.shiftKey) {
        const activeTab = document.querySelector('.config-tab.active');
        if (activeTab) {
          e.preventDefault();
          const tabs = Array.from(els.configTabs);
          const currentIdx = tabs.indexOf(activeTab);
          const nextIdx = (currentIdx + 1) % tabs.length;
          tabs[nextIdx].click();
        }
        return;
      }
    });
  }

  loadModels().then(loadProjects);
  bindEvents();
})();
