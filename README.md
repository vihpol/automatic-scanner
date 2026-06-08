# Automatic Scanner

Automatic Scanner is a phone-friendly inventory scanning app for operations teams. It helps Sean capture model numbers and serial numbers from product labels, validates each scan before it is saved, and sends clean rows to Google Sheets.

## What It Solves

- Prevents blank spreadsheet rows from missed manual scans.
- Captures both model number and serial number in the same workflow.
- Prompts immediately when a required field is missing.
- Sends confirmed scan records directly to Google Sheets.
- Keeps a local session history so the operator can review recent scans.

## Project Structure

```text
automatic-scanner/
  public/
    app.js
    index.html
    styles.css
  .env.example
  .gitignore
  package.json
  README.md
  server.js
```

## Google Sheets Setup

1. Create a Google Cloud service account.
2. Enable the Google Sheets API for the project.
3. Create a service account key in JSON format.
4. Share the target Google Sheet with the service account email as an editor.
5. Copy `.env.example` to `.env`.
6. Fill in:
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SHEET_TAB`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`

The sheet tab should have this header row:

```text
Timestamp | Model Number | Serial Number | Notes | Source
```

## Run Locally

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

For phone testing, run the server on the same Wi-Fi network and open the computer's local IP address from the phone, for example:

```text
http://192.168.1.20:3000
```

For phone testing, set `HOST=0.0.0.0` in `.env` so other devices on the network can reach the server.

Camera access usually requires HTTPS or localhost. If mobile browser camera access is blocked on a local IP, deploy this app or run it behind an HTTPS tunnel.

## How the Scanner Works

1. Choose whether you are scanning a model number or serial number.
2. Point the phone camera at a barcode.
3. The app reads supported barcode formats through the browser `BarcodeDetector` API when available.
4. If the browser cannot detect the code, the operator can type or paste the value manually.
5. The app only enables submission when both model and serial are present.
6. The backend appends the validated row to Google Sheets.

## Notes

This MVP uses browser barcode detection and manual fallback. Photo-based OCR for printed model text can be added later with a vision/OCR service, but the validation flow is already designed for that upgrade.
