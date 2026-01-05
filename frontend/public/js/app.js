var lastTag = "";
var lastBarcode = "";
var loadingTrack = false;

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

document.addEventListener('DOMContentLoaded', () => {

  
  const scanResult = document.getElementById('scanResult');

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


    if ((lastTag == tag && lastBarcode == barcode && tag != 'awaiting_parts' )) {
      // scanResult.textContent = `Avoiding double upload`;
      console.log("Avoiding double upload");
      return;
    }

    console.log('Tagging order:', { barcode, tag });
    scanResult.textContent = 'Processing...';
    try {

      loading();
      
      const res = await fetch('/api/tag-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode, tag })
      });
      const data = await res.json();
      console.log('API response:', data);

      lastTag = tag;
      lastBarcode = barcode;
      if (data.success) {
        positiveDing();
        scanResult.textContent = `Order ${data.orderNumber} tagged ${tag} successfully by ${data.staff}`;
      } else {
        negativeDing();
        scanResult.textContent = `Error: ${data.error}`;
      }

      if (tag == 'awaiting_parts') {
        openAwaitingPartsDialog(
          barcode,          // or order ID if you have it
          data.lineItems    // returned from backend
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

  const html5QrcodeScanner = new Html5Qrcode("reader");
  html5QrcodeScanner.start(
    { facingMode: "environment" },
    { fps: 15, aspectRatio: 1.0, disableFlip: true },
    qrCodeMessage => {
      console.log('QR detected:', qrCodeMessage);

      if (loadingTrack == false) {
        tagOrder(qrCodeMessage)
      } else {
        console.log("Skipping due to loading");
      }
    },
    errorMessage => {}
  );
});