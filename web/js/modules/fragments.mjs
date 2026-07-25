// web/js/modules/fragments.mjs — 速记碎片 + AI 整理
import { S } from './state.mjs';
import { api, apiUpload, showToast, escapeHtml, escapeHtmlAttr } from './state.mjs';
import { showConfirmModal } from './modals.mjs';
import { t } from './i18n.mjs';

let _cb = {};
export function initFragmentsModule(callbacks) {
    _cb = callbacks; // { switchSidebarTab, showTagsPanel, appendFragmentToToday }
}

// ============================================================
// 辅助
// ============================================================
function relativeTime(iso) {
    const ts = new Date(iso).getTime();
    if (!ts) return '';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return t('刚刚');
    if (m < 60) return t('{m} 分钟前', { m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('{h} 小时前', { h });
    const d = Math.floor(h / 24);
    if (d < 7) return t('{d} 天前', { d });
    return new Date(iso).toLocaleDateString();
}

// ============================================================
// 碎片 CRUD
// ============================================================
export async function loadFragments() {
    try {
        const qs = S.fragmentFilter === 'all' ? '' : `?status=${encodeURIComponent(S.fragmentFilter)}`;
        const data = await api('GET', `/api/vault/fragments${qs}`);
        S.fragments = data.fragments || [];
        renderFragments();
        updateOrganizeButton();
    } catch (e) { console.error('Failed to load fragments:', e); showToast(t('加载速记列表失败')); }
}

// 附件文件名白名单（渲染端防注入，与服务端落盘命名规则一致）
const SAFE_ASSET_NAME = /^[\w.\-()（）一-龥 ]+$/;
const FRAGMENT_MEDIA_KINDS = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    video: ['mp4', 'webm', 'mov'],
    audio: ['mp3', 'wav', 'm4a', 'ogg'],
    doc: ['pdf', 'docx']
};

// 渲染碎片正文：先整体 escapeHtml，再把转义后的 ![[name.ext]] token 替换为媒体元素
function renderFragmentContent(content) {
    let html = escapeHtml(content);
    html = html.replace(/!\[\[([^\[\]\n]+?\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|m4a|ogg|pdf|docx))\]\]/gi, (m, name, ext) => {
        // token 取自转义后文本；含 & 等特殊字符的名字不渲染为媒体，原样保留文本
        if (!SAFE_ASSET_NAME.test(name)) return m;
        const e = String(ext).toLowerCase();
        const url = escapeHtmlAttr(`/api/vault/assets/${encodeURIComponent(name)}`);
        const label = escapeHtml(name);
        if (FRAGMENT_MEDIA_KINDS.image.includes(e)) {
            return `<a href="${url}" target="_blank" rel="noopener"><img class="fragment-media-img" src="${url}" loading="lazy" alt="${escapeHtmlAttr(name)}"></a>`;
        }
        // 语音听记录音（voice-*.webm）以音频播放器渲染
        if (FRAGMENT_MEDIA_KINDS.audio.includes(e) || (FRAGMENT_MEDIA_KINDS.video.includes(e) && /^voice-/i.test(name))) {
            return `<audio class="fragment-media-audio" src="${url}" controls></audio>`;
        }
        if (FRAGMENT_MEDIA_KINDS.video.includes(e)) {
            return `<video class="fragment-media-video" src="${url}" controls preload="metadata"></video>`;
        }
        return `<a class="fragment-media-file" href="${url}" target="_blank" rel="noopener">📄 ${label}</a>`;
    });
    return html;
}

