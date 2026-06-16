/* IntakeLine audit-video renderer (narrated, multi-scene, offer-focused).
 *
 * Story (your cloned ElevenLabs voice narrates the whole thing):
 *   Scene 1  agency / legal-software site   "Hey {first}. You're {Agency} ..."
 *   Scene 2  client firm site               "I called {firm} after hours ... voicemail ..."
 *   Scene 3  dark brand bg + kinetic cards   the OFFER (trial, ROAS, churn, commission, no white-label)
 *   Scene 4  stays on brand bg               CTA to the page
 * Captions auto-sync to the narration via ElevenLabs character timestamps.
 * Scenes 1-2 caption at the bottom (Hook style); the offer is centered kinetic cards (Offer style).
 *
 * Input (env): SLUG AGENCY CLIENT_FIRM FIRST_NAME SITE_URL AGENCY_URL LEAK_NOTE PAGE_URL
 *   ELEVEN_API_KEY ELEVEN_VOICE_ID  R2_*  N8N_INGEST_URL
 * Output: 1080x1920 MP4 -> R2 staging -> n8n ingest -> Drive "Intro Videos".
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const SLUG = env("SLUG") || "test";
const AGENCY = env("AGENCY") || "your agency";
const CLIENT_FIRM = env("CLIENT_FIRM") || "your client firm";
const FIRST = env("FIRST_NAME") || "there";
const SITE_URL = env("SITE_URL");           // client firm site
const AGENCY_URL = env("AGENCY_URL");        // agency / legal-software site
const LEAK_NOTE =
  env("LEAK_NOTE") || "no one picked up and there was no way to leave case details";
const FPS = 30;

const EL_KEY = env("ELEVEN_API_KEY");
const EL_VOICE = env("ELEVEN_VOICE_ID");
const R2_KEY = env("R2_ACCESS_KEY_ID");
const R2_SECRET = env("R2_SECRET_ACCESS_KEY");
const R2_ACCOUNT = env("R2_ACCOUNT_ID");
const R2_BUCKET = env("R2_BUCKET", "intakeline-media");
const N8N_INGEST_URL = env("N8N_INGEST_URL");
const SKIP_CALLBACK = env("SKIP_CALLBACK") === "1";

const ACCENT = "&H000EE8F9&";   // IntakeLine brand gold (ASS BGR), used to highlight key words
const WHITE = "&H00FFFFFF&";

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
const probeDims = (f) => {
  const out = sh("ffprobe", ["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=p=0", f]).toString().trim();
  const [w, h] = out.split(",").map(Number);
  return { w, h };
};

/* ---------- 1. script ---------- */
const leak = LEAK_NOTE.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
// Scene 1 — agency / legal-software (talks like a person, not a deck)
const beat1 = `Hey ${FIRST}, real quick. So you're ${AGENCY}, you run the marketing for personal injury firms, and honestly, you're good at it. The leads are coming in.`;
// Scene 2 — client firm site, then the after-hours leak
const beat2 = `So I grabbed one of your clients, ${CLIENT_FIRM}, and did something kind of sneaky. I called their office after hours, like I'm someone who just got hurt and needs a lawyer. Nobody picked up. Straight to voicemail. ${leak}. So that person hangs up and calls the next firm on Google. You did everything right to get them to call, and the front desk just lost you the case.`;
// Scene 3 — the offer (kinetic cards), conversational but tight
const beat3 = `So here's what I'd do, and why it's good for you, not just them. I put an A I receptionist on their line. It picks up every call, day or night, runs the intake, and books the consult. For you? Your client tries it free for two weeks. They book more cases, so your marketing looks even better. Happy clients stick around, so you keep them longer. And you get paid every month, for every firm you refer. No white-labeling, no work on your end. You send them to me, I do the rest, you get a check.`;
// Scene 4 — CTA (stays on brand bg)
const beat4 = `I already built a line that answers exactly how their intake should sound. It's on this page, give it a listen. If it's a fit, grab fifteen minutes with me.`;
const SCRIPT = `${beat1} ${beat2} ${beat3} ${beat4}`;
const cut2Idx = beat1.length + 1;
const cut3Idx = beat1.length + 1 + beat2.length + 1; // start of the offer (beat3)

