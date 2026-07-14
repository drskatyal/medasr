'use strict';
// Resumable file downloader with progress, used to fetch model weights on first
// use and cache them in the app's data dir. Follows HTTP redirects (Hugging
// Face -> CDN) and drops the auth header on cross-host redirects (HF CDN uses
// signed URLs and rejects a stray Authorization header).

const fs = require('fs');
const https = require('https');
const { URL } = require('url');

function request(url, headers, onResponse, onError) {
  const u = new URL(url);
  const req = https.get(
    { hostname: u.hostname, path: u.pathname + u.search, headers },
    onResponse,
  );
  req.on('error', onError);
  return req;
}

// Download `url` to `dest`, resuming if a partial file exists. onProgress gets
// ({ received, total, pct }). Returns the dest path.
function downloadFile(url, dest, { headers = {}, onProgress, redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const partial = dest + '.part';
    try { received = fs.existsSync(partial) ? fs.statSync(partial).size : 0; } catch (e) {}

    const reqHeaders = { ...headers, 'User-Agent': 'MedASR-Dictate' };
    if (received > 0) reqHeaders.Range = `bytes=${received}-`;

    const req = request(url, reqHeaders, (res) => {
      // Redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        const crossHost = new URL(next).hostname !== new URL(url).hostname;
        const fwd = crossHost ? { ...headers, Authorization: undefined } : headers;
        return resolve(downloadFile(next, dest, { headers: fwd, onProgress, redirectsLeft: redirectsLeft - 1 }));
      }
      if (res.statusCode === 416) {            // range not satisfiable -> already complete
        try { fs.renameSync(partial, dest); } catch (e) {}
        return resolve(dest);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const totalHeader = Number(res.headers['content-length'] || 0);
      const total = res.statusCode === 206 ? received + totalHeader : totalHeader;
      const out = fs.createWriteStream(partial, { flags: received > 0 ? 'a' : 'w' });
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress({ received, total, pct: Math.floor((received / total) * 100) });
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(partial, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      out.on('error', reject);
    }, reject);
    req.end();
  });
}

module.exports = { downloadFile };
