const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const path = require("path");

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/scans") {
      const body = await readJson(req);
      const scan = normalizeScan(body);
      const validation = validateScan(scan);

      if (!validation.ok) {
        sendJson(res, 400, { ok: false, errors: validation.errors });
        return;
      }

      const sheet = await appendScanToSheet(scan);
      sendJson(res, 201, { ok: true, scan, sheet });
      return;
    }

    if (req.method === "POST" && req.url === "/api/extract") {
      const body = await readJson(req, 18000000);
      const extraction = await extractScanFromImage(body.imageDataUrl, {
        knownModel: body.knownModel,
        serialOnly: body.serialOnly
      });
      sendJson(res, 200, { ok: true, extraction });
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      ok: false,
      error: error.message || "Something went wrong while processing the request."
    });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Automatic Scanner running at http://${HOST}:${PORT}`);
  });
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value.replace(/\\n/g, "\n");
    }
  }
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url);
  const requestedPath = path.normalize(path.join(PUBLIC_DIR, urlPath));

  if (!requestedPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  fs.readFile(requestedPath, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const extension = path.extname(requestedPath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    const limit = maxBytes || 1000000;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function extractScanFromImage(imageDataUrl, options = {}) {
  const apiKey = getUsableOpenAIKey();
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const knownModel = cleanInventoryValue(options.knownModel || "");

  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(String(imageDataUrl || ""))) {
    throw new Error("A PNG, JPEG, or WebP image data URL is required.");
  }

  if (!apiKey) {
    return extractScanWithTesseract(imageDataUrl, {
      knownModel,
      serialOnly: Boolean(options.serialOnly)
    });
  }

  try {
    const response = await requestJson("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Extract the inventory model number and serial number from this product label photo. " +
                  "Find the line containing the word MODEL and extract the model value from that full line. " +
                  "For the serial number, first look for the line labeled SWITCH S/N and extract that value. Only use S/N, SN, or serial number if SWITCH S/N is not present. " +
                  (knownModel ? `The previously saved model is ${knownModel}. If the photo shows a different model, return the model from the photo. ` : "") +
                  "Return only valid JSON with keys modelNumber, serialNumber, confidence, and notes. " +
                  "Use empty strings for fields you cannot read. Confidence must be a number from 0 to 1. " +
                  "Notes should briefly mention uncertainty, glare, blur, or missing fields."
              },
              {
                type: "input_image",
                image_url: imageDataUrl,
                detail: "high"
              }
            ]
          }
        ]
      })
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(response.body);
    }

    const data = JSON.parse(response.body);
    const outputText = extractOpenAIText(data);
    const parsed = parseJsonObject(outputText);

    return {
      modelNumber: String(parsed.modelNumber || "").trim() || knownModel,
      serialNumber: String(parsed.serialNumber || "").trim(),
      confidence: Number(parsed.confidence || 0),
      notes: String(parsed.notes || "").trim(),
      rawText: outputText
    };
  } catch (error) {
    console.warn("Photo analysis service unavailable; using local reader:", error.message);
    return extractScanWithTesseract(imageDataUrl, {
      knownModel,
      serialOnly: Boolean(options.serialOnly)
    });
  }
}

function getUsableOpenAIKey() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();

  if (!key || /^optional_/i.test(key) || /your[_-]?api[_-]?key/i.test(key)) {
    return "";
  }

  return key;
}

async function extractScanWithTesseract(imageDataUrl, options = {}) {
  const image = decodeImageDataUrl(imageDataUrl);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-scanner-"));
  const imagePath = path.join(tempDir, `label.${image.extension}`);

  try {
    fs.writeFileSync(imagePath, image.buffer);
    const text = await extractTextFromLabelImages(imagePath, tempDir, options);
    const parsed = parseInventoryText(text, options.knownModel);

    return {
      modelNumber: parsed.modelNumber,
      serialNumber: parsed.serialNumber,
      confidence: parsed.confidence,
      notes: parsed.notes,
      rawText: text
    };
  } finally {
    removeDirSafe(tempDir);
  }
}

