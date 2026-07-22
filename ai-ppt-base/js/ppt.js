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
    presenter: false,
    editMode: false,
    editOriginalHtml: '',
    markerMode: false,
    markerDrawing: false,
    markerColor: '#EF4444',
    markerStrokes: new Map(),
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

  // Presenter (speaker) mode
  let presenterWin = null;
  let presenterTimer = null;
  let presenterStart = 0;

  // Marker (laser pen / annotation) mode
  let markerToolbarEl = null;
  let markerCurrentPath = null;

  function init() {
    state.slides = Array.from(document.querySelectorAll('.slide'));
    if (state.slides.length === 0) return;

    initThemes();
    buildSidebar();
    buildOverview();
    buildFullscreenBtn();
    buildMarkerToolbar();
    initEditMode();
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

  // ===== Marker pen (per-slide annotations) =====

  function buildMarkerToolbar() {
    markerToolbarEl = document.createElement('div');
    markerToolbarEl.className = 'marker-toolbar';
    markerToolbarEl.innerHTML = `
      <button class="marker-btn marker-toggle" type="button" title="标识笔 (M)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
        </svg>
        <span>标识笔</span>
      </button>
      <div class="marker-colors">
        <button class="marker-color-btn active" data-color="#EF4444" style="background: #EF4444;" title="红色"></button>
        <button class="marker-color-btn" data-color="#2563EB" style="background: #2563EB;" title="蓝色"></button>
        <button class="marker-color-btn" data-color="#22C55E" style="background: #22C55E;" title="绿色"></button>
        <button class="marker-color-btn" data-color="#111827" style="background: #111827;" title="黑色"></button>
      </div>
      <button class="marker-btn marker-clear" type="button" title="清除本页标记">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        <span>清除</span>
      </button>
    `;

    markerToolbarEl.querySelector('.marker-toggle').addEventListener('click', toggleMarkerMode);
    markerToolbarEl.querySelector('.marker-clear').addEventListener('click', clearCurrentSlideMarkers);
    markerToolbarEl.querySelectorAll('.marker-color-btn').forEach((btn) => {
      btn.addEventListener('click', () => setMarkerColor(btn.dataset.color));
    });

    document.body.appendChild(markerToolbarEl);
    updateMarkerUI();
  }

  function toggleMarkerMode() {
    state.markerMode = !state.markerMode;
    document.documentElement.classList.toggle('marker-mode', state.markerMode);
    updateMarkerUI();
    showToast(state.markerMode ? '标识笔已开启，在本页圈点即可' : '标识笔已关闭');
  }

  function setMarkerColor(color) {
    state.markerColor = color;
    markerToolbarEl.querySelectorAll('.marker-color-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });
  }

  function updateMarkerUI() {
    if (!markerToolbarEl) return;
    markerToolbarEl.classList.toggle('active', state.markerMode);
    const toggleBtn = markerToolbarEl.querySelector('.marker-toggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', state.markerMode);
    }
  }

  function ensureMarkerOverlay(slide) {
    let overlay = slide.querySelector(':scope > .marker-overlay');
    if (!overlay) {
      overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.classList.add('marker-overlay');
      overlay.setAttribute('viewBox', '0 0 1280 800');
      overlay.setAttribute('preserveAspectRatio', 'none');
      slide.appendChild(overlay);

      overlay.addEventListener('pointerdown', onMarkerPointerDown);
      overlay.addEventListener('pointermove', onMarkerPointerMove);
      overlay.addEventListener('pointerup', onMarkerPointerUp);
      overlay.addEventListener('pointerleave', onMarkerPointerUp);
    }
    return overlay;
  }

  function getSlideMarkers() {
    return state.markerStrokes.get(state.current) || [];
  }

  function setSlideMarkers(strokes) {
    state.markerStrokes.set(state.current, strokes);
  }

  function onMarkerPointerDown(e) {
    if (!state.markerMode) return;
    const overlay = e.currentTarget;
    const slide = overlay.closest('.slide');
    if (!slide || !slide.classList.contains('active')) return;

    e.preventDefault();
    state.markerDrawing = true;
    const pt = getSvgPoint(overlay, e);
    markerCurrentPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    markerCurrentPath.setAttribute('d', `M ${pt.x} ${pt.y}`);
    markerCurrentPath.setAttribute('stroke', state.markerColor);
    markerCurrentPath.setAttribute('stroke-width', '3');
    markerCurrentPath.setAttribute('stroke-linecap', 'round');
    markerCurrentPath.setAttribute('stroke-linejoin', 'round');
    markerCurrentPath.setAttribute('fill', 'none');
    overlay.appendChild(markerCurrentPath);
  }

  function onMarkerPointerMove(e) {
    if (!state.markerDrawing || !markerCurrentPath) return;
    const overlay = e.currentTarget;
    const pt = getSvgPoint(overlay, e);
    const d = markerCurrentPath.getAttribute('d');
    markerCurrentPath.setAttribute('d', `${d} L ${pt.x} ${pt.y}`);
  }

  function onMarkerPointerUp() {
    if (!state.markerDrawing || !markerCurrentPath) return;
    state.markerDrawing = false;
    const strokes = getSlideMarkers();
    strokes.push(markerCurrentPath.getAttribute('d'));
    setSlideMarkers(strokes);
    markerCurrentPath = null;
  }

  function getSvgPoint(svg, e) {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1280;
    const y = ((e.clientY - rect.top) / rect.height) * 800;
    return { x: x.toFixed(1), y: y.toFixed(1) };
  }

  function renderSlideMarkers(slideIndex) {
    const slide = state.slides[slideIndex];
    if (!slide) return;
    const overlay = ensureMarkerOverlay(slide);
    const strokes = state.markerStrokes.get(slideIndex) || [];
    overlay.innerHTML = '';
    strokes.forEach((d) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', state.markerColor);
      path.setAttribute('stroke-width', '3');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('fill', 'none');
      overlay.appendChild(path);
    });
  }

  function clearCurrentSlideMarkers() {
    const overlay = state.slides[state.current]?.querySelector(':scope > .marker-overlay');
    if (overlay) overlay.innerHTML = '';
    state.markerStrokes.delete(state.current);
    showToast('已清除本页标记');
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

    window.addEventListener('beforeunload', closePresenter);
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
    if (state.editMode) return;
    if (e.target && (e.target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))) return;

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

    if (e.key === 's') {
      e.preventDefault();
      if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
        toggleSidebar();
      }
      return;
    }

    if (e.key === 'S') {
      e.preventDefault();
      togglePresenter();
      return;
    }

    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleMarkerMode();
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
        toggleHelp();
      }
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
    if (target.closest('a') || target.closest('button') || target.closest('.help') || target.closest('.theme-switcher') || target.closest('.fullscreen-btn') || target.closest('.marker-toolbar') || target.closest('.marker-overlay')) return;

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
    renderSlideMarkers(state.current);
    syncPresenter();
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

  // ===== Presenter (speaker) mode =====
  // Shift+S opens a presenter window with the current slide's speaker notes
  // (<div class="speaker-note">), a scaled preview of the next slide, and an
  // elapsed-time timer. Shift+S again or closing the window exits.

  function togglePresenter() {
    if (state.presenter) {
      closePresenter();
    } else {
      openPresenter();
    }
  }

  function openPresenter() {
    const win = window.open('about:blank', 'ai-ppt-presenter', 'width=980,height=680');
    if (!win) {
      showToast('演讲者窗口被浏览器拦截，请允许弹出窗口后重试');
      return;
    }

    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"], style[id="theme-overrides"]'))
      .map((node) => {
        if (node.tagName === 'LINK') {
          return `<link rel="stylesheet" href="${new URL(node.getAttribute('href'), location.href).href}">`;
        }
        return `<style id="theme-overrides">${node.innerHTML}</style>`;
      })
      .join('\n');

    win.document.open();
    win.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>演讲者模式</title>
${links}
<style>
  html, body { margin: 0; height: 100%; }
  body.pv-body {
    overflow: auto;
    background: #0B1413;
    color: #FAFAF7;
    font-family: -apple-system, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
    display: flex;
    flex-direction: column;
  }
  .pv-header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    border-bottom: 1px solid rgba(250, 250, 247, 0.12);
  }
  .pv-title { font-weight: 600; letter-spacing: 0.05em; }
  .pv-counter { color: rgba(250, 250, 247, 0.6); font-size: 14px; }
  .pv-timer {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-size: 20px;
    color: var(--teal, #0D9488);
  }
  .pv-main {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    padding: 20px;
    min-height: 0;
  }
  .pv-main h2 {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(250, 250, 247, 0.5);
  }
  .pv-notes, .pv-next { min-width: 0; }
  .pv-notes-content {
    font-size: 18px;
    line-height: 1.7;
  }
  .pv-notes-content p { margin: 0 0 0.8em; }
  .pv-notes-empty { color: rgba(250, 250, 247, 0.4); font-size: 15px; }
  .pv-next-frame {
    position: relative;
    width: 100%;
    aspect-ratio: 1280 / 800;
    overflow: hidden;
    border-radius: 8px;
    background: var(--cream, #FAFAF7);
  }
  .pv-next-frame .slide {
    position: absolute;
    top: 0;
    left: 0;
    opacity: 1;
    pointer-events: none;
  }
  .pv-next-end { color: rgba(250, 250, 247, 0.4); font-size: 15px; }
  .pv-footer {
    padding: 10px 20px;
    border-top: 1px solid rgba(250, 250, 247, 0.12);
    color: rgba(250, 250, 247, 0.5);
    font-size: 13px;
  }
  .pv-footer kbd {
    padding: 1px 6px;
    border: 1px solid rgba(250, 250, 247, 0.3);
    border-radius: 4px;
    font-family: inherit;
  }
</style>
</head>
<body class="pv-body ${document.body.className}">
<header class="pv-header">
  <span class="pv-title">演讲者模式</span>
  <span class="pv-counter" id="pv-counter"></span>
  <span class="pv-timer" id="pv-timer">00:00</span>
</header>
<main class="pv-main">
  <section class="pv-notes">
    <h2>演讲备注</h2>
    <div class="pv-notes-content" id="pv-notes-content"></div>
  </section>
  <section class="pv-next">
    <h2>下一页预览</h2>
    <div class="pv-next-frame" id="pv-next-frame"></div>
    <div class="pv-next-end" id="pv-next-end" hidden>已是最后一页</div>
  </section>
</main>
<footer class="pv-footer">按 <kbd>Shift</kbd>+<kbd>S</kbd>（主窗口或本窗口）或关闭本窗口退出演讲者模式</footer>
</body>
</html>`);
    win.document.close();

    presenterWin = win;
    state.presenter = true;
    presenterStart = Date.now();

    win.document.addEventListener('keydown', (e) => {
      if (e.key === 'S') {
        e.preventDefault();
        closePresenter();
      }
    });

    presenterTimer = setInterval(tickPresenter, 1000);
    syncPresenter();
    showToast('演讲者模式已开启（Shift+S 退出）');
  }

  function closePresenter() {
    state.presenter = false;
    clearInterval(presenterTimer);
    presenterTimer = null;
    if (presenterWin && !presenterWin.closed) {
      presenterWin.close();
    }
    presenterWin = null;
  }

  function tickPresenter() {
    if (!presenterWin || presenterWin.closed) {
      closePresenter();
      return;
    }
    const elapsed = Math.floor((Date.now() - presenterStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const timerEl = presenterWin.document.getElementById('pv-timer');
    if (timerEl) {
      timerEl.textContent = `${mm}:${ss}`;
    }
  }

  // Keep the presenter window in sync with the deck; called from updateSlide().
  function syncPresenter() {
    if (!state.presenter || !presenterWin || presenterWin.closed) return;

    const doc = presenterWin.document;
    const counterEl = doc.getElementById('pv-counter');
    const notesEl = doc.getElementById('pv-notes-content');
    const frameEl = doc.getElementById('pv-next-frame');
    const endEl = doc.getElementById('pv-next-end');
    if (!counterEl || !notesEl || !frameEl || !endEl) return;

    counterEl.textContent = `${state.current + 1} / ${state.slides.length}`;

    const notes = state.slides[state.current].querySelectorAll('.speaker-note');
    notesEl.innerHTML = notes.length
      ? Array.from(notes).map((note) => `<p>${note.innerHTML}</p>`).join('')
      : '<p class="pv-notes-empty">（本页无演讲备注）</p>';

    // Next-slide preview: clone at a fixed design size, then scale into the
    // frame — same approach as buildSidebarThumbnails().
    frameEl.innerHTML = '';
    const nextSlide = state.slides[state.current + 1];
    endEl.hidden = !!nextSlide;
    if (!nextSlide) return;

    const BASE_W = 1280;
    const BASE_H = 800;
    const clone = nextSlide.cloneNode(true);
    clone.classList.remove('active');
    clone.removeAttribute('id');
    clone.style.width = `${BASE_W}px`;
    clone.style.height = `${BASE_H}px`;

    // Render animated components at their final state in the preview.
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

    frameEl.appendChild(clone);
    const scale = frameEl.clientWidth / BASE_W;
    clone.style.transform = `scale(${scale})`;
    clone.style.transformOrigin = 'top left';
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
      // Hide help panel and slide thumbnail sidebar completely in fullscreen.
      state.help = false;
      helpEl.classList.add('hidden');
      if (sidebarEl) sidebarEl.classList.add('collapsed');
      stage.classList.remove('sidebar-open');
      showToast('全屏模式：点击右侧翻下页，左侧翻上页，M 标识笔，ESC 退出');
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

  // ===== Visual edit mode =====
  // The parent Web UI can send postMessage to enter/exit edit mode. Inside the
  // iframe we enable contenteditable on textual slide elements and provide a
  // floating save/cancel toolbar. Saving sends the full document HTML back to
  // the parent so it can persist via /api/projects/:name/save-edits.

  function editableSelector() {
    return '.slide h1, .slide h2, .slide h3, .slide p, .slide li, .slide td, .slide th, .slide .lead, .slide .kicker, .slide .section-title, .slide .big-number-label, .slide .visual-card p, .slide .timeline-horizontal-title, .slide .timeline-horizontal-desc, .slide .chart-step-title, .slide .chart-step-desc, .slide .speaker-note';
  }

  function initEditMode() {
    window.addEventListener('message', onEditMessage);
  }

  function onEditMessage(e) {
    const data = e.data || {};
    if (data.type === 'ai-ppt:edit-start') {
      enableEditMode();
    } else if (data.type === 'ai-ppt:edit-cancel') {
      cancelEditMode();
    }
  }

  function enableEditMode() {
    if (state.editMode) return;
    state.editMode = true;
    state.editOriginalHtml = document.documentElement.outerHTML;

    const editable = document.querySelectorAll(editableSelector());
    editable.forEach((el) => {
      el.setAttribute('contenteditable', 'true');
      el.dataset.wasEditable = 'true';
    });

    createEditToolbar();
    showToast('已进入编辑模式：点击文字即可修改');
  }

  function cancelEditMode() {
    if (!state.editMode) return;
    if (confirm('确定放弃本次编辑？未保存的修改将丢失。')) {
      window.parent.postMessage({ type: 'ai-ppt:edit-cancelled' }, '*');
      state.editMode = false;
      state.editOriginalHtml = '';
      removeEditToolbar();
      // The parent will reload the iframe src to restore the original content.
    }
  }

  function saveEditMode() {
    if (!state.editMode) return;
    // Disable contenteditable before serializing so attributes are clean.
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      el.removeAttribute('contenteditable');
    });
    const html = document.documentElement.outerHTML;
    window.parent.postMessage({ type: 'ai-ppt:edit-saved', html }, '*');
    state.editMode = false;
    state.editOriginalHtml = '';
    removeEditToolbar();
    showToast('编辑内容已发送，正在保存…');
  }

  function createEditToolbar() {
    removeEditToolbar();
    const toolbar = document.createElement('div');
    toolbar.id = 'ai-ppt-edit-toolbar';
    toolbar.innerHTML = `
      <span class="edit-toolbar-label">编辑模式</span>
      <button class="edit-toolbar-btn edit-toolbar-save" type="button">保存</button>
      <button class="edit-toolbar-btn edit-toolbar-cancel" type="button">取消</button>
    `;
    document.body.appendChild(toolbar);
    toolbar.querySelector('.edit-toolbar-save').addEventListener('click', saveEditMode);
    toolbar.querySelector('.edit-toolbar-cancel').addEventListener('click', cancelEditMode);
  }

  function removeEditToolbar() {
    const toolbar = document.getElementById('ai-ppt-edit-toolbar');
    if (toolbar) toolbar.remove();
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
