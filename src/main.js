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
  qualitySelect: document.querySelector('#qualitySelect')
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
  setupAnimations(gltf);
  setupBlendshapeControls(currentModel);
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
