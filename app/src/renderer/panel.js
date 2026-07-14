'use strict';

const $ = (id) => document.getElementById(id);

function fillSelect(sel, items, currentId, labelFn) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = labelFn ? labelFn(it) : it.label;
    if (it.id === currentId) o.selected = true;
    sel.appendChild(o);
  }
}

async function init() {
  const [settings, engines] = await Promise.all([
    window.medasr.getSettings(),
    window.medasr.getEngines(),
  ]);

  fillSelect($('stt'), engines.stt, settings.sttEngine,
    (e) => e.label + (e.implemented ? '' : '  (needs setup)'));
  // The dropdown shows the true state: 'Off' unless cleaning is actually enabled.
  fillSelect($('cleanup'), engines.cleanup, settings.cleanupEnabled ? (settings.cleanupModel || 'off') : 'off');

  const sttHint = () => {
    const e = engines.stt.find((x) => x.id === $('stt').value);
    $('sttHint').textContent = e ? (e.implemented ? e.note : '⚠ ' + e.note + '  Falls back to MedASR until installed.') : '';
  };
  $('stt').addEventListener('change', sttHint);
  sttHint();

  $('autoInject').checked = settings.autoInject !== false;
  $('lockFocus').checked = settings.lockFocus !== false;
  $('voiceCommands').checked = settings.voiceCommands !== false;
  $('voiceNav').checked = settings.voiceNav !== false;
  $('voiceActions').checked = settings.voiceActions !== false;
  $('alwaysOnCommands').checked = settings.alwaysOnCommands !== false;
  $('pacsCommand').value = settings.pacsCommand || '';

  // --- macro table (stored as "trigger = text" lines; \n for line breaks) ---
  function addMacroRow(trigger = '', text = '') {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input class="mtrig" type="text" spellcheck="false" placeholder="normal chest"></td>'
      + '<td><textarea class="mtext" rows="1" spellcheck="false" placeholder="No acute…"></textarea></td>'
      + '<td><button type="button" class="mdel" title="Remove">×</button></td>';
    tr.querySelector('.mtrig').value = trigger;
    tr.querySelector('.mtext').value = text;
    tr.querySelector('.mdel').addEventListener('click', () => tr.remove());
    $('macroBody').appendChild(tr);
  }
  function loadMacros(str) {
    $('macroBody').innerHTML = '';
    for (const line of (str || '').split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const trig = line.slice(0, i).trim();
      const text = line.slice(i + 1).trim().replace(/\\n/g, '\n');   // show real line breaks
      if (trig) addMacroRow(trig, text);
    }
    if (!$('macroBody').children.length) addMacroRow();   // start with one empty row
  }
  function serializeMacros() {
    const out = [];
    for (const tr of $('macroBody').children) {
      const trig = tr.querySelector('.mtrig').value.trim();
      const text = tr.querySelector('.mtext').value.trim().replace(/\r?\n/g, '\\n');  // store \n
      if (trig && text) out.push(trig + ' = ' + text);
    }
    return out.join('\n');
  }
  $('macroAdd').addEventListener('click', () => addMacroRow());
  loadMacros(settings.macros);
  window.__serializeMacros = serializeMacros;
  $('hotkey').value = settings.hotkey || 'Alt+Q';
  $('modelPath').value = settings.llmModelPath || '';
  $('modelsDir').value = settings.modelsDirOverride || '';

  // Live status panel + setup buttons (so setup/errors are visible, no pop-ups).
  function btnState(btn, state, downloadingRe, readyRe) {
    if (readyRe.test(state)) { btn.textContent = '✓ Installed'; btn.disabled = true; }
    else if (downloadingRe.test(state)) { btn.textContent = state.replace(/^.*?(\d+%).*$/, 'Downloading $1'); if (!/\d+%/.test(btn.textContent)) btn.textContent = 'Working…'; btn.disabled = true; }
    else { btn.textContent = 'Download'; btn.disabled = false; }
  }
  // Drive a download progress bar from a status string: a "42%" shows a filled
  // bar; a wordy "loading…/extracting…" shows an indeterminate sweep; otherwise
  // it's hidden (off / ready / error — the text row carries those).
  function setBar(id, state, active) {
    const pb = $(id);
    if (!pb) return;
    const str = String(state || '');
    const m = str.match(/(\d+)\s*%/);
    if (active && m) {
      pb.className = 'pbar show';
      pb.querySelector('i').style.width = m[1] + '%';
      pb.querySelector('em').textContent = m[1] + '%';
    } else if (active && /downloading|loading|extract|working|starting/i.test(str) && !/ready/i.test(str)) {
      pb.className = 'pbar indet';
    } else {
      pb.className = 'pbar';
    }
  }
  async function refreshStatus() {
    let s;
    try { s = await window.medasr.getStatus(); } catch (e) { return; }
    // Input model: make the ACTIVE engine obvious.
    $('stStt').textContent = s.modelReady
      ? (s.sttActive === s.sttSelected ? `${s.sttActive} — running`
         : `${s.sttActive} running (you selected ${s.sttSelected}: ${s.sttNote || 'not available'})`)
      : (s.sttNote || 'not loaded');
    // STT download button: shown when the selected engine can be downloaded and isn't installed yet.
    const sttNeedsDl = s.sttInstallable && !s.sttInstalled;
    $('btnDlStt').style.display = sttNeedsDl || /downloading/i.test(s.sttDl || '') ? 'inline-block' : 'none';
    // NB: use /downloading/i (not /download/i) so an idle state doesn't get
    // mistaken for an in-progress download and disable the button.
    btnState($('btnDlStt'), s.sttInstalled ? 'installed' : (s.sttDl || 'idle'), /downloading/i, /installed/i);
    if ($('btnDlStt').textContent === 'Download') $('btnDlStt').textContent = 'Set up';
    setBar('pbStt', s.sttDl, sttNeedsDl || /downloading/i.test(s.sttDl || ''));
    if ($('modelsDirNow') && s.modelsDir) $('modelsDirNow').textContent = 'Currently: ' + s.modelsDir;
    // Cleaning
    const cleanSel = $('cleanup').value;
    $('stClean').textContent = cleanSel === 'off' ? 'off' : `${cleanSel} — ${s.cleaning}`;
    $('btnDlClean').style.display = cleanSel === 'off' ? 'none' : 'inline-block';
    btnState($('btnDlClean'), s.cleaning, /download|loading/i, /ready|✓/i);
    setBar('pbClean', s.cleaning, cleanSel !== 'off');
    // Real-time VAD
    const vadOn = $('realtimeMode').checked;
    $('stVad').textContent = vadOn ? s.vad : 'off';
    $('btnDlVad').style.display = vadOn ? 'inline-block' : 'none';
    btnState($('btnDlVad'), s.vad, /download|loading/i, /ready/i);
    setBar('pbVad', s.vad, vadOn);
    // Always-on commands (Vosk)
    const cmdOn = $('alwaysOnCommands').checked;
    $('stCmd').textContent = cmdOn ? (s.commands || 'off') : 'off';
    $('btnDlCmd').style.display = cmdOn ? 'inline-block' : 'none';
    btnState($('btnDlCmd'), s.commands || 'off', /download|loading/i, /ready/i);
    setBar('pbCmd', s.commands || 'off', cmdOn);
  }
  $('btnDlClean').addEventListener('click', async () => { $('btnDlClean').textContent = 'Starting…'; $('btnDlClean').disabled = true; await window.medasr.setup('cleanup'); });
  $('btnDlVad').addEventListener('click', async () => { $('btnDlVad').textContent = 'Starting…'; $('btnDlVad').disabled = true; await window.medasr.setup('vad'); });
  $('btnDlCmd').addEventListener('click', async () => { $('btnDlCmd').textContent = 'Starting…'; $('btnDlCmd').disabled = true; await window.medasr.setup('commands'); });
  $('btnDlStt').addEventListener('click', async () => {
    $('btnDlStt').textContent = 'Starting…'; $('btnDlStt').disabled = true;
    const r = await window.medasr.setup('stt');
    if (r && r.ok === false) { $('sttHint').textContent = '⚠ ' + (r.error || 'download failed'); }
  });
  $('alwaysOnCommands').addEventListener('change', refreshStatus);
  refreshStatus();
  setInterval(refreshStatus, 1200);

  // real-time / VAD controls
  $('realtimeMode').checked = !!settings.realtimeMode;
  $('realtimeReplace').checked = settings.realtimeReplace !== false;
  $('vadSilenceMs').value = settings.vadSilenceMs ?? 700;
  $('vadProbThreshold').value = settings.vadProbThreshold ?? 0.5;
  $('vadMinSpeechMs').value = settings.vadMinSpeechMs ?? 250;
  const sync = () => {
    $('vadSilenceVal').textContent = $('vadSilenceMs').value;
    $('vadThreshVal').textContent = $('vadProbThreshold').value;
    $('vadMinVal').textContent = $('vadMinSpeechMs').value;
    $('vadBox').style.display = $('realtimeMode').checked ? 'block' : 'none';
  };
  ['vadSilenceMs', 'vadProbThreshold', 'vadMinSpeechMs', 'realtimeMode'].forEach(
    (id) => $(id).addEventListener('input', sync));
  sync();

  $('save').addEventListener('click', async () => {
    const sel = $('cleanup').value;
    const enabled = sel !== 'off';
    await window.medasr.setSettings({
      sttEngine: $('stt').value,
      cleanupModel: enabled ? sel : (settings.cleanupModel || 'lfm2.5-8b-a1b'),
      cleanupEnabled: enabled,
      autoInject: $('autoInject').checked,
      lockFocus: $('lockFocus').checked,
      voiceCommands: $('voiceCommands').checked,
      voiceNav: $('voiceNav').checked,
      voiceActions: $('voiceActions').checked,
      alwaysOnCommands: $('alwaysOnCommands').checked,
      macros: window.__serializeMacros ? window.__serializeMacros() : (settings.macros || ''),
      pacsCommand: $('pacsCommand').value.trim(),
      hotkey: $('hotkey').value.trim() || 'Alt+Q',
      llmModelPath: $('modelPath').value.trim(),
      modelsDirOverride: $('modelsDir').value.trim(),
      realtimeMode: $('realtimeMode').checked,
      realtimeReplace: $('realtimeReplace').checked,
      vadSilenceMs: Number($('vadSilenceMs').value),
      vadProbThreshold: Number($('vadProbThreshold').value),
      vadMinSpeechMs: Number($('vadMinSpeechMs').value),
    });
    const s = $('saved');
    s.textContent = enabled ? 'Saved ✓ — downloading/loading the cleaning model…' : 'Saved ✓';
    s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 3500);
  });
}

init();