function decodeImageDataUrl(imageDataUrl) {
  const match = String(imageDataUrl || "").match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error("A PNG, JPEG, or WebP image data URL is required.");
  }

  const mimeExtension = match[1].toLowerCase();
  const extension = mimeExtension === "jpeg" || mimeExtension === "jpg" ? "jpg" : mimeExtension;

  return {
    extension,
    buffer: Buffer.from(match[2], "base64")
  };
}

function runTesseract(imagePath) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "tesseract",
      [imagePath, "stdout", "--psm", "6"],
      {
        timeout: 20000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

async function extractTextFromLabelImages(imagePath, tempDir, options = {}) {
  const imagePaths = [imagePath];
  const variantSpecs = options.serialOnly
    ? [
        ["serial-center.jpg", ["-resize", "2200x2200>", "-gravity", "center", "-crop", "94%x66%+0+0", "+repage", "-colorspace", "Gray", "-auto-level", "-sharpen", "0x1"]]
      ]
    : [
        ["enhanced.jpg", ["-resize", "2400x2400>", "-colorspace", "Gray", "-auto-level", "-contrast-stretch", "1%x1%", "-sharpen", "0x1"]],
        ["label-band.jpg", ["-resize", "2400x2400>", "-gravity", "center", "-crop", "96%x68%+0+0", "+repage", "-colorspace", "Gray", "-auto-level", "-contrast-stretch", "1%x1%", "-sharpen", "0x1.2"]],
        ["glare-cut.jpg", ["-resize", "2400x2400>", "-colorspace", "Gray", "-contrast-stretch", "4%x12%", "-sigmoidal-contrast", "6,45%", "-sharpen", "0x1.4"]],
        ["dark-boost.jpg", ["-resize", "2400x2400>", "-colorspace", "Gray", "-brightness-contrast", "22x34", "-normalize", "-sharpen", "0x1.3"]],
        ["threshold.jpg", ["-resize", "2200x2200>", "-colorspace", "Gray", "-auto-level", "-threshold", "58%", "-sharpen", "0x0.8"]]
      ];

  for (const spec of variantSpecs) {
    const variantPath = path.join(tempDir, spec[0]);
    if (await makeImageVariant(imagePath, variantPath, spec[1])) {
      imagePaths.push(variantPath);
    }
  }

  const modes = options.serialOnly ? ["6"] : ["6", "11"];
  const results = [];

  for (const candidatePath of imagePaths) {
    for (const mode of modes) {
      const text = await runTesseractMode(candidatePath, mode);
      if (!text) continue;

      results.push(text);

      const combined = uniqueLines(results.join("\n")).join("\n").trim();
      const parsed = parseInventoryText(combined, options.knownModel);
      if (hasCompleteConfidentRead(parsed)) {
        return combined;
      }
    }
  }

  return uniqueLines(results.join("\n")).join("\n").trim();
}

async function makeImageVariant(inputPath, outputPath, operations) {
  const result = await execFileQuiet("convert", [inputPath, "-auto-orient"].concat(operations, [outputPath]), {
    timeout: 12000
  });
  return result.ok && fs.existsSync(outputPath);
}

async function runTesseractMode(imagePath, mode) {
  const result = await execFileQuiet("tesseract", [imagePath, "stdout", "--psm", mode], {
    timeout: 45000,
    maxBuffer: 1024 * 1024
  });
  return result.ok ? result.stdout.trim() : "";
}

function execFileQuiet(command, args, options) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, options || {}, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error
      });
    });
  });
}

