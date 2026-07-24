// scripts/front-matter.mjs — 唯一的 Front Matter 解析/序列化模块（零依赖，YAML 子集）。
// 支持的语法：
//   - key: value 标量（字符串 / 数字 / 布尔）
//   - 行内数组 [a, b, "c, d"]（元素含逗号的带引号字符串正确解析）
//   - 多行数组（key: 后接缩进的 - item 列表）
//   - 多行字符串（key: | 字面块 / key: > 折叠块）
//   - 值含冒号（如 time: 12:30）
// 解析与序列化互逆：读出现有 vault 文件再写回不丢字段、不变格式。

// 拆分 front matter 原始文本与正文（不解析字段，fm 含 --- 分隔线与结尾换行）
export function splitFrontMatter(text) {
  const match = String(text ?? '').match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!match) return { fm: '', body: String(text ?? '') };
  return { fm: match[0], body: String(text).slice(match[0].length) };
}

// 解析笔记/碎片/卡片的 Front Matter，返回 { frontMatter, content }
export function parseFrontMatter(content) {
  const text = String(content ?? '');
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (match) {
    return { frontMatter: parseBlock(match[1]), content: match[2] };
  }
  return { frontMatter: {}, content: text };
}

// 序列化为 Front Matter 字符串（空对象返回 ''）；输出形如 `---\n...\n---\n`
export function stringifyFrontMatter(frontMatter) {
  if (!frontMatter || Object.keys(frontMatter).length === 0) return '';
  const lines = ['---'];
  for (const [key, val] of Object.entries(frontMatter)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.map(stringifyArrayItem).join(', ')}]`);
    } else if (typeof val === 'string' && val.includes('\n')) {
      lines.push(`${key}: |`);
      for (const l of val.split('\n')) lines.push(`  ${l}`);
    } else {
      lines.push(`${key}: ${stringifyScalar(val)}`);
    }
  }
  lines.push('---\n');
  return lines.join('\n');
}

// ============================================================
// 内部实现
// ============================================================

// 解析 --- 之间的 YAML 子集文本为扁平对象
function parseBlock(fmText) {
  const obj = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 键：字母/数字/下划线/中划线；冒号后须为空格或行尾（值本身可含冒号，如 12:30）
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:(?:[ \t]+(.*))?$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = (m[2] ?? '').trim();

    if (rest === '') {
      // 多行数组：后续缩进的 `- item` 行
      const items = [];
      let j = i + 1;
      let sawItem = false;
      while (j < lines.length) {
        const im = lines[j].match(/^\s+-\s*(.*)$/);
        if (!im) break;
        sawItem = true;
        const v = im[1].trim();
        if (v !== '') items.push(parseScalar(v));
        j++;
      }
      if (sawItem) { obj[key] = items; i = j; continue; }
      obj[key] = '';
      i++;
      continue;
    }

    // 多行字符串：key: |（字面保留换行）/ key: >（折叠为空格）
    if (/^[|>][+-]?$/.test(rest)) {
      const folded = rest[0] === '>';
      const raw = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^[ \t]/.test(lines[j]))) {
        raw.push(lines[j]);
        j++;
      }
      while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
      const firstContent = raw.find((l) => l.trim() !== '');
      const indent = firstContent ? firstContent.match(/^[ \t]*/)[0] : '';
      const stripped = raw.map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l));
      obj[key] = folded
        ? stripped.map((l) => l.trim()).filter(Boolean).join(' ')
        : stripped.join('\n');
      i = j;
      continue;
    }

    obj[key] = parseScalar(rest);
    i++;
  }
  return obj;
}

// 解析单个标量：行内数组 / 引号字符串 / 布尔 / 数字 / 普通字符串
function parseScalar(raw) {
  const val = raw.trim();
  if (val === '') return '';
  if (val.startsWith('[') && val.endsWith(']')) {
    return splitInlineArray(val.slice(1, -1))
      .map((s) => parseScalar(s))
      .filter((v) => v !== '');
  }
  if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
    return unescapeDoubleQuoted(val.slice(1, -1));
  }
  if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
    return val.slice(1, -1).replace(/''/g, "'");
  }
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^-?\d+$/.test(val)) {
    const n = Number(val);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(val)) {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  return val;
}

// 按逗号切分行内数组，忽略引号内部的逗号
function splitInlineArray(inner) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i];
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((s) => s.trim());
}

function unescapeDoubleQuoted(s) {
  return s.replace(/\\(["\\/bnrt]|u[0-9a-fA-F]{4})/g, (_, esc) => {
    switch (esc[0]) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc;
    }
  });
}

function escapeDoubleQuoted(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 纯字符串不加引号会破坏类型或格式的场景需要加引号
function needsQuotes(s) {
  return s !== s.trim()
    || /^(?:true|false|null)$/.test(s)
    || /^-?\d+(\.\d+)?$/.test(s)
    || /^(?:[-?]\s|[#[\]{},&*!|>'"%@`])/.test(s)
    || /:\s/.test(s)
    || s.endsWith(':')
    || s.includes('"');
}

// 序列化标量；空字符串输出为空（与现有文件 `subject: ` 的写法一致）
function stringifyScalar(val) {
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  const s = String(val);
  if (s === '') return '';
  return needsQuotes(s) ? `"${escapeDoubleQuoted(s)}"` : s;
}

// 数组元素额外要求：含逗号 / 方括号时必须加引号
function stringifyArrayItem(item) {
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  const s = String(item ?? '');
  if (s === '' || needsQuotes(s) || /[,[\]]/.test(s)) {
    return `"${escapeDoubleQuoted(s)}"`;
  }
  return s;
}
