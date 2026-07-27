#!/usr/bin/env node
// scripts/export-pdf-weasy.mjs — WeasyPrint 矢量 PDF 导出
// 产出矢量文字 PDF（可选中、可搜索、文件小），不依赖浏览器。
// 限制：不执行 JS，data-chart 等动态渲染内容会空白；CSS 支持为 WeasyPrint 子集。
//
// CLI: node scripts/export-pdf-weasy.mjs <project>
// 输出 NDJSON 到 stdout（同 export-pdf.mjs 协议）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { load } from 'cheerio';
import { getProjectDir, ROOT_DIR } from './config.mjs';
import { emit, emitDone, emitError } from './generation-common.mjs';

const __filename = fileURLToPath(import.meta.url);

function downloadInfo(file) {
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  return { file: rel, downloadUrl: '/' + rel };
}

// 探测 weasyprint 是否可用；返回 { ok, pythonCmd, env }
async function probeWeasyprint() {
  const pythonCandidates = ['python3', 'python'];
  // macOS 上如果 pango 等原生库装在 homebrew 而非系统路径，需要 DYLD_FALLBACK_LIBRARY_PATH
  const extraEnv = {};
  if (process.platform === 'darwin') {
    const brewPaths = ['/opt/homebrew/lib', '/usr/local/lib'];
    const existing = [];
    for (const p of brewPaths) {
      if (fs.existsSync(p)) existing.push(p);
    }
    if (existing.length) {
      extraEnv.DYLD_FALLBACK_LIBRARY_PATH = existing.join(':');
    }
  }

  for (const py of pythonCandidates) {
    try {
      const result = await new Promise((resolve) => {
        const proc = spawn(py, ['-c', 'import weasyprint; print(weasyprint.__version__)'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...extraEnv },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('error', () => resolve({ ok: false }));
        proc.on('close', (code) => {
          if (code === 0 && stdout.trim()) {
            resolve({ ok: true, version: stdout.trim(), pythonCmd: py, env: extraEnv });
          } else {
            resolve({ ok: false, stderr });
          }
        });
      });
      if (result.ok) return result;
    } catch {
      // try next
    }
  }
  return { ok: false };
}

// 预处理 HTML：移除脚本/UI 铬件、注入打印 CSS，返回 HTML 字符串
function preprocessHtml(html, projectDir) {
  const $ = load(html);

  // 移除 script（weasyprint 不执行 JS，且避免 data-chart 等占位）
  $('script').remove();

  // 移除 UI 铬件
  $('#help, #progress, #hud, #toast, #overview').remove();
  $('.sidebar, .theme-switcher, .theme-hint, .fullscreen-btn, .marker-toolbar').remove();

  // 移除侧边栏打开状态影响
  $('#stage').removeClass('sidebar-open');

  // 确保所有幻灯片可见（weasyprint 不切页，靠 CSS 分页）
  // — 让每个 .slide 都是正常文档流中的一页，而非 absolute 叠加
  const slides = $('#stage > .slide');
  slides.each((_, el) => {
    const $s = $(el);
    $s.removeClass('active');
    // 清除 absolute/inset/opacity 等由 JS 切换的内联样式
    $s.css({
      position: '',
      inset: '',
      opacity: '',
      'pointer-events': '',
      'z-index': '',
      transform: '',
      animation: '',
      display: '',
      visibility: '',
    });
  });
  // 第一页加 active 以匹配主题/样式中的 .active 相关规则（虽然我们会覆盖，但保险）
  slides.first().addClass('active');

  // 注入 WeasyPrint 专用 CSS
  const weasyCss = `
    @page {
      size: 1280px 800px;
      margin: 0;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 1280px;
      height: 800px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    #app, #stage {
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      max-width: none !important;
    }
    #stage {
      overflow: visible !important;
    }
    #stage > .slide {
      position: relative !important;
      width: 1280px !important;
      height: 800px !important;
      opacity: 1 !important;
      visibility: visible !important;
      display: flex !important;
      page-break-after: always;
      break-after: page;
      transform: none !important;
      animation: none !important;
      transition: none !important;
      overflow: hidden;
    }
    #stage > .slide:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    #stage > .slide * {
      opacity: 1 !important;
      transform: none !important;
      filter: none !important;
      animation: none !important;
      transition: none !important;
    }
    /* 幻灯片内容区撑满 */
    .slide-content {
      width: 100% !important;
      height: 100% !important;
      box-sizing: border-box;
    }
    /* 大数字禁换行，等宽分布 */
    .big-number {
      white-space: nowrap;
    }
    /* 隐藏所有演讲者备注以外的交互元素 */
    .speaker-note { display: none; }
    /* data-chart 占位区域给个提示背景，避免完全空白 */
    [data-chart] {
      background: #f5f5f5;
      border: 1px dashed #ccc;
      min-height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #999;
      font-size: 14px;
    }
    [data-chart]::before {
      content: "图表（需 Puppeteer 导出）";
    }
  `;

  // 在现有 CSS 之后注入（放在 head 末尾以覆盖）
  $('head').append(`<style id="weasyprint-overrides">${weasyCss}</style>`);

  return $.html();
}

export async function exportPdfWeasy(name, onProgress) {
  const projectDir = getProjectDir(name);
  const indexHtml = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`项目 ${name} 的 index.html 不存在`);
  }

  onProgress?.('probe', '正在检测 WeasyPrint');
  const probe = await probeWeasyprint();
  if (!probe.ok) {
    throw new Error('未检测到 weasyprint，请先安装：pip install weasyprint（macOS 还需 brew install pango）');
  }
  onProgress?.('probe', `WeasyPrint ${probe.version} 可用`);

  onProgress?.('prepare', '正在预处理 HTML');
  const originalHtml = fs.readFileSync(indexHtml, 'utf-8');
  const processedHtml = preprocessHtml(originalHtml, projectDir);

  // 写临时 HTML 文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-weasy-'));
  const tmpHtml = path.join(tmpDir, 'deck.html');
  fs.writeFileSync(tmpHtml, processedHtml, 'utf-8');

  const exportDir = path.join(projectDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const outFile = path.join(exportDir, 'deck.pdf');

  onProgress?.('render', '正在生成矢量 PDF');

  const result = await new Promise((resolve, reject) => {
    const proc = spawn(probe.pythonCmd, [
      '-m', 'weasyprint',
      tmpHtml,
      outFile,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...probe.env },
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdout.on('data', () => {}); // 吃掉 stdout

    proc.on('error', (err) => {
      reject(new Error(`weasyprint 启动失败：${err.message}`));
    });
    proc.on('close', (code) => {
      // 清理临时文件
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }

      if (code === 0) {
        resolve({ file: outFile });
      } else {
        reject(new Error(`weasyprint 导出失败（exit ${code}）：${stderr.trim() || '未知错误'}`));
      }
    });
  });

  return result;
}

// CLI 入口
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/export-pdf-weasy.mjs <project>');
    process.exit(1);
  }
  exportPdfWeasy(name, (step, message) => emit(step, message))
    .then((result) => {
      emitDone(downloadInfo(result.file));
    })
    .catch((err) => {
      emitError(err.stack || err.message);
      process.exit(1);
    });
}
