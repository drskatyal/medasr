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
  $('macros').value = settings.macros || '';
  $('pacsCommand').value = settings.pacsCommand || '';
  $('hotkey').value = settings.hotkey || 'Alt+Q';
  $('modelPath').value = settings.llmModelPath || '';

  // Live status panel + setup buttons (so setup/errors are visible, no pop-ups).
  function btnState(btn, state, downloadingRe, readyRe) {
    if (readyRe.test(state)) { btn.textContent = '✓ Installed'; btn.disabled = true; }
    else if (downloadingRe.test(state)) { btn.textContent = state.replace(/^.*?(\d+%).*$/, 'Downloading $1'); if (!/\d+%/.test(btn.textContent)) btn.textContent = 'Working…'; btn.disabled = true; }
    else { btn.textContent = 'Download'; btn.disabled = false; }
  }
  async function refreshStatus() {
    let s;
    try { s = await window.medasr.getStatus(); } catch (e) { return; }
    // Input model: make the ACTIVE engine obvious.
    $('stStt').textContent = s.modelReady
      ? (s.sttActive === s.sttSelected ? `${s.sttActive} — running`
         : `${s.sttActive} running (you selected ${s.sttSelected}: ${s.sttNote || 'not available'})`)
      : (s.sttNote || 'not loaded');
    // Cleaning
    const cleanSel = $('cleanup').value;
    $('stClean').textContent = cleanSel === 'off' ? 'off' : `${cleanSel} — ${s.cleaning}`;
    $('btnDlClean').style.display = cleanSel === 'off' ? 'none' : 'inline-block';
    btnState($('btnDlClean'), s.cleaning, /download|loading/i, /ready|✓/i);
    // Real-time VAD
    $('stVad').textContent = $('realtimeMode').checked ? s.vad : 'off';
    $('btnDlVad').style.display = $('realtimeMode').checked ? 'inline-block' : 'none';
    btnState($('btnDlVad'), s.vad, /download|loading/i, /ready/i);
    // Always-on commands (Vosk)
    const cmdOn = $('alwaysOnCommands').checked;
    $('stCmd').textContent = cmdOn ? (s.commands || 'off') : 'off';
    $('btnDlCmd').style.display = cmdOn ? 'inline-block' : 'none';
    btnState($('btnDlCmd'), s.commands || 'off', /download|loading/i, /ready/i);
  }
  $('btnDlClean').addEventListener('click', async () => { $('btnDlClean').textContent = 'Starting…'; $('btnDlClean').disabled = true; await window.medasr.setup('cleanup'); });
  $('btnDlVad').addEventListener('click', async () => { $('btnDlVad').textContent = 'Starting…'; $('btnDlVad').disabled = true; await window.medasr.setup('vad'); });
  $('btnDlCmd').addEventListener('click', async () => { $('btnDlCmd').textContent = 'Starting…'; $('btnDlCmd').disabled = true; await window.medasr.setup('commands'); });
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
      macros: $('macros').value,
      pacsCommand: $('pacsCommand').value.trim(),
      hotkey: $('hotkey').value.trim() || 'Alt+Q',
      llmModelPath: $('modelPath').value.trim(),
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
