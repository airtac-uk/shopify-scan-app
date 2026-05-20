let printConfigLoading = false;
let orientationLoading = false;
let orientationSku = '';
let orientationDriveFile = null;
let orientationSavedRecord = null;
let orientationCurrentEuler = null;
let orientationRenderer = null;
let orientationScene = null;
let orientationCamera = null;
let orientationControls = null;
let orientationMesh = null;
let orientationHighlight = null;
let orientationLibraryPromise = null;
let orientationAnimationFrameId = 0;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function setConfigStatus(message, type = 'info') {
  const el = document.getElementById('printSettingsMessage');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function setConfigLoading(isLoading) {
  printConfigLoading = Boolean(isLoading);
  const spinner = document.getElementById('printSettingsSpinner');
  const button = document.querySelector('#printSettingsForm button');

  if (spinner) spinner.style.display = printConfigLoading ? 'inline-block' : 'none';
  if (button) button.disabled = printConfigLoading;
}

function setOrientationLoading(isLoading) {
  orientationLoading = Boolean(isLoading);
  const lookupButton = document.querySelector('#printOrientationLookupForm button');
  const saveButton = document.getElementById('printOrientationSaveBtn');

  if (lookupButton) lookupButton.disabled = orientationLoading;
  if (saveButton) saveButton.disabled = orientationLoading || !orientationCurrentEuler;
}

function setOrientationViewerStatus(message, type = 'info') {
  const el = document.getElementById('printOrientationViewerStatus');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function patchWebGlPrecisionFormat(context) {
  if (!context || typeof context.getShaderPrecisionFormat !== 'function') return context;

  const originalGetShaderPrecisionFormat = context.getShaderPrecisionFormat.bind(context);
  const patchedGetShaderPrecisionFormat = (shaderType, precisionType) => (
    originalGetShaderPrecisionFormat(shaderType, precisionType) || {
      rangeMin: 127,
      rangeMax: 127,
      precision: 23,
    }
  );
  try {
    context.getShaderPrecisionFormat = patchedGetShaderPrecisionFormat;
    if (!context.getShaderPrecisionFormat(context.VERTEX_SHADER, context.HIGH_FLOAT)) {
      Object.defineProperty(context, 'getShaderPrecisionFormat', {
        value: patchedGetShaderPrecisionFormat,
      });
    }
  } catch (err) {
    return context;
  }

  return context;
}

function createSafeWebGlRenderer(THREE, canvas, options = {}) {
  const contextAttributes = {
    antialias: Boolean(options.antialias),
    alpha: Boolean(options.alpha),
    powerPreference: options.powerPreference || 'high-performance',
  };
  const context = patchWebGlPrecisionFormat(
    canvas.getContext('webgl2', contextAttributes)
      || canvas.getContext('webgl', contextAttributes)
      || canvas.getContext('experimental-webgl', contextAttributes)
  );
  if (!context) {
    throw new Error('WebGL is not available in this browser.');
  }

  return new THREE.WebGLRenderer({
    ...options,
    canvas,
    context,
    precision: options.precision || 'mediump',
  });
}

async function readJsonResponse(response, fallbackMessage) {
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }

  if (!response.ok || !data?.success) {
    throw new Error(data?.error || fallbackMessage);
  }

  return data;
}

function renderPrintSettings(settings) {
  const folderInput = document.getElementById('printDriveFolder');
  const extensionInput = document.getElementById('printStlExtensions');
  const status = document.getElementById('printSettingsStatus');
  const folderIds = Array.isArray(settings?.driveFolderIds) ? settings.driveFolderIds : [];

  if (folderInput) folderInput.value = folderIds.join(', ');
  if (extensionInput) extensionInput.value = settings?.stlExtensions || 'stl,3mf';
  if (status) {
    status.textContent = folderIds.length > 0
      ? `${folderIds.length} Drive ${folderIds.length === 1 ? 'folder' : 'folders'} saved.`
      : 'No STL folder saved yet.';
  }
}

function renderOrientationMeta(status = '') {
  const meta = document.getElementById('printOrientationMeta');
  if (!meta) return;

  if (!orientationSku) {
    meta.textContent = 'No model loaded.';
    return;
  }

  const fileLabel = orientationDriveFile?.name || 'No Drive file found';
  const savedLabel = orientationSavedRecord
    ? `Saved ${orientationSavedRecord.updatedAt ? new Date(orientationSavedRecord.updatedAt).toLocaleString('en-GB') : ''}`
    : 'No saved orientation';
  const statusLabel = status === 'stale'
    ? 'Saved orientation is stale because the Drive file changed.'
    : (status === 'current' ? 'Saved orientation matches the current Drive file.' : savedLabel);

  meta.textContent = `${orientationSku} - ${fileLabel}. ${statusLabel}`;
}

function renderSavedOrientations(orientations = []) {
  const container = document.getElementById('printOrientationSavedList');
  if (!container) return;

  if (!orientations.length) {
    container.innerHTML = '<p class="print-queue-empty">No saved orientations yet.</p>';
    return;
  }

  container.innerHTML = `
    <div class="print-orientation-list__head">Saved Orientations</div>
    ${orientations.slice(0, 12).map((item) => `
      <button
        type="button"
        class="print-orientation-saved"
        data-orientation-sku="${escapeHtmlAttribute(item.sku)}"
      >
        <span>${escapeHtml(item.sku)}</span>
        <small>${escapeHtml(item.driveFileName || 'Drive file')}</small>
      </button>
    `).join('')}
  `;
}

async function loadSavedOrientations() {
  try {
    const response = await fetch('/api/print-queue/orientations', {
      headers: { Accept: 'application/json' },
    });
    const data = await readJsonResponse(response, 'Failed to load saved orientations');
    renderSavedOrientations(Array.isArray(data.orientations) ? data.orientations : []);
  } catch (err) {
    renderSavedOrientations([]);
  }
}

async function loadOrientationLibraries() {
  if (!orientationLibraryPromise) {
    orientationLibraryPromise = Promise.all([
      import('three'),
      import('three/addons/loaders/STLLoader.js'),
      import('three/addons/controls/OrbitControls.js'),
    ]).then(([THREE, stlModule, controlsModule]) => ({
      THREE,
      STLLoader: stlModule.STLLoader,
      OrbitControls: controlsModule.OrbitControls,
    }));
  }

  return orientationLibraryPromise;
}

function disposeOrientationViewer() {
  if (orientationAnimationFrameId) {
    window.cancelAnimationFrame(orientationAnimationFrameId);
    orientationAnimationFrameId = 0;
  }
  if (orientationControls) orientationControls.dispose();
  if (orientationMesh?.geometry) orientationMesh.geometry.dispose();
  if (orientationMesh?.material) orientationMesh.material.dispose();
  if (orientationHighlight?.geometry) orientationHighlight.geometry.dispose();
  if (orientationHighlight?.material) orientationHighlight.material.dispose();
  if (orientationRenderer) {
    orientationRenderer.dispose();
    orientationRenderer.forceContextLoss();
  }

  orientationRenderer = null;
  orientationScene = null;
  orientationCamera = null;
  orientationControls = null;
  orientationMesh = null;
  orientationHighlight = null;
}

function applyOrientationEuler(euler) {
  if (!orientationMesh || !euler) return;
  orientationMesh.rotation.set(Number(euler.x || 0), Number(euler.y || 0), Number(euler.z || 0), 'XYZ');
  orientationCurrentEuler = {
    x: orientationMesh.rotation.x,
    y: orientationMesh.rotation.y,
    z: orientationMesh.rotation.z,
  };
  setOrientationLoading(false);
}

function clearOrientationHighlight() {
  if (!orientationHighlight || !orientationScene) return;
  orientationScene.remove(orientationHighlight);
  orientationHighlight.geometry.dispose();
  orientationHighlight.material.dispose();
  orientationHighlight = null;
}

function selectOrientationFace(intersection, libs) {
  const { THREE } = libs;
  if (!intersection?.face || !orientationMesh) return;

  const normal = intersection.face.normal.clone().normalize();
  const down = new THREE.Vector3(0, 0, -1);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(normal, down);
  orientationMesh.quaternion.copy(quaternion);
  orientationCurrentEuler = {
    x: orientationMesh.rotation.x,
    y: orientationMesh.rotation.y,
    z: orientationMesh.rotation.z,
  };

  clearOrientationHighlight();
  const position = orientationMesh.geometry.attributes.position;
  const index = orientationMesh.geometry.index;
  const faceIndex = intersection.faceIndex || 0;
  const triangle = new THREE.BufferGeometry();
  const vertices = [];
  for (let i = 0; i < 3; i += 1) {
    const vertexIndex = index ? index.getX(faceIndex * 3 + i) : faceIndex * 3 + i;
    const vertex = new THREE.Vector3()
      .fromBufferAttribute(position, vertexIndex)
      .applyMatrix4(orientationMesh.matrixWorld);
    vertices.push(vertex.x, vertex.y, vertex.z);
  }
  triangle.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  orientationHighlight = new THREE.Mesh(
    triangle,
    new THREE.MeshBasicMaterial({
      color: 0x47d18c,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: false,
    })
  );
  orientationScene.add(orientationHighlight);
  setOrientationViewerStatus('Face selected. X/Y will be locked in PreForm; Z remains free for packing.', 'success');
  setOrientationLoading(false);
}

async function createOrientationViewer(arrayBuffer, savedOrientation = null) {
  disposeOrientationViewer();
  const libs = await loadOrientationLibraries();
  const { THREE, STLLoader, OrbitControls } = libs;
  const canvas = document.getElementById('printOrientationCanvas');
  if (!canvas) return;

  const loader = new STLLoader();
  const geometry = loader.parse(arrayBuffer);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.center();

  orientationScene = new THREE.Scene();
  orientationScene.background = new THREE.Color(0x101820);
  orientationCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 10000);
  orientationRenderer = createSafeWebGlRenderer(THREE, canvas, {
    antialias: true,
    alpha: false,
  });
  orientationRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const material = new THREE.MeshStandardMaterial({
    color: 0xd7dde7,
    roughness: 0.56,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  orientationMesh = new THREE.Mesh(geometry, material);
  orientationScene.add(orientationMesh);

  const radius = Math.max(geometry.boundingSphere?.radius || 1, 1);
  orientationCamera.position.set(radius * 1.4, radius * 1.1, radius * 2.7);
  orientationCamera.near = Math.max(radius / 100, 0.01);
  orientationCamera.far = radius * 20;
  orientationCamera.updateProjectionMatrix();

  orientationScene.add(new THREE.HemisphereLight(0xffffff, 0x263140, 1.8));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  keyLight.position.set(3, 5, 6);
  orientationScene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x9fd1ff, 0.8);
  fillLight.position.set(-5, -2, 3);
  orientationScene.add(fillLight);

  orientationControls = new OrbitControls(orientationCamera, canvas);
  orientationControls.enableDamping = true;
  orientationControls.target.set(0, 0, 0);
  orientationControls.update();

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    orientationRenderer.setSize(width, height, false);
    orientationCamera.aspect = width / height;
    orientationCamera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1)
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, orientationCamera);
    const [intersection] = raycaster.intersectObject(orientationMesh, false);
    if (intersection) selectOrientationFace(intersection, libs);
  };

  if (savedOrientation) {
    applyOrientationEuler(savedOrientation);
  } else {
    orientationCurrentEuler = null;
  }

  const renderFrame = () => {
    orientationAnimationFrameId = window.requestAnimationFrame(renderFrame);
    orientationControls.update();
    orientationRenderer.render(orientationScene, orientationCamera);
  };
  renderFrame();
}

