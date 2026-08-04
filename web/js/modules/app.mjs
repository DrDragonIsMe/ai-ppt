// web/js/modules/app.mjs — 入口：初始化与全局编排
import { S, initEls, loadThemes, showToast } from './state.mjs';
import {
    loadModels, loadGlobalConfig, loadProjects, selectProject,
    renderModelConfigUI, updatePreview, showTagsPanel, loadDashboard,
    bindDashboardEvents, bindEvents as bindProjectEvents, initProjectsModule,
} from './projects.mjs';
import { initGraphModule, hideAllMainPanels, bindGraphEvents, bindGraphDeckEvents, stopPhysics } from './graph.mjs';
import {
    initVaultModule, loadNotes, selectNote, openQuickOpen, openTodayNote,
    appendFragmentToToday, openAiImageModal, confirmAiImage,
    insertAiImageIntoNote, insertAiImageIntoSlide, openAssetsModal, resetAssetsModalTab, initAssetsModalTabs,
    bindVaultEvents, bindQuickOpenEvents, createNewNote, saveCurrentNote,
} from './vault.mjs';
import {
    initCardsModule, showCardsPanel, loadCards, selectCard,
    openReviewDeckModal, bindCardsEvents, bindReviewDeckEvents,
} from './cards.mjs';
import { showTrainingWelcome, bindTrainingEvents, loadExams, loadMistakes, selectMistake, bindExamsMistakesEvents } from './exams.mjs';
import { initFragmentsModule, loadFragments, revealFragment, focusFragmentInput, openOrganizeModal, bindFragmentEvents } from './fragments.mjs';
import { bindModalEvents } from './modals.mjs';
import { initGenerateModule, openGenerateModal, bindGenerateEvents } from './generate.mjs';
import { initAgentModule, loadAgentWorkspace, bindAgentEvents } from './agent.mjs';
import { t, applyStaticI18n, getLang, setLang } from './i18n.mjs';

