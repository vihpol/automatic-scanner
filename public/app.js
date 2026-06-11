const state = {
  imageDataUrl: "",
  savedCount: 0,
  scanning: false,
  saving: false
};

const supportStatus = document.querySelector("#supportStatus");
const labelPhoto = document.querySelector("#labelPhoto");
const photoPreview = document.querySelector("#photoPreview");
const photoPlaceholder = document.querySelector("#photoPlaceholder");
const extractPhoto = document.querySelector("#extractPhoto");
const scanForm = document.querySelector("#scanForm");
const submitScan = document.querySelector("#submitScan");
const formStatus = document.querySelector("#formStatus");
const progressBar = document.querySelector("#progressBar");
const modelNumber = document.querySelector("#modelNumber");
const serialNumber = document.querySelector("#serialNumber");
const rapidMode = document.querySelector("#rapidMode");
const autoSave = document.querySelector("#autoSave");
const sameModel = document.querySelector("#sameModel");
const LAST_MODEL_KEY = "automaticScanner.lastModelNumber";

initialize();

function initialize() {
  supportStatus.textContent = "Ready";
  labelPhoto.addEventListener("change", handlePhotoSelection);
  extractPhoto.addEventListener("click", extractFromPhoto);
  scanForm.addEventListener("submit", submitCurrentScan);
  modelNumber.addEventListener("input", updateValidation);
  serialNumber.addEventListener("input", updateValidation);
  serialNumber.addEventListener("keydown", handleSerialKeydown);
  rapidMode.addEventListener("change", handleRapidModeChange);
  autoSave.addEventListener("change", updateValidation);
  sameModel.addEventListener("change", handleSameModelChange);
  handleRapidModeChange();
  restoreLastModel();
  updateValidation();
}

async function handlePhotoSelection(event) {
  const file = event.target.files && event.target.files[0];
  if (!file || state.scanning) return;

  if (!file.type.startsWith("image/")) {
    setFormStatus("Choose an image file.", false);
    return;
  }

  try {
    if (!shouldKeepModel()) {
      clearFieldsForNewModel();
    }
    setProgress(18);
    setFormStatus("Preparing photo.", true);
    state.imageDataUrl = await readPreparedImage(file);
    photoPreview.src = state.imageDataUrl;
    photoPreview.classList.add("visible");
    photoPlaceholder.classList.add("hidden");
    extractPhoto.disabled = false;
    extractPhoto.classList.add("hidden");
    if (await applyFastBarcodeRead()) return;
    await extractFromPhoto();
  } catch (error) {
    console.error(error);
    setFormStatus("Unable to read the photo.", false);
  }
}

async function extractFromPhoto() {
  if (!state.imageDataUrl) {
    setFormStatus("Take a photo first.", false);
    return;
  }
  if (state.scanning) return;

  state.scanning = true;
  extractPhoto.disabled = true;
  extractPhoto.classList.add("hidden");
  supportStatus.textContent = "Reading";
  setProgress(42);
  setFormStatus("Reading label.", true);

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageDataUrl: state.imageDataUrl,
        knownModel: shouldKeepModel() ? modelNumber.value.trim() : "",
        serialOnly: shouldKeepModel()
      })
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Unable to extract fields.");
    }

    await applyExtraction(result.extraction);
  } catch (error) {
    console.error(error);
    setProgress(0);
    setFormStatus("Scan failed. Retake photo or type fields.", false);
    supportStatus.textContent = "Review";
    extractPhoto.classList.remove("hidden");
  } finally {
    state.scanning = false;
    extractPhoto.disabled = false;
  }
}

async function submitCurrentScan(event) {
  event.preventDefault();
  await saveScan();
}

async function saveScan() {
  const payload = {
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim(),
    notes: "",
    source: "phone-photo"
  };

  const errors = getValidationErrors(payload);
  if (errors.length > 0 || state.saving) {
    setFormStatus(errors.join(" "), false);
    return;
  }

  state.saving = true;
  submitScan.disabled = true;
  supportStatus.textContent = "Saving";
  setProgress(86);
  setFormStatus("Sending to Google Sheets.", true);

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

    rememberCurrentModel();
    state.savedCount += 1;
    serialNumber.value = "";
    clearPhoto();
    setProgress(100);
    supportStatus.textContent = rapidMode.checked ? `${state.savedCount} saved` : "Ready";
    setFormStatus(getSavedMessage(result.sheet), true);
    setTimeout(() => setProgress(0), 900);
  } catch (error) {
    setProgress(0);
    setFormStatus(error.message || "Unable to save scan.", false);
    supportStatus.textContent = "Review";
  } finally {
    state.saving = false;
    updateValidation();
  }
}