async function fetchPrintSettings() {
  setConfigLoading(true);
  setConfigStatus('Loading print settings...', 'info');

  try {
    const response = await fetch('/api/print-queue/settings', {
      headers: { Accept: 'application/json' },
    });
    const data = await readJsonResponse(response, 'Failed to load print settings');
    renderPrintSettings(data.settings || {});
    setConfigStatus('Print settings loaded.', 'success');
  } catch (err) {
    setConfigStatus(`Error: ${err.message}`, 'error');
  } finally {
    setConfigLoading(false);
  }
}

async function savePrintSettings(event) {
  event.preventDefault();
  if (printConfigLoading) return;

  const folderInput = document.getElementById('printDriveFolder');
  const extensionInput = document.getElementById('printStlExtensions');
  const driveFolderValue = String(folderInput?.value || '').trim();
  const stlExtensions = String(extensionInput?.value || 'stl,3mf').trim() || 'stl,3mf';

  setConfigLoading(true);
  setConfigStatus('Saving STL source...', 'info');

  try {
    const response = await fetch('/api/print-queue/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        driveFolderValue,
        stlExtensions,
      }),
    });
    const data = await readJsonResponse(response, 'Failed to save print settings');
    renderPrintSettings(data.settings || {});
    setConfigStatus('STL source saved. Files will be matched by exact SKU filename first.', 'success');
  } catch (err) {
    setConfigStatus(`Error: ${err.message}`, 'error');
  } finally {
    setConfigLoading(false);
  }
}

