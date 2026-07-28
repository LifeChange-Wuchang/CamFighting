// ============================================================
//  calibrate.js —— 頭巾校色工具
//  收集「頭巾」與「皮膚/背景」兩組樣本,算出能區分兩者的門檻值
// ============================================================
import { Detector } from './detect.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('overlay');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let stream = null, facing = 'environment', raf = null;
const good = [], bad = [];

const rgbToHsv = Detector.rgbToHsv;

async function startCam() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await new Promise(r => { video.onloadedmetadata = () => r(); });
  await video.play();
}

// 取樣畫面正中央的方框(和螢幕上的黃框對應)
function sample() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return null;
  const side = Math.round(Math.min(vw, vh) * 0.28);
  const sx = Math.round((vw - side) / 2), sy = Math.round((vh - side) / 2);
  canvas.width = side; canvas.height = side;
  ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side);
  let d;
  try { d = ctx.getImageData(0, 0, side, side).data; } catch (e) { return null; }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  r /= n; g /= n; b /= n;
  const [h, s, v] = rgbToHsv(r, g, b);
  return { r, g, b, h, s, v };
}

function loop() {
  raf = requestAnimationFrame(loop);
  const c = sample();
  if (!c) return;
  const rgb = `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
  $('readout').innerHTML =
    `<span class="cal-swatch" style="background:${rgb}"></span><span class="big">${rgb}</span><br>
     色相 ${c.h.toFixed(0)}° · 飽和 ${c.s.toFixed(2)} · 亮度 ${c.v.toFixed(2)}`;
}

// ---- 色相是環狀的(359° 和 1° 其實很近),要用向量平均而不是算術平均 ----
function hueStats(hs) {
  let x = 0, y = 0;
  hs.forEach(h => { x += Math.cos(h * Math.PI / 180); y += Math.sin(h * Math.PI / 180); });
  let mean = Math.atan2(y / hs.length, x / hs.length) * 180 / Math.PI;
  if (mean < 0) mean += 360;
  const dev = hs.map(h => { let d = Math.abs(h - mean); return Math.min(d, 360 - d); });
  return { mean, maxDev: Math.max(...dev) };
}
function inHueRange(h, lo, hi) {
  return lo <= hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi);
}
function toRanges(lo, hi) {   // 跨過 0 度就拆成兩段,配合 config.js 的格式
  lo = (lo + 360) % 360; hi = (hi + 360) % 360;
  return lo <= hi ? [[+lo.toFixed(0), +hi.toFixed(0)]]
                  : [[0, +hi.toFixed(0)], [+lo.toFixed(0), 360]];
}

function analyse() {
  if (good.length < 3) return { error: '頭巾樣本太少,請至少記錄 3 筆(換幾個角度和位置)' };

  const st = hueStats(good.map(s => s.h));
  const margin = 10;
  let lo = st.mean - st.maxDev - margin;
  let hi = st.mean + st.maxDev + margin;
  let satMin = Math.max(0, Math.min(...good.map(s => s.s)) - 0.07);
  let valMin = Math.max(0, Math.min(...good.map(s => s.v)) - 0.07);

  // 逐步收緊,直到所有負樣本都被排除
  const hits = () => bad.filter(s => inHueRange(s.h, (lo + 360) % 360, (hi + 360) % 360)
                                      && s.s >= satMin && s.v >= valMin);
  let leaks = hits(), tightened = false, guard = 0;
  while (leaks.length && guard++ < 40) {
    const worstSat = Math.max(...leaks.map(s => s.s));
    const minGoodSat = Math.min(...good.map(s => s.s));
    if (worstSat + 0.02 < minGoodSat) { satMin = worstSat + 0.02; tightened = true; }
    else {
      // 飽和度分不開,改用色相收緊
      const span = hi - lo;
      if (span <= 8) break;
      lo += 2; hi -= 2; tightened = true;
    }
    leaks = hits();
  }

  return {
    ranges: toRanges(lo, hi),
    sat: +satMin.toFixed(2),
    val: +valMin.toFixed(2),
    leaks: leaks.length,
    tightened,
    hueMean: st.mean,
    spread: st.maxDev
  };
}

$('btnStart').onclick = async () => {
  try {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost')
      throw new Error('相機需要 https 網址');
    await startCam();
    $('intro').classList.add('hidden');
    loop();
  } catch (e) {
    $('introErr').textContent = '啟動失敗:' + (e.message || e);
  }
};

$('btnFlip').onclick = async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try { await startCam(); } catch (e) { alert('切換失敗:' + e.message); }
};

$('btnGood').onclick = () => { const c = sample(); if (c) { good.push(c); $('nGood').textContent = good.length; } };
$('btnBad').onclick  = () => { const c = sample(); if (c) { bad.push(c);  $('nBad').textContent  = bad.length;  } };
$('btnClear').onclick = () => { good.length = 0; bad.length = 0; $('nGood').textContent = '0'; $('nBad').textContent = '0'; };

$('btnFinish').onclick = () => {
  const a = analyse();
  const box = $('result');
  if (a.error) {
    box.innerHTML = `<div class="warn">${a.error}</div>
      <button class="btn ghost" onclick="document.getElementById('result').classList.add('hidden')">返回</button>`;
    box.classList.remove('hidden');
    return;
  }

  const swatches = arr => `<div class="samples">${arr.map(s =>
    `<i style="background:rgb(${Math.round(s.r)},${Math.round(s.g)},${Math.round(s.b)})"></i>`).join('')}</div>`;

  const note = a.leaks > 0
    ? `<div class="warn"><b>⚠️ 有 ${a.leaks} 筆皮膚/背景樣本無法排除。</b><br>
       這代表你的頭巾顏色和皮膚或環境太接近,再怎麼調門檻都會誤判。<br>
       強烈建議換一條<b>更鮮豔、更深</b>的頭巾——淡色系(水藍、粉紅、米色)特別容易和皮膚牆面混淆。</div>`
    : `<div class="good">✅ 這組門檻可以完整涵蓋所有頭巾樣本,同時排除掉所有皮膚/背景樣本。</div>`;

  const tips = a.tightened
    ? `<p class="sub">為了排除皮膚/背景,門檻有被自動收緊,判定會比較嚴格。若現場覺得太難命中,可以把 sat 稍微調低 0.03 試試。</p>` : '';

  box.innerHTML = `
    <h2 style="font-size:19px;margin:0 0 4px">校色結果</h2>
    <p class="sub" style="text-align:left">頭巾平均色相 ${a.hueMean.toFixed(0)}°,樣本間最大偏差 ±${a.spread.toFixed(0)}°</p>
    <div><b style="font-size:12px;color:var(--neutral)">頭巾樣本</b>${swatches(good)}</div>
    ${bad.length ? `<div><b style="font-size:12px;color:var(--neutral)">皮膚/背景樣本</b>${swatches(bad)}</div>` : ''}
    ${note}${tips}
    <p class="sub" style="text-align:left">把下面這段貼回 <b>js/config.js</b> 的 <b>DETECT.teamColors</b> 裡(取代對應那一隊):</p>
    <pre id="snippet">${escapeHTML(
`red:  { label: "紅隊", hueRanges: ${JSON.stringify(a.ranges)}, sat: ${a.sat}, val: ${a.val} },`
    )}</pre>
    <p class="sub" style="text-align:left">上面寫的是紅隊,如果你校的是藍色頭巾,把 <b>red</b> 改成 <b>blue</b>、<b>"紅隊"</b> 改成 <b>"藍隊"</b>。</p>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn primary" id="btnCopy">複製設定</button>
      <button class="btn ghost" id="btnBack">繼續校色</button>
    </div>`;
  box.classList.remove('hidden');
  $('btnBack').onclick = () => box.classList.add('hidden');
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('snippet').textContent); $('btnCopy').textContent = '已複製!'; }
    catch (e) { $('btnCopy').textContent = '請長按上方文字手動複製'; }
  };
};

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
