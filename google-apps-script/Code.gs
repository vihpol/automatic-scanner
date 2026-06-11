const SHEET_NAME = "Scans";
const SHARED_SECRET = "change-this-password";
const DEFAULT_SPREADSHEET_ID = "";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");

    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return jsonResponse({
        ok: false,
        error: "Unauthorized"
      });
    }

    const spreadsheet = getTargetSpreadsheet(payload.sheetId);
    const sheet = getOrCreateSheet(spreadsheet, payload.tab || SHEET_NAME);
    sheet.appendRow([
      payload.timestamp || new Date().toISOString(),
      payload.modelNumber || "",
      payload.serialNumber || "",
      payload.notes || "",
      payload.source || "scan-station"
    ]);

    return jsonResponse({
      ok: true
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.message
    });
  }
}

function getTargetSpreadsheet(sheetId) {
  const targetId = String(sheetId || DEFAULT_SPREADSHEET_ID || "").trim();
  if (targetId) {
    return SpreadsheetApp.openById(targetId);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("No spreadsheet ID was provided.");
  }

  return spreadsheet;
}

function getOrCreateSheet(spreadsheet, sheetName) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "Timestamp",
      "Model Number",
      "Serial Number",
      "Notes",
      "Source"
    ]);
  }

  return sheet;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
