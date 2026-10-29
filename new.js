/* =========================================================
   WordSnap 2.1 (Open Source Version)
   - 浏览模式（默认）：可上下拖动页面；单击中英切换；双击词典弹窗
   - 标记模式（悬浮窗开关）：页面锁定，画完整红圈 = 本轮没记住
   - 完成本轮：只保留本轮圈住的词，直到某轮 0 个圈
========================================================= */

const $ = (id) => document.getElementById(id);
const wordPane = $('wordPane');
const wordStage = $('wordStage');
const wordGrid = $('wordGrid');
const canvasEl = $('drawCanvas');
const ctx = canvasEl.getContext('2d');
const orbWrap = $('orbWrap');
const orb = $('orb');
const toolMenu = $('toolMenu');

/* =========================================================
   ⚠️ 注意：请在此处替换为你自己部署的腾讯云函数 URL
   ========================================================= */
const OCR_FN_URL = 'YOUR_OCR_FUNCTION_URL_HERE';     // 例如: 'https://xxx.ap-nanjing.tencentscf.com/'
const TRANS_FN_URL = 'YOUR_TRANS_FUNCTION_URL_HERE'; // 例如: 'https://xxx.ap-nanjing.tencentscf.com/'

if (OCR_FN_URL.includes('YOUR_OCR') || TRANS_FN_URL.includes('YOUR_TRANS')) {
  console.warn('⚠️ 提示：你尚未配置云函数接口，请修改 new.js 顶部的 OCR_FN_URL 和 TRANS_FN_URL。');
}

const TAP_WINDOW_MS = 270;   // 单击等待时间 = 双击判定时间（两者必须相同）

const state = {
  allItems: [],
  roundItems: [],
  cards: [],
  globalZh: false,
  round: 1,
  completed: false,
  sessions: [],
  cropper: null,
  markMode: false,
  pointerId: null,
  startPoint: null,
  currentStroke: [],
  isDrawing: false,
  strokes: [],
  tapTimer: null,
  lastTapCard: null,
  modalWord: ''
};

const transCache = new Map();
const detailCache = new Map();
const pendingMap = new Map();
const detailPendingMap = new Map();

/* =========================================================
   通用工具
========================================================= */
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function uniqueWords(words) {
  const seen = new Set();
  const out = [];
  for (const raw of words || []) {
    const word = String(raw || '').trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 300) break;
  }
  return out;
}

function escapeText(value) {
  return String(value == null ? '' : value);
}

/* =========================================================
   翻译 API
========================================================= */
async function apiPost(payload, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TRANS_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTranslation(word) {
  const key = String(word || '').toLowerCase();
  if (!key) return '暂无释义';
  if (transCache.has(key)) return transCache.get(key);
  if (pendingMap.has(key)) return pendingMap.get(key);

  const p = (async () => {
    try {
      const data = await apiPost({ action: 'translate', text: word }, 4500);
      const result = data.translation || '暂无释义';
      transCache.set(key, result);
      return result;
    } catch (err) {
      console.error(`[翻译失败] ${word}:`, err);
      return '翻译暂不可用';
    }
  })();

  pendingMap.set(key, p);
  p.finally(() => pendingMap.delete(key));
  return p;
}

async function fetchBatchTranslations(words) {
  const unique = uniqueWords(words);
  const need = unique.filter((w) => !transCache.has(w.toLowerCase()));
  if (!need.length) return;

  try {
    const data = await apiPost({ action: 'batch', texts: need }, 6500);
    const map = data.translations || {};
    for (const word of need) {
      const value = map[word.toLowerCase()] || map[word] || '';
      if (value) transCache.set(word.toLowerCase(), value);
    }
  } catch (err) {
    console.error('批量翻译失败:', err);
  }
}

async function fetchWordDetail(word) {
  const key = String(word || '').toLowerCase();
  if (detailCache.has(key)) return detailCache.get(key);
  if (detailPendingMap.has(key)) return detailPendingMap.get(key);

  const p = (async () => {
    const data = await apiPost({ action: 'detail', word }, 7000);
    detailCache.set(key, data);
    return data;
  })();

  detailPendingMap.set(key, p);
  p.finally(() => detailPendingMap.delete(key));
  return p;
}

/* =========================================================
   OCR
========================================================= */
async function recognizeWords(imageSrc) {
  setProgress(0.28, '上传图片至云端识别…');

  const response = await fetch(OCR_FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageSrc })
  });
  if (!response.ok) throw new Error('OCR 网络请求失败');

  setProgress(0.72, '识别完成，正在整理单词…');
  const result = await response.json();
  if (result.code !== 0 || !Array.isArray(result.words)) {
    throw new Error(result.message || 'OCR 未返回有效数据');
  }

  const boxes = [];
  for (const w of result.words) {
    const text = acceptWord(w.text, Number(w.confidence || 0));
    if (text) {
      boxes.push({
        text, x0: Number(w.x0 || 0), y0: Number(w.y0 || 0),
        x1: Number(w.x1 || 0), y1: Number(w.y1 || 0)
      });
    }
  }

  const ordered = uniqueWords(orderByColumns(boxes));
  if (ordered.length) return ordered;
  return parseWords(result.words.map((w) => w.text).join(' '));
}

