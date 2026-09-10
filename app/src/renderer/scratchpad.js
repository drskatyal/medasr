'use strict';

const pad = document.getElementById('pad');
const brandSub = document.getElementById('brandSub');
let saveTimer = 0;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { window.medasr.scratchpadChanged(pad.value); } catch (e) {}
  }, 400);
}

async function init() {
  try {
    const b = await window.medasr.getBranding();
    if (b && b.APP_NAME && brandSub) brandSub.textContent = b.APP_NAME;
  } catch (e) {}
  try {
    const s = await window.medasr.getSettings();
    pad.value = (s && s.scratchpadText) || '';
  } catch (e) {}
}

pad.addEventListener('input', scheduleSave);

document.getElementById('copy').addEventListener('click', async () => {
  try { await window.medasr.scratchpadCopy(pad.value); } catch (e) {}
});
document.getElementById('clear').addEventListener('click', () => {
  pad.value = '';
  scheduleSave();
});
document.getElementById('type').addEventListener('click', async () => {
  const t = pad.value;
  if (!t) return;
  try { await window.medasr.scratchpadType(t); } catch (e) {}
});
document.getElementById('hide').addEventListener('click', () => {
  try { window.medasr.hideScratchpad(); } catch (e) {}
});

window.medasr.onScratchpadSet((text) => {
  const keep = document.activeElement === pad;
  const start = pad.selectionStart, end = pad.selectionEnd;
  pad.value = text || '';
  if (keep) {
    try { pad.setSelectionRange(start, end); } catch (e) {}
  }
});

init();
