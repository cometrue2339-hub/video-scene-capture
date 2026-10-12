'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let currentJobId  = null;
let pollTimer     = null;
let allResults    = [];
let activeFilter  = 'all';
let selectedFile  = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initDropzone();
  initOptions();
  initFilters();
  initModal();
  initButtons();
});

// ── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-pane').forEach(p => {
        p.classList.toggle('hidden', p.id !== `pane-${key}`);
        p.classList.toggle('active', p.id === `pane-${key}`);
      });
      updateStartBtn();
    });
  });
}

// ── Dropzone ──────────────────────────────────────────────────────────────────
function initDropzone() {
  const dz   = $('dropzone');
  const fi   = $('fileInput');
  const sel  = $('fileSelected');
  const name = $('fileName');
  const rm   = $('removeFile');

  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  fi.addEventListener('change', () => {
    if (fi.files[0]) setFile(fi.files[0]);
  });

  rm.addEventListener('click', e => {
    e.stopPropagation();
    clearFile();
  });

  function setFile(file) {
    selectedFile = file;
    name.textContent = file.name;
    dz.classList.add('hidden');
    sel.classList.remove('hidden');
    updateStartBtn();
  }

  function clearFile() {
    selectedFile = null;
    fi.value = '';
    dz.classList.remove('hidden');
    sel.classList.add('hidden');
    updateStartBtn();
  }
}

// ── Options ───────────────────────────────────────────────────────────────────
function initOptions() {
  const cards = {
    all:    { card: $('card-all'),    cb: $('optAll') },
    ai:     { card: $('card-ai'),     cb: $('optAI') },
    invest: { card: $('card-invest'), cb: $('optInvest') },
    title:  { card: $('card-title'),  cb: $('optTitle') },
  };

  Object.entries(cards).forEach(([key, { card, cb }]) => {
    card.addEventListener('click', () => {
      cb.checked = !cb.checked;
      card.classList.toggle('active', cb.checked);

      if (key === 'all' && cb.checked) {
        // Deselect specifics when "all" is picked
        ['ai', 'invest', 'title'].forEach(k => {
          cards[k].cb.checked = false;
          cards[k].card.classList.remove('active');
        });
      } else if (key !== 'all' && cb.checked) {
        // Deselect "all" when a specific is picked
        cards.all.cb.checked = false;
        cards.all.card.classList.remove('active');
      }

      // Ensure at least one option
      const anyChecked = Object.values(cards).some(v => v.cb.checked);
      if (!anyChecked) {
        cards.all.cb.checked = true;
        cards.all.card.classList.add('active');
      }
    });
  });
}

function getOptions() {
  return {
    ai:         $('optAI').checked,
    investment: $('optInvest').checked,
    title:      $('optTitle').checked,
    // "all" means no specific filter; backend uses absence of specific flags
  };
}

// ── Filters ───────────────────────────────────────────────────────────────────
function initFilters() {
  document.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderGrid();
    });
  });
}

