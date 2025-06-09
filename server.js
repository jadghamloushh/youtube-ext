/* ------------------------------------------------------------------
   High-res YouTube downloader  –  anti-bot tuned, clean URLs
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

/* ─────────────── ytdl options (no cookie, full browser headers) ───────── */
const YT_OPTS = {
  requestOptions: {
    family: 4,
    headers: {
      //  ↓ copy/paste of real Chrome request headers
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/137.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml," +
        "application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
    timeout: 30000,
    retries: 3,
  },
};

/* ─────────────── helper – always return canonical watch?v=ID URL ─────── */
function cleanWatchURL(input) {
  try {
    const id = ytdl.getURLVideoID(input); // extracts 11-char ID
    return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    // fall back untouched
    return input;
  }
}

/* ─────────────── in-memory cache & basic rate limiter ─────────────────── */
const cache = new Map();
const TTL = 900_000; // 15 min
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_MIN = 10;

function rateOK(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_MIN) return false;
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

/* ─────────────── middleware & health endpoint ─────────────────────────── */
app.use(cors({ origin: ["chrome-extension://*", "moz-extension://*", "*"] }));
app.use((req, _, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});
app.get("/", (_, res) =>
  res.json({
    status: "OK",
    endpoints: ["/info", "/download"],
    timestamp: new Date().toISOString(),
  })
);

/* ─────────────── compact, resilient info fetcher ──────────────────────── */
async function fetchInfo(videoUrl) {
  const attempts = [
    () => ytdl.getBasicInfo(videoUrl, YT_OPTS),
    () => ytdl.getInfo(videoUrl, YT_OPTS),
    () => {
      // alt UA – some vids unblock when UA changes
      const alt = {
        ...YT_OPTS,
        requestOptions: {
          ...YT_OPTS.requestOptions,
          headers: {
            ...YT_OPTS.requestOptions.headers,
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/137.0.0.0 Safari/537.36",
          },
        },
      };
      return ytdl.getInfo(videoUrl, alt);
    },
  ];
  let lastErr;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e.message.includes("Status code: 410"))
        videoUrl = cleanWatchURL(videoUrl); // ensure canonical before retry
    }
  }
  throw lastErr;
}

/* ---------------------------  /info  ----------------------------------- */
app.get("/info", async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateOK(ip)) return res.status(429).json({ error: "Too many requests." });

  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: "Missing URL parameter" });
  const url = cleanWatchURL(raw);
  if (!ytdl.validateURL(url))
    return res.status(400).json({ error: "Invalid YouTube URL" });

  if (cache.has(url) && Date.now() - cache.get(url).ts < TTL)
    return res.json(cache.get(url).data);

  try {
    const info = await fetchInfo(url);
    const title = info.videoDetails.title;
    const bins = {
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
        if (h >= 1080 && !bins["1080p"]) bins["1080p"] = f;
        else if (h >= 720 && h < 1080 && !bins["720p"]) bins["720p"] = f;
        else if (h >= 480 && h < 720 && !bins["480p"]) bins["480p"] = f;
        else if (h >= 360 && h < 480 && !bins["360p"]) bins["360p"] = f;
      }
      if (f.hasAudio && !f.hasVideo && !bins.audio) bins.audio = f;
    }

    const formats = Object.entries(bins)
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
    cache.set(url, { data: payload, ts: Date.now() });
    res.json(payload);
  } catch (e) {
    console.error("[/info]", e.message);
    if (e.message.includes("410"))
      return res
        .status(404)
        .json({ error: "Video not accessible via API (410)." });
    if (e.message.includes("bot") || e.message.includes("Sign in"))
      return res
        .status(403)
        .json({ error: "YouTube blocked this request. Try later." });
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});

/* ---------------------------  /download  ------------------------------- */
app.get("/download", async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateOK(ip)) return res.status(429).json({ error: "Too many requests." });

  const raw = req.query.url;
  const url = cleanWatchURL(raw);
  const itag = req.query.itag;
  if (!ytdl.validateURL(url))
    return res.status(400).send("Invalid YouTube URL");
  if (!itag) return res.status(400).send("Missing itag parameter");

  try {
    const info = await fetchInfo(url);
    const videoF = info.formats.find((f) => f.itag == itag);
    if (!videoF) return res.status(404).send("itag not found");

    const safe = info.videoDetails.title.replace(/[^\w\s\-]/g, "");
    res.header("Content-Disposition", `attachment; filename="${safe}.mp4"`);

    /* Direct progressive MP4? Stream it. */
    if (videoF.hasAudio && videoF.container === "mp4") {
      res.header("Content-Type", "video/mp4");
      return ytdl(url, { ...YT_OPTS, format: videoF }).pipe(res);
    }

    /* Otherwise: merge separate video+audio streams */
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
      save(url, videoF, vTmp.path),
      save(url, audioF, aTmp.path),
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

/* helper: stream YouTube → tmp file */
function save(u, f, out) {
  return new Promise((ok, fail) =>
    ytdl(u, { ...YT_OPTS, format: f })
      .pipe(fs.createWriteStream(out))
      .on("finish", ok)
      .on("error", fail)
  );
}

/* ─────────────── guard for any uncaught middleware errors ───────────── */
app.use((err, _, res, __) =>
  res.status(500).json({ error: "Internal server error", detail: err.message })
);

app.listen(PORT, () => console.log("▶️  Server running on", PORT));
