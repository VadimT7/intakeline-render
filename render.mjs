/* IntakeLine audit-video renderer.
 *
 * Input (env): SLUG, AGENCY, CLIENT_FIRM, FIRST_NAME, SITE_URL, LEAK_NOTE, PAGE_URL
 * Output: a vertical 1080x1920 MP4 = smooth auto-scroll of the client firm's
 *   website + Hormozi-style burned captions of the hook, uploaded to R2 staging,
 *   then handed to the n8n ingest webhook which drops it in the Drive folder.
 *
 * No third-party call audio is used (legal: right of publicity). The proof is
 * the live "talk to the AI answering as their firm" demo on the audit page;
 * this video is the hook that earns the click. Fully free: Playwright + ffmpeg
 * (libass on the ubuntu runner), R2 transport, n8n's existing Drive OAuth.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const SLUG = env("SLUG") || "test";
const AGENCY = env("AGENCY") || "the agency";
const CLIENT_FIRM = env("CLIENT_FIRM") || "the firm";
const FIRST_NAME = env("FIRST_NAME");
const SITE_URL = env("SITE_URL");
const LEAK_NOTE =
  env("LEAK_NOTE") ||
  "their answering service couldn't even take the case details";
const DUR = 23; // seconds
const FPS = 30;

const R2_KEY = env("R2_ACCESS_KEY_ID");
const R2_SECRET = env("R2_SECRET_ACCESS_KEY");
const R2_ACCOUNT = env("R2_ACCOUNT_ID");
const R2_BUCKET = env("R2_BUCKET", "intakeline-media");
const N8N_INGEST_URL = env("N8N_INGEST_URL");
const SKIP_CALLBACK = env("SKIP_CALLBACK") === "1";

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
}

/* ---- 1. capture a tall full-page screenshot of the client firm's site ---- */
async function captureSite() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1350 },
      deviceScaleFactor: 1.5,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    // best-effort dismiss cookie / consent overlays
    for (const re of [/accept/i, /agree/i, /got it/i, /allow all/i, /i understand/i]) {
      try {
        const b = page.getByRole("button", { name: re }).first();
        if (await b.isVisible({ timeout: 800 })) await b.click({ timeout: 800 });
      } catch {}
    }
    // trigger lazy images: scroll down then back to top
    try {
      await page.evaluate(async () => {
        const h = document.body.scrollHeight;
        for (let y = 0; y < h; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1200);
    } catch {}
    await page.screenshot({ path: "page.png", fullPage: true });
    const dim = await page.evaluate(() => ({
      w: document.documentElement.clientWidth,
    }));
    await browser.close();
    return dim;
  } catch (e) {
    await browser.close();
    return null;
  }
}

/* ---- 2. build a branded fallback background if the site won't load ---- */
function fallbackBackground() {
  sh("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x08090A:s=1080x1920",
    "-frames:v", "1",
    "page.png",
  ]);
  return { scaledH: 1920, fallback: true };
}

