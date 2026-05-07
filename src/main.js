import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

const viewport = document.querySelector('#viewport');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1a1f28');

const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.01, 1000);
camera.position.set(2.5, 1.8, 3.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.8, 0);

const gltfLoader = new GLTFLoader();
const rgbeLoader = new RGBELoader();
const exrLoader = new EXRLoader();
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

const root = new THREE.Group();
scene.add(root);

let currentModel = null;
let currentEnvMap = null;
let currentHdrTexture = null;
let currentModelBlobUrl = null;
let currentHdrBlobUrl = null;

// ── Quality presets ────────────────────────────────────────────
const _dpr = window.devicePixelRatio;
const QUALITY_PRESETS = {
  low:    { pixelRatio: 1,                  shadowSize: 512,  shadows: false, ibl: false },
  medium: { pixelRatio: Math.min(_dpr, 1.5), shadowSize: 1024, shadows: true,  ibl: true  },
  high:   { pixelRatio: Math.min(_dpr, 2),  shadowSize: 2048, shadows: true,  ibl: true  }
};

function detectQuality() {
  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (isMobile) return 'low';
  const mem = navigator.deviceMemory; // undefined on Firefox/Safari
  if (mem !== undefined && mem < 4) return 'low';
  if (mem !== undefined && mem >= 8) return 'high';
  return 'medium';
}

function applyQualityPreset(name) {
  const preset = QUALITY_PRESETS[name];
  if (!preset) return;

  renderer.setPixelRatio(preset.pixelRatio);
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);

  // Resize shadow maps on lights that cast shadows
  const shadowLights = [directionalLight, pointLight, spotLight];
  for (const light of shadowLights) {
    light.castShadow = preset.shadows;
    if (preset.shadows) {
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
      light.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
    }
  }

  // IBL environment reflections
  scene.environment = preset.ibl && currentEnvMap ? currentEnvMap : null;
}

// Camera reset: store initial camera state per-model
let defaultCameraPosition = new THREE.Vector3(2.5, 1.8, 3.2);
let defaultCameraTarget = new THREE.Vector3(0, 0, 0);

// Animation state
let mixer = null;
let currentAction = null;
let animationClips = [];
const clock = new THREE.Clock();
let currentGltf = null;         // stored for external anim clip restoration

// ── Lip sync state ─────────────────────────────────────────────
let lipSyncCues = null;         // parsed Rhubarb mouthCues array
let lipSyncAudioBuffer = null;  // decoded AudioBuffer
let lipSyncAudioCtx = null;     // lazy AudioContext
let lipSyncSourceNode = null;   // current BufferSourceNode
let lipSyncStartTime = 0;       // audioCtx.currentTime at playback start
let lipSyncPlaying = false;
let lipSyncCurrentShape = 'X';

// ── External animation GLB state ───────────────────────────────
let externalAnimBlobUrl = null;

// ── Viseme presets ─────────────────────────────────────────────
const CUES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'];
const CUE_DESCRIPTIONS = {
  A: 'P/B/M', B: 'K/S/T', C: 'EH', D: 'AA',
  E: 'AO/ER', F: 'UW/OW', G: 'F/V', H: 'L/N', X: 'silence'
};

const ARKIT_PRESET = {
  A: [{ name: 'viseme_PP',  weight: 1.0 }],
  B: [{ name: 'viseme_kk',  weight: 0.8 }, { name: 'viseme_E',   weight: 0.4 }],
  C: [{ name: 'viseme_E',   weight: 0.9 }],
  D: [{ name: 'viseme_aa',  weight: 1.0 }],
  E: [{ name: 'viseme_O',   weight: 0.9 }, { name: 'viseme_RR',  weight: 0.5 }],
  F: [{ name: 'viseme_U',   weight: 1.0 }],
  G: [{ name: 'viseme_FF',  weight: 1.0 }],
  H: [{ name: 'viseme_nn',  weight: 0.8 }],
  X: [{ name: 'viseme_sil', weight: 1.0 }],
};

