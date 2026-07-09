(function () {
  'use strict';

  let currentProject = null;
  let projects = [];

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
    inputModel: document.getElementById('input-model'),
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
  };

  const steps = [
    { key: 'start', label: '启动' },
    { key: 'extract', label: '提取内容' },
    { key: 'prompt', label: '构建提示' },
    { key: 'llm', label: 'LLM 生成' },
    { key: 'fallback', label: '模板兜底' },
    { key: 'build', label: '写入文件' },
    { key: 'ready', label: '完成' },
  ];

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

  function statusLabel(status) {
    const map = { draft: '草稿', generating: '生成中', ready: '就绪', error: '错误' };
    return map[status] || status;
  }

  function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function selectProject(name) {
    currentProject = name;
    renderProjects();
    els.emptyState.classList.add('hidden');
    els.projectPanel.classList.remove('hidden');
    const cfg = await api('GET', `/api/projects/${encodeURIComponent(name)}/config`);
    renderConfig(cfg);
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
    els.inputModel.value = cfg.params?.model || 'qwen-max';

    const canExport = cfg.status === 'ready';
    els.btnPreview.disabled = !canExport;
    els.btnExportPptx.disabled = !canExport;
    els.btnExportPptxImage.disabled = !canExport;
    els.progressCard.classList.add('hidden');

    // Existing projects may already have index.html even if status is draft
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
    } catch {
      // keep current state
    }
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

  function getConfigPayload() {
    const activeTab = document.querySelector('.tab.active');
    const sourceType = activeTab ? activeTab.dataset.source : 'article';
    return {
      sourceType,
      sourceUrl: els.inputUrl.value.trim(),
      articleText: els.inputArticle.value.trim(),
      params: {
        title: els.inputTitle.value.trim(),
        audience: els.inputAudience.value.trim(),
        style: els.inputStyle.value,
        slideCount: parseInt(els.inputSlideCount.value, 10) || 8,
        language: els.inputLanguage.value,
        model: els.inputModel.value.trim() || 'qwen-max',
      },
    };
  }

  async function saveConfig() {
    if (!currentProject) return;
    const payload = getConfigPayload();
    await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/config`, payload);
    showToast('配置已保存');
    renderConfig({ ...payload, name: currentProject, status: 'draft' });
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
    await saveConfig();
    initProgress();
    els.btnGenerate.disabled = true;
    updateProgress('start', 'active', '开始生成');

    try {
      await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/generate`);
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
          openPreview();
        });
      }
    };
    es.onerror = () => {
      es.close();
      els.btnGenerate.disabled = false;
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
    showToast('正在生成高清图片 PPTX（需要 Chrome，约需几十秒）...');
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

  // Event bindings
  els.tabs.forEach((t) => {
    t.addEventListener('click', () => setSourceTab(t.dataset.source));
  });
  els.btnSave.addEventListener('click', saveConfig);
  els.btnGenerate.addEventListener('click', generate);
  els.btnPreview.addEventListener('click', openPreview);
  els.btnExportPptx.addEventListener('click', exportPptx);
  els.btnExportPptxImage.addEventListener('click', exportPptxImage);
  els.btnCreate.addEventListener('click', () => els.createModal.classList.remove('hidden'));
  els.btnCancelCreate.addEventListener('click', () => els.createModal.classList.add('hidden'));
  els.btnConfirmCreate.addEventListener('click', createProject);
  els.btnCloseExport.addEventListener('click', closeExportModal);
  async function exportPdf() {
    if (!currentProject) return;
    showToast('正在生成 PDF（需要 Chrome，约需几十秒）...');
    try {
      const res = await api('POST', `/api/projects/${encodeURIComponent(currentProject)}/export/pdf`);
      if (res.fallback) {
        closeExportModal();
        openPreview();
        showToast(res.message || '请在打开的预览页中使用 Ctrl+P 导出 PDF');
      } else if (res.downloadUrl) {
        const a = document.createElement('a');
        a.href = res.downloadUrl;
        a.download = `${currentProject}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast('PDF 已下载');
      }
    } catch (err) {
      showToast('PDF 导出失败：' + err.message);
    }
  }

  els.exportPdf.addEventListener('click', () => {
    closeExportModal();
    exportPdf();
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

  loadProjects();
})();