/* ---------- 2. narration (ElevenLabs, your cloned voice, pushed expressive) ---------- */
function narrate() {
  const body = JSON.stringify({
    text: SCRIPT,
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.22, similarity_boost: 0.90, style: 0.45, use_speaker_boost: true },
  });
  writeFileSync("el_body.json", body);
  const raw = sh("curl", [
    "-sS", "-f", "-X", "POST",
    `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/with-timestamps?output_format=mp3_44100_128`,
    "-H", `xi-api-key: ${EL_KEY}`,
    "-H", "Content-Type: application/json",
    "--data", `@el_body.json`,
  ]).toString();
  const d = JSON.parse(raw);
  writeFileSync("narration.mp3", Buffer.from(d.audio_base64, "base64"));
  const al = d.alignment || d.normalized_alignment;
  return {
    chars: al.characters,
    starts: al.character_start_times_seconds,
    ends: al.character_end_times_seconds,
  };
}

/* ---------- 3. captions (.ass): bottom Hook for scenes 1-2, centered kinetic Offer cards after ---------- */
function tc(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}
function buildAss(al, dur, offerStart) {
  // group chars into words
  const words = [];
  let cur = "", ws = null, we = 0;
  for (let i = 0; i < al.chars.length; i++) {
    const c = al.chars[i];
    if (/\s/.test(c)) { if (cur) { words.push({ w: cur, s: ws, e: we }); cur = ""; ws = null; } continue; }
    if (ws === null) ws = al.starts[i];
    we = al.ends[i];
    cur += c;
  }
  if (cur) words.push({ w: cur, s: ws, e: we });
  // words -> short phrases (a phrase becomes one on-screen line/card)
  const phrases = [];
  let p = [], len = 0;
  for (const wd of words) {
    const offer = wd.s >= offerStart - 0.05;
    p.push(wd); len += wd.w.length + 1;
    const endsSentence = /[.!?]$/.test(wd.w);
    const limit = offer ? 16 : 20;
    if (len >= limit || endsSentence) { phrases.push(p); p = []; len = 0; }
  }
  if (p.length) phrases.push(p);

  const esc = (s) => s.replace(/[{}]/g, "").replace(/\\/g, "");
  const firmRe = new RegExp(CLIENT_FIRM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const offerKeys = [/free for two weeks/i, /\bfree\b/i, /more cases/i, /every single month/i, /no white-?labeling/i, /zero risk/i, /get a check/i, /paid/i];

  const dialog = phrases.map((ph) => {
    const s = ph[0].s, e = ph[ph.length - 1].e + 0.06;
    const isOffer = s >= offerStart - 0.05;
    let text = esc(ph.map((x) => x.w).join(" ")).replace(/\bA I\b/g, "AI");
    if (isOffer) {
      for (const re of offerKeys) text = text.replace(re, (m) => `{\\c${ACCENT}}${m}{\\c${WHITE}}`);
      // kinetic typography: fast fade + bouncy scale pop (overshoot then settle), slight rise
      const anim = `{\\fad(60,70)\\fscx56\\fscy56\\t(0,120,\\fscx114\\fscy114)\\t(120,210,\\fscx100\\fscy100)\\move(540,1020,540,960,0,200)}`;
      return `Dialogue: 0,${tc(s)},${tc(e)},Offer,,0,0,0,,${anim}${text}`;
    }
    if (firmRe.test(text)) text = text.replace(firmRe, (m) => `{\\c${ACCENT}}${m}{\\c${WHITE}}`);
    const anim = `{\\fad(50,60)\\fscx82\\fscy82\\t(0,110,\\fscx100\\fscy100)}`;
    return `Dialogue: 0,${tc(s)},${tc(e)},Hook,,0,0,0,,${anim}${text}`;
  }).join("\n");

  const header = `Dialogue: 0,${tc(0)},${tc(dur)},Header,,0,0,0,,PRIVATE INTAKE AUDIT  -  ${esc(AGENCY).toUpperCase()}`;
  const brand = `Dialogue: 0,${tc(0)},${tc(dur)},Brand,,0,0,0,,INTAKELINE`;
  writeFileSync("captions.ass", `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,DejaVu Sans,88,&H00FFFFFF,&H00000000,&HB0000000,1,0,1,7,3,2,80,80,540,1
Style: Offer,DejaVu Sans,104,&H00FFFFFF,&H00000000,&HA0000000,1,0,1,8,4,5,120,120,0,1
Style: Header,DejaVu Sans,40,&H00B4BCD0,&H00000000,&H00000000,1,0,1,4,0,8,60,60,90,1
Style: Brand,DejaVu Sans,44,&H000EE8F9,&H00000000,&H00000000,1,0,1,4,0,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${header}
${brand}
${dialog}
`);
}

/* ---------- 4. site capture ---------- */
async function capture(url, file) {
  if (!url) return false;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1.5,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    for (const re of [/accept/i, /agree/i, /got it/i, /allow all/i]) {
      try { const b = page.getByRole("button", { name: re }).first(); if (await b.isVisible({ timeout: 700 })) await b.click({ timeout: 700 }); } catch {}
    }
    try {
      await page.evaluate(async () => { const h = document.body.scrollHeight; for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 50)); } window.scrollTo(0, 0); });
      await page.waitForTimeout(1000);
    } catch {}
    await page.screenshot({ path: file, fullPage: true });
    await browser.close();
    return true;
  } catch { await browser.close(); return false; }
}
function brandCard(file, w = 1080, h = 1920) {
  // flat dark fallback
  sh("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=0x0A0F1E:s=${w}x${h}`, "-frames:v", "1", file]);
}
// premium dark-navy gradient bg for the offer (gold glow up top, blue glow at the base); slow zoom adds drift
async function brandBg(file) {
  try {
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0;width:1080px;height:1920px;background:#070b16;overflow:hidden;position:relative;">
      <div style="position:absolute;inset:0;background:radial-gradient(120% 78% at 50% 32%, #1b3460 0%, #0d1830 40%, #070b16 74%);"></div>
      <div style="position:absolute;inset:0;background:radial-gradient(55% 26% at 50% 7%, rgba(249,232,14,0.12) 0%, rgba(249,232,14,0) 70%);"></div>
      <div style="position:absolute;inset:0;background:radial-gradient(95% 45% at 50% 102%, rgba(14,60,120,0.45) 0%, rgba(7,11,22,0) 62%);"></div>
      <div style="position:absolute;inset:0;background:repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 3px);"></div>
    </body></html>`, { waitUntil: "load" });
    await page.waitForTimeout(200);
    await page.screenshot({ path: file });
    await browser.close();
  } catch { brandCard(file); }
}

/* ---------- 5. per-scene pan/zoom filter ---------- */
function sceneFilter(idx, dur, file, label, dim) {
  const { w, h } = probeDims(file);
  const scaledH = Math.round((1080 / w) * h);
  const frames = Math.round(dur * FPS);
  // dim + vignette the busy site captures so the captions pop (offer bg stays vivid)
  const d = dim ? "eq=brightness=-0.17:saturation=0.92:contrast=1.04,vignette," : "";
  if (scaledH > 1920 * 1.12) {
    return `[${idx}:v]scale=1080:-1:flags=lanczos,crop=1080:1920:0:'min((ih-1920)*t/${dur.toFixed(2)}\\,ih-1920)',${d}fps=${FPS},format=yuv420p,setsar=1[${label}]`;
  }
  return `[${idx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${d}zoompan=z='min(zoom+0.0006,1.12)':d=${frames}:s=1080x1920:fps=${FPS},format=yuv420p,setsar=1[${label}]`;
}

/* ---------- main ---------- */
const al = narrate();
const dur = (al.ends[al.ends.length - 1] || 25) + 0.6;
let cut2 = al.starts[cut2Idx]; let cut3 = al.starts[cut3Idx];
if (!(cut2 > 1 && cut2 < dur)) cut2 = dur * 0.18;
if (!(cut3 > cut2 && cut3 < dur)) cut3 = dur * 0.42;
console.log(`narration ${dur.toFixed(1)}s  cut2=${cut2.toFixed(1)} cut3=${cut3.toFixed(1)}`);
buildAss(al, dur, cut3);

const okAgency = await capture(AGENCY_URL, "s1.png");
if (!okAgency) brandCard("s1.png");
const okFirm = await capture(SITE_URL, "s2.png");
if (!okFirm) brandCard("s2.png");
await brandBg("s3.png"); // offer scene = premium gradient bg with slow drift
console.log(`captures: agency=${okAgency} firm=${okFirm}`);

const XF = 0.45;
const L1 = cut2 + 0.4, L2 = (cut3 - cut2) + 0.9, L3 = (dur - cut3) + 0.4;
const fc = [
  `-loop`, `1`, `-t`, L1.toFixed(2), `-i`, `s1.png`,
  `-loop`, `1`, `-t`, L2.toFixed(2), `-i`, `s2.png`,
  `-loop`, `1`, `-t`, L3.toFixed(2), `-i`, `s3.png`,
  `-i`, `narration.mp3`,
];
const graph = [
  sceneFilter(0, L1, "s1.png", "a", true),
  sceneFilter(1, L2, "s2.png", "b", true),
  sceneFilter(2, L3, "s3.png", "c", false),
  `[a][b]xfade=transition=fade:duration=${XF}:offset=${(cut2 - XF / 2).toFixed(2)}[ab]`,
  `[ab][c]xfade=transition=fade:duration=${XF}:offset=${(cut3 - XF / 2).toFixed(2)}[abc]`,
  `[abc]ass=captions.ass[v]`,
].join(";");
sh("ffmpeg", [
  "-y", ...fc,
  "-filter_complex", graph,
  "-map", "[v]", "-map", "3:a",
  "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
  "out.mp4",
]);
const sizeMB = (statSync("out.mp4").size / 1e6).toFixed(2);
console.log(`rendered out.mp4 (${sizeMB} MB, ${dur.toFixed(1)}s)`);

/* ---------- 6. R2 upload (SigV4) + n8n callback ---------- */
function r2Put(objectKey, file, contentType) {
  const host = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
  const bodyBuf = readFileSync(file);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(bodyBuf).digest("hex");
  const ch = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const sh_ = "host;x-amz-content-sha256;x-amz-date";
  const creq = ["PUT", `/${R2_BUCKET}/${objectKey}`, "", ch, sh_, payloadHash].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(creq).digest("hex")].join("\n");
  const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
  const kSig = hmac(hmac(hmac(hmac("AWS4" + R2_SECRET, dateStamp), "auto"), "s3"), "aws4_request");
  const sig = createHmac("sha256", kSig).update(sts).digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${scope}, SignedHeaders=${sh_}, Signature=${sig}`;
  sh("curl", ["-sS", "-f", "-X", "PUT",
    "-H", `Host: ${host}`, "-H", `x-amz-date: ${amzDate}`, "-H", `x-amz-content-sha256: ${payloadHash}`,
    "-H", `Authorization: ${auth}`, "-H", `Content-Type: ${contentType}`,
    "--data-binary", `@${file}`, `https://${host}/${R2_BUCKET}/${objectKey}`]);
}
const objectKey = `staging/${SLUG}.mp4`;
r2Put(objectKey, "out.mp4", "video/mp4");
const publicUrl = `https://pub-6ca6af6a65f941a28d2bfac535c37148.r2.dev/${objectKey}`;
console.log(`uploaded ${publicUrl}`);
if (!SKIP_CALLBACK && N8N_INGEST_URL) {
  sh("curl", ["-sS", "-X", "POST", "-H", "Content-Type: application/json",
    "--data", JSON.stringify({ slug: SLUG, agency: AGENCY, fileName: `${AGENCY}.mp4`, url: publicUrl }), N8N_INGEST_URL]);
  console.log("notified n8n ingest");
} else console.log("callback skipped");
console.log("DONE");
