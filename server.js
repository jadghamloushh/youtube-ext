/* ------------------------------------------------------------------
   High-res YouTube downloader  (Enhanced anti-bot protection)
   ------------------------------------------------------------------ */

const express  = require('express');
const cors     = require('cors');
const ytdl = require('ytdl-core');
const pretty   = require('pretty-bytes').default || require('pretty-bytes');
const ffmpeg   = require('fluent-ffmpeg');

const { file } = require('tmp-promise');
const fs       = require('fs');

// Enhanced YouTube options with better bot protection
const YT_OPTS = {
  requestOptions: {
    family: 4,   // IPv4 only
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
      // Add cookie if you have one from your browser:
      // 'Cookie': process.env.YT_COOKIE || ''
    },
    timeout: 30000,
    retries: 3
  },
  // Add these options to help bypass restrictions
  lang: 'en',
  format: 'html5'
};

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

/* ─── Enhanced cache with cleanup ─────────────────────────────── */
const cache = new Map();
const TTL   = 900_000; // 15 minutes

// Clean up expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > TTL) {
      cache.delete(key);
    }
  }
}, 300_000); // Clean every 5 minutes

/* ─── Rate limiting to avoid being blocked ─────────────────────── */
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = rateLimiter.get(ip) || [];

  // Remove old requests
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);

  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  recentRequests.push(now);
  rateLimiter.set(ip, recentRequests);
  return true;
}

/* ─── Helper function to add delays ─────────────────────────── */
function randomDelay(min = 1000, max = 3000) {
  return new Promise(resolve => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(resolve, delay);
  });
}

/* ─── Enhanced video info fetching with multiple strategies ─── */
async function getVideoInfoWithFallback(videoUrl) {
  const strategies = [
    // Strategy 1: Basic info with enhanced options
    async () => {
      console.log('Trying strategy 1: Basic info...');
      return await ytdl.getBasicInfo(videoUrl, YT_OPTS);
    },

    // Strategy 2: Full info with enhanced options
    async () => {
      console.log('Trying strategy 2: Full info...');
      await randomDelay(2000, 4000); // Add delay between attempts
      return await ytdl.getInfo(videoUrl, YT_OPTS);
    },

    // Strategy 3: Try with different user agent
    async () => {
      console.log('Trying strategy 3: Alternative user agent...');
      await randomDelay(2000, 4000);
      const altOpts = {
        ...YT_OPTS,
        requestOptions: {
          ...YT_OPTS.requestOptions,
          headers: {
            ...YT_OPTS.requestOptions.headers,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      };
      return await ytdl.getInfo(videoUrl, altOpts);
    },

    // Strategy 4: Try with minimal options
    async () => {
      console.log('Trying strategy 4: Minimal options...');
      await randomDelay(3000, 5000);
      return await ytdl.getInfo(videoUrl, {
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      });
    }
  ];

  let lastError;
  for (let i = 0; i < strategies.length; i++) {
    try {
      const info = await strategies[i]();
      if (info && info.formats && info.formats.length > 0) {
        console.log(`Strategy ${i + 1} succeeded!`);
        return info;
      }
    } catch (error) {
      console.log(`Strategy ${i + 1} failed:`, error.message);
      lastError = error;

      // If it's a bot detection error, wait longer before next attempt
      if (error.message.includes('bot') || error.message.includes('Sign in')) {
        await randomDelay(5000, 10000);
      }
    }
  }

  throw lastError || new Error('All strategies failed');
}

/* ---------------------------  /info  ----------------------------- */
app.get('/info', async (req, res) => {
  console.log('Info request received:', req.query);

  const clientIP = req.ip || req.connection.remoteAddress;

  // Check rate limit
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute before trying again.'
    });
  }

  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  if (!ytdl.validateURL(videoUrl)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  // Check cache
  const cacheKey = videoUrl;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < TTL) {
      console.log('Returning cached result');
      return res.json(cached.data);
    } else {
      cache.delete(cacheKey);
    }
  }

  try {
    console.log('Fetching video info for:', videoUrl);

    // Add initial delay to seem more human-like
    await randomDelay(500, 1500);

    const info = await getVideoInfoWithFallback(videoUrl);

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

    // Cache with timestamp
    cache.set(cacheKey, {
      data: payload,
      timestamp: Date.now()
    });

    console.log('Successfully processed video info');
    res.json(payload);

  } catch (err) {
    console.error('[/info] Error details:', {
      message: err.message,
      stack: err.stack,
      url: videoUrl
    });

    const msg = err?.message || 'unknown';

    if (msg.includes('Sign in') || msg.includes('bot'))
      return res.status(403).json({
        error: 'YouTube is blocking requests. Try again in a few minutes, or use a different network.'
      });

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

  const clientIP = req.ip || req.connection.remoteAddress;

  // Check rate limit
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute before trying again.'
    });
  }

  const { url: videoUrl, itag } = req.query;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send('Invalid YouTube URL');

  if (!itag) {
    return res.status(400).send('Missing itag parameter');
  }

  try {
    // Add delay before download
    await randomDelay(1000, 2000);

    const info = await getVideoInfoWithFallback(videoUrl);
    const videoF = info.formats.find(f => f.itag == itag);
    if (!videoF) return res.status(404).send('itag not found');

    const safeTitle = info.videoDetails.title.replace(/[^\w\s\-]/g, '');
    res.header('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.header('Content-Type', 'video/mp4');

    console.log('Starting download for:', safeTitle);

    /* ≤360 p – already has audio */
    if (videoF.hasAudio) {
      console.log('Direct download (has audio)');
      return ytdl(videoUrl, { format: videoF, ...YT_OPTS }).pipe(res);
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
    const msg = err?.message || 'unknown';

    if (msg.includes('Sign in') || msg.includes('bot')) {
      res.status(403).send('YouTube is blocking requests. Try again later.');
    } else {
      res.status(500).send('Download failed: ' + err.message);
    }
  }
});

/* helper: ytdl stream → file */
function save(url, format, out) {
  return new Promise((ok, fail) => {
    const ws = fs.createWriteStream(out);
    ytdl(url, { format, ...YT_OPTS })
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`▶️  Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Rate limiting: ${MAX_REQUESTS_PER_MINUTE} requests per minute per IP`);
});
