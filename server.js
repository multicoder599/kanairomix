require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3025;
const TELEGRAM_LINK = process.env.TELEGRAM_LINK || 'https://t.me/+n34Jd_tGyLswNjY5';

/* CRITICAL: Trust Nginx proxy so req.hostname and req.subdomains work */
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const dirs = ['uploads/videos', 'uploads/thumbs', 'uploads/previews', 'data'];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DATA_FILE = './data/videos.json';
function loadVideos() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function saveVideos(videos) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(videos, null, 2));
}

/* ========== FFmpeg 10s preview generator ========== */
function createPreview(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-t', '10',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'copy',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', outputPath
    ];
    const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg preview failed: ${stderr.slice(-200)}`));
    });
    proc.on('error', reject);
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === 'thumbnail' ? 'uploads/thumbs' : 'uploads/videos';
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'kanairo-admin-2024';
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ========== API Routes ========== */

app.get('/api/videos', (req, res) => {
  let videos = loadVideos();
  const { category, search, page = 1, limit = 24 } = req.query;
  if (category && category !== 'all') videos = videos.filter(v => v.category === category);
  if (search) {
    const q = search.toLowerCase();
    videos = videos.filter(v => v.title.toLowerCase().includes(q) || v.tags.some(t => t.includes(q)));
  }
  videos.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = videos.length;
  const start = (page - 1) * limit;
  const paginated = videos.slice(start, start + parseInt(limit));
  res.json({ videos: paginated, total, pages: Math.ceil(total / limit) });
});

app.get('/api/videos/:id', (req, res) => {
  const videos = loadVideos();
  const video = videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  video.views = (video.views || 0) + 1;
  saveVideos(videos);
  res.json(video);
});

app.get('/api/categories', (req, res) => {
  const videos = loadVideos();
  const cats = [...new Set(videos.map(v => v.category).filter(Boolean))];
  res.json(cats);
});

/* Admin: Add by URL */
app.post('/api/admin/videos', auth, (req, res) => {
  const { title, videoUrl, thumbnail, category, tags, duration, description } = req.body;
  if (!title || !videoUrl) return res.status(400).json({ error: 'Title and videoUrl required' });
  const videos = loadVideos();
  const newVideo = {
    id: uuidv4(),
    title,
    videoUrl,
    previewUrl: videoUrl,
    thumbnail: thumbnail || '/assets/placeholder.jpg',
    category: category || 'Uncategorized',
    tags: tags || [],
    duration: duration || '00:00',
    description: description || '',
    telegramLink: TELEGRAM_LINK,
    views: 0,
    createdAt: new Date().toISOString()
  };
  videos.unshift(newVideo);
  saveVideos(videos);
  res.json(newVideo);
});

/* Admin: Upload file — auto-cap to 10s preview */
app.post('/api/admin/upload', auth, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  const videoFile = req.files.video?.[0];
  const thumbFile = req.files.thumbnail?.[0];
  if (!videoFile) return res.status(400).json({ error: 'Video required' });

  const fullPath = path.join(__dirname, 'uploads/videos', videoFile.filename);
  const previewName = `prev_${videoFile.filename}`;
  const previewPath = path.join(__dirname, 'uploads/previews', previewName);

  try {
    console.log('🎬 Generating 10s preview...');
    await createPreview(fullPath, previewPath);
    console.log('✅ Preview ready');
  } catch (err) {
    console.error('Preview generation failed:', err.message);
    return res.status(500).json({ error: 'Preview generation failed: ' + err.message });
  }

  const videos = loadVideos();
  const newVideo = {
    id: uuidv4(),
    title: req.body.title || 'Untitled',
    videoUrl: `/uploads/videos/${videoFile.filename}`,
    previewUrl: `/uploads/previews/${previewName}`,
    thumbnail: thumbFile ? `/uploads/thumbs/${thumbFile.filename}` : '/assets/placeholder.jpg',
    category: req.body.category || 'Uncategorized',
    tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : [],
    duration: req.body.duration || '00:00',
    description: req.body.description || '',
    telegramLink: TELEGRAM_LINK,
    views: 0,
    createdAt: new Date().toISOString()
  };
  videos.unshift(newVideo);
  saveVideos(videos);
  res.json(newVideo);
});

app.delete('/api/admin/videos/:id', auth, (req, res) => {
  let videos = loadVideos();
  const video = videos.find(v => v.id === req.params.id);
  if (video) {
    [video.videoUrl, video.previewUrl, video.thumbnail].forEach(url => {
      try { if (url && url.startsWith('/uploads/')) fs.unlinkSync('.' + url); }
      catch {}
    });
  }
  videos = videos.filter(v => v.id !== req.params.id);
  saveVideos(videos);
  res.json({ success: true });
});

app.get('/api/admin/stats', auth, (req, res) => {
  const videos = loadVideos();
  const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
  res.json({ totalVideos: videos.length, totalViews, categories: [...new Set(videos.map(v => v.category))].length });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* ========== SUBDOMAIN ROUTING ========== */
app.get('/', (req, res) => {
  const host = (req.hostname || req.headers.host || '').toLowerCase();
  const isAdmin = host.startsWith('admin.');
  console.log(`[ROUTER] hostname=${req.hostname}, host=${req.headers.host}, isAdmin=${isAdmin}`);
  if (isAdmin) {
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🔥 KanairoMix running on port ${PORT}`);
  console.log(`🌐 Main:    http://localhost:${PORT}`);
  console.log(`⚙️  Admin:   http://localhost:${PORT}/admin  (or admin subdomain)`);
  console.log(`🔗 Telegram: ${TELEGRAM_LINK}`);
});