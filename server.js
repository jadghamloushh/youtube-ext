/* ------------------------------------------------------------------
   High-res YouTube downloader  —  local or Render deployment
   ------------------------------------------------------------------ */

const express = require("express");
const cors = require("cors");
const ytdl = require("ytdl-core");
const pretty = require("pretty-bytes");
const ffmpeg = require("fluent-ffmpeg");

const { file } = require("tmp-promise");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------ CORS ---------- */
// Allow:
//
//   • Any Chrome or Firefox web-extension origin
//   • Your Render URL  (set RENDER_HOST env var to "youtube-ext-1.onrender.com")
//   • localhost (no Origin header)
//
const RENDER_HOST_RE = new RegExp(
  `^https://(${process.env.RENDER_HOST || "youtube-ext-1.onrender.com"})$`
);

app.use(
  cors({
    origin(origin, cb) {
      if (
        !origin || // curl / localhost
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://") ||
        RENDER_HOST_RE.test(origin)
      ) {
        return cb(null, true);
      }
      cb(new Error(`CORS blocked: ${origin}`));
    },
  })
);

/* --------------------------------------------- logging ---------- */
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method}  ${req.url}`);
  next();
});

/* --------------------------------------- health-check ---------- */
app.get("/", (_req, res) =>
  res.json({
    status: "OK",
    message: "YouTube Downloader API",
    endpoints: ["/info", "/download"],
    timestamp: new Date().toISOString(),
  })
);

/* 15-minute in-memory cache for /info */
const cache = new Map();
const TTL = 900_000;

/* ------------------------------------------------ /info ---------- */
app.get("/info", async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl)
    return res.status(400).json({ error: "Missing URL parameter" });
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).json({ error: "Invalid YouTube URL" });

  if (cache.has(videoUrl)) return res.json(cache.get(videoUrl));

  try {
    /* basic → full fallback to dodge occasional “no formats” bug */
    let info;
    try {
      info = await ytdl.getBasicInfo(videoUrl);
      if (!info.formats?.length) info = await ytdl.getInfo(videoUrl);
    } catch (_) {
      info = await ytdl.getInfo(videoUrl);
    }

    const title = info.videoDetails.title;
    const buckets = {
      "1080p": null,
      "720p": null,
      "480p": null,
      "360p": null,
      audio: null,
    };

    for (const f of info.formats) {
      const q = f.qualityLabel || "";
      if (f.container === "mp4" && f.hasVideo) {
        if (q.startsWith("1080") && !buckets["1080p"]) buckets["1080p"] = f;
        else if (q.startsWith("720") && !buckets["720p"]) buckets["720p"] = f;
        else if (q.startsWith("480") && !buckets["480p"]) buckets["480p"] = f;
        else if (q.startsWith("360") && !buckets["360p"]) buckets["360p"] = f;
      }
      if (f.hasAudio && !f.hasVideo && !buckets.audio) buckets.audio = f;
    }

    const formats = Object.entries(buckets)
      .filter(([, f]) => f)
      .map(([label, f]) => ({
        itag: f.itag,
        label: label === "audio" ? "Audio only" : label,
        ext: "MP4",
        sizeMB: f.contentLength ? pretty(+f.contentLength) : "—",
      }));

    if (!formats.length)
      return res.status(404).json({ error: "No suitable formats found" });

    const payload = { title, formats };
    cache.set(videoUrl, payload);
    setTimeout(() => cache.delete(videoUrl), TTL);

    return res.json(payload);
  } catch (err) {
    console.error("[/info] error:", err.message);
    const msg = err.message || "unknown";

    if (msg.includes("Video unavailable"))
      return res
        .status(410)
        .json({ error: "Video unavailable or region-blocked." });
    if (msg.includes("confirm your age"))
      return res
        .status(451)
        .json({ error: "Age-restricted, sign-in required." });
    if (msg.includes("Status code: 403") || msg.includes("Status code: 429"))
      return res.status(429).json({ error: "Rate-limited by YouTube." });

    return res.status(500).json({ error: "Failed to fetch video info" });
  }
});

/* ----------------------------------------------- /download ------ */
app.get("/download", async (req, res) => {
  const { url: videoUrl, itag } = req.query;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send("Invalid YouTube URL");
  if (!itag) return res.status(400).send("Missing itag parameter");

  try {
    const info = await ytdl.getInfo(videoUrl);
    const videoF = info.formats.find((f) => f.itag == itag);
    if (!videoF) return res.status(404).send("itag not found");

    const safeTitle = info.videoDetails.title.replace(/[^\w\s\-]/g, "").trim();
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeTitle}.mp4"`
    );
    res.setHeader("Content-Type", "video/mp4");

    /* ≤ 360p already contains audio */
    if (videoF.hasAudio) return ytdl(videoUrl, { format: videoF }).pipe(res);

    /* higher → merge separate audio */
    const audioF =
      info.formats.find(
        (f) => f.hasAudio && !f.hasVideo && /^(m4a|mp4|webm)$/.test(f.container)
      ) ||
      ytdl.chooseFormat(info.formats, {
        quality: "highestaudio",
        filter: "audioonly",
      });

    const vTmp = await file({ postfix: ".mp4" });
    const aTmp = await file({
      postfix: audioF.container === "webm" ? ".webm" : ".m4a",
    });

    await Promise.all([
      save(videoUrl, videoF, vTmp.path),
      save(videoUrl, audioF, aTmp.path),
    ]);

    const mux = ffmpeg().input(vTmp.path).videoCodec("copy").input(aTmp.path);

    if (["m4a", "mp4"].includes(audioF.container)) {
      mux.audioCodec("copy"); // keep AAC
    } else {
      mux.audioCodec("aac").audioBitrate("192k"); // Opus → AAC
    }

    mux
      .format("mp4")
      .outputOptions("-movflags", "faststart") // seekable after download
      .on("error", (e) => {
        console.error("FFmpeg error:", e.message || e);
        if (!res.headersSent) res.status(500).end("FFmpeg failed");
      })
      .on("end", () =>
        [vTmp.path, aTmp.path].forEach((p) => fs.unlink(p, () => {}))
      )
      .pipe(res, { end: true });
  } catch (err) {
    console.error("[/download] error:", err.message);
    res.status(500).send(`Download failed: ${err.message}`);
  }
});

/* ytdl stream → temporary file */
function save(url, format, outPath) {
  return new Promise((ok, fail) => {
    ytdl(url, { format })
      .pipe(fs.createWriteStream(outPath))
      .on("finish", ok)
      .on("error", fail);
  });
}

/* global error handler */
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent)
    res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`▶️  Server running on port ${PORT}`);
});
