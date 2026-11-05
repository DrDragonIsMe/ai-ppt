// web/js/modules/graph.mjs — 知识星图 Canvas 渲染 + 物理模拟
import { S } from './state.mjs';
import { showToast, escapeHtml } from './state.mjs';

// 外部模块回调（通过 initGraphModule 注入）
let _switchSidebarTab = null;
let _selectNote = null;
let _openGenerateModal = null;

// 模块内部状态
let physicsRafId = null;
let hoverNode = null;

// 常量（teal-editorial 配色：ink #151A19 / cream #FAFAF7 / teal #00B498）
const GRAPH_INK = '#151A19';
const GRAPH_CREAM = '#FAFAF7';
const GRAPH_TEAL = '#00B498';
const GRAPH_TYPE_COLORS = { card: '#d97706', fragment: '#8b5cf6' };
// 标签 hash 色（降饱和度的柔和版本）
const GRAPH_TAG_COLORS = ['#dfa357', '#a78bfa', '#f28bb8', '#7aa5d6', '#6fbf8f', '#e08080', '#d3b968', '#5fb3bd'];
const GRAPH_DEFAULT_COLOR = GRAPH_TEAL;

// ============================================================
// 初始化
// ============================================================
export function initGraphModule(callbacks) {
    _switchSidebarTab = callbacks.switchSidebarTab;
    _selectNote = callbacks.selectNote;
    _openGenerateModal = callbacks.openGenerateModal;
}

// ============================================================
// 通用：隐藏主工作区所有面板
// ============================================================
export function hideAllMainPanels() {
    ['empty-state', 'project-panel', 'graph-panel', 'cards-panel', 'study-panel', 'vault-panel', 'dashboard-panel', 'tags-panel', 'tasks-panel', 'settings-panel', 'agent-panel', 'materials-panel']
        .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
}

// ============================================================
// 面板切换
// ============================================================
export function showGraphPanel() {
    hideAllMainPanels();
    document.getElementById('graph-panel').classList.remove('hidden');
    loadGraph();
}

function hideGraphPanel() {
    stopPhysics();
    document.getElementById('graph-panel').classList.add('hidden');
    if (_switchSidebarTab) _switchSidebarTab(S.currentSidebarTab);
}

// ============================================================
// 数据加载
// ============================================================
async function loadGraph() {
    try {
        const res = await fetch('/api/vault/graph');
        S.currentGraph = await res.json();
        initGraph();
        renderGraph();
    } catch (e) {
        console.error('Failed to load graph:', e);
    }
}

async function refreshGraph() {
    try {
        const res = await fetch('/api/vault/graph', { method: 'POST' });
        await loadGraph();
        showToast('图谱已刷新');
    } catch (e) {
        console.error('Failed to refresh graph:', e);
        showToast('刷新失败');
    }
}

// ============================================================
// 节点/边权重辅助
// ============================================================
function getNodeWeight(node) {
    const w = Number(node && node.weight);
    return w > 0 ? w : 1;
}

function getEdgeWeight(edge) {
    const w = Number(edge && edge.weight);
    return w > 0 ? w : 1;
}

function graphNodeSizeFactor(weight) {
    return Math.min(2, 1 + 0.3 * Math.log2(weight));
}

function graphEdgeLineWidth(weight) {
    if (weight >= 5) return 3;
    if (weight >= 3) return 2.4;
    if (weight >= 2) return 1.9;
    return 1.5;
}