// ============================================================
// DOM 元素缓存
// ============================================================
function cacheEls() {
    initEls({
        projectList: document.getElementById('project-list'),
        emptyState: document.getElementById('empty-state'),
        projectPanel: document.getElementById('project-panel'),
        projectTitle: document.getElementById('project-panel-title'),
        projectStatus: document.getElementById('project-panel-status'),
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
        inputModelPersistApiKey: document.getElementById('input-model-persist-api-key'),
        inputImageModelProvider: document.getElementById('input-image-model-provider'),
        inputImageModelName: document.getElementById('input-image-model-name'),
        inputImageModelBaseUrl: document.getElementById('input-image-model-base-url'),
        inputImageModelApiKey: document.getElementById('input-image-model-api-key'),
        inputImageModelPersistApiKey: document.getElementById('input-image-model-persist-api-key'),
        imageModelOpenaiFields: document.getElementById('image-model-openai-fields'),
        btnTestImageModel: document.getElementById('btn-test-image-model'),
        inputVideoModelProvider: document.getElementById('input-video-model-provider'),
        inputVideoModelName: document.getElementById('input-video-model-name'),
        inputVideoModelBaseUrl: document.getElementById('input-video-model-base-url'),
        inputVideoModelApiKey: document.getElementById('input-video-model-api-key'),
        inputVideoModelPersistApiKey: document.getElementById('input-video-model-persist-api-key'),
        videoModelOpenaiFields: document.getElementById('video-model-openai-fields'),
        btnTestVideoModel: document.getElementById('btn-test-video-model'),
        btnSaveModelConfig: document.getElementById('btn-save-model-config'),
        btnSave: document.getElementById('btn-save'),
        btnGenerate: document.getElementById('btn-generate'),
        btnGenerateContent: document.getElementById('btn-generate-content'),
        btnPreview: document.getElementById('btn-preview'),
        progressCard: document.getElementById('progress-card'),
        progressSteps: document.getElementById('progress-steps'),
        progressLog: document.getElementById('progress-log'),
        createModal: document.getElementById('create-modal'),
        btnCreate: document.getElementById('btn-create'),
        btnCreateProject: document.getElementById('btn-create-project-side'),
        btnCancelCreate: document.getElementById('btn-cancel-create'),
        btnConfirmCreate: document.getElementById('btn-confirm-create'),
        newProjectName: document.getElementById('new-project-name'),
        newProjectTitle: document.getElementById('new-project-title'),
        newProjectTemplate: document.getElementById('new-project-template'),
        themeGalleryModal: document.getElementById('theme-gallery-modal'),
        themeGalleryFrame: document.getElementById('theme-gallery-frame'),
        btnThemeGallery: document.getElementById('btn-theme-gallery'),
        btnCloseThemeGallery: document.getElementById('btn-close-theme-gallery'),
        btnEditMode: document.getElementById('btn-edit-mode'),
        editStatus: document.getElementById('edit-status'),
        projectSidebar: document.getElementById('sidebar'),
        btnCollapseSidebar: document.getElementById('btn-collapse-sidebar'),
        exportDropdown: document.getElementById('export-dropdown'),
        btnExport: document.getElementById('btn-export'),
        btnPublishQuick: document.getElementById('btn-publish-quick'),
        toast: document.getElementById('toast'),
        btnHelp: document.getElementById('btn-help'),
        btnSettingsTopbar: document.getElementById('btn-settings-topbar'),
        appLogo: document.getElementById('app-logo'),
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
        btnDesignLint: document.getElementById('btn-design-lint'),
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
        animationOptions: document.getElementById('animation-options'),
        animationSpeed: document.getElementById('animation-speed'),
        btnSaveAnimation: document.getElementById('btn-save-animation'),
        publishStatusTitle: document.getElementById('publish-status-title'),
        publishStatusDesc: document.getElementById('publish-status-desc'),
        btnPublish: document.getElementById('btn-publish'),
        publishLatest: document.getElementById('publish-latest'),
        publishList: document.getElementById('publish-list'),
        previewFrame: document.getElementById('preview-frame'),
        btnOpenPreview: document.getElementById('btn-open-preview'),
        btnOpenPreviewHeader: document.getElementById('btn-open-preview-header'),
          btnTaskCenter: document.getElementById('btn-task-center'),
          taskCenterBadge: document.getElementById('task-center-badge'),
          taskCenterPanel: document.getElementById('task-center-panel'),
          taskCenterList: document.getElementById('task-center-list'),
          taskCenterEmpty: document.getElementById('task-center-empty'),
          btnTaskCenterClose: document.getElementById('btn-task-center-close'),
          btnTaskCenterClear: document.getElementById('btn-task-center-clear'),
          workspaceGuide: document.getElementById('workspace-guide'),
          workspaceGuideTitle: document.getElementById('workspace-guide-title'),
          workspaceGuideText: document.getElementById('workspace-guide-text'),
          btnGuidePrimary: document.getElementById('btn-guide-primary'),
          btnGuideSecondary: document.getElementById('btn-guide-secondary'),
          mobileWorkspaceTabs: document.querySelectorAll('.mobile-workspace-tab'),
          mobileTaskCardBody: document.getElementById('mobile-task-card-body'),
          btnPreviewMore: document.getElementById('btn-preview-more'),
          previewMoreDropdown: document.getElementById('preview-more-dropdown'),
          settingsModeTabs: document.querySelectorAll('.settings-mode-tab'),
          quickModelPreset: document.getElementById('quick-model-preset'),
          inputAppBrandName: document.getElementById('input-app-brand-name'),
          quickModelApiKey: document.getElementById('quick-model-api-key'),
          quickModelPersistApiKey: document.getElementById('quick-model-persist-api-key'),
          quickPdfEngine: document.getElementById('quick-pdf-engine'),
          btnQuickSaveConfig: document.getElementById('btn-quick-save-config'),
          btnOpenAdvancedSettings: document.getElementById('btn-open-advanced-settings'),
          btnQuickPptOnly: document.getElementById('btn-quick-ppt-only'),
          btnQuickMediaSetup: document.getElementById('btn-quick-media-setup'),
          settingsQuickTip: document.getElementById('settings-quick-tip'),
    });
}

