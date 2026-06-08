const state = {
  detector: null,
  stream: null,
  scanTarget: "model",
  scanning: false,
  lastValue: "",
  lastDetectedAt: 0,
  history: []
};

const camera = document.querySelector("#camera");
const supportStatus = document.querySelector("#supportStatus");
const startCamera = document.querySelector("#startCamera");
const stopCamera = document.querySelector("#stopCamera");
const scanForm = document.querySelector("#scanForm");
const submitScan = document.querySelector("#submitScan");
const formStatus = document.querySelector("#formStatus");
const modelNumber = document.querySelector("#modelNumber");
const serialNumber = document.querySelector("#serialNumber");
const notes = document.querySelector("#notes");
const historyList = document.querySelector("#historyList");
const modeButtons = document.querySelectorAll("[data-scan-target]");

initialize();

function initialize() {
  if ("BarcodeDetector" in window) {
    state.detector = new BarcodeDetector({
      formats: [
        "code_128",
        "code_39",
        "codabar",
        "data_matrix",
        "ean_13",
        "qr_code",
        "upc_a"
      ]
    });
    supportStatus.textContent = "Camera ready";
  } else {
    supportStatus.textContent = "Manual entry fallback";
  }

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setScanTarget(button.dataset.scanTarget));
  });

  startCamera.addEventListener("click", beginCamera);
  stopCamera.addEventListener("click", endCamera);
  scanForm.addEventListener("submit", submitCurrentScan);
  modelNumber.addEventListener("input", updateValidation);
  serialNumber.addEventListener("input", updateValidation);
  renderHistory();
  updateValidation();
}

function setScanTarget(target) {
  state.scanTarget = target;
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.scanTarget === target);
  });
  if (state.scanning) {
    supportStatus.textContent = `Scanning ${target}`;
  }
}

async function beginCamera() {
  if (!state.detector) {
    supportStatus.textContent = "Barcode detection unavailable";
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment"
      },
      audio: false
    });
    camera.srcObject = state.stream;
    state.scanning = true;
    supportStatus.textContent = `Scanning ${state.scanTarget}`;
    requestAnimationFrame(scanFrame);
  } catch (error) {
    supportStatus.textContent = "Camera blocked";
    console.error(error);
  }
}

function endCamera() {
  state.scanning = false;
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  camera.srcObject = null;
  supportStatus.textContent = state.detector ? "Camera ready" : "Manual entry fallback";
}

async function scanFrame() {
  if (!state.scanning || !state.detector) return;

  if (camera.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    try {
      const codes = await state.detector.detect(camera);
      if (codes.length > 0) {
        handleDetectedCode(codes[0].rawValue);
      }
    } catch (error) {
      console.error(error);
    }
  }

  requestAnimationFrame(scanFrame);
}

function handleDetectedCode(rawValue) {
  const value = String(rawValue || "").trim();
  const now = Date.now();

  if (!value || (value === state.lastValue && now - state.lastDetectedAt < 1600)) {
    return;
  }

  state.lastValue = value;
  state.lastDetectedAt = now;

  const capturedTarget = state.scanTarget;

  if (capturedTarget === "model") {
    modelNumber.value = value;
    setScanTarget("serial");
  } else {
    serialNumber.value = value;
  }

  supportStatus.textContent = `Captured ${capturedTarget}`;
  updateValidation();
}

async function submitCurrentScan(event) {
  event.preventDefault();

  const payload = {
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim(),
    notes: notes.value.trim(),
    source: "phone-scanner"
  };

  const errors = getValidationErrors(payload);
  if (errors.length > 0) {
    setFormStatus(errors.join(" "), false);
    return;
  }

  submitScan.disabled = true;
  setFormStatus("Sending scan.", true);
  let saved = false;

  try {
    const response = await fetch("/api/scans", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error((result.errors || [result.error]).join(" "));
    }

    state.history.unshift(result.scan);
    state.history = state.history.slice(0, 8);
    renderHistory();
    serialNumber.value = "";
    notes.value = "";
    setScanTarget("serial");
    saved = true;
    updateValidation();
    setFormStatus("Saved. Ready for the next serial number.", true);
  } catch (error) {
    setFormStatus(error.message || "Unable to save scan.", false);
  } finally {
    if (!saved) {
      updateValidation();
    }
  }
}

function updateValidation() {
  const payload = {
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim()
  };
  const errors = getValidationErrors(payload);

  submitScan.disabled = errors.length > 0;
  setFormStatus(
    errors.length > 0 ? errors.join(" ") : "Ready to send to Google Sheets.",
    errors.length === 0
  );
}

function getValidationErrors(payload) {
  const errors = [];
  if (!payload.modelNumber) errors.push("Model number is missing.");
  if (!payload.serialNumber) errors.push("Serial number is missing.");
  return errors;
}

function setFormStatus(message, ready) {
  formStatus.textContent = message;
  formStatus.classList.toggle("ready", ready);
}

function renderHistory() {
  historyList.innerHTML = "";

  if (state.history.length === 0) {
    const item = document.createElement("li");
    item.className = "history-item";
    item.innerHTML = "<strong>No scans yet</strong><span>Validated scans will appear here.</span>";
    historyList.append(item);
    return;
  }

  state.history.forEach((scan) => {
    const item = document.createElement("li");
    item.className = "history-item";
    item.innerHTML = `
      <strong>${escapeHtml(scan.serialNumber)}</strong>
      <span>${escapeHtml(scan.modelNumber)} · ${new Date(scan.timestamp).toLocaleTimeString()}</span>
    `;
    historyList.append(item);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character];
  });
}