function uniqueLines(text) {
  return Array.from(new Set(String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
}

function hasCompleteConfidentRead(parsed) {
  return Boolean(
    parsed &&
    parsed.modelNumber &&
    parsed.serialNumber &&
    parsed.confidence >= 0.8
  );
}

function parseInventoryText(text, knownModel = "") {
  const normalized = String(text || "")
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  const lines = getOcrLines(normalized);
  const scannedModelFromText = findModelFromText(normalized);
  const scannedModelNumber = findValueFromLine(lines, /\bmodel\b/i);
  const scannedModelBelow = findValueBelowLabel(lines, /\bmodel\b/i, isLikelyModelToken);
  const scannedModelNearby = findValueNearLabel(lines, /\bmodel\b/i, isLikelyModelToken);
  const modelNumber = scannedModelFromText || scannedModelNumber || scannedModelBelow || scannedModelNearby || knownModel;
  const switchSerialFromText = findSwitchSerialFromText(normalized);
  const switchSerialNumber = findValueFromLine(lines, /\bswitch\s*(?:s\s*\/?\s*n|sn|sin|serial(?:\s+number|\s+no)?)\b/i);
  const switchSerialNearby = findValueNearLabel(lines, /\bswitch\s*(?:s\s*\/?\s*n|sn|sin|serial(?:\s+number|\s+no)?)\b/i);
  const genericSerialNumber = findValueFromLine(lines, /\bs\s*\/?\s*n\b|\bsn\b|\bserial(?:\s+number|\s+no)?\b/i);
  const genericSerialNearby = findValueNearLabel(lines, /\bs\s*\/?\s*n\b|\bsn\b|\bserial(?:\s+number|\s+no)?\b/i);
  const serialNumber = switchSerialFromText || switchSerialNumber || switchSerialNearby || genericSerialNumber || genericSerialNearby || findBestSerialCandidate(lines);

  const candidates = normalized
    .split(/[^A-Z0-9._/-]+/i)
    .map((value) => cleanInventoryValue(value))
    .filter((value) => /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 5);

  const fallbackSerial = candidates
    .filter((candidate) => !isLikelyModelOrProduct(candidate))
    .slice()
    .sort((a, b) => b.length - a.length)[0] || "";
  const fallbackModel = candidates.find((candidate) => candidate !== fallbackSerial && isLikelyModelToken(candidate)) || "";

  const resolvedModel = cleanInventoryValue(modelNumber || fallbackModel);
  const resolvedSerial = cleanInventoryValue(serialNumber || fallbackSerial);
  const foundBoth = Boolean(resolvedModel && resolvedSerial);
  const foundLabeledModel = Boolean(scannedModelFromText || scannedModelNumber || scannedModelBelow || scannedModelNearby);
  const foundLabeledSerial = Boolean(switchSerialFromText || switchSerialNumber || switchSerialNearby);
  const usedLabels = Boolean(foundLabeledModel || foundLabeledSerial || genericSerialNumber || genericSerialNearby);

  return {
    modelNumber: resolvedModel,
    serialNumber: resolvedSerial,
    confidence: getReadConfidence(foundBoth, foundLabeledModel, foundLabeledSerial, usedLabels),
    notes: foundBoth
      ? "Read from photo. Review before saving."
      : "Photo scan could not confidently find both fields. Type missing values before saving."
  };
}

function getReadConfidence(foundBoth, foundLabeledModel, foundLabeledSerial, usedLabels) {
  if (!foundBoth) return 0.25;
  if (foundLabeledModel && foundLabeledSerial) return 0.84;
  if (foundLabeledModel || foundLabeledSerial) return 0.62;
  return usedLabels ? 0.52 : 0.38;
}

function getOcrLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function findModelFromText(text) {
  const match = String(text || "").match(/\bmodel\s*[:;]?\s*[\r\n ]*([A-Z0-9][A-Z0-9._/-]{4,})/i);
  if (!match) return "";

  const value = cleanInventoryValue(match[1]);
  return isLikelyModelToken(value) ? value : "";
}

function findSwitchSerialFromText(text) {
  const match = String(text || "").match(/\bswitch\s*s\s*\/?\s*n\s*[:;]?\s*([A-Z0-9][A-Z0-9._/-]{7,})/i);
  if (!match) return "";

  const value = cleanInventoryValue(match[1]);
  return isLikelyModelOrProduct(value) ? "" : value;
}

function findValueFromLine(lines, labelPattern) {
  for (const line of lines) {
    if (!labelPattern.test(line)) continue;

    const value = valueAfterLabel(line, labelPattern);
    if (value) return value;
  }

  return "";
}

function findValueNearLabel(lines, labelPattern, validator) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!labelPattern.test(lines[index])) continue;

    const sameLine = valueAfterLabel(lines[index], labelPattern);
    if (sameLine && (!validator || validator(sameLine))) return sameLine;

    for (let offset = 1; offset <= 2; offset += 1) {
      const nextLine = lines[index + offset] || "";
      if (looksLikeLabelLine(nextLine)) continue;

      const value = bestInventoryToken(nextLine);
      if (value && (!validator || validator(value))) return value;
    }
  }

  return "";
}

