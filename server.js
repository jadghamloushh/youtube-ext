/* ------------------------------------------------------------------
   High-res YouTube downloader   (Enhanced anti-bot + clean URLs)
   ------------------------------------------------------------------ */

const express = require("express");
const cors = require("cors");
const ytdl = require("ytdl-core");
const pretty = require("pretty-bytes").default || require("pretty-bytes");
const ffmpeg = require("fluent-ffmpeg");
const { file } = require("tmp-promise");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

/* ─────────────── ytdl options (IPv4, modern UA, optional cookie) ─────── */
const YT_OPTS = {
  requestOptions: {
    family: 4,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
    },
    timeout: 30000,
    retries: 3,
  },
  lang: "en",
  format: "html5",
};

/* ─────────────── helper: strip extra query-params from watch URLs ─────── */
function cleanWatchURL(input) {
  try {
    // ytdl extracts the bare 11-char ID
    const id = ytdl.getURLVideoID(input);
    return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    return input; // let validateURL catch bad cases
  }
}

/* ─────────────── memory cache & simple rate-limiter ───────────────────── */
const cache = new Map();
const TTL = 900_000; // 15 min
const rateLimiter = new Map();
const WINDOW_MS = 60_000;
const MAX_REQS_WINDOW = 10;

function tooMany(ip) {
  const now = Date.now();
  const hits = (rateLimiter.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_REQS_WINDOW) return true;
  hits.push(now);
  rateLimiter.set(ip, hits);
  return false;
}

/* ─────────────── middleware & health check ────────────────────────────── */
app.use(cors({ origin: ["chrome-extension://*", "moz-extension://*", "*"] }));
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});
app.get("/", (_, res) =>
  res.json({
    status: "OK",
    endpoints: ["/info", "/download"],
    ts: new Date().toISOString(),
  })
);

/* ─────────────── intelligent info fetcher with fallbacks ─────────────── */
async function getVideoInfoWithFallback(videoUrl) {
  const variants = [
    async () => ytdl.getBasicInfo(videoUrl, YT_OPTS),
    async () => ytdl.getInfo(videoUrl, YT_OPTS),
    async () => {
      const alt = {
        ...YT_OPTS,
        requestOptions: {
          ...YT_OPTS.requestOptions,
          headers: {
            ...YT_OPTS.requestOptions.headers,
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36",
          },
        },
      };
      return ytdl.getInfo(videoUrl, alt);
    },
  ];
  let err;
  for (const fn of variants) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      if (e.message.includes("Status code: 410"))
        videoUrl = cleanWatchURL(videoUrl);
    }
  }
  throw err;
}

/* -----------------------------  /info  --------------------------------- */
app.get("/info", async (req, res) => {
  const client = req.ip || req.connection.remoteAddress;
  if (tooMany(client))
    return res.status(429).json({ error: "Too many requests; slow down." });

  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: "Missing URL parameter" });
  const videoUrl = cleanWatchURL(rawUrl);
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).json({ error: "Invalid YouTube URL" });

  /* cache */
  if (cache.has(videoUrl) && Date.now() - cache.get(videoUrl).ts < TTL)
    return res.json(cache.get(videoUrl).data);

  try {
    const info = await getVideoInfoWithFallback(videoUrl);
    const title = info.videoDetails.title;
    const picks = {
      "1080p": null,
      "720p": null,
      "480p": null,
      "360p": null,
      audio: null,
    };

    for (const f of info.formats) {
      if (f.hasVideo) {
        const h =
          f.height || parseInt((f.qualityLabel || "").match(/\d+/)?.[0] || 0);
        if (h >= 1080 && !picks["1080p"]) picks["1080p"] = f;
        else if (h >= 720 && h < 1080 && !picks["720p"]) picks["720p"] = f;
        else if (h >= 480 && h < 720 && !picks["480p"]) picks["480p"] = f;
        else if (h >= 360 && h < 480 && !picks["360p"]) picks["360p"] = f;
      }
      if (f.hasAudio && !f.hasVideo && !picks.audio) picks.audio = f;
    }

    const formats = Object.entries(picks)
      .filter(([, f]) => f)
      .map(([k, f]) => ({
        itag: f.itag,
        label: k === "audio" ? "Audio only" : k,
        ext: f.container.toUpperCase(),
        sizeMB: f.contentLength ? pretty(+f.contentLength) : "—",
      }));
    if (!formats.length)
      return res.status(404).json({ error: "No suitable formats found" });

    const payload = { title, formats };
    cache.set(videoUrl, { data: payload, ts: Date.now() });
    res.json(payload);
  } catch (e) {
    console.error("[/info]", e.message);
    if (e.message.includes("bot") || e.message.includes("Sign in"))
      return res
        .status(403)
        .json({ error: "YouTube blocked the request; try again later." });
    if (e.message.includes("410"))
      return res
        .status(404)
        .json({ error: "Video not accessible via API (410)." });
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});

