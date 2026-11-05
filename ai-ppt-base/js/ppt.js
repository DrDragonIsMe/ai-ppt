(function () {
  'use strict';

  const state = {
    current: 0,
    slides: [],
    overview: false,
    help: false,
    transitioning: false,
    currentTheme: 'web-ui',
    sidebarOpen: true,
    presenter: false,
    editMode: false,
    editOriginalHtml: '',
    markerMode: false,
    markerDrawing: false,
    markerTool: 'pen',
    markerColor: '#EF4444',
    markerStrokes: new Map(),
  };

  // Theme definitions — 运行时优先从 /api/themes 拉取（数据源 ai-ppt-base/themes.json）。
  // 下面这份仅是离线兜底（如 file:// 直接打开 deck 时 fetch 失败）：
  // 新增主题只需改 themes.json + 加一个 css/themes/<id>.css，本列表不必同步，
  // 顶多离线打开时主题切换器里缺少新主题，不影响已应用主题的渲染。
  let themes = [
    { id: 'web-ui', name: 'Web UI', color: '#439288' },
    { id: 'business-blue', name: '商务蓝', color: '#2563EB' },
    { id: 'elegant-purple', name: '优雅紫', color: '#7C3AED' },
    { id: 'warm-orange', name: '温暖橙', color: '#EA580C' },
    { id: 'sunset-red', name: '日落红', color: '#E11D48' },
    { id: 'tech-green', name: '科技绿', color: '#65A30D' },
    { id: 'minimal-gray', name: '极简灰', color: '#171717' },
    { id: 'dark-mode', name: '暗黑模式', color: '#22D3EE' },
  ];

  async function loadThemes() {
    try {
      const res = await fetch('/api/themes');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) themes = data;
      }
    } catch { /* keep fallback */ }
  }

  // hasDOM：浏览器运行时为 true。Node（单测 import 本文件取纯函数）下为 false，
  // 顶层 DOM 查询与启动逻辑全部跳过，只做函数定义。
  const hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';

  const stage = hasDOM ? document.getElementById('stage') : null;
  const overviewEl = hasDOM ? document.getElementById('overview') : null;
  const overviewGrid = hasDOM ? overviewEl.querySelector('.overview-grid') : null;
  const progressEl = hasDOM ? document.getElementById('progress') : null;
  const hudEl = hasDOM ? document.getElementById('hud') : null;
  const toastEl = hasDOM ? document.getElementById('toast') : null;
  const helpEl = hasDOM ? document.getElementById('help') : null;
  const originalTitle = hasDOM ? (document.title || 'ai-ppt') : 'ai-ppt';

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

  // ===== SVG 数据图表渲染器（.chart-line / .chart-pie / .chart-bars）=====
  // 以下为纯函数（不触碰 DOM）：输入 data-chart 配置对象，输出内联 SVG 字符串。
  // 序列色用 CSS 变量 var(--chart-1..6)（ppt.css :root 定义，主题 css 可覆盖），
  // 文字/网格/轴线用 var(--chart-text*) / var(--chart-grid) / var(--chart-axis)。
  // 渲染结果是静态 SVG：打印、导出截图、overview/sidebar/presenter 缩略图
  // （都是 DOM 克隆）天然正确，无需终态补偿。
  // Node 单测经文件尾部 module.exports 引用这些函数（浏览器下 module 未定义，自动跳过）。

  const CHART_W = 640;
  const CHART_H = 360;

  function chartNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function chartEsc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function chartFmt(v) {
    const n = chartNum(v);
    if (Math.abs(n) >= 10000) {
      const k = n / 1000;
      return `${Math.round(k * 10) / 10}k`;
    }
    return String(Math.round(n * 100) / 100);
  }

  function chartColor(i) {
    return `var(--chart-${(i % 6) + 1})`;
  }

  // 顶部居中水平图例（宽度按字符数估算，CJK 约 13px/字）
  function chartLegend(names) {
    const items = names.map((n, i) => {
      const name = String(n ?? `系列${i + 1}`);
      return { name, color: chartColor(i), w: name.length * 13 + 26 };
    });
    const total = items.reduce((s, it) => s + it.w, 0);
    let x = Math.max(8, (CHART_W - total) / 2);
    return items.map((it) => {
      const out = `<rect x="${x}" y="8" width="12" height="12" rx="3" style="fill:${it.color}"/>`
        + `<text x="${x + 18}" y="19" class="chart-legend-text">${chartEsc(it.name)}</text>`;
      x += it.w;
      return out;
    }).join('');
  }

  // 归一化 labels / series；series 元素为 { name, data[] }
  function chartSeries(cfg) {
    const labels = Array.isArray(cfg && cfg.labels) ? cfg.labels.map(String) : [];
    const series = (Array.isArray(cfg && cfg.series) ? cfg.series : [])
      .filter((s) => s && Array.isArray(s.data) && s.data.length > 0)
      .map((s) => ({ name: String(s.name ?? ''), data: s.data.map(chartNum) }));
    return { labels, series };
  }

  // y 轴刻度：把 min..max 外扩到「好看」边界（1/2/2.5/5×10^n 步进），返回刻度数组
  function chartTicks(min, max) {
    const span = max - min || 1;
    const rawStep = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step = mag * 10;
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (rawStep <= m * mag) { step = m * mag; break; }
    }
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let t = niceMin; t <= niceMax + step * 1e-6; t += step) {
      ticks.push(Math.round(t * 1e6) / 1e6);
    }
    return ticks;
  }

  function chartSvgOpen(cls) {
    return `<svg class="chart-svg ${cls}" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg">`;
  }

  // 折线/面积图：cfg = { labels, series:[{name,data}], area?, points?, valueLabels? }
  function renderLineChart(cfg) {
    const { labels, series } = chartSeries(cfg);
    if (!labels.length || !series.length) return '';
    const area = !!cfg.area;
    const showPoints = cfg.points !== false;
    const showValues = !!cfg.valueLabels;
    const withLegend = series.length > 1;

    const pad = { l: 52, r: 20, t: withLegend ? 34 : 20, b: 34 };
    const iw = CHART_W - pad.l - pad.r;
    const ih = CHART_H - pad.t - pad.b;

    const all = series.flatMap((s) => s.data);
    let min = Math.min(0, ...all);
    let max = Math.max(...all);
    if (max <= min) max = min + 1;
    const ticks = chartTicks(min, max);
    min = ticks[0];
    max = ticks[ticks.length - 1];

    const x = (i) => pad.l + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
    const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
    const y0 = y(Math.max(0, min));

    const parts = [];
    for (const t of ticks) {
      const ty = y(t);
      parts.push(`<line x1="${pad.l}" y1="${ty.toFixed(1)}" x2="${CHART_W - pad.r}" y2="${ty.toFixed(1)}" class="chart-grid"/>`);
      parts.push(`<text x="${pad.l - 8}" y="${ty.toFixed(1)}" dy="0.35em" text-anchor="end" class="chart-tick">${chartFmt(t)}</text>`);
    }
    parts.push(`<line x1="${pad.l}" y1="${y0.toFixed(1)}" x2="${CHART_W - pad.r}" y2="${y0.toFixed(1)}" class="chart-axis"/>`);
    labels.forEach((label, i) => {
      parts.push(`<text x="${x(i).toFixed(1)}" y="${CHART_H - 10}" text-anchor="middle" class="chart-tick">${chartEsc(label)}</text>`);
    });

    series.forEach((s, si) => {
      const color = chartColor(si);
      const pts = labels.map((_, i) => [x(i), y(s.data[i] ?? 0)]);
      const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      if (area) {
        parts.push(`<path d="${line} L ${pts[pts.length - 1][0].toFixed(1)} ${y0.toFixed(1)} L ${pts[0][0].toFixed(1)} ${y0.toFixed(1)} Z" style="fill:${color};fill-opacity:0.12;stroke:none"/>`);
      }
      parts.push(`<path d="${line}" style="fill:none;stroke:${color};stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>`);
      if (showPoints) {
        pts.forEach((p) => {
          parts.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" style="fill:${color};stroke:var(--surface);stroke-width:1.5"/>`);
        });
      }
      if (showValues) {
        pts.forEach((p, i) => {
          parts.push(`<text x="${p[0].toFixed(1)}" y="${(p[1] - 10).toFixed(1)}" text-anchor="middle" class="chart-value">${chartFmt(s.data[i] ?? 0)}</text>`);
        });
      }
    });

    if (withLegend) parts.push(chartLegend(series.map((s) => s.name)));
    return chartSvgOpen('chart-svg-line') + parts.join('') + '</svg>';
  }

  // 饼/环图：cfg = { labels, data }（或 series[0].data）；donut?、centerLabel?
  function renderPieChart(cfg) {
    const labels = Array.isArray(cfg && cfg.labels) ? cfg.labels.map(String) : [];
    const raw = Array.isArray(cfg && cfg.data)
      ? cfg.data
      : (cfg && Array.isArray(cfg.series) && cfg.series[0] && Array.isArray(cfg.series[0].data) ? cfg.series[0].data : []);
    const items = labels
      .map((label, i) => ({ label, value: chartNum(raw[i]) }))
      .filter((it) => it.value > 0);
    if (!items.length) return '';
    const total = items.reduce((s, it) => s + it.value, 0);
    if (total <= 0) return '';

    const donut = !!cfg.donut;
    const cx = 175;
    const cy = CHART_H / 2;
    const r = 128;
    const innerR = donut ? 66 : 0;

    const pt = (radius, a) => `${(cx + radius * Math.cos(a)).toFixed(1)} ${(cy + radius * Math.sin(a)).toFixed(1)}`;
    const parts = [];
    let angle = -Math.PI / 2;
    items.forEach((it, i) => {
      const pct = it.value / total;
      const a1 = angle + pct * Math.PI * 2;
      const large = pct > 0.5 ? 1 : 0;
      let d;
      if (innerR) {
        d = `M ${pt(r, angle)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} L ${pt(innerR, a1)} A ${innerR} ${innerR} 0 ${large} 0 ${pt(innerR, angle)} Z`;
      } else {
        d = `M ${cx} ${cy} L ${pt(r, angle)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} Z`;
      }
      parts.push(`<path d="${d}" style="fill:${chartColor(i)};stroke:var(--surface);stroke-width:2"/>`);
      if (pct >= 0.06) {
        const mid = (angle + a1) / 2;
        const lr = innerR ? (r + innerR) / 2 : r * 0.62;
        parts.push(`<text x="${(cx + lr * Math.cos(mid)).toFixed(1)}" y="${(cy + lr * Math.sin(mid)).toFixed(1)}" dy="0.35em" text-anchor="middle" class="chart-pct">${Math.round(pct * 100)}%</text>`);
      }
      angle = a1;
    });

    if (donut && cfg.centerLabel) {
      parts.push(`<text x="${cx}" y="${cy}" dy="0.35em" text-anchor="middle" class="chart-center">${chartEsc(cfg.centerLabel)}</text>`);
    }

    // 右侧纵向图例：色块 + 名称 + 占比
    const lx = 370;
    const rowH = 26;
    const ly0 = cy - ((items.length - 1) * rowH) / 2;
    items.forEach((it, i) => {
      const yRow = ly0 + i * rowH;
      const pctText = `${Math.round((it.value / total) * 100)}%`;
      parts.push(`<rect x="${lx}" y="${(yRow - 6).toFixed(1)}" width="12" height="12" rx="3" style="fill:${chartColor(i)}"/>`);
      parts.push(`<text x="${lx + 18}" y="${yRow.toFixed(1)}" dy="0.35em" class="chart-legend-text">${chartEsc(it.label)}</text>`);
      parts.push(`<text x="${CHART_W - 16}" y="${yRow.toFixed(1)}" dy="0.35em" text-anchor="end" class="chart-value">${pctText}</text>`);
    });

    return chartSvgOpen('chart-svg-pie') + parts.join('') + '</svg>';
  }

  // 柱状图（分组/堆叠）：cfg = { labels, series:[{name,data}], stacked?, valueLabels? }
  function renderBarsChart(cfg) {
    const { labels, series } = chartSeries(cfg);
    if (!labels.length || !series.length) return '';
    const stacked = !!cfg.stacked;
    const showValues = cfg.valueLabels !== false;
    const withLegend = series.length > 1;

    const pad = { l: 52, r: 20, t: withLegend ? 34 : 20, b: 34 };
    const iw = CHART_W - pad.l - pad.r;
    const ih = CHART_H - pad.t - pad.b;

    let min = 0;
    let max = 0;
    if (stacked) {
      labels.forEach((_, i) => {
        max = Math.max(max, series.reduce((s, sr) => s + Math.max(0, sr.data[i] ?? 0), 0));
      });
    } else {
      const all = series.flatMap((s) => s.data);
      min = Math.min(0, ...all);
      max = Math.max(0, ...all);
    }
    if (max <= min) max = min + 1;
    const ticks = chartTicks(min, max);
    min = ticks[0];
    max = ticks[ticks.length - 1];

    const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
    const y0 = y(Math.max(0, min));
    const slot = iw / labels.length;

    const parts = [];
    for (const t of ticks) {
      const ty = y(t);
      parts.push(`<line x1="${pad.l}" y1="${ty.toFixed(1)}" x2="${CHART_W - pad.r}" y2="${ty.toFixed(1)}" class="chart-grid"/>`);
      parts.push(`<text x="${pad.l - 8}" y="${ty.toFixed(1)}" dy="0.35em" text-anchor="end" class="chart-tick">${chartFmt(t)}</text>`);
    }
    parts.push(`<line x1="${pad.l}" y1="${y0.toFixed(1)}" x2="${CHART_W - pad.r}" y2="${y0.toFixed(1)}" class="chart-axis"/>`);

    labels.forEach((label, i) => {
      const cx = pad.l + slot * (i + 0.5);
      parts.push(`<text x="${cx.toFixed(1)}" y="${CHART_H - 10}" text-anchor="middle" class="chart-tick">${chartEsc(label)}</text>`);

      if (stacked) {
        const bw = Math.min(56, slot * 0.5);
        let acc = 0;
        series.forEach((s, si) => {
          const v = Math.max(0, s.data[i] ?? 0);
          if (v <= 0) return;
          const top = y(acc + v);
          const bottom = y(acc);
          parts.push(`<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(bottom - top).toFixed(1)}" style="fill:${chartColor(si)}"/>`);
          if (cfg.segmentLabels && bottom - top >= 16) {
            parts.push(`<text x="${cx.toFixed(1)}" y="${((top + bottom) / 2).toFixed(1)}" dy="0.35em" text-anchor="middle" class="chart-pct">${chartFmt(v)}</text>`);
          }
          acc += v;
        });
        if (showValues && acc > 0) {
          parts.push(`<text x="${cx.toFixed(1)}" y="${(y(acc) - 8).toFixed(1)}" text-anchor="middle" class="chart-value">${chartFmt(acc)}</text>`);
        }
      } else {
        const bw = Math.min(48, (slot * 0.62) / series.length);
        const gx = cx - (bw * series.length) / 2;
        series.forEach((s, si) => {
          const v = s.data[i] ?? 0;
          const vy = y(v);
          const top = Math.min(vy, y0);
          const h = Math.abs(y0 - vy);
          const bx = gx + si * bw;
          parts.push(`<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:${chartColor(si)}"/>`);
          if (showValues) {
            const ly = v >= 0 ? top - 6 : top + h + 12;
            parts.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="chart-value">${chartFmt(v)}</text>`);
          }
        });
      }
    });

    if (withLegend) parts.push(chartLegend(series.map((s) => s.name)));
    return chartSvgOpen('chart-svg-bars') + parts.join('') + '</svg>';
  }

  function renderChart(type, cfg) {
    if (type === 'line') return renderLineChart(cfg);
    if (type === 'pie') return renderPieChart(cfg);
    if (type === 'bars') return renderBarsChart(cfg);
    return '';
  }

  // DOM 包装：扫描声明式 data-chart 容器并注入 SVG（init 时调用一次，
  // 必须在 buildSidebar/buildOverview 之前，保证缩略图克隆到已渲染的 SVG）。
  function initCharts() {
    if (!hasDOM) return;
    document.querySelectorAll('.chart-line[data-chart], .chart-pie[data-chart], .chart-bars[data-chart]').forEach((el) => {
      const type = el.classList.contains('chart-line') ? 'line' : el.classList.contains('chart-pie') ? 'pie' : 'bars';
      let cfg = null;
      try {
        cfg = JSON.parse(el.getAttribute('data-chart'));
      } catch {
        cfg = null;
      }
      const svg = cfg && renderChart(type, cfg);
      if (svg) {
        el.innerHTML = svg;
      } else {
        el.classList.add('chart-error');
        if (!el.textContent.trim()) el.textContent = '图表数据无效';
      }
    });
  }

  async function init() {
    await loadThemes();
    state.slides = Array.from(document.querySelectorAll('.slide'));
    if (state.slides.length === 0) return;

    initThemes();
    initCharts();
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
    // web-ui 也写显式 class（纯标记，变量与 :root 默认一致）：
    // 让 initThemes 能区分「配置为 web-ui」和「无主题信息」，避免回退到 localStorage 的旧主题
    document.body.classList.add(`theme-${themeId}`);
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
  // Tools: pen (freehand), arrow, rect, circle, ellipse. Strokes are stored
  // per slide index as SVG element strings and re-rendered on slide change.
  // The floating toolbar is hidden by default; in marker mode it appears on
  // mouse activity and auto-hides after ~2s of inactivity.

  let markerUiTimeout = null;
  let markerStartPoint = null;

  function buildMarkerToolbar() {
    markerToolbarEl = document.createElement('div');
    markerToolbarEl.className = 'marker-toolbar';
    markerToolbarEl.innerHTML = `
      <div class="marker-tools">
        <button class="marker-tool-btn active" data-tool="pen" title="画笔 (1/P)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
          </svg>
        </button>
        <button class="marker-tool-btn" data-tool="arrow" title="箭头 (2/A)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="19" x2="19" y2="5"></line>
            <polyline points="12 5 19 5 19 12"></polyline>
          </svg>
        </button>
        <button class="marker-tool-btn" data-tool="rect" title="矩形 (3/R)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="6" width="16" height="12" rx="1"></rect>
          </svg>
        </button>
        <button class="marker-tool-btn" data-tool="circle" title="圆形 (4/O)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="8"></circle>
          </svg>
        </button>
        <button class="marker-tool-btn" data-tool="ellipse" title="椭圆 (5/E)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="12" cy="12" rx="9" ry="6"></ellipse>
          </svg>
        </button>
      </div>
      <div class="marker-colors">
        <button class="marker-color-btn active" data-color="#EF4444" style="background: #EF4444;" title="红色"></button>
        <button class="marker-color-btn" data-color="#2563EB" style="background: #2563EB;" title="蓝色"></button>
        <button class="marker-color-btn" data-color="#22C55E" style="background: #22C55E;" title="绿色"></button>
        <button class="marker-color-btn" data-color="#111827" style="background: #111827;" title="黑色"></button>
      </div>
      <button class="marker-btn marker-clear" type="button" title="清除本页标记 (C)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
      <button class="marker-btn marker-exit" type="button" title="退出标识笔 (M / Esc)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <div class="marker-hint">1画笔 2箭头 3矩形 4圆 5椭圆 · C清除 · M/Esc 退出</div>
    `;

    markerToolbarEl.querySelector('.marker-clear').addEventListener('click', clearCurrentSlideMarkers);
    markerToolbarEl.querySelector('.marker-exit').addEventListener('click', toggleMarkerMode);
    markerToolbarEl.querySelectorAll('.marker-color-btn').forEach((btn) => {
      btn.addEventListener('click', () => setMarkerColor(btn.dataset.color));
    });
    markerToolbarEl.querySelectorAll('.marker-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => setMarkerTool(btn.dataset.tool));
    });

    document.body.appendChild(markerToolbarEl);
    updateMarkerUI();
  }

  function toggleMarkerMode() {
    state.markerMode = !state.markerMode;
    document.documentElement.classList.toggle('marker-mode', state.markerMode);
    clearTimeout(markerUiTimeout);
    updateMarkerUI();
    if (state.markerMode) {
      showMarkerUi();
      showToast('标识笔已开启：1画笔 2箭头 3矩形 4圆 5椭圆，C 清除本页，M/Esc 退出');
    } else {
      showToast('标识笔已关闭');
    }
  }

  function setMarkerColor(color) {
    state.markerColor = color;
    markerToolbarEl.querySelectorAll('.marker-color-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });
  }

  function setMarkerTool(tool) {
    state.markerTool = tool;
    markerToolbarEl.querySelectorAll('.marker-tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    const names = { pen: '画笔', arrow: '箭头', rect: '矩形', circle: '圆形', ellipse: '椭圆' };
    showToast(`已切换到「${names[tool] || tool}」`);
    showMarkerUi();
  }

  function updateMarkerUI() {
    if (!markerToolbarEl) return;
    markerToolbarEl.classList.toggle('active', state.markerMode);
    markerToolbarEl.classList.remove('visible');
    if (state.markerMode) showMarkerUi();
  }

  function showMarkerUi() {
    if (!state.markerMode || !markerToolbarEl) return;
    markerToolbarEl.classList.add('visible');
    clearTimeout(markerUiTimeout);
    markerUiTimeout = setTimeout(() => {
      markerToolbarEl.classList.remove('visible');
    }, 2000);
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

  function shapeSvg(tool, start, end) {
    const color = state.markerColor;
    const attrs = `stroke="${color}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
    const x1 = parseFloat(start.x), y1 = parseFloat(start.y);
    const x2 = parseFloat(end.x), y2 = parseFloat(end.y);

    if (tool === 'arrow') {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = 18;
      const a1 = angle + Math.PI / 6;
      const a2 = angle - Math.PI / 6;
      const hx1 = x2 - headLen * Math.cos(a1);
      const hy1 = y2 - headLen * Math.sin(a1);
      const hx2 = x2 - headLen * Math.cos(a2);
      const hy2 = y2 - headLen * Math.sin(a2);
      return `<path d="M ${x1} ${y1} L ${x2} ${y2} M ${hx1.toFixed(1)} ${hy1.toFixed(1)} L ${x2} ${y2} L ${hx2.toFixed(1)} ${hy2.toFixed(1)}" ${attrs}/>`;
    }
    if (tool === 'rect') {
      const x = Math.min(x1, x2), y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" ${attrs}/>`;
    }
    if (tool === 'circle') {
      const r = Math.hypot(x2 - x1, y2 - y1);
      return `<circle cx="${x1}" cy="${y1}" r="${r}" ${attrs}/>`;
    }
    if (tool === 'ellipse') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2 || 1, ry = Math.abs(y2 - y1) / 2 || 1;
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${attrs}/>`;
    }
    return '';
  }

  function svgFromString(str) {
    const tpl = document.createElement('template');
    tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${str}</svg>`;
    return tpl.content.firstChild.firstChild;
  }

  function onMarkerPointerDown(e) {
    if (!state.markerMode) return;
    const overlay = e.currentTarget;
    const slide = overlay.closest('.slide');
    if (!slide || !slide.classList.contains('active')) return;

    e.preventDefault();
    state.markerDrawing = true;
    const pt = getSvgPoint(overlay, e);
    markerStartPoint = pt;

    if (state.markerTool === 'pen') {
      markerCurrentPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      markerCurrentPath.setAttribute('d', `M ${pt.x} ${pt.y}`);
      markerCurrentPath.setAttribute('stroke', state.markerColor);
      markerCurrentPath.setAttribute('stroke-width', '3');
      markerCurrentPath.setAttribute('stroke-linecap', 'round');
      markerCurrentPath.setAttribute('stroke-linejoin', 'round');
      markerCurrentPath.setAttribute('fill', 'none');
      overlay.appendChild(markerCurrentPath);
    } else {
      markerCurrentPath = svgFromString(shapeSvg(state.markerTool, pt, pt));
      if (markerCurrentPath) overlay.appendChild(markerCurrentPath);
    }
  }

  function onMarkerPointerMove(e) {
    showMarkerUi();
    if (!state.markerDrawing || !markerCurrentPath) return;
    const overlay = e.currentTarget;
    const pt = getSvgPoint(overlay, e);

    if (state.markerTool === 'pen') {
      const d = markerCurrentPath.getAttribute('d');
      markerCurrentPath.setAttribute('d', `${d} L ${pt.x} ${pt.y}`);
    } else {
      const fresh = svgFromString(shapeSvg(state.markerTool, markerStartPoint, pt));
      if (fresh && markerCurrentPath.parentNode === overlay) {
        overlay.replaceChild(fresh, markerCurrentPath);
        markerCurrentPath = fresh;
      }
    }
  }

  function onMarkerPointerUp() {
    if (!state.markerDrawing || !markerCurrentPath) return;
    state.markerDrawing = false;
    // The temp element already holds the final shape; serialize it.
    const strokes = getSlideMarkers();
    strokes.push(markerCurrentPath.outerHTML);
    setSlideMarkers(strokes);
    markerCurrentPath = null;
    markerStartPoint = null;
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
    strokes.forEach((str) => {
      const el = svgFromString(str);
      if (el) overlay.appendChild(el);
    });
  }

  function clearCurrentSlideMarkers() {
    const overlay = state.slides[state.current]?.querySelector(':scope > .marker-overlay');
    if (overlay) overlay.innerHTML = '';
    state.markerStrokes.delete(state.current);
    showToast('已清除本页标记');
    showMarkerUi();
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

    // Reveal the marker toolbar on any pointer activity while marker mode is on.
    document.addEventListener('mousemove', () => { if (state.markerMode) showMarkerUi(); });
    document.addEventListener('touchstart', () => { if (state.markerMode) showMarkerUi(); }, { passive: true });

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
    if (state.transitioning) return;
    if (state.editMode) return;
    if (e.target && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName))) return;

    // Escape: overview first, then fullscreen, then theme panel
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.overview) {
        toggleOverview(false);
      } else if (document.fullscreenElement) {
        exitFullscreen();
      } else if (themePanelEl && themePanelEl.classList.contains('open')) {
        closeThemePanel();
      } else if (state.markerMode) {
        toggleMarkerMode();
      }
      return;
    }

    if (state.overview) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const idx = state.currentIndex + 1;
        if (idx < state.slides.length) {
          selectOverviewItem(idx);
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = state.currentIndex - 1;
        if (idx >= 0) {
          selectOverviewItem(idx);
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleOverview(false);
        return;
      }
      return;
    }

    // Marker mode shortcuts take priority over navigation (except Escape above).
    if (state.markerMode) {
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMarkerMode();
        return;
      }
      if (e.key === '1' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setMarkerTool('pen');
        return;
      }
      if (e.key === '2' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setMarkerTool('arrow');
        return;
      }
      if (e.key === '3' || e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setMarkerTool('rect');
        return;
      }
      if (e.key === '4' || e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        setMarkerTool('circle');
        return;
      }
      if (e.key === '5' || e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setMarkerTool('ellipse');
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        clearCurrentSlideMarkers();
        return;
      }
    }

    // Navigation keys
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        goTo(state.slides.length - 1);
      } else {
        next();
      }
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
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

    if (e.key === 'Home') {
      e.preventDefault();
      goTo(0);
      return;
    }

    if (e.key === 'End') {
      e.preventDefault();
      goTo(state.slides.length - 1);
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

  if (hasDOM) window.goTo = goTo;

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
    color: var(--teal, #439288);
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
      el.requestFullscreen().catch(() => { });
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  }

  function exitFullscreen() {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
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
    // Base matches the 1280×800 design canvas used by thumbnails/presenter preview.
    const base = Math.min(vw / 1280, vh / 800, 1);
    document.documentElement.style.fontSize = `${16 * Math.max(base, 0.5)}px`;
  }

  if (hasDOM) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Node 单测入口：仅导出图表渲染纯函数（浏览器下 module 未定义，跳过）。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      renderChart,
      renderLineChart,
      renderPieChart,
      renderBarsChart,
    };
  }
})();
