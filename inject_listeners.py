with open(r'e:\Dropbox\hemitExport\GLBViewer\src\main.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the "Drag and drop" section comment line
drag_marker = 'window.addEventListener(\'dragover\', (event) => {'
idx = content.find(drag_marker)
if idx == -1:
    print('ERROR: dragover marker not found')
    exit(1)

# Walk backward to find the comment line above it
newline_before = content.rfind('\n', 0, idx)
insert_point = newline_before + 1  # start of the comment line
print(f'Inserting before index: {insert_point}')
print(f'Context: {repr(content[insert_point:insert_point+80])}')

new_listeners = """// ── External animation GLB controls ────────────────────────────────────────────

if (ui.animGlbUpload) {
  ui.animGlbUpload.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await loadExternalAnimGlb(file);
  });
}

if (ui.animGlbClear) {
  ui.animGlbClear.addEventListener('click', clearExternalAnimGlb);
}

// ── Lip sync controls ────────────────────────────────────────────────────────

if (ui.lipSyncWav) {
  ui.lipSyncWav.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (ui.speechStatus) ui.speechStatus.textContent = 'Decoding audio\u2026';
    try {
      const arrayBuffer = await file.arrayBuffer();
      if (!lipSyncAudioCtx) lipSyncAudioCtx = new AudioContext();
      lipSyncAudioBuffer = await lipSyncAudioCtx.decodeAudioData(arrayBuffer);
      updateSpeechReadyState();
    } catch (err) {
      if (ui.speechStatus) ui.speechStatus.textContent = `\u2717 Failed to decode WAV: ${err.message}`;
    }
  });
}

if (ui.lipSyncJson) {
  ui.lipSyncJson.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      lipSyncCues = parseLipSyncJson(text);
      updateSpeechReadyState();
    } catch (err) {
      if (ui.speechStatus) ui.speechStatus.textContent = `\u2717 Invalid JSON: ${err.message}`;
    }
  });
}

if (ui.lipSyncPlay) {
  ui.lipSyncPlay.addEventListener('click', playLipSync);
}

if (ui.lipSyncStop) {
  ui.lipSyncStop.addEventListener('click', () => stopLipSync(false));
}

// ── Viseme mapping controls ──────────────────────────────────────────────────

if (ui.mappingPreset) {
  ui.mappingPreset.addEventListener('change', () => {
    const presetKey = ui.mappingPreset.value;
    mappingRows = presetToRows(PRESETS[presetKey] || ARKIT_PRESET);
    renderMappingTable();
    rebuildVisemeIndex();
  });
}

if (ui.mappingAddRow) {
  ui.mappingAddRow.addEventListener('click', () => {
    mappingRows.push({ cue: 'X', name: '', weight: 1.0 });
    renderMappingTable();
  });
}

if (ui.mappingExport) {
  ui.mappingExport.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(mappingRows, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'viseme-mapping.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

if (ui.mappingImport) {
  ui.mappingImport.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
      mappingRows = parsed.map((r) => ({
        cue: String(r.cue || 'X'),
        name: String(r.name || ''),
        weight: parseFloat(r.weight) || 0,
      }));
      renderMappingTable();
      rebuildVisemeIndex();
    } catch (err) {
      console.warn('[LipSync] Failed to import mapping:', err);
    }
  });
}

"""

content = content[:insert_point] + new_listeners + content[insert_point:]

with open(r'e:\Dropbox\hemitExport\GLBViewer\src\main.js', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'Done. File size: {len(content)}')
print(f'lipSyncWav listener: {"lipSyncWav" in content}')
print(f'mappingExport listener: {"mappingExport" in content}')
print(f'animGlbUpload listener: {"animGlbUpload" in content}')
