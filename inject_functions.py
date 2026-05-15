import sys

with open(r'e:\Dropbox\hemitExport\GLBViewer\src\main.js', 'r', encoding='utf-8') as f:
    content = f.read()

reset_fn = """function resetCamera() {
  camera.position.copy(defaultCameraPosition);
  controls.target.copy(defaultCameraTarget);
  controls.update();
}"""

insert_idx = content.find(reset_fn)
if insert_idx == -1:
    print('ERROR: resetCamera not found')
    sys.exit(1)

after_reset = insert_idx + len(reset_fn)
print(f'Inserting after index: {after_reset}')

new_block = """

// ── Viseme mapping helpers ──────────────────────────────────────

function detectMappingPreset(model) {
  if (!model) return 'unknown';
  const allMorphNames = new Set();
  model.traverse((child) => {
    if (!child.isMesh || !child.morphTargetDictionary) return;
    Object.keys(child.morphTargetDictionary).forEach((n) => allMorphNames.add(n));
  });
  const cc5Score   = ['B_M_P','Ah','EE','Oh','W_OO','F_V','S_Z','AE'].filter((k) => allMorphNames.has(k)).length;
  const arkitScore = ['viseme_PP','viseme_aa','viseme_kk','viseme_E','viseme_U'].filter((k) => allMorphNames.has(k)).length;
  if (cc5Score >= 2)   return 'cc5';
  if (arkitScore >= 2) return 'arkit';
  return 'unknown';
}

function buildVisemeIndex(model, rows) {
  const index = new Map();
  if (!model) return index;
  const allShapeNames = new Set(rows.map((r) => r.name).filter(Boolean));
  model.traverse((child) => {
    if (!child.isMesh || !child.morphTargetDictionary || !child.morphTargetInfluences) return;
    for (const shapeName of allShapeNames) {
      const morphIndex = child.morphTargetDictionary[shapeName];
      if (morphIndex !== undefined) {
        if (!index.has(shapeName)) index.set(shapeName, []);
        index.get(shapeName).push({ influences: child.morphTargetInfluences, morphIndex });
      }
    }
  });
  return index;
}

function rebuildVisemeIndex() {
  visemeIndex = buildVisemeIndex(currentModel, mappingRows);
}

function detectAndApplyMappingPreset(model) {
  const detected = detectMappingPreset(model);
  const presetKey = detected === 'unknown' ? 'arkit' : detected;
  if (ui.mappingPreset) ui.mappingPreset.value = presetKey;
  mappingRows = presetToRows(PRESETS[presetKey] || ARKIT_PRESET);
  renderMappingTable();
  rebuildVisemeIndex();
  const label = detected === 'unknown'
    ? 'unknown \u2014 using ARKit'
    : detected.toUpperCase() + ' detected';
  if (ui.mappingPresetLabel) ui.mappingPresetLabel.textContent = `(${label})`;
  console.log(`[LipSync] Viseme preset: ${label} \u2014 ${visemeIndex.size} shapes indexed`);
}

function renderMappingTable() {
  const tbody = ui.mappingTableBody;
  if (!tbody) return;
  tbody.innerHTML = '';
  for (let i = 0; i < mappingRows.length; i++) {
    const row = mappingRows[i];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <select class="mapping-cue" data-idx="${i}">
          ${CUES.map((c) => `<option value="${c}"${c === row.cue ? ' selected' : ''}>${c} (${CUE_DESCRIPTIONS[c]})</option>`).join('')}
        </select>
      </td>
      <td><input class="mapping-name" type="text" data-idx="${i}" /></td>
      <td><input class="mapping-weight" type="number" min="0" max="1" step="0.05" value="${row.weight.toFixed(2)}" data-idx="${i}" /></td>
      <td><button class="btn-icon mapping-remove" data-idx="${i}" title="Remove">\u00d7</button></td>
    `;
    // Set via .value property to avoid attribute-injection XSS
    tr.querySelector('.mapping-name').value = row.name;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.mapping-cue').forEach((el) => {
    el.addEventListener('change', () => {
      mappingRows[+el.dataset.idx].cue = el.value;
    });
  });
  tbody.querySelectorAll('.mapping-name').forEach((el) => {
    el.addEventListener('input', () => {
      mappingRows[+el.dataset.idx].name = el.value.trim();
      rebuildVisemeIndex();
    });
  });
  tbody.querySelectorAll('.mapping-weight').forEach((el) => {
    el.addEventListener('input', () => {
      mappingRows[+el.dataset.idx].weight = parseFloat(el.value) || 0;
    });
  });
  tbody.querySelectorAll('.mapping-remove').forEach((el) => {
    el.addEventListener('click', () => {
      mappingRows.splice(+el.dataset.idx, 1);
      renderMappingTable();
      rebuildVisemeIndex();
    });
  });
}

function applyVisemeCue(cue) {
  const targetWeights = new Map();
  for (const row of mappingRows) {
    if (row.cue === cue && row.name) {
      targetWeights.set(row.name, Math.max(targetWeights.get(row.name) ?? 0, row.weight));
    }
  }
  for (const [shapeName, targets] of visemeIndex.entries()) {
    const targetW = targetWeights.get(shapeName) ?? 0;
    for (const { influences, morphIndex } of targets) {
      influences[morphIndex] = THREE.MathUtils.lerp(influences[morphIndex], targetW, 0.25);
    }
  }
}

function resetAllVisemeInfluences() {
  for (const [, targets] of visemeIndex.entries()) {
    for (const { influences, morphIndex } of targets) {
      influences[morphIndex] = 0;
    }
  }
}

function getActiveCue(t) {
  if (!lipSyncCues || !lipSyncCues.length) return 'X';
  let lo = 0, hi = lipSyncCues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = lipSyncCues[mid];
    if      (t < cue.start) hi = mid - 1;
    else if (t >= cue.end)  lo = mid + 1;
    else                    return cue.value;
  }
  return 'X';
}

// ── Lip sync audio + data ───────────────────────────────────────

function parseLipSyncJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.mouthCues)) {
    throw new Error('Invalid Rhubarb JSON: missing mouthCues array');
  }
  return data.mouthCues.map((c) => ({
    start: +c.start,
    end:   +c.end,
    value: String(c.value),
  }));
}

function updateSpeechReadyState() {
  const ready = lipSyncAudioBuffer !== null && lipSyncCues !== null;
  if (ui.speechControls) ui.speechControls.style.display = ready ? '' : 'none';
  if (ready && ui.speechStatus) {
    ui.speechStatus.textContent = `Ready \u2014 ${lipSyncCues.length} cues loaded.`;
  }
}

function playLipSync() {
  if (!lipSyncAudioBuffer || !lipSyncCues) return;
  stopLipSync(false);
  if (!lipSyncAudioCtx) lipSyncAudioCtx = new AudioContext();
  if (lipSyncAudioCtx.state === 'suspended') lipSyncAudioCtx.resume();
  lipSyncSourceNode = lipSyncAudioCtx.createBufferSource();
  lipSyncSourceNode.buffer = lipSyncAudioBuffer;
  lipSyncSourceNode.connect(lipSyncAudioCtx.destination);
  lipSyncStartTime = lipSyncAudioCtx.currentTime;
  lipSyncPlaying = true;
  lipSyncCurrentShape = 'X';
  lipSyncSourceNode.start(0);
  lipSyncSourceNode.onended = () => stopLipSync(true);
  if (ui.lipSyncPlay)  ui.lipSyncPlay.textContent = '\u23f9 Playing\u2026';
  if (ui.speechStatus) ui.speechStatus.textContent = 'Playing\u2026';
}

function stopLipSync(natural = false) {
  if (lipSyncSourceNode) {
    try { lipSyncSourceNode.stop(); } catch (_) { /* already ended */ }
    lipSyncSourceNode.disconnect();
    lipSyncSourceNode = null;
  }
  if (lipSyncPlaying) resetAllVisemeInfluences();
  lipSyncPlaying = false;
  lipSyncCurrentShape = 'X';
  if (ui.lipSyncPlay)  ui.lipSyncPlay.textContent = '\u25b6 Play Speech';
  if (ui.lipSyncShape) ui.lipSyncShape.textContent = '\u2014';
  if (ui.speechStatus && (natural || !lipSyncAudioBuffer)) {
    ui.speechStatus.textContent = natural ? 'Done.' : 'Stopped.';
  }
}

// ── External animation GLB ──────────────────────────────────────

async function loadExternalAnimGlb(file) {
  const statusEl = document.getElementById('animGlbStatus');
  const clearBtn = document.getElementById('animGlbClear');

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.className = `hint anim-glb-status ${ok ? 'status-ok' : 'status-error'}`;
    clearBtn.style.display = ok ? '' : 'none';
  }

  if (externalAnimBlobUrl) {
    URL.revokeObjectURL(externalAnimBlobUrl);
    externalAnimBlobUrl = null;
  }
  externalAnimBlobUrl = URL.createObjectURL(file);

  let extGltf;
  try {
    extGltf = await gltfLoader.loadAsync(externalAnimBlobUrl);
  } catch {
    setStatus('\u2717 Failed to parse the animation GLB file.', false);
    return;
  }

  if (!extGltf.animations || extGltf.animations.length === 0) {
    setStatus('\u2717 No animation clips found in this file.', false);
    return;
  }

  if (!currentModel) {
    setStatus('\u2717 No character loaded \u2014 load a model first.', false);
    return;
  }

  // Collect target bone names from tracks (prefix before first '.')
  const trackTargets = new Set();
  for (const clip of extGltf.animations) {
    for (const track of clip.tracks) {
      trackTargets.add(track.name.split('.')[0]);
    }
  }

  // Collect bone names from the current character
  const modelBones = new Set();
  currentModel.traverse((node) => {
    if (node.isBone || node.type === 'Bone') modelBones.add(node.name);
  });

  const matched = [...trackTargets].filter((n) => modelBones.has(n));
  if (matched.length === 0) {
    setStatus(
      '\u2717 No matching skeleton found \u2014 bone names do not match the loaded character.',
      false
    );
    return;
  }

  // Apply clips to current model's skeleton
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  currentAction = null;
  animationClips = extGltf.animations;
  mixer = new THREE.AnimationMixer(currentModel);

  ui.animSelect.innerHTML = '';
  for (const clip of animationClips) {
    const option = document.createElement('option');
    option.value = clip.name;
    option.textContent = `${clip.name} (${clip.duration.toFixed(2)}s)`;
    ui.animSelect.appendChild(option);
  }
  ui.animNone.style.display = 'none';
  ui.animControls.style.display = '';
  playClip(animationClips[0].name);

  setStatus(
    `\u2713 ${extGltf.animations.length} clip${extGltf.animations.length > 1 ? 's' : ''} loaded` +
    ` (${matched.length}\u202f/\u202f${trackTargets.size} bones matched)`,
    true
  );
}

function clearExternalAnimGlb() {
  if (externalAnimBlobUrl) {
    URL.revokeObjectURL(externalAnimBlobUrl);
    externalAnimBlobUrl = null;
  }
  const uploadEl = document.getElementById('animGlbUpload');
  if (uploadEl) uploadEl.value = '';
  const statusEl = document.getElementById('animGlbStatus');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'hint anim-glb-status'; }
  const clearBtn = document.getElementById('animGlbClear');
  if (clearBtn) clearBtn.style.display = 'none';
  if (currentGltf) setupAnimations(currentGltf);
}

"""

content = content[:after_reset] + new_block + content[after_reset:]

with open(r'e:\Dropbox\hemitExport\GLBViewer\src\main.js', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'Done. File size: {len(content)}')
print(f'detectMappingPreset: {"detectMappingPreset" in content}')
print(f'loadExternalAnimGlb: {"loadExternalAnimGlb" in content}')
print(f'playLipSync: {"playLipSync" in content}')