const FORCE_BLACKLIST = new Set([
  'tt', 'hndi', "im' hndi", 'utoe', 'oeihinic', '4#', '0', '12', 'unit 12', 'raima', 'ture', 'the summ', 'the sumnd',
  '本单元词汇预览', 'll', 're', 've', 'd', 'm', 's', 't', 'lll', '®', '□', '叫', '豊四', '看见一全景', '对天', '214', '■',
  'ma', 'fc', 'in', 'ic', 'i', 'b', ' #', 'stab', '*t'
]);
const MINI_WHITELIST = new Set(['a','an','as','at','be','by','do','go','he','if','is','it','me','my','no','of','on','or','so','to','up','us','we']);

function cleanToken(t) {
  let s = String(t || '').trim();
  const lower = s.toLowerCase();
  if (FORCE_BLACKLIST.has(lower)) return '';
  if (lower === '] fgure' || lower === 'fgure') return 'figure';
  if (lower === 'deline') return 'define';
  if (lower === 'z00m') return 'zoom';
  if (lower === ']underestimate') return 'underestimate';
  if (lower === ']underlie') return 'underlie';
  if (lower === '" technical') return 'technical';
  if (lower === 'i temptation') return 'temptation';
  if (lower === 'behavio(u)r') return 'behavio(u)r';

  s = s.replace(/^[^A-Za-z]+|[^A-Za-z)]+$/g, '');
  s = s.replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 40) return '';
  if (!/^[A-Za-z][A-Za-z'’\/() -]*$/.test(s)) return '';
  return s;
}

function normalizeCase(text) { return text ? text.toLowerCase() : text; }

function acceptWord(piece, conf) {
  let text = cleanToken(piece);
  if (!text) {
    const rawLower = String(piece || '').trim().toLowerCase();
    if (MINI_WHITELIST.has(rawLower) && conf >= 50) return rawLower;
    return null;
  }
  const lower = text.toLowerCase();
  if (conf >= 85) return normalizeCase(text);
  if (/^[a-z][a-z'-]*$/.test(lower) || MINI_WHITELIST.has(lower)) return normalizeCase(text);
  return null;
}

function parseWords(text) {
  const tokens = String(text || '')
    .replace(/[^A-Za-z\s'’\/()-]/g, ' ')
    .split(/\s+/)
    .map(cleanToken)
    .filter(Boolean)
    .map(normalizeCase);
  return uniqueWords(tokens);
}

function orderByColumns(items) {
  if (!items.length) return [];
  const heights = items.map((w) => Math.max(1, w.y1 - w.y0)).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 20;
  const gapTol = medH * 0.6;
  const byX = items.slice().sort((a, b) => a.x0 - b.x0);
  const cols = [];
  let cur = null;

  for (const w of byX) {
    if (cur && w.x0 <= cur.x1 + gapTol) {
      cur.items.push(w);
      cur.x1 = Math.max(cur.x1, w.x1);
    } else {
      cur = { x1: w.x1, items: [w] };
      cols.push(cur);
    }
  }

  const result = [];
  for (const col of cols) {
    const byY = col.items.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const rows = [];
    for (const w of byY) {
      const cy = (w.y0 + w.y1) / 2;
      const last = rows[rows.length - 1];
      if (last && Math.abs(cy - last.cy) <= medH * 0.5) {
        last.items.push(w);
        last.cy = last.items.reduce((sum, it) => sum + (it.y0 + it.y1) / 2, 0) / last.items.length;
      } else {
        rows.push({ cy, items: [w] });
      }
    }
    for (const row of rows) {
      row.items.sort((a, b) => a.x0 - b.x0);
      for (const item of row.items) result.push(item.text);
    }
  }
  return result;
}

/* =========================================================
   图片读取 / 压缩
========================================================= */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function compressImage(src, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(src);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

/* =========================================================
   画布：完整闭环检测
========================================================= */
const DPR = Math.min(window.devicePixelRatio || 1, 2);
let drawRaf = 0;

function resizeCanvas() {
  const w = Math.max(1, wordStage.clientWidth);
  const h = Math.max(1, wordStage.offsetHeight, wordPane.clientHeight);
  const pw = Math.round(w * DPR);
  const ph = Math.round(h * DPR);

  if (canvasEl.width !== pw || canvasEl.height !== ph) {
    canvasEl.width = pw;
    canvasEl.height = ph;
    canvasEl.style.width = w + 'px';
    canvasEl.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  redrawCanvas();
}

function eventPoint(e) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function drawOneStroke(points) {
  if (!points || points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(239,68,68,.90)';
  ctx.lineWidth = 5.5;
  ctx.shadowColor = 'rgba(239,68,68,.35)';
  ctx.shadowBlur = 8;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function redrawCanvas() {
  const w = canvasEl.width / DPR;
  const h = canvasEl.height / DPR;
  ctx.clearRect(0, 0, w, h);

  const now = Date.now();
  state.strokes = state.strokes.filter((s) => s.expiresAt > now);
  for (const stroke of state.strokes) drawOneStroke(stroke.points);
  if (state.isDrawing) drawOneStroke(state.currentStroke);
}

function addTransientStroke(points) {
  const stroke = {
    id: Date.now() + Math.random(),
    points: points.map((p) => ({ x: p.x, y: p.y })),
    expiresAt: Date.now() + 3000
  };
  state.strokes.push(stroke);
  redrawCanvas();
  setTimeout(() => redrawCanvas(), 3050);
}

function pathStats(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    if (i > 0) length += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
  }

  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area2 += a.x * b.y - b.x * a.y;
  }

  return {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY,
    length,
    area: Math.abs(area2) / 2
  };
}

function wrappedAngleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function isCompleteCircle(points) {
  if (!points || points.length < 12) return false;
  const s = pathStats(points);
  const minDim = Math.min(s.width, s.height);
  if (minDim < 34 || s.length < 95) return false;

  const start = points[0];
  const end = points[points.length - 1];
  const closeDist = Math.hypot(end.x - start.x, end.y - start.y);
  const allowedGap = Math.max(20, minDim * 0.34);
  if (closeDist > allowedGap) return false;

  const bboxArea = Math.max(1, s.width * s.height);
  if (s.area / bboxArea < 0.28) return false;

  const cx = (s.minX + s.maxX) / 2;
  const cy = (s.minY + s.maxY) / 2;
  let sweep = 0;
  let prev = Math.atan2(points[0].y - cy, points[0].x - cx);
  for (let i = 1; i < points.length; i++) {
    const angle = Math.atan2(points[i].y - cy, points[i].x - cx);
    sweep += wrappedAngleDelta(prev, angle);
    prev = angle;
  }
  if (Math.abs(sweep) < Math.PI * 1.62) return false;

  const aspect = Math.max(s.width, s.height) / Math.max(1, minDim);
  if (aspect > 4.5) return false;

  return true;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getCardCenterOnCanvas(card) {
  const c = card.getBoundingClientRect();
  const r = canvasEl.getBoundingClientRect();
  return { x: c.left + c.width / 2 - r.left, y: c.top + c.height / 2 - r.top };
}

function markWrongByCircle(points) {
  if (!isCompleteCircle(points)) {
    if (pathStats(points).length > 70) toast('没有形成完整闭环，不计错');
    return;
  }

  let hit = 0;
  for (const card of state.cards) {
    const center = getCardCenterOnCanvas(card);
    if (!pointInPolygon(center, points)) continue;

    const item = getItemFromCard(card);
    if (!item) continue;
    if (!item.markedThisRound) {
      item.markedThisRound = true;
      hit += 1;
    }
    card.classList.add('marked'); 
    card.classList.remove('just-marked');
    void card.offsetWidth;
    card.classList.add('just-marked');
  }

  if (hit > 0) {
    updateRoundUI();
    toast(`本轮已标错 ${markedCount()} 个`);
  } else {
    toast('完整圈已识别，但没有圈中新单词');
  }
}

function markedCount() {
  return state.roundItems.filter((x) => x.markedThisRound).length;
}

canvasEl.addEventListener('pointerdown', (e) => {
  if (!state.markMode) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { canvasEl.setPointerCapture(e.pointerId); } catch (_) {}

  state.pointerId = e.pointerId;
  const p = eventPoint(e);
  state.startPoint = p;
  state.currentStroke = [p];
  state.isDrawing = false;
});

canvasEl.addEventListener('pointermove', (e) => {
  if (state.pointerId !== e.pointerId || !state.startPoint) return;
  const p = eventPoint(e);
  const dist = Math.hypot(p.x - state.startPoint.x, p.y - state.startPoint.y);

  if (!state.isDrawing && dist > 8) state.isDrawing = true;
  if (!state.isDrawing) return;

  e.preventDefault();
  const last = state.currentStroke[state.currentStroke.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) state.currentStroke.push(p);
  cancelAnimationFrame(drawRaf);
  drawRaf = requestAnimationFrame(redrawCanvas);
});

function finishPointer(e, cancelled) {
  if (state.pointerId !== e.pointerId || !state.startPoint) return;
  const end = eventPoint(e);
  const dist = Math.hypot(end.x - state.startPoint.x, end.y - state.startPoint.y);
  const wasDrawing = state.isDrawing;
  const points = state.currentStroke.slice();

  state.pointerId = null;
  state.startPoint = null;
  state.currentStroke = [];
  state.isDrawing = false;

  if (cancelled) {
    redrawCanvas();
    return;
  }

  if (!wasDrawing && dist <= 8) {
    redrawCanvas();
    const card = findCardAtClientPoint(e.clientX, e.clientY);
    if (card) handleTapGesture(card);
    return;
  }

  if (points.length >= 2) {
    addTransientStroke(points);
    markWrongByCircle(points);
  }
}

canvasEl.addEventListener('pointerup', (e) => finishPointer(e, false));
canvasEl.addEventListener('pointercancel', (e) => finishPointer(e, true));

let browseTap = null;

wordGrid.addEventListener('pointerdown', (e) => {
  if (state.markMode) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  browseTap = { id: e.pointerId, x: e.clientX, y: e.clientY };
});

wordGrid.addEventListener('pointerup', (e) => {
  if (state.markMode || !browseTap || browseTap.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - browseTap.x, e.clientY - browseTap.y);
  browseTap = null;
  if (moved > 8) return;
  const card = e.target && e.target.closest ? e.target.closest('.word-card') : null;
  if (card) handleTapGesture(card);
});

wordGrid.addEventListener('pointercancel', () => { browseTap = null; });

function setMarkMode(on, silent) {
  state.markMode = !!on;
  document.body.classList.toggle('mark-mode', state.markMode);

  const btn = $('btnMarkMode');
  if (btn) {
    btn.classList.toggle('active', state.markMode);
    btn.textContent = state.markMode ? '🖐 退出标记（可拖动）' : '✏️ 标记模式';
  }

  state.pointerId = null;
  state.startPoint = null;
  state.currentStroke = [];
  state.isDrawing = false;
  browseTap = null;
  redrawCanvas();

  if (!silent) {
    toast(state.markMode ? '标记模式：页面已锁定，画完整红圈标记' : '浏览模式：可上下拖动页面');
  }
}

function createStudyItems(words) {
  return uniqueWords(words).map((word, index) => ({
    id: `w_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    en: word,
    errorCount: 0,
    markedThisRound: false
  }));
}

function startStudy(words) {
  state.allItems = createStudyItems(words);
  state.roundItems = state.allItems.slice();
  state.round = 1;
  state.completed = false;
  state.globalZh = false;
  state.strokes = [];
  renderCurrentRound();
}

function getItemFromCard(card) {
  const id = card && card.dataset.itemId;
  return state.roundItems.find((item) => item.id === id) || null;
}

function setCardText(card, text) {
  const el = card.querySelector('.word-text');
  if (!el) return;
  el.textContent = escapeText(text);
  requestAnimationFrame(() => fitCard(card));
}

function applyErrorClass(card, count) {
  card.classList.remove('err-1', 'err-2', 'err-3');
  if (count >= 3) card.classList.add('err-3');
  else if (count === 2) card.classList.add('err-2');
  else if (count === 1) card.classList.add('err-1');
}

function fitCard(card) {
  const t = card.querySelector('.word-text');
  if (!t) return;

  const base = Number(card.dataset.baseFont || 19);
  const avail = Math.max(30, card.clientWidth - 18);
  t.style.fontSize = base + 'px';
  t.style.transform = 'scaleX(1)';

  let contentW = t.scrollWidth;
  if (contentW <= avail) return;

  const target = Math.max(11, Math.floor((base * avail / contentW) * 10) / 10);
  t.style.fontSize = target + 'px';
  contentW = t.scrollWidth;

  if (contentW > avail) {
    const sx = clamp(avail / contentW, 0.68, 1);
    t.style.transform = `scaleX(${sx})`;
  }
}

function fitAllCards() { state.cards.forEach(fitCard); }

function layoutGrid() {
  const count = state.cards.length;
  if (!count) {
    resizeCanvas();
    return;
  }

  const stageStyle = getComputedStyle(wordStage);
  const padX = parseFloat(stageStyle.paddingLeft) + parseFloat(stageStyle.paddingRight);
  const padY = parseFloat(stageStyle.paddingTop) + parseFloat(stageStyle.paddingBottom);
  const availW = Math.max(240, wordStage.clientWidth - padX);
  const availH = Math.max(260, wordPane.clientHeight - padY);

  const isPhone = window.innerWidth < 700;
  const gap = isPhone ? 10 : 14;
  const minCardW = window.innerWidth < 430 ? 94 : (isPhone ? 106 : 136);
  const preferredCardH = isPhone ? (window.innerHeight < 700 ? 55 : 62) : 68;
  const minCardH = isPhone ? 48 : 60;
  const maxCardH = isPhone ? 76 : 80;

  const maxCols = Math.max(1, Math.floor((availW + gap) / (minCardW + gap)));
  const targetRows = Math.max(1, Math.floor((availH + gap) / (preferredCardH + gap)));

  let cols = clamp(Math.ceil(count / targetRows), 1, maxCols);
  if (count >= 2 && availW >= 220) cols = Math.max(2, cols);

  const rows = Math.ceil(count / cols);
  const rawH = (availH - gap * Math.max(0, rows - 1)) / rows;
  const cardH = clamp(rawH, minCardH, maxCardH);
  const baseFont = clamp(cardH * 0.31, 14, 20);

  wordGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0,1fr))`;
  wordGrid.style.gap = gap + 'px';
  for (const card of state.cards) {
    card.style.height = Math.floor(cardH) + "px";
    card.dataset.baseFont = String(baseFont);
  }

  requestAnimationFrame(() => {
    fitAllCards();
    resizeCanvas();
  });
}

function updateRoundUI() {
  const badge = $('roundBadge');
  const next = $('btnNextRound');
  const toggle = $('btnToggleAll');

  if (state.completed) {
    badge.textContent = `完成 · 共 ${state.round} 轮`;
    next.textContent = '✅ 已完成';
    next.disabled = true;
    toggle.disabled = true;
  } else {
    const marked = markedCount();
    badge.textContent = `第 ${state.round} 轮 · ${state.roundItems.length} 个单词` +
      (marked ? ` · 已圈 ${marked}` : '');
    next.textContent = '✨ 完成本轮';
    next.disabled = false;
    toggle.disabled = !state.roundItems.length;
  }
  updateToggleBtn();
}

function renderCurrentRound() {
  state.cards = [];
  state.globalZh = false;
  state.strokes = [];
  clearTimeout(state.tapTimer);
  state.tapTimer = null;
  state.lastTapCard = null;
  wordGrid.innerHTML = '';
  wordPane.scrollTop = 0;
  redrawCanvas();
  updateRoundUI();

  if (!state.roundItems.length) {
    renderCompletedState();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of state.roundItems) {
    const card = document.createElement('div');
    card.className = 'word-card';
    card.dataset.itemId = item.id;
    card.dataset.en = item.en;
    applyErrorClass(card, item.errorCount);
    if (item.markedThisRound) card.classList.add('marked');

    const text = document.createElement('span');
    text.className = 'word-text';
    text.textContent = item.en;
    card.appendChild(text);

    if (item.errorCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'error-badge';
      badge.textContent = `×${item.errorCount}`;
      card.appendChild(badge);
    }

    frag.appendChild(card);
    state.cards.push(card);
  }

  wordGrid.appendChild(frag);
  requestAnimationFrame(layoutGrid);
}

function renderCompletedState() {
  state.cards = [];
  wordGrid.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'grid-empty';
  box.innerHTML = '<div class="finish-orb">✨</div><b>这一轮全部记住了</b><span>没有任何完整红圈，本次记忆检测结束。<br>可以打开历史记录重练，或重新拍照。</span>';
  wordGrid.appendChild(box);
  updateRoundUI();
  requestAnimationFrame(resizeCanvas);
}

function finishRound() {
  if (state.completed || !state.roundItems.length) return;
  closeMenu();

  const wrong = state.roundItems.filter((item) => item.markedThisRound);
  if (!wrong.length) {
    state.completed = true;
    renderCompletedState();
    toast('本轮没有标错，检测完成');
    return;
  }

  for (const item of wrong) {
    item.errorCount += 1;
    item.markedThisRound = false;
  }

  state.round += 1;
  state.roundItems = wrong;
  state.globalZh = false;
  renderCurrentRound();
  toast(`进入第 ${state.round} 轮，仅保留 ${wrong.length} 个标错单词`);
}

function findCardAtClientPoint(x, y) {
  for (let i = state.cards.length - 1; i >= 0; i--) {
    const card = state.cards[i];
    const rect = card.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return card;
  }
  return null;
}

function handleTapGesture(card) {
  if (state.tapTimer && state.lastTapCard === card) {
    clearTimeout(state.tapTimer);
    state.tapTimer = null;
    state.lastTapCard = null;
    openWordModal(card.dataset.en);
    return;
  }

  if (state.tapTimer && state.lastTapCard && state.lastTapCard !== card) {
    clearTimeout(state.tapTimer);
    const prev = state.lastTapCard;
    state.tapTimer = null;
    state.lastTapCard = null;
    onCardClick(prev);
  }

  state.lastTapCard = card;
  state.tapTimer = setTimeout(() => {
    const target = state.lastTapCard;
    state.tapTimer = null;
    state.lastTapCard = null;
    if (target) onCardClick(target);
  }, TAP_WINDOW_MS);
}

async function onCardClick(card) {
  if (!card || !document.body.contains(card)) return;

  if (card.classList.contains('is-zh')) {
    setEnglish(card);
    return;
  }
  if (card.dataset.busy === '1') return;

  const en = card.dataset.en;
  const key = en.toLowerCase();
  if (transCache.has(key)) {
    showChinese(card, transCache.get(key));
    return;
  }

  card.dataset.busy = '1';
  card.classList.add('loading');
  setCardText(card, '…');

  const zh = await fetchTranslation(en);
  if (!document.body.contains(card)) return;

  card.classList.remove('loading');
  delete card.dataset.busy;
  showChinese(card, zh);
}

function showChinese(card, zh) {
  setCardText(card, zh || '暂无释义');
  card.classList.add('is-zh');
}

function setEnglish(card) {
  setCardText(card, card.dataset.en);
  card.classList.remove('is-zh', 'loading');
  delete card.dataset.busy;
}

function updateToggleBtn() {
  const btn = $('btnToggleAll');
  if (!btn) return;
  btn.textContent = state.globalZh ? '🔤 一键英文' : '🈶 一键中文';
}

async function toggleAll() {
  if (!state.cards.length) {
    toast('还没有单词可以切换');
    return;
  }

  state.globalZh = !state.globalZh;
  updateToggleBtn();

  if (!state.globalZh) {
    state.cards.forEach(setEnglish);
    return;
  }

  for (const card of state.cards) {
    const en = card.dataset.en;
    const cached = transCache.get(en.toLowerCase());
    card.classList.add('is-zh');
    setCardText(card, cached || '…');
  }

  await fetchBatchTranslations(state.cards.map((card) => card.dataset.en));

  if (!state.globalZh) return;
  for (const card of state.cards) {
    if (!card.classList.contains('is-zh')) continue;
    const en = card.dataset.en;
    setCardText(card, transCache.get(en.toLowerCase()) || '暂无释义');
  }
}

let modalOpenedAt = 0;

function openWordModal(word) {
  const modal = $('wordModal');
  modalOpenedAt = performance.now();
  state.modalWord = word;
  $('modalWord').textContent = word;
  $('modalPhonetic').textContent = '';
  $('modalBody').className = 'dict-loading';
  $('modalBody').textContent = '正在加载词典…';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');

  const key = word.toLowerCase();
  if (detailCache.has(key)) {
    renderWordDetail(detailCache.get(key));
    return;
  }

  fetchWordDetail(word)
    .then((detail) => {
      if (state.modalWord === word && modal.classList.contains('show')) renderWordDetail(detail);
    })
    .catch((err) => {
      console.error('词典详情失败:', err);
      if (state.modalWord !== word) return;
      const body = $('modalBody');
      body.className = '';
      body.textContent = '词典详情暂时加载失败，可以稍后再试。';
    });
}

function closeWordModal() {
  const modal = $('wordModal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
  state.modalWord = '';
}

function renderWordDetail(detail) {
  const body = $('modalBody');
  body.className = '';
  body.innerHTML = '';

  $('modalWord').textContent = detail.word || state.modalWord;
  $('modalPhonetic').textContent = detail.phonetic ? `/${detail.phonetic}/` : '点击右侧按钮发音';

  const meanings = Array.isArray(detail.meanings) ? detail.meanings : [];
  for (const group of meanings) {
    const block = document.createElement('section');
    block.className = 'meaning-block';

    const top = document.createElement('div');
    top.className = 'meaning-top';
    const pill = document.createElement('span');
    pill.className = 'pos-pill';
    pill.textContent = group.pos || '释义';
    top.appendChild(pill);
    block.appendChild(top);

    const list = document.createElement('div');
    list.className = 'meaning-list';
    const values = Array.isArray(group.translations) ? group.translations : [];
    for (const value of values) {
      const chip = document.createElement('span');
      chip.className = 'meaning-chip';
      chip.textContent = value;
      list.appendChild(chip);
    }
    block.appendChild(list);
    body.appendChild(block);
  }

  const examples = Array.isArray(detail.examples) ? detail.examples : [];
  if (examples.length) {
    const title = document.createElement('div');
    title.className = 'example-title';
    title.textContent = '例句';
    body.appendChild(title);

    for (const example of examples) {
      const item = document.createElement('div');
      item.className = 'example-item';
      if (example.pos) {
        const pos = document.createElement('div');
        pos.className = 'example-pos';
        pos.textContent = example.pos;
        item.appendChild(pos);
      }
      const en = document.createElement('div');
      en.className = 'example-en';
      en.textContent = example.en || '';
      item.appendChild(en);

      const zh = document.createElement('div');
      zh.className = 'example-zh';
      zh.textContent = example.zh || '暂无例句汉译';
      item.appendChild(zh);
      body.appendChild(item);
    }
  }
}

function speakCurrentWord() {
  const word = state.modalWord;
  if (!word) return;
  if (!('speechSynthesis' in window)) {
    toast('当前浏览器不支持系统语音');
    return;
  }

  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(word);
  utter.lang = 'en-US';
  utter.rate = 0.86;
  utter.pitch = 1;

  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((v) => /^en[-_]US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang));
  if (preferred) utter.voice = preferred;
  window.speechSynthesis.speak(utter);
}

function closeModalByClick() {
  if (performance.now() - modalOpenedAt < 400) return;
  closeWordModal();
}
$('wordModalClose').addEventListener('click', closeModalByClick);
$('modalWord').addEventListener('click', closeModalByClick);
$('btnSpeak').addEventListener('click', (e) => { e.stopPropagation(); speakCurrentWord(); });
$('wordModal').addEventListener('click', (e) => { if (e.target === $('wordModal')) closeModalByClick(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWordModal(); });

function showOverlay(text, p) {
  $('overlay').classList.add('show');
  $('ovText').textContent = text || '';
  $('ovBar').style.width = Math.round((p || 0) * 100) + '%';
}
function setProgress(p, text) {
  $('ovBar').style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
  if (text) $('ovText').textContent = text;
}
function hideOverlay() {
  $('overlay').classList.remove('show');
  setTimeout(() => { $('ovBar').style.width = '0%'; }, 300);
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function showMainScreen() {
  $('startScreen').style.display = 'none';
  $('mainScreen').style.display = 'flex';
}

function backToStart() {
  state.allItems = [];
  state.roundItems = [];
  state.cards = [];
  state.round = 1;
  state.completed = false;
  state.globalZh = false;
  state.strokes = [];
  setMarkMode(false, true);
  updateToggleBtn();
  wordGrid.innerHTML = '';
  redrawCanvas();
  $('mainScreen').style.display = 'none';
  $('startScreen').style.display = 'flex';
  closeMenu();
  closeWordModal();
}

async function handleImage(dataUrl) {
  showMainScreen();
  wordGrid.innerHTML = '';
  state.cards = [];
  state.strokes = [];
  redrawCanvas();

  showOverlay('准备识别…', 0.02);
  try {
    const words = await recognizeWords(dataUrl);
    hideOverlay();
    startStudy(words);
    if (words.length) {
      addSession(dataUrl, words);
      toast(`识别到 ${words.length} 个单词`);
    } else {
      toast('没有识别到英文单词');
    }
  } catch (err) {
    hideOverlay();
    console.error(err);
    toast('识别失败：' + (err && err.message ? err.message : '未知错误'));
    startStudy([]);
  }
}

async function addSession(imgSrc, words) {
  const thumb = await compressImage(imgSrc, 180, 0.7);
  state.sessions.unshift({
    id: Date.now() + Math.random(),
    img: thumb,
    words: uniqueWords(words),
    time: new Date()
  });
  if (state.sessions.length > 12) state.sessions.pop();
  renderHistory();
}

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-mini">还没有记录</div>';
    return;
  }

  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const img = document.createElement('img');
    img.src = s.img;
    const meta = document.createElement('div');
    meta.className = 'hi-meta';

    const b = document.createElement('b');
    b.textContent = `${s.words.length} 个单词`;
    const span = document.createElement('span');
    span.textContent = s.time.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    meta.appendChild(b); meta.appendChild(span);
    item.appendChild(img); item.appendChild(meta);

    item.addEventListener('click', () => {
      closeHistory();
      showMainScreen();
      startStudy(s.words);
      toast('已从历史记录重新开始');
    });
    list.appendChild(item);
  }
}

$('btnStart').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const raw = await readFileAsDataURL(file);
    openCropper(raw);
  } catch (err) {
    console.error(err);
    toast('图片读取失败');
  }
});

function openCropper(imageSrc) {
  if (typeof Cropper === 'undefined') {
    alert('裁剪组件加载失败');
    return;
  }

  $('cropScreen').classList.add('active');
  const slider = $('rotateSlider');
  slider.value = 0;
  $('rotateVal').textContent = '0°';

  const img = $('cropImg');
  img.src = imageSrc;
  if (state.cropper) state.cropper.destroy();
  state.cropper = new Cropper(img, {
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 0.9,
    background: false,
    zoomable: true,
    rotatable: true,
    responsive: true
  });
}

$('btnCropCancel').addEventListener('click', () => {
  $('cropScreen').classList.remove('active');
  if (state.cropper) {
    state.cropper.destroy();
    state.cropper = null;
  }
});

$('btnCropConfirm').addEventListener('click', async () => {
  if (!state.cropper) return;
  $('cropScreen').classList.remove('active');
  const canvas = state.cropper.getCroppedCanvas({
    maxWidth: 1600,
    maxHeight: 1600,
    fillColor: '#fff',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high'
  });
  const base64Data = canvas.toDataURL('image/jpeg', 0.85);
  state.cropper.destroy();
  state.cropper = null;
  await handleImage(base64Data);
});

$('rotateSlider').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  $('rotateVal').textContent = val + '°';
  if (state.cropper) state.cropper.rotateTo(val);
});

$('btnNextRound').addEventListener('click', finishRound);
$('btnToggleAll').addEventListener('click', toggleAll);
$('btnMarkMode').addEventListener('click', () => {
  setMarkMode(!state.markMode);
  closeMenu();
});
$('btnRetake').addEventListener('click', () => {
  backToStart();
  setTimeout(() => $('fileInput').click(), 120);
});
$('btnHistory').addEventListener('click', () => {
  renderHistory();
  $('historyDrawer').classList.add('open');
  closeMenu();
});
$('hdClose').addEventListener('click', closeHistory);
$('historyDrawer').addEventListener('click', (e) => {
  if (e.target === $('historyDrawer')) closeHistory();
});
function closeHistory() { $('historyDrawer').classList.remove('open'); }

const ORB = 64;
const EDGE = 10;
const ORB_KEY = 'wordsnap_orb_v2';
const orbPos = { x: 0, y: 0 };
let orbSide = 'right';
let orbYRatio = 0.78;
let orbDrag = null;
let idleTimer = null;
let jellyTimer = null;
let landedTimer = null;
const vw = () => window.innerWidth;
const vh = () => window.innerHeight;

function clampOrb(x, y) {
  return {
    x: Math.min(Math.max(8, x), vw() - ORB - 8),
    y: Math.min(Math.max(8, y), vh() - ORB - 16)
  };
}
function setOrbPos(x, y, animate) {
  orbPos.x = x;
  orbPos.y = y;
  orbWrap.classList.toggle('snapping', !!animate);
  orbWrap.style.transform = `translate3d(${x}px,${y}px,0)`;
}
function saveOrb() {
  try { localStorage.setItem(ORB_KEY, JSON.stringify({ side: orbSide, y: orbYRatio })); } catch (_) {}
}
function loadOrb() {
  try {
    const s = JSON.parse(localStorage.getItem(ORB_KEY) || 'null');
    if (s && (s.side === 'left' || s.side === 'right') && typeof s.y === 'number') {
      orbSide = s.side;
      orbYRatio = clamp(s.y, 0, 1);
    }
  } catch (_) {}
}
function placeOrbFromState(animate) {
  const x = orbSide === 'left' ? EDGE : vw() - ORB - EDGE;
  const c = clampOrb(x, orbYRatio * vh());
  setOrbPos(c.x, c.y, animate);
}
function snapOrb(projX, projY) {
  orbSide = projX + ORB / 2 < vw() / 2 ? 'left' : 'right';
  const x = orbSide === 'left' ? EDGE : vw() - ORB - EDGE;
  const c = clampOrb(x, projY);
  orbYRatio = c.y / vh();
  setOrbPos(c.x, c.y, true);
  saveOrb();
  orbWrap.classList.remove('landed');
  void orbWrap.offsetWidth;
  orbWrap.classList.add('landed');
  clearTimeout(landedTimer);
  landedTimer = setTimeout(() => orbWrap.classList.remove('landed'), 650);
}
function placeMenu() {
  const w = toolMenu.offsetWidth;
  const h = toolMenu.offsetHeight;
  const cx = orbPos.x + ORB / 2;
  const cy = orbPos.y + ORB / 2;
  const above = cy > vh() / 2;

  let absX = cx > vw() / 2 ? orbPos.x + ORB - w : orbPos.x;
  absX = Math.min(Math.max(8, absX), vw() - w - 8);
  let absY = above ? orbPos.y - h - 12 : orbPos.y + ORB + 12;
  absY = Math.min(Math.max(8, absY), Math.max(8, vh() - h - 8));

  toolMenu.style.left = (absX - orbPos.x) + 'px';
  toolMenu.style.top = (absY - orbPos.y) + 'px';
  toolMenu.style.transformOrigin = `${cx - absX}px ${above ? h : 0}px`;
}
function openMenu() { placeMenu(); orbWrap.classList.add('open'); orbWrap.classList.remove('idle'); }
function closeMenu() { orbWrap.classList.remove('open'); wake(); }
function toggleMenu() { orbWrap.classList.contains('open') ? closeMenu() : openMenu(); }
function wake() {
  orbWrap.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!orbWrap.classList.contains('open') && !orbDrag) orbWrap.classList.add('idle');
  }, 3000);
}
function jelly(vx, vy) {
  const speed = Math.hypot(vx, vy);
  const s = 1 + Math.min(speed * 0.18, 0.3);
  const a = Math.atan2(vy, vx);
  orb.style.transform = `rotate(${a}rad) scale(${s * 1.08},${(1 / Math.sqrt(s)) * 1.08}) rotate(${-a}rad)`;
  clearTimeout(jellyTimer);
  jellyTimer = setTimeout(() => { orb.style.transform = 'scale(1.1)'; }, 70);
}

orb.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { orb.setPointerCapture(e.pointerId); } catch (_) {}
  wake();

  const rect = orbWrap.getBoundingClientRect();
  orbDrag = {
    id: e.pointerId,
    sx: e.clientX, sy: e.clientY,
    ox: rect.left, oy: rect.top,
    lx: e.clientX, ly: e.clientY,
    lt: performance.now(),
    vx: 0, vy: 0,
    moved: false
  };
  orbWrap.classList.add('pressed');
});

