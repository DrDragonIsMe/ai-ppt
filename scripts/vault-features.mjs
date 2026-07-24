// scripts/vault-features.mjs — Logseq 风格笔记特性的纯函数模块：
// 任务行（TODO/DOING/DONE）、页面属性（key:: value）、块锚点（^id）、任务状态切换、微型查询 DSL。
// 本模块不依赖文件系统与其他 scripts，方便单测。

// ---- 代码块跳过工具 ----

// 逐行扫描，回调签名为 (line, index)，``` 围栏内的行不触发回调
function forEachNonCodeLine(body, fn) {
  let inCode = false;
  const lines = String(body || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    fn(lines[i], i);
  }
}

// ---- 任务行解析 ----

// 解析 - TODO / - DOING / - DONE 任务行，返回 [{status, priority, text, line}]（line 为 0 基行号）
export function parseTasks(body) {
  const tasks = [];
  forEachNonCodeLine(body, (line, i) => {
    const m = line.match(/^(\s*)-\s+(TODO|DOING|DONE)\s+(?:\[#(A|B|C)\]\s+)?(.*)$/);
    if (m) {
      tasks.push({
        status: m[2],
        priority: m[3] || null,
        text: m[4].trim(),
        line: i,
      });
    }
  });
  return tasks;
}

// ---- 页面属性解析 ----

// 解析 Logseq 风格属性行 key:: value，同 key 多值合并为数组，返回 {key: value}
export function parseProperties(body) {
  const props = {};
  forEachNonCodeLine(body, (line) => {
    const m = line.match(/^\s*([A-Za-z][\w-]*)::\s+(.+)$/);
    if (!m) return;
    const key = m[1];
    const value = m[2].trim();
    if (key in props) {
      if (Array.isArray(props[key])) props[key].push(value);
      else props[key] = [props[key], value];
    } else {
      props[key] = value;
    }
  });
  return props;
}

// ---- 块锚点解析 ----

// 解析行尾锚点 ^id（id 为 4 位以上字母/数字/中划线），返回 [{id, text, line}]，text 为去锚点后的行文本
export function parseBlockAnchors(body) {
  const blocks = [];
  forEachNonCodeLine(body, (line, i) => {
    const m = line.match(/\s\^([A-Za-z0-9-]{4,})\s*$/);
    if (m) {
      blocks.push({
        id: m[1],
        text: line.slice(0, m.index).trim(),
        line: i,
      });
    }
  });
  return blocks;
}

// ---- 任务状态切换 ----

// 任务状态循环：无标记的 "- " 行 → TODO → DOING → DONE → 无标记；保留缩进与 [#A] 优先级。
// 非 "- " 行原样返回。
export function toggleTaskLine(line) {
  const m = String(line).match(/^(\s*)-\s+(?:(TODO|DOING|DONE)\s+)?(?:\[#(A|B|C)\]\s+)?(.*)$/);
  if (!m) return line;
  const [, indent, status, priority, text] = m;
  const next = status === undefined ? 'TODO' : { TODO: 'DOING', DOING: 'DONE', DONE: null }[status];
  let out = `${indent}-`;
  if (next) out += ` ${next}`;
  if (priority) out += ` [#${priority}]`;
  const rest = text.trim();
  if (rest) out += ` ${rest}`;
  return out;
}

// ---- 微型查询 DSL ----

// 语法：`(and (tag 日记) (task TODO) (property type book) (page 笔记名))`，支持 and/or/not 嵌套。
// 谓词：tag X / task STATUS / property k v / page 名（值允许包含空格，收集到 ')' 为止）。

function tokenize(dsl) {
  const tokens = [];
  const re = /\s*([()]|[^()\s]+)/g;
  let m;
  while ((m = re.exec(dsl)) !== null) tokens.push(m[1]);
  return tokens;
}

function parseQuery(dsl) {
  const tokens = tokenize(dsl);
  let pos = 0;

  const expectClose = () => {
    if (pos >= tokens.length || tokens[pos] !== ')') {
      throw new Error('查询语法错误：缺少右括号');
    }
    pos++;
  };

  // 收集谓词参数（原子）直到右括号；遇到嵌套 '(' 报错
  const collectArgs = (op) => {
    const args = [];
    while (pos < tokens.length && tokens[pos] !== ')') {
      if (tokens[pos] === '(') throw new Error(`查询语法错误：${op} 的参数不能是表达式`);
      args.push(tokens[pos++]);
    }
    return args;
  };

  const parseExpr = () => {
    if (pos >= tokens.length) throw new Error('查询语法错误：表达式不完整');
    const tok = tokens[pos++];
    if (tok !== '(') throw new Error(`查询语法错误：期望 '('，得到 '${tok}'`);
    if (pos >= tokens.length) throw new Error('查询语法错误：缺少操作符');
    const op = tokens[pos++];
    if (op === '(' || op === ')') throw new Error(`查询语法错误：非法操作符 '${op}'`);

    if (op === 'and' || op === 'or') {
      const children = [];
      while (pos < tokens.length && tokens[pos] !== ')') children.push(parseExpr());
      expectClose();
      if (!children.length) throw new Error(`查询语法错误：${op} 至少需要一个子表达式`);
      return { op, children };
    }
    if (op === 'not') {
      const child = parseExpr();
      expectClose();
      return { op, children: [child] };
    }
    if (op === 'tag' || op === 'page') {
      const args = collectArgs(op);
      expectClose();
      if (!args.length) throw new Error(`查询语法错误：${op} 需要一个参数`);
      return { op, args: [args.join(' ')] };
    }
    if (op === 'task') {
      const args = collectArgs(op);
      expectClose();
      if (args.length !== 1) throw new Error('查询语法错误：task 需要一个状态参数（TODO/DOING/DONE）');
      return { op, args };
    }
    if (op === 'property') {
      const args = collectArgs(op);
      expectClose();
      if (args.length < 2) throw new Error('查询语法错误：property 需要键和值两个参数');
      return { op, args: [args[0], args.slice(1).join(' ')] };
    }
    throw new Error(`查询语法错误：未知谓词 '${op}'`);
  };

  const ast = parseExpr();
  if (pos !== tokens.length) throw new Error('查询语法错误：表达式后有多余内容');
  return ast;
}

function normalizeName(name) {
  return String(name).trim().replace(/\.md$/i, '').toLowerCase();
}

function dedupeTasks(tasks) {
  const seen = new Set();
  return tasks.filter((t) => {
    if (seen.has(t.line)) return false;
    seen.add(t.line);
    return true;
  });
}

// 对单条笔记求值，返回 { match, taskHits }：
// task 谓词命中产生行级 taskHits；not 命中不产生行级结果
function evalQuery(node, noteName, entry) {
  switch (node.op) {
    case 'task': {
      const hits = (entry.tasks || []).filter((t) => t.status === node.args[0]);
      return { match: hits.length > 0, taskHits: hits };
    }
    case 'tag':
      return { match: (entry.tags || []).includes(node.args[0]), taskHits: [] };
    case 'property': {
      const raw = (entry.properties || {})[node.args[0]];
      const values = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
      return { match: values.includes(node.args[1]), taskHits: [] };
    }
    case 'page':
      return { match: normalizeName(noteName) === normalizeName(node.args[0]), taskHits: [] };
    case 'and': {
      let taskHits = [];
      for (const child of node.children) {
        const r = evalQuery(child, noteName, entry);
        if (!r.match) return { match: false, taskHits: [] };
        taskHits = taskHits.concat(r.taskHits);
      }
      return { match: true, taskHits: dedupeTasks(taskHits) };
    }
    case 'or': {
      let match = false;
      let taskHits = [];
      for (const child of node.children) {
        const r = evalQuery(child, noteName, entry);
        if (r.match) {
          match = true;
          taskHits = taskHits.concat(r.taskHits);
        }
      }
      return { match, taskHits: match ? dedupeTasks(taskHits) : [] };
    }
    case 'not': {
      const r = evalQuery(node.children[0], noteName, entry);
      return { match: !r.match, taskHits: [] };
    }
    default:
      throw new Error(`查询语法错误：未知谓词 '${node.op}'`);
  }
}

// 执行查询，返回 [{note, line, text, status?, priority?}]。
// task 谓词命中返回对应任务行；tag/property/page 命中笔记级——
// 笔记有任务行则返回任务行，否则返回 {note, line: 0, text: 笔记标题}。
export function runQuery(index, dsl) {
  const ast = parseQuery(dsl);
  const results = [];
  for (const [noteName, entry] of Object.entries((index && index.notes) || {})) {
    const r = evalQuery(ast, noteName, entry);
    if (!r.match) continue;
    const hits = r.taskHits.length ? r.taskHits : (entry.tasks || []);
    if (hits.length) {
      for (const t of hits) {
        results.push({
          note: noteName,
          line: t.line,
          text: t.text,
          status: t.status,
          priority: t.priority ?? null,
        });
      }
    } else {
      results.push({ note: noteName, line: 0, text: entry.title || noteName });
    }
  }
  return results;
}
