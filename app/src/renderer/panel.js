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
  $('hotkey').value = settings.hotkey || 'Alt+Q';
  $('modelPath').value = settings.llmModelPath || '';

  $('save').addEventListener('click', async () => {
    const sel = $('cleanup').value;
    const enabled = sel !== 'off';
    await window.medasr.setSettings({
      sttEngine: $('stt').value,
      cleanupModel: enabled ? sel : (settings.cleanupModel || 'lfm2.5-8b-a1b'),
      cleanupEnabled: enabled,
      autoInject: $('autoInject').checked,
      hotkey: $('hotkey').value.trim() || 'Alt+Q',
      llmModelPath: $('modelPath').value.trim(),
    });
    const s = $('saved');
    s.textContent = enabled ? 'Saved ✓ — downloading/loading the cleaning model…' : 'Saved ✓';
    s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 3500);
  });
}

init();