function renderFragments() {
    const listEl = document.getElementById('fragment-list');
    if (!listEl) return;
    if (S.fragments.length === 0) { listEl.innerHTML = `<div style="padding:20px;text-align:center;opacity:0.6;font-size:13px;">${t('暂无碎片，在上方记录第一条吧')}</div>`; return; }
    listEl.innerHTML = S.fragments.map((f) => {
        const organized = f.status === 'organized';
        const hasAttach = /!\[\[[^\]]+\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|m4a|ogg|pdf|docx)\]\]/i.test(f.content || '');
        const tags = (f.tags || []).map((t) => `<span class="fragment-tag" data-tag="${escapeHtmlAttr(t)}">${escapeHtml(t)}</span>`).join('');
        return `<div class="fragment-item ${organized ? 'fragment-organized' : ''}" data-id="${escapeHtmlAttr(f.id)}">
        <div class="fragment-content">${renderFragmentContent(f.content)}</div>
        <div class="fragment-meta">${tags}<span class="fragment-time">${escapeHtml(relativeTime(f.created))}</span>${organized ? `<span class="fragment-organized-badge">${t('已整理')}</span>` : ''}</div>
        <div class="fragment-actions">
          <button class="btn-secondary fragment-action" data-action="promote" data-to="card" ${organized ? 'disabled' : ''}>${t('转卡片')}</button>
          <button class="btn-secondary fragment-action" data-action="promote" data-to="note" ${organized ? 'disabled' : ''}>${t('转笔记')}</button>
          <button class="btn-secondary fragment-action" data-action="promote" data-to="mistake" ${organized ? 'disabled' : ''}>${t('转错题')}</button>
          <button class="btn-secondary fragment-action" data-action="today" ${organized ? 'disabled' : ''}>${t('到今日')}</button>
          ${hasAttach ? `<button class="btn-secondary fragment-action" data-action="reparse">${t('重新解析')}</button>` : ''}
          <button class="btn-secondary fragment-action fragment-delete" data-action="delete">${t('删除')}</button>
        </div></div>`;
    }).join('');
}

// ============================================================
// 附件（粘贴 / 拖放 / 文件选择 → chips → 上传）
// ============================================================
const ATTACH_LIMITS = { image: 10 * 1024 * 1024, doc: 20 * 1024 * 1024, audio: 80 * 1024 * 1024, video: 80 * 1024 * 1024 };
const ATTACH_LIMIT_LABEL = { image: '10MB', doc: '20MB', audio: '80MB', video: '80MB' };
let pendingAttachments = [];
let _attachSeq = 0;

function classifyAttachment(file) {
    const ext = (String(file.name || '').split('.').pop() || '').toLowerCase();
    const mime = String(file.type || '');
    if (FRAGMENT_MEDIA_KINDS.image.includes(ext) || mime.startsWith('image/')) return 'image';
    if (FRAGMENT_MEDIA_KINDS.doc.includes(ext)) return 'doc';
    if (FRAGMENT_MEDIA_KINDS.audio.includes(ext) || mime.startsWith('audio/')) return 'audio';
    if (FRAGMENT_MEDIA_KINDS.video.includes(ext) || mime.startsWith('video/')) return 'video';
    return null;
}

