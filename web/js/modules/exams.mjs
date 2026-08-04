// web/js/modules/exams.mjs — 训练模式 + 测验 + 错题集
import { S } from './state.mjs';
import { showToast, escapeHtml } from './state.mjs';
import { showConfirmModal } from './modals.mjs';

// ============================================================
// 辅助
// ============================================================
function getDifficultyColor(d) { return d === 'easy' ? '#22c55e' : d === 'hard' ? '#ef4444' : '#f59e0b'; }
function getDifficultyText(d) { return d === 'easy' ? '简单' : d === 'hard' ? '困难' : '中等'; }

// ============================================================
// 训练模式（Training）
// ============================================================
let trainingItems = [];
let currentTrainingIndex = 0;
let trainingType = null;

export function showTrainingWelcome() {
    document.getElementById('training-welcome').classList.remove('hidden');
    document.getElementById('training-session').classList.add('hidden');
    document.getElementById('training-complete').classList.add('hidden');
}

async function startTraining(type) {
    trainingType = type;
    currentTrainingIndex = 0;
    try {
        if (type === 'cards') { const res = await fetch('/api/vault/cards/due'); trainingItems = await res.json(); }
        else if (type === 'mistakes') { const res = await fetch('/api/mistakes'); trainingItems = (await res.json()).filter(m => (m.mastery || 0) < 5); }
        if (trainingItems.length === 0) { showToast('今天没有需要复习的内容！'); return; }
        trainingItems = [...trainingItems].sort(() => Math.random() - 0.5);
        document.getElementById('training-welcome').classList.add('hidden');
        document.getElementById('training-session').classList.remove('hidden');
        document.getElementById('training-complete').classList.add('hidden');
        showCurrentTrainingItem();
    } catch (e) { console.error('Failed to start training:', e); showToast('启动复习失败'); }
}

function showCurrentTrainingItem() {
    const item = trainingItems[currentTrainingIndex];
    if (!item) { showTrainingComplete(); return; }
    document.getElementById('training-progress').textContent = `${currentTrainingIndex + 1} / ${trainingItems.length}`;
    document.getElementById('training-question').textContent = item.question || item.title || '';
    document.getElementById('training-answer').textContent = item.answer || item.correctAnswer || '';
    document.getElementById('training-analysis').textContent = item.explanation || item.analysis || '';
    document.getElementById('training-answer-section').classList.add('hidden');
    document.getElementById('btn-show-training-answer').style.display = '';
    if (!item.explanation && !item.analysis) document.getElementById('training-analysis-section').classList.add('hidden');
    else document.getElementById('training-analysis-section').classList.remove('hidden');
}

function showTrainingAnswer() {
    document.getElementById('training-answer-section').classList.remove('hidden');
    document.getElementById('btn-show-training-answer').style.display = 'none';
}

async function submitTrainingRating(rate) {
    const item = trainingItems[currentTrainingIndex];
    if (!item) return;
    try {
        let res = null;
        if (trainingType === 'cards') {
            res = await fetch(`/api/vault/cards/${encodeURIComponent(item.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: rate }) });
        } else if (trainingType === 'mistakes') {
            res = await fetch(`/api/mistakes/${encodeURIComponent(item.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mastery: rate }) });
        }
        if (res && !res.ok) { showToast('提交失败，请重试'); return; }
        currentTrainingIndex++;
        if (currentTrainingIndex >= trainingItems.length) showTrainingComplete();
        else showCurrentTrainingItem();
    } catch (e) { console.error('Failed to submit rating:', e); showToast('提交失败'); }
}

function showTrainingComplete() {
    document.getElementById('training-session').classList.add('hidden');
    document.getElementById('training-complete').classList.remove('hidden');
}

export function bindTrainingEvents() {
    document.getElementById('btn-train-cards')?.addEventListener('click', () => startTraining('cards'));
    document.getElementById('btn-train-mistakes')?.addEventListener('click', () => startTraining('mistakes'));
    document.getElementById('btn-show-training-answer')?.addEventListener('click', showTrainingAnswer);
    document.getElementById('btn-back-to-welcome')?.addEventListener('click', showTrainingWelcome);
    document.getElementById('btn-end-training')?.addEventListener('click', showTrainingWelcome);
    document.querySelectorAll('.training-rate-btn').forEach(btn => { btn.addEventListener('click', () => { submitTrainingRating(parseInt(btn.dataset.rate)); }); });
}