const CC5_PRESET = {
  A: [{ name: 'B_M_P',       weight: 1.0 }],
  B: [{ name: 'S_Z',         weight: 0.8 }, { name: 'EE',          weight: 0.4 }],
  C: [{ name: 'AE',          weight: 0.9 }, { name: 'Mouth_Open',  weight: 0.3 }],
  D: [{ name: 'Ah',          weight: 1.0 }, { name: 'Mouth_Open',  weight: 0.9 }],
  E: [{ name: 'Oh',          weight: 0.9 }, { name: 'Er',          weight: 0.5 }],
  F: [{ name: 'W_OO',        weight: 1.0 }],
  G: [{ name: 'F_V',         weight: 1.0 }],
  H: [{ name: 'T_L_D_N',    weight: 0.8 }, { name: 'V_Tongue_Up', weight: 0.5 }],
  X: [{ name: 'Mouth_Close', weight: 0.5 }],
};

const PRESETS = { arkit: ARKIT_PRESET, cc5: CC5_PRESET };

function presetToRows(presetObj) {
  const rows = [];
  for (const cue of CUES) {
    for (const { name, weight } of (presetObj[cue] || [])) {
      rows.push({ cue, name, weight });
    }
  }
  return rows;
}

let mappingRows = presetToRows(ARKIT_PRESET);
let visemeIndex = new Map(); // shapeName → [{influences, morphIndex}]

// Light base intensities (used as 1Ã— for the multiplier slider)
const lightBaseIntensity = {
  directional: 2.2,
  point: 60,
  spot: 130,
  hemisphere: 1.2
};
let keyLightMultiplier = 1.0;

const grid = new THREE.GridHelper(20, 20, 0x4f617a, 0x2f3b4d);
scene.add(grid);

const shadowPlaneMaterial = new THREE.ShadowMaterial({ opacity: 0.35 });
const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), shadowPlaneMaterial);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
shadowPlane.visible = false;
scene.add(shadowPlane);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, lightBaseIntensity.directional);
directionalLight.position.set(4, 7, 3);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.set(2048, 2048);
directionalLight.shadow.camera.near = 0.1;
directionalLight.shadow.camera.far = 40;
directionalLight.shadow.camera.left = -8;
directionalLight.shadow.camera.right = 8;
directionalLight.shadow.camera.top = 8;
directionalLight.shadow.camera.bottom = -8;
scene.add(directionalLight);

const pointLight = new THREE.PointLight(0xffffff, lightBaseIntensity.point, 100, 2);
pointLight.position.set(2.5, 3, 2.5);
pointLight.castShadow = true;
pointLight.visible = false;
scene.add(pointLight);

const spotLight = new THREE.SpotLight(0xffffff, lightBaseIntensity.spot, 100, Math.PI / 5, 0.3, 1.2);
spotLight.position.set(3.5, 5, 3.5);
spotLight.target.position.set(0, 0.7, 0);
spotLight.castShadow = true;
spotLight.visible = false;
scene.add(spotLight);
scene.add(spotLight.target);

const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x1f2a3a, lightBaseIntensity.hemisphere);
hemisphereLight.visible = false;
scene.add(hemisphereLight);

const keyLights = {
  directional: directionalLight,
  point: pointLight,
  spot: spotLight,
  hemisphere: hemisphereLight
};