// ============================================================
// switchSidebarTab — 中央侧边栏编排
// ============================================================
function switchSidebarTab(tab, subTab) {
    S.currentSidebarTab = tab;
    // 移动端点 tab 后自动收起抽屉；速记 tab 例外（输入区在抽屉内，需保持展开）
    if (tab !== 'fragments') closeSidebarDrawer();
    document.querySelectorAll('.sidebar-tab').forEach((tabEl) => {
        tabEl.classList.toggle('active', tabEl.dataset.tab === tab);
    });
    // Settings tab icon highlighting (sidebar bottom button + topbar button)
    const settingsTabBtn = document.getElementById('btn-settings-tab');
    if (settingsTabBtn) settingsTabBtn.classList.toggle('active', tab === 'settings');
    const settingsTopbarBtn = document.getElementById('btn-settings-topbar');
    if (settingsTopbarBtn) settingsTopbarBtn.classList.toggle('active', tab === 'settings');
    hideAllMainPanels();
    stopPhysics();
    document.getElementById('fragments-sidebar-content').classList.add('hidden');
    document.getElementById('project-sidebar-content').classList.add('hidden');
    document.getElementById('vault-sidebar-content').classList.add('hidden');
    document.getElementById('agent-sidebar-content').classList.add('hidden');
    document.getElementById('cards-sidebar-content').classList.add('hidden');

    if (tab === 'fragments') {
        document.getElementById('fragments-sidebar-content').classList.remove('hidden');
        document.getElementById('dashboard-panel').classList.remove('hidden');
        loadDashboard();
        loadFragments();
    } else if (tab === 'projects') {
        document.getElementById('project-sidebar-content').classList.remove('hidden');
        loadProjects();
        if (S.currentProject) document.getElementById('project-panel').classList.remove('hidden');
        else document.getElementById('empty-state').classList.remove('hidden');
    } else if (tab === 'vault') {
        document.getElementById('vault-sidebar-content').classList.remove('hidden');
        document.getElementById('vault-panel').classList.remove('hidden');
        loadNotes();
    } else if (tab === 'agent') {
        document.getElementById('agent-sidebar-content').classList.remove('hidden');
        document.getElementById('agent-panel').classList.remove('hidden');
        loadAgentWorkspace();
    } else if (tab === 'cards') {
        document.getElementById('cards-sidebar-content').classList.remove('hidden');
        showCardsPanel();
    } else if (tab === 'study') {
        document.getElementById('study-panel').classList.remove('hidden');
        switchStudySubtab(subTab || S.studySubtab || 'exams');
    } else if (tab === 'settings') {
        document.getElementById('settings-panel').classList.remove('hidden');
        renderModelConfigUI();
    }
}

// 学习面板内子 tab 切换（状态记在 S.studySubtab，不持久化）
function switchStudySubtab(subTab) {
    if (!['exams', 'mistakes', 'training'].includes(subTab)) subTab = 'exams';
    S.studySubtab = subTab;
    document.querySelectorAll('.study-subtab').forEach((el) => {
        el.classList.toggle('active', el.dataset.subtab === subTab);
    });
    document.getElementById('exams-panel').classList.toggle('hidden', subTab !== 'exams');
    document.getElementById('mistakes-panel').classList.toggle('hidden', subTab !== 'mistakes');
    document.getElementById('training-panel').classList.toggle('hidden', subTab !== 'training');
    if (subTab === 'exams') loadExams();
    else if (subTab === 'mistakes') loadMistakes();
    else if (subTab === 'training') showTrainingWelcome();
}

// ============================================================
// openSmartExamModal — 从 dashboard 调用
// ============================================================
function openSmartExamModal() {
    if (S.currentSidebarTab !== 'study') switchSidebarTab('study', 'exams');
    document.getElementById('smart-exam-count').value = '5';
    document.getElementById('smart-exam-subject').value = '';
    const btn = document.getElementById('btn-confirm-smart-exam');
    btn.disabled = false;
    btn.textContent = t('开始组卷');
    document.getElementById('smart-exam-modal').classList.remove('hidden');
}

function showGraphPanel() {
    hideAllMainPanels();
    document.getElementById('graph-panel').classList.remove('hidden');
}

// ============================================================
// AI 配图事件绑定
// ============================================================
function bindAiImageEvents() {
    document.getElementById('btn-vault-note-image')?.addEventListener('click', () => {
        if (!S.currentNote) { showToast(t('请先选择一篇笔记')); return; }
        openAiImageModal('vault');
    });
    document.getElementById('btn-ai-image')?.addEventListener('click', () => {
        if (!S.currentProject) { showToast(t('请先选择项目')); return; }
        openAiImageModal(S.currentProject);
    });
    document.getElementById('btn-cancel-ai-image')?.addEventListener('click', () => {
        document.getElementById('ai-image-modal').classList.add('hidden');
    });
    document.getElementById('btn-confirm-ai-image')?.addEventListener('click', confirmAiImage);
    document.getElementById('btn-ai-image-insert-note')?.addEventListener('click', insertAiImageIntoNote);
    document.getElementById('btn-ai-image-insert-slide')?.addEventListener('click', insertAiImageIntoSlide);
    document.getElementById('btn-vault-assets')?.addEventListener('click', () => {
        resetAssetsModalTab();
        openAssetsModal();
    });
    // 初始化资源库标签页事件（双标签页切换）
    initAssetsModalTabs();
    document.getElementById('btn-close-assets')?.addEventListener('click', () => {
        document.getElementById('assets-modal').classList.add('hidden');
    });
    document.getElementById('ai-image-prompt')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); confirmAiImage(); }
    });
}

