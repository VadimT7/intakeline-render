/* IntakeLine audit-video renderer — real screen recordings + designed offer slides.
 *
 * Scenes (your cloned ElevenLabs voice narrates over everything, captions pinned bottom):
 *   s1   REAL smooth screen-recording of the agency / legal-software site
 *   s2   REAL smooth screen-recording of the client firm's site (the after-hours leak story)
 *   fix  designed slide: the 24/7 AI receptionist
 *   01-05 designed numbered offer slides (free trial, more cases/ROAS, churn, commission, no white-label)
 *   cta  designed slide: hear it live + book 15 min
 * Each scene is rendered to its own clip, then concatenated, captions burned, narration muxed.
 *
 * Env: SLUG AGENCY CLIENT_FIRM FIRST_NAME SITE_URL AGENCY_URL LEAK_NOTE PAGE_URL
 *      ELEVEN_API_KEY ELEVEN_VOICE_ID  R2_*  N8N_INGEST_URL  [LOCAL_TEST=1 for local visual dry-run]
 * Output: 1080x1920 MP4 -> R2 staging -> n8n ingest -> Drive "Intro Videos".
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
const LEAK_NOTE = env("LEAK_NOTE") || "no one even picked up, and there was no way to leave any details";
const FPS = 30;
const LOCAL = env("LOCAL_TEST") === "1";

const EL_KEY = env("ELEVEN_API_KEY");
const EL_VOICE = env("ELEVEN_VOICE_ID");
const R2_KEY = env("R2_ACCESS_KEY_ID");
const R2_SECRET = env("R2_SECRET_ACCESS_KEY");
const R2_ACCOUNT = env("R2_ACCOUNT_ID");
const R2_BUCKET = env("R2_BUCKET", "intakeline-media");
const N8N_INGEST_URL = env("N8N_INGEST_URL");
const SKIP_CALLBACK = env("SKIP_CALLBACK") === "1";

const ACCENT = "&H000EE8F9&"; // brand gold (ASS BGR)
const WHITE = "&H00FFFFFF&";
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });

/* ---------- 1. script broken into timed segments ---------- */
const leak = LEAK_NOTE.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
// Personalization: pull one real line from the agency's OWN site so the hook references them specifically. Graceful fallback.
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
const SEG = [
  { key: "s1", type: "site", url: AGENCY_URL,
    text: TAGLINE
      ? `${AGENCY} - hold up. I was just on your site: "${TAGLINE}". But watch what happens to one of those hard-won calls.`
      : `${AGENCY} - hold up. You get injury firms the calls. But watch what happens to one of those hard-won calls.` },
  { key: "s2", type: "site", url: SITE_URL,
    text: `I called ${CLIENT_FIRM} after hours, posing as an injured lead. Voicemail. ${leak}. That case walked straight to a competitor.` },
  { key: "fix", type: "slide", slide: { n: "", icon: "📞", title: "A 24/7 AI receptionist", sub: "" },
    text: `The fix? A twenty-four-seven A.I. receptionist. It answers every call, runs intake, and books the consult.` },
  { key: "o1", type: "slide", slide: { n: "", icon: "💸", title: "Free. And you get paid.", sub: "" },
    text: `It's free for two weeks, I build all of it, and you earn a commission every month - just for the intro.` },
  { key: "cta", type: "slide", slide: { n: "", icon: "▶", title: "Hear it live", sub: "" },
    text: `A live demo's on this page answering as ${CLIENT_FIRM}. Hear it - then grab fifteen minutes.` },
];
const SCRIPT = SEG.map((s) => s.text).join(" ");
let off = 0; for (const s of SEG) { s.charStart = off; off += s.text.length + 1; }

