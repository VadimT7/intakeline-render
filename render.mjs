/* IntakeLine cold-outreach video renderer — 16:9, fully automated, no hand editing.
 *
 * Recreates the Palmier "Leaky Bucket" cut as a deterministic ffmpeg pipeline so n8n can mint a
 * personalized video per prospect with zero manual steps. Look: graded landscape site b-roll +
 * bottom scrim + white/gold/red karaoke captions + brand-navy/red motion cards + Jack John VO.
 *
 * Beats (Hormozi grand-slam):
 *   s1    agency homepage b-roll  — call-out + "world-class"
 *   s2a   client firm b-roll      — the 2am stress test
 *   vm    voicemail card          — spliced phone-line greeting
 *   s2b   client firm b-roll      — the $30k cost
 *   logo  IntakeLine card         — the solution
 *   cta   demo/offer card         — 14-day Lead-Lock trial
 *   outro intakeline.com b-roll   — "that A.I. was us, IntakeLine"  (the reveal)
 *   end   URL lock card           — intakeline.com
 *
 * Env: SLUG AGENCY CLIENT_FIRM FIRST_NAME SITE_URL AGENCY_URL LEAK_NOTE
 *      ELEVEN_API_KEY ELEVEN_VOICE_ID  R2_*  N8N_INGEST_URL  [LOCAL_TEST=1 visual dry-run]
 *      [VOICE_ID TTS_MODEL SPEED STYLE STAB NO_VS  — tuning overrides]
 * Output: 1920x1080 MP4 -> R2 staging -> n8n ingest -> Drive.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, statSync, readdirSync, rmSync, existsSync } from "node:fs";

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const SLUG = env("SLUG") || "test";
const AGENCY = env("AGENCY") || "your agency";
const CLIENT_FIRM = env("CLIENT_FIRM") || "your client firm";
const FIRST = env("FIRST_NAME") || "there";
const SITE_URL = env("SITE_URL");
const AGENCY_URL = env("AGENCY_URL");
const INTAKELINE_URL = env("INTAKELINE_URL") || "https://intakeline.com";
const FPS = 30;
const W = 1920, H = 1080;
const LOCAL = env("LOCAL_TEST") === "1";

const EL_KEY = env("ELEVEN_API_KEY");
// Locked voice: Jack John — Conversational and Upbeat (premade). Baked as default so the
// automated path needs no override; ELEVEN_VOICE_ID secret or VOICE_ID env still wins if set.
const EL_VOICE = process.env.VOICE_ID || env("ELEVEN_VOICE_ID") || "7EzWGsX10sAS4c9m9cPf";
const R2_KEY = env("R2_ACCESS_KEY_ID");
const R2_SECRET = env("R2_SECRET_ACCESS_KEY");
const R2_ACCOUNT = env("R2_ACCOUNT_ID");
const R2_BUCKET = env("R2_BUCKET", "intakeline-media");
const N8N_INGEST_URL = env("N8N_INGEST_URL");
const SKIP_CALLBACK = env("SKIP_CALLBACK") === "1";

const GOLD = "&H000EE8F9&";  // brand gold f9e80e (ASS BGR)
const RED = "&H005C5CFF&";   // alert red ff5c5c (ASS BGR)
const WHITE = "&H00FFFFFF&";
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });

/* premium cinematic grade applied to every site recording — matches the Palmier b-roll look */
const GRADE = "eq=contrast=1.12:saturation=1.05:brightness=0.012,vibrance=intensity=0.20,colortemperature=temperature=6700,vignette=angle=PI/4.6,noise=alls=5:allf=t+u";

