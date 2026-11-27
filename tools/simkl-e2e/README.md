# Simkl sync: end-to-end checks

APL TV's Simkl sync (`app/js/simkl.js`) checked in the PC preview, against a small stand-in for api.simkl.com.
The real Simkl isn't involved: no Client ID or account is needed.

- **`mock-simkl.js`** answers like api.simkl.com on port 8090. It covers Auth V2 device sign-in and key renewal,
  `/sync/activities`, `/sync/all-items` (full pulls, `date_from` deltas, `simkl_ids_only`), `/sync/playback`, history,
  add-to-list, and scrobble. It also serves a test playlist (7 movies, 3 series). `/__log` lists the requests the app
  made, and `/__do?what=…` changes the library as if from another app.
- **`run.js`** opens the app in Chromium (Playwright) on port 8080 and runs 54 checks:
  - Linking with the code.
  - The first download and its ticks.
  - My List both ways.
  - Continue Watching, Up Next and Recently Watched.
  - The first-link upload.
  - Every outgoing change, with writes at least 1 s apart.
  - Changes made on Simkl's side.
  - Finished or pause cleared elsewhere.
  - The deferred "watching now" and the retried pause.
  - The 15-minute throttle and key renewal.
  - Surviving a restart, and unlink/relink.
  - No script errors.

  Screenshots and the app's log go to `$OUT`, by default a temporary folder.

## Running it

```
npm install --no-save playwright     # once, here or globally
npx playwright install chromium      # once
tools/simkl-e2e/run.sh
```

`run.sh` starts the stand-in and a static server for `app/`, then the checks. It prints `PASS`/`FAIL` per check and
ends with `ALL PASSED`, or the number that failed (exit code 1).
