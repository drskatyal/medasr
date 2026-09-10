'use strict';
// MedASR Dictate — release distribution + auto-update server (for Railway).
//
// Serves:
//   GET  /                      -> download landing page (links to installers)
//   GET  /latest.yml etc.       -> electron-updater "generic" feed (+ installers)
//   GET  /releases/<file>       -> the raw installer / yml files
//   PUT  /releases/<file>       -> upload a build artifact (needs UPLOAD_TOKEN)
//   GET  /health                -> ok
//
// This is a DISTRIBUTION server, not an inference server — transcription runs
// fully on-device. Point the app's build at it via MEDASR_UPDATE_URL=<this-url>.
//
// Env:
//   PORT           (Railway provides)
//   RELEASES_DIR   default /data/releases (mount a Railway volume here to persist)
//   UPLOAD_TOKEN   shared secret required for PUT uploads

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const RELEASES_DIR = process.env.RELEASES_DIR || '/data/releases';
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

fs.mkdirSync(RELEASES_DIR, { recursive: true });

app.get('/health', (_req, res) => res.type('text').send('ok'));

// Landing / download page.
app.get('/', (_req, res) => {
  let files = [];
  try { files = fs.readdirSync(RELEASES_DIR); } catch (e) {}
  const installers = files.filter((f) => /\.(dmg|exe|AppImage|zip)$/i.test(f)).sort();
  const rows = installers.length
    ? installers.map((f) => `<li><a href="/releases/${encodeURIComponent(f)}">${f}</a></li>`).join('')
    : '<li><em>No builds uploaded yet.</em></li>';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>MedASR Dictate — Download</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#111}
h1{font-size:1.6rem}a{color:#2563eb}li{margin:.4rem 0}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>MedASR Dictate</h1>
<p>Local, private medical dictation. Install, press the hotkey, speak — it types into any app.</p>
<h2>Downloads</h2><ul>${rows}</ul>
<p style="color:#666;font-size:.9rem">Auto-updates are served from this same host via <code>electron-updater</code>.</p>
</body></html>`);
});

// Static artifacts + update feed. electron-updater (generic) fetches
// <MEDASR_UPDATE_URL>/latest.yml — so also expose the yml files at root.
app.use('/releases', express.static(RELEASES_DIR));
for (const yml of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
  app.get('/' + yml, (_req, res) => res.sendFile(path.join(RELEASES_DIR, yml), (e) => e && res.sendStatus(404)));
}

// Token-protected upload: PUT /releases/<file>  (raw body).
app.put('/releases/:file', (req, res) => {
  if (!UPLOAD_TOKEN || req.get('x-upload-token') !== UPLOAD_TOKEN) return res.sendStatus(401);
  const name = path.basename(req.params.file); // prevent path traversal
  const dest = path.join(RELEASES_DIR, name);
  const out = fs.createWriteStream(dest);
  req.pipe(out);
  out.on('finish', () => res.json({ ok: true, file: name, bytes: fs.statSync(dest).size }));
  out.on('error', (e) => res.status(500).json({ error: String(e) }));
});

http.createServer(app).listen(PORT, () => {
  console.log(`MedASR distribution server on :${PORT}  (releases: ${RELEASES_DIR})`);
});
