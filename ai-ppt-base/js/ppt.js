(function () {
  'use strict';

  const state = {
    current: 0,
    slides: [],
    overview: false,
    help: true,
    transitioning: false,
  };

  const stage = document.getElementById('stage');
  const overviewEl = document.getElementById('overview');
  const overviewGrid = overviewEl.querySelector('.overview-grid');
  const progressEl = document.getElementById('progress');
  const hudEl = document.getElementById('hud');
  const toastEl = document.getElementById('toast');
  const helpEl = document.getElementById('help');
  const originalTitle = document.title || 'ai-ppt';

  function init() {
    state.slides = Array.from(document.querySelectorAll('.slide'));
    if (state.slides.length === 0) return;

    buildOverview();
    updateSlide();
    bindEvents();

    window.addEventListener('resize', onResize);
    onResize();
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
      }
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
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

    const isFullscreen = !!document.fullscreenElement;
    if (!isFullscreen) return;

    const target = e.target;
    if (target.closest('a') || target.closest('button')) return;

    if (e.button === 0) {
      next();
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

  function updateSlide() {
    state.slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === state.current);
    });

    const pct = ((state.current + 1) / state.slides.length) * 100;
    progressEl.style.width = pct + '%';
    hudEl.textContent = `${state.current + 1} / ${state.slides.length}`;

    document.title = `${originalTitle} · ${state.current + 1} / ${state.slides.length}`;

    updateOverviewActive();
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

      card.appendChild(indexBadge);
      card.appendChild(clone);
      overviewGrid.appendChild(card);
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
    if (document.fullscreenElement) {
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
    if (document.fullscreenElement) {
      showToast('全屏模式：点击左键翻页，ESC 退出');
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