/* ---------- 2. narration (ElevenLabs, cloned voice) ---------- */
function narrate() {
  // log the voice's OWN saved settings (what you hear in the ElevenLabs UI) for reference
  try {
    const s = sh("curl", ["-sS", "-f", `https://api.elevenlabs.io/v1/voices/${EL_VOICE}/settings`, "-H", `xi-api-key: ${EL_KEY}`]).toString();
    console.log("native voice settings:", s);
  } catch { console.log("voice settings fetch failed"); }
  // Human tune. multilingual_v2 honors these directly; eleven_v3 (tried first) is the most human/natural model.
  // Kept ZZ Human 2's base (pace + stability); only STYLE raised 0.2 -> 0.5 to widen the tonal up/down (less monotone).
  const vs = { stability: 0.45, similarity_boost: 0.85, style: 0.5, use_speaker_boost: true, speed: 0.95 };
  const tts = (model, settings) => {
    const payload = { text: SCRIPT, model_id: model };
    if (settings) payload.voice_settings = settings;
    writeFileSync("el_body.json", JSON.stringify(payload));
    // Highest source fidelity the tier allows -> cleaner SAME voice (no tonal change); falls back to 128k.
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
  // v2 is the known-good base (the take you preferred). v3 is opt-in via TRY_V3=1 for separate experiments.
  let d;
  if (process.env.TRY_V3 === "1") {
    try { d = tts("eleven_v3", vs); console.log("NARRATION MODEL: eleven_v3 (most human)"); }
    catch (e1) {
      try { d = tts("eleven_v3", null); console.log("NARRATION MODEL: eleven_v3 (defaults)"); }
      catch (e2) { console.log("eleven_v3 unavailable (" + String(e2.message).slice(0, 80) + "); using v2"); d = tts("eleven_multilingual_v2", vs); console.log("NARRATION MODEL: eleven_multilingual_v2"); }
    }
  } else {
    d = tts("eleven_multilingual_v2", vs); console.log("NARRATION MODEL: eleven_multilingual_v2");
  }
  writeFileSync("narration.mp3", Buffer.from(d.audio_base64, "base64"));
  const al = d.alignment || d.normalized_alignment;
  return { chars: al.characters, starts: al.character_start_times_seconds, ends: al.character_end_times_seconds };
}

/* ---------- 3. captions (.ass): pinned bottom, phrase-timed, keyword highlight, subtle pop ---------- */
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
    if (len >= 24 || /[.!?,]$/.test(wd.w)) { phrases.push(p); p = []; len = 0; }
  }
  if (p.length) phrases.push(p);
  const esc = (s) => s.replace(/[{}]/g, "").replace(/\\/g, "");
  const keys = [/voicemail/i, /competitor/i, /\bfree\b/i, /two weeks/i, /every call/i, /commission/i, /every month/i, /fifteen minutes/i, new RegExp(CLIENT_FIRM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")];
  const dialog = phrases.map((ph) => {
    const s = ph[0].s, e = ph[ph.length - 1].e + 0.06;
    let text = esc(ph.map((x) => x.w).join(" ")).replace(/\bA I\b/g, "AI");
    for (const re of keys) text = text.replace(re, (m) => `{\\c${ACCENT}}${m}{\\c${WHITE}}`);
    return `Dialogue: 0,${tc(s)},${tc(e)},Cap,,0,0,0,,{\\fad(40,50)\\fscx72\\fscy72\\t(0,140,\\fscx100\\fscy100)}${text}`;
  }).join("\n");
  const brand = `Dialogue: 0,${tc(0)},${tc(dur)},Brand,,0,0,0,,INTAKELINE`;
  writeFileSync("captions.ass", `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,90,&H00FFFFFF,&H00000000,&H90000000,1,0,1,6,4,2,80,80,220,1
Style: Brand,DejaVu Sans,40,&H000EE8F9,&H00000000,&H00000000,1,0,1,3,0,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${brand}
${dialog}
`);
}

/* ---------- bottom scrim so captions read over bright site recordings ---------- */
async function makeScrim(file) {
  try {
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await (await browser.newContext({ viewport: { width: 1080, height: 1920 } })).newPage();
    await page.setContent(`<body style="margin:0;width:1080px;height:1920px"><div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(7,11,22,.94) 0%,rgba(7,11,22,.80) 15%,rgba(7,11,22,0) 38%)"></div></body>`, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: file, omitBackground: true });
    await browser.close(); return true;
  } catch { return false; }
}