/* ---------- personalization: lift one real line from the agency's own site ---------- */
function siteTagline(url) {
  if (!url) return "";
  try {
    const html = sh("curl", ["-sSL", "-m", "12", "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", url]).toString();
    const grab = (re) => { const m = html.match(re); return m ? m[1] : ""; };
    const clean = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&").replace(/&#0?39;|&rsquo;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    const firstClause = (s) => { let c = clean(s).split(/\s[|·•–—]\s|\s-\s/)[0].trim(); const d = c.search(/[.!?]\s/); if (d > 12) c = c.slice(0, d + 1); return c.trim(); };
    const cands = [
      grab(/<h1[^>]*>([\s\S]*?)<\/h1>/i),
      grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i),
      grab(/<title[^>]*>([\s\S]*?)<\/title>/i),
      grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i),
      grab(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
    ].map(firstClause).filter(Boolean);
    const junk = /\b(error|403|404|forbidden|not found|access denied|just a moment|attention required|enable javascript|are you a robot|cloudflare|page not found|untitled|home ?page)\b/i;
    for (const c of cands) if (c.length >= 12 && c.length <= 70 && !junk.test(c)) return c;
    return "";
  } catch { return ""; }
}
const TAGLINE = siteTagline(AGENCY_URL);
console.log("site tagline:", TAGLINE || "(none - generic hook)");

const ICON_PLAY = '<svg width="120" height="120" viewBox="0 0 24 24" fill="#f9e80e"><path d="M8 5v14l11-7z"/></svg>';
const PHONE_RED = '<svg width="120" height="120" viewBox="0 0 24 24" fill="#ff5a6e"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>';

/* ---------- 1. script broken into timed beats ---------- */
const SEG = [
  { key: "s1", type: "site", url: AGENCY_URL,
    text: TAGLINE
      ? `Okay ${AGENCY}, real quick, I was just on your site, "${TAGLINE}", love it, and the lead-gen you're running for ${CLIENT_FIRM} is honestly world-class.`
      : `Okay ${AGENCY}, real quick, I was just on your site and the lead-gen you're running for ${CLIENT_FIRM} is honestly world-class.` },
  { key: "s2a", type: "site", url: SITE_URL,
    text: `But your traffic is so good I had to test where it lands, so I called ${CLIENT_FIRM} at two A.M. like a real injured lead, and listen to this.` },
  { key: "vm", type: "vm" },
  { key: "s2b", type: "site", url: SITE_URL,
    text: `So just like that a thirty thousand dollar case walks out the door, because a message taker picked up instead of a real lawyer, and that is the leak nobody tells you about.` },
  { key: "logo", type: "logo",
    text: `So here is what I built you, an A.I. agent that plugs that leak instantly, it answers on the first ring, books the lead, and doubles your return on ad spend, totally hands off.` },
  { key: "cta", type: "demo",
    text: `So here is my offer, give me fourteen days with ${CLIENT_FIRM} on a free Lead Lock trial, I do all the work, you take the credit and the commission, so honestly, are you gonna say no to a quick fifteen minute hand off?` },
  // the reveal: show our own site so they know who is actually reaching out
  { key: "outro", type: "site", url: INTAKELINE_URL,
    text: `Oh, and that A.I. that just answered your call, that was us, IntakeLine.` },
  { key: "end", type: "end",
    text: `So go see it live for yourself, at intakeline dot com.` },
];
const SCRIPT = SEG.filter((s) => s.text).map((s) => s.text).join(" ");
let off = 0; for (const s of SEG) { if (!s.text) continue; s.charStart = off; off += s.text.length + 1; }

