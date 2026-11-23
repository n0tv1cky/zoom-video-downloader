# Setup guide

This guide gets the downloader running by hand on your own machine:
read the recordings sheet, download each Zoom recording, and optionally upload
it to Google Drive. Plan on about 20 minutes. Scheduled runs are optional and
covered separately in [daily-automation.md](daily-automation.md).

## 1. What you need

- **Node.js 20.11 or newer** (`node -v`).
- **Google Chrome**, the normal installed app.
- **A Google account that can open the recordings sheet.**
- **ffmpeg** (optional). It's needed only when one Zoom file holds two classes
  back to back. On macOS: `brew install ffmpeg`.

## 2. Install

```bash
git clone https://github.com/n0tv1cky/zoom-video-downloader.git
cd zoom-video-downloader
npm install
```

## 3. Create a Google sign-in for the script

The script reads the sheet (and uploads to Drive) as **you**, so it needs its
own OAuth client:

1. **Create a project.** Open [Google Cloud Console](https://console.cloud.google.com/)
   and create a project (any name).
2. **Enable two APIs:** the
   [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   and the
   [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
3. **Set up the consent screen.** Under **APIs & Services → OAuth consent
   screen**, choose **External** and fill in the required fields. Add your own
   Google address under **Test users**.
4. **Create the client.** Under **APIs & Services → Credentials → Create
   credentials → OAuth client ID**, choose **Desktop app**.
5. **Save the file.** Download the JSON and save it in the repo folder as
   **`oauth-client.json`**. It's already ignored by git; never share it.

## 4. Configure

Your own values go in `config.local.json`. It's ignored by git and overrides
`config.json`.

```bash
cp config.local.example.json config.local.json
```

Edit `config.local.json`:

| Key | What to put |
|---|---|
| `recordingsSheet.id` | The long ID in the sheet's URL: `docs.google.com/spreadsheets/d/<id>/edit` |
| `recordingsSheet.gid` | The tab number after `gid=` in the URL (`0` for the first tab) |
| `outputDir` | Where videos are saved, relative to the repo (`./recordings` is fine) |
| `driveUpload.enabled` | `false` to only download, or `true` to also upload to Drive |
| `driveUpload.rootFolderId` | If uploading: the ID at the end of the Drive folder's URL |
| `driveUpload.tokenFile` | Leave as it is, so uploads use the same Google login as the sheet |

You can delete `notifications`; it's only for the emailed reports from
scheduled runs.

Then check `config.json` against your sheet. Nothing secret lives here:

- **`columns`**: the sheet's header text, exactly as written.
- **`subjectCodeMap`**: the sheet's short course names mapped to course codes
  (for example, `"ME": "DSM 107"`).
- **`term`** and **`stateFile`**: a label and a progress file. Use a new
  `stateFile` per term.
- **`sessionOverrides`**, **`heldWithoutRecording`** and **`courseFaculty`**:
  corrections and data for the original author's batch. Keep them if you're
  in the same batch; otherwise replace them with `{}`, `[]` and `{}`.

## 5. First run

**a. Dry run.** It lists what would be downloaded and changes nothing:

```bash
npm run sync:dry
```

The first time, a browser tab opens. Sign in with the Google account that can
see the sheet and allow access. The login is saved in
`~/.zoom-recordings-sync/`.

**b. Log in to Zoom once and fetch one recording:**

```bash
npm run login
```

A Chrome window opens on the first Zoom link. If it shows a sign-in page, sign
in the way you normally open the recordings. Then go back to the terminal and
press **Enter**. The login is kept in a separate Chrome profile
(`~/.zoom-recordings-sync/chrome-profile`); your everyday Chrome isn't touched.

**c. Download everything:**

```bash
npm run sync
```

It runs headless (no window) from now on. You can run it any time. Anything
already done is skipped, so run it at least every few days, before links
expire.

## 6. What you get

```
recordings/
  DSM-101/DSM-101-1_2026-08-17_Suman-Majumdar.mp4
  DSM-107/DSM-107-2_2026-08-17_Karthikeya-Naraparaju.mp4
```

With Drive upload on, the same layout is created under your Drive folder, in a
subfolder named after `outputDir`. To delete local copies once they're safely
on Drive, set `driveUpload.deleteLocalAfterUpload: true`.

## If something goes wrong

| Message | Fix |
|---|---|
| `…running headless… Re-run with --headed` | The Zoom login expired. Run `npm run login` and sign in again. |
| Google login errors such as `invalid_grant` | Delete `~/.zoom-recordings-sync/google-oauth-token.json` and run again to sign in. Tokens from a "Testing" OAuth app can expire after about a week. |
| `No Drive login at … run: node auth-personal-drive.mjs` | Set `driveUpload.tokenFile` as shown in step 4. That script is only for keeping videos in a *different* Google account than the one reading the sheet. |
| `share page lists N recording files but the sheet row lists M classes` | The link has an extra or missing recording. Check it in a browser, then map each class to its file with `clip` in `sessionOverrides` (see [how-it-works.md](how-it-works.md#hand-corrections-sessionoverrides)). |
| `pending-manual-split` | One file holds two classes and no clear break was found. Find the break time by watching, then run `node confirm-split.mjs <stateKey> --at MM:SS`. |
| A recording fails after its link's end date | The link has expired. Ask whoever shares the recordings for a fresh link. |

How the pieces fit together is explained in [how-it-works.md](how-it-works.md).
