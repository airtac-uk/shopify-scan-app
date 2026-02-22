var lastTag = "";
var lastBarcode = "";
var loadingTrack = false;

var hidBuffer = "";
var hidLastKeyAt = 0;
var hidBufferTimeoutId = null;

function loading() {

  loadingTrack = true;
  const scanResult = document.getElementById('scanResult');
  scanResult.textContent = "";


  const spinner = document.getElementById('spinner');
  spinner.style.display = "inline"
  
}

function stopLoading() {

  loadingTrack = false;

  const spinner  = document.getElementById('spinner');
  spinner.style.display = "none"
}

function positiveDing(){ 
  var context = new AudioContext();
  const successNoise = context.createOscillator();
    successNoise.frequency = "600";
    successNoise.type = "sine";
    successNoise.frequency.exponentialRampToValueAtTime(
        800,
        context.currentTime + 0.05
    );
    successNoise.frequency.exponentialRampToValueAtTime(
        1000,
        context.currentTime + 0.15
    );

    successGain = context.createGain();
    successGain.gain.exponentialRampToValueAtTime(
        0.01,
        context.currentTime + 0.3
    );

    successFilter = context.createBiquadFilter("bandpass");
    successFilter.Q = 0.01;

    successNoise
        .connect(successFilter)
        .connect(successGain)
        .connect(context.destination);
    successNoise.start();
    successNoise.stop(context.currentTime + 0.2);
}

function negativeDing(){ 

  var context = new AudioContext();
   const errorNoise = context.createOscillator();
    errorNoise.frequency = "400";
    errorNoise.type = "sine";
    errorNoise.frequency.exponentialRampToValueAtTime(
        200,
        context.currentTime + 0.05
    );
    errorNoise.frequency.exponentialRampToValueAtTime(
        100,
        context.currentTime + 0.2
    );

    errorGain = context.createGain();
    errorGain.gain.exponentialRampToValueAtTime(
        0.01,
        context.currentTime + 0.3
    );

    errorNoise.connect(errorGain).connect(context.destination);
    errorNoise.start();
    errorNoise.stop(context.currentTime + 0.3);
}

function openAwaitingPartsDialog(orderId, lineItems) {
  const form = document.getElementById('awaitingPartsForm');
  form.innerHTML = '';

  lineItems.forEach(item => {
    if (!item.sku) return;

    const label = document.createElement('label');
    label.style.display = 'block';
    label.className = 'awaiting-parts-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.sku;

    label.appendChild(checkbox);
    label.append(` ${item.sku} — ${item.title}`);

    form.appendChild(label);
  });

  form.dataset.orderId = orderId;
  document.getElementById('awaitingPartsModal').style.display = 'block';
}

function closeAwaitingParts() {
  stopLoading();
  document.getElementById('awaitingPartsModal').style.display = 'none';
}

async function submitAwaitingParts() {
  const form = document.getElementById('awaitingPartsForm');
  const orderId = form.dataset.orderId;

  const skus = Array.from(form.querySelectorAll('input:checked'))
    .map(input => input.value);

  if (skus.length === 0) {
    alert('Please select at least one part.');
    return;
  }

  await fetch('/api/awaiting-parts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, skus }),
  });

  closeAwaitingParts();
}

function openQcFailDialog(orderId, lineItems) {
  const scanResult = document.getElementById('scanResult');
  const skuSelect = document.getElementById('qcFailSku');
  const reasonInput = document.getElementById('qcFailReason');
  if (!skuSelect || !reasonInput || !scanResult) return;

  skuSelect.innerHTML = '';

  const skuItems = (lineItems || []).filter(item => item && item.sku);
  const uniqueSkuItems = [];
  const seenSkus = new Set();

  skuItems.forEach((item) => {
    if (seenSkus.has(item.sku)) return;
    seenSkus.add(item.sku);
    uniqueSkuItems.push(item);
  });

  uniqueSkuItems.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.sku;
    option.textContent = `${item.sku} — ${item.title || ''}`;
    skuSelect.appendChild(option);
  });

  if (uniqueSkuItems.length === 0) {
    negativeDing();
    scanResult.textContent = 'Error: No SKU found on this order to mark as QC fail.';
    return;
  }

  skuSelect.dataset.orderId = orderId;
  reasonInput.value = '';
  document.getElementById('qcFailModal').style.display = 'block';
}

function closeQcFail() {
  stopLoading();

  const modal = document.getElementById('qcFailModal');
  const skuSelect = document.getElementById('qcFailSku');
  const reasonInput = document.getElementById('qcFailReason');

  if (modal) modal.style.display = 'none';
  if (skuSelect) skuSelect.dataset.orderId = '';
  if (reasonInput) reasonInput.value = '';
}

async function submitQcFail() {
  const skuSelect = document.getElementById('qcFailSku');
  const reasonInput = document.getElementById('qcFailReason');
  const scanResult = document.getElementById('scanResult');

  if (!skuSelect || !reasonInput || !scanResult) return;

  const orderId = skuSelect.dataset.orderId;
  const sku = skuSelect.value;
  const reason = reasonInput.value.trim();

  if (!sku) {
    alert('Please select a SKU.');
    return;
  }

  if (!reason) {
    alert('Please enter a reason for QC fail.');
    return;
  }

  try {
    loading();

    const res = await fetch('/api/qc-fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, sku, reason }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to save QC fail');
    }

    positiveDing();
    scanResult.textContent = `QC fail saved for ${sku}: ${reason}. Last waiting_qc by: ${data.latestWaitingQcStaff || 'No waiting_qc record found'}`;
    closeQcFail();
  } catch (err) {
    negativeDing();
    scanResult.textContent = `Error: ${err.message}`;
  } finally {
    stopLoading();
  }
}

