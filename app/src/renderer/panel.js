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
  $('hotkey').value = settings.hotkey || 'Alt+Q';
  $('modelPath').value = settings.llmModelPath || '';

  // Live status panel + setup buttons (so setup/errors are visible, no pop-ups).
  async function refreshStatus() {
    let s;
    try { s = await window.medasr.getStatus(); } catch (e) { return; }
    $('stStt').textContent = s.modelReady
      ? `${s.sttActive}${s.sttNote && s.sttNote !== 'running' ? ' — ' + s.sttNote : ' (running)'}`
      : (s.sttNote || 'not loaded');
    $('stClean').textContent = s.cleaning;
    $('stVad').textContent = s.realtime ? s.vad : 'off';
    // show setup buttons contextually
    $('btnSetupStt').style.display = (s.sttNote && /needs|not runnable|failed/.test(s.sttNote)) ? 'inline-block' : 'none';
    $('btnDlClean').style.display = (s.cleaning === 'off' || /error/.test(s.cleaning)) && $('cleanup').value !== 'off' ? 'inline-block' : 'none';
    $('btnDlVad').style.display = (s.realtime && s.vad !== 'ready' && !/download|load/.test(s.vad)) ? 'inline-block' : 'none';
  }
  $('btnDlClean').addEventListener('click', async () => { $('btnDlClean').textContent = 'Downloading…'; await window.medasr.setup('cleanup'); });
  $('btnDlVad').addEventListener('click', async () => { $('btnDlVad').textContent = 'Downloading…'; await window.medasr.setup('vad'); });
  $('btnSetupStt').addEventListener('click', () => {
    alert('This input model needs its files. See docs/PARAKEET.md in the repo for the one-time setup, then reopen Settings.');
  });
  refreshStatus();
  setInterval(refreshStatus, 1500);

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
