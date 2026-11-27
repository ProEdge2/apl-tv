# APL TV on NVIDIA SHIELD TV: performance research and plan

*Researched 27 November 2026, against APL TV 1.4.17 (branch `claude/festive-thompson-6adam0`, PR #1).*

The goal is to make watching on a SHIELD as smooth and as quick as possible: channels and movies that start fast,
judder-free motion, and a UI that stays fluid over the video. This document collects what the code does today,
what current documentation and other players say, and what to change, ranked by impact.

**Status legend:** ✅ done in PR #1 · 🔜 recommended next · 🧪 needs checking on a real SHIELD · ❓ could not be verified

---

## 1. The short list

| # | Change | What you notice | Effort | Status |
|---|---|---|---|---|
| 1 | Start playing after 1 s of buffer instead of 2.5 s (2.5 s instead of 5 s after a stall) | Channels and movies start up to ~1.5 s sooner | Tiny | ✅ `Player.java` |
| 2 | Open a resumed movie at its resume point, and play as soon as it's ready | No double buffering when you resume, and no wait for the page to say "play" | Small | ✅ `prepareAt` |
| 3 | Skip the `.mkv` pre-read on Android (up to 1 MB and 2 s before every `.mkv`) | `.mkv` movies and episodes start up to 2 s sooner | Tiny | ✅ `mkv.js` |
| 4 | **Frame-rate matching** through `preferredDisplayModeId` | No judder: 25/50 fps channels and 24 fps movies shown at their own rate | Medium | 🔜 🧪 |
| 5 | Keep the decoder and video surface between channels (drop `stop()` and `clearMediaItems()`) | Faster, cleaner zapping (no codec teardown, less black flash) | Small–medium | 🔜 🧪 |
| 6 | Upgrade Media3 1.5.1 → 1.11.1 | TS, HEVC and DTS-HD fixes, passthrough fix on SHIELD, dynamic scheduling | Medium | 🔜 (raises minSdk to 23) |
| 7 | No hardware layer on the WebView | Cheaper UI frames over the video | Tiny | ✅ on SHIELD, 🧪 elsewhere |
| 8 | Remove static `will-change` from cards and lists; add `content-visibility` and `img.decode()` | Less GPU memory, smoother scrolling | Small | 🔜 |
| 9 | Re-select audio when HDMI capabilities change (Media3 ≥ 1.8) | Dolby/TrueHD passthrough no longer falls back to PCM after a mode switch | Tiny (after #6) | 🔜 |
| 10 | Prewarm WebView at app start (`WebViewCompat.startUpWebView`) | Faster cold start | Small | 🔜 |
| 11 | Async JS bridge (`addWebMessageListener` + `WebViewAssetLoader`) | Remote keys and player events never block the page | Larger | 🔜 later |
| 12 | Show the time each start took | Tells a slow network from a slow app | Small | ✅ Stream Info › Time to Start |
| 13 | When several sound tracks share your language, take the one with the most channels (Atmos first among equals) | Surround and Atmos reach the receiver instead of the first stereo track | Tiny | ✅ `osd.js` (Android) |
| 14 | Name Dolby Digital Plus Atmos in Stream Info | You can see that Atmos is playing | Tiny | ✅ |
| 15 | FFmpeg audio extension | Sound for TrueHD/DTS films on TVs and soundbars that can't take them | Medium | 🔜 |
| — | Leave tunneled playback off; never preload live channels | Avoids known bugs and single-connection refusals | — | Decision |

Items 1–3, 7, 12, 13 and 14 are already in PR #1, along with the phone-page QR fix for Tailscale (§2). The Java parts reach
the SHIELD only through a new APK, because the automatic updater replaces only the web app.

---

## 2. Your setup: an Xtream login on your own server, reached over Tailscale

**Symptom:** channels and videos start slowly.

**Why it adds up.** Starting a stream on Android costs, in order:
1. Opening a connection to the server, plus a redirect for many Xtream servers (each one a round trip).
2. Waiting for the first keyframe of the stream.
3. Waiting for the start buffer: 2.5 s of video before this PR, 1 s now.
4. A round trip from Android to the web page and back before playing (removed for movies in this PR).

Tailscale adds latency to every round trip. If the SHIELD and the server can't connect directly, the traffic goes
through a Tailscale relay (DERP), which adds more latency and limits speed. A server that sends the stream at its
own pace rather than in a burst makes the start-buffer wait last its full length in real time.

**How to tell whether it's the connection:**
- **APL TV:** after installing the new APK, open Stream Info while a channel plays. **Time to Start** (new) and
  **Connection Speed** appear together. Compare the same channel at home through the server's LAN address and
  through Tailscale.
- **Tailscale:** on the server, run `tailscale status` or `tailscale ping <shield-name>`. *direct* means the
  connection is fine. *relay* (DERP) means slow starts are expected. Fix the direct path (allow UDP, check router
  NAT), or use the server's LAN address in APL TV when at home.
- **The server software:** proxies such as Dispatcharr, Threadfin or xTeVe can buffer through FFmpeg/VLC before
  sending anything, which can add seconds to every channel change. A direct, redirect or proxy mode is faster.
- **APL TV setting:** Settings › Playback › Live Stream Format. MPEG-TS starts faster than HLS.
- **Minor:** a `100.x` address skips the MagicDNS lookup that a `.ts.net` name needs.

**Fixed in the app (PR #1):**
- **Phone page QR code:** it showed whichever address Android listed first, which could be Tailscale's `100.x`, so
  a phone that isn't on Tailscale couldn't open it. Home network addresses now come first (`Helper.java`).
- Items 1, 2, 3 and 12 from §1.

---

## 3. Video playback on SHIELD

### Baseline
- **Android version:** every SHIELD model runs Android 11 (API 30): SHIELD Experience 9.x, latest 9.2.4 with
  January 2026 security patches. [P1]
- **Model codenames:** `foster` (2015), `darcy` (2017), `mdarcy` (2019 Pro, 3 GB), `sif` (2019 tube, 2 GB).
  [P2][U13]
- **ExoPlayer (Media3):** the app uses **1.5.1**. The latest stable release is **1.11.1** (Sept 2026); 1.12.0-rc01
  came out 25 Nov 2026. [P3]
- **minSdk cost of upgrading:** Media3 1.9 raised minSdk to 23 and 1.12 raises it to 24. [P4] The app is minSdk 21,
  so upgrading drops Android 5.x devices (first-generation Fire TV Sticks). That is a product decision.

### 3.1 Frame-rate matching (judder) 🔜 🧪
- **Today:** the app doesn't handle it.
- **ExoPlayer's built-in call won't do it on SHIELD.** On API 30, ExoPlayer calls `Surface.setFrameRate(rate,
  FIXED_SOURCE)`, which only asks for seamless switches, and HDMI mode changes aren't seamless.
  `CHANGE_FRAME_RATE_ALWAYS` needs API 31. Android's guide tells TV apps to set `preferredDisplayModeId`
  themselves. [P5][P6][P7] ❓ No direct SHIELD test of this was found.
- **SHIELD's own "Match frame rate (beta)"** (from 9.2): the user turns it on per playback, and "not all apps
  support this feature". Without it, SHIELD converts the content to the display's rate. [P8]
- **What other players do** (all use `preferredDisplayModeId`):
  - **Kodi:** exact rate, then 2×, then 2.5×, within 0.01 Hz (so 23.976 ≠ 24). It drops ≤30 Hz modes except 24,
    so 25p/25i go to 50 Hz. It waits up to 5 s for the display-change event. [P9]
  - **Jellyfin:** accepts 1×, 2× or 2.5×, keeps the resolution or not, and resets to mode 0 on exit. [P10]
  - **Just Player:** current resolution only, highest exact multiple, plays in `onDisplayChanged`. Off by default
    because of the black flash. [P11]
  - **SmartTube:** prefers double rate (25→50, 23.976→47.95). [P12]
- **Plan for APL TV:**
  1. Keep the current (4K) resolution and change only the refresh rate. Keeping 4K also keeps NVIDIA's AI
     upscaling in charge rather than the TV's scaler (§3.4).
  2. Choose the exact rate, else 2× (25→50, 29.97→59.94). Treat 23.976 and 24 as different. Send interlaced
     content (25i) to 50 Hz.
  3. Skip the switch when the current mode already fits. Most channels share a rate, so most zaps have no blackout.
  4. While switching, hold `playWhenReady=false` until `DisplayListener.onDisplayChanged`, then wait about 1–2 s
     (Android suggests 2 s) before playing.
  5. Reset `preferredDisplayModeId` to 0 when playback ends or the UI takes over (Live TV previews, Home).
  6. Make it a setting: Off / Movies only / Always, like the other players.
- **Getting the rate:**
  - HLS `FRAME-RATE` and MP4/MKV give `Format.frameRate`.
  - **MPEG-TS H.264 does not:** Media3's H264Reader skips the VUI timing fields. [P13] Estimate the rate from the
    first frames' timestamps, or parse the SPS from `Format.initializationData` (`NalUnitUtil.parseSpsNalUnit`,
    which also gives `frameMbsOnlyFlag` for interlace detection).
- **Needs Media3 ≥ 1.8 and `setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true)`.** On SHIELD, mode
  switches made Dolby/TrueHD passthrough fall back to PCM. [P14][P15]

### 3.2 HDR and Dolby Vision
- **Official support:** NVIDIA lists Dolby Vision and HDR10; HDR10+ and HLG aren't listed. HDR10 switches
  automatically. Dolby Vision has to be enabled, or picked as a "Dolby Vision Ready" mode. [P16][P17]
- **DV profiles:** forum reports say profiles 5, 7 and 8 play on the 2019 models; ❓ not confirmed by NVIDIA. [P18]
- **Media3 1.5.1 fallback when there's no DV decoder:**
  - Profiles 4/8 fall back to HEVC, 9 to AVC; profile 5 has no fallback. [P19]
  - Profile 7 falls back to HEVC only from 1.12. 1.9.1 fixed DV fallback failures.
- **Change:** nothing to force. On models without a DV decoder (2015/2017), detect profile-5 failures and say so.

### 3.3 Interlaced IPTV (1080i/576i)
- **No deinterlacer in ExoPlayer.** The device's decoder does it. [P20]
- **SHIELD's decoder deinterlaces in hardware, at double rate by default** (25i → 50p). A private
  `deinterlace-method=1` gives single rate. ❓ The source is a 2018 developer post. [P21]
- **Known issue:** H.264 MBAFF 576i TS freezing on the 2015 SHIELD (open, untriaged). [P22]
- **Change:** don't set `deinterlace-method`. Send interlaced content to 50 Hz (§3.1).

### 3.4 AI upscaling
- **Models:** 2019 models only. [P23]
- **When it falls back to "Enhanced":** content under 480p, above 30 Hz, or in RGB. The Pro handles 60 fps; the
  tube only up to 4K30. [P24]
- **50p content:** deinterlaced 50p channels won't get AI upscaling on the tube model.
- **Keep 4K output:** the upscale target is the output resolution. Switching to 1080p output hands scaling to the
  TV.
- 🧪 Not verified: AI upscaling with HDR, or with the WebView layered on top. Check with SHIELD's AI demo mode.

### 3.5 Tunneled playback: keep it off
- **No SHIELD evidence:** nothing found either way. ❓
- **Known problems:**
  - A Media3 maintainer: "many issues around… ending and switching streams", which is bad for zapping. [P25]
  - Video stalls on any audio underrun. [P26]
  - No speed adjustment in tunneling mode.
- **It would break the AV-sync setting.** In tunneling, the hardware syncs on the timestamps written into the
  audio stream. The app's ForwardingAudioSink offset would stop working; it would need to shift
  `presentationTimeUs` instead.
- **Others:** Just Player keeps it off by default; NextPlayer has a multichannel hang with it on. [P27][P28]

### 3.6 Audio passthrough
- **What SHIELD passes:** AC3, E-AC3/Atmos, TrueHD, DTS:X and DTS core (Settings › Available formats). [P29]
- **Media3 has no SHIELD-specific quirk.** It uses `AudioTrack.isDirectPlaybackSupported` on API 29+. [P30]
- **Open issue:** TrueHD Atmos dropouts on the Pro with receivers on streams with gaps. [P31]
- **Change:**
  - The capability-change flag (§3.1).
  - Possibly `FLAG_ENABLE_HDMV_DTS_AUDIO_STREAMS` for DTS in TS, as Just Player does. 🧪 Check that it doesn't
    misread stream type 0x82 on DVB channels.
  - An FFmpeg audio extension as a fallback for receivers without DTS/TrueHD.

### 3.7 Decoders
- **Supported:** HEVC 4K HDR60; H.264, VP8, VP9 and MPEG-1/2 up to 4K60. [P16]
- **Not supported:** AV1 and VP9 Profile 2 (from a 2019 launch review; ❓ NVIDIA's spec just doesn't list them).
- **Change:** keep `MediaCodecSelector.DEFAULT`; forcing decoders brings nothing. Deprioritise AV1 tracks.

### 3.8 What Media3 1.6 → 1.11 brings [P4]
- **1.6:** start buffer defaults 1000/2000 ms (now matched by hand, ✅); H.265 TS streams no longer get stuck;
  renderer pre-warming (only between playlist items).
- **1.8:** the SHIELD passthrough/PCM fix (#2258).
- **1.9:** E-AC3/JOC codec reuse; TS PES without timestamps; minSdk 23. **1.9.1:** DV fallback fixes.
- **1.10–1.11:** dynamic scheduling (on by default in 1.11); DTS-HD in TS fixed; TS last-frame fix; better
  frame-rate estimation; fewer frame drops when a new surface is set.
- **1.12 (RC):** DV profile 7 → HEVC; DTS-HD passthrough retry; minSdk 24.

### 3.9 Zapping
- **Keep the decoder between channels** 🔜 🧪.
  - Today a channel change runs `stop()`, then `clearMediaItems()`, then `setMediaItem()`, then `prepare()`.
    `stop()` resets the renderers and releases the codecs. [P32]
  - Replacing the media item on the same player and surface keeps "limited resources retained". [P33]
  - In APL TV, `player.js` closes the player (`av.stop()` + `av.close()`, which hides the PlayerView) before every
    open. Doing this needs either a short delayed close in `Player.java` that a following `open()` cancels, or an
    Android-only path in `player.js`.
  - The old stream must still close before the new one opens, for single-connection accounts.
- **Start buffer:** 1000 / 2500 ms now (✅). No measured IPTV study exists; Akamai's model gives ~1.9 s → ~1.1 s
  for a smaller first buffer. [P34] The stream's GOP length and connection setup are the floor.
- **HLS live offset:** the playlist's start offset, else PART-HOLD-BACK, else HOLD-BACK, else 3× target duration.
  [P35] `setLiveTargetOffsetMs` can lower it at some rebuffer risk. Handle `ERROR_CODE_BEHIND_LIVE_WINDOW`. Doesn't
  apply to MPEG-TS.
- **Network stack:**
  - OkHttp or Cronet pool sockets and speak HTTP/2 and HTTP/3. That helps HLS segment fetches, not one long TS
    connection. [P36]
  - `setAllowCrossProtocolRedirects(true)` is already set.
- **Single-connection accounts:** don't preload or pre-warm live channels, since a second stream gets refused.
  Providers also keep closed sessions for a while. [P37] The existing 380 ms zap debounce in `osd.js` already
  avoids opening every channel you pass.

---

## 4. The UI (WebView) on SHIELD

### 4.1 The WebView's hardware layer ✅ on SHIELD
- **What it was doing:** `MainActivity` set `LAYER_TYPE_HARDWARE`, so every UI frame was drawn into an offscreen
  full-screen buffer and then blended over the video. That's roughly 8 MB of extra memory and an extra full-screen
  write and read per frame. [U1][U3]
- **Guidance:** Android advises hardware layers only for the length of an animation; Chromium forbids only
  *software* layers on WebView. [U1][U2]
- **Known bug:** WebView 153 drew black areas with a hardware layer (fixed). [U5]
- **Change:** the layer is now off on SHIELD. 🧪 After installing, check that the video still shows behind the UI.
  Then drop it on other devices too.

### 4.2 Video under a transparent page
- **The cost:** views over a SurfaceView cost "a full alpha-blended composite… each time the Surface changes".
  Overlapping translucent layers can push composition from the hardware compositor to the GPU. At 4K output, the
  GPU would then composite 3840×2160 per video frame. [U6][U7] ❓ SHIELD's compositor policy isn't documented.
- **Keep the SurfaceView.** Media3 lists lower power, accurate frame timing, and full-resolution video on TVs that
  upscale the UI. [U8] `setZOrderMediaOverlay` doesn't apply, and `setZOrderOnTop` would hide the UI.
- **While video plays with no UI showing,** keep the page still: no spinners or animations, and skip DOM updates
  for the hidden OSD. Prefer compact bars to full-screen scrims.
- **Check:** `adb shell dumpsys SurfaceFlinger` during playback should show both layers as DEVICE, not CLIENT.

### 4.3 Resolution
- **SHIELD apps see 1920×1080 at 320 dpi even on 4K output.** Reported by MythTV, Plex and Flutter developers.
  [U10][U11][U12]
- **So the page already rasterizes at about 1080p.** The video surface stays 4K.
- **Only a forced `wm size 3840x2160` (a community hack) makes the UI 4K,** at 4× the pixels. Detect
  `DisplayMetrics.widthPixels > 1920` and log it. [U14]
- **Don't use `preferredDisplayModeId` to lower the UI.** It changes the HDMI output, so the video drops too.

### 4.4 WebView settings
- **`setOffscreenPreRaster`:** only helps if the page is hidden and shown again, and costs RAM on the 2 GB model.
  Skip it. [U16][U17]
- **`setRendererPriorityPolicy`:** IMPORTANT is already the default. Skip it. [U18]
- **`largeHeap`:** doesn't help WebView, whose memory is native and in the renderer process. [U19]
- **Prewarm** with `WebViewCompat.startUpWebView` (Jetpack Webkit ≥ 1.16) in `Application.onCreate`. [U20]
- **`@JavascriptInterface` calls are synchronous.** The page's JavaScript waits for each call. [U21][U22] Keep the
  methods trivial: today `tracks()`, `stats()`, `duration()` and `position()` return cached values, which is good.
- **Later:** move remote keys and player events to `addWebMessageListener`. It needs an http(s) origin, so serve
  the assets with `WebViewAssetLoader` (`https://appassets.androidplatform.net`), which Android also recommends
  over `file://` with universal access. [U22][U23] 🧪 That changes the page's origin, which affects local storage
  and the helper's origin check: plan a migration.

### 4.5 WebView version and CSS
- **Version:** SHIELD (Android 11, Google services) gets the current Android System WebView from the Play Store;
  version 153 appears in a 2026 bug report. Log it with `WebViewCompat.getCurrentWebViewPackage()`. [U24][U25]
- **Composited layers:** each one costs memory and upload bandwidth. WebView's tile budget is about 166 MB at
  1080p, shared by all layers. [U17][U26]
- **APL TV today:** `tv2.css` puts `will-change: transform` on every `.btn`, `.tab` and `.is-lift`, and on many
  strips. Set it only on what is moving, from script, during the transition. [U27] Audit with DevTools › Layers.
- **Images:** keep backdrops at 1920×1080 (a 4K image decodes to about 33 MB). Use `img.decode()` before swapping
  (the app already does for cards). [U29]
- **Off-screen rows:** `content-visibility: auto` (Chromium 85+). [U30]

### 4.6 SHIELD settings worth recommending in the app
- **Settings › Device Preferences › System › Processor mode: "Max performance".** NVIDIA recommends it for
  streaming; there's no API to read it. [U31] ❓ May not exist on the 2019 tube.
- **AI upscaling:** "AI-Enhanced" vs "Enhanced". Worth an A/B test while the OSD animates, since it uses the same
  chip as the UI.
- **Detection:** `Build.MANUFACTURER == "NVIDIA"` and `Build.MODEL` contains "SHIELD" (now
  `MainActivity.isShield()`). `ActivityManager.MemoryInfo.totalMem` tells 2 GB from 3 GB.

---

## 5. 4K, HDR and Dolby Atmos

**In short:** 4K, HDR and Atmos passthrough mostly work already. The app was getting in the way of Atmos in one place
(track choice, now fixed). The remaining work is about keeping passthrough reliable, giving TVs without a receiver
sound for every format, and setting up the SHIELD and the HDMI chain correctly.

### What already works
- **4K video:**
  - The video surface renders at the output resolution (4K), even though the UI is 1080p. [U8][U10]
  - 4K versions of a channel are grouped with its HD/FHD versions and put first when `Player.canUhd()` finds a 4K
    display mode and an HEVC decoder for 2160p50. A SHIELD has both.
  - HLS/DASH streams start at their highest quality (`ADAPTIVE_INFO`, then `setForceHighestSupportedBitrate`).
  - ExoPlayer's track selector sizes against the physical display mode (4K), not the 1080p UI. [U9]
- **Decoding on SHIELD:** HEVC Main10 4K60 HDR, VP9 4K60 and H.264 up to 4K. [P16] There's no AV1, but ExoPlayer
  skips renditions the device can't decode by itself.
- **HDR:** SHIELD switches to HDR10 output by itself, and to Dolby Vision once that's enabled (§3.2). Stream Info
  shows HDR10, HLG or Dolby Vision.
- **Atmos and surround passthrough:** ExoPlayer passes AC3, E-AC3, **E-AC3 JOC (Dolby Digital Plus Atmos)**,
  **TrueHD (including Atmos)**, DTS and DTS-HD to the receiver, whenever the SHIELD reports the receiver accepts them
  (`AudioCapabilities`, `isDirectPlaybackSupported` on API 29+). [P29][P30] Nothing in the app blocks this.

### Fixed now (PR #1)
- **Track choice:** with an audio language set in Settings, the app used to take the *first* track in that language.
  That's often the stereo AAC listed before the 5.1 or Atmos one, so Atmos never reached the receiver.
  - **On Android** it now takes the track with the most channels, Atmos first among equals. Only playable tracks are
    listed there, so this never picks one the device can't play.
  - **Samsung and LG** are unchanged, because their lists can include tracks they can't play.
- **Labels:** Stream Info says **Dolby Digital Plus Atmos** for `audio/eac3-joc` (`ec+3` in HLS), and the log says
  "E-AC3 Atmos".

### Recommended next
1. **Keep passthrough across HDMI changes:** Media3 ≥ 1.8 with
   `setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true)`. On SHIELD, a display-mode switch could drop
   Dolby/TrueHD to PCM. Frame-rate matching needs this fix. [P14][P15]
2. **TrueHD Atmos dropouts:** these happen on the SHIELD Pro with receivers on streams with gaps or splices. Follow
   androidx/media#3535, which has a MAT-packer workaround. [P31]
3. **FFmpeg audio extension** (Media3 `decoder-ffmpeg`, built with the TrueHD, DTS and E-AC3 decoders): a TV or
   soundbar that can't take TrueHD or DTS then gets PCM sound instead of "This device cannot play the sound of this
   video".
   - It's built from source with the NDK, and FFmpeg is LGPL.
   - Decoding keeps the bed channels and loses the Atmos objects. Passthrough stays the first choice whenever the
     receiver accepts the format.
4. **Dolby Vision profile 5** on SHIELDs without a DV decoder (2015/2017): explain the failure instead of a generic
   error (§3.2).
5. **Bandwidth for 4K:**
   - 4K HEVC IPTV needs about 15–25 Mb/s sustained, which a Tailscale relay usually can't hold. Keep the direct path
     (§2).
   - Stream Info's Connection Speed and Buffer show whether it keeps up.
   - The app already drops to a lower quality when the picture freezes ("videostall").
6. **With frame-rate matching** (§3.1), keep 4K and change only the refresh rate. 1080p content then keeps NVIDIA's
   AI upscaling.
7. **Tunneling stays off** (§3.5), even though it's sometimes suggested for 4K HDR sync.
8. **Optional:** 4K / HDR / Atmos badges on title pages, from the provider's names ("4K", "UHD", "HDR", "ATMOS" are
   already read for grouping versions).

### What to set on the SHIELD and the HDMI chain
- **Display:** 4K at the TV's native rate (e.g. 4K 59.940 Hz). Turn on matching the content's dynamic range/color
  space if the TV does HDR. ❓ Menu names vary between firmware versions.
- **Sound:**
  - Settings › Device Preferences › Display & Sound › Advanced sound settings › Surround sound.
  - Set **Available formats** to **Auto**, or to Manual with Dolby TrueHD/Atmos and DTS enabled for your receiver.
    [P29]
- **HDMI path:**
  - **TrueHD Atmos** needs the receiver in the HDMI chain or on **eARC**.
  - Plain **ARC** carries Dolby Digital Plus (including its Atmos variant) but not TrueHD or DTS-HD.
- **Check:**
  - Stream Info › Sound should say *Dolby Digital Plus Atmos* or *Dolby TrueHD*.
  - The receiver's display should say *Atmos*.
  - The app log lists every track and whether this device can play it (`tracks …`).

---

## 6. Testing on a Mac

**In short:** there's no SHIELD emulator. An Android TV emulator on the Mac is good for checking that things work
(navigation, layouts, the Simkl flows, the player's logic) but not for performance, judder, HDR or audio. Do those on
a real SHIELD, driven from the Mac over the network (§7).

### Is there a SHIELD emulator?
No. NVIDIA's developer page only offers developer OS images to flash onto a physical SHIELD, and says to validate
apps on the consumer OS. [M1]

### The closest emulator on an Apple Silicon Mac
- **System image:**
  - Android TV arm64 images exist for **API 31, 33, 34 and 36**; Google TV arm64 the same. [M2][M3]
  - **API 30 (the SHIELD's Android 11) exists only as x86**, which an M-series Mac can't run. Use **API 31**
    (Android 12).
  - Android 12 has things the SHIELD lacks, e.g. `CHANGE_FRAME_RATE_ALWAYS`, so don't conclude anything about
    frame-rate switching from it. [M4]
  - An Intel Mac can run the exact API 30 x86 image. [M5]
- **Device profile:** Android Studio's **Television (1080p)** profile already matches the 2019 tube SHIELD:
  1920×1080, xhdpi, D-pad, 2 GB. [M6]
  - Clone it with **3 GB** RAM for the Pro. [M7]
  - The settings live in the AVD's `config.ini`: `hw.lcd.density`, `hw.ramSize`, `hw.dPad`. [M8]
- **Remote:** the emulator's Extended controls include a D-pad panel. [M9]
- **WebView:** switch providers with `adb shell cmd webviewupdate set-webview-implementation …` (release-signed
  providers only on user images). [M10]
- **APL TV there:**
  1. Build with `python3 tools/make-android.py --dev` (or `--unsigned`).
  2. `adb install` the APK.
  3. Open `chrome://inspect` to debug the page.

### What the emulator can't reproduce
| Area | Emulator | Real SHIELD |
|---|---|---|
| Video decoders | `c2.goldfish.*`, decoding on the Mac, plus AOSP software decoders [M11][M12] | NVIDIA hardware codecs (`OMX.Nvidia.*`) [M13] |
| HEVC 10-bit / HDR10 / Dolby Vision | Not decoded: 8-bit HEVC Main only, no DV decoder [M14][M15] | Yes (§3.2) |
| HDR output | None reported [M16] | HDR10, Dolby Vision |
| Display modes / frame-rate matching | Several resolutions possible, but one refresh rate: no 23.976/24/50/59.94 Hz switching [M17][M8] | Yes (§3.1) |
| Audio passthrough (AC3, E-AC3/Atmos, TrueHD, DTS) | PCM 16-bit only [M18] | Yes (§5) |
| AI upscaling | No | 2019 models (§3.4) |
| GPU / UI smoothness | The Mac's GPU, far faster than the Tegra X1+, so it looks better than it will be [M5][M19] | The real figure |
| Memory | Can be capped at 2–3 GB; CPU and storage speeds still differ [M7] | 2 GB (tube), 3 GB (Pro) |
| NVIDIA-specific workarounds in Media3 | Not triggered (`MANUFACTURER == "NVIDIA"` checks) [M20] | Active |

### Other options from a Mac
- **BrowserStack** has a real **NVIDIA SHIELD TV Pro 2019 (Android 11)**, but only as a private device dedicated to
  an account (paid). [M21]
- **Genymotion** doesn't support Android TV. [M22]
- **Firebase Test Lab** only had virtual Google TV devices (deprecated), and is closing on 2027-09-30. [M23]
- **AWS Device Farm and Kobiton:** no TV devices found. [M24]
- **UTM/QEMU:** only unofficial LineageOS builds, not worth it. [M25]

### Recommendation
- **The emulator (API 31 Television 1080p):** day-to-day functional checks.
- **A real SHIELD over network adb:** everything that's about speed or picture and sound (§7). A used 2019 tube is
  the cheapest representative device, since it's also the weakest current model.
- **BrowserStack's private SHIELD:** only for testing remotely without owning one.

---

## 7. Measuring each change on a real SHIELD

1. **Connect from the Mac** (Android platform-tools; `brew install android-platform-tools`):
   1. On the SHIELD, open Settings › Device Preferences › About and press Build 7 times.
   2. In Developer options, turn on **Network debugging**. ❓ The path comes from forum reports; NVIDIA doesn't
      document it. [M26]
   3. On the Mac: `adb connect <shield-ip>:5555`, then accept the prompt on the TV.
   4. **See the screen on the Mac:** `scrcpy` works over the network and mirrors at 1080p. Since SHIELD 9.2.2 some get a blank
      screen with the default AAC audio. ❓ Untested workaround: `--no-audio` or `--audio-codec=raw`. [M27]
2. **The UI's frames:**
   - Build with `python3 tools/make-android.py --dev` (WebView debugging on).
   - Open `chrome://inspect` on the Mac and use the Performance, Rendering and Layers panels.
   - Run `adb shell dumpsys gfxinfo com.knikt.apltv reset`, use the app, then
     `adb shell dumpsys gfxinfo com.knikt.apltv framestats`. [U33][U35]
3. **Composition while video plays:** `adb shell dumpsys SurfaceFlinger`. The video and app layers should be
   DEVICE, not CLIENT. [U7]
4. **Display mode** (frame-rate matching): `adb shell dumpsys display | grep -i mode`.
5. **Decoders:**
   - `adb logcat EventLogger:* ExoPlayerImpl:* MediaCodecInfo:* *:s`. The `videoDecoderInitialized` line names
     the decoder; `NoSupport` lines show what was refused. [M28]
   - On Android 11, use `adb shell dumpsys media.metrics` and `dumpsys media.resource_manager`
     (`media.codec` isn't a dumpsys service there). [M29]
   - **Frame pacing of the video:** `adb shell dumpsys SurfaceFlinger --latency <video layer>`, or `--timestats`.
     `gfxinfo` covers the UI, not the video. [M30]
   - **Tracing:** Perfetto from ui.perfetto.dev (Android 11+, over the same adb). [M31]
6. **Start times:**
   - The app log says `started in N ms` for every channel and movie; Stream Info shows the same.
   - Run `adb logcat | grep -i -E "APL TV|ExoPlayer|MediaCodec"`.
   - Compare before and after each change, over LAN and over Tailscale.
7. **Memory:** `adb shell dumpsys meminfo com.knikt.apltv`, plus the WebView renderer's PID. [U19]

---

## 8. Open questions

These couldn't be verified from public sources and are worth checking on a SHIELD:
- Whether `Surface.setFrameRate` on API 30 ever switches SHIELD's HDMI mode, and how SHIELD's "Match frame rate"
  interacts with an app's `preferredDisplayModeId`.
- Dolby Vision profiles beyond forum reports; HLG and HDR10+.
- AI upscaling with the UI on top, with HDR, and with deinterlaced content.
- Whether tunneling is reliable on SHIELD.
- Whether the 2018 double-rate deinterlacing finding still holds on current firmware.
- SHIELD's hardware compositor policy for a translucent window over video.
- The UI's frame rate while the display is in a 24 Hz mode.
- Measured IPTV start times for specific buffer values (no study found).

---

## Sources

**Playback**
- [P1] https://www.nvidia.com/en-us/shield/software-update/
- [P2] https://github.com/androidx/media/issues/3572
- [P3] https://github.com/androidx/media/releases
- [P4] https://github.com/androidx/media/blob/main/RELEASENOTES.md
- [P5] https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/video/VideoFrameReleaseHelper.java
- [P6] https://developer.android.com/reference/android/view/Surface
- [P7] https://developer.android.com/media/optimize/performance/frame-rate
- [P8] https://www.nvidia.com/en-us/shield/support/shield-tv/match-frame-rate/
- [P9] https://github.com/xbmc/xbmc/blob/master/xbmc/windowing/Resolution.cpp · https://github.com/xbmc/xbmc/blob/master/xbmc/platform/android/activity/XBMCApp.cpp
- [P10] https://github.com/jellyfin/jellyfin-androidtv/blob/master/app/src/main/java/org/jellyfin/androidtv/ui/playback/PlaybackController.java
- [P11] https://github.com/moneytoo/Player/blob/master/app/src/main/java/com/brouken/player/Utils.java · https://github.com/moneytoo/Player/issues/252
- [P12] https://github.com/yuliskov/SmartTube/blob/master/common/src/main/java/com/liskovsoft/smartyoutubetv2/common/autoframerate/internal/DisplaySyncHelper.java
- [P13] https://github.com/androidx/media/blob/release/libraries/extractor/src/main/java/androidx/media3/extractor/ts/H264Reader.java
- [P14] https://github.com/androidx/media/issues/2258
- [P15] https://github.com/moneytoo/Player/issues/635
- [P16] https://www.nvidia.com/en-us/shield/specs/
- [P17] https://www.nvidia.com/en-eu/shield/support/shield-tv/enable-dolby-vision-hdr10-on-shield/
- [P18] https://emby.media/community/topic/103414-emby-for-android-tv-beta-on-a90j-discarding-dv/page/2
- [P19] https://github.com/androidx/media/blob/1.5.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/mediacodec/MediaCodecUtil.java
- [P20] https://github.com/google/ExoPlayer/issues/2013 · https://github.com/androidx/media/issues/2341
- [P21] https://lists.mythtv.org/pipermail/mythtv-dev/2018-June/076810.html
- [P22] https://github.com/androidx/media/issues/3572
- [P23] https://www.androidpolice.com/2020/08/26/nvidia-releases-shield-experience-8-2-improving-ai-upscaling-for-2019-models-and-more/
- [P24] https://www.nvidia.com/en-us/shield/support/shield-tv/ai-upscaling/
- [P25] https://github.com/androidx/media/issues/2941
- [P26] https://source.android.com/docs/devices/tv/multimedia-tunneling
- [P27] https://github.com/moneytoo/Player/issues/585
- [P28] https://github.com/anilbeesetti/nextplayer/issues/2125
- [P29] https://www.nvidia.com/en-us/shield/support/shield-tv/avr-surround-audio-setup/
- [P30] https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioCapabilities.java
- [P31] https://github.com/androidx/media/issues/3535
- [P32] https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/ExoPlayerImplInternal.java
- [P33] https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/ExoPlayer.java · https://github.com/google/ExoPlayer/issues/3933
- [P34] https://www.akamai.com/blog/performance/enhancing-video-streaming-quality-for-exoplayer-part-2-exoplayers-buffering-strategy-how-to-lower
- [P35] https://github.com/androidx/media/blob/release/libraries/exoplayer_hls/src/main/java/androidx/media3/exoplayer/hls/HlsMediaSource.java
- [P36] https://developer.android.com/media/media3/exoplayer/network-stacks
- [P37] https://emby.media/learn/articles/live-tv/sources/capacity/TV-IPTV-Limits.html

**Testing on a Mac**
- [M1] https://developer.nvidia.com/shield-developer-os-images
- [M2] https://dl.google.com/android/repository/sys-img/android-tv/sys-img2-4.xml
- [M3] https://dl.google.com/android/repository/sys-img/google-tv/sys-img2-4.xml
- [M4] https://developer.android.com/reference/android/view/Surface
- [M5] https://developer.android.com/studio/run/emulator-acceleration
- [M6] https://android.googlesource.com/platform/tools/base/+/refs/heads/mirror-goog-studio-main/sdklib/src/main/resources/com/android/sdklib/devices/tv.xml
- [M7] https://developer.android.com/studio/run/managing-avds
- [M8] https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/emu/avd/src/android/avd/hardware-properties.ini
- [M9] https://developer.android.com/studio/run/emulator-extended-controls
- [M10] https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/webview-providers.md
- [M11] https://android.googlesource.com/device/generic/goldfish/+/refs/heads/main/codecs/media/codecs.xml
- [M12] https://android.googlesource.com/device/generic/goldfish-opengl/+/8d51d2e%5E%21
- [M13] https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/mediacodec/MediaCodecRenderer.java
- [M14] https://android.googlesource.com/device/generic/goldfish-opengl/+/refs/heads/main/system/codecs/c2/decoders/hevcdec/C2GoldfishHevcDec.cpp
- [M15] https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/codec2/components/hevc/C2SoftHevcDec.cpp
- [M16] https://android.googlesource.com/device/generic/goldfish-opengl/+/refs/heads/main/system/hwc3/Display.cpp
- [M17] https://android.googlesource.com/device/generic/goldfish-opengl/+/refs/heads/main/system/hwc3/DisplayFinder.cpp
- [M18] https://android.googlesource.com/device/generic/goldfish/+/refs/heads/main/hals/audio/util.cpp
- [M19] https://www.nvidia.com/en-us/shield/shield-tv/
- [M20] https://github.com/androidx/media/blob/release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/video/MediaCodecVideoRenderer.java
- [M21] https://www.browserstack.com/docs/app-automate/smart-tv/getting-started
- [M22] https://support.genymotion.com/hc/en-us/articles/115004220045-Does-Genymotion-support-Android-TV
- [M23] https://firebase.google.com/docs/test-lab/available-testing-devices
- [M24] https://docs.aws.amazon.com/devicefarm/latest/developerguide/devices.html
- [M25] https://wiki.lineageos.org/utm-vm-on-apple-silicon-mac
- [M26] https://forums.nextpvr.com/showthread.php?pid=589588
- [M27] https://github.com/Genymobile/scrcpy (doc/audio.md; issues #4316, #6501)
- [M28] https://developer.android.com/media/media3/exoplayer/debug-logging
- [M29] https://android.googlesource.com/platform/frameworks/av/+/refs/heads/android11-release/services/
- [M30] https://android.googlesource.com/platform/frameworks/native/+/refs/heads/android11-release/services/surfaceflinger/SurfaceFlinger.cpp
- [M31] https://perfetto.dev/docs/getting-started/system-tracing

**UI and WebView**
- [U1] https://developer.android.com/develop/ui/views/graphics/hardware-accel
- [U2] https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/software_draw_deprecated.md
- [U3] https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android11-release/libs/hwui/pipeline/skia/GLFunctorDrawable.cpp
- [U5] https://issues.chromium.org/issues/566667041
- [U6] https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android11-release/core/java/android/view/SurfaceView.java
- [U7] https://source.android.com/docs/core/graphics/hwc
- [U8] https://developer.android.com/media/media3/ui/surface
- [U9] https://github.com/androidx/media/blob/release/libraries/common/src/main/java/androidx/media3/common/util/Util.java (getCurrentDisplayModeSize)
- [U10] https://lists.mythtv.org/pipermail/mythtv-dev/2018-August/076974.html
- [U11] https://forums.plex.tv/t/wrong-x-plex-device-screen-resolution-detection-on-nvidia-shield-pro-2019/816662
- [U12] https://forums.developer.nvidia.com/t/flutter-app-4k-rendering-on-nvidia-shield/312695
- [U13] https://github.com/LineageOS/android_device_nvidia_foster/blob/cdd6e8e92b2e5e002c910e479f1191366b6b69fe/init/init_foster.cpp
- [U14] https://medium.com/@naren/nvidia-shield-tv-4k-ui-2930f6a254b8 (search snippet only)
- [U16] https://developer.android.com/reference/android/webkit/WebSettings
- [U17] https://chromium.googlesource.com/chromium/src/+/main/android_webview/browser/gfx/browser_view_renderer.cc
- [U18] https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/webkit/WebView.java
- [U19] https://developer.android.com/develop/ui/views/layout/webapps/manage-webview-memory
- [U20] https://developer.android.com/develop/ui/views/layout/webapps/optimize-webview-startup
- [U21] https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/java-bridge.md
- [U22] https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge
- [U23] https://developer.android.com/develop/ui/views/layout/webapps/load-local-content
- [U24] https://blogs.nvidia.com/blog/2022/01/12/shield-experience-9
- [U25] https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/webview-providers.md
- [U26] https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
- [U27] https://developer.mozilla.org/en-US/docs/Web/CSS/will-change
- [U29] https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
- [U30] https://web.dev/articles/content-visibility
- [U31] https://support-shield.nvidia.com/shield-tv-user-guide/How_to_Optimize_Internet_and_Video_Performance.htm
- [U33] https://developer.chrome.com/docs/devtools/remote-debugging/webviews
- [U35] https://developer.android.com/topic/performance/rendering/inspect-gpu-rendering
