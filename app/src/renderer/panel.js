'use strict';

const $ = (id) => document.getElementById(id);

function acceleratorFromDomEvent(e) {
  const skip = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'Dead']);
  if (skip.has(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Command');
  let key;
  if (/^F\d{1,2}$/i.test(e.key)) key = e.key.toUpperCase();
  else if (e.code && e.code.startsWith('Key') && e.code.length === 4) key = e.code.slice(3);
  else if (e.code && e.code.startsWith('Digit') && e.code.length === 6) key = e.code.slice(5);
  else if (e.code === 'Space' || e.key === ' ') key = 'Space';
  else if (e.key && e.key.length === 1) key = e.key.toUpperCase();
  else if (e.key) key = e.key;
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

function bindHotkeyField(input) {
  input.addEventListener('focus', () => {
    input.classList.add('listening');
    input.dataset.prev = input.value;
    input.value = '';
    input.placeholder = 'Press a shortcut…';
  });
  input.addEventListener('blur', () => {
    input.classList.remove('listening');
    if (!input.value) input.value = input.dataset.prev || '';
    input.placeholder = input.id === 'holdHotkey' ? 'Alt+X' : 'Alt+Z';
  });
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { input.blur(); return; }
    const accel = acceleratorFromDomEvent(e);
    if (!accel) return;
    input.value = accel;
    input.blur();
  });
}

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
  const [settings, engines, cmds, brand] = await Promise.all([
    window.medasr.getSettings(),
    window.medasr.getEngines(),
    window.medasr.getCommands().catch(() => []),
    window.medasr.getBranding().catch(() => null),
  ]);
  if (brand) {
    if ($('appName')) $('appName').textContent = brand.APP_NAME || 'Dictate';
    if ($('appBy')) $('appBy').textContent = brand.BYLINE || 'by FlowRad';
    if ($('aboutName')) $('aboutName').textContent = brand.APP_NAME_FULL || 'Dictate by FlowRad';
    if ($('aboutBy')) $('aboutBy').textContent = brand.AUTHOR_CREDIT || 'Developed by Dr. Sanyam Katyal';
    if ($('footerCredit')) $('footerCredit').textContent = brand.AUTHOR_CREDIT || 'Developed by Dr. Sanyam Katyal';
  }

  // Tab switching
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  }));

  // Built-in command reference list
  (function renderCommands() {
    const order = [['internal', 'Dictation control'], ['keys', 'Editing (keyboard actions)'],
      ['runApp', 'Open apps'], ['systemKey', 'System']];
    // Pretty label for a canonical combo, e.g. "mod+shift+z" -> "Ctrl/Cmd+Shift+Z".
    const isMac = /Mac/i.test(navigator.platform);
    const comboLabel = (combo) => combo.split('+').map((p) =>
      p === 'mod' ? (isMac ? 'Cmd' : 'Ctrl') : p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)).join('+');
    const el = $('cmdList'); el.innerHTML = '';
    for (const [type, title] of order) {
      const rows = cmds.filter((c) => c.type === type);
      if (!rows.length) continue;
      const g = document.createElement('div'); g.className = 'cmdgroup';
      const h = document.createElement('h4'); h.textContent = title; g.appendChild(h);
      for (const c of rows) {
        const row = document.createElement('div'); row.className = 'cmdrow';
        const say = document.createElement('span'); say.className = 'say';
        const b = document.createElement('b'); b.textContent = '“' + c.triggers[0] + '”'; say.appendChild(b);
        if (c.triggers.length > 1) {
          const alt = document.createElement('span'); alt.style.color = 'var(--muted)';
          alt.textContent = '  / ' + c.triggers.slice(1).map((t) => '“' + t + '”').join(' / ');
          say.appendChild(alt);
        }
        row.appendChild(say);
        if (c.combo) {
          const does = document.createElement('span'); does.className = 'does';
          const k = document.createElement('kbd'); k.textContent = comboLabel(c.combo);
          does.appendChild(k); row.appendChild(does);
        }
        g.appendChild(row);
      }
      el.appendChild(g);
    }
    if (!el.children.length) el.innerHTML = '<div class="item-sub" style="padding:10px 0">Command list unavailable.</div>';
  })();

  // ---- inline model lists: each model is a selectable row with its note, a
  // Download button, and its own progress. NOTHING here downloads on its own. ----
  const rowsStt = {}, rowsClean = {};
  // MedASR is downloadable too (gated ONNX via the user's HF token) — so it shows
  // a "Set up" button on first run when the weights aren't present yet.
  const sttInstallable = (it) => false; // MedASR ships in the installer
  function buildRow(container, it, group, { installable, isOff }) {
    const row = document.createElement('div'); row.className = 'mrow2';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = group; radio.value = it.id;
    const body = document.createElement('div'); body.className = 'mrow2-body';
    const title = document.createElement('div'); title.className = 'mrow2-title';
    const name = document.createElement('span'); name.textContent = it.label; title.appendChild(name);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.style.display = 'none'; title.appendChild(badge);
    body.appendChild(title);
    if (it.note) { const sub = document.createElement('div'); sub.className = 'mrow2-sub'; sub.textContent = it.note; body.appendChild(sub); }
    const pbar = document.createElement('div'); pbar.className = 'pbar'; pbar.innerHTML = '<i></i><em>0%</em>'; body.appendChild(pbar);
    row.appendChild(radio); row.appendChild(body);
    let btn = null;
    if (installable && !isOff) {
      btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = it.bundled ? 'Bundled' : 'Download';
      btn.addEventListener('click', async () => {
        btn.textContent = 'Starting…'; btn.disabled = true;
        radio.checked = true;
        // MedASR needs the HF token + repo persisted before the gated download —
        // save whatever is currently typed so the user doesn't have to hit Save first.
        if (it.id === 'medasr') {
          try { await window.medasr.setSettings({ hfToken: ($('hfToken').value || '').trim(), medasrRepo: ($('medasrRepo').value || '').trim() }); } catch (e) {}
        }
        const r = await window.medasr.setup(group === 'sttSel' ? 'stt' : 'cleanup', it.id);
        if (r && r.ok === false) { badge.style.display = ''; badge.className = 'badge warn'; badge.textContent = (r.error || 'error').slice(0, 44); }
      });
      row.appendChild(btn);
    }
    container.appendChild(row);
    return { badge, pbar, btn, installable, isOff };
  }
  for (const it of engines.stt) rowsStt[it.id] = buildRow($('sttList'), it, 'sttSel', { installable: sttInstallable(it), isOff: false });
  for (const it of engines.cleanup) rowsClean[it.id] = buildRow($('cleanList'), it, 'cleanSel', { installable: it.id !== 'off' && !it.bundled, isOff: it.id === 'off' });
  const sttRadio = document.querySelector(`input[name=sttSel][value="${settings.sttEngine}"]`);
  if (sttRadio) sttRadio.checked = true;
  const initClean = settings.cleanupEnabled ? (settings.cleanupModel || 'off') : 'off';
  const cleanRadio = document.querySelector(`input[name=cleanSel][value="${initClean}"]`);
  if (cleanRadio) cleanRadio.checked = true;
  document.querySelectorAll('input[name=cleanSel], input[name=sttSel]').forEach((r) => r.addEventListener('change', () => refreshStatus()));

  function setRowState(r, st) {
    if (!r) return;
    setBarEl(r.pbar, st.downloading ? ('downloading ' + (st.pct || 0) + '%') : (st.loading ? 'loading' : ''), !!(st.downloading || st.loading));
    r.badge.style.display = '';
    if (st.downloading) r.badge.style.display = 'none';
    else if (st.active) { r.badge.className = 'badge ok'; r.badge.textContent = 'active'; }
    else if (st.loading) { r.badge.className = 'badge'; r.badge.textContent = 'loading…'; }
    else if (st.installed) { r.badge.className = 'badge'; r.badge.textContent = 'installed'; }
    else if (st.notAvailable) { r.badge.className = 'badge warn'; r.badge.textContent = 'not available yet'; }
    else r.badge.style.display = 'none';
    if (r.btn) {
      if (st.downloading) { r.btn.textContent = 'Downloading ' + (st.pct || 0) + '%'; r.btn.disabled = true; }
      else if (st.installed || st.active) { r.btn.textContent = '✓ Installed'; r.btn.disabled = true; }
      else { r.btn.textContent = 'Download'; r.btn.disabled = false; }
    }
  }

  $('autoInject').checked = settings.autoInject !== false;
  $('lockFocus').checked = settings.lockFocus !== false;
  $('voiceCommands').checked = settings.voiceCommands !== false;
  $('voiceNav').checked = settings.voiceNav !== false;
  $('voiceActions').checked = settings.voiceActions !== false;
  $('alwaysOnCommands').checked = settings.alwaysOnCommands !== false;
  $('notifications').checked = !!settings.notifications;
  $('gpuAccel').checked = settings.gpuAccel !== 'off';
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
  $('holdHotkey').value = settings.holdHotkey || 'Alt+X';
  $('toggleHotkey').value = settings.toggleHotkey || settings.hotkey || 'Alt+Z';
  $('showScratchpad').checked = settings.showScratchpad !== false;
  bindHotkeyField($('holdHotkey'));
  bindHotkeyField($('toggleHotkey'));
  $('holdHotkeyReset').addEventListener('click', () => { $('holdHotkey').value = 'Alt+X'; });
  $('toggleHotkeyReset').addEventListener('click', () => { $('toggleHotkey').value = 'Alt+Z'; });
  $('modelPath').value = settings.llmModelPath || '';
  $('modelsDir').value = settings.modelsDirOverride || '';
  $('llamaServerPath').value = settings.llamaServerPath || '';
  $('hfToken').value = settings.hfToken || '';
  $('medasrRepo').value = settings.medasrRepo || '';

  // Live status panel + setup buttons (so setup/errors are visible, no pop-ups).
  function btnState(btn, state, downloadingRe, readyRe) {
    if (readyRe.test(state)) { btn.textContent = '✓ Installed'; btn.disabled = true; }
    else if (downloadingRe.test(state)) { btn.textContent = state.replace(/^.*?(\d+%).*$/, 'Downloading $1'); if (!/\d+%/.test(btn.textContent)) btn.textContent = 'Working…'; btn.disabled = true; }
    else { btn.textContent = 'Download'; btn.disabled = false; }
  }
  // Drive a download progress bar from a status string: a "42%" shows a filled
  // bar; a wordy "loading…/extracting…" shows an indeterminate sweep; otherwise
  // it's hidden (off / ready / error — the text row carries those).
  function setBarEl(pb, state, active) {
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
  function setBar(id, state, active) { setBarEl($(id), state, active); }
  async function refreshStatus() {
    let s;
    try { s = await window.medasr.getStatus(); } catch (e) { return; }
    // STT engine rows
    for (const it of engines.stt) {
      setRowState(rowsStt[it.id], {
        active: s.modelReady && s.sttActive === it.id,
        installed: !!(s.installed && s.installed[it.id]),
        downloading: s.dl && s.dl.id === it.id,
        pct: s.dl && s.dl.pct,
        notAvailable: !it.implemented && !sttInstallable(it),
      });
    }
    // Cleaning rows (Off has no download/badge except "active")
    for (const it of engines.cleanup) {
      if (it.id === 'off') { setRowState(rowsClean[it.id], { active: s.cleanSelected === 'off' && !s.cleanActive }); continue; }
      setRowState(rowsClean[it.id], {
        active: s.cleanActive === it.id,
        installed: !!(s.installed && s.installed[it.id]),
        downloading: s.dl && s.dl.id === it.id,
        pct: s.dl && s.dl.pct,
        loading: s.cleanState === 'loading' && s.cleanSelected === it.id,
      });
    }
    if ($('modelsDirNow') && s.modelsDir) $('modelsDirNow').textContent = 'Currently: ' + s.modelsDir;
    if ($('gpuNow')) $('gpuNow').textContent = s.cleanBackend
      ? (s.cleanBackend === 'cpu' ? 'Currently running on CPU (no GPU detected).' : `Currently running on ${s.cleanBackend.toUpperCase()}.`)
      : '';
    // Real-time VAD
    const vadOn = $('realtimeMode').checked;
    $('stVad').textContent = vadOn ? s.vad : 'off';
    $('btnDlVad').style.display = vadOn ? 'inline-block' : 'none';
    btnState($('btnDlVad'), s.vad, /downloading|loading/i, /ready/i);
    setBar('pbVad', s.vad, vadOn);
    // Always-on commands (Vosk)
    const cmdOn = $('alwaysOnCommands').checked;
    $('stCmd').textContent = cmdOn ? (s.commands || 'off') : 'off';
    $('btnDlCmd').style.display = cmdOn ? 'inline-block' : 'none';
    btnState($('btnDlCmd'), s.commands || 'off', /downloading|loading/i, /ready/i);
    setBar('pbCmd', s.commands || 'off', cmdOn);
  }
  $('btnDlVad').addEventListener('click', async () => { $('btnDlVad').textContent = 'Starting…'; $('btnDlVad').disabled = true; await window.medasr.setup('vad'); });
  $('btnDlCmd').addEventListener('click', async () => { $('btnDlCmd').textContent = 'Starting…'; $('btnDlCmd').disabled = true; await window.medasr.setup('commands'); });
  $('alwaysOnCommands').addEventListener('change', refreshStatus);
  refreshStatus();
  setInterval(refreshStatus, 1200);

  // real-time / VAD controls
  $('realtimeMode').checked = !!settings.realtimeMode;
  $('realtimeReplace').checked = settings.realtimeReplace !== false;
  $('replaceWholeField').checked = !!settings.replaceWholeField;
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
    const sttEngine = (document.querySelector('input[name=sttSel]:checked') || {}).value || settings.sttEngine;
    const sel = (document.querySelector('input[name=cleanSel]:checked') || {}).value || 'off';
    const enabled = sel !== 'off';
    await window.medasr.setSettings({
      sttEngine,
      cleanupModel: enabled ? sel : (settings.cleanupModel || 'qwen3-1.7b'),
      cleanupEnabled: enabled,
      autoInject: $('autoInject').checked,
      lockFocus: $('lockFocus').checked,
      voiceCommands: $('voiceCommands').checked,
      voiceNav: $('voiceNav').checked,
      voiceActions: $('voiceActions').checked,
      alwaysOnCommands: $('alwaysOnCommands').checked,
      macros: window.__serializeMacros ? window.__serializeMacros() : (settings.macros || ''),
      pacsCommand: $('pacsCommand').value.trim(),
      notifications: $('notifications').checked,
      gpuAccel: $('gpuAccel').checked ? 'auto' : 'off',
      holdHotkey: $('holdHotkey').value.trim() || 'Alt+X',
      toggleHotkey: $('toggleHotkey').value.trim() || 'Alt+Z',
      hotkey: $('toggleHotkey').value.trim() || 'Alt+Z',
      showScratchpad: $('showScratchpad').checked,
      llmModelPath: $('modelPath').value.trim(),
      modelsDirOverride: $('modelsDir').value.trim(),
      llamaServerPath: $('llamaServerPath').value.trim(),
      hfToken: $('hfToken').value.trim(),
      medasrRepo: $('medasrRepo').value.trim(),
      realtimeMode: $('realtimeMode').checked,
      realtimeReplace: $('realtimeReplace').checked,
      replaceWholeField: $('replaceWholeField').checked,
      vadSilenceMs: Number($('vadSilenceMs').value),
      vadProbThreshold: Number($('vadProbThreshold').value),
      vadMinSpeechMs: Number($('vadMinSpeechMs').value),
    });
    const s = $('saved');
    s.textContent = 'Saved ✓';
    s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 3000);
  });
}

init();
