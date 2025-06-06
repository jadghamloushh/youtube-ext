/* ------------------------------------------------------------------
   High-res YouTube downloader  (Render-ready, system ffmpeg)
   ------------------------------------------------------------------ */

const express  = require('express');
const cors     = require('cors');
const ytdl = require('ytdl-core');
const pretty   = require('pretty-bytes').default || require('pretty-bytes');
const ffmpeg   = require('fluent-ffmpeg');

const { file } = require('tmp-promise');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration
app.use(cors({
  origin: ['chrome-extension://*', 'moz-extension://*', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Add a health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'YouTube Downloader API is running',
    endpoints: ['/info', '/download'],
    timestamp: new Date().toISOString()
  });
});

/* ─── simple 15-min cache for /info ─────────────────────────────── */
const cache = new Map();
const TTL   = 900_000;

/* ---------------------------  /info  ----------------------------- */
app.get('/info', async (req, res) => {
  console.log('Info request received:', req.query);

  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  if (!ytdl.validateURL(videoUrl)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  if (cache.has(videoUrl)) {
    console.log('Returning cached result');
    return res.json(cache.get(videoUrl));
  }

  try {
    console.log('Fetching video info for:', videoUrl);

    // Try getBasicInfo first, fallback to getInfo
    let info;
    try {
      info = await ytdl.getBasicInfo(videoUrl);
      if (!info.formats?.length) {
        console.log('No formats in basic info, trying full info...');
        info = await ytdl.getInfo(videoUrl);
      }
    } catch (basicError) {
      console.log('Basic info failed, trying full info:', basicError.message);
      info = await ytdl.getInfo(videoUrl);
    }

    console.log('Got video info, processing formats...');
    const title = info.videoDetails.title;
    const buckets = { '1080p':null,'720p':null,'480p':null,'360p':null,audio:null };

    // Process formats
    for (const f of info.formats) {
      const q = f.qualityLabel || '';
      if (f.container === 'mp4' && f.hasVideo) {
        if      (q.startsWith('1080') && !buckets['1080p']) buckets['1080p'] = f;
        else if (q.startsWith('720')  && !buckets['720p'])  buckets['720p']  = f;
        else if (q.startsWith('480')  && !buckets['480p'])  buckets['480p']  = f;
        else if (q.startsWith('360')  && !buckets['360p'])  buckets['360p']  = f;
      }
      if (f.hasAudio && !f.hasVideo && !buckets.audio) buckets.audio = f;
    }

    const formats = Object.entries(buckets)
      .filter(([, f]) => f)
      .map(([k, f]) => ({
        itag  : f.itag,
        label : k === 'audio' ? 'Audio only' : k,
        ext   : 'MP4',
        sizeMB: f.contentLength ? pretty(+f.contentLength) : '—'
      }));

    if (formats.length === 0) {
      return res.status(404).json({ error: 'No suitable formats found' });
    }

    const payload = { title, formats };
    cache.set(videoUrl, payload);
    setTimeout(() => cache.delete(videoUrl), TTL);

    console.log('Successfully processed video info');
    res.json(payload);

  } catch (err) {
    console.error('[/info] Error details:', {
      message: err.message,
      stack: err.stack,
      url: videoUrl
    });

    const msg = err?.message || 'unknown';

    if (msg.includes('Video unavailable'))
      return res.status(410).json({ error: 'Video unavailable or region-blocked.' });

    if (msg.includes('confirm your age'))
      return res.status(451).json({ error: 'Age-restricted, sign-in required.' });

    if (msg.includes('Status code: 403'))
      return res.status(429).json({ error: 'YouTube throttled this server IP.' });

    if (msg.includes('Status code: 429'))
      return res.status(429).json({ error: 'Rate limited by YouTube.' });

    res.status(500).json({
      error: 'Failed to fetch video info',
      details: process.env.NODE_ENV === 'development' ? msg : undefined
    });
  }
});

/* --------------------------  /download  -------------------------- */
app.get('/download', async (req, res) => {
  console.log('Download request received:', req.query);

  const { url: videoUrl, itag } = req.query;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send('Invalid YouTube URL');

  if (!itag) {
    return res.status(400).send('Missing itag parameter');
  }

  try {
    const info   = await ytdl.getInfo(videoUrl);
    const videoF = info.formats.find(f => f.itag == itag);
    if (!videoF) return res.status(404).send('itag not found');

    const safeTitle = info.videoDetails.title.replace(/[^\w\s\-]/g, '');
    res.header('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.header('Content-Type', 'video/mp4');

    console.log('Starting download for:', safeTitle);

    /* ≤360 p – already has audio */
    if (videoF.hasAudio) {
      console.log('Direct download (has audio)');
      return ytdl(videoUrl, { format: videoF }).pipe(res);
    }

    /* >360 p – need to merge */
    console.log('Need to merge video and audio');
    let audioF = info.formats.find(
      f => f.hasAudio && !f.hasVideo && (f.container === 'm4a' || f.container === 'mp4')
    );
    if (!audioF) {
      audioF = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    }

    const vTmp = await file({ postfix: '.mp4' });
    const aTmp = await file({ postfix: audioF.container === 'webm' ? '.webm' : '.m4a' });

    await Promise.all([
      save(videoUrl, videoF, vTmp.path),
      save(videoUrl, audioF, aTmp.path)
    ]);

    const mux = ffmpeg()
      .input(vTmp.path).videoCodec('copy')
      .input(aTmp.path);

    if (['m4a','mp4'].includes(audioF.container)) {
      mux.audioCodec('copy');                 // keep AAC
    } else {
      mux.audioCodec('aac').audioBitrate('192k'); // Opus → AAC
    }

    mux
      .outputOptions('-movflags', 'frag_keyframe+empty_moov')
      .format('mp4')
      .on('start', cmd => console.log('[ffmpeg]', cmd))
      .on('stderr', l  => process.stdout.write('[ffmpeg] '+l))
      .on('error',  e  => {
        console.error('FFmpeg error:', e);
        if (!res.headersSent) res.status(500).end('FFmpeg failed');
        else res.end();
      })
      .on('end', () => {
        console.log('FFmpeg completed successfully');
        // Clean up temp files
        fs.unlink(vTmp.path, () => {});
        fs.unlink(aTmp.path, () => {});
      })
      .pipe(res, { end: true });

  } catch (err) {
    console.error('Download error:', err);
    res.status(500).send('Download failed: ' + err.message);
  }
});

/* helper: ytdl stream → file */
function save(url, format, out) {
  return new Promise((ok, fail) => {
    const ws = fs.createWriteStream(out);
    ytdl(url, { format })
      .pipe(ws)
      .on('finish', ok)
      .on('error',  fail);
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`▶️  Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