/* ---------- 2. narration (ElevenLabs, with-timestamps for caption sync) ---------- */
function narrate() {
  try {
    const vn = JSON.parse(sh("curl", ["-sS", "-f", `https://api.elevenlabs.io/v1/voices/${EL_VOICE}`, "-H", `xi-api-key: ${EL_KEY}`]).toString());
    console.log("NARRATION VOICE ->", EL_VOICE, "=", vn.name, "[" + vn.category + "]");
  } catch { console.log("NARRATION VOICE id:", EL_VOICE); }
  const SPEED = process.env.SPEED ? parseFloat(process.env.SPEED) : 1.13;
  const STYLE = process.env.STYLE ? parseFloat(process.env.STYLE) : 0.5;
  const STAB = process.env.STAB ? parseFloat(process.env.STAB) : 0.35;
  const vs = { stability: STAB, similarity_boost: 0.8, style: STYLE, use_speaker_boost: true, speed: SPEED };
  console.log("NARRATION SETTINGS:", JSON.stringify(vs));
  const tts = (model, settings) => {
    const payload = { text: SCRIPT, model_id: model };
    if (settings) payload.voice_settings = settings;
    writeFileSync("el_body.json", JSON.stringify(payload));
    for (const fmt of ["mp3_44100_192", "mp3_44100_128"]) {
      try {
        const raw = sh("curl", ["-sS", "-f", "-X", "POST",
          `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/with-timestamps?output_format=${fmt}`,
          "-H", `xi-api-key: ${EL_KEY}`, "-H", "Content-Type: application/json", "--data", "@el_body.json"]).toString();
        const d = JSON.parse(raw);
        const al = d.alignment || d.normalized_alignment;
        if (!al || !al.characters || !d.audio_base64) throw new Error("no alignment/audio");
        console.log("EL SOURCE FORMAT:", fmt);
        return d;
      } catch (e) { console.log("format " + fmt + " failed (" + String(e.message).slice(0, 50) + ")"); }
    }
    throw new Error("all source formats failed for " + model);
  };
  // Jack John is a turbo_v2_5 voice (natural + fast); fall back to multilingual_v2 if turbo rejects.
  const MODEL = process.env.TTS_MODEL || "eleven_turbo_v2_5";
  const settings = process.env.NO_VS === "1" ? null : vs;
  let d;
  try { d = tts(MODEL, settings); console.log("NARRATION MODEL:", MODEL); }
  catch (e) { console.log("model " + MODEL + " failed (" + String(e.message).slice(0, 80) + "); fallback multilingual_v2"); d = tts("eleven_multilingual_v2", vs); console.log("NARRATION MODEL: eleven_multilingual_v2"); }
  writeFileSync("narration.mp3", Buffer.from(d.audio_base64, "base64"));
  const al = d.alignment || d.normalized_alignment;
  return { chars: al.characters, starts: al.character_start_times_seconds, ends: al.character_end_times_seconds };
}

/* ---------- 3. captions (.ass): bottom, phrase-timed, white + gold/red keyword highlight ---------- */
function tc(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}
function buildAss(al, dur) {
  const words = [];
  let cur = "", ws = null, we = 0;
  for (let i = 0; i < al.chars.length; i++) {
    const c = al.chars[i];
    if (/\s/.test(c)) { if (cur) { words.push({ w: cur, s: ws, e: we }); cur = ""; ws = null; } continue; }
    if (ws === null) ws = al.starts[i];
    we = al.ends[i]; cur += c;
  }
  if (cur) words.push({ w: cur, s: ws, e: we });
  const phrases = [];
  let p = [], len = 0;
  for (const wd of words) {
    p.push(wd); len += wd.w.length + 1;
    if (len >= 30 || /[.!?,]$/.test(wd.w)) { phrases.push(p); p = []; len = 0; }
  }
  if (p.length) phrases.push(p);
  const esc = (s) => s.replace(/[{}]/g, "").replace(/\\/g, "");
  const cf = CLIENT_FIRM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const goldKeys = [/world-class/i, /first ring/i, /\bdoubles?\b/i, /return on ad spend/i, /Lead Lock/i, /fifteen[ -]minute/i, /\bcommission\b/i, /\bcredit\b/i, /IntakeLine/i, /intakeline dot com/i, new RegExp(cf, "i")];
  const redKeys = [/thirty thousand dollar/i, /walks out the door/i, /the leak/i];
  const dialog = phrases.map((ph) => {
    const s = ph[0].s, e = ph[ph.length - 1].e + 0.06;
    let text = esc(ph.map((x) => x.w).join(" ")).replace(/\bA I\b/g, "AI").replace(/\bA M\b/g, "AM");
    for (const re of redKeys) text = text.replace(re, (m) => `{\\c${RED}}${m}{\\c${WHITE}}`);
    for (const re of goldKeys) text = text.replace(re, (m) => /\\c&/.test(m) ? m : `{\\c${GOLD}}${m}{\\c${WHITE}}`);
    return `Dialogue: 0,${tc(s)},${tc(e)},Cap,,0,0,0,,{\\fad(40,50)\\fscx80\\fscy80\\t(0,130,\\fscx100\\fscy100)}${text}`;
  }).join("\n");
  writeFileSync("captions.ass", `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,72,&H00FFFFFF,&H00000000,&H90000000,1,0,1,5,3,2,260,260,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialog}
`);
}

