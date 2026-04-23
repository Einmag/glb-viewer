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

const directionalLight = new THREE.DirectionalLight(0xffffff, 2.2);
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

const pointLight = new THREE.PointLight(0xffffff, 60, 100, 2);
pointLight.position.set(2.5, 3, 2.5);
pointLight.castShadow = true;
pointLight.visible = false;
scene.add(pointLight);

const spotLight = new THREE.SpotLight(0xffffff, 130, 100, Math.PI / 5, 0.3, 1.2);
spotLight.position.set(3.5, 5, 3.5);
spotLight.target.position.set(0, 0.7, 0);
spotLight.castShadow = true;
spotLight.visible = false;
scene.add(spotLight);
scene.add(spotLight.target);

const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x1f2a3a, 1.2);
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
  hdrSelect: document.querySelector('#hdrSelect'),
  loadHdrButton: document.querySelector('#loadHdrButton'),
  hdrUpload: document.querySelector('#hdrUpload'),
  lightType: document.querySelector('#lightType'),
  ambientEnabled: document.querySelector('#ambientEnabled'),
  envBackground: document.querySelector('#envBackground'),
  gridEnabled: document.querySelector('#gridEnabled'),
  planeEnabled: document.querySelector('#planeEnabled'),
  shadowsEnabled: document.querySelector('#shadowsEnabled')
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

  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();

    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose());
    } else {
      child.material?.dispose();
    }
  });

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

  camera.position.set(distance * 0.75, distance * 0.55, distance);
  controls.target.set(0, 0, 0);
  controls.update();
}

async function loadModel(url) {
  disposeCurrentModel();

  const gltf = await gltfLoader.loadAsync(url);
  currentModel = gltf.scene;

  currentModel.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = ui.shadowsEnabled.checked;
    child.receiveShadow = ui.shadowsEnabled.checked;
  });

  root.add(currentModel);
  frameModel(currentModel);
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
  const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;

  currentHdrTexture = hdrTexture;
  currentEnvMap = envMap;

  scene.environment = envMap;
  scene.background = ui.envBackground.checked ? envMap : new THREE.Color('#1a1f28');
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

  // Remove 'visible' class after animation completes (3.3s) to hide it.
  setTimeout(() => {
    statusEl.classList.remove('visible');
  }, 3300);
}

async function tryLoadAsset(loadFn, url, label) {
  try {
    await loadFn(url);
    showStatusMessage(`✓ ${label} loaded`, 'success');
    return true;
  } catch (error) {
    console.warn(`Failed to load ${label}: ${url}`, error);
    showStatusMessage(`✗ Failed to load ${label}`, 'error');
    return false;
  }
}

async function tryLoadHdr(url, label, sourceName = '') {
  try {
    await loadHdr(url, sourceName);
    showStatusMessage(`✓ ${label} loaded`, 'success');
    return true;
  } catch (error) {
    console.warn(`Failed to load ${label}: ${url}`, error);
    showStatusMessage(`✗ Failed to load ${label}`, 'error');
    return false;
  }
}

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

ui.lightType.addEventListener('change', () => updateKeyLight(ui.lightType.value));
ui.ambientEnabled.addEventListener('change', () => {
  ambientLight.visible = ui.ambientEnabled.checked;
});
ui.envBackground.addEventListener('change', () => {
  scene.background = ui.envBackground.checked && currentEnvMap ? currentEnvMap : new THREE.Color('#1a1f28');
});
ui.gridEnabled.addEventListener('change', setGroundMode);
ui.planeEnabled.addEventListener('change', setGroundMode);
ui.shadowsEnabled.addEventListener('change', () => setShadowMode(ui.shadowsEnabled.checked));

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

window.addEventListener('resize', () => {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
});

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

  // Keep rendering active even if default startup assets fail to load.
  renderer.setAnimationLoop(() => {
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
