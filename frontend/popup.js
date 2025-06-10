/* ----------  YT-Downloader popup controller  ---------- */

const $url      = document.getElementById('urlInput');
const $arrow    = document.getElementById('arrowBtn');
const $quality  = document.getElementById('qualitySelect');
const $download = document.getElementById('actionBtn');
const $info     = document.getElementById('infoBox');

/* Choose backend automatically:
   – If dev server running locally, use it
   – Otherwise fall back to Render */
const BACKENDS = [
  'http://localhost:3000',
  'https://youtube-ext-1.onrender.com',
];

let backend   = BACKENDS[0];   // will be verified at startup
let videoInfo = null;
let busy      = false;

/* INIT */
window.onload = () => {
  $url.focus();
  findWorkingBackend();
};

/* UI handlers */
$arrow.onclick    = () => !busy && fetchFormats();
$download.onclick = () => !busy && videoInfo && startDownload();

/* ---------------  backend discovery + health test  -------------- */
async function findWorkingBackend() {
  for (const url of BACKENDS) {
    try {
      showMsg(`🔄 Checking server: ${url} …`);
      const r = await fetchWithTimeout(`${url}/`, 5000);
      if (r.ok) {
        backend = url;
        showMsg('✅ Server connected. Ready to use.');
        return;
      }
    } catch (_) { /* ignore */ }
  }
  showMsg('⚠️ No server reachable. It will start automatically on first request (may take 20–30 s).');
}

/* ---------------  fetch available formats  ---------------------- */
async function fetchFormats() {
  const yt = $url.value.trim();
  if (!isValidYtUrl(yt)) return showMsg('❌ Please enter a valid YouTube URL');

  setBusy(true);
  showMsg('<span class="spinner"></span> Fetching video info…');

  try {
    const r = await fetchWithRetry(`${backend}/info?url=${encodeURIComponent(yt)}`, 2, 45000);

    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
      throw new Error(msg);
    }

    videoInfo = await r.json();
    if (!videoInfo.formats?.length) throw new Error('No downloadable formats found');

    buildSelect(videoInfo.formats);
    $quality.hidden  = false;
    $download.hidden = false;
    $arrow.hidden    = true;
    showMsg(`🎬 <b>${escapeHtml(videoInfo.title)}</b>`);
  } catch (e) {
    console.error('fetchFormats error:', e);
    $quality.innerHTML = '';
    $quality.hidden    = true;
    $download.hidden   = true;
    $arrow.hidden      = false;

    /* Distinguish CORS / network vs server errors */
    if (e.name === 'AbortError' || e.message === 'Failed to fetch')
      showMsg('❌ Network / CORS error: could not reach the server.');
    else
      showMsg(`❌ ${e.message}`);
  } finally {
    setBusy(false);
  }
}

/* ---------------  start the download via Chrome API ------------- */
function startDownload() {
  const yt   = $url.value.trim();
  const itag = $quality.value;
  if (!yt || !itag) return showMsg('❌ Missing URL or format');

  setBusy(true);
  showMsg('<span class="spinner"></span> Starting download…');

  const dlUrl = `${backend}/download?url=${encodeURIComponent(yt)}&itag=${itag}`;
  chrome.downloads.download(
    {
      url: dlUrl,
      filename: `YouTube/${sanitize(videoInfo.title)}.mp4`,
      conflictAction: 'uniquify',
      saveAs: true,
    },
    id => {
      setBusy(false);
      if (chrome.runtime.lastError)
        showMsg('❌ Download failed: ' + chrome.runtime.lastError.message);
      else
        showMsg('✅ Download started. Check your Downloads folder.');
    }
  );
}

/* ---------------  helpers --------------------------------------- */
function buildSelect(list) {
  $quality.innerHTML = '';
  list.forEach(f => {
    const o = document.createElement('option');
    o.value = f.itag;
    o.textContent = `${f.label} · ${f.sizeMB}`;
    $quality.appendChild(o);
  });
  $quality.selectedIndex = 0;
}

function setBusy(state) {
  busy             = state;
  $arrow.disabled  = state;
  $download.disabled = state;
}

function showMsg(html) {
  $info.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const sanitize = s => s.replace(/[<>:"/\\|?*]+/g, '').trim();

const isValidYtUrl = url =>
  /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/.test(url);

/* ---------------  fetch helpers  -------------------------------- */
function fetchWithTimeout(url, timeout = 30000, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

async function fetchWithRetry(url, tries = 3, timeout = 30000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchWithTimeout(url, timeout);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** i, 10000)));
    }
  }
  throw lastErr;
}