/* ---------- bottom scrim so captions read over bright site recordings ---------- */
async function makeScrim(file) {
  try {
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
    await page.setContent(`<body style="margin:0;width:${W}px;height:${H}px"><div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(7,11,22,.93) 0%,rgba(7,11,22,.74) 17%,rgba(7,11,22,0) 42%)"></div></body>`, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: file, omitBackground: true });
    await browser.close(); return true;
  } catch { return false; }
}

/* ---------- 4. real site recording: landscape, eased scroll, cinematic grade + scrim ---------- */
async function recordSite(url, secs, outMp4) {
  if (!url) return false;
  const dir = `rec_${Math.random().toString(36).slice(2)}`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: 1,
      recordVideo: { dir, size: { width: W, height: H } },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // bot-walls (Cloudflare 403/429/503, "Just a moment") render as a real page — Playwright won't throw.
    // Detect them and bail so we fall back to a branded card instead of burning an error page into the video.
    const status = resp ? resp.status() : 0;
    const title = (await page.title().catch(() => "")) || "";
    if (status >= 400 || /just a moment|attention required|forbidden|access denied|are you a robot/i.test(title)) {
      console.log("site", url, "blocked (status", status, "title:", title.slice(0, 40) + ")");
      await ctx.close(); await browser.close(); rmSync(dir, { recursive: true, force: true }); return false;
    }
    await page.waitForTimeout(1700);
    for (const re of [/accept/i, /agree/i, /got it/i, /allow all/i, /reject/i, /^ok$/i]) {
      try { const b = page.getByRole("button", { name: re }).first(); if (await b.isVisible({ timeout: 600 })) await b.click({ timeout: 600 }); } catch {}
    }
    await page.waitForTimeout(500);
    await page.evaluate(async (ms) => {
      const max = Math.min(2600, Math.max(0, document.body.scrollHeight - window.innerHeight));
      const t0 = performance.now();
      await new Promise((res) => {
        function step(t) {
          const k = Math.min(1, (t - t0) / ms);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
          window.scrollTo(0, e * max);
          if (k < 1) requestAnimationFrame(step); else res();
        }
        requestAnimationFrame(step);
      });
    }, Math.max(2600, secs * 1000));
    await page.waitForTimeout(300);
    await ctx.close();
    await browser.close();
    const webm = readdirSync(dir).find((f) => f.endsWith(".webm"));
    if (!webm) return false;
    const args = existsSync("scrim.png")
      ? ["-y", "-sseof", `-${(secs + 0.15).toFixed(2)}`, "-i", `${dir}/${webm}`, "-i", "scrim.png", "-filter_complex",
         `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},${GRADE},format=yuv420p[v0];[v0][1:v]overlay=0:0,setsar=1[v]`,
         "-map", "[v]", "-t", secs.toFixed(2), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", outMp4]
      : ["-y", "-sseof", `-${(secs + 0.15).toFixed(2)}`, "-i", `${dir}/${webm}`, "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},${GRADE},format=yuv420p,setsar=1`, "-t", secs.toFixed(2), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", outMp4];
    sh("ffmpeg", args);
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) { try { await browser?.close(); } catch {} console.log("record fail", url, String(e.message).slice(0, 100)); return false; }
}