orb.addEventListener('pointermove', (e) => {
  if (!orbDrag || e.pointerId !== orbDrag.id) return;
  const dx = e.clientX - orbDrag.sx;
  const dy = e.clientY - orbDrag.sy;

  if (!orbDrag.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    orbDrag.moved = true;
    closeMenu();
    orbWrap.classList.add('dragging');
    orbWrap.classList.remove('snapping', 'landed');
  }

  const c = clampOrb(orbDrag.ox + dx, orbDrag.oy + dy);
  setOrbPos(c.x, c.y, false);

  const now = performance.now();
  const dt = Math.max(1, now - orbDrag.lt);
  orbDrag.vx = orbDrag.vx * 0.6 + ((e.clientX - orbDrag.lx) / dt) * 0.4;
  orbDrag.vy = orbDrag.vy * 0.6 + ((e.clientY - orbDrag.ly) / dt) * 0.4;
  orbDrag.lx = e.clientX;
  orbDrag.ly = e.clientY;
  orbDrag.lt = now;
  jelly(orbDrag.vx, orbDrag.vy);
});

function endOrbDrag(e, cancelled) {
  if (!orbDrag || e.pointerId !== orbDrag.id) return;
  const d = orbDrag;
  orbDrag = null;
  clearTimeout(jellyTimer);
  orbWrap.classList.remove('pressed', 'dragging');
  orb.style.transform = '';

  if (!d.moved) {
    if (!cancelled) toggleMenu();
    return;
  }
  snapOrb(orbPos.x + d.vx * 140, orbPos.y + d.vy * 140);
  wake();
}
orb.addEventListener('pointerup', (e) => endOrbDrag(e, false));
orb.addEventListener('pointercancel', (e) => endOrbDrag(e, true));
orb.addEventListener('click', (e) => { if (e.detail === 0) toggleMenu(); });
document.addEventListener('pointerdown', (e) => {
  if (!orbWrap.contains(e.target)) closeMenu();
});

function onViewportChange() {
  placeOrbFromState(false);
  layoutGrid();
  if (orbWrap.classList.contains('open')) placeMenu();
}
window.addEventListener('resize', () => {
  clearTimeout(window._rt);
  window._rt = setTimeout(onViewportChange, 120);
});
window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 320));
new ResizeObserver(() => requestAnimationFrame(layoutGrid)).observe(wordStage);

updateToggleBtn();
loadOrb();
placeOrbFromState(false);
wake();
renderHistory();
