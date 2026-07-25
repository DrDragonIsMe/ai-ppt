// tests/core.test.mjs — 核心函数单元测试（node:test）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isSafeName,
    isSafeProjectName,
    sanitizeProjectName,
} from '../scripts/config.mjs';
import {
    escapeHtml,
    stripMarkdown,
    cleanSlideMarkdown,
    extractMainContent,
    ensureSingleActive,
    diagnoseError,
    splitChangeDetails,
} from '../scripts/generation-common.mjs';

// ---- isSafeName ----
describe('isSafeName', () => {
    it('accepts normal names', () => {
        assert.equal(isSafeName('hello'), true);
        assert.equal(isSafeName('my-project'), true);
        assert.equal(isSafeName('项目名'), true);
        assert.equal(isSafeName('test_123'), true);
    });

    it('rejects empty / non-string', () => {
        assert.equal(isSafeName(''), false);
        assert.equal(isSafeName(null), false);
        assert.equal(isSafeName(undefined), false);
        assert.equal(isSafeName(123), false);
    });

    it('rejects path traversal', () => {
        assert.equal(isSafeName('../etc'), false);
        assert.equal(isSafeName('a/b'), false);
        assert.equal(isSafeName('a\\b'), false);
        assert.equal(isSafeName('..'), false);
    });

    it('rejects control characters', () => {
        assert.equal(isSafeName('a\x00b'), false);
        assert.equal(isSafeName('a\x1fb'), false);
        assert.equal(isSafeName('a\x7fb'), false);
    });
});

// ---- isSafeProjectName ----
describe('isSafeProjectName', () => {
    it('accepts valid project names', () => {
        assert.equal(isSafeProjectName('my-project'), true);
        assert.equal(isSafeProjectName('test_123'), true);
        assert.equal(isSafeProjectName('华龙区'), true);
        assert.equal(isSafeProjectName('q3-sales-preview'), true);
    });

    it('rejects names with spaces or special chars', () => {
        assert.equal(isSafeProjectName('hello world'), false);
        assert.equal(isSafeProjectName('a.b'), false);
        assert.equal(isSafeProjectName('a@b'), false);
        assert.equal(isSafeProjectName(''), false);
        assert.equal(isSafeProjectName(null), false);
    });
});

// ---- sanitizeProjectName ----
describe('sanitizeProjectName', () => {
    it('replaces illegal chars with dash', () => {
        assert.equal(sanitizeProjectName('hello world'), 'hello-world');
        assert.equal(sanitizeProjectName('a@b.c'), 'a-b-c');
        assert.equal(sanitizeProjectName('test!@#$%'), 'test-----');
    });

    it('preserves valid chars', () => {
        assert.equal(sanitizeProjectName('my-project_123'), 'my-project_123');
        assert.equal(sanitizeProjectName('华龙区'), '华龙区');
    });
});

// ---- escapeHtml ----
describe('escapeHtml', () => {
    it('escapes HTML entities', () => {
        assert.equal(escapeHtml('<b>test</b>'), '&lt;b&gt;test&lt;/b&gt;');
        assert.equal(escapeHtml('a & b'), 'a &amp; b');
        assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
    });

    it('handles null / undefined', () => {
        assert.equal(escapeHtml(null), '');
        assert.equal(escapeHtml(undefined), '');
    });

    it('returns plain text unchanged', () => {
        assert.equal(escapeHtml('hello world'), 'hello world');
    });
});

// ---- stripMarkdown ----
describe('stripMarkdown', () => {
    it('removes headers', () => {
        assert.equal(stripMarkdown('# Title'), 'Title');
        assert.equal(stripMarkdown('## Sub title'), 'Sub title');
    });

    it('removes bold / italic', () => {
        assert.equal(stripMarkdown('**bold**'), 'bold');
        assert.equal(stripMarkdown('__also bold__'), 'also bold');
    });

    it('removes links but keeps text', () => {
        assert.equal(stripMarkdown('[click here](https://example.com)'), 'click here');
    });

    it('removes images entirely', () => {
        assert.equal(stripMarkdown('![alt text](image.png)'), '');
    });

    it('removes list markers', () => {
        assert.equal(stripMarkdown('- item one'), 'item one');
        assert.equal(stripMarkdown('1. first item'), 'first item');
    });

    it('removes blockquotes', () => {
        assert.equal(stripMarkdown('> quoted text'), 'quoted text');
    });

    it('removes inline code backticks', () => {
        assert.equal(stripMarkdown('use `npm install`'), 'use npm install');
    });

    it('handles null', () => {
        assert.equal(stripMarkdown(null), '');
        assert.equal(stripMarkdown(undefined), '');
    });
});

// ---- cleanSlideMarkdown ----
describe('cleanSlideMarkdown', () => {
    it('cleans markdown in text nodes', () => {
        const input = '<p>**bold text** and [link](url)</p>';
        const result = cleanSlideMarkdown(input);
        assert.ok(!result.includes('**'));
        assert.ok(!result.includes('](url)'));
        assert.ok(result.includes('bold text'));
        assert.ok(result.includes('link'));
    });

    it('returns falsy input as-is', () => {
        assert.equal(cleanSlideMarkdown(''), '');
        assert.equal(cleanSlideMarkdown(null), null);
    });
});

// ---- extractMainContent ----
describe('extractMainContent', () => {
    it('extracts from <main class="stage">', () => {
        const html = '<html><body><main class="stage"><section class="slide">S1</section></main></body></html>';
        const result = extractMainContent(html);
        assert.ok(result.includes('section'));
        assert.ok(result.includes('S1'));
        assert.ok(!result.includes('<main'));
    });

    it('falls back to body sections', () => {
        const html = '<html><body><section class="slide">S1</section><section class="slide">S2</section></body></html>';
        const result = extractMainContent(html);
        assert.ok(result.includes('S1'));
        assert.ok(result.includes('S2'));
    });

    it('handles empty input', () => {
        assert.equal(extractMainContent(''), '');
        assert.equal(extractMainContent(null), '');
    });
});

// ---- ensureSingleActive ----
describe('ensureSingleActive', () => {
    it('ensures only first slide is active', () => {
        const input = '<section class="slide active">S1</section><section class="slide active">S2</section>';
        const result = ensureSingleActive(input);
        const activeCount = (result.match(/class="slide active"/g) || []).length;
        assert.equal(activeCount, 1);
        // First slide should be active
        assert.ok(result.indexOf('active') < result.indexOf('S2'));
    });

    it('adds active to first slide if none had it', () => {
        const input = '<section class="slide">S1</section><section class="slide">S2</section>';
        const result = ensureSingleActive(input);
        assert.ok(result.includes('active'));
    });
});

// ---- diagnoseError ----
describe('diagnoseError', () => {
    it('diagnoses 401 errors', () => {
        const hint = diagnoseError('API returned 401 Unauthorized');
        assert.ok(hint);
        assert.ok(hint.includes('API Key'));
    });

    it('diagnoses rate limit errors', () => {
        const hint = diagnoseError('HTTP 429 Too Many Requests');
        assert.ok(hint);
        assert.ok(hint.includes('频率'));
    });

    it('diagnoses network errors', () => {
        const hint = diagnoseError('ECONNREFUSED 127.0.0.1:8080');
        assert.ok(hint);
        assert.ok(hint.includes('连接'));
    });

    it('diagnoses timeout errors', () => {
        const hint = diagnoseError('Request timeout after 30s');
        assert.ok(hint);
        assert.ok(hint.includes('超时'));
    });

    it('returns null for unknown errors', () => {
        assert.equal(diagnoseError('something weird happened'), null);
        assert.equal(diagnoseError(''), null);
    });
});

// ---- splitChangeDetails ----
describe('splitChangeDetails', () => {
    it('splits content with marker', () => {
        const text = '修改后的内容\n---修改说明---\n修改了第3页的标题';
        const result = splitChangeDetails(text);
        assert.equal(result.content, '修改后的内容');
        assert.ok(result.details.includes('修改了第3页'));
    });

    it('handles content without marker', () => {
        const result = splitChangeDetails('just content');
        assert.equal(result.content, 'just content');
        assert.equal(result.details, '');
    });
});

// ==================== Logseq 笔记特性（scripts/vault-features.mjs） ====================
import {
    parseTasks,
    parseProperties,
    parseBlockAnchors,
    toggleTaskLine,
    runQuery,
} from '../scripts/vault-features.mjs';
import { buildFallbackReport } from '../scripts/generate-report.mjs';

// ---- parseTasks ----
describe('parseTasks', () => {
    it('parses task lines with status / priority / line number', () => {
        const body = '# 标题\n- TODO [#A] 写周报\n  - DOING 子任务\n- DONE 已完成';
        const tasks = parseTasks(body);
        assert.equal(tasks.length, 3);
        assert.deepEqual(tasks[0], { status: 'TODO', priority: 'A', text: '写周报', line: 1 });
        assert.equal(tasks[1].priority, null);
        assert.equal(tasks[1].line, 2);
        assert.equal(tasks[2].status, 'DONE');
    });

    it('skips fenced code blocks', () => {
        const body = '- TODO 真实任务\n```\n- TODO 代码里的假任务\n```\n- DONE 另一个';
        const tasks = parseTasks(body);
        assert.equal(tasks.length, 2);
        assert.equal(tasks[1].text, '另一个');
    });

    it('ignores plain list items without status', () => {
        assert.equal(parseTasks('- 普通列表项\n- 另一项').length, 0);
    });
});

// ---- parseProperties ----
describe('parseProperties', () => {
    it('parses key:: value lines', () => {
        const props = parseProperties('type:: book\nauthor:: 张三\n正文行');
        assert.equal(props.type, 'book');
        assert.equal(props.author, '张三');
        assert.equal(props['正文行'], undefined);
    });

    it('merges duplicate keys into an array', () => {
        const props = parseProperties('tag:: a\ntag:: b\ntag:: c');
        assert.deepEqual(props.tag, ['a', 'b', 'c']);
    });

    it('skips fenced code blocks', () => {
        const props = parseProperties('type:: book\n```\ntype:: fake\n```');
        assert.equal(props.type, 'book');
    });
});

// ---- parseBlockAnchors ----
describe('parseBlockAnchors', () => {
    it('extracts trailing anchors and strips them from text', () => {
        const blocks = parseBlockAnchors('这是一个重要段落 ^abc1\n没有锚点的行\n- 列表块 ^blk-99');
        assert.equal(blocks.length, 2);
        assert.deepEqual(blocks[0], { id: 'abc1', text: '这是一个重要段落', line: 0 });
        assert.equal(blocks[1].id, 'blk-99');
    });

    it('rejects anchors shorter than 4 chars and skips code blocks', () => {
        const blocks = parseBlockAnchors('短锚 ^ab1\n```\n代码内 ^fake1\n```');
        assert.equal(blocks.length, 0);
    });
});