const ui = {
  modelSelect: document.querySelector('#modelSelect'),
  loadModelButton: document.querySelector('#loadModelButton'),
  modelUpload: document.querySelector('#modelUpload'),
  resetCameraButton: document.querySelector('#resetCameraButton'),
  hdrSelect: document.querySelector('#hdrSelect'),
  loadHdrButton: document.querySelector('#loadHdrButton'),
  hdrUpload: document.querySelector('#hdrUpload'),
  hdrExposure: document.querySelector('#hdrExposure'),
  hdrExposureVal: document.querySelector('#hdrExposureVal'),
  lightType: document.querySelector('#lightType'),
  keyLightMult: document.querySelector('#keyLightMult'),
  keyLightMultVal: document.querySelector('#keyLightMultVal'),
  ambientIntensity: document.querySelector('#ambientIntensity'),
  ambientIntensityVal: document.querySelector('#ambientIntensityVal'),
  ambientEnabled: document.querySelector('#ambientEnabled'),
  envBackground: document.querySelector('#envBackground'),
  materialOverride: document.querySelector('#materialOverride'),
  gridEnabled: document.querySelector('#gridEnabled'),
  planeEnabled: document.querySelector('#planeEnabled'),
  shadowsEnabled: document.querySelector('#shadowsEnabled'),
  animNone: document.querySelector('#animNone'),
  animControls: document.querySelector('#animControls'),
  animSelect: document.querySelector('#animSelect'),
  animPlay: document.querySelector('#animPlay'),
  animPause: document.querySelector('#animPause'),
  animStop: document.querySelector('#animStop'),
  animLoop: document.querySelector('#animLoop'),
  blendshapeNone: document.querySelector('#blendshapeNone'),
  blendshapeControls: document.querySelector('#blendshapeControls'),
  panel: document.querySelector('#panel'),
  panelToggle: document.querySelector('#panelToggle'),
  qualitySelect: document.querySelector('#qualitySelect'),
  animGlbUpload:      document.querySelector('#animGlbUpload'),
  animGlbClear:       document.querySelector('#animGlbClear'),
  lipSyncWav:         document.querySelector('#lipSyncWav'),
  lipSyncJson:        document.querySelector('#lipSyncJson'),
  lipSyncPlay:        document.querySelector('#lipSyncPlay'),
  lipSyncStop:        document.querySelector('#lipSyncStop'),
  lipSyncShape:       document.querySelector('#lipSyncShape'),
  speechStatus:       document.querySelector('#speechStatus'),
  speechControls:     document.querySelector('#speechControls'),
  mappingPreset:      document.querySelector('#mappingPreset'),
  mappingTableBody:   document.querySelector('#mappingTableBody'),
  mappingAddRow:      document.querySelector('#mappingAddRow'),
  mappingExport:      document.querySelector('#mappingExport'),
  mappingImport:      document.querySelector('#mappingImport'),
  mappingPresetLabel: document.querySelector('#mappingPresetLabel'),
};

async function loadList(url, key) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data[key]) ? data[key] : [];
  } catch {
    return [];
  }
}

function fillSelect(select, values, emptyText) {
  select.innerHTML = '';
  if (!values.length) {
    const option = document.createElement('option');
    option.textContent = emptyText;
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function disposeCurrentModel() {
  if (!currentModel) return;

  stopAnimation();
  resetBlendshapeControls();

  const materialsToDispose = new Set();

  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();

    const originalMaterial = child.userData?.originalMaterial;
    if (Array.isArray(originalMaterial)) {
      originalMaterial.forEach((material) => material && materialsToDispose.add(material));
    } else if (originalMaterial) {
      materialsToDispose.add(originalMaterial);
    }

    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material && materialsToDispose.add(material));
    } else {
      if (child.material) materialsToDispose.add(child.material);
    }
  });

  materialsToDispose.forEach((material) => material.dispose());

  root.remove(currentModel);
  currentModel = null;
}

function applyShadowsToModel(enabled) {
  if (!currentModel) return;

  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = enabled;
    child.receiveShadow = enabled;
  });
}

function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  model.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
  const fitDistance = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const distance = fitDistance * 1.8;

  camera.near = Math.max(maxDim / 100, 0.01);
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();

  const newPos = new THREE.Vector3(distance * 0.75, distance * 0.55, distance);
  camera.position.copy(newPos);
  controls.target.set(0, 0, 0);
  controls.update();

  // Store for reset
  defaultCameraPosition.copy(newPos);
  defaultCameraTarget.set(0, 0, 0);
}

function smoothMeshNormals(mesh) {
  const geometry = mesh.geometry;
  if (!geometry?.attributes?.position) return;

  geometry.computeVertexNormals();
  if (geometry.attributes.normal) {
    geometry.attributes.normal.needsUpdate = true;
  }

  if (Array.isArray(mesh.material)) {
    for (const material of mesh.material) {
      if (!material) continue;
      material.flatShading = false;
      material.needsUpdate = true;
    }
  } else if (mesh.material) {
    mesh.material.flatShading = false;
    mesh.material.needsUpdate = true;
  }
}

function getMaterialReference(material) {
  if (Array.isArray(material)) {
    return material.find((entry) => !!entry) || null;
  }
  return material || null;
}

