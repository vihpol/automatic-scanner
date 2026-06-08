const state = {
  imageDataUrl: "",
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
const modelNumber = document.querySelector("#modelNumber");
const serialNumber = document.querySelector("#serialNumber");
const autoSave = document.querySelector("#autoSave");

initialize();

function initialize() {
  supportStatus.textContent = "Ready";
  labelPhoto.addEventListener("change", handlePhotoSelection);
  extractPhoto.addEventListener("click", extractFromPhoto);
  scanForm.addEventListener("submit", submitCurrentScan);
  modelNumber.addEventListener("input", updateValidation);
  serialNumber.addEventListener("input", updateValidation);
  autoSave.addEventListener("change", updateValidation);
  updateValidation();
}

async function handlePhotoSelection(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setFormStatus("Choose an image file.", false);
    return;
  }

  try {
    state.imageDataUrl = await readCompressedImage(file);
    photoPreview.src = state.imageDataUrl;
    photoPreview.classList.add("visible");
    photoPlaceholder.classList.add("hidden");
    extractPhoto.disabled = false;
    extractPhoto.classList.add("hidden");
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

  extractPhoto.disabled = true;
  extractPhoto.classList.add("hidden");
  supportStatus.textContent = "Reading";
  setFormStatus("Reading label.", true);

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        imageDataUrl: state.imageDataUrl
      })
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Unable to extract fields.");
    }

    await applyExtraction(result.extraction);
  } catch (error) {
    console.error(error);
    setFormStatus("OCR failed. Retake photo or type fields.", false);
    supportStatus.textContent = "Review";
    extractPhoto.classList.remove("hidden");
  } finally {
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

    serialNumber.value = "";
    clearPhoto();
    setFormStatus("Saved. Ready for next label.", true);
  } catch (error) {
    setFormStatus(error.message || "Unable to save scan.", false);
    supportStatus.textContent = "Review";
  } finally {
    state.saving = false;
    updateValidation();
  }
}

async function applyExtraction(extraction) {
  modelNumber.value = extraction.modelNumber || "";
  serialNumber.value = extraction.serialNumber || "";

  const confidence = Number(extraction.confidence || 0);
  const confidencePercent = Math.round(confidence * 100);
  supportStatus.textContent = confidencePercent ? `${confidencePercent}% read` : "Read";
  updateValidation();

  const missing = getValidationErrors({
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim()
  });

  if (missing.length > 0) {
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

function clearPhoto() {
  state.imageDataUrl = "";
  labelPhoto.value = "";
  photoPreview.removeAttribute("src");
  photoPreview.classList.remove("visible");
  photoPlaceholder.classList.remove("hidden");
  extractPhoto.disabled = true;
  extractPhoto.classList.add("hidden");
  supportStatus.textContent = "Ready";
}

function readCompressedImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxDimension = 1600;
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.84));
      };
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function updateValidation() {
  const payload = {
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim()
  };
  const errors = getValidationErrors(payload);

  submitScan.disabled = errors.length > 0 || state.saving;

  if (!state.imageDataUrl && errors.length > 0) {
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
  return errors;
}

function setFormStatus(message, ready) {
  formStatus.textContent = message;
  formStatus.classList.toggle("ready", ready);
}
