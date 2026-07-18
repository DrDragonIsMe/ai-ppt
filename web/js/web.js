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
    { id: 'bounce', name: '弹性弹出', desc: '活泼有活力的弹出', icon: '🚀' }
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

    configTabs: document.querySelectorAll('.config-tab'),
    themeGrid: document.getElementById('theme-grid'),
    btnSaveTheme: document.getElementById('btn-save-theme'),
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
    projects.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'project-item' + (p.name === currentProject ? ' active' : '');
      item.innerHTML = `
        <div>
          <div class="project-name">${escapeHtml(p.title || p.name)}</div>
          <div class="project-meta">${escapeHtml(p.name)} · ${statusLabel(p.status)}</div>
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
    const cfg = await api('GET', `/api/projects/${encodeURIComponent(name)}/config`);
    currentConfig = cfg;
    renderConfig(cfg);
    renderThemeOptions();
    renderAnimationOptions();
    loadPublishHistory();
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

    const canExport = cfg.status === 'ready';
    els.btnPreview.disabled = !canExport;
    els.btnExportPptx.disabled = !canExport;
    els.btnExportPptxImage.disabled = !canExport;
    els.progressCard.classList.add('hidden');

    checkProjectFiles();
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

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
          return;
        }
        e.preventDefault();
        openExportModal();
      }
    });
  }

  loadModels().then(loadProjects);
  bindEvents();
})();
