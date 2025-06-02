/* ----------  High-res YouTube downloader (muxes audio)  ---------- */
const express  = require('express');
const ytdl     = require('@distube/ytdl-core');
const cors     = require('cors');
const pretty   = require('pretty-bytes').default || require('pretty-bytes');

const ffmpeg   = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; // works on Intel & Apple-Sil
ffmpeg.setFfmpegPath(ffmpegPath);

const { file } = require('tmp-promise');
const fs       = require('fs');

const app  = express();
const PORT = 3000;
app.use(cors());

/* ─── 15-min cache ─────────────────────────────────────────── */
const cache = new Map();
const TTL   = 900_000;

/* --------------------  /info  ------------------------------ */
app.get('/info', async (req,res)=>{
  const videoUrl=req.query.url;
  if(!ytdl.validateURL(videoUrl))
    return res.status(400).json({error:'Invalid YouTube URL'});

  if(cache.has(videoUrl)) return res.json(cache.get(videoUrl));

  try{
    let info=await ytdl.getBasicInfo(videoUrl);
    if(!info.formats?.length) info=await ytdl.getInfo(videoUrl);

    const title=info.videoDetails.title;
    const buckets={ '1080p':null,'720p':null,'480p':null,'360p':null,audio:null };

    for(const f of info.formats){
      const q=f.qualityLabel||'';
      if(f.container==='mp4'&&f.hasVideo){
        if(q.startsWith('1080')&&!buckets['1080p']) buckets['1080p']=f;
        else if(q.startsWith('720')&&!buckets['720p']) buckets['720p']=f;
        else if(q.startsWith('480')&&!buckets['480p']) buckets['480p']=f;
        else if(q.startsWith('360')&&!buckets['360p']) buckets['360p']=f;
      }
      if(f.hasAudio&&!f.hasVideo&&!buckets.audio) buckets.audio=f;
    }

    const formats=Object.entries(buckets).filter(([,f])=>f).map(([k,f])=>({
      itag:f.itag,label:k==='audio'?'Audio only':k,ext:'MP4',
      sizeMB:f.contentLength?pretty(+f.contentLength):'—'
    }));

    const payload={title,formats};
    cache.set(videoUrl,payload); setTimeout(()=>cache.delete(videoUrl),TTL);
    res.json(payload);
  }catch(e){console.error(e);res.status(500).json({error:'info failed'});}
});

/* --------------------  /download  --------------------------- */
app.get('/download', async (req,res)=>{
  const { url:videoUrl, itag } = req.query;
  if(!ytdl.validateURL(videoUrl))
    return res.status(400).send('Invalid YouTube URL');

  try{
    const info=await ytdl.getInfo(videoUrl);
    const vFmt=info.formats.find(f=>f.itag==itag);
    if(!vFmt) return res.status(404).send('itag not found');

    const title=info.videoDetails.title.replace(/[^\w\s\-]/g,'');
    res.header('Content-Disposition',`attachment; filename="${title}.mp4"`);

    if(vFmt.hasAudio){               /* ≤360p already muxed */
      return ytdl(videoUrl,{format:vFmt}).pipe(res);
    }

    /* >360p: download video & audio separately, then mux */
    const aFmt=ytdl.chooseFormat(info.formats,{quality:'highestaudio',filter:'audioonly'});

    const vTmp=await file({postfix:'.mp4'});
    const aTmp=await file({postfix:'.m4a'});

    await Promise.all([
      streamToFile(videoUrl,vFmt, vTmp.path),
      streamToFile(videoUrl,aFmt, aTmp.path)
    ]);

    ffmpeg()
      .input(vTmp.path).videoCodec('copy')
      .input(aTmp.path).audioCodec('copy')
      .format('mp4')
      .on('error',e=>{console.error(e);res.end();})
      .pipe(res,{end:true});

  }catch(e){console.error(e);res.status(500).send('Download failed');}
});

/* helper: pipe ytdl stream → local file */
function streamToFile(url,format,outPath){
  return new Promise((ok,err)=>{
    const ws=fs.createWriteStream(outPath);
    ytdl(url,{format}).pipe(ws).on('finish',ok).on('error',err);
  });
}

app.listen(PORT,()=>console.log(`▶️  Server running at http://localhost:${PORT}`));