// ── Buttons ───────────────────────────────────────────────────────────────────
function initButtons() {
  $('startBtn').addEventListener('click', handleStart);
  $('downloadAllBtn').addEventListener('click', handleDownloadAll);
  $('newCaptureBtn').addEventListener('click', resetToUpload);

  // URL input enables button on Enter
  $('urlInput').addEventListener('input', updateStartBtn);
  $('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleStart(); });
}

function updateStartBtn() {
  const isFileTab = $('pane-file').classList.contains('active');
  const ready = isFileTab ? !!selectedFile : $('urlInput').value.trim().length > 0;
  $('startBtn').disabled = !ready;
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function handleStart() {
  const isFileTab = $('pane-file').classList.contains('active');
  const options   = getOptions();

  showProgress();

  try {
    let res;
    if (isFileTab) {
      const form = new FormData();
      form.append('video', selectedFile);
      form.append('options', JSON.stringify(options));
      res = await fetch('/api/upload', { method: 'POST', body: form });
    } else {
      const url = $('urlInput').value.trim();
      res = await fetch('/api/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, options }),
      });
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '서버 오류');

    currentJobId = data.job_id;
    startPolling();
  } catch (err) {
    showError(err.message);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1800);
  poll(); // immediate first check
}

async function poll() {
  if (!currentJobId) return;
  try {
    const res  = await fetch(`/api/status/${currentJobId}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error);

    updateProgress(data.progress, data.message);

    if (data.status === 'completed') {
      clearInterval(pollTimer);
      allResults = data.results || [];
      showResults(data.total_frames);
    } else if (data.status === 'error') {
      clearInterval(pollTimer);
      showError(data.message);
    }
  } catch (err) {
    // network hiccup – keep polling
    console.warn('Poll error:', err);
  }
}

// ── UI state machines ─────────────────────────────────────────────────────────
function showProgress() {
  $('uploadCard').classList.add('hidden');
  $('progressCard').classList.remove('hidden');
  $('resultsCard').classList.add('hidden');
  updateProgress(0, '시작 중...');
}

function updateProgress(pct, msg) {
  $('progressBar').style.width = pct + '%';
  $('progressMsg').textContent = msg;
  $('progressTitle').textContent = pct < 100 ? '처리 중...' : '완료!';
}

function showResults(totalFrames) {
  $('progressCard').classList.add('hidden');
  $('resultsCard').classList.remove('hidden');
  $('resultsSub').textContent =
    `${allResults.length}개 장면 캡쳐됨 (전체 ${totalFrames}개 프레임 분석)`;
  renderGrid();
}

function showError(msg) {
  $('progressCard').classList.add('hidden');
  $('uploadCard').classList.remove('hidden');

  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'background:rgba(239,68,68,.15);border:1px solid #ef4444;border-radius:8px;padding:.9rem 1rem;margin-bottom:1rem;font-size:.9rem;color:#ef4444;';
  errDiv.textContent = '오류: ' + msg;

  const card = $('uploadCard');
  const existing = card.querySelector('.error-banner');
  if (existing) existing.remove();
  errDiv.className = 'error-banner';
  card.insertBefore(errDiv, card.firstChild);

  setTimeout(() => errDiv.remove(), 6000);
}

function resetToUpload() {
  clearInterval(pollTimer);
  currentJobId = null;
  allResults   = [];

  $('uploadCard').classList.remove('hidden');
  $('progressCard').classList.add('hidden');
  $('resultsCard').classList.add('hidden');
  $('framesGrid').innerHTML = '';
}

// ── Render grid ───────────────────────────────────────────────────────────────
const BADGE_MAP = {
  ai:         { label: '🤖 AI 생성',  cls: 'badge-ai' },
  investment: { label: '⚠️ 투자유의', cls: 'badge-invest' },
  title:      { label: '🏷️ 타이틀',   cls: 'badge-title' },
};

function renderGrid() {
  const grid  = $('framesGrid');
  const empty = $('emptyState');
  grid.innerHTML = '';

  const visible = allResults.filter(r => {
    if (activeFilter === 'all')   return true;
    if (activeFilter === 'scene') return r.categories.length === 0;
    return r.categories.includes(activeFilter);
  });

  if (visible.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  visible.forEach(r => {
    const card = document.createElement('div');
    card.className = 'frame-card';
    card.innerHTML = `
      <img src="/api/frame/${currentJobId}/${r.frame}" alt="프레임" loading="lazy">
      <div class="frame-meta">
        <div class="frame-badges">${makeBadges(r.categories)}</div>
        <div class="frame-ts">&#9201; ${r.ts_fmt || '00:00'}</div>
      </div>
    `;
    card.addEventListener('click', () => openModal(r));
    grid.appendChild(card);
  });
}

function makeBadges(cats) {
  if (!cats || cats.length === 0)
    return `<span class="badge badge-scene">장면</span>`;
  return cats.map(c => {
    const b = BADGE_MAP[c];
    return b ? `<span class="badge ${b.cls}">${b.label}</span>` : '';
  }).join('');
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function initModal() {
  $('modalClose').addEventListener('click', closeModal);
  $('modalOverlay').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function openModal(r) {
  $('modalImg').src      = `/api/frame/${currentJobId}/${r.frame}`;
  $('modalBadges').innerHTML = makeBadges(r.categories);
  $('modalTs').textContent   = `타임스탬프: ${r.ts_fmt || '00:00'}`;
  $('modalOcr').textContent  = r.text || '';

  const dlBtn = $('modalDl');
  dlBtn.href = `/api/download/${currentJobId}/${r.frame}`;
  dlBtn.download = r.frame;

  $('modal').classList.remove('hidden');
  $('modalOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('modalOverlay').classList.add('hidden');
  document.body.style.overflow = '';
}

// ── Download all ──────────────────────────────────────────────────────────────
function handleDownloadAll() {
  if (!currentJobId) return;
  const a = document.createElement('a');
  a.href = `/api/download/${currentJobId}`;
  a.download = 'video_captures.zip';
  a.click();
}
