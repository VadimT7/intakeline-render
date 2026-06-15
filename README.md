# intakeline-render

Auto-renders personalized 9:16 audit videos for the IntakeLine outreach pipeline and drops them into the Google Drive "Intro Videos" folder, so the existing n8n **Send Audit** flow picks them up unchanged.

Runs on **GitHub Actions** (free; has ffmpeg+libass). Never runs on the n8n box (4 GB, OOMs).

## What it makes
A ~23s vertical MP4: a smooth auto-scroll of the prospect's **client-firm website** with Hormozi-style burned captions delivering the hook (`I called {firm} after hours … {leak} … hear it answered live below`). No third-party call audio is used — the live "answering as their firm" demo on the audit page is the real proof; this video is the hook that earns the click.

## Flow
```
n8n "Render Trigger" (schedule)
   → reads Notion rows at "To contact" with no video yet in Drive
   → repository_dispatch  ──▶  this Action
                                 → Playwright screenshots the firm site
                                 → ffmpeg scroll + Hormozi captions → out.mp4
                                 → upload to R2 staging/{slug}.mp4
                                 → POST n8n "Render Ingest" webhook
n8n "Render Ingest" → downloads from R2 → uploads to Drive "Intro Videos" as {agency}.mp4
   → (you review the video, flip the row to "Recorded")
   → existing Send Audit run sends it at the next 11:00 ET window
```

## Secrets / vars (repo settings)
- Secret `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` — set automatically.
- Variable `N8N_INGEST_URL` — the n8n Render Ingest production webhook URL.

## Manual test
Actions tab → `render-audit-video` → Run workflow, fill slug/agency/client_firm/site_url, set `skip_callback=1` to leave the file in R2 without touching Drive.