/* -----------------------------  /download  ----------------------------- */
app.get("/download", async (req, res) => {
  const client = req.ip || req.connection.remoteAddress;
  if (tooMany(client))
    return res.status(429).json({ error: "Too many requests; slow down." });

  const rawUrl = req.query.url;
  const videoUrl = cleanWatchURL(rawUrl);
  const itag = req.query.itag;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send("Invalid YouTube URL");
  if (!itag) return res.status(400).send("Missing itag parameter");

  try {
    const info = await getVideoInfoWithFallback(videoUrl);
    const videoF = info.formats.find((f) => f.itag == itag);
    if (!videoF) return res.status(404).send("itag not found");

    const titleSafe = info.videoDetails.title.replace(/[^\w\s\-]/g, "");
    res.header(
      "Content-Disposition",
      `attachment; filename="${titleSafe}.mp4"`
    );

    if (videoF.hasAudio && videoF.container === "mp4") {
      res.header("Content-Type", "video/mp4");
      return ytdl(videoUrl, { ...YT_OPTS, format: videoF }).pipe(res);
    }

    /* merge DASH/WebM */
    const audioF =
      info.formats.find((f) => f.hasAudio && !f.hasVideo) ||
      ytdl.chooseFormat(info.formats, {
        quality: "highestaudio",
        filter: "audioonly",
      });

    const vTmp = await file({ postfix: ".mp4" });
    const aTmp = await file({
      postfix: audioF.container.startsWith("webm") ? ".webm" : ".m4a",
    });

    await Promise.all([
      save(videoUrl, videoF, vTmp.path),
      save(videoUrl, audioF, aTmp.path),
    ]);

    ffmpeg()
      .input(vTmp.path)
      .videoCodec("copy")
      .input(aTmp.path)
      .audioCodec(audioF.container.startsWith("webm") ? "aac" : "copy")
      .audioBitrate("192k")
      .outputOptions("-movflags", "frag_keyframe+empty_moov")
      .format("mp4")
      .on("end", () => {
        fs.unlink(vTmp.path, () => {});
        fs.unlink(aTmp.path, () => {});
      })
      .on("error", (e) => {
        console.error("ffmpeg", e);
        res.end();
      })
      .pipe(res, { end: true });
  } catch (e) {
    console.error("[/download]", e.message);
    res.status(500).send("Download failed: " + e.message);
  }
});

/* helper – stream → temp file */
function save(u, f, out) {
  return new Promise((ok, fail) =>
    ytdl(u, { ...YT_OPTS, format: f })
      .pipe(fs.createWriteStream(out))
      .on("finish", ok)
      .on("error", fail)
  );
}

/* ─────────────── unhandled error guard ───────────────────────── */
app.use((err, _, res, __) =>
  res.status(500).json({ error: "Internal server error", detail: err.message })
);

app.listen(PORT, () => console.log("▶️  server on", PORT));
