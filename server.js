'use strict';

// Corporate proxy SSL inspection bypass (tesseract.js CDN download)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Prevent worker-thread errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const { v4: uuid } = require('uuid');
const archiver  = require('archiver');
const { spawn }  = require('child_process');
const ffmpeg     = require('fluent-ffmpeg');
const ffStatic   = require('ffmpeg-static');
const ffProbe    = require('@ffprobe-installer/ffprobe');
const { createWorker } = require('tesseract.js');
const YTDlpWrap  = require('yt-dlp-wrap').default;

ffmpeg.setFfmpegPath(ffStatic);
ffmpeg.setFfprobePath(ffProbe.path);

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const YTDLP_BIN  = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// ── Job store ─────────────────────────────────────────────────────────────────
const jobs = new Map();

function jobSet(id, updates) {
  const j = jobs.get(id);
  if (j) Object.assign(j, updates);
}

// ── FFmpeg helpers ────────────────────────────────────────────────────────────

function extractIntervalFrames(src, dir, intervalSec = 5) {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .outputOptions([
        '-vf', `fps=1/${intervalSec},scale=1280:-2`,
        '-q:v', '2',
        '-loglevel', 'error',
      ])
      .output(path.join(dir, 'iv_%04d.jpg'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function extractSceneFrames(src, dir, threshold = 0.35) {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve) => {
    // Escape the comma inside gt() for ffmpeg filter graph
    const filter = `select=gt(scene\\,${threshold}),scale=1280:-2`;
    ffmpeg(src)
      .outputOptions([
        '-vf', filter,
        '-vsync', 'vfr',
        '-q:v', '2',
        '-loglevel', 'error',
      ])
      .output(path.join(dir, 'sc_%04d.jpg'))
      .on('end', resolve)
      .on('error', (err) => {
        // Not fatal — some formats don't support scene detection
        console.warn('Scene detection skipped:', err.message.split('\n')[0]);
        resolve();
      })
      .run();
  });
}

// ── Perceptual hash deduplication ────────────────────────────────────────────

/**
 * Compute a 16×16 perceptual hash using FFmpeg raw pixel output.
 * No extra packages needed — uses the bundled ffmpeg-static binary.
 */
function getFrameHash(framePath) {
  return new Promise((resolve) => {
    const chunks = [];
    const proc = spawn(ffStatic, [
      '-i', framePath,
      '-vf', 'scale=16:16,format=gray',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-loglevel', 'error',
      'pipe:1',
    ]);
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 256) return resolve(null);
      const px   = Array.from(buf.slice(0, 256));
      const mean = px.reduce((a, b) => a + b, 0) / px.length;
      resolve(px.map(p => (p > mean ? 1 : 0)));
    });
    proc.on('error', () => resolve(null));
  });
}

function hashSim(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 0;
  let same = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] === h2[i]) same++;
  return same / h1.length;
}

/**
 * Remove near-duplicate frames from a directory.
 * Compares each frame against all previously kept frames.
 * Similarity threshold 0.90 = 90% of 256 hash bits must match.
 */
async function dedupeFrames(framesDir, threshold = 0.90) {
  const files = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.jpg'))
    .sort();

  const kept = []; // { hash }
  let removed = 0;

  for (const fname of files) {
    const fp   = path.join(framesDir, fname);
    const hash = await getFrameHash(fp);

    if (hash === null) continue; // can't hash → keep

    const isDup = kept.some(k => hashSim(hash, k) > threshold);
    if (isDup) {
      fs.unlinkSync(fp);
      removed++;
    } else {
      kept.push(hash);
    }
  }

  return removed;
}

// ── Text classification ───────────────────────────────────────────────────────

const AI_PATS = [
  'ai생성','ai가생성','ai로생성','ai제작','ai로제작','ai로만든',
  '인공지능생성','인공지능으로','ai영상','ai이미지','ai콘텐츠',
  'ai-generated','aigenerated','generatedbyai','createdbyai','madewithai',
  '딥페이크','deepfake','chatgpt','dall-e','dalle','midjourney',
  'stablediffusion','sora','ai합성','ai제작물','가상영상','syntheticvideo',
  'ai그림','ai작성','생성형ai','generativeai','이영상은ai',
];

