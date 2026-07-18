#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import PptxGenJS from 'pptxgenjs';
import { getProjectDir, readConfig } from './config.mjs';

const __filename = fileURLToPath(import.meta.url);

// Colors mirror the Web UI token set (web/css/web.css) so the exported PPTX
// matches the on-screen deck. Brand/accent = teal #0D9488.
const COLORS = {
  cream: 'F7F8FA',
  tile: 'EEF1F5',
  tileStrong: 'E0E4EA',
  accent: '0D9488',
  accentLight: 'F0FDFA',
  navy: '0F172A',
  ink: '1A2332',
  slate: '475569',
};

// Sans-serif (Web UI uses PingFang SC; Songti SC was the rejected serif direction).
const FONT_HEADING = 'PingFang SC';
const FONT_BODY = 'PingFang SC';

function textOf($el) {
  return $el.text().trim();
}

function addText(slide, text, x, y, w, h, opts = {}) {
  slide.addText(text, {
    x, y, w, h,
    fontFace: opts.fontFace || FONT_BODY,
    color: COLORS.ink,
    ...opts,
  });
}

function addShape(slide, shape, x, y, w, h, opts = {}) {
  slide.addShape(shape, {
    x, y, w, h,
    ...opts,
  });
}

function addRoundedRect(slide, x, y, w, h, fill, lineColor) {
  return addShape(slide, 'roundRect', x, y, w, h, {
    fill: { color: fill },
    line: { color: lineColor || fill, width: 1 },
    rectRadius: 0.15,
  });
}

function renderHero(slide, $, $slide, title, lead) {
  const kicker = textOf($slide.find('.kicker'));
  if (kicker) {
    addText(slide, kicker, 0.5, 0.6, 9, 0.4, { fontSize: 12, color: COLORS.accent, bold: true, align: 'center' });
  }
  addText(slide, title, 0.5, 1.1, 9, 1.4, { fontSize: 44, bold: false, fontFace: FONT_HEADING, color: COLORS.ink, align: 'center' });
  if (lead) {
    addText(slide, lead, 1, 2.7, 8, 0.8, { fontSize: 18, color: COLORS.slate, align: 'center' });
  }
  const badges = $slide.find('.badge-row .badge');
  if (badges.length) {
    const texts = [];
    badges.each((_, b) => texts.push(textOf($(b))));
    let bx = 2.5;
    texts.forEach((t) => {
      const tw = t.length * 0.12 + 0.3;
      addRoundedRect(slide, bx, 3.8, tw, 0.4, COLORS.accent, COLORS.accent);
      addText(slide, t, bx, 3.85, tw, 0.3, { fontSize: 11, color: COLORS.cream, align: 'center', bold: true });
      bx += tw + 0.15;
    });
  }
}

