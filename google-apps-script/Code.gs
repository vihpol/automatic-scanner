const SHEET_NAME = "Scans";
const SHARED_SECRET = "scanned";
const DEFAULT_SPREADSHEET_ID = "";

function doPost(e) {
  try {
    return handlePayload(JSON.parse(e.postData.contents || "{}"));
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.message
    });
  }
}

function doGet(e) {
  try {
    return handlePayload((e && e.parameter) || {});
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.message
    });
  }
}

function handlePayload(payload) {
  if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
    return jsonResponse({
      ok: false,
      error: "Unauthorized"
    });
  }

  const spreadsheet = getTargetSpreadsheet(payload.sheetId);
  const sheet = getOrCreateSheet(spreadsheet, payload.tab || SHEET_NAME);
  const location = appendScanByModel(sheet, payload.modelNumber, payload.serialNumber);

  return jsonResponse({
    ok: true,
    modelNumber: cleanValue(payload.modelNumber),
    serialNumber: cleanValue(payload.serialNumber),
    spreadsheetName: spreadsheet.getName(),
    spreadsheetUrl: spreadsheet.getUrl(),
    sheetName: sheet.getName(),
    row: location.row,
    column: location.column,
    headerCell: location.headerCell,
    serialCell: location.serialCell,
    headerValue: location.headerValue,
    serialValue: location.serialValue
  });
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
  const modelNumber = normalizeModelNumber(rawModelNumber);
  const serialNumber = cleanValue(rawSerialNumber);

  if (!modelNumber) {
    throw new Error("Model number is required.");
  }

  if (!serialNumber) {
    throw new Error("Serial number is required.");
  }

  const column = findOrCreateModelColumn(sheet, modelNumber);
  const nextRow = findNextSerialRow(sheet, column);
  const headerRange = sheet.getRange(1, column);
  const serialRange = sheet.getRange(nextRow, column);

  writePlainText(headerRange, modelNumber);
  writePlainText(serialRange, serialNumber);
  headerRange
    .setFontWeight("bold")
    .setBackground("#dbeafe");
  sheet.autoResizeColumn(column);
  SpreadsheetApp.flush();

  const columnLetter = columnToLetter(column);

  return {
    row: nextRow,
    column,
    headerCell: `${columnLetter}1`,
    serialCell: `${columnLetter}${nextRow}`,
    headerValue: cleanValue(headerRange.getDisplayValue()),
    serialValue: cleanValue(serialRange.getDisplayValue())
  };
}

function findOrCreateModelColumn(sheet, modelNumber) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const target = modelKey(modelNumber);

  for (let index = 0; index < headers.length; index += 1) {
    if (modelKey(headers[index]) === target) {
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

function writePlainText(range, value) {
  range
    .setNumberFormat("@")
    .setValue(cleanValue(value));
}

function columnToLetter(column) {
  let letter = "";
  let current = column;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    current = Math.floor((current - 1) / 26);
  }

  return letter;
}

function cleanValue(value) {
  return String(value || "").trim();
}

function normalizeValue(value) {
  return cleanValue(value).toLowerCase();
}

function modelKey(value) {
  return normalizeValue(normalizeModelNumber(value)).replace(/[^a-z0-9]/g, "");
}

function normalizeModelNumber(value) {
  let normalized = cleanValue(value).toUpperCase().replace(/\s+/g, "");

  normalized = normalized
    .replace(/^SW-(\d{3})6(-)/, "SW-$1G$2")
    .replace(/^SW-(\d{3})G-84(-TH5$)/, "SW-$1G-64$2");

  return normalized;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