function createOverrideMaterial(mesh, mode) {
  const sourceMaterial = getMaterialReference(mesh.userData.originalMaterial || mesh.material);
  const baseColor = sourceMaterial?.color ? sourceMaterial.color.clone() : new THREE.Color(0xffffff);
  const hasMorphTargets = !!mesh.morphTargetInfluences;
  const hasMorphNormals = !!mesh.geometry?.morphAttributes?.normal?.length;

  const commonSettings = {
    color: baseColor,
    side: sourceMaterial?.side ?? THREE.FrontSide,
    transparent: sourceMaterial?.transparent ?? false,
    opacity: sourceMaterial?.opacity ?? 1,
    map: sourceMaterial?.map ?? null,
    alphaMap: sourceMaterial?.alphaMap ?? null,
    normalMap: sourceMaterial?.normalMap ?? null,
    flatShading: false
  };

  const applyDeformationFlags = (material) => {
    material.skinning = !!mesh.isSkinnedMesh;
    if ('morphTargets' in material) material.morphTargets = hasMorphTargets;
    if ('morphNormals' in material) material.morphNormals = hasMorphNormals;
    material.needsUpdate = true;
    return material;
  };

  if (mode === 'matte') {
    return applyDeformationFlags(new THREE.MeshStandardMaterial({
      ...commonSettings,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0
    }));
  }

  return applyDeformationFlags(new THREE.MeshPhysicalMaterial({
    ...commonSettings,
    color: new THREE.Color(0xffffff),
    roughness: 0,
    metalness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0,
    envMapIntensity: 1.5
  }));
}

function applyMaterialOverride(mode) {
  if (!currentModel) return;

  currentModel.traverse((child) => {
    if (!child.isMesh) return;

    if (!child.userData.originalMaterial) {
      child.userData.originalMaterial = child.material;
    }

    const currentMaterial = child.material;
    if (mode === 'original') {
      const originalMaterial = child.userData.originalMaterial;
      if (currentMaterial !== originalMaterial) {
        if (Array.isArray(currentMaterial)) {
          currentMaterial.forEach((material) => material?.dispose());
        } else {
          currentMaterial?.dispose();
        }
        child.material = originalMaterial;
      }
      return;
    }

    const originalMaterial = child.userData.originalMaterial;
    if (currentMaterial !== originalMaterial) {
      if (Array.isArray(currentMaterial)) {
        currentMaterial.forEach((material) => material?.dispose());
      } else {
        currentMaterial?.dispose();
      }
    }

    child.material = createOverrideMaterial(child, mode);
  });
}

function resetBlendshapeControls() {
  ui.blendshapeControls.innerHTML = '';
  ui.blendshapeControls.style.display = 'none';
  ui.blendshapeNone.style.display = '';
}

function clampBlendshapeValue(value) {
  return Math.min(1, Math.max(0, value));
}

function hasMeaningfulMorphPosition(geometry, targetIndex, epsilon = 1e-6) {
  const morphPosition = geometry?.morphAttributes?.position?.[targetIndex];
  const values = morphPosition?.array;
  if (!values?.length) return false;

  for (let i = 0; i < values.length; i += 1) {
    if (Math.abs(values[i]) > epsilon) {
      return true;
    }
  }

  return false;
}