// ============================================================
// 初始化节点位置
// ============================================================
function initGraph() {
    if (!S.currentGraph) return;

    const container = document.getElementById('graph-container');
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    S.graphAllNodes = S.currentGraph.nodes.map((node, i) => {
        const angle = (i / S.currentGraph.nodes.length) * Math.PI * 2;
        const radius = Math.min(width, height) * 0.3;
        return {
            ...node,
            size: node.size * graphNodeSizeFactor(getNodeWeight(node)),
            x: width / 2 + Math.cos(angle) * radius + (Math.random() - 0.5) * 50,
            y: height / 2 + Math.sin(angle) * radius + (Math.random() - 0.5) * 50,
            vx: 0,
            vy: 0
        };
    });

    S.graphAllEdges = S.currentGraph.edges.map(edge => ({
        source: edge.source,
        target: edge.target,
        weight: getEdgeWeight(edge)
    }));

    applyGraphView();
    S.graphZoom = 1;
    S.graphPan = { x: 0, y: 0 };
    S.selectedNode = null;
    S.selectedGraphNodes = new Set();
    updateGraphGenerateBtn();
}

// 「只看高频」：只保留 weight 前 20 的节点及其间边
function applyGraphView() {
    if (S.graphHighFreqOnly && S.graphAllNodes.length > 20) {
        const topIds = new Set(
            [...S.graphAllNodes]
                .sort((a, b) => getNodeWeight(b) - getNodeWeight(a))
                .slice(0, 20)
                .map((n) => n.id)
        );
        S.graphNodes = S.graphAllNodes.filter((n) => topIds.has(n.id));
        S.graphEdges = S.graphAllEdges.filter((e) => topIds.has(e.source) && topIds.has(e.target));
        if (S.selectedNode && !topIds.has(S.selectedNode.id)) selectNode(null);
    } else {
        S.graphNodes = S.graphAllNodes;
        S.graphEdges = S.graphAllEdges;
    }
}

// ============================================================
// 节点颜色（按类型：笔记 teal / 卡片琥珀 / 碎片紫 / 标签 hash 柔和色）
// ============================================================
function getGraphNodeColor(node) {
    const type = String((node && node.type) || '').toLowerCase();
    if (GRAPH_TYPE_COLORS[type]) return GRAPH_TYPE_COLORS[type];
    const tags = node && node.tags;
    if (!tags || !tags.length) return GRAPH_DEFAULT_COLOR;
    const tag = String(tags[0]);
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
        hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
    }
    return GRAPH_TAG_COLORS[hash % GRAPH_TAG_COLORS.length];
}