function getSavedMessage(sheet) {
  if (sheet && sheet.spreadsheetName && sheet.sheetName) {
    return `Saved to ${sheet.spreadsheetName} / ${sheet.sheetName}.`;
  }

  if (sheet && sheet.sheetName) {
    return `Saved to Google Sheets / ${sheet.sheetName}.`;
  }

  return rapidMode.checked ? "Saved to Google Sheets. Tap Scan Label for next." : "Saved to Google Sheets.";
}

async function applyExtraction(extraction) {
  const lockedModel = shouldKeepModel() ? modelNumber.value.trim() : "";
  modelNumber.value = lockedModel || extraction.modelNumber || "";
  serialNumber.value = extraction.serialNumber || "";

  const confidence = Number(extraction.confidence || 0);
  const confidencePercent = Math.round(confidence * 100);
  supportStatus.textContent = confidencePercent ? `${confidencePercent}% read` : "Read";
  setProgress(72);
  updateValidation();

  const missing = getValidationErrors({
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim()
  });

  if (missing.length > 0) {
    setProgress(0);
    setFormStatus(`Review needed. ${missing.join(" ")}`, false);
    extractPhoto.classList.remove("hidden");
    return;
  }

  if (autoSave.checked && confidence >= 0.45) {
    setFormStatus("Read complete. Auto-saving.", true);
    await saveScan();
    return;
  }

  setFormStatus("Ready to save.", true);
}

async function applyFastBarcodeRead() {
  if (!rapidMode.checked || !shouldKeepModel() || !state.imageDataUrl || !("BarcodeDetector" in window)) {
    return false;
  }

  setFormStatus("Checking barcode first.", true);

  try {
    const rawBarcode = await detectBarcodeFromImage(state.imageDataUrl);
    const serial = bestSerialFromValues([rawBarcode], modelNumber.value.trim());
    if (!serial) return false;

    serialNumber.value = serial;
    supportStatus.textContent = "Barcode read";
    setProgress(72);
    updateValidation();

    if (autoSave.checked) {
      await saveScan();
    } else {
      setFormStatus("Barcode read. Ready to save.", true);
    }
    return true;
  } catch (error) {
    console.warn("Fast barcode read failed:", error);
    return false;
  }
}

function clearPhoto() {
  state.imageDataUrl = "";
  labelPhoto.value = "";
  photoPreview.removeAttribute("src");
  photoPreview.classList.remove("visible");
  photoPlaceholder.classList.remove("hidden");
  extractPhoto.disabled = true;
  extractPhoto.classList.add("hidden");
  if (!rapidMode.checked || state.savedCount === 0) {
    supportStatus.textContent = "Ready";
  }
}

function setProgress(percent) {
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function readPreparedImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxDimension = 2200;
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        const brightness = estimateImageBrightness(image);
        const boost = brightness < 92 ? 1.34 : brightness < 125 ? 1.18 : 1;
        const contrast = brightness < 140 ? 1.18 : 1.08;
        context.filter = `brightness(${boost}) contrast(${contrast}) saturate(0.9)`;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function estimateImageBrightness(image) {
  const sample = document.createElement("canvas");
  const size = 48;
  sample.width = size;
  sample.height = size;
  const context = sample.getContext("2d");
  context.drawImage(image, 0, 0, size, size);

  const data = context.getImageData(0, 0, size, size).data;
  let total = 0;
  for (let index = 0; index < data.length; index += 4) {
    total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  }
  return total / (data.length / 4);
}

function detectBarcodeFromImage(imageDataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = async () => {
      try {
        const formats = [
          "code_128",
          "code_39",
          "data_matrix",
          "qr_code",
          "pdf417",
          "ean_13",
          "upc_a"
        ];
        const detector = new BarcodeDetector({ formats });
        const results = await detector.detect(image);
        resolve((results[0] && results[0].rawValue) || "");
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error("Could not inspect barcode"));
    image.src = imageDataUrl;
  });
}

