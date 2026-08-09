# `docs/assets/` — visual content for the public README

This directory holds **small PNG screenshots only** (~≤200 KB each) used by the main repository README. Walkthrough videos do **not** live here — they live on GitHub's user-attachment CDN (see "Hosting walkthrough videos" below) and are embedded in the README via the URL GitHub returns.

Keep the directory lean. Three or four screenshots that read at a glance beats a gallery of similar shots.

---

## Pre-commit PII scrub checklist

The public-release scanner (`scripts/audit-current-tree.mjs`) does **not** read pixel data or EXIF metadata. Anything visible in a screenshot — or embedded in image metadata — reaches the public repo as-is. Walk through this list before adding any image:

1. **Strip EXIF / IPTC / XMP metadata.**
   - ImageMagick: `magick mogrify -strip docs/assets/*.png`
   - ExifTool: `exiftool -all= -overwrite_original docs/assets/*.png`
   - Verify with `exiftool docs/assets/your.png` — you want zero personal fields (Author, Camera, GPS, Software path).
2. **Title bar — no Windows username.** `C:\Users\<your-name>\…` shouldn't appear anywhere in window chrome. Either screenshot just the app's client area, crop the title bar out in post, or run the app under a placeholder username (e.g. set `USERPROFILE=tomes-demo` for the recording session).
3. **Browser tabs / bookmarks bar.** Other tabs reveal what you're working on, and bookmark titles can carry your real name or company. Close tabs you don't need; tuck the bookmark bar away.
4. **Notifications + system tray.** Disable notifications for the duration. Crop the tray if anything personal lingers (calendar invites, mail counts, build agent notices).
5. **File-open / save dialogs.** Close any open file picker — they reveal recent paths.
6. **Demo content uses synthetic names.** Match the test-fixture convention: "Acme Bards" for campaigns, "Test Town" or "Velka" for placeholders. Don't screenshot your actual campaign.
7. **Visible filenames in the app's KB tab, Sessions tab, etc.** All should be synthetic.

If any of the above sneaks through, **rotate before re-publishing**: delete the offending PNG, sanitise, force-push a corrected release commit. (Don't just edit and amend — Git keeps the old blob reachable via the previous push.)

---

## Hosting walkthrough videos

GitHub stores user-uploaded videos on its own CDN under your account. The URL is a UUID and your real name is not exposed — perfect for embedding a walkthrough without linking to YouTube or any third-party platform.

The mechanic:

1. Sanitise your machine state per the checklist above (and remember: video frames are screenshots too).
2. Record (OBS Studio with the App capture source works well on Windows) and export as MP4, ≤100 MB.
3. Open a **draft GitHub issue** in `KochiTusker/Tusks-Tomes-Dev` (private — doesn't matter, the resulting CDN URL is public-readable).
4. Drag the `.mp4` into the comment body. Wait for upload to finish.
5. Copy the `<video src="https://github.com/user-attachments/assets/<uuid>"></video>` snippet GitHub inserted.
6. **Close the issue without submitting it.** The CDN URL persists; the issue is just the upload vehicle.
7. Paste the snippet into the main `README.md` where the placeholder lives. Commit. Push.

If GitHub ever changes the CDN policy and the URL 404s, you still have the source `.mp4` locally — re-upload to a fresh draft issue and swap the URL.

For a belt-and-braces fallback, you can also keep a small low-resolution `.webm` (≤30 MB) checked in here as `walkthrough-fallback.webm` and reference it inside a `<video><source>` tag.