/* ---------- 4. real screen recording (smooth eased scroll) ---------- */
async function recordSite(url, secs, outMp4) {
  if (!url) return false;
  const dir = `rec_${Math.random().toString(36).slice(2)}`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1,
      recordVideo: { dir, size: { width: 1080, height: 1920 } },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1600);
    for (const re of [/accept/i, /agree/i, /got it/i, /allow all/i, /reject/i]) {
      try { const b = page.getByRole("button", { name: re }).first(); if (await b.isVisible({ timeout: 600 })) await b.click({ timeout: 600 }); } catch {}
    }
    await page.waitForTimeout(400);
    await page.evaluate(async (ms) => {
      const max = Math.max(0, document.body.scrollHeight - window.innerHeight);
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
    }, Math.max(2200, secs * 1000));
    await page.waitForTimeout(300);
    await ctx.close();
    await browser.close();
    const webm = readdirSync(dir).find((f) => f.endsWith(".webm"));
    if (!webm) return false;
    // normalize to a clean 1080x1920 clip of exactly `secs`, bottom scrim + gentle fade-in
    const args = existsSync("scrim.png")
      ? ["-y", "-i", `${dir}/${webm}`, "-i", "scrim.png", "-filter_complex",
         `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${FPS},format=yuv420p[v0];[v0][1:v]overlay=0:0,fade=t=in:st=0:d=0.3,setsar=1[v]`,
         "-map", "[v]", "-t", secs.toFixed(2), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", outMp4]
      : ["-y", "-i", `${dir}/${webm}`, "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${FPS},fade=t=in:st=0:d=0.3,format=yuv420p,setsar=1`, "-t", secs.toFixed(2), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", outMp4];
    sh("ffmpeg", args);
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) { try { await browser?.close(); } catch {} return false; }
}