function renderVisualCards(slide, $, $slide, $row, startY) {
  const cards = $row.find('> .visual-card, > .tile');
  const n = cards.length || 1;
  const gap = 0.25;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const cardW = (totalW - gap * (n - 1)) / n;
  const cardH = 2.6;

  cards.each((i, card) => {
    const $card = $(card);
    const x = margin + i * (cardW + gap);
    const y = startY;
    addRoundedRect(slide, x, y, cardW, cardH, COLORS.tile, COLORS.tileStrong);

    const icon = textOf($card.find('.icon, .big-number').first());
    const h3 = textOf($card.find('h3').first());
    const body = textOf($card.find('p').first());

    if (icon) {
      addShape(slide, 'ellipse', x + cardW / 2 - 0.35, y + 0.25, 0.7, 0.7, {
        fill: { color: COLORS.accent },
      });
      addText(slide, icon, x + cardW / 2 - 0.35, y + 0.35, 0.7, 0.4, {
        fontSize: 16, color: 'FFFFFF', align: 'center', bold: true,
      });
    }

    const titleY = icon ? y + 1.05 : y + 0.4;
    if (h3) {
      addText(slide, h3, x + 0.15, titleY, cardW - 0.3, 0.45, {
        fontSize: 16, bold: false, fontFace: FONT_HEADING, color: COLORS.ink, align: 'center',
      });
    }
    if (body) {
      addText(slide, body, x + 0.15, titleY + 0.45, cardW - 0.3, cardH - (titleY - y) - 0.6, {
        fontSize: 12, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderTiles(slide, $, $slide, $row, startY) {
  const tiles = $row.find('> .tile');
  const n = tiles.length || 1;
  const gap = 0.25;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const cardW = n > 2 ? (totalW - gap * (n - 1)) / n : (totalW - gap) / 2;
  const cardH = 2.0;
  const perRow = n > 2 ? n : 2;

  tiles.each((i, tile) => {
    const $tile = $(tile);
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = margin + col * (cardW + gap);
    const y = startY + row * (cardH + 0.2);
    addRoundedRect(slide, x, y, cardW, cardH, 'FFFFFF', COLORS.tileStrong);

    const icon = textOf($tile.find('.icon').first());
    const h3 = textOf($tile.find('h3').first());
    const body = textOf($tile.find('p').first());

    if (icon) {
      addShape(slide, 'ellipse', x + cardW / 2 - 0.25, y + 0.15, 0.5, 0.5, {
        fill: { color: COLORS.accent },
      });
      addText(slide, icon, x + cardW / 2 - 0.25, y + 0.23, 0.5, 0.3, {
        fontSize: 11, color: 'FFFFFF', align: 'center', bold: true,
      });
    }

    const titleY = icon ? y + 0.75 : y + 0.25;
    if (h3) {
      addText(slide, h3, x + 0.12, titleY, cardW - 0.24, 0.35, {
        fontSize: 14, bold: false, fontFace: FONT_HEADING, color: COLORS.ink, align: 'center',
      });
    }
    if (body) {
      addText(slide, body, x + 0.12, titleY + 0.35, cardW - 0.24, cardH - (titleY - y) - 0.5, {
        fontSize: 11, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderQuote(slide, $quote, startY) {
  const text = textOf($quote);
  if (!text) return;
  addShape(slide, 'rect', 0.5, startY, 0.06, 1.6, { fill: { color: COLORS.accent } });
  addRoundedRect(slide, 0.6, startY, 8.9, 1.6, COLORS.accentLight, COLORS.accentLight);
  addText(slide, text, 0.85, startY + 0.2, 8.4, 1.2, {
    fontSize: 22, bold: false, fontFace: FONT_HEADING, color: COLORS.ink,
  });
}

function renderTimeline(slide, $, $timeline, startY) {
  const items = $timeline.find('.timeline-item');
  items.each((i, item) => {
    const $item = $(item);
    const y = startY + i * 1.1;
    addShape(slide, 'ellipse', 0.55, y + 0.15, 0.18, 0.18, { fill: { color: COLORS.accent } });
    addText(slide, textOf($item.find('h3')), 0.85, y, 8, 0.4, { fontSize: 14, bold: false, fontFace: FONT_HEADING, color: COLORS.ink });
    addText(slide, textOf($item.find('p')), 0.85, y + 0.38, 8, 0.5, { fontSize: 12, color: COLORS.slate });
  });
}

function renderHeroStat(slide, $stat, startY) {
  const value = textOf($stat.find('.big-number'));
  const label = textOf($stat.find('.big-number-label'));
  addText(slide, value, 0.5, startY, 9, 1.2, { fontSize: 60, bold: false, fontFace: FONT_HEADING, color: COLORS.accent, align: 'center' });
  if (label) {
    addText(slide, label, 0.5, startY + 1.1, 9, 0.5, { fontSize: 16, color: COLORS.slate, align: 'center' });
  }
}

function renderBadges(slide, $, $row, startY) {
  const texts = [];
  $row.find('.badge').each((_, b) => texts.push(textOf($(b))));
  let bx = 0.5;
  texts.forEach((t) => {
    const tw = Math.max(0.6, t.length * 0.12 + 0.3);
    addRoundedRect(slide, bx, startY, tw, 0.35, COLORS.accent, COLORS.accent);
    addText(slide, t, bx, startY + 0.04, tw, 0.27, { fontSize: 10, color: COLORS.cream, align: 'center', bold: true });
    bx += tw + 0.12;
  });
}

function renderTable(slide, $, $table, startY) {
  const rows = [];
  $table.find('tr').each((_, tr) => {
    const row = [];
    $(tr).find('th, td').each((_, cell) => {
      row.push(textOf($(cell)));
    });
    if (row.length) rows.push(row);
  });
  if (rows.length) {
    slide.addTable(rows, {
      x: 0.5, y: startY, w: 9, h: 3.8, fontSize: 11, fontFace: FONT_BODY,
      color: COLORS.ink,
      border: { color: COLORS.tileStrong },
      fill: { color: 'FFFFFF' },
      colW: Array(rows[0].length).fill(9 / rows[0].length),
    });
  }
}

function renderBarChart(slide, $, $chart, startY) {
  const items = $chart.find('.chart-bar-item');
  const n = items.length || 1;
  const gap = 0.3;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const barW = (totalW - gap * (n - 1)) / n;
  const chartH = 2.0;

  items.each((i, item) => {
    const $item = $(item);
    const x = margin + i * (barW + gap);
    const value = textOf($item.find('.chart-bar-value'));
    const label = textOf($item.find('.chart-bar-label'));

    // Find bar height percentage from style
    const barEl = $item.find('.chart-bar-bar')[0];
    let barHeightPercent = 0.6;
    if (barEl) {
      const style = $(barEl).attr('style');
      if (style) {
        const match = style.match(/height:\s*(\d+)px/);
        if (match) barHeightPercent = Math.min(1, parseInt(match[1]) / 200);
      }
    }
    const barH = chartH * barHeightPercent;

    // Draw bar
    addRoundedRect(slide, x, startY + chartH - barH, barW, barH, COLORS.accent, COLORS.accent);

    // Draw value
    if (value) {
      addText(slide, value, x, startY + chartH - barH - 0.3, barW, 0.3, {
        fontSize: 14, color: COLORS.ink, align: 'center', bold: true,
      });
    }
    // Draw label
    if (label) {
      addText(slide, label, x, startY + chartH + 0.1, barW, 0.3, {
        fontSize: 11, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderProgressRings(slide, $, $rings, startY) {
  const items = $rings.find('.progress-ring-item');
  const n = items.length || 1;
  const gap = 0.3;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const itemW = (totalW - gap * (n - 1)) / n;
  const ringSize = Math.min(itemW, 1.6);

  items.each((i, item) => {
    const $item = $(item);
    const x = margin + i * (itemW + gap) + (itemW - ringSize) / 2;
    const value = textOf($item.find('.progress-ring-value'));
    const label = textOf($item.find('.progress-ring-label'));

    // Draw background circle
    addShape(slide, 'ellipse', x, startY, ringSize, ringSize, {
      fill: { color: COLORS.tile },
    });

    // Draw accent arc approximation (as smaller circle on top)
    addShape(slide, 'ellipse', x + 0.1, startY + 0.1, ringSize - 0.2, ringSize - 0.2, {
      fill: { color: COLORS.cream },
    });

    // Draw value text in center
    if (value) {
      addText(slide, value, x, startY + 0.55, ringSize, 0.5, {
        fontSize: 24, color: COLORS.accent, align: 'center', bold: true,
      });
    }
    if (label) {
      addText(slide, label, x, startY + ringSize + 0.1, ringSize, 0.3, {
        fontSize: 11, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderStepsChart(slide, $, $steps, startY) {
  const items = $steps.find('.chart-step');
  items.each((i, item) => {
    const $item = $(item);
    const y = startY + i * 0.9;

    // Step number circle
    const num = textOf($item.find('.chart-step-number'));
    addShape(slide, 'ellipse', 0.5, y, 0.5, 0.5, { fill: { color: COLORS.accent } });
    addText(slide, num, 0.5, y + 0.08, 0.5, 0.35, {
      fontSize: 14, color: 'FFFFFF', align: 'center', bold: true,
    });

    // Content
    const title = textOf($item.find('.chart-step-title'));
    const desc = textOf($item.find('.chart-step-desc'));
    if (title) {
      addText(slide, title, 1.15, y + 0.02, 7.5, 0.35, {
        fontSize: 14, bold: false, fontFace: FONT_HEADING, color: COLORS.ink,
      });
    }
    if (desc) {
      addText(slide, desc, 1.15, y + 0.38, 7.5, 0.35, {
        fontSize: 11, color: COLORS.slate,
      });
    }
  });
}

function renderDataMatrix(slide, $, $matrix, startY) {
  const cells = $matrix.find('.data-matrix-cell');
  const n = cells.length || 4;
  const cols = $matrix.hasClass('data-matrix-3x3') ? 3 : 2;
  const rows = Math.ceil(n / cols);
  const gap = 0.25;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const cellW = (totalW - gap * (cols - 1)) / cols;
  const cellH = 1.2;

  cells.each((i, cell) => {
    const $cell = $(cell);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = margin + col * (cellW + gap);
    const y = startY + row * (cellH + gap);

    const fill = $cell.hasClass('hot') ? COLORS.accentLight : ($cell.hasClass('warm') ? COLORS.tile : 'FFFFFF');
    addRoundedRect(slide, x, y, cellW, cellH, fill, COLORS.tileStrong);

    const value = textOf($cell.find('.data-matrix-value'));
    const label = textOf($cell.find('.data-matrix-label'));

    if (value) {
      addText(slide, value, x, y + 0.3, cellW, 0.45, {
        fontSize: 28, color: COLORS.accent, align: 'center', bold: true,
      });
    }
    if (label) {
      addText(slide, label, x, y + 0.75, cellW, 0.3, {
        fontSize: 11, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderWaterfall(slide, $, $waterfall, startY) {
  const items = $waterfall.find('.waterfall-item');
  const n = items.length || 1;
  const gap = 0.15;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const itemH = 0.45;

  items.each((i, item) => {
    const $item = $(item);
    const y = startY + i * (itemH + gap);

    const label = textOf($item.find('.waterfall-label'));
    const value = textOf($item.find('.waterfall-value'));
    const $fill = $item.find('.waterfall-fill');
    const isPositive = $fill.hasClass('positive');
    const isNegative = $fill.hasClass('negative');
    const fillColor = isPositive ? '10B981' : (isNegative ? 'EF4444' : COLORS.accent);

    // Label
    if (label) {
      addText(slide, label, margin, y, 1.5, itemH, {
        fontSize: 11, color: COLORS.ink, align: 'right', bold: true,
      });
    }

    // Find width percentage from style
    let widthPercent = 0.5;
    if ($fill[0]) {
      const style = $fill.attr('style');
      if (style) {
        const match = style.match(/width:\s*(\d+)%/);
        if (match) widthPercent = parseInt(match[1]) / 100;
      }
    }
    const barW = (totalW - 2.8) * widthPercent;
    const barX = margin + 1.6;

    // Bar
    addRoundedRect(slide, barX, y, barW, itemH, fillColor, fillColor);

    // Value
    if (value) {
      addText(slide, value, barX + barW + 0.15, y, 2, itemH, {
        fontSize: 11, color: COLORS.ink, align: 'left', bold: true,
      });
    }
  });
}

function renderHorizontalTimeline(slide, $, $timeline, startY) {
  const items = $timeline.find('.timeline-horizontal-item');
  const n = items.length || 1;
  const gap = 0.25;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const itemW = (totalW - gap * (n - 1)) / n;

  // Draw center line
  addShape(slide, 'rect', margin, startY + 0.4, totalW, 0.05, { fill: { color: COLORS.tileStrong } });

  items.each((i, item) => {
    const $item = $(item);
    const x = margin + i * (itemW + gap) + itemW / 2 - 0.15;

    // Dot
    addShape(slide, 'ellipse', x, startY + 0.32, 0.3, 0.3, { fill: { color: COLORS.accent } });
    addShape(slide, 'ellipse', x + 0.07, startY + 0.39, 0.16, 0.16, { fill: { color: COLORS.cream } });

    const title = textOf($item.find('.timeline-horizontal-title'));
    const desc = textOf($item.find('.timeline-horizontal-desc'));

    if (title) {
      addText(slide, title, margin + i * (itemW + gap), startY + 0.7, itemW, 0.35, {
        fontSize: 12, bold: true, fontFace: FONT_HEADING, color: COLORS.ink, align: 'center',
      });
    }
    if (desc) {
      addText(slide, desc, margin + i * (itemW + gap), startY + 1.05, itemW, 0.35, {
        fontSize: 10, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderDataCompare(slide, $, $compare, startY) {
  const items = $compare.find('.data-compare-item');
  const n = items.length || 1;
  const gap = 0.25;
  const margin = 0.5;
  const totalW = 9 - margin * 2;
  const itemW = (totalW - gap * (n - 1)) / n;
  const itemH = 1.4;

  items.each((i, item) => {
    const $item = $(item);
    const x = margin + i * (itemW + gap);
    addRoundedRect(slide, x, startY, itemW, itemH, 'FFFFFF', COLORS.tileStrong);

    const title = textOf($item.find('.data-compare-title'));
    const value = textOf($item.find('.data-compare-value'));
    const sub = textOf($item.find('.data-compare-sub'));

    if (title) {
      addText(slide, title, x, startY + 0.15, itemW, 0.3, {
        fontSize: 10, color: COLORS.slate, align: 'center',
      });
    }
    if (value) {
      addText(slide, value, x, startY + 0.45, itemW, 0.5, {
        fontSize: 28, color: COLORS.accent, align: 'center', bold: true,
      });
    }
    if (sub) {
      addText(slide, sub, x, startY + 0.95, itemW, 0.3, {
        fontSize: 11, color: COLORS.slate, align: 'center',
      });
    }
  });
}

function renderSlide(slide, $, $slide) {
  slide.background = { color: COLORS.cream };

  const $content = $slide.find('.slide-content');
  const isHero = $content.hasClass('section-hero') || $content.css('text-align') === 'center';
  const h1 = textOf($slide.find('h1'));
  const h2 = textOf($slide.find('h2'));
  const title = h1 || h2 || '';
  const lead = textOf($slide.find('p.lead'));
  const kicker = textOf($slide.find('.kicker'));

  if (isHero && title) {
    renderHero(slide, $, $slide, title, lead);
    return;
  }

  // Header
  let y = 0.4;
  if (kicker) {
    addText(slide, kicker, 0.5, y, 9, 0.35, { fontSize: 11, color: COLORS.accent, bold: true });
    y += 0.35;
  }
  if (title) {
    addText(slide, title, 0.5, y, 9, 0.8, { fontSize: 28, bold: false, fontFace: FONT_HEADING, color: COLORS.ink });
    y += 0.9;
  }
  if (lead) {
    addText(slide, lead, 0.5, y, 9, 0.45, { fontSize: 14, color: COLORS.slate });
    y += 0.55;
  }

  // Body elements
  const $visualRow = $slide.find('.visual-row');
  const $tileRow = $slide.find('.tile-row, .two-col');
  const $quote = $slide.find('.quote-block');
  const $timeline = $slide.find('.timeline');
  const $heroStat = $slide.find('.hero-stat');
  const $badgeRow = $slide.find('.badge-row');
  const $table = $slide.find('table.ppt-table');
  const $barChart = $slide.find('.chart-bar');
  const $progressRings = $slide.find('.progress-ring');
  const $stepsChart = $slide.find('.chart-steps');
  const $dataMatrix = $slide.find('.data-matrix');
  const $waterfall = $slide.find('.waterfall');
  const $horizontalTimeline = $slide.find('.timeline-horizontal');
  const $dataCompare = $slide.find('.data-compare');

  if ($visualRow.length) {
    renderVisualCards(slide, $, $slide, $visualRow, y);
    y += 2.9;
  } else if ($tileRow.length) {
    if ($tileRow.find('> .visual-card').length) {
      renderVisualCards(slide, $, $slide, $tileRow, y);
      y += 2.9;
    } else {
      renderTiles(slide, $, $slide, $tileRow, y);
      y += 2.4;
    }
  }

  if ($quote.length) {
    renderQuote(slide, $quote, y);
    y += 1.9;
  }

  if ($heroStat.length) {
    renderHeroStat(slide, $heroStat, y);
    y += 1.7;
  }

  if ($timeline.length) {
    renderTimeline(slide, $, $timeline, y);
    y += $timeline.find('.timeline-item').length * 1.1 + 0.2;
  }

  if ($badgeRow.length) {
    renderBadges(slide, $, $badgeRow, y);
    y += 0.5;
  }

  if ($table.length) {
    renderTable(slide, $, $table, y);
  }

  if ($barChart.length) {
    renderBarChart(slide, $, $barChart, y);
    y += 2.6;
  }

  if ($progressRings.length) {
    renderProgressRings(slide, $, $progressRings, y);
    y += 2.1;
  }

  if ($stepsChart.length) {
    renderStepsChart(slide, $, $stepsChart, y);
    y += $stepsChart.find('.chart-step').length * 0.9 + 0.3;
  }

  if ($dataMatrix.length) {
    renderDataMatrix(slide, $, $dataMatrix, y);
    y += 3.0;
  }

  if ($waterfall.length) {
    renderWaterfall(slide, $, $waterfall, y);
    y += $waterfall.find('.waterfall-item').length * 0.6 + 0.4;
  }

  if ($horizontalTimeline.length) {
    renderHorizontalTimeline(slide, $, $horizontalTimeline, y);
    y += 1.7;
  }

  if ($dataCompare.length) {
    renderDataCompare(slide, $, $dataCompare, y);
    y += 1.9;
  }
}

export async function exportPptx(name) {
  const projectDir = getProjectDir(name);
  const indexHtml = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`项目 ${name} 的 index.html 不存在`);
  }

  const html = fs.readFileSync(indexHtml, 'utf8');
  const $ = load(html);
  const slides = $('section.slide');
  if (slides.length === 0) {
    throw new Error('未找到幻灯片内容');
  }

  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';
  pres.author = 'ai-ppt';
  pres.title = readConfig(name).params?.title || name;
  pres.defineSlideMaster({
    title: 'MASTER_SLIDE',
    background: { color: COLORS.cream },
  });

  slides.each((_, el) => {
    const slide = pres.addSlide({ masterName: 'MASTER_SLIDE' });
    renderSlide(slide, $, $(el));
  });

  const exportDir = path.join(projectDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const outFile = path.join(exportDir, 'deck.pptx');
  await pres.writeFile({ fileName: outFile });
  return outFile;
}

export async function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/bin/chrome',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Chrome，请安装 Google Chrome 或设置 PUPPETEER_EXECUTABLE_PATH');
}

async function captureSlideImages(indexHtml) {
  const puppeteer = await import('puppeteer-core');
  const executablePath = await findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
    await page.goto('file://' + indexHtml, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);

    // Disable all CSS animations / transitions so screenshots capture the final state
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          animation-play-state: paused !important;
        }
      `;
      document.head.appendChild(style);
    });

    const slideCount = await page.evaluate(() => document.querySelectorAll('#stage > .slide').length);
    if (slideCount === 0) throw new Error('未找到幻灯片');

    const images = [];
    for (let i = 0; i < slideCount; i++) {
      await page.evaluate((idx) => {
        // Hide UI chrome
        ['#help', '#progress', '#hud', '#toast', '#overview'].forEach((sel) => {
          const el = document.querySelector(sel);
          if (el) el.style.display = 'none';
        });
        // Show only the target slide in its final state
        document.querySelectorAll('#stage > .slide').forEach((s, j) => {
          s.style.position = 'absolute';
          s.style.inset = '0';
          s.style.opacity = j === idx ? '1' : '0';
          s.style.pointerEvents = 'none';
          s.style.zIndex = j === idx ? '10' : '0';
          s.style.transform = 'none';
          s.style.animation = 'none';
          s.classList.toggle('active', j === idx);
        });
      }, i);

      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const base64 = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: 1280, height: 720 },
        encoding: 'base64',
      });
      images.push('data:image/png;base64,' + base64);
    }
    return images;
  } finally {
    await browser.close();
  }
}

export async function exportPptxImage(name) {
  const projectDir = getProjectDir(name);
  const indexHtml = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`项目 ${name} 的 index.html 不存在`);
  }

  const images = await captureSlideImages(indexHtml);
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';
  pres.author = 'ai-ppt';
  pres.title = readConfig(name).params?.title || name;

  for (const imageData of images) {
    const slide = pres.addSlide();
    slide.background = { color: COLORS.cream };
    slide.addImage({
      data: imageData,
      x: 0,
      y: 0,
      w: '100%',
      h: '100%',
      sizing: { type: 'cover' },
    });
  }

  const exportDir = path.join(projectDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const outFile = path.join(exportDir, 'deck-image.pptx');
  await pres.writeFile({ fileName: outFile });
  return outFile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const imageMode = args.includes('--image');
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: node scripts/export-pptx.mjs [--image] <project>');
    process.exit(1);
  }
  (imageMode ? exportPptxImage(name) : exportPptx(name))
    .then((file) => console.log(file))
    .catch((err) => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
}