document.addEventListener('DOMContentLoaded', () => {

  var tagInput = document.getElementById("tag");

  var lastTagged = localStorage.getItem("lastTag");
  if (lastTagged != null) {
    tagInput.value = lastTagged;
  }

  tagInput.addEventListener('change', () => {
    localStorage.setItem("lastTag", tagInput.value || '');
  });


  const scanResult = document.getElementById('scanResult');

  function isAnyDialogOpen() {
    const awaitingPartsModal = document.getElementById('awaitingPartsModal');
    const qcFailModal = document.getElementById('qcFailModal');
    return awaitingPartsModal?.style.display === 'block' || qcFailModal?.style.display === 'block';
  }

  const shopCookie = document.cookie.split('; ').find(c => c.startsWith('shop='));
  if (!shopCookie) {
    console.log('Shop cookie not found, redirecting to login...');
    window.location.href = '/';
    return;
  }

  async function tagOrder(barcode) {
    const tag = document.getElementById("tag").value;
    if (!barcode || !tag) {
      alert('Barcode and tag required');
      return;
    }

    if (isAnyDialogOpen()) {
      return;
    }

    const normalizedBarcode = String(barcode).trim();
    if (!normalizedBarcode.toUpperCase().startsWith("AT")) {
      negativeDing();
      scanResult.textContent = 'Error: Invalid QR code. Code must begin with AT.';
      return;
    }


    if (
      lastTag == tag &&
      lastBarcode == normalizedBarcode &&
      tag != 'awaiting_parts' &&
      tag != 'qc_fail' &&
      tag != 'wholesale_adapter_built'
    ) {
      // scanResult.textContent = `Avoiding double upload`;
      console.log("Avoiding double upload");
      return;
    }

    console.log('Tagging order:', { barcode: normalizedBarcode, tag });
    scanResult.textContent = 'Processing...';
    try {

      loading();
      
      const res = await fetch('/api/tag-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: normalizedBarcode, tag })
      });
      const data = await res.json();
      console.log('API response:', data);

      lastTag = tag;
      lastBarcode = normalizedBarcode;
      if (data.success) {
        positiveDing();
        if (tag === 'wholesale_adapter_built') {
          scanResult.textContent = `Order ${data.orderNumber} adapter built by ${data.staff}. Total scans: ${data.wholesaleAdapterBuiltCount ?? 1}`;
        } else {
          scanResult.textContent = `Order ${data.orderNumber} tagged ${tag} successfully by ${data.staff}`;
        }
      } else {
        negativeDing();
        scanResult.textContent = `Error: ${data.error}`;
      }

      if (data.success && tag == 'awaiting_parts') {
        openAwaitingPartsDialog(
          normalizedBarcode, // or order ID if you have it
          data.lineItems    // returned from backend
        );
      } else if (data.success && tag == 'qc_fail') {
        openQcFailDialog(
          normalizedBarcode,
          data.lineItems
        );
      } else {
        stopLoading();
      }

    } catch (err) {

      negativeDing();

      console.error(err);
      scanResult.textContent = 'Server error';

      stopLoading();
    } finally {
      stopLoading();
    }
  }

  function setupHidScanner(onScan) {
    const body = document.body;
    const hidEnabled = body?.dataset?.enableHidScan === 'true';
    if (!hidEnabled) return;

    const INTER_KEY_TIMEOUT_MS = 80;
    const BUFFER_RESET_MS = 200;
    const MIN_SCAN_LENGTH = 3;

    function resetHidBuffer() {
      hidBuffer = "";
      hidLastKeyAt = 0;
      if (hidBufferTimeoutId) {
        clearTimeout(hidBufferTimeoutId);
        hidBufferTimeoutId = null;
      }
    }

    document.addEventListener('keydown', (event) => {
      if (loadingTrack) return;
      if (isAnyDialogOpen()) return;

      const target = event.target;
      const tagName = target?.tagName?.toLowerCase();

      if (tagName === 'select' && target?.id === 'tag') {
        // Prevent HID characters from changing the selected workflow mode.
        event.preventDefault();
      }

      if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) {
        return;
      }

      const now = Date.now();
      if (hidLastKeyAt && now - hidLastKeyAt > INTER_KEY_TIMEOUT_MS) {
        resetHidBuffer();
      }
      hidLastKeyAt = now;

      if (event.key === 'Enter') {
        const scannedCode = hidBuffer.trim();
        resetHidBuffer();

        if (scannedCode.length >= MIN_SCAN_LENGTH) {
          console.log('HID scan detected:', scannedCode);
          onScan(scannedCode);
        }
        return;
      }

      if (event.key.length === 1) {
        hidBuffer += event.key;
      }

      if (hidBufferTimeoutId) {
        clearTimeout(hidBufferTimeoutId);
      }
      hidBufferTimeoutId = setTimeout(resetHidBuffer, BUFFER_RESET_MS);
    });
  }

  setupHidScanner((scannedCode) => {
    tagOrder(scannedCode);
  });

  const readerEl = document.getElementById("reader");
  const cameraEnabled = document.body?.dataset?.enableCameraScan !== 'false';
  if (readerEl && cameraEnabled) {
    try {
      const html5QrcodeScanner = new Html5Qrcode("reader");
      html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 15, aspectRatio: 1.0, disableFlip: true },
        qrCodeMessage => {
          console.log('QR detected:', qrCodeMessage);

          if (loadingTrack == false && !isAnyDialogOpen()) {
            tagOrder(qrCodeMessage)
          } else {
            console.log("Skipping due to loading");
          }
        },
        errorMessage => {}
      );
    } catch (err) {
      console.log("No reader found");
    }
  }
});