/* ---------- 5. designed cards -> clip (zoom-punch entrance) ---------- */
const CARD_HEAD = `<!doctype html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@800;900&family=Inter:wght@400;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;overflow:hidden;background:#070b16;position:relative;font-family:Inter,Arial,sans-serif}
.grid{position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 4px)}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 200px;text-align:center}
</style></head><body>`;
async function htmlClip(html, secs, outMp4) {
  const png = `h_${Math.random().toString(36).slice(2)}.png`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
    await page.setContent(html, { waitUntil: "load" });
    try { await page.evaluate(() => document.fonts.ready); } catch {}
    await page.waitForTimeout(450);
    await page.screenshot({ path: png });
    await browser.close();
  } catch (e) { try { await browser?.close(); } catch {}; sh("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=0x070b16:s=${W}x${H}`, "-frames:v", "1", png]); }
  const frames = Math.round(secs * FPS);
  const pf = Math.max(4, Math.round(0.22 * FPS));
  const driftInc = (0.05 / Math.max(1, frames - pf)).toFixed(6);
  const z = `if(lt(on,${pf}),1.0+0.09*on/${pf},min(1.09+${driftInc}*(on-${pf}),1.14))`;
  sh("ffmpeg", ["-y", "-i", png, "-vf", `scale=${Math.round(W * 1.2)}:${Math.round(H * 1.2)},zoompan=z='${z}':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p,setsar=1`, "-frames:v", String(frames), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", outMp4]);
  rmSync(png, { force: true });
}

function voicemailHtml() {
  const bars = [40, 86, 58, 110, 48, 96, 66, 120, 52, 84, 64, 100, 56, 92].map((h) => `<i style="height:${h}px"></i>`).join("");
  return `${CARD_HEAD}
<div class=grid style="background:radial-gradient(120% 90% at 50% 42%,#3a1422 0%,#1a0a13 48%,#070b16 82%)"></div>
<div style="position:absolute;top:80px;left:96px;display:flex;align-items:center;gap:16px;background:rgba(255,40,40,.16);border:3px solid #ff3b3b;border-radius:999px;padding:14px 30px 14px 24px;box-shadow:0 0 40px rgba(255,40,40,.35)">
<span style="width:24px;height:24px;border-radius:50%;background:#ff3b3b;box-shadow:0 0 24px #ff3b3b"></span>
<span style="font-family:Montserrat;font-weight:900;font-size:40px;letter-spacing:5px;color:#fff">LIVE</span></div>
<div style="position:absolute;top:88px;right:96px;font-family:Montserrat;font-weight:800;font-size:38px;letter-spacing:4px;color:#ff8a97">REC 0:03 · 2:00 AM</div>
<div class=wrap>
<div style="filter:drop-shadow(0 10px 34px rgba(255,90,110,.35));margin-bottom:18px">${PHONE_RED}</div>
<div style="font-family:Montserrat;font-weight:900;font-size:118px;letter-spacing:12px;color:#fff;line-height:1">VOICEMAIL</div>
<div style="display:flex;gap:12px;align-items:center;height:120px;margin:40px 0">${bars}</div>
<div style="font-family:Inter;font-weight:700;font-size:54px;color:#ff8a97">"...please call back tomorrow."</div>
<div style="font-family:Inter;font-weight:600;font-size:42px;color:#9fb0c8;margin-top:22px">A $30,000 case, hanging up.</div>
</div>
<style>.wrap i{width:16px;background:linear-gradient(#ff5a6e,#ff8a97);border-radius:8px;display:inline-block}</style>
</body></html>`;
}
function logoHtml() {
  return `${CARD_HEAD}
<div class=grid style="background:radial-gradient(120% 90% at 50% 38%,#1b3460 0%,#0d1830 46%,#070b16 80%)"></div>
<div style="position:absolute;inset:0;background:radial-gradient(46% 30% at 50% 42%,rgba(249,232,14,.14),rgba(249,232,14,0) 70%)"></div>
<div class=wrap>
<svg width="560" height="130" viewBox="0 0 600 150" style="margin-bottom:26px"><path d="M0 75 H150 L182 75 L205 26 L232 124 L258 75 L300 75 L330 40 L360 110 L388 75 H600" fill="none" stroke="#f9e80e" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/></svg>
<div style="font-family:Montserrat;font-weight:900;font-size:160px;letter-spacing:-4px;color:#fff;line-height:1">INTAKE<span style="color:#f9e80e">LINE</span></div>
<div style="font-family:Inter;font-weight:600;font-size:52px;color:#a9bad2;margin-top:30px">Answers on the first ring. Books the case. 24/7.</div>
</div></body></html>`;
}
function demoHtml() {
  return `${CARD_HEAD}
<div class=grid style="background:radial-gradient(120% 90% at 50% 38%,#152a4d 0%,#0b1426 48%,#070b16 82%)"></div>
<div class=wrap>
<div style="font-family:Montserrat;font-weight:900;font-size:42px;letter-spacing:8px;color:#f9e80e;text-transform:uppercase;margin-bottom:30px">The Offer</div>
<div style="font-family:Montserrat;font-weight:900;font-size:122px;letter-spacing:-3px;color:#fff;line-height:1.02">14-DAY <span style="color:#f9e80e">LEAD-LOCK</span><br>TRIAL</div>
<div style="font-family:Inter;font-weight:600;font-size:50px;color:#a9bad2;margin-top:34px">I do all the work. You take the credit and the commission.</div>
<div style="display:flex;align-items:center;gap:18px;margin-top:48px;background:#0e1626;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:22px 40px">
<span style="width:16px;height:16px;border-radius:50%;background:#28c840;box-shadow:0 0 18px #28c840"></span>
<span style="font-family:Inter;font-weight:700;font-size:44px;color:#fff">intakeline.com/demo</span>
<span style="font-family:Inter;font-weight:600;font-size:40px;color:#7d8ca6">— for ${CLIENT_FIRM}</span>
</div></div></body></html>`;
}
function endHtml() {
  return `${CARD_HEAD}
<div class=grid style="background:radial-gradient(120% 90% at 50% 40%,#1b3460 0%,#0d1830 46%,#070b16 80%)"></div>
<div style="position:absolute;inset:0;background:radial-gradient(50% 32% at 50% 46%,rgba(249,232,14,.16),rgba(249,232,14,0) 70%)"></div>
<div class=wrap>
<svg width="520" height="120" viewBox="0 0 600 150" style="margin-bottom:24px"><path d="M0 75 H150 L182 75 L205 26 L232 124 L258 75 L300 75 L330 40 L360 110 L388 75 H600" fill="none" stroke="#f9e80e" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/></svg>
<div style="font-family:Montserrat;font-weight:900;font-size:150px;letter-spacing:-4px;color:#fff;line-height:1">INTAKE<span style="color:#f9e80e">LINE</span></div>
<div style="margin-top:40px;font-family:Montserrat;font-weight:800;font-size:64px;letter-spacing:2px;color:#f9e80e;background:rgba(249,232,14,.10);border:2px solid rgba(249,232,14,.4);border-radius:16px;padding:20px 56px">intakeline.com</div>
<div style="font-family:Inter;font-weight:600;font-size:46px;color:#a9bad2;margin-top:38px">24/7 AI intake for injury firms.</div>
</div></body></html>`;
}

// branded nameplate shown when a prospect's site blocks the crawler — keeps the personalization beat on-brand
function siteCardHtml(name, kicker) {
  return `${CARD_HEAD}
<div class=grid style="background:radial-gradient(120% 90% at 50% 38%,#16294a 0%,#0b1426 48%,#070b16 82%)"></div>
<div class=wrap>
<div style="font-family:Montserrat;font-weight:800;font-size:40px;letter-spacing:7px;color:#7d8ca6;text-transform:uppercase;margin-bottom:34px">${kicker}</div>
<div style="font-family:Montserrat;font-weight:900;font-size:120px;letter-spacing:-3px;color:#fff;line-height:1.04;text-shadow:0 6px 40px rgba(0,0,0,.5)">${name}</div>
<div style="display:flex;align-items:center;gap:16px;margin-top:48px;background:#0e1626;border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:18px 38px">
<span style="width:14px;height:14px;border-radius:50%;background:#28c840;box-shadow:0 0 16px #28c840"></span>
<span style="font-family:Inter;font-weight:600;font-size:42px;color:#a9bad2">live on the line</span></div>
</div></body></html>`;
}

/* ---------- voicemail: synth a phone-filtered greeting (stock voice) + splice into narration ---------- */
function spliceVoicemail(splitT) {
  const VM_VOICE = "21m00Tcm4TlvDq8ikWAM"; // EL stock "Rachel" — a generic office voice, NOT our narrator
  const vmText = "Hi, you've reached our office. We're not available right now. Please call back tomorrow.";
  try {
    writeFileSync("vm_body.json", JSON.stringify({ text: vmText, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.6, similarity_boost: 0.7, style: 0, use_speaker_boost: false, speed: 1.05 } }));
    const raw = sh("curl", ["-sS", "-f", "-X", "POST", `https://api.elevenlabs.io/v1/text-to-speech/${VM_VOICE}?output_format=mp3_44100_128`, "-H", `xi-api-key: ${EL_KEY}`, "-H", "Content-Type: application/json", "--data", "@vm_body.json"]);
    writeFileSync("vm_raw.mp3", raw);
    sh("ffmpeg", ["-y", "-i", "vm_raw.mp3", "-af", "highpass=f=320,lowpass=f=3200,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,volume=2.0,afade=t=in:st=0:d=0.04,afade=t=out:st=2.78:d=0.22", "-t", "3.0", "-ar", "44100", "-ac", "2", "vm.mp3"]);
    const vmDur = parseFloat(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "vm.mp3"]).toString().trim()) || 3.0;
    sh("ffmpeg", ["-y", "-i", "narration.mp3", "-i", "vm.mp3", "-filter_complex",
      `[0]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${splitT.toFixed(3)},asetpts=N/SR/TB[a];[0]aformat=sample_rates=44100:channel_layouts=stereo,atrim=${splitT.toFixed(3)},asetpts=N/SR/TB[b];[1]aformat=sample_rates=44100:channel_layouts=stereo[v];[a][v][b]concat=n=3:v=0:a=1[o]`,
      "-map", "[o]", "narration_spliced.mp3"]);
    sh("ffmpeg", ["-y", "-i", "narration_spliced.mp3", "-c", "copy", "narration.mp3"]);
    console.log("voicemail spliced at", splitT.toFixed(2), "s, vmDur", vmDur.toFixed(2));
    return vmDur;
  } catch (e) { console.log("voicemail splice FAILED:", String(e.message).slice(0, 140)); return 0; }
}