function setupBlendshapeControls(model) {
  resetBlendshapeControls();

  const groups = [];
  model.traverse((child) => {
    if (!child.isMesh || !child.morphTargetInfluences?.length) return;

    const influences = child.morphTargetInfluences;
    const dictionary = child.morphTargetDictionary || {};
    const entries = Object.entries(dictionary)
      .sort((a, b) => a[1] - b[1]);

    // Some exports omit target names; build stable fallback names so sliders still work.
    const usedIndices = new Set(entries.map(([, index]) => index));
    for (let i = 0; i < influences.length; i += 1) {
      if (!usedIndices.has(i)) {
        entries.push([`Target ${i}`, i]);
      }
    }

    entries.sort((a, b) => a[1] - b[1]);
    if (!entries.length) return;

    const morphPositionCount = child.geometry?.morphAttributes?.position?.length ?? 0;
    const morphNormalCount = child.geometry?.morphAttributes?.normal?.length ?? 0;
    const deformingEntries = entries.filter(([, index]) => hasMeaningfulMorphPosition(child.geometry, index));

    if (!deformingEntries.length) return;

    groups.push({
      meshName: child.name || child.parent?.name || '(unnamed mesh)',
      influences,
      entries: deformingEntries,
      morphPositionCount,
      morphNormalCount
    });
  });

  if (!groups.length) {
    ui.blendshapeNone.textContent = 'No deforming position blendshapes found in loaded model.';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'blendshape-group';

    const title = document.createElement('p');
    title.className = 'blendshape-group-title';
    title.textContent = `${group.meshName} (targets: ${group.influences.length}, pos: ${group.morphPositionCount}, nrm: ${group.morphNormalCount})`;
    groupEl.appendChild(title);

    for (const [targetName, targetIndex] of group.entries) {
      const row = document.createElement('div');
      row.className = 'blendshape-row';

      const label = document.createElement('label');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = targetName;

      const valueSpan = document.createElement('span');
      valueSpan.className = 'blendshape-value';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      const initialValue = clampBlendshapeValue(Number(group.influences[targetIndex] ?? 0));
      group.influences[targetIndex] = initialValue;
      slider.value = String(initialValue);

      valueSpan.textContent = Number(slider.value).toFixed(2);

      slider.addEventListener('input', () => {
        if (currentAction && !currentAction.paused) {
          currentAction.paused = true;
          ui.animPause.textContent = '▶ Resume';
        }
        const value = clampBlendshapeValue(Number(slider.value));
        slider.value = String(value);
        group.influences[targetIndex] = value;
        valueSpan.textContent = value.toFixed(2);
      });

      label.appendChild(nameSpan);
      label.appendChild(valueSpan);
      row.appendChild(label);
      row.appendChild(slider);
      groupEl.appendChild(row);
    }

    fragment.appendChild(groupEl);
  }

  ui.blendshapeControls.appendChild(fragment);
  ui.blendshapeNone.style.display = 'none';
  ui.blendshapeControls.style.display = '';
}

function resetCamera() {
  camera.position.copy(defaultCameraPosition);
  controls.target.copy(defaultCameraTarget);
  controls.update();
}

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
    ? 'unknown — using ARKit'
    : detected.toUpperCase() + ' detected';
  if (ui.mappingPresetLabel) ui.mappingPresetLabel.textContent = `(${label})`;
  console.log(`[LipSync] Viseme preset: ${label} — ${visemeIndex.size} shapes indexed`);
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
      <td><button class="btn-icon mapping-remove" data-idx="${i}" title="Remove">×</button></td>
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
    ui.speechStatus.textContent = `Ready — ${lipSyncCues.length} cues loaded.`;
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
  if (ui.lipSyncPlay)  ui.lipSyncPlay.textContent = '⏹ Playing…';
  if (ui.speechStatus) ui.speechStatus.textContent = 'Playing…';
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
  if (ui.lipSyncPlay)  ui.lipSyncPlay.textContent = '▶ Play Speech';
  if (ui.lipSyncShape) ui.lipSyncShape.textContent = '—';
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
    setStatus('✗ Failed to parse the animation GLB file.', false);
    return;
  }

  if (!extGltf.animations || extGltf.animations.length === 0) {
    setStatus('✗ No animation clips found in this file.', false);
    return;
  }

  if (!currentModel) {
    setStatus('✗ No character loaded — load a model first.', false);
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
      '✗ No matching skeleton found — bone names do not match the loaded character.',
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
    `✓ ${extGltf.animations.length} clip${extGltf.animations.length > 1 ? 's' : ''} loaded` +
    ` (${matched.length} / ${trackTargets.size} bones matched)`,
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



// â”€â”€ Animation helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function stopAnimation() {
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }
  currentAction = null;
  animationClips = [];
}

function setupAnimations(gltf) {
  stopAnimation();

  if (!gltf.animations || gltf.animations.length === 0) {
    ui.animNone.style.display = '';
    ui.animControls.style.display = 'none';
    return;
  }

  animationClips = gltf.animations;
  mixer = new THREE.AnimationMixer(gltf.scene);

  // Populate clip dropdown
  ui.animSelect.innerHTML = '';
  for (const clip of animationClips) {
    const option = document.createElement('option');
    option.value = clip.name;
    option.textContent = `${clip.name} (${clip.duration.toFixed(2)}s)`;
    ui.animSelect.appendChild(option);
  }

  ui.animNone.style.display = 'none';
  ui.animControls.style.display = '';

  // Auto-play first clip
  playClip(animationClips[0].name);
}

