/* ------------------------------------------------------------------
   High-res YouTube video downloader
   • Streams ≤360 p directly (they already include audio).
   • For 480 p / 720 p / 1080 p it downloads video-only + audio-only,
     then muxes them into a *stream-friendly* fragmented MP4:
        - if audio track is already AAC → copy
        - if audio is Opus → transcode to AAC on the fly
   ------------------------------------------------------------------ */

const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const pretty = require("pretty-bytes").default || require("pretty-bytes");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path; // universal binary
ffmpeg.setFfmpegPath(ffmpegPath);

const { file } = require("tmp-promise");
const fs = require("fs");

const app = express();
const PORT = 3000;
app.use(cors());

/* ─── 15-minute in-memory cache for /info  ────────────────────────── */
const cache = new Map();
const TTL = 900_000;

/* ───────────────────────────  /info  ─────────────────────────────── */
app.get("/info", async (req, res) => {
  const videoUrl = req.query.url;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).json({ error: "Invalid YouTube URL" });

  if (cache.has(videoUrl)) return res.json(cache.get(videoUrl));

  try {
    let info = await ytdl.getBasicInfo(videoUrl);
    if (!info.formats?.length) info = await ytdl.getInfo(videoUrl);

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
      .map(([key, f]) => ({
        itag: f.itag,
        label: key === "audio" ? "Audio only" : key,
        ext: "MP4",
        sizeMB: f.contentLength ? pretty(+f.contentLength) : "—",
      }));

    const payload = { title, formats };
    cache.set(videoUrl, payload);
    setTimeout(() => cache.delete(videoUrl), TTL);

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});

/* ─────────────────────────  /download  ───────────────────────────── */
app.get("/download", async (req, res) => {
  const { url: videoUrl, itag } = req.query;
  if (!ytdl.validateURL(videoUrl))
    return res.status(400).send("Invalid YouTube URL");

  try {
    const info = await ytdl.getInfo(videoUrl);
    const videoF = info.formats.find((f) => f.itag == itag);
    if (!videoF) return res.status(404).send("itag not found");

    const safeTitle = info.videoDetails.title.replace(/[^\w\s\-]/g, "");
    res.header(
      "Content-Disposition",
      `attachment; filename="${safeTitle}.mp4"`
    );

    /* ≤360 p — already muxed */
    if (videoF.hasAudio) {
      return ytdl(videoUrl, { format: videoF }).pipe(res);
    }

    /* >360 p — need to merge video-only + audio-only */
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
      saveStream(videoUrl, videoF, vTmp.path),
      saveStream(videoUrl, audioF, aTmp.path),
    ]);

    /* build FFmpeg pipeline */
    const mux = ffmpeg().input(vTmp.path).videoCodec("copy").input(aTmp.path);

    if (["m4a", "mp4"].includes(audioF.container)) {
      mux.audioCodec("copy"); // keep AAC
    } else {
      mux.audioCodec("aac").audioBitrate("192k"); // Opus → AAC
    }

    mux
      .outputOptions("-movflags", "frag_keyframe+empty_moov") // << stream-friendly
      .format("mp4")
      .on("start", (cmd) => console.log("[ffmpeg]", cmd))
      .on("stderr", (line) => process.stdout.write("[ffmpeg] " + line))
      .on("error", (err) => {
        console.error(err);
        if (!res.headersSent) res.status(500).end("FFmpeg failed");
        else res.end();
      })
      .pipe(res, { end: true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Download failed");
  }
});

/* helper: pipe ytdl stream → local file -------------------------------- */
function saveStream(url, format, out) {
  return new Promise((ok, fail) => {
    const ws = fs.createWriteStream(out);
    ytdl(url, { format }).pipe(ws).on("finish", ok).on("error", fail);
  });
}

app.listen(PORT, () =>
  console.log(`▶️  Server running at http://localhost:${PORT}`)
);