/* ---------- main ---------- */
let al, dur;
if (LOCAL) {
  for (const s of SEG) s.dur = s.type === "site" ? 5.0 : 3.0;
  dur = SEG.reduce((a, s) => a + s.dur, 0);
  sh("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", dur.toFixed(2), "-q:a", "9", "narration.mp3"]);
} else {
  al = narrate();
  const vmSeg = SEG.find((s) => s.type === "vm");
  let splitT = 0, vmDur = 0;
  if (vmSeg) {
    const s2bIdx = SEG.findIndex((s) => s.key === "s2b");
    const splitChar = SEG[s2bIdx].charStart;
    splitT = al.starts[splitChar] || (al.ends[Math.max(0, splitChar - 1)] || 0);
    vmDur = spliceVoicemail(splitT);
    for (let i = splitChar; i < al.starts.length; i++) { al.starts[i] += vmDur; al.ends[i] += vmDur; }
  }
  dur = (al.ends[al.ends.length - 1] || 30) + 0.6;
  let prev = 0;
  for (let i = 0; i < SEG.length; i++) {
    let t;
    if (SEG[i].type === "vm") t = splitT;
    else { t = al.starts[SEG[i].charStart]; if (!(t > prev) || !(t < dur)) t = prev + 0.4; }
    SEG[i].start = t; prev = t;
  }
  for (let i = 0; i < SEG.length; i++) SEG[i].dur = Math.max(1.0, (i < SEG.length - 1 ? SEG[i + 1].start : dur) - SEG[i].start);
  buildAss(al, dur);
}
console.log("durations:", SEG.map((s) => `${s.key}:${s.dur.toFixed(1)}`).join(" "), "total", dur.toFixed(1));