function addAttachmentFiles(files) {
    let added = false;
    for (const file of files) {
        if (!file) continue;
        const kind = classifyAttachment(file);
        if (!kind) { showToast(t('不支持的附件类型：{name}', { name: file.name || t('未命名文件') }), 'error'); continue; }
        if (file.size > ATTACH_LIMITS[kind]) {
            showToast(t('附件超过 {limit} 限制，已跳过：{name}', { limit: ATTACH_LIMIT_LABEL[kind], name: file.name || t('未命名文件') }), 'error');
            continue;
        }
        let name = String(file.name || '').trim();
        if (!name) {
            // 截图粘贴等场景文件名为空，补一个默认名
            const ext = kind === 'image' ? 'png'
                : (String(file.type || '').split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
            name = `pasted-${Date.now()}.${ext}`;
        }
        pendingAttachments.push({
            id: ++_attachSeq,
            file,
            name,
            kind,
            objectUrl: kind === 'image' ? URL.createObjectURL(file) : null
        });
        added = true;
    }
    if (added) renderAttachmentChips();
}

function removeAttachment(id) {
    const i = pendingAttachments.findIndex((a) => a.id === id);
    if (i < 0) return;
    if (pendingAttachments[i].objectUrl) URL.revokeObjectURL(pendingAttachments[i].objectUrl);
    pendingAttachments.splice(i, 1);
    renderAttachmentChips();
}

function clearAttachments() {
    for (const att of pendingAttachments) {
        if (att.objectUrl) URL.revokeObjectURL(att.objectUrl);
    }
    pendingAttachments = [];
    renderAttachmentChips();
}

function renderAttachmentChips() {
    const box = document.getElementById('fragment-attachments');
    if (!box) return;
    box.innerHTML = '';
    box.classList.toggle('hidden', pendingAttachments.length === 0);
    const icons = { doc: '📄', audio: '🎵', video: '🎬' };
    for (const att of pendingAttachments) {
        const chip = document.createElement('div');
        chip.className = 'fragment-attach-chip';
        if (att.kind === 'image' && att.objectUrl) {
            const img = document.createElement('img');
            img.className = 'fragment-attach-thumb';
            img.src = att.objectUrl;
            img.alt = att.name;
            chip.appendChild(img);
        } else {
            const icon = document.createElement('span');
            icon.className = 'fragment-attach-icon';
            icon.textContent = icons[att.kind] || '📎';
            chip.appendChild(icon);
        }
        const label = document.createElement('span');
        label.className = 'fragment-attach-name';
        label.textContent = att.name;
        label.title = att.name;
        chip.appendChild(label);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'fragment-attach-remove';
        rm.textContent = '✕';
        rm.title = t('移除附件');
        rm.addEventListener('click', () => removeAttachment(att.id));
        chip.appendChild(rm);
        box.appendChild(chip);
    }
}

// 附件上传走 multipart 流式（不再 base64 转 JSON，大文件内存友好）；语音听记 Blob 复用此路径
async function uploadAttachment(att) {
    try {
        const fd = new FormData();
        fd.append('name', att.name);
        fd.append('file', att.file, att.name);
        const data = await apiUpload('/api/vault/assets', fd);
        return { name: data.name || att.name, kind: data.kind || att.kind };
    } catch (e) {
        console.error('Failed to upload attachment:', e);
        showToast(t('附件上传失败，已跳过：{name}', { name: att.name }), 'error');
        return null;
    }
}

// 轮询附件 AI 解析任务（每 2s，最多 5 分钟），全部结束后刷新碎片列表
function pollParseTasks(taskIds) {
    const pending = new Set(taskIds);
    const startedAt = Date.now();
    let interrupted = false;
    const timer = setInterval(async () => {
        for (const id of [...pending]) {
            try {
                const t = await api('GET', `/api/vault/assets/parse-tasks/${encodeURIComponent(id)}`);
                if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') pending.delete(id);
                else if (t.status === 'interrupted') { pending.delete(id); interrupted = true; }
            } catch (e) {
                // 任务未知（如服务重启后注册表之外的任务）→ 停止该任务轮询
                if (e.status === 404 && e.data && e.data.status === 'unknown') { pending.delete(id); interrupted = true; }
                /* 其余网络抖动时继续轮询 */
            }
        }
        if (pending.size === 0 || Date.now() - startedAt > 5 * 60 * 1000) {
            clearInterval(timer);
            if (interrupted) showToast(t('服务已重启，任务中断，请重试'), 'error');
            else showToast(pending.size === 0 ? t('附件解析完成') : t('附件解析超时，稍后刷新查看'));
            loadFragments();
        }
    }, 2000);
}

async function submitFragment() {
    const input = document.getElementById('fragment-input');
    let content = input.value.trim();
    if (!content && pendingAttachments.length === 0) return;
    try {
        const uploaded = [];
        for (const att of pendingAttachments) {
            const res = await uploadAttachment(att);
            if (res) uploaded.push(res);
        }
        for (const a of uploaded) content += `\n![[${a.name}]]`;
        const data = await api('POST', '/api/vault/fragments', {
            content,
            attachments: uploaded.map((a) => a.name),
            parse: true
        });
        input.value = '';
        clearAttachments();
        input.focus();
        showToast(t('已记录'));
        await loadFragments();
        const taskIds = (data && data.parseTaskIds) || [];
        if (taskIds.length) {
            showToast(t('附件 AI 解析中…'));
            pollParseTasks(taskIds);
        }
    }
    catch (e) { console.error('Failed to create fragment:', e); showToast(e.message || t('记录失败')); }
}

async function promoteFragment(id, to) {
    const label = t({ card: '知识卡片', note: '笔记', mistake: '错题' }[to] || '目标');
    try { await api('POST', `/api/vault/fragments/${encodeURIComponent(id)}/promote`, { to }); showToast(t('已转为{label}', { label })); await loadFragments(); }
    catch (e) { console.error('Failed to promote fragment:', e); showToast(e.message || t('转化失败')); }
}

async function deleteFragment(id) {
    if (!(await showConfirmModal({ title: t('删除碎片'), message: t('确定要删除这条碎片吗？此操作不可恢复。'), confirmText: t('删除'), danger: true }))) return;
    try { await api('DELETE', `/api/vault/fragments/${encodeURIComponent(id)}`); showToast(t('已删除')); await loadFragments(); }
    catch (e) { console.error('Failed to delete fragment:', e); showToast(e.message || t('删除失败')); }
}

async function reparseFragment(id) {
    try {
        const data = await api('POST', `/api/vault/fragments/${encodeURIComponent(id)}/reparse`, {});
        showToast(t('重新解析 {count} 个附件…', { count: data.count }));
        const taskIds = (data && data.parseTaskIds) || [];
        if (taskIds.length) pollParseTasks(taskIds);
    } catch (e) { console.error('Failed to reparse fragment:', e); showToast(e.message || t('重新解析失败'), 'error'); }
}

export function focusFragmentInput() {
    if (S.currentSidebarTab !== 'fragments' && _cb.switchSidebarTab) _cb.switchSidebarTab('fragments');
    document.getElementById('sidebar')?.classList.remove('collapsed');
    if (_cb.openSidebarDrawer) _cb.openSidebarDrawer(); // 移动端：输入区在抽屉内，先展开（桌面为 no-op）
    document.getElementById('fragment-input')?.focus();
}

// ============================================================
// AI 整理（碎片智能归置）
// ============================================================
let organizeSuggestions = [];
const ORGANIZE_ACTION_LABELS = { tag: '补标签', link: '关联笔记', merge: '合并', leave: '保留' };

function organizeActionLabel(s) {
    if (s.action === 'promote') return t({ card: '转卡片', note: '转笔记', mistake: '转错题' }[s.to] || '转化');
    return t(ORGANIZE_ACTION_LABELS[s.action] || s.action || '保留');
}

async function updateOrganizeButton() {
    const btn = document.getElementById('btn-organize');
    if (!btn) return;
    try {
        const data = await api('GET', '/api/vault/fragments?status=inbox');
        const count = (data.fragments || []).length;
        btn.disabled = count === 0;
        btn.textContent = count > 0 ? t('AI 整理（{count}）', { count }) : t('AI 整理');
    } catch (e) { console.error('Failed to check inbox fragments:', e); btn.disabled = false; }
}

export async function openOrganizeModal() {
    const modal = document.getElementById('organize-modal');
    const statusEl = document.getElementById('organize-status');
    const listEl = document.getElementById('organize-list');
    const tipEl = document.getElementById('organize-degraded-tip');
    const applyBtn = document.getElementById('btn-apply-organize');
    modal.classList.remove('hidden');
    organizeSuggestions = [];
    listEl.innerHTML = '';
    tipEl.classList.add('hidden');
    statusEl.textContent = t('正在分析碎片…');
    statusEl.classList.remove('hidden');
    applyBtn.disabled = true;
    try {
        const data = await api('POST', '/api/vault/organize');
        organizeSuggestions = data.suggestions || [];
        statusEl.classList.add('hidden');
        if (data.degraded) tipEl.classList.remove('hidden');
        renderOrganizeList();
    } catch (e) {
        console.error('Failed to get organize suggestions:', e);
        statusEl.textContent = t('分析失败：{msg}', { msg: e.message || t('未知错误') });
    } finally { applyBtn.disabled = false; }
}

function renderOrganizeList() {
    const listEl = document.getElementById('organize-list');
    if (!organizeSuggestions.length) { listEl.innerHTML = `<div class="organize-status">${t('暂无可整理的碎片')}</div>`; return; }
    listEl.innerHTML = organizeSuggestions.map((s, i) => `
      <label class="organize-item">
        <input type="checkbox" class="organize-check" data-index="${i}" checked>
        <div class="organize-item-body">
          <div class="organize-item-content">${escapeHtml(s.fragmentPreview)}</div>
          <div class="organize-item-meta">
            <span class="organize-action-badge organize-action-${escapeHtmlAttr(s.action)}">${escapeHtml(organizeActionLabel(s))}</span>
            <span class="organize-reason">${escapeHtml(s.reason)}</span>
          </div></div></label>`).join('');
}

async function applyOrganize() {
    const checked = document.querySelectorAll('#organize-list .organize-check:checked');
    const actions = [...checked].map((c) => organizeSuggestions[Number(c.dataset.index)]).filter(Boolean);
    if (!actions.length) { showToast(t('请先勾选要应用的建议')); return; }
    const applyBtn = document.getElementById('btn-apply-organize');
    applyBtn.disabled = true; applyBtn.textContent = t('应用中…');
    try {
        const res = await api('POST', '/api/vault/organize/apply', { actions });
        const applied = res.applied || 0;
        const failed = (res.errors || []).length;
        showToast(failed ? t('整理完成：成功 {applied} 条，失败 {failed} 条', { applied, failed }) : t('整理完成：成功 {applied} 条', { applied }));
        document.getElementById('organize-modal').classList.add('hidden');
        await loadFragments();
    } catch (e) { console.error('Failed to apply organize actions:', e); showToast(e.message || t('应用失败')); }
    finally { applyBtn.disabled = false; applyBtn.textContent = t('应用所选'); }
}

// ============================================================
// 语音听记（MediaRecorder 录音 → 自动上传为 voice-* 附件 → ASR 转写）
// ============================================================
const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
let voiceRec = null; // { recorder, stream, audioCtx, analyser, chunks, seconds, timerId, rafId, paused, mime }

function pickVoiceMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    return VOICE_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function fmtVoiceTime(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateVoiceTimer() {
    const el = document.getElementById('voice-timer');
    if (el && voiceRec) el.textContent = fmtVoiceTime(voiceRec.seconds);
}

function setVoiceStatus(text, recording) {
    const el = document.getElementById('voice-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('recording', !!recording);
}

function drawVoiceWave() {
    const canvas = document.getElementById('voice-wave');
    if (!canvas || !voiceRec) return;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(voiceRec.analyser.frequencyBinCount);
    const draw = () => {
        if (!voiceRec) return;
        voiceRec.rafId = requestAnimationFrame(draw);
        voiceRec.analyser.getByteFrequencyData(data);
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        const barCount = 48;
        const step = Math.floor(data.length / barCount) || 1;
        const barW = width / barCount;
        for (let i = 0; i < barCount; i++) {
            const v = voiceRec.paused ? 0.06 : data[i * step] / 255;
            const h = Math.max(3, v * (height - 8));
            ctx.fillStyle = voiceRec.paused ? 'rgba(21, 26, 25, 0.18)' : 'rgba(0, 180, 152, 0.85)';
            ctx.beginPath();
            ctx.roundRect(i * barW + barW * 0.22, (height - h) / 2, barW * 0.56, h, 2);
            ctx.fill();
        }
    };
    draw();
}

async function openVoiceModal() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        showToast(t('当前浏览器不支持录音'), 'error');
        return;
    }
    const modal = document.getElementById('voice-modal');
    const pauseBtn = document.getElementById('btn-voice-pause');
    const finishBtn = document.getElementById('btn-voice-finish');
    document.getElementById('voice-timer').textContent = '00:00';
    setVoiceStatus(t('准备录音…'), false);
    pauseBtn.disabled = true; pauseBtn.textContent = t('暂停');
    finishBtn.disabled = true;
    modal.classList.remove('hidden');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = pickVoiceMime();
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        audioCtx.createMediaStreamSource(stream).connect(analyser);
        voiceRec = {
            recorder, stream, audioCtx, analyser,
            chunks: [], seconds: 0, timerId: null, rafId: 0, paused: false,
            mime: recorder.mimeType || mime || 'audio/webm'
        };
        recorder.addEventListener('dataavailable', (e) => {
            if (e.data?.size && voiceRec) voiceRec.chunks.push(e.data);
        });
        recorder.start(500);
        voiceRec.timerId = setInterval(() => {
            if (voiceRec && !voiceRec.paused) { voiceRec.seconds++; updateVoiceTimer(); }
        }, 1000);
        setVoiceStatus(t('录音中'), true);
        pauseBtn.disabled = false;
        finishBtn.disabled = false;
        drawVoiceWave();
    } catch (e) {
        console.error('Failed to start recording:', e);
        modal.classList.add('hidden');
        showToast(t('无法访问麦克风，请检查浏览器授权'), 'error');
    }
}