// ============================================================
// 测验（Exam Papers）
// ============================================================
let examStats = null;
let editingExamId = null;

export async function loadExams() {
    try {
        const [examsRes, statsRes] = await Promise.all([fetch('/api/exams'), fetch('/api/exams/stats')]);
        S.exams = await examsRes.json();
        examStats = await statsRes.json();
        renderExamsList(); renderExamsStats();
    } catch (e) { console.error('Failed to load exams:', e); showToast('加载测验列表失败'); }
}

function renderExamsStats() {
    if (!examStats) return;
    document.getElementById('stat-exam-count').textContent = examStats.examCount;
    document.getElementById('stat-question-count').textContent = examStats.questionCount;
}

function renderExamsList() {
    const container = document.getElementById('exams-list');
    if (S.exams.length === 0) {
        container.innerHTML = `<div style="padding:40px 20px;text-align:center;opacity:0.6;"><div style="font-size:48px;margin-bottom:12px;">📝</div>暂无测验<br><button id="btn-first-exam" class="btn-primary" style="margin-top:12px;">创建第一份测验</button></div>`;
        document.getElementById('btn-first-exam')?.addEventListener('click', createNewExam);
        return;
    }
    let html = '<div style="display:flex;flex-direction:column;gap:12px;">';
    for (const exam of S.exams) {
        html += `<div class="exam-list-item" style="padding:16px;border:1px solid var(--tile-strong);border-radius:12px;background:white;cursor:pointer;" data-id="${escapeHtml(exam.id)}">
          <div style="font-weight:700;font-size:15px;margin-bottom:6px;">${escapeHtml(exam.title)}</div>
          <div style="font-size:13px;opacity:0.7;margin-bottom:8px;">${escapeHtml(exam.subject || '未分类')} · ${exam.questions?.length || 0} 道题${exam.examDate ? ` · ${escapeHtml(exam.examDate)}` : ''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${(exam.tags || []).slice(0, 3).map(t => `<span style="padding:2px 8px;background:var(--tile);border-radius:9999px;font-size:11px;">${escapeHtml(t)}</span>`).join('')}
            <span style="padding:2px 8px;background:${getDifficultyColor(exam.difficulty)};border-radius:9999px;font-size:11px;color:white;">${getDifficultyText(exam.difficulty)}</span>
          </div></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.exam-list-item').forEach(el => { el.addEventListener('click', () => selectExam(el.dataset.id)); });
}

function selectExam(id) {
    const exam = S.exams.find(e => e.id === id);
    if (!exam) return;
    S.currentExam = exam;
    document.getElementById('exam-empty').style.display = 'none';
    document.getElementById('exam-detail').style.display = 'flex';
    document.getElementById('exam-detail-title').textContent = exam.title;
    document.getElementById('exam-detail-meta').textContent = `${exam.subject || '未分类'} · ${exam.questions?.length || 0} 道题 · ${getDifficultyText(exam.difficulty)}难度`;
    renderExamDetail(exam);
}

function renderExamDetail(exam) {
    const container = document.getElementById('exam-detail-content');
    let html = '';
    if (exam.description) html += `<div style="padding:16px;background:var(--tile);border-radius:12px;margin-bottom:16px;"><div style="font-size:13px;opacity:0.7;margin-bottom:4px;">测验说明</div><div>${escapeHtml(exam.description)}</div></div>`;
    const questions = exam.questions || [];
    if (questions.length === 0) { html += `<div style="text-align:center;padding:40px;opacity:0.7;"><div style="font-size:48px;margin-bottom:12px;">❓</div>暂无题目，点击"编辑"添加题目</div>`; }
    else {
        html += '<div style="display:flex;flex-direction:column;gap:16px;">';
        questions.forEach((q, idx) => {
            html += `<div style="padding:16px;border:1px solid var(--tile-strong);border-radius:12px;background:white;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
              <div style="font-weight:600;">第 ${idx + 1} 题</div>
              <div style="display:flex;gap:6px;">
                <span style="padding:2px 8px;background:${getDifficultyColor(q.difficulty || exam.difficulty)};border-radius:9999px;font-size:11px;color:white;">${getDifficultyText(q.difficulty || exam.difficulty)}</span>
                ${q.type ? `<span style="padding:2px 8px;background:var(--tile);border-radius:9999px;font-size:11px;">${escapeHtml(q.type)}</span>` : ''}
              </div></div>
            <div style="margin-bottom:12px;line-height:1.6;">${escapeHtml(q.question || '')}</div>
            ${q.answer ? `<div style="padding:12px;background:#f0fdf4;border-radius:8px;"><div style="font-size:12px;opacity:0.7;margin-bottom:4px;">答案</div><div>${escapeHtml(q.answer)}</div></div>` : ''}
            ${q.explanation ? `<div style="padding:12px;background:#f0f9ff;border-radius:8px;margin-top:8px;"><div style="font-size:12px;opacity:0.7;margin-bottom:4px;">解析</div><div>${escapeHtml(q.explanation)}</div></div>` : ''}
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--tile);display:flex;gap:8px;justify-content:flex-end;">
              <button class="btn-secondary add-to-mistakes" data-idx="${idx}" style="font-size:13px;padding:8px 12px;">❌ 加入错题集</button>
            </div></div>`;
        });
        html += '</div>';
    }
    container.innerHTML = html;
    container.querySelectorAll('.add-to-mistakes').forEach(el => { el.addEventListener('click', (e) => { e.stopPropagation(); addMistakeFromExam(Number(el.dataset.idx)); }); });
}

async function addMistakeFromExam(questionIdx) {
    if (!S.currentExam) return;
    try { const res = await fetch('/api/mistakes/from-exam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ examId: S.currentExam.id, questionIndex: questionIdx }) }); if (res.ok) showToast('已加入错题集！'); }
    catch (e) { console.error('Failed to add mistake:', e); showToast('添加失败'); }
}

function createNewExam() { openExamModal(null); }

function openSmartExamModal() {
    document.getElementById('smart-exam-count').value = '5';
    document.getElementById('smart-exam-subject').value = '';
    const btn = document.getElementById('btn-confirm-smart-exam');
    btn.disabled = false; btn.textContent = '开始组卷';
    document.getElementById('smart-exam-modal').classList.remove('hidden');
}

async function confirmSmartExam() {
    const btn = document.getElementById('btn-confirm-smart-exam');
    const count = parseInt(document.getElementById('smart-exam-count').value, 10) || 5;
    const subject = document.getElementById('smart-exam-subject').value.trim();
    btn.disabled = true; btn.textContent = '组卷中…';
    try {
        const res = await fetch('/api/exams/smart-generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subject ? { count, subject } : { count }) });
        if (res.status === 400) { showToast('没有足够的可组卷内容，先去记录一些卡片或错题吧'); return; }
        if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '智能组卷失败'); }
        const { exam, meta } = await res.json();
        document.getElementById('smart-exam-modal').classList.add('hidden');
        const parts = [];
        if (meta?.lowMasteryCards) parts.push(`${meta.lowMasteryCards} 张低熟练度卡片`);
        if (meta?.dueCards) parts.push(`${meta.dueCards} 张到期复习卡片`);
        if (meta?.mistakesUsed) parts.push(`${meta.mistakesUsed} 道历史错题`);
        showToast(`已生成智能测验：基于 ${parts.join('、') || '现有测验内容'}`);
        await loadExams();
        if (exam?.id) selectExam(exam.id);
    } catch (e) { console.error('Failed to smart-generate exam:', e); showToast(e.message || '智能组卷失败'); }
    finally { btn.disabled = false; btn.textContent = '开始组卷'; }
}

function openExamModal(exam) {
    editingExamId = exam ? exam.id : null;
    document.getElementById('exam-modal-title').textContent = exam ? '编辑测验' : '新建测验';
    document.getElementById('exam-form-title').value = exam?.title || '';
    document.getElementById('exam-form-subject').value = exam?.subject || '';
    document.getElementById('exam-form-difficulty').value = exam?.difficulty || 'medium';
    document.getElementById('exam-form-date').value = exam?.examDate || '';
    document.getElementById('exam-form-tags').value = (exam?.tags || []).join(', ');
    document.getElementById('exam-form-description').value = exam?.description || '';
    const list = document.getElementById('exam-questions-list');
    list.innerHTML = '';
    const questions = exam?.questions || [];
    if (questions.length === 0) addExamQuestionRow(); else questions.forEach((q) => addExamQuestionRow(q));
    document.getElementById('exam-modal').classList.remove('hidden');
}

function addExamQuestionRow(q = {}) {
    const list = document.getElementById('exam-questions-list');
    const row = document.createElement('div'); row.className = 'exam-question-row';
    row.innerHTML = `<div class="exam-question-row-head"><span class="exam-question-row-index"></span><button type="button" class="btn-icon exam-question-remove" title="删除题目">×</button></div>
      <textarea class="eq-question" rows="2" placeholder="题干"></textarea>
      <div class="exam-question-row-grid"><input type="text" class="eq-type" placeholder="题型（如：选择题、填空题）"><input type="text" class="eq-answer" placeholder="答案"></div>
      <textarea class="eq-explanation" rows="2" placeholder="解析（可选）"></textarea>`;
    row.querySelector('.eq-question').value = q.question || '';
    row.querySelector('.eq-type').value = q.type || '';
    row.querySelector('.eq-answer').value = q.answer || '';
    row.querySelector('.eq-explanation').value = q.explanation || '';
    row.querySelector('.exam-question-remove').addEventListener('click', () => { row.remove(); updateExamQuestionIndexes(); });
    list.appendChild(row); updateExamQuestionIndexes();
}

function updateExamQuestionIndexes() {
    document.querySelectorAll('#exam-questions-list .exam-question-row-index').forEach((el, i) => { el.textContent = `第 ${i + 1} 题`; });
}

async function confirmExamModal() {
    const title = document.getElementById('exam-form-title').value.trim();
    if (!title) { showToast('请输入测验标题'); return; }
    const questions = [];
    document.querySelectorAll('#exam-questions-list .exam-question-row').forEach((row) => {
        const question = row.querySelector('.eq-question').value.trim();
        if (!question) return;
        questions.push({ question, type: row.querySelector('.eq-type').value.trim(), answer: row.querySelector('.eq-answer').value.trim(), explanation: row.querySelector('.eq-explanation').value.trim() });
    });
    const data = { title, subject: document.getElementById('exam-form-subject').value.trim(), description: document.getElementById('exam-form-description').value.trim(), difficulty: document.getElementById('exam-form-difficulty').value || 'medium', examDate: document.getElementById('exam-form-date').value, tags: document.getElementById('exam-form-tags').value.split(',').map(t => t.trim()).filter(t => t), questions };
    try {
        let examId = editingExamId;
        if (editingExamId) {
            const res = await fetch(`/api/exams/${encodeURIComponent(editingExamId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            if (!res.ok) throw new Error('保存失败');
            showToast('保存成功！');
        } else {
            examId = title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || `exam-${Date.now()}`;
            const res = await fetch('/api/exams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: examId, ...data }) });
            if (!res.ok) throw new Error('创建失败');
            showToast('创建成功！');
        }
        document.getElementById('exam-modal').classList.add('hidden');
        await loadExams(); selectExam(examId);
    } catch (e) { console.error('Failed to save exam:', e); showToast(e.message || '保存失败'); }
}

async function editExam() { if (!S.currentExam) return; openExamModal(S.currentExam); }

async function deleteExam() {
    if (!S.currentExam || !(await showConfirmModal({ title: '删除测验', message: '确定要删除这份测验吗？此操作不可恢复。', confirmText: '删除', danger: true }))) return;
    try {
        const res = await fetch(`/api/exams/${encodeURIComponent(S.currentExam.id)}`, { method: 'DELETE' });
        if (res.ok) { S.currentExam = null; showToast('删除成功！'); document.getElementById('exam-detail').style.display = 'none'; document.getElementById('exam-empty').style.display = 'flex'; await loadExams(); }
    } catch (e) { console.error('Failed to delete exam:', e); showToast('删除失败'); }
}

// ============================================================
// 错题集（Mistakes）
// ============================================================
let mistakeStats = null;
let editingMistakeId = null;

export async function loadMistakes() {
    try {
        const subject = document.getElementById('mistake-filter-subject')?.value || '';
        const masteryRange = document.getElementById('mistake-filter-mastery')?.value || '';
        let url = '/api/mistakes';
        const params = new URLSearchParams();
        if (subject) params.set('subject', subject);
        if (masteryRange) params.set('masteryRange', masteryRange);
        if (params.toString()) url += '?' + params.toString();
        const [mistakesRes, statsRes] = await Promise.all([fetch(url), fetch('/api/mistakes/stats')]);
        S.mistakes = await mistakesRes.json();
        mistakeStats = await statsRes.json();
        renderMistakesList(); renderMistakesStats(); updateSubjectFilter();
    } catch (e) { console.error('Failed to load mistakes:', e); showToast('加载错题集失败'); }
}

function renderMistakesStats() {
    if (!mistakeStats) return;
    document.getElementById('stat-mistake-count').textContent = mistakeStats.mistakeCount;
    document.getElementById('stat-review-count').textContent = mistakeStats.reviewCount;
    document.getElementById('stat-mastered-count').textContent = mistakeStats.masteredCount;
}

function updateSubjectFilter() {
    const select = document.getElementById('mistake-filter-subject');
    if (!select || !mistakeStats) return;
    const currentValue = select.value;
    let optionsHtml = '<option value="">全部分类</option>';
    (mistakeStats.subjects || []).forEach(subj => { optionsHtml += `<option value="${escapeHtml(subj)}">${escapeHtml(subj)}</option>`; });
    select.innerHTML = optionsHtml; select.value = currentValue;
}

function renderMistakesList() {
    const container = document.getElementById('mistakes-list');
    if (S.mistakes.length === 0) {
        container.innerHTML = `<div style="padding:40px 20px;text-align:center;opacity:0.6;"><div style="font-size:48px;margin-bottom:12px;">✅</div>暂无错题，继续保持！<br><button id="btn-first-mistake" class="btn-primary" style="margin-top:12px;">记录错题</button></div>`;
        document.getElementById('btn-first-mistake')?.addEventListener('click', createNewMistake);
        return;
    }
    const masteryColors = ['#fee2e2', '#fef3c7', '#fde68a', '#d9f99d', '#86efac', '#22c55e'];
    const masteryText = ['需要复习', '需要复习', '基本掌握', '基本掌握', '掌握得不错', '完全掌握'];
    let html = '<div style="display:flex;flex-direction:column;gap:12px;">';
    for (const m of S.mistakes) {
        html += `<div class="mistake-list-item" style="padding:14px 16px;border:1px solid var(--tile-strong);border-radius:12px;background:white;cursor:pointer;" data-id="${escapeHtml(m.id)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div style="font-weight:600;font-size:14px;line-height:1.4;flex:1;">${escapeHtml(m.question?.substring(0, 60) || '无题')}${m.question?.length > 60 ? '...' : ''}</div>
            <div style="margin-left:12px;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
              <span style="width:12px;height:12px;border-radius:50%;background:${masteryColors[m.mastery || 0]};"></span>
              <span style="font-size:11px;opacity:0.7;">${masteryText[m.mastery || 0]}</span></div></div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            ${m.subject ? `<span style="padding:2px 8px;background:var(--tile);border-radius:9999px;font-size:11px;">${escapeHtml(m.subject)}</span>` : ''}
            ${m.questionType ? `<span style="padding:2px 8px;background:var(--tile);border-radius:9999px;font-size:11px;">${escapeHtml(m.questionType)}</span>` : ''}
            <span style="font-size:11px;opacity:0.6;">复习 ${m.reviewCount || 0} 次</span></div></div>`;
    }
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.mistake-list-item').forEach(el => { el.addEventListener('click', () => selectMistake(el.dataset.id)); });
}

export function selectMistake(id) {
    const m = S.mistakes.find(x => x.id === id);
    if (!m) return;
    S.currentMistake = m;
    document.getElementById('mistake-empty').style.display = 'none';
    document.getElementById('mistake-detail').style.display = 'flex';
    const masteryText = ['需要复习', '需要复习', '基本掌握', '基本掌握', '掌握得不错', '完全掌握'];
    document.getElementById('mistake-detail-title').textContent = (m.question || '').substring(0, 50) + ((m.question || '').length > 50 ? '...' : '');
    document.getElementById('mistake-detail-meta').textContent = `${m.subject || '未分类'} · ${m.questionType || ''} · ${masteryText[m.mastery || 0]}`;
    renderMistakeDetail(m);
}

function renderMistakeDetail(m) {
    const container = document.getElementById('mistake-detail-content');
    const masteryColors = ['#fee2e2', '#fef3c7', '#fde68a', '#d9f99d', '#86efac', '#22c55e'];
    let html = `<div style="padding:20px;border:1px solid var(--tile-strong);border-radius:16px;background:white;">
        <div style="font-size:18px;font-weight:700;margin-bottom:20px;">题目</div>
        <div style="line-height:1.8;margin-bottom:24px;">${escapeHtml(m.question || '')}</div>
        ${m.wrongAnswer ? `<div style="margin-bottom:16px;"><div style="font-size:13px;opacity:0.7;margin-bottom:6px;">我的错误答案</div><div style="padding:12px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;color:#991b1b;">${escapeHtml(m.wrongAnswer)}</div></div>` : ''}
        ${m.correctAnswer ? `<div style="margin-bottom:16px;"><div style="font-size:13px;opacity:0.7;margin-bottom:6px;">正确答案</div><div style="padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac;">${escapeHtml(m.correctAnswer)}</div></div>` : ''}
        ${m.analysis ? `<div style="margin-bottom:16px;"><div style="font-size:13px;opacity:0.7;margin-bottom:6px;">解析</div><div style="padding:12px;background:#f0f9ff;border-radius:8px;">${escapeHtml(m.analysis)}</div></div>` : ''}
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--tile);"><div style="font-size:13px;opacity:0.7;margin-bottom:12px;">熟练程度</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">${[0, 1, 2, 3, 4, 5].map(level => `<button class="btn-secondary mastery-btn" data-mastery="${level}" style="padding:8px 16px;background:${m.mastery === level ? masteryColors[level] : 'white'};${m.mastery === level ? 'border-color:' + masteryColors[level] + ';' : ''}">${level === 0 ? '完全不熟' : level === 1 ? '有点印象' : level === 2 ? '基本掌握' : level === 3 ? '掌握不错' : level === 4 ? '很熟练' : '完全掌握'}</button>`).join('')}</div></div>
        <div style="margin-top:20px;padding-top:20px;border-top:1px solid var(--tile);display:flex;gap:12px;flex-wrap:wrap;font-size:13px;opacity:0.7;">
          ${m.subject ? `<span>分类：${escapeHtml(m.subject)}</span>` : ''}
          ${m.questionType ? `<span>题型：${escapeHtml(m.questionType)}</span>` : ''}
          ${m.tags?.length ? `<span>标签：${m.tags.map(t => escapeHtml(t)).join(', ')}</span>` : ''}
          <span>复习了 ${m.reviewCount || 0} 次</span>
          ${m.lastReviewedAt ? `<span>上次复习：${new Date(m.lastReviewedAt).toLocaleDateString()}</span>` : ''}</div></div>`;
    container.innerHTML = html;
    container.querySelectorAll('.mastery-btn').forEach(el => { el.addEventListener('click', () => { recordMistakeMastery(Number(el.dataset.mastery)); }); });
}

async function recordMistakeMastery(mastery) {
    if (!S.currentMistake) return;
    try {
        const res = await fetch(`/api/mistakes/${encodeURIComponent(S.currentMistake.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mastery }) });
        if (res.ok) { showToast('已记录！'); await loadMistakes(); const updated = S.mistakes.find(m => m.id === S.currentMistake.id); if (updated) selectMistake(updated.id); }
    } catch (e) { console.error('Failed to record review:', e); showToast('记录失败'); }
}

async function markAsMastered() { if (!S.currentMistake) return; await recordMistakeMastery(5); }
function createNewMistake() { openMistakeModal(null); }

function openMistakeModal(mistake) {
    editingMistakeId = mistake ? mistake.id : null;
    document.getElementById('mistake-modal-title').textContent = mistake ? '编辑错题' : '记录错题';
    document.getElementById('mistake-form-question').value = mistake?.question || '';
    document.getElementById('mistake-form-wrong').value = mistake?.wrongAnswer || '';
    document.getElementById('mistake-form-correct').value = mistake?.correctAnswer || '';
    document.getElementById('mistake-form-subject').value = mistake?.subject || '';
    document.getElementById('mistake-form-questiontype').value = mistake?.questionType || '';
    document.getElementById('mistake-form-difficulty').value = mistake?.difficulty || 'medium';
    document.getElementById('mistake-form-tags').value = (mistake?.tags || []).join(', ');
    document.getElementById('mistake-form-analysis').value = mistake?.analysis || '';
    document.getElementById('mistake-modal').classList.remove('hidden');
}

async function confirmMistakeModal() {
    const question = document.getElementById('mistake-form-question').value.trim();
    if (!question) { showToast('请输入错题题目'); return; }
    const data = { question, wrongAnswer: document.getElementById('mistake-form-wrong').value.trim(), correctAnswer: document.getElementById('mistake-form-correct').value.trim(), subject: document.getElementById('mistake-form-subject').value.trim(), questionType: document.getElementById('mistake-form-questiontype').value.trim(), difficulty: document.getElementById('mistake-form-difficulty').value || 'medium', tags: document.getElementById('mistake-form-tags').value.split(',').map(t => t.trim()).filter(t => t), analysis: document.getElementById('mistake-form-analysis').value.trim() };
    try {
        let mistakeId = editingMistakeId;
        if (editingMistakeId) {
            const res = await fetch(`/api/mistakes/${encodeURIComponent(editingMistakeId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            if (!res.ok) throw new Error('保存失败');
            showToast('保存成功！');
        } else {
            mistakeId = `mistake-${Date.now()}`;
            const res = await fetch('/api/mistakes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: mistakeId, ...data }) });
            if (!res.ok) throw new Error('记录失败');
            showToast('记录成功！');
        }
        document.getElementById('mistake-modal').classList.add('hidden');
        await loadMistakes();
        if (editingMistakeId) selectMistake(mistakeId);
    } catch (e) { console.error('Failed to save mistake:', e); showToast(e.message || '保存失败'); }
}

async function editMistake() { if (!S.currentMistake) return; openMistakeModal(S.currentMistake); }

async function deleteMistake() {
    if (!S.currentMistake || !(await showConfirmModal({ title: '删除错题', message: '确定要删除这个错题吗？此操作不可恢复。', confirmText: '删除', danger: true }))) return;
    try {
        const res = await fetch(`/api/mistakes/${encodeURIComponent(S.currentMistake.id)}`, { method: 'DELETE' });
        if (res.ok) { S.currentMistake = null; showToast('删除成功！'); document.getElementById('mistake-detail').style.display = 'none'; document.getElementById('mistake-empty').style.display = 'flex'; await loadMistakes(); }
    } catch (e) { console.error('Failed to delete mistake:', e); showToast('删除失败'); }
}

// ============================================================
// 事件绑定
// ============================================================
export function bindExamsMistakesEvents() {
    document.getElementById('btn-new-exam')?.addEventListener('click', createNewExam);
    document.getElementById('btn-new-mistake')?.addEventListener('click', createNewMistake);
    document.getElementById('btn-edit-exam')?.addEventListener('click', editExam);
    document.getElementById('btn-delete-exam')?.addEventListener('click', deleteExam);
    document.getElementById('btn-edit-mistake')?.addEventListener('click', editMistake);
    document.getElementById('btn-delete-mistake')?.addEventListener('click', deleteMistake);
    document.getElementById('btn-mark-mastered')?.addEventListener('click', markAsMastered);
    document.getElementById('mistake-filter-subject')?.addEventListener('change', loadMistakes);
    document.getElementById('mistake-filter-mastery')?.addEventListener('change', loadMistakes);
    document.getElementById('btn-exam-add-question')?.addEventListener('click', () => addExamQuestionRow());
    document.getElementById('btn-cancel-exam')?.addEventListener('click', () => { document.getElementById('exam-modal').classList.add('hidden'); });
    document.getElementById('btn-confirm-exam')?.addEventListener('click', confirmExamModal);
    document.getElementById('btn-smart-exam')?.addEventListener('click', openSmartExamModal);
    document.getElementById('btn-cancel-smart-exam')?.addEventListener('click', () => { document.getElementById('smart-exam-modal').classList.add('hidden'); });
    document.getElementById('btn-confirm-smart-exam')?.addEventListener('click', confirmSmartExam);
    document.getElementById('smart-exam-subject')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) confirmSmartExam(); });
    document.getElementById('btn-cancel-mistake')?.addEventListener('click', () => { document.getElementById('mistake-modal').classList.add('hidden'); });
    document.getElementById('btn-confirm-mistake')?.addEventListener('click', confirmMistakeModal);
}