await makeScrim("scrim.png");
const XF = 0.18; // whip-cut transition; scenes get a +XF tail so the xfade overlap keeps sync
const scenes = [];
for (let i = 0; i < SEG.length; i++) {
  const s = SEG[i]; const f = `scene${i}.mp4`; const sd = s.dur + XF;
  if (s.type === "site") {
    const ok = await recordSite(s.url, sd, f);
    if (!ok) {
      console.log(`site ${s.key} record failed -> card fallback`);
      const fb = s.key === "outro" ? endHtml() : s.key === "s1" ? siteCardHtml(AGENCY, "Their lead engine") : siteCardHtml(CLIENT_FIRM, "The firm I called");
      await htmlClip(fb, sd, f);
    }
    else console.log(`recorded ${s.key} (${s.url})`);
  } else if (s.type === "vm") { await htmlClip(voicemailHtml(), sd, f); console.log("voicemail card"); }
  else if (s.type === "logo") { await htmlClip(logoHtml(), sd, f); console.log("logo card"); }
  else if (s.type === "demo") { await htmlClip(demoHtml(), sd, f); console.log("demo card"); }
  else if (s.type === "end") { await htmlClip(endHtml(), sd, f); console.log("end card"); }
  scenes.push(f);
}

// assemble with whip-cut (xfade slide) transitions; hard-cut concat fallback so a render never fails
let assembled = false;
if (scenes.length >= 2) {
  try {
    const pre = []; let acc = 0; for (let i = 0; i < SEG.length; i++) { pre.push(acc); acc += SEG[i].dur; }
    const inputs = []; for (const fl of scenes) inputs.push("-i", fl);
    let fc = "", last = "0:v";
    for (let m = 1; m < scenes.length; m++) {
      const out = `x${m}`;
      const trans = (m % 2 === 1) ? "slideleft" : "slideright";
      fc += `[${last}][${m}:v]xfade=transition=${trans}:duration=${XF}:offset=${pre[m].toFixed(3)}[${out}];`;
      last = out;
    }
    fc += `[${last}]fade=t=in:st=0:d=0.3[vout]`;
    sh("ffmpeg", ["-y", ...inputs, "-filter_complex", fc, "-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "body.mp4"]);
    assembled = true; console.log("assembled with whip-cut transitions");
  } catch (e) { console.log("whip-cut xfade failed -> hard-cut concat:", String(e.message).slice(0, 100)); }
}
if (!assembled) {
  writeFileSync("list.txt", scenes.map((f) => `file '${f}'`).join("\n"));
  sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "body.mp4"]);
}

