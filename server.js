// server.js
import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core"; // 4.16.x or newer
import prettyBytes from "pretty-bytes";
import ffmpeg from "fluent-ffmpeg";
import { file } from "tmp-promise";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------ 1.  global request headers ------------------- */
const COMMON = {
  requestOptions: {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0 Safari/537.36",
      cookie: process.env.YT_COOKIE || "",
    },
  },
};

/* ----------------------- 2. middleware --------------------------- */
app.use(
  cors({
    origin: ["chrome-extension://*", "moz-extension://*", "*"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

/* simple health check */
app.get("/", (_req, res) => {
  res.json({
    status: "OK",
    message: "YouTube Downloader API is running",
    endpoints: ["/info", "/download"],
    timestamp: new Date().toISOString(),
  });
});

/* ------------------ 3.  15-min in-memory cache ------------------- */
const cache = new Map();
const TTL = 900_000;

/* -------------------------- /info -------------------------------- */
app.get("/info", async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: "Missing url param" });
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).json({ error: "Invalid YouTube URL" });

  if (cache.has(videoUrl)) return res.json(cache.get(videoUrl));

  try {
    let info;
    try {
      info = await ytdl.getBasicInfo(videoUrl, COMMON);
      if (!info.formats?.length) {
        info = await ytdl.getInfo(videoUrl, COMMON);
      }
    } catch {
      info = await ytdl.getInfo(videoUrl, COMMON);
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
      .map(([k, f]) => ({
        itag: f.itag,
        label: k === "audio" ? "Audio only" : k,
        ext: "MP4",
        sizeMB: f.contentLength ? prettyBytes(+f.contentLength) : "—",
      }));

    if (!formats.length)
      return res.status(404).json({ error: "No suitable formats found" });

    const payload = { title, formats };
    cache.set(videoUrl, payload);
    setTimeout(() => cache.delete(videoUrl), TTL);

    return res.json(payload);
  } catch (err) {
    console.error("[/info] FULL error:", err);
    const msg = String(err?.message || "");
    if (msg.includes("age"))
      return res.status(451).json({ error: "Age-restricted." });
    if (msg.includes("403"))
      return res.status(429).json({ error: "Throttled by YouTube." });
    if (msg.includes("429"))
      return res.status(429).json({ error: "Rate-limited." });
    if (msg.includes("unavailable"))
      return res.status(410).json({ error: "Video unavailable." });
    return res.status(500).json({ error: "Failed to fetch video info" });
  }
});

/* ------------------------- /download ----------------------------- */
app.get("/download", async (req, res) => {
  const { url: videoUrl, itag } = req.query;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send("Invalid YouTube URL");
  if (!itag) return res.status(400).send("Missing itag parameter");

  try {
    const info = await ytdl.getInfo(videoUrl, COMMON);
    const videoF = info.formats.find((f) => f.itag == itag);
    if (!videoF) return res.status(404).send("itag not found");

    const safeTitle = info.videoDetails.title.replace(/[^\w\s\-]/g, "");
    res.header(
      "Content-Disposition",
      `attachment; filename="${safeTitle}.mp4"`
    );
    res.header("Content-Type", "video/mp4");

    if (videoF.hasAudio) {
      return ytdl(videoUrl, { ...COMMON, format: videoF }).pipe(res);
    }

    let audioF = info.formats.find(
      (f) =>
        f.hasAudio &&
        !f.hasVideo &&
        (f.container === "m4a" || f.container === "mp4")
    );
    if (!audioF) {
      audioF = ytdl.chooseFormat(info.formats, {
        quality: "highestaudio",
        filter: "audioonly",
      });
    }

    const vTmp = await file({ postfix: ".mp4" });
    const aTmp = await file({
      postfix: audioF.container === "webm" ? ".webm" : ".m4a",
    });

    await Promise.all([
      save(videoUrl, videoF, vTmp.path),
      save(videoUrl, audioF, aTmp.path),
    ]);

    ffmpeg()
      .input(vTmp.path)
      .videoCodec("copy")
      .input(aTmp.path)
      .audioCodec(
        audioF.container === "mp4" || audioF.container === "m4a"
          ? "copy"
          : "aac"
      )
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

function save(url, format, out) {
  return new Promise((ok, fail) => {
    const ws = fs.createWriteStream(out);
    ytdl(url, { ...COMMON, format })
      .pipe(ws)
      .on("finish", ok)
      .on("error", fail);
  });
}

/* fallback error middleware */
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`▶️  Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