function playClip(name) {
  if (!mixer) return;

  if (currentAction) {
    currentAction.stop();
  }

  const clip = THREE.AnimationClip.findByName(animationClips, name);
  if (!clip) return;

  currentAction = mixer.clipAction(clip);
  currentAction.setLoop(
    ui.animLoop.checked ? THREE.LoopRepeat : THREE.LoopOnce,
    Infinity
  );
  currentAction.clampWhenFinished = !ui.animLoop.checked;
  currentAction.play();
}

// â”€â”€ Model + HDR loaders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function loadModel(url) {
  disposeCurrentModel();

  const gltf = await gltfLoader.loadAsync(url);
  currentModel = gltf.scene;

  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    child.userData.originalMaterial = child.material;
    smoothMeshNormals(child);
    child.castShadow = ui.shadowsEnabled.checked;
    child.receiveShadow = ui.shadowsEnabled.checked;
  });

  root.add(currentModel);
  frameModel(currentModel);
  currentGltf = gltf;
  setupAnimations(gltf);
  setupBlendshapeControls(currentModel);
  detectAndApplyMappingPreset(currentModel);
  applyMaterialOverride(ui.materialOverride.value);
}

function getLowerExtension(source) {
  const cleaned = source.split('?')[0].split('#')[0];
  const dot = cleaned.lastIndexOf('.');
  if (dot < 0) return '';
  return cleaned.slice(dot).toLowerCase();
}

async function loadHdr(url, sourceName = '') {
  if (currentEnvMap) {
    currentEnvMap.dispose();
    currentEnvMap = null;
  }

  if (currentHdrTexture) {
    currentHdrTexture.dispose();
    currentHdrTexture = null;
  }

  const extension = getLowerExtension(sourceName || url);
  const hdrTexture = extension === '.exr'
    ? await exrLoader.loadAsync(url)
    : await rgbeLoader.loadAsync(url);
  hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
  const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;

  currentHdrTexture = hdrTexture;
  currentEnvMap = envMap;

  // Respect current quality preset for IBL
  const iblEnabled = QUALITY_PRESETS[ui.qualitySelect?.value]?.ibl ?? true;
  scene.environment = iblEnabled ? envMap : null;
  scene.background = ui.envBackground.checked ? hdrTexture : new THREE.Color('#1a1f28');
}

function updateKeyLight(type) {
  for (const [name, light] of Object.entries(keyLights)) {
    light.visible = name === type;
  }

  if (type === 'none') {
    for (const light of Object.values(keyLights)) {
      light.visible = false;
    }
  }

  applyKeyLightMultiplier();
}

function applyKeyLightMultiplier() {
  const type = ui.lightType.value;
  if (type === 'none' || !keyLights[type]) return;
  keyLights[type].intensity = lightBaseIntensity[type] * keyLightMultiplier;
}

function setShadowMode(enabled) {
  renderer.shadowMap.enabled = enabled;
  directionalLight.castShadow = enabled;
  pointLight.castShadow = enabled;
  spotLight.castShadow = enabled;
  shadowPlane.visible = enabled && ui.planeEnabled.checked;
  applyShadowsToModel(enabled);
}

function setGroundMode() {
  grid.visible = ui.gridEnabled.checked;
  shadowPlane.visible = ui.shadowsEnabled.checked && ui.planeEnabled.checked;
}

function showStatusMessage(message, type = 'success') {
  const statusEl = document.getElementById('loadStatus');
  statusEl.textContent = message;
  statusEl.className = `load-status visible ${type}`;

  setTimeout(() => {
    statusEl.classList.remove('visible');
  }, 3300);
}

async function tryLoadAsset(loadFn, url, label) {
  try {
    await loadFn(url);
    showStatusMessage(`âœ“ ${label} loaded`, 'success');
    return true;
  } catch (error) {
    console.warn(`Failed to load ${label}: ${url}`, error);
    showStatusMessage(`âœ— Failed to load ${label}`, 'error');
    return false;
  }
}

async function tryLoadHdr(url, label, sourceName = '') {
  try {
    await loadHdr(url, sourceName);
    showStatusMessage(`âœ“ ${label} loaded`, 'success');
    return true;
  } catch (error) {
    console.warn(`Failed to load ${label}: ${url}`, error);
    showStatusMessage(`âœ— Failed to load ${label}`, 'error');
    return false;
  }
}