const INV_PATS = [
  '투자유의','원금손실','투자위험','손실가능성','투자설명서',
  '투자주의','위험등급','고위험','금융투자','증권신고서',
  '손실위험','원금의일부','투자원금','원금비보장','투자권유',
  '투자판단','예금자보호','투자참고','금융감독원','한국거래소',
  '코스피','코스닥','매수매도','종목추천','주식투자','채권투자',
  'etf','리츠','reit','손실이발생','투자손실','이콘텐츠는투자',
  '투자에따른','과거수익률','미래수익','투자결과',
];

function classify(text) {
  const t = text.toLowerCase().replace(/[\s\n\r]/g, '');
  const cats = [];
  if (AI_PATS.some(p  => t.includes(p))) cats.push('ai');
  if (INV_PATS.some(p => t.includes(p))) cats.push('investment');
  return cats;
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const z = n => String(n).padStart(2, '0');
  return h > 0 ? `${z(h)}:${z(m % 60)}:${z(s % 60)}` : `${z(m)}:${z(s % 60)}`;
}

// ── Processing pipeline ───────────────────────────────────────────────────────

async function processJob(jobId, videoPath, options) {
  const framesDir = path.join(OUTPUT_DIR, jobId, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const fAI     = options.ai         || false;
  const fInvest = options.investment  || false;
  const fTitle  = options.title       || false;
  const fAll    = !(fAI || fInvest || fTitle);

  try {
    // 1. Extract frames ────────────────────────────────────────────────────────
    jobSet(jobId, { progress: 5, message: '장면 변환 감지 중...' });
    await extractSceneFrames(videoPath, framesDir, 0.35);

    jobSet(jobId, { progress: 15, message: '구간별 프레임 추출 중...' });
    await extractIntervalFrames(videoPath, framesDir, 5);

    // 1b. Deduplicate ──────────────────────────────────────────────────────────
    const beforeDedup = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).length;
    jobSet(jobId, { progress: 20, message: `중복 프레임 제거 중... (${beforeDedup}개 → 분석 중)` });
    const removed = await dedupeFrames(framesDir, 0.90);
    if (removed > 0) {
      console.log(`[dedup] ${removed}개 중복 프레임 제거됨`);
    }

    const allFrames = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort();

    if (allFrames.length === 0) {
      jobSet(jobId, { status: 'error', message: '프레임 추출 실패. 영상 파일이 올바른지 확인하세요.' });
      return;
    }

    const total = allFrames.length;
    const dedupMsg = removed > 0
      ? `중복 ${removed}개 제거 → ${total}개 프레임 분석 시작...`
      : `${total}개 프레임 텍스트 분석 시작...`;
    jobSet(jobId, { progress: 25, message: dedupMsg });

    // 2. OCR ──────────────────────────────────────────────────────────────────
    let worker = null;
    let ocrAvailable = true;

    try {
      jobSet(jobId, { progress: 25, message: '한국어 OCR 모델 로딩 중...' });
      worker = await createWorker('kor+eng', 1, { logger: () => {} });
    } catch (e1) {
      console.warn('Korean OCR 로드 실패, 영어만 시도:', e1.message);
      try {
        worker = await createWorker('eng', 1, { logger: () => {} });
      } catch (e2) {
        console.warn('OCR 로드 실패 — 텍스트 분류 없이 프레임만 추출:', e2.message);
        ocrAvailable = false;
      }
    }

    const results = [];
    const INTERVAL_SEC = 5;

    for (let i = 0; i < allFrames.length; i++) {
      const fname = allFrames[i];
      const fp    = path.join(framesDir, fname);
      const pct   = 25 + Math.floor((i / total) * 68);

      jobSet(jobId, {
        progress: pct,
        message:  ocrAvailable
          ? `텍스트 분석 중... (${i + 1}/${total})`
          : `프레임 처리 중... (${i + 1}/${total})`,
      });

      let text = '';
      if (ocrAvailable && worker) {
        try {
          const { data } = await worker.recognize(fp);
          text = data.text || '';
        } catch { /* skip */ }
      }

      const cats = classify(text);

      // Mark first frames as title candidates
      const seq = parseInt(fname.split('_').pop(), 10);
      if ((fname.startsWith('sc_') && seq <= 1) ||
          (fname.startsWith('iv_') && seq <= 2)) {
        if (!cats.includes('title')) cats.push('title');
      }

      const ts = fname.startsWith('iv_') ? (seq - 1) * INTERVAL_SEC : 0;

      const include = fAll
        || (fAI     && cats.includes('ai'))
        || (fInvest && cats.includes('investment'))
        || (fTitle  && cats.includes('title'));

      if (include) {
        results.push({
          frame:      fname,
          categories: cats,
          text:       text.slice(0, 400),
          timestamp:  ts,
          ts_fmt:     fmtTime(ts),
        });
      }
    }

    if (worker) await worker.terminate().catch(() => {});

    jobSet(jobId, {
      status:       'completed',
      progress:     100,
      message:      `완료! ${results.length}개 장면 캡쳐됨 (${total}개 프레임 분석)`,
      results,
      total_frames: total,
    });

  } catch (err) {
    console.error('[processJob]', err);
    jobSet(jobId, { status: 'error', message: `처리 오류: ${err.message}` });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });

  const options = JSON.parse(req.body.options || '{}');
  const jobId   = uuid();
  const ext     = path.extname(req.file.originalname) || '.mp4';
  const dest    = path.join(UPLOAD_DIR, `${jobId}${ext}`);
  fs.renameSync(req.file.path, dest);

  jobs.set(jobId, { status: 'processing', progress: 0, message: '시작 중...', results: [] });
  processJob(jobId, dest, options).catch(err =>
    jobSet(jobId, { status: 'error', message: err.message })
  );
  res.json({ job_id: jobId });
});

