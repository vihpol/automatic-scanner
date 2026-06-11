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
    appendScanByModel(sheet, payload.modelNumber, payload.serialNumber);

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

  return sheet;
}

function appendScanByModel(sheet, rawModelNumber, rawSerialNumber) {
  const modelNumber = cleanValue(rawModelNumber);
  const serialNumber = cleanValue(rawSerialNumber);

  if (!modelNumber) {
    throw new Error("Model number is required.");
  }

  if (!serialNumber) {
    throw new Error("Serial number is required.");
  }

  const column = findOrCreateModelColumn(sheet, modelNumber);
  const nextRow = findNextSerialRow(sheet, column);

  sheet.getRange(1, column).setValue(modelNumber);
  sheet.getRange(nextRow, column).setValue(serialNumber);
  sheet.getRange(1, column).setFontWeight("bold");
  sheet.autoResizeColumn(column);
}

function findOrCreateModelColumn(sheet, modelNumber) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const target = normalizeValue(modelNumber);

  for (let index = 0; index < headers.length; index += 1) {
    if (normalizeValue(headers[index]) === target) {
      return index + 1;
    }
  }

  if (isStarterTemplate(sheet)) {
    return 1;
  }

  for (let index = 0; index < headers.length; index += 1) {
    if (!cleanValue(headers[index])) {
      return index + 1;
    }
  }

  return lastColumn + 1;
}

function findNextSerialRow(sheet, column) {
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const values = sheet.getRange(2, column, lastRow - 1, 1).getDisplayValues();

  for (let index = 0; index < values.length; index += 1) {
    const value = cleanValue(values[index][0]);

    if (!value || normalizeValue(value) === "serial number") {
      return index + 2;
    }
  }

  return lastRow + 1;
}

function isStarterTemplate(sheet) {
  const firstCell = cleanValue(sheet.getRange(1, 1).getDisplayValue());
  const secondCell = cleanValue(sheet.getRange(2, 1).getDisplayValue());
  const onlyOneColumn = sheet.getLastColumn() <= 1;

  return onlyOneColumn &&
    normalizeValue(firstCell) === "model number" &&
    normalizeValue(secondCell) === "serial number";
}

function cleanValue(value) {
  return String(value || "").trim();
}

function normalizeValue(value) {
  return cleanValue(value).toLowerCase();
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
