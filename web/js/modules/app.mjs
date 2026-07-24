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
    bindVaultEvents, bindQuickOpenEvents, createNewNote, saveCurrentNote,
} from './vault.mjs';
import {
    initCardsModule, showCardsPanel, loadCards, selectCard,
    openReviewDeckModal, bindCardsEvents, bindReviewDeckEvents,
} from './cards.mjs';
import { showTrainingWelcome, bindTrainingEvents, loadExams, loadMistakes, bindExamsMistakesEvents } from './exams.mjs';
import { initFragmentsModule, loadFragments, focusFragmentInput, openOrganizeModal, bindFragmentEvents } from './fragments.mjs';
import { bindModalEvents } from './modals.mjs';
import { initGenerateModule, openGenerateModal, bindGenerateEvents } from './generate.mjs';

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
        btnEditMode: document.getElementById('btn-edit-mode'),
        editStatus: document.getElementById('edit-status'),
        projectSidebar: document.getElementById('sidebar'),
        btnCollapseSidebar: document.getElementById('btn-collapse-sidebar'),
        exportDropdown: document.getElementById('export-dropdown'),
        btnExport: document.getElementById('btn-export'),
        toast: document.getElementById('toast'),
        btnHelp: document.getElementById('btn-help'),
        btnSettings: document.getElementById('btn-settings'),
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
    });
}

// ============================================================
// switchSidebarTab — 中央侧边栏编排
// ============================================================
function switchSidebarTab(tab, subTab) {
    S.currentSidebarTab = tab;
    document.querySelectorAll('.sidebar-tab').forEach((tabEl) => {
        tabEl.classList.toggle('active', tabEl.dataset.tab === tab);
    });
    if (S.els.btnSettings) S.els.btnSettings.classList.toggle('active', tab === 'settings');
    hideAllMainPanels();
    stopPhysics();
    document.getElementById('fragments-sidebar-content').classList.add('hidden');
    document.getElementById('project-sidebar-content').classList.add('hidden');
    document.getElementById('vault-sidebar-content').classList.add('hidden');
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
    btn.textContent = '开始组卷';
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
        if (!S.currentNote) { showToast('请先选择一篇笔记'); return; }
        openAiImageModal('vault');
    });
    document.getElementById('btn-ai-image')?.addEventListener('click', () => {
        if (!S.currentProject) { showToast('请先选择项目'); return; }
        openAiImageModal(S.currentProject);
    });
    document.getElementById('btn-cancel-ai-image')?.addEventListener('click', () => {
        document.getElementById('ai-image-modal').classList.add('hidden');
    });
    document.getElementById('btn-confirm-ai-image')?.addEventListener('click', confirmAiImage);
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
// 初始化：注入回调 → 加载数据 → 绑定事件
// ============================================================
cacheEls();
loadThemes();

const commonCbs = {
    switchSidebarTab,
    hideAllMainPanels,
    selectNote,
    saveCurrentNote,
    loadProjects,
    selectProject,
    loadCards,
    selectCard,
    loadFragments,
    loadDashboard,
    showTagsPanel,
    stopPhysics,
    focusFragmentInput,
    openOrganizeModal,
    openSmartExamModal,
    showGraphPanel,
    openTodayNote,
    openReviewDeckModal,
    openGenerateModal,
    confirmAiImage,
    appendFragmentToToday,
};

initProjectsModule(commonCbs);
initGraphModule(commonCbs);
initVaultModule(commonCbs);
initCardsModule(commonCbs);
initFragmentsModule(commonCbs);
initGenerateModule(commonCbs);

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
    bindEmptyStateEvents();
    bindStudyEvents();
    switchSidebarTab('vault');
});
bindProjectEvents();