// ============================================================
// 学习面板子 tab 事件绑定
// ============================================================
function bindStudyEvents() {
    document.querySelectorAll('.study-subtab').forEach((el) => {
        el.addEventListener('click', () => switchStudySubtab(el.dataset.subtab));
    });
}

// ============================================================
// 首屏空态按钮：跳到新建笔记 / 速记
// ============================================================
function bindEmptyStateEvents() {
    document.getElementById('btn-empty-new-note')?.addEventListener('click', () => {
        switchSidebarTab('vault');
        createNewNote();
    });
    document.getElementById('btn-empty-fragment')?.addEventListener('click', focusFragmentInput);
}

// ============================================================
// 移动端侧边栏抽屉（≤768px：汉堡展开为全高抽屉，点 tab / 遮罩 / Esc 收起）
// ============================================================
function openSidebarDrawer() {
    if (!window.matchMedia('(max-width: 768px)').matches) return; // 抽屉仅移动端
    document.getElementById('sidebar')?.classList.add('drawer-open');
    document.getElementById('sidebar-scrim')?.classList.remove('hidden');
}

function closeSidebarDrawer() {
    document.getElementById('sidebar')?.classList.remove('drawer-open');
    document.getElementById('sidebar-scrim')?.classList.add('hidden');
}

function bindSidebarDrawerEvents() {
    document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (sidebar?.classList.contains('drawer-open')) closeSidebarDrawer();
        else openSidebarDrawer();
    });
    document.getElementById('sidebar-scrim')?.addEventListener('click', closeSidebarDrawer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSidebarDrawer();
    });
}

// ============================================================
// 首次启动向导（localStorage ai-ppt-onboarded 未设置时自动弹出；帮助面板可重新查看）
// ============================================================
const ONBOARDING_KEY = 'ai-ppt-onboarded';
const ONBOARDING_STEPS = [
    {
        title: t('① 记录'),
        desc: t('这里是你的知识中枢。在「速记」tab 随手记录文字、用 🎙 语音听记自动转写、粘贴图片或 PDF 附件；碎片稍后可一键整理为笔记、知识卡片或错题。'),
        cta: t('写第一条速记'),
        action: () => focusFragmentInput(),
    },
    {
        title: t('② 生成'),
        desc: t('从笔记、知识星图或知识卡片一键生成 PPT / 视频 / 报告。生成的作品在「PPT 作品」tab 统一管理，按 选材 → 生成 → 修改 → 发布 四步走完。'),
        cta: t('查看 PPT 作品'),
        action: () => switchSidebarTab('projects'),
    },
    {
        title: t('③ 导出与发布'),
        desc: t('作品支持导出 PPTX / PDF / 单文件 HTML / 视频 MP4，也可一键发布为带二维码的在线链接；「设计检查」会在生成后自动把关排版质量。'),
        cta: t('开始使用'),
        action: null,
    },
];
let onboardingIndex = 0;

function getOnboardingEls() {
    return {
        modal: document.getElementById('onboarding-modal'),
        tag: document.getElementById('onboarding-step-tag'),
        title: document.getElementById('onboarding-title'),
        desc: document.getElementById('onboarding-desc'),
        dots: document.getElementById('onboarding-dots'),
        btnNext: document.getElementById('btn-onboarding-next'),
        btnSkip: document.getElementById('btn-onboarding-skip'),
    };
}

function renderOnboardingStep() {
    const e = getOnboardingEls();
    const step = ONBOARDING_STEPS[onboardingIndex];
    e.tag.textContent = t('第 {n} 步 · 共 {total} 步', { n: onboardingIndex + 1, total: ONBOARDING_STEPS.length });
    e.title.textContent = step.title;
    e.desc.textContent = step.desc;
    e.btnNext.textContent = step.cta;
    e.dots.querySelectorAll('.onboarding-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === onboardingIndex);
    });
}

function openOnboarding() {
    onboardingIndex = 0;
    renderOnboardingStep();
    getOnboardingEls().modal.classList.remove('hidden');
}

function closeOnboarding(persist) {
    getOnboardingEls().modal.classList.add('hidden');
    if (persist) {
        try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* 隐私模式下忽略 */ }
    }
}

function bindOnboardingEvents() {
    const e = getOnboardingEls();
    e.btnNext?.addEventListener('click', () => {
        const step = ONBOARDING_STEPS[onboardingIndex];
        if (onboardingIndex >= ONBOARDING_STEPS.length - 1) { closeOnboarding(true); return; }
        onboardingIndex += 1;
        renderOnboardingStep();
        if (step.action) step.action();
    });
    e.btnSkip?.addEventListener('click', () => closeOnboarding(true));
    document.getElementById('btn-replay-onboarding')?.addEventListener('click', () => {
        document.getElementById('help-panel')?.classList.add('hidden');
        openOnboarding();
    });
}