/* ---- 3. caption track (.ass, Hormozi style: bold, white + neon-yellow) ---- */
function esc(s) {
  return s.replace(/\n/g, " ").replace(/[{}]/g, "").trim();
}
function t(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}
function buildAss() {
  const who = FIRST_NAME ? FIRST_NAME : "you";
  const lines = [
    [0.4, 6.2, `I called {\\c&H00FFFF&}${esc(CLIENT_FIRM)}{\\c&HFFFFFF&} after hours`],
    [6.2, 12.5, `posing as an injured lead, and ${esc(LEAK_NOTE)}`],
    [12.5, 17.8, `{\\c&H00FFFF&}78%{\\c&HFFFFFF&} hire the FIRST firm that answers.`],
    [17.8, DUR, `Hear the same call answered live, ${esc(who)}. {\\c&H00FFFF&}Try it below.{\\c&HFFFFFF&}`],
  ];
  const dialog = lines
    .map(
      ([a, b, txt]) =>
        `Dialogue: 0,${t(a)},${t(b)},Hook,,0,0,0,,${txt}`,
    )
    .join("\n");
  // persistent header + brand, spanning the whole clip
  const header = `Dialogue: 0,${t(0)},${t(DUR)},Header,,0,0,0,,PRIVATE INTAKE AUDIT  -  ${esc(AGENCY).toUpperCase()}`;
  const brand = `Dialogue: 0,${t(0)},${t(DUR)},Brand,,0,0,0,,INTAKELINE`;
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,DejaVu Sans,86,&H00FFFFFF,&H00000000,&HA0000000,1,0,1,6,3,2,90,90,520,1
Style: Header,DejaVu Sans,40,&H00B4BCD0,&H00000000,&H00000000,1,0,1,4,0,8,60,60,90,1
Style: Brand,DejaVu Sans,44,&H00F9E80E,&H00000000,&H00000000,1,0,1,4,0,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${header}
${brand}
${dialog}
`;
  writeFileSync("captions.ass", ass);
}

/* ---- 4. composite the final MP4 with ffmpeg ---- */
function renderVideo(scaledTallEnough) {
  // pan filter: scroll the screenshot top->bottom; if too short, gentle zoom
  const panFilter = scaledTallEnough
    ? `scale=1080:-1:flags=lanczos,crop=1080:1920:0:'min((ih-1920)*t/${DUR}\\,ih-1920)'`
    : `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0006,1.12)':d=${DUR * FPS}:s=1080x1920:fps=${FPS}`;
  const vf = `${panFilter},ass=captions.ass,format=yuv420p`;
  sh("ffmpeg", [
    "-y",
    "-loop", "1", "-t", String(DUR), "-i", "page.png",
    "-f", "lavfi", "-t", String(DUR), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-vf", vf,
    "-r", String(FPS),
    "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-shortest",
    "-movflags", "+faststart",
    "out.mp4",
  ]);
}

/* ---- 5. upload to R2 via SigV4 (no SDK) ---- */
function r2Put(objectKey, file, contentType) {
  const host = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
  const body = readFileSync(file);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    `/${R2_BUCKET}/${objectKey}`,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const kDate = hmac("AWS4" + R2_SECRET, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  sh("curl", [
    "-sS", "-f", "-X", "PUT",
    "-H", `Host: ${host}`,
    "-H", `x-amz-date: ${amzDate}`,
    "-H", `x-amz-content-sha256: ${payloadHash}`,
    "-H", `Authorization: ${authorization}`,
    "-H", `Content-Type: ${contentType}`,
    "--data-binary", `@${file}`,
    `https://${host}/${R2_BUCKET}/${objectKey}`,
  ]);
}

/* ---- main ---- */
const dim = SITE_URL ? await captureSite() : null;
let scaledTallEnough = true;
if (!dim) {
  console.log("site capture failed or no SITE_URL; using branded background");
  const fb = fallbackBackground();
  scaledTallEnough = false;
} else {
  // screenshot is 1080-ish wide (deviceScaleFactor folds into pixels); after
  // scaling width to 1080 the height stays proportional. Decide pan vs zoom.
  const { width, height } = (() => {
    const out = sh("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0", "page.png",
    ]).toString().trim();
    const [w, h] = out.split(",").map(Number);
    return { width: w, height: h };
  })();
  const scaledH = Math.round((1080 / width) * height);
  scaledTallEnough = scaledH > 1920 * 1.15; // enough runway to pan
  console.log(`screenshot ${width}x${height} -> scaledH ${scaledH}, pan=${scaledTallEnough}`);
}

buildAss();
renderVideo(scaledTallEnough);
const sizeMB = (statSync("out.mp4").size / 1e6).toFixed(2);
console.log(`rendered out.mp4 (${sizeMB} MB)`);

const objectKey = `staging/${SLUG}.mp4`;
r2Put(objectKey, "out.mp4", "video/mp4");
const publicUrl = `https://pub-6ca6af6a65f941a28d2bfac535c37148.r2.dev/${objectKey}`;
console.log(`uploaded to ${publicUrl}`);

if (!SKIP_CALLBACK && N8N_INGEST_URL) {
  const payload = JSON.stringify({
    slug: SLUG,
    agency: AGENCY,
    fileName: `${AGENCY}.mp4`,
    url: publicUrl,
  });
  sh("curl", [
    "-sS", "-X", "POST",
    "-H", "Content-Type: application/json",
    "--data", payload,
    N8N_INGEST_URL,
  ]);
  console.log("notified n8n ingest webhook");
} else {
  console.log("callback skipped");
}
console.log("DONE");