// ---- toggleTaskLine ----
describe('toggleTaskLine', () => {
    it('cycles 无标记 → TODO → DOING → DONE → 无标记', () => {
        assert.equal(toggleTaskLine('- 写周报'), '- TODO 写周报');
        assert.equal(toggleTaskLine('- TODO 写周报'), '- DOING 写周报');
        assert.equal(toggleTaskLine('- DOING 写周报'), '- DONE 写周报');
        assert.equal(toggleTaskLine('- DONE 写周报'), '- 写周报');
    });

    it('preserves indent and priority', () => {
        assert.equal(toggleTaskLine('  - TODO [#A] 写周报'), '  - DOING [#A] 写周报');
        assert.equal(toggleTaskLine('- DONE [#B] 写周报'), '- [#B] 写周报');
    });

    it('returns non-list lines unchanged', () => {
        assert.equal(toggleTaskLine('普通文本行'), '普通文本行');
        assert.equal(toggleTaskLine('# 标题'), '# 标题');
    });
});

// ---- runQuery ----
describe('runQuery', () => {
    const index = {
        notes: {
            '日记 7月1日': {
                title: '7月1日日记',
                tags: ['日记'],
                tasks: [{ status: 'TODO', priority: null, text: '写周报', line: 2 }],
                properties: {},
            },
            '读书笔记': {
                title: '如何阅读一本书',
                tags: ['读书'],
                tasks: [
                    { status: 'DONE', priority: 'A', text: '读完第一章', line: 3 },
                    { status: 'TODO', priority: null, text: '整理笔记', line: 4 },
                ],
                properties: { type: 'book' },
            },
            '普通笔记': {
                title: '普通笔记',
                tags: [],
                tasks: [],
                properties: {},
            },
        },
    };

    it('task 谓词命中行级返回任务行', () => {
        const results = runQuery(index, '(task TODO)');
        assert.equal(results.length, 2);
        assert.deepEqual(results[0], { note: '日记 7月1日', line: 2, text: '写周报', status: 'TODO', priority: null });
    });

    it('tag 命中笔记级：有任务返回任务行，无任务返回标题', () => {
        const withTasks = runQuery(index, '(tag 日记)');
        assert.equal(withTasks[0].text, '写周报');
        const noTasks = runQuery(index, '(page 普通笔记)');
        assert.deepEqual(noTasks, [{ note: '普通笔记', line: 0, text: '普通笔记' }]);
    });

    it('property 谓词与 page 名归一化匹配', () => {
        const results = runQuery(index, '(property type book)');
        // 命中的笔记有 2 条任务行，笔记级命中返回全部任务行
        assert.equal(results.length, 2);
        assert.ok(results.every((r) => r.note === '读书笔记'));
        const byPage = runQuery(index, '(page 读书笔记.md)');
        assert.equal(byPage.length, 2);
        assert.ok(byPage.every((r) => r.note === '读书笔记'));
    });

    it('支持 and / or / not 嵌套组合', () => {
        const r1 = runQuery(index, '(and (tag 读书) (task TODO))');
        assert.equal(r1.length, 1);
        assert.equal(r1[0].text, '整理笔记');
        const r2 = runQuery(index, '(or (tag 日记) (property type book))');
        assert.equal(new Set(r2.map((r) => r.note)).size, 2);
        const r3 = runQuery(index, '(and (task TODO) (not (tag 读书)))');
        assert.equal(r3.length, 1);
        assert.equal(r3[0].note, '日记 7月1日');
    });

    it('语法错误抛出异常', () => {
        assert.throws(() => runQuery(index, '(and (tag 日记)'), /查询语法错误/);
        assert.throws(() => runQuery(index, '(foo bar)'), /查询语法错误/);
        assert.throws(() => runQuery(index, '(task)'), /查询语法错误/);
    });
});

// ---- buildFallbackReport（generate-report 降级模板，无 LLM 时确定性输出） ----
describe('buildFallbackReport', () => {
    it('generates deterministic structured markdown', () => {
        const collected = [
            { name: '笔记A', title: '笔记A', body: '# 笔记A\n这是 **第一篇** 笔记的正文内容。' },
            { name: '笔记B', title: '笔记B', body: '' },
        ];
        const content = buildFallbackReport('测试报告', collected);
        assert.ok(content.startsWith('# 测试报告'));
        assert.ok(content.includes('## 摘要'));
        assert.ok(content.includes('## 要点'));
        assert.ok(content.includes('## 结论'));
        assert.ok(content.includes('笔记A、笔记B'));
        assert.ok(content.includes('第一篇'));
        assert.ok(!content.includes('**第一篇**')); // 正文摘录已去除 Markdown 标记
        assert.ok(content.includes('（无正文内容）'));
        // 同样的输入输出完全一致（确定性）
        assert.equal(content, buildFallbackReport('测试报告', collected));
    });
});

// ==================== v2.5.0 速记多媒体（资产上传校验 + 碎片附件 token） ====================
import { detectAssetKind, appendAttachmentTokens } from '../routes/vault.mjs';