// ============================================================
// 初始化：注入回调 → 加载数据 → 绑定事件
// ============================================================
applyStaticI18n(); // 静态文案批量替换（zh 模式恒等；module script 延迟执行，DOM 已就绪）
cacheEls();
loadThemes();

const commonCbs = {
    switchSidebarTab,
    hideAllMainPanels,
    selectNote,
    saveCurrentNote,
    loadProjects,
    selectProject,
    updatePreview,
    loadCards,
    selectCard,
    loadFragments,
      revealFragment,
    loadDashboard,
    loadGlobalConfig,
      loadMistakes,
      selectMistake,
    showTagsPanel,
    stopPhysics,
    focusFragmentInput,
    openOrganizeModal,
    openSmartExamModal,
    showGraphPanel,
    openTodayNote,
    loadNotes,
    openReviewDeckModal,
    openGenerateModal,
    confirmAiImage,
    appendFragmentToToday,
    openSidebarDrawer,
    closeSidebarDrawer,
};

initProjectsModule(commonCbs);
initGraphModule(commonCbs);
initVaultModule(commonCbs);
initCardsModule(commonCbs);
initFragmentsModule(commonCbs);
initGenerateModule(commonCbs);
initAgentModule(commonCbs);

// 启动加载链
loadModels().then(loadGlobalConfig).then(() => {
    return loadProjects();
}).then(() => {
    bindVaultEvents();
    bindGraphEvents();
    bindGraphDeckEvents();
    bindCardsEvents();
    bindExamsMistakesEvents();
    bindTrainingEvents();
    bindReviewDeckEvents();
    bindFragmentEvents();
    bindQuickOpenEvents();
    bindDashboardEvents();
    bindAiImageEvents();
    bindModalEvents();
    bindGenerateEvents();
    bindAgentEvents();
    bindEmptyStateEvents();
    bindStudyEvents();
    bindSidebarDrawerEvents();
    bindOnboardingEvents();
    switchSidebarTab('vault');
    // 首次使用：数据加载完成后弹出 3 步向导
    let onboarded = null;
    try { onboarded = localStorage.getItem(ONBOARDING_KEY); } catch { /* 隐私模式下忽略 */ }
    if (!onboarded && S.notes.length === 0 && S.projects.length === 0) openOnboarding();
}).catch((e) => {
    console.error('启动失败:', e);
    showToast('加载失败，点击重试', 'error');
    // 简单持久化重试按钮：刷新重试
    const toastEl = document.getElementById('toast');
    toastEl.style.cursor = 'pointer';
    toastEl.onclick = () => location.reload();
});
bindProjectEvents();

// 界面语言切换（设置面板 #input-ui-lang）：切换即 reload，状态在 localStorage/服务端，安全
const uiLangSelect = document.getElementById('input-ui-lang');
if (uiLangSelect) {
    uiLangSelect.value = getLang();
    uiLangSelect.addEventListener('change', () => setLang(uiLangSelect.value));
}

// PWA：线上保留 Service Worker；本地开发/本机回环禁用并清理缓存，
// 避免 index.html 与模块脚本被旧 SW 交叉缓存后出现“加载失败”。
const isLoopbackHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
if ('serviceWorker' in navigator) {
    if (isLoopbackHost) {
        navigator.serviceWorker.getRegistrations()
            .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
            .catch(() => { /* 注销失败静默 */ });
        if ('caches' in window) {
            caches.keys()
                .then((keys) => Promise.all(keys
                    .filter((key) => key.startsWith('ai-ppt-v'))
                    .map((key) => caches.delete(key))))
                .catch(() => { /* 清缓存失败静默 */ });
        }
    } else if (location.protocol === 'https:') {
        navigator.serviceWorker.register('/sw.js')
            .then((reg) => {
                let reloading = false;
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    if (reloading) return;
                    reloading = true;
                    location.reload();
                });
                reg.update().catch(() => { /* 更新检查失败忽略 */ });
            })
            .catch(() => { /* 注册失败静默（如隐私模式） */ });
    }
}

// Settings tab button (sidebar bottom icon + topbar both open settings panel)
document.getElementById('btn-settings-tab')?.addEventListener('click', () => switchSidebarTab('settings'));
document.getElementById('btn-settings-topbar')?.addEventListener('click', () => switchSidebarTab('settings'));