// â”€â”€ Panel toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function setPanelOpen(open) {
  if (open) {
    ui.panel.classList.remove('collapsed');
    document.body.classList.remove('panel-closed');
    document.body.classList.add('panel-open');
    ui.panelToggle.setAttribute('aria-expanded', 'true');
  } else {
    ui.panel.classList.add('collapsed');
    document.body.classList.remove('panel-open');
    document.body.classList.add('panel-closed');
    ui.panelToggle.setAttribute('aria-expanded', 'false');
  }
  // Trigger resize so canvas fills correctly
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 280);
}

ui.panelToggle.addEventListener('click', () => {
  const isOpen = !ui.panel.classList.contains('collapsed');
  setPanelOpen(!isOpen);
});

// â”€â”€ Collapsible section headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

document.querySelectorAll('.section-header').forEach((header) => {
  header.addEventListener('click', () => {
    const targetId = header.dataset.target;
    const body = document.getElementById(targetId);
    const closed = body.classList.toggle('closed');
    header.classList.toggle('closed', closed);
  });
});

// â”€â”€ UI event listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ui.loadModelButton.addEventListener('click', async () => {
  const value = ui.modelSelect.value;
  if (!value) return;
  await tryLoadAsset(loadModel, `/models/${value}`, 'model');
});

ui.modelUpload.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (currentModelBlobUrl) URL.revokeObjectURL(currentModelBlobUrl);
  currentModelBlobUrl = URL.createObjectURL(file);
  await tryLoadAsset(loadModel, currentModelBlobUrl, 'uploaded model');
});

ui.resetCameraButton.addEventListener('click', resetCamera);

ui.loadHdrButton.addEventListener('click', async () => {
  const value = ui.hdrSelect.value;
  if (!value) return;
  await tryLoadHdr(`/hdr/${value}`, 'HDRI', value);
});

ui.hdrUpload.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (currentHdrBlobUrl) URL.revokeObjectURL(currentHdrBlobUrl);
  currentHdrBlobUrl = URL.createObjectURL(file);
  await tryLoadHdr(currentHdrBlobUrl, 'uploaded HDRI', file.name);
});

ui.hdrExposure.addEventListener('input', () => {
  const val = parseFloat(ui.hdrExposure.value);
  renderer.toneMappingExposure = val;
  ui.hdrExposureVal.textContent = val.toFixed(2);
});

ui.keyLightMult.addEventListener('input', () => {
  keyLightMultiplier = parseFloat(ui.keyLightMult.value);
  ui.keyLightMultVal.textContent = keyLightMultiplier.toFixed(2);
  applyKeyLightMultiplier();
});

ui.ambientIntensity.addEventListener('input', () => {
  const val = parseFloat(ui.ambientIntensity.value);
  ambientLight.intensity = val;
  ui.ambientIntensityVal.textContent = val.toFixed(2);
});

ui.lightType.addEventListener('change', () => {
  // Reset multiplier to 1Ã— when switching light type
  keyLightMultiplier = 1.0;
  ui.keyLightMult.value = 1.0;
  ui.keyLightMultVal.textContent = '1.00';
  updateKeyLight(ui.lightType.value);
});

ui.ambientEnabled.addEventListener('change', () => {
  ambientLight.visible = ui.ambientEnabled.checked;
});

ui.envBackground.addEventListener('change', () => {
  scene.background = ui.envBackground.checked && currentHdrTexture ? currentHdrTexture : new THREE.Color('#1a1f28');
});

ui.materialOverride.addEventListener('change', () => {
  applyMaterialOverride(ui.materialOverride.value);
});

ui.gridEnabled.addEventListener('change', setGroundMode);
ui.planeEnabled.addEventListener('change', setGroundMode);
ui.shadowsEnabled.addEventListener('change', () => setShadowMode(ui.shadowsEnabled.checked));

// â”€â”€ Animation controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ui.animPlay.addEventListener('click', () => {
  const name = ui.animSelect.value;
  if (name) playClip(name);
});

ui.animPause.addEventListener('click', () => {
  if (currentAction) {
    currentAction.paused = !currentAction.paused;
    ui.animPause.textContent = currentAction.paused ? 'â–¶ Resume' : 'â¸ Pause';
  }
});