function findValueBelowLabel(lines, labelPattern, validator) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!labelPattern.test(lines[index])) continue;

    for (let offset = 1; offset <= 3; offset += 1) {
      const value = bestInventoryToken(lines[index + offset] || "");
      if (value && (!validator || validator(value))) return value;
    }
  }

  return "";
}

function valueAfterLabel(line, labelPattern) {
  const match = line.match(labelPattern);
  if (!match) return "";

  const afterLabel = line.slice(match.index + match[0].length);
  const afterSeparator = afterLabel.replace(/^\s*(?:number|no\.?|#|[:=-])*\s*/i, "");
  return bestInventoryToken(afterSeparator);
}

function bestInventoryToken(text) {
  const rawText = String(text || "");
  const compactToken = cleanInventoryValue(rawText);
  const tokens = rawText
    .split(/[^A-Z0-9._/-]+/i)
    .map((value) => cleanInventoryValue(value))
    .filter((value) => /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 3);

  if (/[A-Z]/i.test(compactToken) && /\d/.test(compactToken) && compactToken.length >= 5) {
    tokens.push(compactToken);
  }

  return tokens
    .sort((a, b) => scoreInventoryToken(b) - scoreInventoryToken(a))[0] || "";
}

function looksLikeLabelLine(line) {
  return /\b(model|switch|serial|s\s*\/?\s*n|sn|mac|part|p\s*\/?\s*n|dp\s*\/?\s*n|product|quantity|weight|version|remark)\b/i.test(line);
}

function scoreInventoryToken(value) {
  let score = value.length;
  if (/^GT[A-Z0-9]{8,}$/i.test(value)) score += 40;
  if (/^3[SR][A-Z0-9]{10,}$/i.test(value)) score += 35;
  if (/^[A-Z0-9]{12,}$/i.test(value)) score += 18;
  if (/^(?:Z|S|N|R|SW)[A-Z0-9]{1,8}[-_][A-Z0-9._/-]{2,}$/i.test(value)) score += 25;
  if (/^(?:MODEL|NUMBER|SERIAL|SWITCH|MAC|ADDR|ADDRESS)$/i.test(value)) score -= 80;
  return score;
}

function findBestSerialCandidate(lines) {
  const tokens = [];

  for (const line of lines) {
    if (/\b(product|model|quantity|weight|version|remark)\b/i.test(line)) continue;

    String(line || "")
      .split(/[^A-Z0-9._/-]+/i)
      .map((value) => cleanInventoryValue(value))
      .filter((value) => value.length >= 8)
      .filter((value) => !isLikelyModelOrProduct(value))
      .forEach((value) => tokens.push(value));
  }

  return tokens.sort((a, b) => scoreSerialToken(b) - scoreSerialToken(a))[0] || "";
}

function scoreSerialToken(value) {
  let score = value.length;
  if (/^GT[A-Z0-9]{8,}$/i.test(value)) score += 80;
  if (/^3[SR][A-Z0-9]{10,}$/i.test(value)) score += 60;
  if (/^[A-Z0-9]{12,}$/i.test(value)) score += 25;
  if (isLikelyModelOrProduct(value)) score -= 120;
  return score;
}

function isLikelyModelOrProduct(value) {
  return /^SW[-_A-Z0-9]*[-_][A-Z0-9]*$/i.test(value) ||
    /-ACF$/i.test(value) ||
    /^(?:MODEL|PRODUCT|SERIAL|NUMBER|SWITCH)$/i.test(value);
}

function isLikelyModelToken(value) {
  return /^SW[-_A-Z0-9]*[-_][A-Z0-9]*$/i.test(value) &&
    !/-ACF$/i.test(value);
}

function cleanInventoryValue(value) {
  let cleaned = String(value || "")
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, "")
    .replace(/O(?=\d)/g, "0")
    .replace(/\s+/g, "")
    .toUpperCase();

  cleaned = cleaned
    .replace(/(\d)U(?=\d|G)/g, "$10")
    .replace(/THS(?=$|[-_])/g, "TH5");

  return cleaned;
}

function removeDirSafe(dirPath) {
  try {
    if (fs.rmSync) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    }

    if (!fs.existsSync(dirPath)) return;
    fs.readdirSync(dirPath).forEach((entry) => {
      const entryPath = path.join(dirPath, entry);
      const stat = fs.lstatSync(entryPath);
      if (stat.isDirectory()) {
        removeDirSafe(entryPath);
      } else {
        fs.unlinkSync(entryPath);
      }
    });
    fs.rmdirSync(dirPath);
  } catch (error) {
    console.warn("Unable to clean temporary scan files:", error.message);
  }
}