// burn captions (skip locally — no libass) then mux narration
const haveCaps = !LOCAL && existsSync("captions.ass");
if (haveCaps) {
  sh("ffmpeg", ["-y", "-i", "body.mp4", "-vf", "ass=captions.ass", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "capped.mp4"]);
} else {
  sh("ffmpeg", ["-y", "-i", "body.mp4", "-c", "copy", "capped.mp4"]);
}
sh("ffmpeg", ["-y", "-i", "capped.mp4", "-i", "narration.mp3", "-map", "0:v", "-map", "1:a",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "44100", "-shortest", "-movflags", "+faststart", "out.mp4"]);
const sizeMB = (statSync("out.mp4").size / 1e6).toFixed(2);
console.log(`rendered out.mp4 (${sizeMB} MB, ${dur.toFixed(1)}s)`);
// proof sheet: 8 evenly-spaced landscape frames tiled, base64 to the log to eyeball the cut
try {
  const d2 = parseFloat(sh("ffprobe", ["-v", "0", "-show_entries", "format=duration", "-of", "csv=p=0", "out.mp4"]).toString().trim()) || dur;
  const rate = (7.999 / d2).toFixed(4);
  sh("ffmpeg", ["-y", "-i", "out.mp4", "-vf", `fps=${rate},scale=320:180,tile=4x2`, "-frames:v", "1", "sheet.jpg"]);
  console.log("SHEET_B64_START");
  console.log(readFileSync("sheet.jpg").toString("base64"));
  console.log("SHEET_B64_END");
} catch (e) { console.log("sheet fail:", e.message); }

if (LOCAL) { console.log("LOCAL dry-run done (no captions, no upload)"); process.exit(0); }

/* ---------- R2 upload (SigV4) + n8n callback ---------- */
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
  sh("curl", ["-sS", "-f", "-X", "PUT", "-H", `Host: ${host}`, "-H", `x-amz-date: ${amzDate}`,
    "-H", `x-amz-content-sha256: ${payloadHash}`, "-H", `Authorization: ${auth}`, "-H", `Content-Type: ${contentType}`,
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