/* ---------- 5. designed offer slide (Montserrat, brand gradient, number, icon, agency tag) ---------- */
function slideHtml({ n, icon, title, sub }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@800;900&family=Inter:wght@400;600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1920px;overflow:hidden;background:#070b16;position:relative;font-family:Inter,Arial,sans-serif}
.bg{position:absolute;inset:0;background:radial-gradient(120% 76% at 50% 30%,#1b3460 0%,#0d1830 42%,#070b16 76%)}
.glow{position:absolute;inset:0;background:radial-gradient(52% 24% at 50% 9%,rgba(249,232,14,.13),rgba(249,232,14,0) 70%)}
.grid{position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 4px)}
.num{position:absolute;top:120px;left:0;right:0;text-align:center;font-family:Montserrat;font-weight:900;font-size:340px;line-height:1;color:rgba(249,232,14,.10);letter-spacing:-12px}
.wrap{position:absolute;top:0;left:0;right:0;height:1500px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 120px;text-align:center}
.icon{font-size:150px;margin-bottom:36px;filter:drop-shadow(0 8px 30px rgba(0,0,0,.4))}
.title{font-family:Montserrat;font-weight:900;font-size:118px;line-height:1.0;color:#fff;letter-spacing:-3px;text-shadow:0 6px 40px rgba(0,0,0,.5)}
.sub{font-family:Inter;font-weight:400;font-size:50px;color:#a9bad2;margin-top:40px;line-height:1.32}
.tag{position:absolute;bottom:470px;left:0;right:0;text-align:center;font-family:Montserrat;font-weight:800;font-size:36px;letter-spacing:6px;color:#f9e80e;text-transform:uppercase;opacity:.92}
</style></head><body>
<div class=bg></div><div class=glow></div><div class=grid></div>
${n ? `<div class=num>${n}</div>` : ""}
<div class=wrap><div class=icon>${icon || ""}</div><div class=title>${title}</div>${sub ? `<div class=sub>${sub}</div>` : ""}</div>
<div class=tag>for ${AGENCY}</div>
</body></html>`;
}
async function slideClip(slide, secs, outMp4) {
  const png = `slide_${Math.random().toString(36).slice(2)}.png`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await (await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })).newPage();
    await page.setContent(slideHtml(slide), { waitUntil: "load" });
    try { await page.evaluate(() => document.fonts.ready); } catch {}
    await page.waitForTimeout(500);
    await page.screenshot({ path: png });
    await browser.close();
  } catch (e) { try { await browser?.close(); } catch {}; sh("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x0A0F1E:s=1080x1920", "-frames:v", "1", png]); }
  const frames = Math.round(secs * FPS);
  // MrBeast entrance: hard zoom-PUNCH to 1.10 in ~0.22s, then slow drift to ~1.16. Snaps the eye on every cut.
  const pf = Math.max(4, Math.round(0.22 * FPS));
  const driftInc = (0.06 / Math.max(1, frames - pf)).toFixed(6);
  const z = `if(lt(on,${pf}),1.0+0.10*on/${pf},min(1.10+${driftInc}*(on-${pf}),1.16))`;
  sh("ffmpeg", ["-y", "-i", png,
    "-vf", `scale=1296:2304,zoompan=z='${z}':d=${frames}:s=1080x1920:fps=${FPS},fade=t=in:st=0:d=0.18,format=yuv420p,setsar=1`,
    "-frames:v", String(frames), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", outMp4]);
  rmSync(png, { force: true });
}

/* ---------- main ---------- */
let al, dur;
if (LOCAL) {
  // visual dry-run: fixed durations, silent track, no captions, no upload
  for (const s of SEG) s.dur = s.type === "site" ? 5.5 : 3.2;
  dur = SEG.reduce((a, s) => a + s.dur, 0);
  sh("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", dur.toFixed(2), "-q:a", "9", "narration.mp3"]);
} else {
  al = narrate();
  dur = (al.ends[al.ends.length - 1] || 30) + 0.5;
  // segment start times from char alignment, made monotonic with sane fallbacks
  let prev = 0;
  for (let i = 0; i < SEG.length; i++) {
    let t = al.starts[SEG[i].charStart];
    if (!(t > prev) || !(t < dur)) t = prev + 0.4;
    SEG[i].start = t; prev = t;
  }
  for (let i = 0; i < SEG.length; i++) SEG[i].dur = Math.max(1.4, (i < SEG.length - 1 ? SEG[i + 1].start : dur) - SEG[i].start);
  buildAss(al, dur);
}
console.log("durations:", SEG.map((s) => `${s.key}:${s.dur.toFixed(1)}`).join(" "), "total", dur.toFixed(1));

await makeScrim("scrim.png");
const scenes = [];
for (let i = 0; i < SEG.length; i++) {
  const s = SEG[i]; const f = `scene${i}.mp4`;
  if (s.type === "site") {
    const ok = await recordSite(s.url, s.dur, f);
    if (!ok) { console.log(`site ${s.key} record failed -> slide fallback`); await slideClip({ n: "", icon: "🌐", title: s.url ? s.key.toUpperCase() : AGENCY, sub: "" }, s.dur, f); }
    else console.log(`recorded ${s.key} (${s.url})`);
  } else {
    await slideClip(s.slide, s.dur, f);
    console.log(`slide ${s.key}`);
  }
  scenes.push(f);
}

// concat all scene clips
writeFileSync("list.txt", scenes.map((f) => `file '${f}'`).join("\n"));
sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "body.mp4"]);

// burn captions (skip locally — no libass) then mux narration
const haveCaps = !LOCAL && existsSync("captions.ass");
if (haveCaps) {
  sh("ffmpeg", ["-y", "-i", "body.mp4", "-vf", "ass=captions.ass", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "capped.mp4"]);
} else {
  sh("ffmpeg", ["-y", "-i", "body.mp4", "-c", "copy", "capped.mp4"]);
}
sh("ffmpeg", ["-y", "-i", "capped.mp4", "-i", "narration.mp3", "-map", "0:v", "-map", "1:a",
  // EXACT same character as ZZ Human 4 - NO EQ/coloring. Only a clean, near-transparent 320k encode of the original voice.
  "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "44100", "-shortest", "-movflags", "+faststart", "out.mp4"]);
const sizeMB = (statSync("out.mp4").size / 1e6).toFixed(2);
console.log(`rendered out.mp4 (${sizeMB} MB, ${dur.toFixed(1)}s)`);
// proof sheet: 6 evenly-spaced frames tiled, base64 to the log so the editing can be eyeballed without downloading the full mp4
try {
  const d2 = parseFloat(sh("ffprobe", ["-v", "0", "-show_entries", "format=duration", "-of", "csv=p=0", "out.mp4"]).toString().trim()) || dur;
  const rate = (5.999 / d2).toFixed(4);
  sh("ffmpeg", ["-y", "-i", "out.mp4", "-vf", `fps=${rate},scale=170:302,tile=6x1`, "-frames:v", "1", "sheet.jpg"]);
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