async function loadOrientationSku(event) {
  if (event) event.preventDefault();
  if (orientationLoading) return;

  const input = document.getElementById('printOrientationSku');
  const sku = String(input?.value || '').trim().toUpperCase();
  if (!sku) {
    setConfigStatus('Enter a SKU to orient.', 'error');
    return;
  }

  const workspace = document.getElementById('printOrientationWorkspace');
  if (workspace) workspace.hidden = false;
  orientationSku = sku;
  orientationDriveFile = null;
  orientationSavedRecord = null;
  orientationCurrentEuler = null;
  setOrientationLoading(true);
  setOrientationViewerStatus(`Loading ${sku}...`, 'info');
  renderOrientationMeta();

  try {
    const metadataResponse = await fetch(`/api/print-queue/orientations/${encodeURIComponent(sku)}`, {
      headers: { Accept: 'application/json' },
    });
    const metadata = await readJsonResponse(metadataResponse, 'Failed to load orientation metadata');
    orientationDriveFile = metadata.driveFile || null;
    orientationSavedRecord = metadata.orientation || null;
    renderOrientationMeta(metadata.status || '');
    if (!orientationDriveFile) {
      throw new Error(`No STL/3MF file found for ${sku}`);
    }

    const modelResponse = await fetch(`/api/print-queue/stl/${encodeURIComponent(sku)}/download?raw=1`, {
      headers: { Accept: 'application/octet-stream' },
    });
    if (!modelResponse.ok) {
      throw new Error(modelResponse.statusText || `Failed to load STL for ${sku}`);
    }

    const buffer = await modelResponse.arrayBuffer();
    await createOrientationViewer(
      buffer,
      metadata.status === 'current' ? orientationSavedRecord?.orientation : null
    );
    if (metadata.status === 'stale') {
      setOrientationViewerStatus('Drive file changed. Select the downward face again and save.', 'error');
    } else if (metadata.status === 'current') {
      setOrientationViewerStatus('Saved orientation loaded. Click another face to re-orient.', 'success');
    } else {
      setOrientationViewerStatus('Click the face that should point down.', 'info');
    }
  } catch (err) {
    setOrientationViewerStatus(`Error: ${err.message}`, 'error');
  } finally {
    setOrientationLoading(false);
  }
}

