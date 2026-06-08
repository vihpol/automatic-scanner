const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

loadDotEnv();

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

      await appendScanToSheet(scan);
      sendJson(res, 201, { ok: true, scan });
      return;
    }

    if (req.method === "POST" && req.url === "/api/extract") {
      const body = await readJson(req, 9000000);
      const extraction = await extractScanFromImage(body.imageDataUrl);
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

server.listen(PORT, HOST, () => {
  console.log(`Automatic Scanner running at http://${HOST}:${PORT}`);
});

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
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream"
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

async function extractScanFromImage(imageDataUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(String(imageDataUrl || ""))) {
    throw new Error("A PNG, JPEG, or WebP image data URL is required.");
  }

  if (!apiKey) {
    return extractScanWithTesseract(imageDataUrl);
  }

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
    throw new Error(`OpenAI extraction failed: ${response.body}`);
  }

  const data = JSON.parse(response.body);
  const outputText = extractOpenAIText(data);
  const parsed = parseJsonObject(outputText);

  return {
    modelNumber: String(parsed.modelNumber || "").trim(),
    serialNumber: String(parsed.serialNumber || "").trim(),
    confidence: Number(parsed.confidence || 0),
    notes: String(parsed.notes || "").trim(),
    rawText: outputText
  };
}

async function extractScanWithTesseract(imageDataUrl) {
  const image = decodeImageDataUrl(imageDataUrl);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-scanner-"));
  const imagePath = path.join(tempDir, `label.${image.extension}`);

  try {
    fs.writeFileSync(imagePath, image.buffer);
    const text = await runTesseract(imagePath);
    const parsed = parseInventoryText(text);

    return {
      modelNumber: parsed.modelNumber,
      serialNumber: parsed.serialNumber,
      confidence: parsed.confidence,
      notes: parsed.notes,
      rawText: text
    };
  } finally {
    try {
      fs.unlinkSync(imagePath);
      fs.rmdirSync(tempDir);
    } catch (error) {
      console.warn("Unable to clean temporary OCR files:", error.message);
    }
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

function parseInventoryText(text) {
  const normalized = String(text || "")
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();

  const serialNumber = findLabeledValue(normalized, [
    "serial number",
    "serial no",
    "serial",
    "service tag",
    "s/n",
    "sn"
  ]);
  const modelNumber = findLabeledValue(normalized, [
    "model number",
    "model no",
    "model",
    "part number",
    "part no",
    "p/n",
    "pn",
    "sku"
  ]);

  const candidates = normalized
    .split(/[^A-Z0-9._/-]+/i)
    .map((value) => cleanInventoryValue(value))
    .filter((value) => /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 5);

  const fallbackSerial = candidates
    .slice()
    .sort((a, b) => b.length - a.length)[0] || "";
  const fallbackModel = candidates.find((candidate) => candidate !== fallbackSerial) || "";

  const resolvedModel = cleanInventoryValue(modelNumber || fallbackModel);
  const resolvedSerial = cleanInventoryValue(serialNumber || fallbackSerial);
  const foundBoth = Boolean(resolvedModel && resolvedSerial);
  const usedLabels = Boolean(modelNumber || serialNumber);

  return {
    modelNumber: resolvedModel,
    serialNumber: resolvedSerial,
    confidence: foundBoth ? (usedLabels ? 0.72 : 0.48) : 0.25,
    notes: foundBoth
      ? "Extracted with local OCR. Review before saving."
      : "Local OCR could not confidently find both fields. Type missing values before saving."
  };
}

function findLabeledValue(text, labels) {
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escapedLabel}\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9._/-]{2,})`, "i");
    const match = text.match(pattern);
    if (match) return cleanInventoryValue(match[1]);
  }

  return "";
}

function cleanInventoryValue(value) {
  return String(value || "")
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, "")
    .replace(/O(?=\d)/g, "0")
    .replace(/\s+/g, "")
    .toUpperCase();
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
    source: String(body.source || "phone-scanner").trim()
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
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || "Scans";
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (appsScriptUrl) {
    await appendScanWithAppsScript(appsScriptUrl, appsScriptSecret, scan);
    return;
  }

  if (!sheetId || !serviceAccountEmail || !privateKey) {
    console.log("Google Sheets is not configured. Scan accepted locally:", scan);
    return;
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
}

async function appendScanWithAppsScript(url, secret, scan) {
  const response = await requestJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret,
      timestamp: scan.timestamp,
      modelNumber: scan.modelNumber,
      serialNumber: scan.serialNumber,
      notes: scan.notes,
      source: scan.source
    })
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Apps Script append failed: ${response.body}`);
  }

  let data;
  try {
    data = JSON.parse(response.body);
  } catch (error) {
    throw new Error(`Apps Script returned invalid JSON: ${response.body}`);
  }

  if (!data.ok) {
    throw new Error(data.error || "Apps Script append failed.");
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

function requestJson(url, options, redirectCount) {
  return new Promise((resolve, reject) => {
    const redirects = redirectCount || 0;
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
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location &&
            redirects < 5
          ) {
            const nextUrl = new URL(response.headers.location, url).toString();
            requestJson(nextUrl, options, redirects + 1).then(resolve, reject);
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