ui.animStop.addEventListener('click', () => {
  if (currentAction) {
    currentAction.stop();
    currentAction = null;
  }
  ui.animPause.textContent = 'â¸ Pause';
});

ui.animSelect.addEventListener('change', () => {
  ui.animPause.textContent = 'â¸ Pause';
  playClip(ui.animSelect.value);
});

ui.animLoop.addEventListener('change', () => {
  if (!currentAction) return;
  currentAction.setLoop(
    ui.animLoop.checked ? THREE.LoopRepeat : THREE.LoopOnce,
    Infinity
  );
  currentAction.clampWhenFinished = !ui.animLoop.checked;
});

// â”€â”€ Drag and drop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ── External animation GLB controls ────────────────────────────────────────────

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
    if (ui.speechStatus) ui.speechStatus.textContent = 'Decoding audio…';
    try {
      const arrayBuffer = await file.arrayBuffer();
      if (!lipSyncAudioCtx) lipSyncAudioCtx = new AudioContext();
      lipSyncAudioBuffer = await lipSyncAudioCtx.decodeAudioData(arrayBuffer);
      updateSpeechReadyState();
    } catch (err) {
      if (ui.speechStatus) ui.speechStatus.textContent = `✗ Failed to decode WAV: ${err.message}`;
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
      if (ui.speechStatus) ui.speechStatus.textContent = `✗ Invalid JSON: ${err.message}`;
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

window.addEventListener('dragover', (event) => {
  event.preventDefault();
});

window.addEventListener('drop', async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;

  const lower = file.name.toLowerCase();
  const blobUrl = URL.createObjectURL(file);

  if (lower.endsWith('.hdr') || lower.endsWith('.exr')) {
    if (currentHdrBlobUrl) URL.revokeObjectURL(currentHdrBlobUrl);
    currentHdrBlobUrl = blobUrl;
    await tryLoadHdr(blobUrl, 'dropped HDRI', file.name);
    return;
  }

  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
    if (currentModelBlobUrl) URL.revokeObjectURL(currentModelBlobUrl);
    currentModelBlobUrl = blobUrl;
    await tryLoadAsset(loadModel, blobUrl, 'dropped model');
    return;
  }

  URL.revokeObjectURL(blobUrl);
});

// â”€â”€ Resize â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

window.addEventListener('resize', () => {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
});

// â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function init() {
  const [models, hdrs] = await Promise.all([
    loadList('/models/models.json', 'models'),
    loadList('/hdr/hdrs.json', 'hdrs')
  ]);

  fillSelect(ui.modelSelect, models, 'No model entries found');
  fillSelect(ui.hdrSelect, hdrs, 'No HDR entries found');

  updateKeyLight('directional');
  setShadowMode(ui.shadowsEnabled.checked);
  setGroundMode();

  // Auto-detect and apply quality preset
  const detectedQuality = detectQuality();
  ui.qualitySelect.value = detectedQuality;
  // Label auto-detected option so user knows what was chosen for them
  const detectedOption = ui.qualitySelect.querySelector(`option[value="${detectedQuality}"]`);
  if (detectedOption) detectedOption.textContent += ' (auto)';
  applyQualityPreset(detectedQuality);

  // Default panel state: open on desktop, closed on mobile
  const isMobile = window.matchMedia('(max-width: 700px)').matches;
  setPanelOpen(!isMobile);

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);

    // Lip sync tick
    if (lipSyncPlaying && lipSyncAudioCtx) {
      const elapsed = lipSyncAudioCtx.currentTime - lipSyncStartTime;
      const cue = getActiveCue(elapsed);
      if (cue !== lipSyncCurrentShape) {
        lipSyncCurrentShape = cue;
        if (ui.lipSyncShape) ui.lipSyncShape.textContent = cue;
      }
      applyVisemeCue(cue);
    }

    controls.update();
    renderer.render(scene, camera);
  });

  if (models.length) {
    await tryLoadAsset(loadModel, `/models/${models[0]}`, 'default model');
  }

  if (hdrs.length) {
    await tryLoadHdr(`/hdr/${hdrs[0]}`, 'default HDRI', hdrs[0]);
  }
}

init().catch((error) => {
  console.error(error);
});