async function saveOrientation() {
  if (orientationLoading || !orientationSku || !orientationCurrentEuler) return;

  setOrientationLoading(true);
  setOrientationViewerStatus('Saving orientation...', 'info');

  try {
    const response = await fetch(`/api/print-queue/orientations/${encodeURIComponent(orientationSku)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        orientation: orientationCurrentEuler,
      }),
    });
    const data = await readJsonResponse(response, 'Failed to save orientation');
    orientationDriveFile = data.driveFile || orientationDriveFile;
    orientationSavedRecord = data.orientation || null;
    renderOrientationMeta(data.status || '');
    await loadSavedOrientations();
    setOrientationViewerStatus('Orientation saved. PreForm will lock X/Y and leave Z free.', 'success');
  } catch (err) {
    setOrientationViewerStatus(`Error: ${err.message}`, 'error');
  } finally {
    setOrientationLoading(false);
  }
}

function resetOrientationView() {
  if (!orientationMesh) return;
  clearOrientationHighlight();
  orientationMesh.rotation.set(0, 0, 0);
  orientationCurrentEuler = null;
  setOrientationViewerStatus('View reset. Click the face that should point down.', 'info');
  setOrientationLoading(false);
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('printSettingsForm');
  if (form) {
    form.addEventListener('submit', savePrintSettings);
  }

  const orientationForm = document.getElementById('printOrientationLookupForm');
  const orientationSaveBtn = document.getElementById('printOrientationSaveBtn');
  const orientationResetBtn = document.getElementById('printOrientationResetBtn');
  const savedList = document.getElementById('printOrientationSavedList');

  if (orientationForm) {
    orientationForm.addEventListener('submit', loadOrientationSku);
  }
  if (orientationSaveBtn) {
    orientationSaveBtn.addEventListener('click', saveOrientation);
  }
  if (orientationResetBtn) {
    orientationResetBtn.addEventListener('click', resetOrientationView);
  }
  if (savedList) {
    savedList.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-orientation-sku]')
        : null;
      if (!button) return;
      const input = document.getElementById('printOrientationSku');
      if (input) input.value = button.getAttribute('data-orientation-sku') || '';
      loadOrientationSku();
    });
  }

  const params = new URLSearchParams(window.location.search);
  const orientSku = String(params.get('orient') || '').trim().toUpperCase();
  if (orientSku) {
    const input = document.getElementById('printOrientationSku');
    if (input) input.value = orientSku;
    window.setTimeout(() => loadOrientationSku(), 0);
  }

  fetchPrintSettings();
  loadSavedOrientations();
});
