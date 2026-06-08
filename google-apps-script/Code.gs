const SHEET_NAME = "Scans";
const SHARED_SECRET = "change-this-password";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");

    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return jsonResponse({
        ok: false,
        error: "Unauthorized"
      });
    }

    const sheet = getOrCreateSheet();
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

function getOrCreateSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
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