function extractOpenAIText(data) {
  if (data.output_text) return data.output_text;

  const output = Array.isArray(data.output) ? data.output : [];
  const parts = [];

  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentItem of content) {
      if (contentItem.text) parts.push(contentItem.text);
    }
  }

  return parts.join("\n").trim();
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw error;
    return JSON.parse(match[0]);
  }
}

function normalizeScan(body) {
  return {
    timestamp: new Date().toISOString(),
    modelNumber: String(body.modelNumber || "").trim(),
    serialNumber: String(body.serialNumber || "").trim(),
    notes: String(body.notes || "").trim(),
    source: String(body.source || "phone-scanner").trim(),
    sheetId: cleanSheetId(body.sheetId || ""),
    sheetTab: String(body.sheetTab || "").trim()
  };
}

function validateScan(scan) {
  const errors = [];

  if (!scan.modelNumber) {
    errors.push("Model number is required.");
  }

  if (!scan.serialNumber) {
    errors.push("Serial number is required.");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

async function appendScanToSheet(scan) {
  const appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const appsScriptSecret = process.env.GOOGLE_APPS_SCRIPT_SECRET || "";
  const sheetId = scan.sheetId || cleanSheetId(process.env.GOOGLE_SHEET_ID || "");
  const tab = scan.sheetTab || process.env.GOOGLE_SHEET_TAB || "Scans";
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (appsScriptUrl) {
    return appendScanWithAppsScriptBlocking(appsScriptUrl, appsScriptSecret, {
      sheetId,
      tab,
      scan
    });
    return;
  }

  if (!sheetId || !serviceAccountEmail || !privateKey) {
    console.log("Google Sheets is not configured. Scan accepted locally:", scan);
    return null;
  }

  const token = await getGoogleAccessToken(serviceAccountEmail, privateKey);
  const range = encodeURIComponent(`${tab}!A:E`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const response = await requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      values: [
        [
          scan.timestamp,
          scan.modelNumber,
          scan.serialNumber,
          scan.notes,
          scan.source
        ]
      ]
    })
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message = response.body;
    throw new Error(`Google Sheets append failed: ${message}`);
  }

  return {
    tab,
    mode: "service-account"
  };
}