app.post('/api/url', async (req, res) => {
  const { url, options = {} } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL이 없습니다' });

  const jobId = uuid();
  jobs.set(jobId, { status: 'downloading', progress: 0, message: '영상 다운로드 중...', results: [] });
  res.json({ job_id: jobId });

  setImmediate(async () => {
    try {
      if (!fs.existsSync(YTDLP_BIN)) {
        jobSet(jobId, { message: 'yt-dlp 바이너리 다운로드 중 (최초 1회)...' });
        await YTDlpWrap.downloadFromGithub(YTDLP_BIN);
      }

      const ytDlp   = new YTDlpWrap(YTDLP_BIN);
      const dlDir   = path.join(UPLOAD_DIR, jobId);
      fs.mkdirSync(dlDir, { recursive: true });

      await ytDlp.execPromise([
        url,
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '-o', path.join(dlDir, 'video.%(ext)s'),
        '--no-playlist',
      ]);

      const files = fs.readdirSync(dlDir);
      if (files.length === 0) {
        jobSet(jobId, { status: 'error', message: '다운로드된 파일을 찾을 수 없습니다' });
        return;
      }

      jobSet(jobId, { status: 'processing', progress: 5, message: '영상 처리 시작...' });
      await processJob(jobId, path.join(dlDir, files[0]), options);

    } catch (err) {
      jobSet(jobId, { status: 'error', message: `다운로드 오류: ${err.message}` });
    }
  });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다' });

  const r = { status: job.status, progress: job.progress, message: job.message };
  if (job.status === 'completed') {
    r.results      = job.results;
    r.total_frames = job.total_frames;
  }
  res.json(r);
});

app.get('/api/frame/:id/:fname', (req, res) => {
  const fp = path.join(OUTPUT_DIR, req.params.id, 'frames', req.params.fname);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '프레임 없음' });
  res.sendFile(fp);
});

app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'completed')
    return res.status(400).json({ error: '완료된 작업이 없습니다' });

  const dir = path.join(OUTPUT_DIR, req.params.id, 'frames');
  res.attachment('video_captures.zip');

  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.pipe(res);
  for (const r of job.results) {
    const fp = path.join(dir, r.frame);
    if (fs.existsSync(fp)) {
      const cats = r.categories.join('_') || 'scene';
      arc.file(fp, { name: `${r.ts_fmt.replace(/:/g, '-')}_${cats}_${r.frame}` });
    }
  }
  arc.finalize();
});

app.get('/api/download/:id/:fname', (req, res) => {
  const fp = path.join(OUTPUT_DIR, req.params.id, 'frames', req.params.fname);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '프레임 없음' });
  res.download(fp, req.params.fname);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  영상 장면 캡쳐 서비스 시작');
  console.log(`  브라우저에서 열기: http://localhost:${PORT}`);
  console.log('  종료: Ctrl+C\n');
});