// ---- detectAssetKind（POST /api/vault/assets 的后缀 + 魔数校验逻辑） ----
describe('detectAssetKind', () => {
    // 标准 8 字节 PNG 文件头
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    it('识别合法 PNG 为 image', () => {
        const r = detectAssetKind('photo.png', PNG_HEADER);
        assert.equal(r.kind, 'image');
        assert.equal(r.error, undefined);
    });

    it('识别各类型合法魔数', () => {
        assert.equal(detectAssetKind('a.jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])).kind, 'image');
        assert.equal(detectAssetKind('a.pdf', Buffer.from('%PDF-1.4', 'latin1')).kind, 'doc');
        assert.equal(detectAssetKind('a.docx', Buffer.from([0x50, 0x4B, 0x03, 0x04])).kind, 'doc');
        assert.equal(detectAssetKind('a.mp3', Buffer.from('ID3xxxx', 'latin1')).kind, 'audio');
        assert.equal(detectAssetKind('a.mp3', Buffer.from([0xFF, 0xFB, 0x90])).kind, 'audio');
        assert.equal(detectAssetKind('a.mp4', Buffer.from('\x00\x00\x00\x18ftyp', 'latin1')).kind, 'video');
        assert.equal(detectAssetKind('a.webm', Buffer.from([0x1A, 0x45, 0xDF, 0xA3])).kind, 'video');
    });

    it('拒绝不支持的扩展名（如 .exe）', () => {
        const r = detectAssetKind('evil.exe', Buffer.from([0x4D, 0x5A, 0x90, 0x00]));
        assert.ok(r.error);
        assert.ok(r.error.includes('不支持的文件类型'));
    });

    it('拒绝魔数与扩展名不符的文件', () => {
        const r = detectAssetKind('fake.png', Buffer.from('not a png at all', 'latin1'));
        assert.ok(r.error);
        assert.ok(r.error.includes('魔数校验失败'));
    });

    it('拒绝空文件', () => {
        assert.ok(detectAssetKind('a.png', Buffer.alloc(0)).error);
    });
});

// ---- appendAttachmentTokens（POST /api/vault/fragments 附件 → ![[name]] token） ----
describe('appendAttachmentTokens', () => {
    it('把附件名以 ![[name]] 追加进正文', () => {
        const r = appendAttachmentTokens('速记内容', ['doc.pdf', 'img.png']);
        assert.ok(r.startsWith('速记内容'));
        assert.ok(r.includes('![[doc.pdf]]'));
        assert.ok(r.includes('![[img.png]]'));
    });

    it('无附件时正文不变', () => {
        assert.equal(appendAttachmentTokens('速记内容', []), '速记内容');
        assert.equal(appendAttachmentTokens('速记内容'), '速记内容');
    });

    it('正文已含同名 token 时不重复追加（前端已拼接的场景）', () => {
        const r = appendAttachmentTokens('速记内容\n![[doc.pdf]]', ['doc.pdf', 'img.png']);
        assert.equal(r, '速记内容\n![[doc.pdf]]\n![[img.png]]');
    });
});

// ---- extractAttachmentNames / upsertParseBlock（碎片附件重解析） ----
import { extractAttachmentNames, upsertParseBlock } from '../scripts/fragments.mjs';

describe('extractAttachmentNames', () => {
    it('从正文提取附件名并去重', () => {
        const names = extractAttachmentNames('文字\n![[a.png]]\n![[b.webm]]\n![[a.png]]');
        assert.deepEqual(names, ['a.png', 'b.webm']);
    });

    it('忽略非资产后缀与普通 wikilink', () => {
        assert.deepEqual(extractAttachmentNames('[[笔记]] ![[x.txt]] ![[y.exe]]'), []);
        assert.deepEqual(extractAttachmentNames(''), []);
    });
});

describe('upsertParseBlock', () => {
    it('无旧块时追加到末尾', () => {
        const r = upsertParseBlock('正文\n![[a.png]]', 'a.png', '解析文本', 'openai-vision');
        assert.equal(r, '正文\n![[a.png]]\n\n📎 a.png 解析（openai-vision）：\n解析文本');
    });

    it('替换旧块（无 provider 括号的历史格式）', () => {
        const old = '正文\n\n📎 a.png 解析：\n（暂无法解析，已仅保存附件）';
        const r = upsertParseBlock(old, 'a.png', '新解析', 'bl-asr');
        assert.equal(r, '正文\n\n📎 a.png 解析（bl-asr）：\n新解析');
    });

    it('替换旧块且不影响后续其他附件的解析块', () => {
        const old = '正文\n\n📎 a.png 解析（bl）：\n旧A\n\n📎 b.pdf 解析（pdf-parse+llm）：\n旧B';
        const r = upsertParseBlock(old, 'a.png', '新A', 'openai-vision');
        assert.ok(r.includes('📎 a.png 解析（openai-vision）：\n新A'));
        assert.ok(r.includes('📎 b.pdf 解析（pdf-parse+llm）：\n旧B'));
        assert.ok(!r.includes('旧A'));
    });
});


// ==================== Front Matter 统一解析（scripts/front-matter.mjs） ====================
import {
    parseFrontMatter,
    stringifyFrontMatter,
    splitFrontMatter,
} from '../scripts/front-matter.mjs';

describe('parseFrontMatter', () => {
    it('parses scalar values（字符串/数字/布尔）', () => {
        const { frontMatter, content } = parseFrontMatter('---\ntitle: 招聘管理模块\ncount: 8\nratio: 1.5\npinned: true\n---\n\n正文');
        assert.equal(frontMatter.title, '招聘管理模块');
        assert.equal(frontMatter.count, 8);
        assert.equal(frontMatter.ratio, 1.5);
        assert.equal(frontMatter.pinned, true);
        assert.equal(content.trim(), '正文');
    });

    it('parses inline arrays', () => {
        const { frontMatter } = parseFrontMatter('---\ntags: [HR, SaaS, 招聘]\nempty: []\n---\nx');
        assert.deepEqual(frontMatter.tags, ['HR', 'SaaS', '招聘']);
        assert.deepEqual(frontMatter.empty, []);
    });

    it('parses inline array items containing commas when quoted', () => {
        const { frontMatter } = parseFrontMatter('---\ntags: ["a, b", c, \'d, e\']\n---\nx');
        assert.deepEqual(frontMatter.tags, ['a, b', 'c', 'd, e']);
    });

    it('parses multi-line arrays（- item 形式）', () => {
        const { frontMatter } = parseFrontMatter('---\ntags:\n  - HR\n  - 招聘\nstatus: inbox\n---\nx');
        assert.deepEqual(frontMatter.tags, ['HR', '招聘']);
        assert.equal(frontMatter.status, 'inbox');
    });

    it('handles multi-line strings（key: | 与 key: >）不崩溃且按字面保留', () => {
        const literal = parseFrontMatter('---\ndesc: |\n  第一行\n  第二行\nnext: ok\n---\nx');
        assert.equal(literal.frontMatter.desc, '第一行\n第二行');
        assert.equal(literal.frontMatter.next, 'ok');
        const folded = parseFrontMatter('---\ndesc: >\n  第一行\n  第二行\n---\nx');
        assert.equal(folded.frontMatter.desc, '第一行 第二行');
    });

    it('keeps values containing colons（time: 12:30）', () => {
        const { frontMatter } = parseFrontMatter('---\ntime: 12:30\nurl: https://example.com\n---\nx');
        assert.equal(frontMatter.time, '12:30');
        assert.equal(frontMatter.url, 'https://example.com');
    });

    it('returns empty frontMatter when there is no FM block', () => {
        const { frontMatter, content } = parseFrontMatter('# 只有正文\n没有 front matter');
        assert.deepEqual(frontMatter, {});
        assert.equal(content, '# 只有正文\n没有 front matter');
    });

    it('handles empty FM block', () => {
        // 空 FM 块的标准写法是 ---\n\n---（与旧解析器行为一致）
        const { frontMatter, content } = parseFrontMatter('---\n\n---\n正文');
        assert.deepEqual(frontMatter, {});
        assert.equal(content, '正文');
    });

    it('parses empty string value（subject: 留空）', () => {
        const { frontMatter } = parseFrontMatter('---\nsubject: \ndifficulty: 1\n---\nx');
        assert.equal(frontMatter.subject, '');
        assert.equal(frontMatter.difficulty, 1);
    });
});

describe('stringifyFrontMatter', () => {
    it('returns empty string for empty/null input', () => {
        assert.equal(stringifyFrontMatter({}), '');
        assert.equal(stringifyFrontMatter(null), '');
    });

    it('round-trips scalars and arrays without losing fields', () => {
        const original = '---\ntitle: 招聘管理模块\ntags: [HR, 招聘]\ncreated: 2026-07-22\n---\n\n# 正文\n';
        const { frontMatter } = parseFrontMatter(original);
        const rebuilt = stringifyFrontMatter(frontMatter);
        const again = parseFrontMatter(`${rebuilt}\n# 正文\n`);
        assert.deepEqual(again.frontMatter, frontMatter);
        // 格式与现有文件一致：行内数组、无引号中文标量
        assert.ok(rebuilt.includes('tags: [HR, 招聘]'));
        assert.ok(rebuilt.includes('title: 招聘管理模块'));
    });

    it('quotes array items containing commas so round-trip preserves them', () => {
        const fm = { tags: ['a, b', 'c'], time: '12:30', count: 8, ok: false };
        const text = stringifyFrontMatter(fm);
        const { frontMatter } = parseFrontMatter(`${text}\n正文`);
        assert.deepEqual(frontMatter.tags, ['a, b', 'c']);
        assert.equal(frontMatter.time, '12:30');
        assert.equal(frontMatter.count, 8);
        assert.equal(frontMatter.ok, false);
    });

    it('serializes multi-line strings as literal blocks and parses them back', () => {
        const fm = { desc: '第一行\n第二行' };
        const text = stringifyFrontMatter(fm);
        assert.ok(text.includes('desc: |'));
        const { frontMatter } = parseFrontMatter(`${text}\n正文`);
        assert.equal(frontMatter.desc, '第一行\n第二行');
    });
});

describe('splitFrontMatter', () => {
    it('splits raw FM text and body（chat-note 保留 FM 的语义不变）', () => {
        const text = '---\ntitle: x\ntags: [a, b]\n---\n\n正文第一行';
        const { fm, body } = splitFrontMatter(text);
        assert.ok(fm.startsWith('---'));
        assert.ok(fm.includes('title: x'));
        assert.equal(body, '正文第一行');
    });

    it('returns whole text as body when no FM', () => {
        const { fm, body } = splitFrontMatter('纯正文');
        assert.equal(fm, '');
        assert.equal(body, '纯正文');
    });
});

// ==================== 原子写（scripts/fs-utils.mjs） ====================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../scripts/fs-utils.mjs';

describe('writeFileAtomic / writeJsonAtomic', () => {
    it('writes content correctly and leaves no temp files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-atomic-'));
        try {
            const target = path.join(dir, 'note.md');
            writeFileAtomic(target, '内容 with émoji 🎉');
            assert.equal(fs.readFileSync(target, 'utf8'), '内容 with émoji 🎉');
            // 覆盖写
            writeFileAtomic(target, '第二版');
            assert.equal(fs.readFileSync(target, 'utf8'), '第二版');
            // 无 .tmp 残留
            assert.deepEqual(fs.readdirSync(dir), ['note.md']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('creates missing parent directories', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-atomic-'));
        try {
            const target = path.join(dir, 'sub', 'deep', 'f.txt');
            writeFileAtomic(target, 'x');
            assert.equal(fs.readFileSync(target, 'utf8'), 'x');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writeJsonAtomic produces parseable pretty JSON', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-atomic-'));
        try {
            const target = path.join(dir, 'data.json');
            writeJsonAtomic(target, { a: 1, tags: ['x', 'y'] });
            assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1, tags: ['x', 'y'] });
            assert.ok(fs.readFileSync(target, 'utf8').includes('\n  "a": 1'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});


// ==================== vault 增量索引（scripts/link-resolver.mjs） ====================
import { rebuildIndex, INDEX_VERSION } from '../scripts/link-resolver.mjs';

// 构造注入式假 IO：notes = { name: { content, mtime } }，index 为既有索引（可选）
function makeFakeVaultIO({ notes = {}, index = null } = {}) {
    const io = {
        written: [],
        reads: [],
        readIndex: () => (index ? JSON.parse(JSON.stringify(index)) : { notes: {}, backlinks: {}, tags: {} }),
        writeIndex: (idx) => { io.written.push(idx); },
        listNotes: () => Object.entries(notes)
            .map(([name, n]) => ({ name, mtime: n.mtime }))
            .sort((a, b) => b.mtime.localeCompare(a.mtime)),
        readNote: (name) => { io.reads.push(name); return notes[name] ? notes[name].content : null; },
    };
    return io;
}

const NOTE_A = '---\ntitle: 笔记A\ntags: [x]\n---\n\n链接到 [[B]] 和 [[C]]\n- TODO [#A] 任务一\n';
const NOTE_B = '---\ntitle: 笔记B\n---\n\n回链 [[A]]\n';
const NOTE_C = '正文无 front matter\n';

describe('rebuildIndex 增量索引（mtime 驱动）', () => {
    const T1 = '2026-07-01T00:00:00.000Z';
    const T2 = '2026-07-02T00:00:00.000Z';

    it('索引版本不符时全量重建并写盘（含 _version 与派生数据）', () => {
        const io = makeFakeVaultIO({
            notes: { A: { content: NOTE_A, mtime: T1 }, B: { content: NOTE_B, mtime: T1 } },
        });
        const index = rebuildIndex({ io });
        assert.equal(io.written.length, 1);
        assert.equal(index._version, INDEX_VERSION);
        assert.deepEqual(io.reads.sort(), ['A', 'B']);
        // 派生数据：反链 / 标签 / 任务
        assert.equal(index.backlinks.B.length, 1);
        assert.equal(index.backlinks.B[0].source, 'A');
        assert.ok(index.backlinks.B[0].snippets[0].includes('[[B]]'));
        assert.deepEqual(index.tags.x, ['A']);
        assert.equal(index.tasks.length, 1);
        assert.equal(index.tasks[0].text, '任务一');
        // 正文缓存供 searchNotes 使用
        assert.equal(index.notes.A.content, NOTE_A);
    });

    it('mtime 变化只重解析变化的文件', () => {
        const notes = { A: { content: NOTE_A, mtime: T1 }, B: { content: NOTE_B, mtime: T1 } };
        const first = rebuildIndex({ io: makeFakeVaultIO({ notes }) });
        // A 的 mtime 变化（内容也变了），B 未动
        const notes2 = {
            A: { content: NOTE_A.replace('任务一', '任务二'), mtime: T2 },
            B: { content: NOTE_B, mtime: T1 },
        };
        const io2 = makeFakeVaultIO({ notes: notes2, index: first });
        const second = rebuildIndex({ io: io2 });
        assert.deepEqual(io2.reads, ['A']); // 只重读 A
        assert.equal(io2.written.length, 1);
        assert.equal(second.notes.A.tasks[0].text, '任务二');
        assert.equal(second.notes.A.mtime, T2);
        assert.equal(second.notes.B.title, '笔记B'); // B 条目保留
    });

    it('删除的文件从索引剔除', () => {
        const notes = { A: { content: NOTE_A, mtime: T1 }, B: { content: NOTE_B, mtime: T1 } };
        const first = rebuildIndex({ io: makeFakeVaultIO({ notes }) });
        const io2 = makeFakeVaultIO({ notes: { A: notes.A }, index: first });
        const second = rebuildIndex({ io: io2 });
        assert.equal(io2.reads.length, 0); // 删除不需要重读任何文件
        assert.equal(io2.written.length, 1);
        assert.equal(second.notes.B, undefined);
        assert.equal(second.backlinks.B, undefined); // 派生数据同步剔除
        assert.ok(second.notes.A);
    });

    it('新增文件被加入索引', () => {
        const notes = { A: { content: NOTE_A, mtime: T1 } };
        const first = rebuildIndex({ io: makeFakeVaultIO({ notes }) });
        const notes2 = { A: notes.A, C: { content: NOTE_C, mtime: T2 } };
        const io2 = makeFakeVaultIO({ notes: notes2, index: first });
        const second = rebuildIndex({ io: io2 });
        assert.deepEqual(io2.reads, ['C']);
        assert.equal(io2.written.length, 1);
        assert.ok(second.notes.C);
    });

    it('无变化时不重读文件、不写盘', () => {
        const notes = { A: { content: NOTE_A, mtime: T1 }, B: { content: NOTE_B, mtime: T1 } };
        const first = rebuildIndex({ io: makeFakeVaultIO({ notes }) });
        const io2 = makeFakeVaultIO({ notes, index: first });
        const second = rebuildIndex({ io: io2 });
        assert.equal(io2.reads.length, 0);
        assert.equal(io2.written.length, 0); // 关键：只读路径重复调用零写盘
        assert.equal(second.backlinks.B[0].source, 'A'); // 返回的索引仍可直接使用
    });

    it('force=true 强制全量重建', () => {
        const notes = { A: { content: NOTE_A, mtime: T1 } };
        const first = rebuildIndex({ io: makeFakeVaultIO({ notes }) });
        const io2 = makeFakeVaultIO({ notes, index: first });
        rebuildIndex({ force: true, io: io2 });
        assert.deepEqual(io2.reads, ['A']);
        assert.equal(io2.written.length, 1);
    });
});

// ==================== chat-modify 局部编辑协议（scripts/chat-modify.mjs） ====================
import {
    parsePartialSlides,
    mergePartialSlides,
    selectRelevantSlides,
    PARTIAL_THRESHOLD,
} from '../scripts/chat-modify.mjs';
import { wrapSlides } from '../scripts/generation-common.mjs';

const SLIDE_1 = '<section class="slide active"><div class="slide-content"><h2>封面</h2></div></section>';
const SLIDE_2 = '<section class="slide"><div class="slide-content"><h2>旧标题</h2><p>第二页正文</p></div></section>';
const SLIDE_3 = '<section class="slide"><div class="slide-content"><h2>结尾</h2></div></section>';

function buildDeckHtml(extraSlides = []) {
    const slides = [SLIDE_1, SLIDE_2, SLIDE_3, ...extraSlides].join('\n');
    // 模拟用户模板外定制：head 里的手写 style 与注释
    return wrapSlides(slides, '测试 Deck', '')
        .replace('</head>', '  <style>.my-custom { color: red; }</style>\n  <!-- 用户手写注释 -->\n</head>');
}

describe('parsePartialSlides（局部编辑协议解析）', () => {
    it('解析 === slide N === 与 === slide new === 区块', () => {
        const out = `=== slide 2 ===
${SLIDE_2.replace('旧标题', '新标题')}
=== slide new ===
<section class="slide"><div class="slide-content"><h2>新增页</h2></div></section>`;
        const blocks = parsePartialSlides(out);
        assert.equal(blocks.length, 2);
        assert.equal(blocks[0].index, 2);
        assert.ok(blocks[0].html.includes('新标题'));
        assert.equal(blocks[1].index, 'new');
        assert.ok(blocks[1].html.includes('新增页'));
    });

    it('兼容 <!-- slide:N --> 注释标记', () => {
        const blocks = parsePartialSlides(`<!-- slide:1 -->\n${SLIDE_1}`);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].index, 1);
    });

    it('无标记时返回 null（触发整页重写降级）', () => {
        assert.equal(parsePartialSlides(`${SLIDE_1}\n${SLIDE_2}`), null);
        assert.equal(parsePartialSlides(''), null);
        assert.equal(parsePartialSlides(null), null);
    });

    it('跳过没有 section.slide 的区块', () => {
        const blocks = parsePartialSlides(`=== slide 2 ===\n没有 section 的垃圾内容\n=== slide 3 ===\n${SLIDE_3}`);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].index, 3);
    });
});

