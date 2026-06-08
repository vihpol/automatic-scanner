# Automatic Scanner

Automatic Scanner is a phone-friendly inventory scanning app for operations teams. It lets Mr. Sean take a phone photo of a product label, extracts model and serial numbers, validates each scan before saving, and sends clean rows to Google Sheets.

## What It Solves

- Prevents blank spreadsheet rows from being missed in manual scans.
- Captures both model number and serial number from one label photo.
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
   - `OPENAI_API_KEY` optional, for higher-accuracy vision extraction
   - `OPENAI_MODEL` optional, defaults to `gpt-4.1-mini`
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

The photo picker works on mobile browsers without embedding a live camera stream in the page. For the best phone experience, open the app from the phone and tap **Take Photo**.

## How the Scanner Works

1. Sean taps **Take Photo** on his phone.
2. The phone camera captures a clear label photo.
3. The browser compresses the photo and sends it to `/api/extract`.
4. The backend extracts text with local Tesseract OCR. If `OPENAI_API_KEY` is configured, it uses OpenAI vision extraction instead.
5. The extracted model number and serial number are filled into the form.
6. Sean reviews or edits the fields.
7. The app only enables submission when both model and serial are present.
8. The backend appends the validated row to Google Sheets.

## Notes

The VM deployment can run without an OpenAI key because it has local Tesseract OCR installed. OpenAI vision extraction remains supported as an optional accuracy upgrade. If Google Sheets credentials are not configured, validated scans are accepted and logged locally for development.
