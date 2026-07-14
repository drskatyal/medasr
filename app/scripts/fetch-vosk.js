#!/usr/bin/env node
'use strict';
// Download + extract the Vosk small command model into ../models so it gets
// bundled into the installer (electron-builder extraResources) — no first-run
// download for users. Run once before `npm run dist`:  node scripts/fetch-vosk.js
//
// If you skip this, the app still works: it downloads the model on first use
// and caches it. This just moves that step to build time.

const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const NAME = 'vosk-model-small-en-us-0.15';
const outDir = path.join(__dirname, '..', '..', 'models');
const dest = path.join(outDir, NAME);
const zip = path.join(outDir, 'vosk-small.zip');

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FlowRadVR' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(download(new URL(res.headers.location, url).toString(), file, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(file);
      res.on('data', (c) => {
        got += c.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`\rdownloading ${pct}%`); }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve(file); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(path.join(dest, 'conf', 'model.conf')) || fs.existsSync(path.join(dest, 'am', 'final.mdl'))) {
    console.log('Vosk model already present at', dest);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  console.log('Fetching', URL);
  await download(URL, zip);
  console.log('Extracting…');
  const AdmZip = require('adm-zip');   // dependency of the app
  new AdmZip(zip).extractAllTo(outDir, true);
  fs.unlinkSync(zip);
  if (!fs.existsSync(path.join(dest, 'conf', 'model.conf')) && !fs.existsSync(path.join(dest, 'am', 'final.mdl'))) {
    throw new Error('extraction did not produce the expected model dir at ' + dest);
  }
  console.log('Done ->', dest);
})().catch((e) => { console.error('fetch-vosk failed:', e.message); process.exit(1); });
