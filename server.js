/* ------------------------------------------------------------------
   High-res YouTube downloader  (Render-ready, system ffmpeg)
   ------------------------------------------------------------------ */

const express = require("express");
const cors = require("cors");
const ytdl = require("ytdl-core"); // official pkg
const pretty = require("pretty-bytes").default || require("pretty-bytes");
const ffmpeg = require("fluent-ffmpeg");
const { file } = require("tmp-promise");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

/* ─────────────── ytdl options: IPv4 + modern UA (+optional cookie) */
const YT_OPTS = {
  requestOptions: {
    family: 4,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/137.0.0.0 Safari/537.36",
      ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
    },
  },
};

/* ─────────────── accepted container lists ─────────────────────── */
const VIDEO_OK = ["mp4", "webm"]; // prog + DASH
const AUDIO_OK = ["m4a", "mp4", "webm", "webm_dash"];

/* ─────────────── middleware & health endpoint ─────────────────── */
app.use(
  cors({
    origin: ["chrome-extension://*", "moz-extension://*", "*"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "YouTube Downloader API is running",
    endpoints: ["/info", "/download"],
    timestamp: new Date().toISOString(),
  });
});

/* ─────────────── 15-min in-memory cache for /info ─────────────── */
const cache = new Map();
const TTL = 900_000;

/* ---------------------------  /info  ---------------------------- */
app.get("/info", async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl)
    return res.status(400).json({ error: "Missing URL parameter" });
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).json({ error: "Invalid YouTube URL" });

  if (cache.has(videoUrl)) return res.json(cache.get(videoUrl));

  try {
    /* getBasicInfo → fallback getInfo */
    let info;
    try {
      info = await ytdl.getBasicInfo(videoUrl, YT_OPTS);
      if (!info.formats?.length) info = await ytdl.getInfo(videoUrl, YT_OPTS);
    } catch {
      info = await ytdl.getInfo(videoUrl, YT_OPTS);
    }

    const title = info.videoDetails.title;
    const buckets = {
      "1080p": null,
      "720p": null,
      "480p": null,
      "360p": null,
      audio: null,
    };

    /* bucket the best format per resolution */
    for (const f of info.formats) {
      if (VIDEO_OK.includes(f.container) && f.hasVideo) {
        const q = f.qualityLabel || "";
        if (q.startsWith("1080") && !buckets["1080p"]) buckets["1080p"] = f;
        else if (q.startsWith("720") && !buckets["720p"]) buckets["720p"] = f;
        else if (q.startsWith("480") && !buckets["480p"]) buckets["480p"] = f;
        else if (q.startsWith("360") && !buckets["360p"]) buckets["360p"] = f;
      }
      if (
        f.hasAudio &&
        !f.hasVideo &&
        AUDIO_OK.includes(f.container) &&
        !buckets.audio
      )
        buckets.audio = f;
    }

    const formats = Object.entries(buckets)
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
    cache.set(videoUrl, payload);
    setTimeout(() => cache.delete(videoUrl), TTL);

    res.json(payload);
  } catch (err) {
    const msg = err?.message || "";
    if (msg.includes("Video unavailable"))
      return res
        .status(410)
        .json({ error: "Video unavailable or region-blocked." });
    if (msg.includes("confirm your age"))
      return res
        .status(451)
        .json({ error: "Age-restricted, sign-in required." });
    if (msg.includes("confirm you’re not a bot"))
      return res
        .status(429)
        .json({ error: "YouTube asked for human verification." });
    if (msg.includes("Status code: 403") || msg.includes("Status code: 429"))
      return res.status(429).json({ error: "Rate-limited by YouTube." });

    console.error("[/info] Error:", err);
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});

/* --------------------------  /download  ------------------------- */
app.get("/download", async (req, res) => {
  const { url: videoUrl, itag } = req.query;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send("Invalid YouTube URL");
  if (!itag) return res.status(400).send("Missing itag parameter");

  try {
    const info = await ytdl.getInfo(videoUrl, YT_OPTS);
    const videoF = info.formats.find((f) => f.itag == itag);
    if (!videoF) return res.status(404).send("itag not found");

    const safeTitle = info.videoDetails.title.replace(/[^\w\s\-]/g, "");
    res.header(
      "Content-Disposition",
      `attachment; filename="${safeTitle}.mp4"`
    );

    /* progressive MP4 w/ audio → stream directly */
    if (videoF.hasAudio && videoF.container === "mp4") {
      res.header("Content-Type", "video/mp4");
      return ytdl(videoUrl, { ...YT_OPTS, format: videoF }).pipe(res);
    }

    /* else: separate DASH or WebM → mux to MP4 */
    let audioF =
      info.formats.find(
        (f) => f.hasAudio && !f.hasVideo && AUDIO_OK.includes(f.container)
      ) ||
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
      .on("error", (e) => {
        console.error("FFmpeg error:", e);
        res.end();
      })
      .on("end", () => {
        fs.unlink(vTmp.path, () => {});
        fs.unlink(aTmp.path, () => {});
      })
      .pipe(res, { end: true });
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).send("Download failed: " + err.message);
  }
});

/* helper: ytdl stream → file */
function save(url, format, out) {
  return new Promise((ok, fail) =>
    ytdl(url, { ...YT_OPTS, format })
      .pipe(fs.createWriteStream(out))
      .on("finish", ok)
      .on("error", fail)
  );
}

/* global error handler */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`▶️  Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