function teardownVoice() {
    if (!voiceRec) return;
    clearInterval(voiceRec.timerId);
    cancelAnimationFrame(voiceRec.rafId);
    try { voiceRec.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { voiceRec.audioCtx.close(); } catch { /* ignore */ }
    voiceRec = null;
}

function closeVoiceModal() {
    teardownVoice();
    document.getElementById('voice-modal').classList.add('hidden');
}

async function cancelVoiceRecording() {
    if (voiceRec && voiceRec.seconds > 0 && !(await showConfirmModal({ title: t('放弃录音'), message: t('录音尚未完成，确定要放弃这段录音吗？'), confirmText: t('放弃'), danger: true }))) return;
    closeVoiceModal();
}

function toggleVoicePause() {
    if (!voiceRec) return;
    const pauseBtn = document.getElementById('btn-voice-pause');
    if (voiceRec.paused) {
        voiceRec.recorder.resume();
        voiceRec.paused = false;
        setVoiceStatus(t('录音中'), true);
        pauseBtn.textContent = t('暂停');
    } else {
        voiceRec.recorder.pause();
        voiceRec.paused = true;
        setVoiceStatus(t('已暂停'), false);
        pauseBtn.textContent = t('继续');
    }
}

async function finishVoiceRecording() {
    if (!voiceRec) return;
    const rec = voiceRec;
    const seconds = rec.seconds;
    const mime = rec.mime;
    const blob = await new Promise((resolve) => {
        const build = () => resolve(new Blob(rec.chunks, { type: mime }));
        if (rec.recorder.state === 'inactive') return build();
        rec.recorder.addEventListener('stop', build, { once: true });
        rec.recorder.stop();
    });
    closeVoiceModal();
    if (!blob.size || seconds < 1) { showToast(t('录音太短，未保存')); return; }
    const ext = mime.includes('mp4') ? 'm4a' : 'webm';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const name = `voice-${stamp}.${ext}`;
    await submitVoiceFragment(new File([blob], name, { type: mime }), name, seconds);
}

async function submitVoiceFragment(file, name, seconds) {
    try {
        showToast(t('录音上传中…'));
        const uploaded = await uploadAttachment({ file, name });
        if (!uploaded) return;
        const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const content = `🎙 语音听记 ${time}（时长 ${fmtVoiceTime(seconds)}）\n![[${uploaded.name}]]`;
        const data = await api('POST', '/api/vault/fragments', {
            content,
            attachments: [uploaded.name],
            parse: true
        });
        showToast(t('语音已保存，转写中…'));
        await loadFragments();
        const taskIds = (data && data.parseTaskIds) || [];
        if (taskIds.length) pollParseTasks(taskIds);
    } catch (e) {
        console.error('Failed to submit voice fragment:', e);
        showToast(e.message || t('语音保存失败'), 'error');
    }
}

// ============================================================
// 事件绑定
// ============================================================
export function bindFragmentEvents() {
    document.getElementById('fragment-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitFragment(); }
    });
    document.getElementById('btn-fragment-submit')?.addEventListener('click', submitFragment);
    // 粘贴附件（截图粘贴是核心场景）
    document.getElementById('fragment-input')?.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items || [];
        const files = [];
        for (const item of items) {
            if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
            }
        }
        if (files.length) addAttachmentFiles(files);
    });
    // 拖放附件
    const inputArea = document.getElementById('fragment-input-area');
    if (inputArea) {
        inputArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            inputArea.classList.add('fragment-drop-active');
        });
        inputArea.addEventListener('dragleave', (e) => {
            if (!inputArea.contains(e.relatedTarget)) inputArea.classList.remove('fragment-drop-active');
        });
        inputArea.addEventListener('drop', (e) => {
            e.preventDefault();
            inputArea.classList.remove('fragment-drop-active');
            if (e.dataTransfer?.files?.length) addAttachmentFiles([...e.dataTransfer.files]);
        });
    }
    // 📎 按钮 + 文件选择
    document.getElementById('btn-fragment-attach')?.addEventListener('click', () => {
        document.getElementById('fragment-file-input')?.click();
    });
    // 🎙 语音听记
    document.getElementById('btn-fragment-voice')?.addEventListener('click', openVoiceModal);
    document.getElementById('btn-voice-cancel')?.addEventListener('click', cancelVoiceRecording);
    document.getElementById('btn-voice-pause')?.addEventListener('click', toggleVoicePause);
    document.getElementById('btn-voice-finish')?.addEventListener('click', finishVoiceRecording);
    document.querySelector('#voice-modal .modal-backdrop')?.addEventListener('click', cancelVoiceRecording);
    document.getElementById('fragment-file-input')?.addEventListener('change', (e) => {
        if (e.target.files?.length) addAttachmentFiles([...e.target.files]);
        e.target.value = '';
    });
    document.getElementById('fragment-list')?.addEventListener('click', (e) => {
        const tagEl = e.target.closest('.fragment-tag');
        if (tagEl && tagEl.dataset.tag) { S.currentTag = tagEl.dataset.tag; if (_cb.showTagsPanel) _cb.showTagsPanel(); return; }
        const btn = e.target.closest('.fragment-action');
        if (!btn) return;
        const id = btn.closest('.fragment-item')?.dataset.id;
        if (!id) return;
        if (btn.dataset.action === 'promote') promoteFragment(id, btn.dataset.to);
        else if (btn.dataset.action === 'today') { if (_cb.appendFragmentToToday) _cb.appendFragmentToToday(id); }
        else if (btn.dataset.action === 'reparse') reparseFragment(id);
        else if (btn.dataset.action === 'delete') deleteFragment(id);
    });
    document.querySelectorAll('.fragment-filter').forEach((btn) => {
        btn.addEventListener('click', () => {
            S.fragmentFilter = btn.dataset.filter;
            document.querySelectorAll('.fragment-filter').forEach((b) => b.classList.toggle('active', b === btn));
            loadFragments();
        });
    });
    document.getElementById('btn-organize')?.addEventListener('click', openOrganizeModal);
    document.getElementById('btn-cancel-organize')?.addEventListener('click', () => { document.getElementById('organize-modal').classList.add('hidden'); });
    document.getElementById('btn-apply-organize')?.addEventListener('click', applyOrganize);
}
