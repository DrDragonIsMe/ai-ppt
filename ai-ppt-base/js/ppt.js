(function () {
  'use strict';

  const state = {
    current: 0,
    slides: [],
    overview: false,
    help: true,
    transitioning: false,
    currentTheme: 'web-ui',
    sidebarOpen: true,
  };

  // Theme definitions
  const themes = [
    { id: 'web-ui', name: 'Web UI', color: '#0D9488' },
    { id: 'business-blue', name: '商务蓝', color: '#2563EB' },
    { id: 'elegant-purple', name: '优雅紫', color: '#7C3AED' },
    { id: 'warm-orange', name: '温暖橙', color: '#EA580C' },
    { id: 'sunset-red', name: '日落红', color: '#E11D48' },
    { id: 'tech-green', name: '科技绿', color: '#65A30D' },
    { id: 'minimal-gray', name: '极简灰', color: '#171717' },
    { id: 'dark-mode', name: '暗黑模式', color: '#22D3EE' },
  ];

  const stage = document.getElementById('stage');
  const overviewEl = document.getElementById('overview');
  const overviewGrid = overviewEl.querySelector('.overview-grid');
  const progressEl = document.getElementById('progress');
  const hudEl = document.getElementById('hud');
  const toastEl = document.getElementById('toast');
  const helpEl = document.getElementById('help');
  const originalTitle = document.title || 'ai-ppt';

  let sidebarEl = null;
  let sidebarContentEl = null;

  let themeLink = null;
  let themeSwitcherEl = null;
  let themePanelEl = null;
  let fullscreenBtn = null;
  let fullscreenTimeout = null;

  function init() {
    state.slides = Array.from(document.querySelectorAll('.slide'));
    if (state.slides.length === 0) return;

    initThemes();
    buildSidebar();
    buildOverview();
    buildFullscreenBtn();
    updateSlide();
    bindEvents();

    window.addEventListener('resize', onResize);
    onResize();
  }

  function initThemes() {
    // A theme class hard-coded on <body> (set by generate-deck wrapSlides from
    // ai-ppt.json `theme`) takes precedence; otherwise fall back to the theme
    // the user last picked in this browser.
    const preset = themes.map(t => t.id).find((id) => document.body.classList.contains(`theme-${id}`));
    if (preset) {
      state.currentTheme = preset;
    } else {
      const savedTheme = localStorage.getItem('ai-ppt-theme');
      if (savedTheme) {
        state.currentTheme = savedTheme;
      }
    }

    // Apply initial theme
    applyTheme(state.currentTheme);

    // Build theme switcher UI
    buildThemeSwitcher();
  }

  function buildThemeSwitcher() {
    themeSwitcherEl = document.createElement('div');
    themeSwitcherEl.className = 'theme-switcher';
    themeSwitcherEl.innerHTML = `
      <button class="theme-switcher-toggle" type="button" aria-label="切换主题">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2"></path>
          <path d="M12 20v2"></path>
          <path d="m4.93 4.93 1.41 1.41"></path>
          <path d="m17.66 17.66 1.41 1.41"></path>
          <path d="M2 12h2"></path>
          <path d="M20 12h2"></path>
          <path d="m6.34 17.66-1.41 1.41"></path>
          <path d="m19.07 4.93-1.41 1.41"></path>
        </svg>
        <span>主题</span>
      </button>
      <div class="theme-switcher-panel">
        <div class="theme-switcher-title">选择主题</div>
        <div class="theme-list"></div>
      </div>
    `;

    themePanelEl = themeSwitcherEl.querySelector('.theme-switcher-panel');
    const themeList = themeSwitcherEl.querySelector('.theme-list');

    themes.forEach((theme) => {
      const option = document.createElement('div');
      option.className = 'theme-option' + (theme.id === state.currentTheme ? ' active' : '');
      option.dataset.themeId = theme.id;
      option.innerHTML = `
        <span class="theme-swatch" style="background: ${theme.color};"></span>
        <span class="theme-name">${theme.name}</span>
      `;
      option.addEventListener('click', () => selectTheme(theme.id));
      themeList.appendChild(option);
    });

    const toggleBtn = themeSwitcherEl.querySelector('.theme-switcher-toggle');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleThemePanel();
    });

    document.addEventListener('click', () => {
      closeThemePanel();
    });

    themePanelEl.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.body.appendChild(themeSwitcherEl);

    // Add hint
    const hint = document.createElement('div');
    hint.className = 'theme-hint';
    hint.textContent = '按 T 键快速切换主题';
    document.body.appendChild(hint);
  }

  function toggleThemePanel() {
    const isOpen = themePanelEl.classList.contains('open');
    if (isOpen) {
      closeThemePanel();
    } else {
      openThemePanel();
    }
  }

  function openThemePanel() {
    themePanelEl.classList.add('open');
  }

  function closeThemePanel() {
    themePanelEl.classList.remove('open');
  }

  function selectTheme(themeId) {
    if (themeId === state.currentTheme) {
      closeThemePanel();
      return;
    }

    state.currentTheme = themeId;
    applyTheme(themeId);
    localStorage.setItem('ai-ppt-theme', themeId);

    // Update UI
    const options = themeSwitcherEl.querySelectorAll('.theme-option');
    options.forEach((option) => {
      option.classList.toggle('active', option.dataset.themeId === themeId);
    });

    closeThemePanel();

    const theme = themes.find((t) => t.id === themeId);
    showToast(`已切换到「${theme?.name || themeId}」主题`);
  }

  function applyTheme(themeId) {
    document.body.classList.remove(...themes.map(t => `theme-${t.id}`));
    if (themeId !== 'web-ui') {
      document.body.classList.add(`theme-${themeId}`);
    }
  }

  function buildSidebar() {
    sidebarEl = document.createElement('div');
    sidebarEl.className = 'sidebar';
    sidebarEl.innerHTML = `
      <button class="sidebar-toggle" type="button" aria-label="切换侧边栏">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 18l-6-6 6-6"></path>
        </svg>
      </button>
      <div class="sidebar-header">
        <div class="sidebar-title">幻灯片</div>
      </div>
      <div class="sidebar-content"></div>
    `;

    sidebarContentEl = sidebarEl.querySelector('.sidebar-content');

    const toggleBtn = sidebarEl.querySelector('.sidebar-toggle');
    toggleBtn.addEventListener('click', () => toggleSidebar());

    // Build sidebar thumbnails
    buildSidebarThumbnails();

    // Insert sidebar into DOM (before stage)
    stage.parentNode.insertBefore(sidebarEl, stage);

    // Apply initial sidebar state
    updateSidebarState();
  }

  function buildSidebarThumbnails() {
    if (!sidebarContentEl) return;
    sidebarContentEl.innerHTML = '';
    const BASE_W = 1280;
    const BASE_H = 800;

    state.slides.forEach((slide, i) => {
      const card = document.createElement('div');
      card.className = 'sidebar-card';
      card.dataset.index = String(i);

      const indexBadge = document.createElement('div');
      indexBadge.className = 'sidebar-index';
      indexBadge.textContent = String(i + 1);

      const clone = slide.cloneNode(true);
      clone.classList.remove('active');
      clone.removeAttribute('id');
      clone.style.width = `${BASE_W}px`;
      clone.style.height = `${BASE_H}px`;

      // Render animated components at their final state in the thumbnail
      clone.querySelectorAll('.progress-ring-circle').forEach((c) => {
        const legacy = parseFloat(c.style.getPropertyValue('--progress'));
        const pct = parseFloat(c.style.getPropertyValue('--progress-pct'));
        c.style.strokeDashoffset = Number.isFinite(legacy)
          ? legacy
          : 314 - (314 * (Number.isFinite(pct) ? pct : 0)) / 100;
      });
      clone.querySelectorAll('.waterfall-fill').forEach((f) => {
        f.style.width = f.style.getPropertyValue('--width') || '0%';
      });

      card.appendChild(indexBadge);
      card.appendChild(clone);
      sidebarContentEl.appendChild(card);

      requestAnimationFrame(() => {
        const scale = card.clientWidth / BASE_W;
        clone.style.transform = `scale(${scale})`;
        clone.style.transformOrigin = 'top left';
      });

      card.addEventListener('click', () => {
        goTo(i);
      });
    });
  }

  function toggleSidebar(open) {
    if (typeof open === 'boolean') {
      state.sidebarOpen = open;
    } else {
      state.sidebarOpen = !state.sidebarOpen;
    }
    updateSidebarState();
  }

  function updateSidebarState() {
    if (!sidebarEl) return;
    sidebarEl.classList.toggle('collapsed', !state.sidebarOpen);
    stage.classList.toggle('sidebar-open', state.sidebarOpen);

    // Adjust positions of other UI elements
    const leftOffset = state.sidebarOpen ? '220px' : '0px';
    progressEl.style.left = leftOffset;
    hudEl.style.left = `calc(50% + ${state.sidebarOpen ? '110px' : '0px'})`;

    const toggleBtn = sidebarEl.querySelector('.sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = state.sidebarOpen
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M15 18l-6-6 6-6"></path>
           </svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M9 18l6-6-6-6"></path>
           </svg>`;
    }
  }

  function buildFullscreenBtn() {
    fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'fullscreen-btn';
    fullscreenBtn.innerHTML = `
      <svg class="enter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3H3v5"></path>
        <path d="M21 8V3h-5"></path>
        <path d="M3 16v5h5"></path>
        <path d="M16 21h5v-5"></path>
      </svg>
      <svg class="exit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 14h6v6"></path>
        <path d="M14 4h6v6"></path>
        <path d="M14 14h6v6"></path>
        <path d="M4 4h6v6"></path>
        <path d="M14 14l6-6"></path>
        <path d="M4 20l6-6"></path>
      </svg>
      <span>全屏</span>
    `;
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    document.body.appendChild(fullscreenBtn);
  }

  function cycleTheme() {
    const currentIndex = themes.findIndex((t) => t.id === state.currentTheme);
    const nextIndex = (currentIndex + 1) % themes.length;
    selectTheme(themes[nextIndex].id);
  }

  function bindEvents() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick);
    overviewEl.addEventListener('click', onOverviewClick);

    helpEl.addEventListener('mouseenter', () => {
      if (state.help) toggleHelp();
    });

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mousemove', onFullscreenActivity);
    document.addEventListener('touchstart', onFullscreenActivity, { passive: true });
  }

  // In fullscreen the overlay UI (help panel, theme switcher, hud,
  // fullscreen button) stays hidden; any pointer activity reveals it
  // briefly, then a timer hides it again.
  function onFullscreenActivity() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      document.documentElement.classList.add('fs-ui-visible');
      clearTimeout(fullscreenTimeout);
      fullscreenTimeout = setTimeout(() => {
        document.documentElement.classList.remove('fs-ui-visible');
      }, 2000);
    }
  }

  function onKeyDown(e) {
    if (state.overview || state.transitioning) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        goTo(state.slides.length - 1);
      } else {
        next();
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        goTo(0);
      } else {
        prev();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      exportPdf();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      toggleOverview(true);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.overview) {
        toggleOverview(false);
      } else if (document.fullscreenElement) {
        exitFullscreen();
      } else if (themePanelEl && themePanelEl.classList.contains('open')) {
        closeThemePanel();
      }
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      cycleTheme();
      return;
    }

    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      toggleHelp();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      exportPdf();
      return;
    }
  }

  function onClick(e) {
    if (state.overview || state.transitioning) return;

    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (!isFullscreen) return;

    const target = e.target;
    if (target.closest('a') || target.closest('button') || target.closest('.help') || target.closest('.theme-switcher') || target.closest('.fullscreen-btn')) return;

    if (e.button === 0) {
      const x = e.clientX;
      const w = window.innerWidth;
      if (x < w * 0.3) {
        prev();
      } else if (x > w * 0.7) {
        next();
      }
    }
  }

  function onOverviewClick(e) {
    const card = e.target.closest('.overview-card');
    if (!card) {
      toggleOverview(false);
      return;
    }

    const index = parseInt(card.dataset.index, 10);
    if (!Number.isNaN(index)) {
      goTo(index);
      toggleOverview(false);
    }
  }

  function next() {
    animateTransition(state.current + 1, 'forward');
  }

  function prev() {
    animateTransition(state.current - 1, 'backward');
  }

  function animateTransition(targetIndex, direction) {
    if (targetIndex < 0 || targetIndex >= state.slides.length) return;
    if (state.transitioning) return;

    const currentSlide = state.slides[state.current];
    currentSlide.classList.remove('active');
    currentSlide.classList.add(direction === 'forward' ? 'exit-forward' : 'exit-backward');

    state.transitioning = true;

    setTimeout(() => {
      currentSlide.classList.remove('exit-forward', 'exit-backward');
      goTo(targetIndex);
      state.transitioning = false;
    }, 350);
  }

  function goTo(index) {
    if (index < 0 || index >= state.slides.length) return;
    state.current = index;
    updateSlide();
  }

  window.goTo = goTo;

  function updateSlide() {
    state.slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === state.current);
    });

    const pct = ((state.current + 1) / state.slides.length) * 100;
    progressEl.style.width = pct + '%';
    hudEl.textContent = `${state.current + 1} / ${state.slides.length}`;

    document.title = `${originalTitle} · ${state.current + 1} / ${state.slides.length}`;

    updateOverviewActive();
    updateSidebarActive();
  }

  function updateSidebarActive() {
    if (!sidebarContentEl) return;
    const cards = sidebarContentEl.querySelectorAll('.sidebar-card');
    cards.forEach((card, i) => {
      card.classList.toggle('active', i === state.current);
    });
    // Scroll the active card into view
    const activeCard = sidebarContentEl.querySelector('.sidebar-card.active');
    if (activeCard) {
      activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function toggleOverview(show) {
    state.overview = show;
    overviewEl.classList.toggle('hidden', !show);
    if (show) {
      buildOverview();
      updateOverviewActive();
    }
  }

  function buildOverview() {
    overviewGrid.innerHTML = '';
    // Thumbnails: clone each slide at a fixed design size, then scale the
    // whole clone to the card width (uniform transform), preserving the
    // slide's real layout.
    const BASE_W = 1280;
    const BASE_H = 800;

    state.slides.forEach((slide, i) => {
      const card = document.createElement('div');
      card.className = 'overview-card';
      card.dataset.index = String(i);

      const indexBadge = document.createElement('div');
      indexBadge.className = 'overview-index';
      indexBadge.textContent = String(i + 1);

      const clone = slide.cloneNode(true);
      clone.classList.remove('active');
      clone.removeAttribute('id');
      clone.style.width = `${BASE_W}px`;
      clone.style.height = `${BASE_H}px`;

      // Render animated components at their final state in the thumbnail
      // (the fill animations only run on .slide.active in the live deck).
      clone.querySelectorAll('.progress-ring-circle').forEach((c) => {
        const legacy = parseFloat(c.style.getPropertyValue('--progress'));
        const pct = parseFloat(c.style.getPropertyValue('--progress-pct'));
        c.style.strokeDashoffset = Number.isFinite(legacy)
          ? legacy
          : 314 - (314 * (Number.isFinite(pct) ? pct : 0)) / 100;
      });
      clone.querySelectorAll('.waterfall-fill').forEach((f) => {
        f.style.width = f.style.getPropertyValue('--width') || '0%';
      });

      card.appendChild(indexBadge);
      card.appendChild(clone);
      overviewGrid.appendChild(card);

      requestAnimationFrame(() => {
        const scale = card.clientWidth / BASE_W;
        clone.style.transform = `scale(${scale})`;
        clone.style.transformOrigin = 'top left';
      });
    });
  }

  function updateOverviewActive() {
    const cards = overviewGrid.querySelectorAll('.overview-card');
    cards.forEach((card, i) => {
      card.style.outline = i === state.current ? '2px solid var(--teal)' : 'none';
    });
  }

  function exportPdf() {
    showToast('正在打开打印对话框，请选择"存储为 PDF"并指定保存位置');

    requestAnimationFrame(() => {
      window.print();
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      exitFullscreen();
    } else {
      requestFullscreen(document.documentElement);
    }
  }

  function requestFullscreen(el) {
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  }

  function exitFullscreen() {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }

  function onFullscreenChange() {
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    clearTimeout(fullscreenTimeout);
    document.documentElement.classList.remove('fs-ui-visible');
    if (isFullscreen) {
      showToast('全屏模式：点击右侧翻下页，左侧翻上页，ESC 退出');
      if (fullscreenBtn) {
        fullscreenBtn.querySelector('span').textContent = '退出';
      }
    } else {
      if (fullscreenBtn) {
        fullscreenBtn.querySelector('span').textContent = '全屏';
      }
    }
  }

  function toggleHelp() {
    state.help = !state.help;
    helpEl.classList.toggle('hidden', !state.help);
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2500);
  }

  function onResize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Use the smaller dimension as base for better coverage on ultrawide/short screens
    const base = Math.min(vw / 1280, vh / 720, 1);
    document.documentElement.style.fontSize = `${16 * Math.max(base, 0.5)}px`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