// ============================================================
// Canvas 渲染
// ============================================================
function renderGraph() {
    const canvas = document.getElementById('graph-canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('graph-container');
    const rect = container.getBoundingClientRect();

    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = GRAPH_CREAM;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 悬停高亮：该节点 + 邻接节点/边保持全亮，其余降至 30% 透明度
    const hoverId = hoverNode ? hoverNode.id : null;
    let hoverNeighbors = null;
    if (hoverId) {
        hoverNeighbors = new Set([hoverId]);
        for (const e of S.graphEdges) {
            if (e.source === hoverId) hoverNeighbors.add(e.target);
            if (e.target === hoverId) hoverNeighbors.add(e.source);
        }
    }

    ctx.save();
    ctx.translate(S.graphPan.x, S.graphPan.y);
    ctx.scale(S.graphZoom, S.graphZoom);

    // 绘制连线（ink 低透明度；悬停时邻接边 teal 高亮）
    for (const edge of S.graphEdges) {
        const sourceNode = S.graphNodes.find(n => n.id === edge.source);
        const targetNode = S.graphNodes.find(n => n.id === edge.target);
        if (sourceNode && targetNode) {
            const adjacent = hoverNeighbors && (edge.source === hoverId || edge.target === hoverId);
            ctx.strokeStyle = adjacent ? GRAPH_TEAL : GRAPH_INK;
            ctx.globalAlpha = hoverNeighbors ? (adjacent ? 0.9 : 0.06) : 0.18;
            ctx.lineWidth = graphEdgeLineWidth(getEdgeWeight(edge)) / S.graphZoom;
            ctx.beginPath();
            ctx.moveTo(sourceNode.x, sourceNode.y);
            ctx.lineTo(targetNode.x, targetNode.y);
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;

    // 绘制节点
    for (const node of S.graphNodes) {
        const isSelected = S.selectedNode && S.selectedNode.id === node.id;
        const color = getGraphNodeColor(node);
        const dimmed = hoverNeighbors && !hoverNeighbors.has(node.id);

        ctx.globalAlpha = dimmed ? 0.3 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.size, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#fff' : color;
        ctx.fill();
        // 细描边（ink 10%）
        ctx.strokeStyle = 'rgba(21, 26, 25, 0.1)';
        ctx.lineWidth = 1 / S.graphZoom;
        ctx.stroke();

        const reviews = Number(node.reviews) || 0;
        if (reviews >= 3) {
            ctx.strokeStyle = '#EF4444';
            ctx.lineWidth = (isSelected ? 4 : 2.5) / S.graphZoom;
            ctx.stroke();
        } else if (isSelected) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 4 / S.graphZoom;
            ctx.stroke();
        }

        if (S.selectedGraphNodes.has(node.id)) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.size + 4 / S.graphZoom, 0, Math.PI * 2);
            ctx.strokeStyle = GRAPH_TEAL;
            ctx.lineWidth = 2.5 / S.graphZoom;
            ctx.stroke();
        }

        ctx.fillStyle = GRAPH_INK;
        ctx.font = `${11 / S.graphZoom}px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(node.label, node.x, node.y + node.size + 15 / S.graphZoom);
        ctx.globalAlpha = 1;
    }

    ctx.restore();
}

// ============================================================
// 物理模拟
// ============================================================
function simulatePhysics() {
    if (!S.graphNodes.length) return;

    const canvas = document.getElementById('graph-canvas');
    const width = canvas.width;
    const height = canvas.height;

    const repulsion = 10000;
    const attraction = 0.01;
    const damping = 0.9;
    const centerPull = 0.001;

    // 斥力
    for (let i = 0; i < S.graphNodes.length; i++) {
        for (let j = i + 1; j < S.graphNodes.length; j++) {
            const dx = S.graphNodes[i].x - S.graphNodes[j].x;
            const dy = S.graphNodes[i].y - S.graphNodes[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = repulsion / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            S.graphNodes[i].vx += fx;
            S.graphNodes[i].vy += fy;
            S.graphNodes[j].vx -= fx;
            S.graphNodes[j].vy -= fy;
        }
    }

    // 引力（边）
    for (const edge of S.graphEdges) {
        const sourceNode = S.graphNodes.find(n => n.id === edge.source);
        const targetNode = S.graphNodes.find(n => n.id === edge.target);
        if (sourceNode && targetNode) {
            const dx = sourceNode.x - targetNode.x;
            const dy = sourceNode.y - targetNode.y;
            const fx = -dx * attraction;
            const fy = -dy * attraction;
            sourceNode.vx += fx;
            sourceNode.vy += fy;
            targetNode.vx -= fx;
            targetNode.vy -= fy;
        }
    }

    // 中心引力
    const centerX = width / 2;
    const centerY = height / 2;
    for (const node of S.graphNodes) {
        node.vx += (centerX - node.x) * centerPull;
        node.vy += (centerY - node.y) * centerPull;
    }

    // 更新位置
    let moved = false;
    for (const node of S.graphNodes) {
        if (S.isNodeDragging && S.dragNode === node) continue;
        node.vx *= damping;
        node.vy *= damping;
        const oldX = node.x;
        const oldY = node.y;
        node.x += node.vx;
        node.y += node.vy;
        if (Math.abs(oldX - node.x) > 0.1 || Math.abs(oldY - node.y) > 0.1) {
            moved = true;
        }
    }

    renderGraph();

    if (moved) {
        physicsRafId = requestAnimationFrame(simulatePhysics);
    } else {
        physicsRafId = null;
    }
}

function startPhysics() {
    if (physicsRafId !== null) return;
    if (!S.graphNodes.length) return;
    physicsRafId = requestAnimationFrame(simulatePhysics);
}

export function stopPhysics() {
    if (physicsRafId !== null) {
        cancelAnimationFrame(physicsRafId);
        physicsRafId = null;
    }
}

// ============================================================
// 自适应缩放
// ============================================================
function fitGraph() {
    if (!S.graphNodes.length) return;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (const node of S.graphNodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x);
        maxY = Math.max(maxY, node.y);
    }

    const canvas = document.getElementById('graph-canvas');
    const padding = 80;
    const width = canvas.width - padding * 2;
    const height = canvas.height - padding * 2;
    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const scaleX = width / graphWidth;
    const scaleY = height / graphHeight;
    S.graphZoom = Math.min(scaleX, scaleY, 2);
    S.graphPan.x = (canvas.width - (minX + maxX) * S.graphZoom) / 2;
    S.graphPan.y = (canvas.height - (minY + maxY) * S.graphZoom) / 2;
    renderGraph();
}

// ============================================================
// 节点选择
// ============================================================
function selectNode(node) {
    S.selectedNode = node;
    const titleEl = document.getElementById('graph-selected-title');
    const infoEl = document.getElementById('graph-selected-info');
    const actionsEl = document.getElementById('graph-actions');

    if (node) {
        titleEl.textContent = node.name;
        infoEl.innerHTML = `
        <div style="margin-bottom:8px;">
          <strong>类型:</strong> ${escapeHtml(node.type || '普通笔记')}
        </div>
        <div style="margin-bottom:8px;">
          <strong>标签:</strong> ${escapeHtml((node.tags || []).join(', ')) || '无'}
        </div>
        <div style="margin-bottom:8px;">
          出现 ${Number(node.mentions) || 0} 次 · 复习 ${Number(node.reviews) || 0} 次
        </div>
      `;
        actionsEl.style.display = 'block';
    } else {
        titleEl.textContent = '选择节点';
        infoEl.textContent = '点击节点查看详细信息';
        actionsEl.style.display = 'none';
    }
    renderGraph();
}

function toggleGraphNodeSelection(node) {
    if (S.selectedGraphNodes.has(node.id)) {
        S.selectedGraphNodes.delete(node.id);
    } else {
        S.selectedGraphNodes.add(node.id);
    }
    updateGraphGenerateBtn();
    renderGraph();
}

// ============================================================
// 多选生成 PPT：统一走 #gen-modal（generate.mjs），星图节点作为来源
// ============================================================
function updateGraphGenerateBtn() {
    const btn = document.getElementById('btn-graph-generate-deck');
    if (!btn) return;
    const n = S.selectedGraphNodes.size;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `生成 PPT（${n}）` : '生成 PPT';
}

function openGraphGenerateModal() {
    const nodes = S.graphAllNodes
        .filter((n) => S.selectedGraphNodes.has(n.id))
        .map((n) => n.name || n.label || n.id);
    if (!nodes.length) { showToast('请先用 Shift+点击选择节点'); return; }
    if (!_openGenerateModal) return;
    _openGenerateModal({
        kind: 'graph',
        nodes,
        onDone: () => {
            S.selectedGraphNodes.clear();
            updateGraphGenerateBtn();
            renderGraph();
        }
    });
}

export function bindGraphDeckEvents() {
    document.getElementById('btn-graph-generate-deck')?.addEventListener('click', openGraphGenerateModal);
}

// ============================================================
// 事件绑定
// ============================================================
export function bindGraphEvents() {
    const canvas = document.getElementById('graph-canvas');
    const btnGraphRefresh = document.getElementById('btn-graph-refresh');
    const btnGraphFit = document.getElementById('btn-graph-fit');
    const btnGraphClose = document.getElementById('btn-graph-close');
    const btnOpenNote = document.getElementById('btn-open-note');
    const btnGeneratePpt = document.getElementById('btn-generate-ppt');

    btnGraphRefresh.addEventListener('click', refreshGraph);
    btnGraphFit.addEventListener('click', fitGraph);
    btnGraphClose?.addEventListener('click', () => {
        document.getElementById('graph-panel').classList.add('hidden');
        if (_switchSidebarTab) _switchSidebarTab('vault');
    });

    document.getElementById('graph-highfreq-toggle')?.addEventListener('change', (e) => {
        S.graphHighFreqOnly = e.target.checked;
        applyGraphView();
        renderGraph();
        startPhysics();
    });

    btnOpenNote.addEventListener('click', () => {
        if (S.selectedNode) {
            if (_switchSidebarTab) _switchSidebarTab('vault');
            if (_selectNote) _selectNote(S.selectedNode.name);
        }
    });

    btnGeneratePpt.addEventListener('click', () => {
        if (S.selectedNode && _openGenerateModal) {
            _openGenerateModal({ kind: 'note', name: S.selectedNode.name });
        }
    });

    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left - S.graphPan.x) / S.graphZoom;
        const y = (e.clientY - rect.top - S.graphPan.y) / S.graphZoom;

        for (const node of S.graphNodes) {
            const dx = x - node.x;
            const dy = y - node.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= node.size) {
                if (e.shiftKey) {
                    toggleGraphNodeSelection(node);
                    return;
                }
                if (S.selectedGraphNodes.size) {
                    S.selectedGraphNodes.clear();
                    updateGraphGenerateBtn();
                }
                S.isNodeDragging = true;
                S.dragNode = node;
                S.dragStart = { x, y };
                selectNode(node);
                return;
            }
        }

        S.isDragging = true;
        S.dragStart = { x: e.clientX - S.graphPan.x, y: e.clientY - S.graphPan.y };
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        if (S.isNodeDragging && S.dragNode) {
            const x = (e.clientX - rect.left - S.graphPan.x) / S.graphZoom;
            const y = (e.clientY - rect.top - S.graphPan.y) / S.graphZoom;
            S.dragNode.x = x;
            S.dragNode.y = y;
            renderGraph();
        } else if (S.isDragging) {
            S.graphPan.x = e.clientX - S.dragStart.x;
            S.graphPan.y = e.clientY - S.dragStart.y;
            renderGraph();
        } else {
            // 悬停高亮：命中节点时该节点与邻接边高亮，其余降透明度
            const x = (e.clientX - rect.left - S.graphPan.x) / S.graphZoom;
            const y = (e.clientY - rect.top - S.graphPan.y) / S.graphZoom;
            let hit = null;
            for (let i = S.graphNodes.length - 1; i >= 0; i--) {
                const n = S.graphNodes[i];
                const dx = x - n.x;
                const dy = y - n.y;
                if (Math.sqrt(dx * dx + dy * dy) <= n.size) { hit = n; break; }
            }
            if (hit !== hoverNode) {
                hoverNode = hit;
                canvas.style.cursor = hit ? 'pointer' : '';
                renderGraph();
            }
        }
    });

    canvas.addEventListener('mouseup', () => {
        S.isDragging = false;
        S.isNodeDragging = false;
        S.dragNode = null;
        startPhysics();
    });

    canvas.addEventListener('mouseleave', () => {
        S.isDragging = false;
        S.isNodeDragging = false;
        S.dragNode = null;
        if (hoverNode) { hoverNode = null; canvas.style.cursor = ''; renderGraph(); }
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const zoomFactor = e.deltaY > 0 ? 0.95 : 1.05;
        const newZoom = Math.max(0.2, Math.min(5, S.graphZoom * zoomFactor));
        const scaleChange = newZoom / S.graphZoom;
        S.graphPan.x = mouseX - (mouseX - S.graphPan.x) * scaleChange;
        S.graphPan.y = mouseY - (mouseY - S.graphPan.y) * scaleChange;
        S.graphZoom = newZoom;
        renderGraph();
    });

    // 知识星图按钮
    const btnVaultGraph = document.getElementById('btn-vault-graph');
    btnVaultGraph.addEventListener('click', () => {
        showGraphPanel();
    });
}