describe('mergePartialSlides（DOM 级合并）', () => {
    it('只替换指定页，未修改页与 head 定制原样保留', () => {
        const deck = buildDeckHtml();
        const blocks = parsePartialSlides(`=== slide 2 ===\n${SLIDE_2.replace('旧标题', 'XXX')}`);
        const merged = mergePartialSlides(deck, blocks);
        assert.ok(merged);
        assert.deepEqual(merged.applied, [2]);
        assert.equal(merged.slideCount, 3);
        assert.ok(merged.html.includes('XXX'));
        assert.ok(!merged.html.includes('旧标题'));
        // 未修改页内容保留
        assert.ok(merged.html.includes('封面'));
        assert.ok(merged.html.includes('结尾'));
        // head 定制保留
        assert.ok(merged.html.includes('.my-custom { color: red; }'));
        assert.ok(merged.html.includes('用户手写注释'));
        // 引擎资源引用保留
        assert.ok(merged.html.includes('css/ppt.css'));
        assert.ok(merged.html.includes('js/ppt.js'));
    });

    it('保留原文档的 active 页', () => {
        const deck = buildDeckHtml();
        const blocks = parsePartialSlides(`=== slide 1 ===\n<section class="slide"><div class="slide-content"><h2>封面改</h2></div></section>`);
        const merged = mergePartialSlides(deck, blocks);
        const activeCount = (merged.html.match(/class="slide active"/g) || []).length;
        assert.equal(activeCount, 1);
        // 被替换的第 1 页仍是 active
        assert.ok(merged.html.indexOf('slide active') < merged.html.indexOf('封面改'));
    });

    it('slide:new 在末尾追加新页', () => {
        const deck = buildDeckHtml();
        const blocks = parsePartialSlides(`=== slide new ===\n<section class="slide"><div class="slide-content"><h2>追加页</h2></div></section>`);
        const merged = mergePartialSlides(deck, blocks);
        assert.equal(merged.slideCount, 4);
        assert.deepEqual(merged.applied, ['new']);
        assert.ok(merged.html.includes('追加页'));
        // 追加页在结尾页之后
        assert.ok(merged.html.indexOf('追加页') > merged.html.indexOf('结尾'));
    });

    it('页码越界且无可应用区块时返回 null（触发降级）', () => {
        const deck = buildDeckHtml();
        const blocks = parsePartialSlides(`=== slide 9 ===\n${SLIDE_2}`);
        assert.equal(mergePartialSlides(deck, blocks), null);
    });

    it('端到端：模拟 LLM 输出 → 解析 → 合并 → 写盘文件结果正确', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-chat-'));
        try {
            const file = path.join(dir, 'index.html');
            fs.writeFileSync(file, buildDeckHtml());
            const llmOut = `=== slide 2 ===\n${SLIDE_2.replace('旧标题', '把第2页标题改成这个')}\n---修改说明---\n第 2 页：改标题`;
            const { content } = splitChangeDetails(llmOut);
            const merged = mergePartialSlides(fs.readFileSync(file, 'utf8'), parsePartialSlides(content));
            fs.writeFileSync(file, merged.html);
            const finalHtml = fs.readFileSync(file, 'utf8');
            assert.ok(finalHtml.includes('把第2页标题改成这个'));
            assert.ok(finalHtml.includes('封面'));
            assert.ok(finalHtml.includes('用户手写注释'));
            assert.ok(!finalHtml.includes('修改说明'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('selectRelevantSlides（大 deck 分页）', () => {
    const manySlides = Array.from({ length: 20 }, (_, i) =>
        `<section class="slide"><div class="slide-content"><h2>第${i + 1}页标题</h2><p>${i === 9 ? '营收增长率 32%' : '普通内容' + (i + 1)}</p></div></section>`
    ).join('\n');

    it('不超过阈值时全量返回', () => {
        const r = selectRelevantSlides(`${SLIDE_1}\n${SLIDE_2}`, '改标题');
        assert.equal(r.truncated, false);
        assert.equal(r.slides.length, 2);
        assert.equal(r.total, 2);
    });

    it('超过阈值时按关键词命中 + 前后各 1 页上下文', () => {
        const r = selectRelevantSlides(manySlides, '把营收增长那页的标题改一下');
        assert.equal(r.truncated, true);
        assert.equal(r.total, 20);
        const idx = r.slides.map((s) => s.i);
        assert.ok(idx.includes(10)); // 命中页（营收增长）
        assert.ok(idx.includes(9) && idx.includes(11)); // 前后上下文
        assert.ok(idx.length < 20);
        assert.ok(r.slides.every((s) => s.html.includes('slide')));
    });

    it('显式页码（第N页）直接命中', () => {
        const r = selectRelevantSlides(manySlides, '把第18页删改一下');
        const idx = r.slides.map((s) => s.i);
        assert.ok(idx.includes(18) && idx.includes(17) && idx.includes(19));
    });

    it('阈值常量符合约定', () => {
        assert.equal(PARTIAL_THRESHOLD, 15);
    });
});


// ==================== 任务注册表（scripts/task-registry.mjs） ====================
import {
    createTaskRegistry,
    isActiveStatus,
    isTerminalStatus,
    pushBounded,
    publicTask,
    NDJSON_BUFFER_CAP,
} from '../scripts/task-registry.mjs';

function makeRegistry(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-tasks-'));
    const filePath = path.join(dir, 'tasks.json');
    return { dir, filePath, registry: createTaskRegistry({ filePath, ...extra }) };
}

describe('task-registry', () => {
    it('create/update/complete 生命周期与持久化写入', () => {
        const { dir, filePath, registry } = makeRegistry();
        try {
            registry.create('t1', { kind: 'media', status: 'running' });
            registry.complete('t1', { webPath: '/x.mp4' });
            registry.flush(); // 强制写盘（正常路径为节流写）
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            assert.equal(data.version, 1);
            assert.equal(data.tasks.t1.status, 'done');
            assert.equal(data.tasks.t1.webPath, '/x.mp4');
            assert.ok(data.tasks.t1.createdAt && data.tasks.t1.finishedAt);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('重启加载：running/pending → interrupted，终态保持不变', () => {
        const { dir, filePath, registry } = makeRegistry();
        try {
            registry.create('run1', { kind: 'media', status: 'running' });
            registry.create('pend1', { kind: 'parse', status: 'pending' });
            registry.create('done1', { kind: 'media' });
            registry.complete('done1');
            registry.flush();
            // 模拟服务重启：新实例从同一文件加载
            const restored = createTaskRegistry({ filePath });
            restored.load();
            assert.equal(restored.get('run1').status, 'interrupted');
            assert.equal(restored.get('run1').error, '服务已重启，任务中断，请重试');
            assert.equal(restored.get('pend1').status, 'interrupted');
            assert.equal(restored.get('done1').status, 'done');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('load 对缺失/损坏文件静默降级', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-tasks-'));
        try {
            const missing = createTaskRegistry({ filePath: path.join(dir, 'nope.json') });
            assert.doesNotThrow(() => missing.load());
            const badPath = path.join(dir, 'bad.json');
            fs.writeFileSync(badPath, '{not json');
            const bad = createTaskRegistry({ filePath: badPath });
            assert.doesNotThrow(() => bad.load());
            assert.equal(bad.list().length, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('cancel：活跃态 → cancelled，终态不变，未知 id 返回 null', () => {
        const { dir, registry } = makeRegistry();
        try {
            registry.create('c1', { status: 'running' });
            const cancelled = registry.cancel('c1');
            assert.equal(cancelled.status, 'cancelled');
            assert.ok(cancelled.finishedAt);
            registry.create('c2', { status: 'running' });
            registry.complete('c2');
            assert.equal(registry.cancel('c2').status, 'done'); // 终态不可取消
            assert.equal(registry.cancel('nope'), null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('cancel 后迟到的 complete/fail 被忽略', () => {
        const { dir, registry } = makeRegistry();
        try {
            registry.create('late', { status: 'running' });
            registry.cancel('late');
            registry.complete('late', { webPath: '/x.mp4' });
            registry.fail('late', 'boom');
            assert.equal(registry.get('late').status, 'cancelled');
            assert.equal(registry.get('late').webPath, undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('持久化剥离运行时字段（_ 前缀 / 对象 / 函数）', () => {
        const { dir, filePath, registry } = makeRegistry();
        try {
            const t = registry.create('rt', { status: 'running' });
            t._child = { kill() { } };
            registry.complete('rt');
            registry.flush();
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            assert.equal(data.tasks.rt._child, undefined);
            assert.deepEqual(publicTask(t)._child, undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('过期终态任务按 TTL 清理', () => {
        const { dir, registry } = makeRegistry({ ttlMs: 1000 });
        try {
            registry.create('old', { status: 'done', finishedAt: new Date(Date.now() - 2000).toISOString() });
            registry.create('new', { status: 'running' });
            registry.flush();
            assert.equal(registry.get('old'), undefined);
            assert.ok(registry.get('new'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('pushBounded：buffer 超出上限丢最旧', () => {
        const buf = [];
        for (let i = 0; i < NDJSON_BUFFER_CAP + 50; i++) pushBounded(buf, { i });
        assert.equal(buf.length, NDJSON_BUFFER_CAP);
        assert.equal(buf[0].i, 50); // 最旧 50 条已丢弃
        assert.equal(buf[buf.length - 1].i, NDJSON_BUFFER_CAP + 49);
    });

    it('状态分类辅助函数', () => {
        assert.equal(isActiveStatus('running'), true);
        assert.equal(isActiveStatus('pending'), true);
        assert.equal(isActiveStatus('done'), false);
        assert.equal(isTerminalStatus('done'), true);
        assert.equal(isTerminalStatus('interrupted'), true);
        assert.equal(isTerminalStatus('cancelled'), true);
        assert.equal(isTerminalStatus('running'), false);
    });
});


// ==================== multipart 流式解析器（scripts/multipart.mjs） ====================
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { parseMultipartBoundary, parseMultipartForm } from '../scripts/multipart.mjs';

function buildMultipart(boundary, parts) {
    const chunks = [];
    for (const p of parts) {
        // header 行按 UTF-8 编码（与浏览器发送中文文件名的行为一致）
        chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
        if (p.filename != null) {
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`, 'utf8'));
            chunks.push(Buffer.from(`Content-Type: ${p.mimeType || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
        } else {
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`, 'utf8'));
        }
        chunks.push(p.data);
        chunks.push(Buffer.from('\r\n', 'latin1'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
    return Buffer.concat(chunks);
}

// 把 body 切成固定大小的小块推送，模拟网络分块（含边界跨块场景）
function streamOf(buf, chunkSize = 65536) {
    const parts = [];
    for (let i = 0; i < buf.length; i += chunkSize) parts.push(buf.subarray(i, i + chunkSize));
    return Readable.from(parts.length ? parts : [Buffer.alloc(0)]);
}

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'multipart-test-'));
}

describe('parseMultipartBoundary', () => {
    it('解析带引号与不带引号的 boundary', () => {
        assert.equal(parseMultipartBoundary('multipart/form-data; boundary=abc123'), 'abc123');
        assert.equal(parseMultipartBoundary('multipart/form-data; boundary="a-b c"'), 'a-b c');
        assert.equal(parseMultipartBoundary('Multipart/Form-Data; charset=utf-8; boundary=xyz'), 'xyz');
    });

    it('非 multipart 或缺 boundary 返回 null', () => {
        assert.equal(parseMultipartBoundary('application/json'), null);
        assert.equal(parseMultipartBoundary('multipart/form-data'), null);
        assert.equal(parseMultipartBoundary(''), null);
        assert.equal(parseMultipartBoundary(undefined), null);
    });
});

describe('parseMultipartForm', () => {
    const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    it('解析文本字段 + 文件，文件字节完整落盘', async () => {
        const fileData = Buffer.concat([PNG_HEAD, randomBytes(2048)]);
        const body = buildMultipart('test-boundary-1', [
            { name: 'name', data: Buffer.from('照片 hello.png', 'utf8') },
            { name: 'file', filename: '照片.png', mimeType: 'image/png', data: fileData },
        ]);
        const tmpDir = makeTmpDir();
        try {
            const r = await parseMultipartForm(streamOf(body, 7), { boundary: 'test-boundary-1', tmpDir });
            assert.equal(r.fields.name, '照片 hello.png'); // UTF-8 字段值
            assert.equal(r.files.length, 1);
            assert.equal(r.files[0].filename, '照片.png'); // UTF-8 文件名还原
            assert.equal(r.files[0].fieldName, 'file');
            assert.equal(r.files[0].size, fileData.length);
            assert.deepEqual(fs.readFileSync(r.files[0].tmpPath), fileData);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('边界跨任意分块位置（1 字节步进）', async () => {
        const fileData = Buffer.concat([PNG_HEAD, randomBytes(512)]);
        const body = buildMultipart('XyZ-boundary-longer-one', [
            { name: 'file', filename: 'a.png', data: fileData },
        ]);
        const tmpDir = makeTmpDir();
        try {
            const r = await parseMultipartForm(streamOf(body, 1), { boundary: 'XyZ-boundary-longer-one', tmpDir });
            assert.equal(r.files.length, 1);
            assert.deepEqual(fs.readFileSync(r.files[0].tmpPath), fileData);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('文件超限 → 413 且临时文件被清理', async () => {
        const body = buildMultipart('b2', [
            { name: 'file', filename: 'a.png', data: randomBytes(4096) },
        ]);
        const tmpDir = makeTmpDir();
        try {
            await assert.rejects(
                parseMultipartForm(streamOf(body, 300), { boundary: 'b2', tmpDir, maxFileBytes: 1024 }),
                (e) => e.statusCode === 413 && /大小上限/.test(e.message),
            );
            assert.deepEqual(fs.readdirSync(tmpDir), []); // 临时文件已删除
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('maxFileBytes 回调抛错（如不支持的扩展名）→ 状态码原样传播并清理', async () => {
        const body = buildMultipart('b3', [
            { name: 'file', filename: 'evil.exe', data: randomBytes(64) },
        ]);
        const tmpDir = makeTmpDir();
        try {
            await assert.rejects(
                parseMultipartForm(streamOf(body), {
                    boundary: 'b3', tmpDir,
                    maxFileBytes: () => { const e = new Error('不支持的文件类型'); e.statusCode = 400; throw e; },
                }),
                (e) => e.statusCode === 400 && e.message === '不支持的文件类型',
            );
            assert.deepEqual(fs.readdirSync(tmpDir), []);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('缺少结束边界 → 400 数据不完整', async () => {
        const full = buildMultipart('b4', [
            { name: 'file', filename: 'a.png', data: PNG_HEAD },
        ]);
        const truncated = full.subarray(0, full.length - Buffer.from('--b4--\r\n').length);
        const tmpDir = makeTmpDir();
        try {
            await assert.rejects(
                parseMultipartForm(streamOf(truncated), { boundary: 'b4', tmpDir }),
                (e) => e.statusCode === 400 && /不完整/.test(e.message),
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('boundary 不匹配 → 400', async () => {
        const body = buildMultipart('real-boundary', [
            { name: 'name', data: Buffer.from('x') },
        ]);
        const tmpDir = makeTmpDir();
        try {
            await assert.rejects(
                parseMultipartForm(streamOf(body), { boundary: 'wrong-boundary', tmpDir }),
                (e) => e.statusCode === 400,
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('分隔符后存在非法字节 → 400 格式错误', async () => {
        const body = Buffer.from('--b5\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--b5XX', 'latin1');
        const tmpDir = makeTmpDir();
        try {
            await assert.rejects(
                parseMultipartForm(streamOf(body), { boundary: 'b5', tmpDir }),
                (e) => e.statusCode === 400 && /格式错误/.test(e.message),
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('字段值超 maxFieldBytes → 413', async () => {
        const body = buildMultipart('b6', [
            { name: 'bio', data: randomBytes(2048) },
        ]);
        const tmpDir = makeTmpDir();
        try {
            await assert.rejects(
                parseMultipartForm(streamOf(body, 500), { boundary: 'b6', tmpDir, maxFieldBytes: 1024 }),
                (e) => e.statusCode === 413,
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('缺 boundary 配置 → 400', async () => {
        await assert.rejects(
            parseMultipartForm(streamOf(Buffer.from('x')), { tmpDir: makeTmpDir() }),
            (e) => e.statusCode === 400,
        );
    });
});

// ==================== 笔记历史备份（scripts/vault.mjs） ====================
import {
    isValidBackupTs,
    listNoteBackups,
    readNoteBackup,
    readNoteOrder,
    writeNoteOrder,
} from '../scripts/vault.mjs';

describe('isValidBackupTs', () => {
    it('接受标准备份时间戳格式', () => {
        assert.equal(isValidBackupTs('2026-07-24T17-02-37-704Z'), true);
    });
    it('拒绝非法/路径穿越时间戳', () => {
        assert.equal(isValidBackupTs(''), false);
        assert.equal(isValidBackupTs('../etc'), false);
        assert.equal(isValidBackupTs('2026-07-24'), false);
        assert.equal(isValidBackupTs('2026-07-24T17:02:37.704Z'), false); // 未替换冒号的 ISO
        assert.equal(isValidBackupTs(null), false);
        assert.equal(isValidBackupTs('2026-07-24T17-02-37-704Z/..'), false);
    });
});

describe('listNoteBackups / readNoteBackup', () => {
    const TS_OLD = '2026-07-01T10-00-00-000Z';
    const TS_NEW = '2026-07-02T10-00-00-000Z';

    function makeSnapshotsDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-bk-'));
        fs.mkdirSync(path.join(dir, TS_OLD), { recursive: true });
        fs.mkdirSync(path.join(dir, TS_NEW), { recursive: true });
        fs.writeFileSync(path.join(dir, TS_OLD, 'demo.md'), '旧版本内容');
        fs.writeFileSync(path.join(dir, TS_NEW, 'demo.md'), '新版本内容'.repeat(30)); // 超过 100 字验证截断
        fs.writeFileSync(path.join(dir, TS_NEW, 'other.md'), '别的笔记');
        return dir;
    }

    it('按时间倒序返回该笔记的备份，preview 截断 100 字', () => {
        const dir = makeSnapshotsDir();
        try {
            const backups = listNoteBackups('demo', { snapshotsDir: dir });
            assert.deepEqual(backups.map((b) => b.ts), [TS_NEW, TS_OLD]);
            assert.equal(backups[0].preview.length, 100);
            assert.equal(backups[1].preview, '旧版本内容');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('没有备份 / 目录不存在时返回空数组', () => {
        const dir = makeSnapshotsDir();
        try {
            assert.deepEqual(listNoteBackups('nonexistent', { snapshotsDir: dir }), []);
            assert.deepEqual(listNoteBackups('demo', { snapshotsDir: path.join(dir, 'nope') }), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('readNoteBackup 读取指定时间戳内容；非法 ts 或不存在的备份返回 null', () => {
        const dir = makeSnapshotsDir();
        try {
            assert.equal(readNoteBackup('demo', TS_OLD, { snapshotsDir: dir }), '旧版本内容');
            assert.equal(readNoteBackup('demo', '../..', { snapshotsDir: dir }), null);
            assert.equal(readNoteBackup('demo', '2026-07-03T10-00-00-000Z', { snapshotsDir: dir }), null);
            assert.equal(readNoteBackup('nonexistent', TS_OLD, { snapshotsDir: dir }), null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('readNoteOrder / writeNoteOrder', () => {
    it('写入后读回；去重并过滤非字符串项', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-order-'));
        try {
            const file = path.join(dir, 'note-order.json');
            const clean = writeNoteOrder(['b', 'a', 'b', 42, null, 'c'], { orderFile: file });
            assert.deepEqual(clean, ['b', 'a', 'c']);
            assert.deepEqual(readNoteOrder({ orderFile: file }), ['b', 'a', 'c']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('文件缺失或损坏时返回空数组', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-order-'));
        try {
            const file = path.join(dir, 'note-order.json');
            assert.deepEqual(readNoteOrder({ orderFile: file }), []);
            fs.writeFileSync(file, 'not json');
            assert.deepEqual(readNoteOrder({ orderFile: file }), []);
            fs.writeFileSync(file, '{"order":"x"}');
            assert.deepEqual(readNoteOrder({ orderFile: file }), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ---- design-lint 规则（scripts/design-lint.mjs） ----
import {
    lintHtml,
    selectSlides,
    slideLayoutFingerprint,
    ruleHeroStatOverflow,
    ruleHeadingIssues,
    ruleGradientText,
    ruleEmptySlide,
    ruleKickerOveruse,
    ruleSuspectData,
    ruleLayoutMonotony,
    ruleDenseTable,
    ruleMissingImage,
} from '../scripts/design-lint.mjs';
import { load as cheerioLoad } from 'cheerio';

function lintRule(rule, slidesHtml, ctx = {}) {
    const $ = cheerioLoad(`<main class="stage">${slidesHtml}</main>`);
    return rule($, selectSlides($), ctx);
}

const slide = (inner, cls = '') =>
    `<section class="slide${cls ? ' ' + cls : ''}"><div class="slide-content">${inner}</div></section>`;

describe('design-lint: ruleHeroStatOverflow', () => {
    it('一行 5 个 hero-stat 命中', () => {
        const stats = Array.from({ length: 5 }, (_, i) =>
            `<div class="hero-stat"><div class="big-number">${i}</div><div class="big-number-label">指标${i}</div></div>`).join('');
        const issues = lintRule(ruleHeroStatOverflow, slide(`<h2>数据</h2><div class="split-visual">${stats}</div>`));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'hero-stat-overflow');
        assert.equal(issues[0].severity, 'warning');
        assert.equal(issues[0].page, 1);
    });

    it('一行 4 个 hero-stat 不命中', () => {
        const stats = Array.from({ length: 4 }, (_, i) =>
            `<div class="hero-stat"><div class="big-number">${i}</div></div>`).join('');
        const issues = lintRule(ruleHeroStatOverflow, slide(`<h2>数据</h2><div class="split-visual">${stats}</div>`));
        assert.equal(issues.length, 0);
    });
});

describe('design-lint: ruleHeadingIssues', () => {
    it('缺少 h1/h2 命中 missing-heading', () => {
        const issues = lintRule(ruleHeadingIssues, slide('<p>只有正文没有标题的一段内容</p>'));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'missing-heading');
    });

    it('h2 超过 30 字命中 long-heading', () => {
        const issues = lintRule(ruleHeadingIssues, slide(`<h2>${'很长的标题'.repeat(7)}</h2>`));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'long-heading');
    });

    it('正常长度标题不命中', () => {
        const issues = lintRule(ruleHeadingIssues, slide('<h2>季度销售回顾</h2><p>内容</p>'));
        assert.equal(issues.length, 0);
    });
});

describe('design-lint: ruleGradientText', () => {
    it('gradient-text 类命中', () => {
        const issues = lintRule(ruleGradientText, slide('<h1 class="gradient-text">标题</h1>'));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'gradient-text');
    });

    it('无 gradient-text 不命中', () => {
        const issues = lintRule(ruleGradientText, slide('<h1>标题</h1>'));
        assert.equal(issues.length, 0);
    });

    it('lintHtml fix=true 自动移除该类并标记 autoFixed', () => {
        const html = `<main class="stage">${slide('<h1 class="gradient-text">标题</h1>')}</main>`;
        const { issues, html: fixed, fixedCount } = lintHtml(html, { fix: true });
        assert.equal(fixedCount, 1);
        assert.equal(issues.find((i) => i.rule === 'gradient-text').autoFixed, true);
        assert.ok(!fixed.includes('gradient-text'));
        assert.ok(fixed.includes('<h1>标题</h1>'));
    });

    it('lintHtml fix=false 时不修改 html', () => {
        const html = `<main class="stage">${slide('<h1 class="gradient-text">标题</h1>')}</main>`;
        const { html: fixed, fixedCount } = lintHtml(html, { fix: false });
        assert.equal(fixedCount, 0);
        assert.equal(fixed, html);
    });
});

describe('design-lint: ruleEmptySlide', () => {
    it('空 slide 命中（error）', () => {
        const issues = lintRule(ruleEmptySlide, slide(''));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'empty-slide');
        assert.equal(issues[0].severity, 'error');
    });

    it('有内容的 slide 不命中', () => {
        const issues = lintRule(ruleEmptySlide, slide('<h2>标题</h2><p>这是一段有实质内容的正文文字</p>'));
        assert.equal(issues.length, 0);
    });
});

describe('design-lint: ruleKickerOveruse', () => {
    it('一页 2 个 kicker/section-title 命中', () => {
        const issues = lintRule(ruleKickerOveruse,
            slide('<div class="kicker">A</div><div class="section-title">B</div><h2>标题</h2>'));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'kicker-overuse');
    });

    it('一页 1 个 kicker 不命中', () => {
        const issues = lintRule(ruleKickerOveruse, slide('<div class="kicker">A</div><h2>标题</h2>'));
        assert.equal(issues.length, 0);
    });
});

describe('design-lint: ruleSuspectData', () => {
    it('lorem / XX% 占位命中（info）', () => {
        const issues = lintRule(ruleSuspectData, slide('<h2>标题</h2><p>lorem ipsum 增长约 XX%，收入 XXX 万</p>'));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'suspect-data');
        assert.equal(issues[0].severity, 'info');
    });

    it('真实数据文案不命中', () => {
        const issues = lintRule(ruleSuspectData, slide('<h2>标题</h2><p>三季度销售额增长 23.5%，达到 1.2 亿元</p>'));
        assert.equal(issues.length, 0);
    });
});

describe('design-lint: ruleLayoutMonotony', () => {
    it('连续 3 页同一版式命中（info）', () => {
        const same = () => slide('<div class="section-title">T</div><h2>标题</h2><p>正文内容</p>');
        const issues = lintRule(ruleLayoutMonotony, same() + same() + same());
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'layout-monotony');
        assert.equal(issues[0].severity, 'info');
    });

    it('版式轮换不命中', () => {
        const a = slide('<h2>标题一</h2><p>正文</p>');
        const b = slide('<h2>标题二</h2><div class="tile-row"><div class="tile">卡</div></div>');
        const c = slide('<h2>标题三</h2><table class="ppt-table"><tbody><tr><td>1</td></tr></tbody></table>');
        const issues = lintRule(ruleLayoutMonotony, a + b + c);
        assert.equal(issues.length, 0);
    });

    it('slideLayoutFingerprint 忽略 active 类差异', () => {
        const $ = cheerioLoad(`<main class="stage">${slide('<h2>标题</h2>', 'active')}${slide('<h2>标题</h2>')}</main>`);
        const slides = selectSlides($);
        assert.equal(slideLayoutFingerprint($, slides[0]), slideLayoutFingerprint($, slides[1]));
    });
});

describe('design-lint: ruleDenseTable', () => {
    it('7 行表格命中', () => {
        const rows = Array.from({ length: 7 }, () => '<tr><td>a</td><td>b</td></tr>').join('');
        const issues = lintRule(ruleDenseTable,
            slide(`<h2>表</h2><table class="ppt-table"><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody>${rows}</tbody></table>`));
        assert.equal(issues.length, 1);
        assert.equal(issues[0].rule, 'dense-table');
    });

    it('5 列表格命中', () => {
        const issues = lintRule(ruleDenseTable,
            slide('<h2>表</h2><table class="ppt-table"><tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr></tbody></table>'));
        assert.equal(issues.length, 1);
    });

    it('6 行 4 列表格不命中', () => {
        const rows = Array.from({ length: 6 }, () => '<tr><td>a</td><td>b</td><td>c</td><td>d</td></tr>').join('');
        const issues = lintRule(ruleDenseTable, slide(`<h2>表</h2><table class="ppt-table"><tbody>${rows}</tbody></table>`));
        assert.equal(issues.length, 0);
    });
});

describe('design-lint: ruleMissingImage', () => {
    it('引用不存在的本地图片命中（error）', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-lint-'));
        try {
            const issues = lintRule(ruleMissingImage,
                slide('<h2>图</h2><img src="assets/nope.png">'), { projectDir: dir });
            assert.equal(issues.length, 1);
            assert.equal(issues[0].rule, 'missing-image');
            assert.equal(issues[0].severity, 'error');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('存在的本地图片与远程图片不命中', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-lint-'));
        try {
            fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), 'x');
            const issues = lintRule(ruleMissingImage,
                slide('<h2>图</h2><img src="assets/ok.png"><img src="https://example.com/a.png"><img src="data:image/png;base64,xx">'),
                { projectDir: dir });
            assert.equal(issues.length, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ---- SVG 图表渲染器（ai-ppt-base/js/ppt.js 纯函数，浏览器 IIFE + Node module.exports 双模式）----
import charts from '../ai-ppt-base/js/ppt.js';
const { renderChart, renderLineChart, renderPieChart, renderBarsChart } = charts;

describe('renderLineChart（折线/面积图）', () => {
    const cfg = {
        labels: ['Q1', 'Q2', 'Q3', 'Q4'],
        series: [
            { name: '客户数', data: [120, 180, 260, 320] },
            { name: '活跃数', data: [80, 110, 150, 200] },
        ],
    };

    it('生成静态 SVG：每序列一条折线 + 坐标网格 + 标签', () => {
        const svg = renderLineChart(cfg);
        assert.ok(svg.startsWith('<svg class="chart-svg chart-svg-line"'));
        assert.ok(svg.endsWith('</svg>'));
        assert.ok(svg.includes('viewBox="0 0 640 360"'));
        // 2 条折线 path（无 area）
        assert.equal((svg.match(/<path /g) || []).length, 2);
        // 网格线 5 条 + 基线 1 条
        assert.ok((svg.match(/class="chart-grid"/g) || []).length >= 5);
        // x 轴标签齐全
        for (const l of cfg.labels) assert.ok(svg.includes(`>${l}<`));
        // 无 NaN/undefined 坐标
        assert.ok(!/NaN|undefined/.test(svg));
    });

    it('多序列自动生成图例，单序列不出图例', () => {
        const multi = renderLineChart(cfg);
        assert.ok((multi.match(/chart-legend-text/g) || []).length >= 2);
        const single = renderLineChart({ labels: cfg.labels, series: [cfg.series[0]] });
        assert.ok(!single.includes('chart-legend-text'));
    });

    it('area/valueLabels/points 选项生效', () => {
        const svg = renderLineChart({ ...cfg, area: true, valueLabels: true });
        assert.ok(svg.includes('fill-opacity:0.12'));
        assert.ok(svg.includes('>320<'));
        const noPoints = renderLineChart({ ...cfg, points: false });
        assert.ok(!noPoints.includes('<circle'));
    });

    it('数据为空或非法时返回空字符串', () => {
        assert.equal(renderLineChart({}), '');
        assert.equal(renderLineChart({ labels: [], series: [{ name: 'a', data: [1] }] }), '');
        assert.equal(renderLineChart({ labels: ['Q1'], series: [{ name: 'a', data: [] }] }), '');
    });
});

describe('renderPieChart（饼/环图）', () => {
    const cfg = { labels: ['薪酬', '考勤', '招聘', '其他'], data: [45, 25, 20, 10] };

    it('生成切片 + 占比标签 + 图例，占比总和 100%', () => {
        const svg = renderPieChart(cfg);
        assert.ok(svg.startsWith('<svg class="chart-svg chart-svg-pie"'));
        assert.equal((svg.match(/<path /g) || []).length, 4);
        const pcts = [...svg.matchAll(/class="chart-pct">(\d+)%</g)].map((m) => Number(m[1]));
        assert.equal(pcts.length, 4);
        assert.equal(pcts.reduce((a, b) => a + b, 0), 100);
        for (const l of cfg.labels) assert.ok(svg.includes(`>${l}<`));
        assert.ok(!/NaN|undefined/.test(svg));
    });

    it('donut 渲染内圈路径，centerLabel 输出环心文字', () => {
        const svg = renderPieChart({ ...cfg, donut: true, centerLabel: '构成' });
        assert.ok(svg.includes('>构成<'));
        // 环图切片路径含内圈反向弧（A innerR innerR ... 0）
        assert.ok(/A 66 66 0 \d 0/.test(svg));
    });

    it('接受 series[0].data 形式，过滤非正数值', () => {
        const svg = renderPieChart({ labels: ['a', 'b', 'c'], series: [{ name: 'x', data: [10, 0, 30] }] });
        assert.equal((svg.match(/<path /g) || []).length, 2);
        assert.ok(!/NaN|undefined/.test(svg));
    });

    it('数据为空时返回空字符串', () => {
        assert.equal(renderPieChart({}), '');
        assert.equal(renderPieChart({ labels: ['a'], data: [0] }), '');
    });
});

describe('renderBarsChart（分组/堆叠柱状图）', () => {
    const cfg = {
        labels: ['Q1', 'Q2', 'Q3', 'Q4'],
        series: [
            { name: '2024', data: [45, 58, 72, 85] },
            { name: '2025', data: [52, 66, 81, 97] },
        ],
    };

    it('分组柱：labels × series 根柱 + 柱顶数值 + 图例', () => {
        const svg = renderBarsChart(cfg);
        assert.ok(svg.startsWith('<svg class="chart-svg chart-svg-bars"'));
        // 8 根柱 + 2 个图例色块
        assert.equal((svg.match(/<rect /g) || []).length, 8 + 2);
        assert.ok(svg.includes('>97<'));
        assert.ok(!/NaN|undefined/.test(svg));
    });

    it('堆叠柱：每标签一根多段柱，柱顶显示合计', () => {
        const svg = renderBarsChart({ ...cfg, stacked: true });
        // 8 段 + 2 个图例色块
        assert.equal((svg.match(/<rect /g) || []).length, 8 + 2);
        // Q4 合计 85+97=182
        assert.ok(svg.includes('>182<'));
    });

    it('valueLabels:false 关闭柱顶数值', () => {
        const svg = renderBarsChart({ labels: ['Q1'], series: [{ name: 'a', data: [42] }], valueLabels: false });
        // 柱顶数值用 chart-value 类；关闭后应一个都没有（y 轴刻度是 chart-tick）
        assert.ok(!svg.includes('chart-value'));
    });

    it('数据为空时返回空字符串', () => {
        assert.equal(renderBarsChart({}), '');
        assert.equal(renderBarsChart({ labels: ['Q1'], series: [] }), '');
    });
});

describe('renderChart（类型分发）', () => {
    it('按类型分发，未知类型返回空字符串', () => {
        const cfg = { labels: ['Q1', 'Q2'], series: [{ name: 'a', data: [1, 2] }] };
        assert.ok(renderChart('line', cfg).includes('chart-svg-line'));
        assert.ok(renderChart('bars', cfg).includes('chart-svg-bars'));
        assert.ok(renderChart('pie', { labels: ['a'], data: [1] }).includes('chart-svg-pie'));
        assert.equal(renderChart('unknown', cfg), '');
    });
});


// ---- export-video.mjs 纯函数 ----
import {
    extractSlideTexts,
    computeDurations,
    buildConcatList,
    buildFfmpegArgs,
    DEFAULT_SLIDE_DURATION,
} from '../scripts/export-video.mjs';

describe('extractSlideTexts（视频旁白文本提取）', () => {
    const html = `<main class="stage">
        <section class="slide"><div class="slide-content"><h1>标题一</h1><ul><li>要点A</li><li>要点B</li></ul></div></section>
        <section class="slide"><div class="slide-content"><h2>标题二</h2><div class="speaker-note">这是演讲备注</div><ul><li>要点C</li></ul></div></section>
        <section class="slide"><div class="slide-content"><p>没有标题也没有备注</p></div></section>
    </main>`;

    it('.speaker-note 优先于标题与要点', () => {
        const texts = extractSlideTexts(html);
        assert.equal(texts.length, 3);
        assert.equal(texts[1], '这是演讲备注');
    });

    it('无备注时取标题 + 要点', () => {
        const texts = extractSlideTexts(html);
        assert.equal(texts[0], '标题一。要点A。要点B');
    });

    it('无标题无备注返回空串；无幻灯片返回空数组', () => {
        assert.equal(extractSlideTexts(html)[2], '');
        assert.deepEqual(extractSlideTexts('<main class="stage"></main>'), []);
    });
});

describe('computeDurations（每页时长）', () => {
    it('标量填充 count 项', () => {
        assert.deepEqual(computeDurations(3, 5), [5, 5, 5]);
    });

    it('默认 4 秒；非法值回退默认', () => {
        assert.deepEqual(computeDurations(2), [DEFAULT_SLIDE_DURATION, DEFAULT_SLIDE_DURATION]);
        assert.deepEqual(computeDurations(2, -1), [DEFAULT_SLIDE_DURATION, DEFAULT_SLIDE_DURATION]);
        assert.deepEqual(computeDurations(2, NaN), [DEFAULT_SLIDE_DURATION, DEFAULT_SLIDE_DURATION]);
    });

    it('数组按 count 截断 / 以末值补齐', () => {
        assert.deepEqual(computeDurations(2, [3, 6, 9]), [3, 6]);
        assert.deepEqual(computeDurations(4, [3, 6]), [3, 6, 6, 6]);
    });

    it('count <= 0 返回空数组', () => {
        assert.deepEqual(computeDurations(0, 4), []);
    });
});

describe('buildConcatList（ffmpeg concat 清单）', () => {
    it('每帧 file + duration，末帧追加无 duration 的 file', () => {
        const list = buildConcatList(['/tmp/a.png', '/tmp/b.png'], [4, 6]);
        const lines = list.trim().split('\n');
        assert.deepEqual(lines, [
            "file '/tmp/a.png'", 'duration 4',
            "file '/tmp/b.png'", 'duration 6',
            "file '/tmp/b.png'",
        ]);
    });

    it('空帧列表只有结尾换行', () => {
        assert.equal(buildConcatList([], []), '\n');
    });
});

describe('buildFfmpegArgs（ffmpeg 参数构造）', () => {
    it('concat 输入 + fps/yuv420p + libx264 + 输出文件结尾', () => {
        const args = buildFfmpegArgs({ concatFile: '/tmp/concat.txt', fps: 24, outFile: '/tmp/out.mp4' });
        assert.deepEqual(args.slice(0, 6), ['-y', '-f', 'concat', '-safe', '0', '-i']);
        assert.equal(args[6], '/tmp/concat.txt');
        assert.ok(args.includes('fps=24,format=yuv420p'));
        assert.ok(args.includes('libx264'));
        assert.equal(args[args.length - 1], '/tmp/out.mp4');
    });

    it('默认 30fps', () => {
        const args = buildFfmpegArgs({ concatFile: 'c.txt', outFile: 'o.mp4' });
        assert.ok(args.includes('fps=30,format=yuv420p'));
    });

    it('seconds 追加 -t 裁剪末帧重复条目多出的时长，缺省/非法值不加', () => {
        const withT = buildFfmpegArgs({ concatFile: 'c.txt', outFile: 'o.mp4', seconds: 52 });
        const tIdx = withT.indexOf('-t');
        assert.ok(tIdx > 0);
        assert.equal(withT[tIdx + 1], '52');
        assert.equal(withT[withT.length - 1], 'o.mp4');
        assert.ok(!buildFfmpegArgs({ concatFile: 'c.txt', outFile: 'o.mp4' }).includes('-t'));
        assert.ok(!buildFfmpegArgs({ concatFile: 'c.txt', outFile: 'o.mp4', seconds: NaN }).includes('-t'));
        assert.ok(!buildFfmpegArgs({ concatFile: 'c.txt', outFile: 'o.mp4', seconds: -1 }).includes('-t'));
    });
});

// ---- insertImageIntoDeck / isVideoAsset（POST /api/projects/:name/insert-image 的 DOM 合并纯函数） ----
import { insertImageIntoDeck, isVideoAsset } from '../scripts/insert-image.mjs';

describe('isVideoAsset', () => {
    it('按扩展名识别视频资产', () => {
        assert.ok(isVideoAsset('a.mp4'));
        assert.ok(isVideoAsset('B.WEBM'));
        assert.ok(!isVideoAsset('a.png'));
        assert.ok(!isVideoAsset('noext'));
        assert.ok(!isVideoAsset(''));
    });
});

describe('insertImageIntoDeck', () => {
    const deckHtml = `<!doctype html><html><body><main class="stage">
<section class="slide active"><div class="slide-content"><h2>封面</h2></div></section>
<section class="slide"><div class="slide-content"><h2>内容页</h2></div></section>
<section class="slide"><div class="slide-content"><h2>结尾</h2></div></section>
</main></body></html>`;

    it('默认在末页前新建图片页（new-slide），标题取传入 title', () => {
        const r = insertImageIntoDeck(deckHtml, { src: 'assets/pic.png', title: '扁平风格增长曲线插图' });
        assert.equal(r.mode, 'new-slide');
        assert.equal(r.slide, 3); // 新页成为第 3 页（原末页之前）
        const $ = cheerioLoad(r.html);
        const slides = $('main.stage section.slide');
        assert.equal(slides.length, 4);
        const inserted = $(slides[2]);
        assert.equal(inserted.find('h2').text(), '扁平风格增长曲线插图');
        assert.equal(inserted.find('img').attr('src'), 'assets/pic.png');
        assert.equal($(slides[3]).find('h2').text(), '结尾');
        // 单 active：合并后仅首页 active
        assert.equal($('main.stage section.slide.active').length, 1);
        assert.ok($(slides[0]).hasClass('active'));
    });

    it('无 title 时使用默认标题「AI 配图」', () => {
        const r = insertImageIntoDeck(deckHtml, { src: 'assets/pic.png' });
        const $ = cheerioLoad(r.html);
        assert.equal($('main.stage section.slide').eq(2).find('h2').text(), 'AI 配图');
    });

    it('指定页（1-based）把 img 追加进该页 .slide-content（append）', () => {
        const r = insertImageIntoDeck(deckHtml, { src: 'assets/pic.png', title: 't', slide: 2 });
        assert.equal(r.mode, 'append');
        assert.equal(r.slide, 2);
        const $ = cheerioLoad(r.html);
        assert.equal($('main.stage section.slide').length, 3); // 不新增页
        const second = $('main.stage section.slide').eq(1);
        assert.equal(second.find('.slide-content img').attr('src'), 'assets/pic.png');
        assert.ok(second.find('.slide-content .visual-card').length > 0);
    });

    it('视频资产生成 <video> 标签', () => {
        const r = insertImageIntoDeck(deckHtml, { src: 'assets/clip.mp4', title: 'v' });
        const $ = cheerioLoad(r.html);
        assert.equal($('main.stage section.slide').eq(2).find('video').attr('src'), 'assets/clip.mp4');
    });

    it('页码越界 / 缺 src / 无幻灯片结构时抛错', () => {
        assert.throws(() => insertImageIntoDeck(deckHtml, { src: 'a.png', slide: 0 }), /页码超出范围/);
        assert.throws(() => insertImageIntoDeck(deckHtml, { src: 'a.png', slide: 4 }), /页码超出范围/);
        assert.throws(() => insertImageIntoDeck(deckHtml, {}), /缺少媒体地址/);
        assert.throws(() => insertImageIntoDeck('<html><body></body></html>', { src: 'a.png' }), /未找到幻灯片结构/);
    });

    it('title 中的 HTML 特殊字符被转义', () => {
        const r = insertImageIntoDeck(deckHtml, { src: 'assets/pic.png', title: '<b>x</b>' });
        const $ = cheerioLoad(r.html);
        assert.equal($('main.stage section.slide').eq(2).find('h2').text(), '<b>x</b>');
        assert.ok(!r.html.includes('<h2><b>x</b></h2>'));
    });
});

// ---- findAssetReferences（DELETE /api/vault/assets/:name 的 409 引用保护核心） ----
import { contentReferencesAsset, findAssetReferences } from '../scripts/asset-refs.mjs';

describe('contentReferencesAsset', () => {
    it('正文含 ![[name]] 视为引用', () => {
        assert.ok(contentReferencesAsset('文字\n![[a.png]]\n更多', 'a.png'));
        assert.ok(!contentReferencesAsset('![[a.png]]', 'b.png'));
        assert.ok(!contentReferencesAsset(null, 'a.png'));
    });

    it('普通 wikilink [[name]] 不算引用', () => {
        assert.ok(!contentReferencesAsset('[[a.png]]', 'a.png'));
    });
});

describe('findAssetReferences', () => {
    it('分别汇总笔记与碎片引用方', () => {
        const refs = findAssetReferences('a.png', {
            notes: [{ name: '笔记一', content: '![[a.png]]' }, { name: '笔记二', content: '无引用' }],
            fragments: [{ id: 'f-1', content: 'x ![[a.png]]' }, { id: 'f-2', content: null }],
        });
        assert.deepEqual(refs, { notes: ['笔记一'], fragments: ['f-1'] });
    });

    it('无引用时返回空列表（删除应直接 204）', () => {
        const refs = findAssetReferences('a.png', { notes: [{ name: 'n', content: 'text' }] });
        assert.deepEqual(refs, { notes: [], fragments: [] });
    });
});

// ---- cleanupOrphanTmpParts（服务启动清理 vault/assets/.tmp 孤儿 .part） ----
import { cleanupOrphanTmpParts } from '../scripts/multipart.mjs';

describe('cleanupOrphanTmpParts', () => {
    it('只删除 .part 文件并返回数量', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ppt-tmp-clean-'));
        try {
            fs.writeFileSync(path.join(dir, 'upload-a.part'), 'x');
            fs.writeFileSync(path.join(dir, 'upload-b.part'), 'x');
            fs.writeFileSync(path.join(dir, 'keep.png'), 'x');
            const removed = cleanupOrphanTmpParts(dir);
            assert.equal(removed, 2);
            assert.deepEqual(fs.readdirSync(dir), ['keep.png']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('目录不存在时返回 0 不抛错', () => {
        assert.equal(cleanupOrphanTmpParts(path.join(os.tmpdir(), 'ai-ppt-no-such-dir-xyz')), 0);
    });
});

// ---- createProject 场景模板（templates/<id>/ → projects/<name>/） ----
import { createProject, deleteProject, listTemplates, readConfig, getProjectDir } from '../scripts/config.mjs';

describe('listTemplates', () => {
    it('返回仓库内置的 4 个场景模板', () => {
        const tpls = listTemplates();
        for (const id of ['weekly-report', 'training-course', 'pitch', 'review-lesson']) {
            assert.ok(tpls.includes(id), `缺少模板 ${id}`);
        }
    });
});

describe('createProject(template)', () => {
    const name = `test-tpl-${Date.now().toString(36)}`;

    it('从模板创建：复制模板 index.html 与 ai-ppt.json，并注入基座引擎', () => {
        try {
            const cfg = createProject(name, '我的周报', 'weekly-report');
            const dir = getProjectDir(name);
            const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
            assert.ok(html.includes('本周进展'), '模板幻灯片内容应保留');
            assert.ok(fs.existsSync(path.join(dir, 'css', 'ppt.css')), '基座引擎 css 应已注入');
            assert.ok(fs.existsSync(path.join(dir, 'js', 'ppt.js')), '基座引擎 js 应已注入');
            assert.equal(cfg.name, name, '配置 name 应改为新项目名');
            assert.equal(cfg.params.title, '我的周报', '传入 title 应覆盖模板默认标题');
            assert.equal(cfg.template, 'weekly-report');
            // readConfig 回读一致
            assert.equal(readConfig(name).name, name);
        } finally {
            deleteProject(name);
        }
    });

    it('不传 title 时保留模板默认标题', () => {
        const n2 = `${name}-b`;
        try {
            const cfg = createProject(n2, '', 'pitch');
            assert.equal(cfg.params.title, '项目路演');
        } finally {
            deleteProject(n2);
        }
    });

    it('非法或不存在的模板 id 抛错，且不残留项目目录', () => {
        for (const bad of ['../etc', 'no-such-template', 'a/b']) {
            const n3 = `${name}-c`;
            assert.throws(() => createProject(n3, '', bad));
            assert.ok(!fs.existsSync(getProjectDir(n3)), `模板 ${bad} 不应残留目录`);
        }
    });

    it('不传 template 时行为不变（ starter 三页）', () => {
        const n4 = `${name}-d`;
        try {
            createProject(n4, '空白项目');
            const html = fs.readFileSync(path.join(getProjectDir(n4), 'index.html'), 'utf8');
            assert.ok(html.includes('关于本项目'), '应为默认 starter 内容');
        } finally {
            deleteProject(n4);
        }
    });
});
