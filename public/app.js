const state = {
  imageDataUrl: "",
  history: []
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
const historyList = document.querySelector("#historyList");

initialize();

function initialize() {
  supportStatus.textContent = "Photo mode";
  labelPhoto.addEventListener("change", handlePhotoSelection);
  extractPhoto.addEventListener("click", extractFromPhoto);
  scanForm.addEventListener("submit", submitCurrentScan);
  modelNumber.addEventListener("input", updateValidation);
  serialNumber.addEventListener("input", updateValidation);
  renderHistory();
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
    setFormStatus("Take or choose a photo first.", false);
    return;
  }

  extractPhoto.disabled = true;
  extractPhoto.classList.add("hidden");
  supportStatus.textContent = "Reading label";
  setFormStatus("Reading model and serial.", true);

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

    applyExtraction(result.extraction);
  } catch (error) {
    console.error(error);
    setFormStatus("OCR failed. Retake photo or enter fields.", false);
    supportStatus.textContent = "Needs review";
    extractPhoto.classList.remove("hidden");
  } finally {
    extractPhoto.disabled = false;
  }
}

async function submitCurrentScan(event) {
  event.preventDefault();

  const payload = {
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim(),
    notes: "",
    source: "phone-photo"
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
    clearPhoto();
    saved = true;
    updateValidation();
    setFormStatus("Saved. Ready for the next photo.", true);
  } catch (error) {
    setFormStatus(error.message || "Unable to save scan.", false);
  } finally {
    if (!saved) {
      updateValidation();
    }
  }
}

function applyExtraction(extraction) {
  modelNumber.value = extraction.modelNumber || "";
  serialNumber.value = extraction.serialNumber || "";

  const confidence = Math.round(Number(extraction.confidence || 0) * 100);
  supportStatus.textContent = confidence ? `${confidence}% read` : "Read complete";
  updateValidation();

  const missing = getValidationErrors({
    modelNumber: modelNumber.value.trim(),
    serialNumber: serialNumber.value.trim()
  });

  if (missing.length > 0) {
    setFormStatus(`Review needed. ${missing.join(" ")}`, false);
    extractPhoto.classList.remove("hidden");
  } else {
    setFormStatus("Ready to save.", true);
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
  supportStatus.textContent = "Photo mode";
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

  submitScan.disabled = errors.length > 0;
  setFormStatus(
    errors.length > 0 ? errors.join(" ") : "Ready to save.",
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
    item.innerHTML = "<strong>No scans</strong><span>Saved switch labels will appear here.</span>";
    historyList.append(item);
    return;
  }

  state.history.forEach((scan) => {
    const item = document.createElement("li");
    item.className = "history-item";
    item.innerHTML = `
      <strong>${escapeHtml(scan.serialNumber)}</strong>
      <span>${escapeHtml(scan.modelNumber)} &middot; ${new Date(scan.timestamp).toLocaleTimeString()}</span>
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
