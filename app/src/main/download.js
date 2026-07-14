'use strict';
// Resumable file downloader with progress, used to fetch model weights on first
// use and cache them in the app's data dir. Follows HTTP redirects (Hugging
// Face -> CDN) and drops the auth header on cross-host redirects (HF CDN uses
// signed URLs and rejects a stray Authorization header).

const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(url, headers, onResponse, onError) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;   // follow http redirects too
  const req = lib.get(
    { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers },
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

    const reqHeaders = { ...headers, 'User-Agent': 'FlowRadVR' };
    if (received > 0) reqHeaders.Range = `bytes=${received}-`;
    // Node's http throws on a header whose value is undefined — strip any.
    for (const k of Object.keys(reqHeaders)) if (reqHeaders[k] == null) delete reqHeaders[k];

    const req = request(url, reqHeaders, (res) => {
      // Redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        const crossHost = new URL(next).hostname !== new URL(url).hostname;
        // On a cross-host redirect (e.g. HF/GitHub -> signed CDN) DROP the auth
        // header entirely — don't set it to undefined (Node would throw).
        const fwd = { ...headers };
        if (crossHost) delete fwd.Authorization;
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

      // If we sent a Range to resume but the server ignored it and returned the
      // WHOLE file (200), we must NOT append to the partial — that produces a
      // corrupt ~2x file. Restart the partial from scratch in that case.
      const append = received > 0 && res.statusCode === 206;
      if (received > 0 && res.statusCode === 200) received = 0;

      const totalHeader = Number(res.headers['content-length'] || 0);
      const total = res.statusCode === 206 ? received + totalHeader : totalHeader;
      const out = fs.createWriteStream(partial, { flags: append ? 'a' : 'w' });
      res.on('error', (e) => { try { out.destroy(); } catch (x) {} reject(e); });   // surface mid-body ECONNRESET
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress({ received, total, pct: Math.min(100, Math.floor((received / total) * 100)) });
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(partial, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      out.on('error', reject);
    }, reject);
    // Idle timeout: if the socket goes quiet for 60s (half-open stall after a
    // reset), abort so the promise rejects instead of hanging forever. The
    // caller can retry and resume from the .part file.
    req.setTimeout(60000, () => req.destroy(new Error('download stalled (no data for 60s)')));
  });
}

module.exports = { downloadFile };