function cleanSheetId(value) {
  const text = String(value || "").trim();
  if (/^(?:your_google_sheet_id|your[_-]?sheet[_-]?id)$/i.test(text)) return "";
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return (match ? match[1] : text).trim();
}

async function appendScanWithAppsScript(url, secret, options) {
  const scan = options.scan;
  postJsonInBackground(url, {
    secret,
    sheetId: options.sheetId || "",
    tab: options.tab || "Scans",
    timestamp: scan.timestamp,
    modelNumber: scan.modelNumber,
    serialNumber: scan.serialNumber,
    notes: scan.notes,
    source: scan.source
  });
}

function postJsonInBackground(url, payload) {
  const body = JSON.stringify(payload);
  const parsedUrl = new URL(url);
  const request = https.request(
    {
      method: "POST",
      hostname: parsedUrl.hostname,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    },
    (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 400) {
          console.warn(`Apps Script returned status ${response.statusCode}`);
        }
      });
    }
  );

  request.on("error", (error) => {
    console.warn(`Apps Script background append failed: ${error.message}`);
  });
  request.setTimeout(15000, () => {
    request.destroy(new Error("Apps Script request timed out"));
  });
  request.write(body);
  request.end();
}

async function appendScanWithAppsScriptBlocking(url, secret, options) {
  const scan = options.scan;
  const params = new URLSearchParams({
    secret,
    sheetId: options.sheetId || "",
    tab: options.tab || "Scans",
    timestamp: scan.timestamp,
    modelNumber: scan.modelNumber,
    serialNumber: scan.serialNumber,
    notes: scan.notes,
    source: scan.source
  });
  const separator = url.includes("?") ? "&" : "?";
  const data = await requestAppsScriptJson(`${url}${separator}${params.toString()}`);

  if (!data.ok) {
    throw new Error(data.error || "Apps Script append failed.");
  }

  return data;
}

async function requestAppsScriptJson(url) {
  const result = await execFileQuiet("curl", ["-sS", "-L", "--max-time", "25", url], {
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });

  if (!result.ok) {
    throw new Error(`Apps Script request failed: ${result.stderr || result.error.message}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Apps Script returned invalid JSON: ${result.stdout.slice(0, 500)}`);
  }
}

async function getGoogleAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = base64UrlEncode(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT"
    })
  );
  const jwtPayload = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    })
  );
  const unsignedJwt = `${jwtHeader}.${jwtPayload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedJwt)
    .sign(privateKey, "base64");
  const assertion = `${unsignedJwt}.${base64ToBase64Url(signature)}`;

  const response = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message = response.body;
    throw new Error(`Google token request failed: ${message}`);
  }

  const data = JSON.parse(response.body);
  return data.access_token;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64ToBase64Url(value) {
  return value
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function requestJson(url, options, redirectCount, followRedirects) {
  return new Promise((resolve, reject) => {
    const redirects = redirectCount || 0;
    const shouldFollowRedirects = followRedirects !== false;
    const parsedUrl = new URL(url);
    const body = options.body ? String(options.body) : "";
    const request = https.request(
      {
        method: options.method || "GET",
        hostname: parsedUrl.hostname,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: Object.assign(
          {
            "Content-Length": Buffer.byteLength(body)
          },
          options.headers || {}
        )
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if (
            shouldFollowRedirects &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location &&
            redirects < 5
          ) {
            const nextUrl = new URL(response.headers.location, url).toString();
            const nextOptions = options;
            requestJson(nextUrl, nextOptions, redirects + 1, shouldFollowRedirects).then(resolve, reject);
            return;
          }

          resolve({
            statusCode: response.statusCode,
            body: responseBody
          });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error("Request timed out"));
    });
    request.write(body);
    request.end();
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

module.exports = {
  parseInventoryText
};