function bestSerialFromValues(values, lockedModel) {
  return values
    .map((value) => cleanScanValue(value))
    .filter((value) => value.length >= 8)
    .filter((value) => !isBadSerialForLockedModel(value, lockedModel))
    .sort((a, b) => serialScore(b) - serialScore(a))[0] || "";
}

function serialScore(value) {
  let score = value.length;
  if (/^GT[A-Z0-9]{8,}$/i.test(value)) score += 30;
  if (/^3[SR][A-Z0-9]{10,}$/i.test(value)) score += 20;
  if (/^[A-Z0-9]{12,}$/i.test(value)) score += 10;
  return score;
}

function cleanScanValue(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function isBadSerialForLockedModel(serial, model) {
  const serialKey = cleanScanValue(serial).replace(/[^A-Z0-9]/g, "");
  const modelKey = cleanScanValue(model).replace(/[^A-Z0-9]/g, "");
  if (!serialKey) return true;
  if (modelKey && (serialKey === modelKey || serialKey.includes(modelKey) || modelKey.includes(serialKey))) return true;
  return /^(?:Z|S|N|R|SW)[A-Z0-9]{1,8}[-_][A-Z0-9._/-]{2,}$/i.test(serial);
}

function shouldKeepModel() {
  return Boolean(sameModel && sameModel.checked && modelNumber.value.trim());
}

function rememberCurrentModel() {
  const value = modelNumber.value.trim();
  if (!value) return;
  try {
    window.localStorage.setItem(LAST_MODEL_KEY, value);
  } catch (error) {
    // Local storage can be disabled; scanning should still work.
  }
}

function restoreLastModel() {
  if (!sameModel || !sameModel.checked || modelNumber.value.trim()) return;
  try {
    const value = window.localStorage.getItem(LAST_MODEL_KEY);
    if (value) modelNumber.value = value;
  } catch (error) {
    // Ignore storage failures.
  }
}

function handleSameModelChange() {
  if (rapidMode.checked && !sameModel.checked) {
    rapidMode.checked = false;
  }

  if (sameModel.checked) {
    restoreLastModel();
    setFormStatus("Lock model is on. Next scan reads the serial.", true);
  } else {
    clearFieldsForNewModel();
    setFormStatus("Lock model is off. Next scan reads model and serial.", true);
  }
  updateValidation();
}

function handleRapidModeChange() {
  if (rapidMode.checked) {
    sameModel.checked = true;
    restoreLastModel();
    setFormStatus("Rapid mode is on. Scan serials one after another.", true);
  }
  updateValidation();
}

async function handleSerialKeydown(event) {
  if (event.key !== "Enter" || !rapidMode.checked) return;
  event.preventDefault();
  await saveScan();
}

function clearFieldsForNewModel() {
  modelNumber.value = "";
  serialNumber.value = "";
}

function updateValidation() {
  const payload = {
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim()
  };
  const errors = getValidationErrors(payload);

  submitScan.disabled = state.saving;

  if (!state.imageDataUrl && errors.length > 0) {
    if (rapidMode.checked && state.savedCount > 0 && payload.modelNumber && !payload.serialNumber) {
      setFormStatus("Saved. Tap Scan Label for next.", true);
      return;
    }

    setFormStatus("Take a photo to start.", false);
    return;
  }

  setFormStatus(
    errors.length > 0 ? errors.join(" ") : autoSave.checked ? "Auto-save is on." : "Ready to save.",
    errors.length === 0
  );
}

function getValidationErrors(payload) {
  const errors = [];
  if (!payload.modelNumber) errors.push("Model number is missing.");
  if (!payload.serialNumber) errors.push("Serial number is missing.");
  if (
    sameModel &&
    sameModel.checked &&
    payload.modelNumber &&
    payload.serialNumber &&
    isBadSerialForLockedModel(payload.serialNumber, payload.modelNumber)
  ) {
    errors.push("Serial number looks like the model number.");
  }
  return errors;
}

function setFormStatus(message, ready) {
  formStatus.textContent = message;
  formStatus.classList.toggle("ready", ready);
}
