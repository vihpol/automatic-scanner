# Automatic Scanner

Automatic Scanner is a phone-friendly Micas switch scan station. It lets Mr. Sean take a phone photo of a switch label, extracts model and serial numbers, validates each scan before saving, and sends clean rows to Google Sheets.

## What It Solves

- Prevents blank spreadsheet rows from being missed in manual scans.
- Captures both model number and serial number from one label photo.
- Prompts immediately when a required field is missing.
- Sends confirmed scan records directly to Google Sheets.
- Supports auto-save for rapid scan-station use.

## Project Structure

```text
automatic-scanner/
  public/
    app.js
    index.html
    styles.css
  google-apps-script/
    Code.gs
  .env.example
  .gitignore
  package.json
  README.md
  server.js
```

## Google Sheets Setup With Apps Script

1. Create a Google Sheet.
2. Rename the first tab to `Scans`.
3. Open `Extensions > Apps Script`.
4. Paste the contents of `google-apps-script/Code.gs`.
5. Change `SHARED_SECRET` in the script to a simple private value.
6. Click `Deploy > New deployment`.
7. Choose `Web app`.
8. Set `Execute as` to `Me`.
9. Set `Who has access` to `Anyone`.
10. Deploy and copy the web app URL.
11. Copy `.env.example` to `.env`.
12. Fill in:
   - `OPENAI_API_KEY` optional, for higher-accuracy vision extraction
   - `OPENAI_MODEL` optional, defaults to `gpt-4.1-mini`
   - `GOOGLE_APPS_SCRIPT_URL`
   - `GOOGLE_APPS_SCRIPT_SECRET`

The sheet tab should have this header row:

```text
Timestamp | Model Number | Serial Number | Notes | Source
```

The old service-account Google Sheets setup is still supported, but Apps Script is easier for this scan station.

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

The photo picker works on mobile browsers without embedding a live camera stream in the page. For the best phone experience, open the app from the phone and tap **Scan Label**.

## How the Scanner Works

1. Sean taps **Scan Label** on his phone.
2. The phone camera captures a clear label photo.
3. The browser compresses the photo and sends it to `/api/extract`.
4. The backend extracts text with local Tesseract OCR. If `OPENAI_API_KEY` is configured, it uses OpenAI vision extraction instead.
5. The extracted model number and serial number are filled into the form.
6. Sean reviews or edits the model and serial fields.
7. The app only enables submission when both model and serial are present.
8. The backend appends the validated row to Google Sheets.

## Notes

The VM deployment can run without an OpenAI key because it has local Tesseract OCR installed. OpenAI vision extraction remains supported as an optional accuracy upgrade. If Google Sheets credentials are not configured, validated scans are accepted and logged locally for development.
