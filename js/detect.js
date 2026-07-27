// ============================================================
//  detect.js —— 相機、人臉偵測、頭巾顏色判定
//  這一層完全不碰 Firebase,純粹回報「這一槍打到了沒」
// ============================================================
import { DETECT } from './config.js';

const MODELS = {
  full: {
    name: 'full range',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite'
  },
  short: {
    name: 'short range',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
  }
};

export class Detector {
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d', { willReadFrequently: true });
    this.detector = null;
    this.activeModel = '';
    this.stream = null;
    this.animId = null;
    this.paused = false;
    this.tsCounter = 0;
  }

  // MediaPipe 要求時間戳嚴格遞增
  nextTs() {
    this.tsCounter = Math.max(this.tsCounter + 1, Math.round(performance.now()));
    return this.tsCounter;
  }

  async initModel(onProgress) {
    if (this.detector) return this.activeModel;
    const v = DETECT.mpVersion;
    onProgress?.('載入偵測引擎…');
    const { FaceDetector, FilesetResolver } = await import(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}`
    );
    const fileset = await FilesetResolver.forVisionTasks(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}/wasm`
    );

    const build = async (key) => {
      const det = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODELS[key].url, delegate: 'GPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: DETECT.minConfidence
      });
      // 先用假畫面試跑一次,不相容的話在這裡就會失敗,而不是等玩家開火才爆掉
      const probe = document.createElement('canvas');
      probe.width = probe.height = 256;
      const pctx = probe.getContext('2d');
      pctx.fillStyle = '#808080';
      pctx.fillRect(0, 0, 256, 256);
      det.detectForVideo(probe, this.nextTs());
      return det;
    };

    onProgress?.('載入偵測模型…');
    try {
      this.detector = await build('full');
      this.activeModel = MODELS.full.name;
    } catch (err) {
      console.warn('full range 不可用,改用 short range:', err);
      this.detector = await build('short');
      this.activeModel = MODELS.short.name + '(已自動退回)';
    }
    return this.activeModel;
  }

  async startCamera() {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      throw new Error('相機需要 https 網址才能使用');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    this.video.srcObject = this.stream;
    await new Promise(res => { this.video.onloadedmetadata = () => res(); });
    await this.video.play();
    this.syncSize();
  }

  stopCamera() {
    this.stopPreview();
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  syncSize() {
    const v = this.video;
    if (v.videoWidth && (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight)) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
    }
  }

  startPreview() {
    if (this.animId) return;
    const loop = () => {
      this.animId = requestAnimationFrame(loop);
      if (this.paused || this.video.readyState < 2) return;
      this.syncSize();
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      this.drawReticle();
    };
    this.animId = requestAnimationFrame(loop);
  }

  stopPreview() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
  }

  // 準星框(影像座標)。準星直接畫在畫布上,確保「看到的」和「判定的」是同一塊
  getAimBox() {
    const side = Math.round(Math.min(this.canvas.width, this.canvas.height) * DETECT.aimFraction);
    return {
      x: Math.round((this.canvas.width - side) / 2),
      y: Math.round((this.canvas.height - side) / 2),
      side
    };
  }

  drawReticle(color = 'rgba(231,236,242,.9)') {
    const a = this.getAimBox();
    const ctx = this.ctx;
    const lw = Math.max(2, Math.round(this.canvas.width * 0.0035));
    const arm = Math.round(a.side * 0.22);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    const corners = [
      [a.x, a.y, 1, 1],
      [a.x + a.side, a.y, -1, 1],
      [a.x, a.y + a.side, 1, -1],
      [a.x + a.side, a.y + a.side, -1, -1]
    ];
    for (const [px, py, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(px + dx * arm, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * arm);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(a.x + a.side / 2, a.y + a.side / 2, Math.max(2, lw * 0.9), 0, Math.PI * 2);
    ctx.fill();
  }

  static rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }

  static matchesTeam(h, s, v, teamKey) {
    const def = DETECT.teamColors[teamKey];
    if (!def) return false;
    if (s < def.sat || v < def.val) return false;
    return def.hueRanges.some(([lo, hi]) => h >= lo && h <= hi);
  }

  // 在臉框「上方」取樣,對應額頭頭巾的位置
  sampleForehead(box) {
    const sx = Math.max(0, Math.round(box.originX + box.width * 0.15));
    const sy = Math.max(0, Math.round(box.originY - box.height * 0.35));
    const sw = Math.min(this.canvas.width - sx, Math.round(box.width * 0.7));
    const sh = Math.min(this.canvas.height - sy, Math.round(box.height * 0.35));
    if (sw <= 4 || sh <= 4) return null;
    let data;
    try { data = this.ctx.getImageData(sx, sy, sw, sh).data; }
    catch (e) { return null; }
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 16) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    if (!n) return null;
    return { r: r / n, g: g / n, b: b / n, rect: { sx, sy, sw, sh } };
  }

  // 只把準星附近裁切放大後偵測,解析度集中在目標上
  detectInAim() {
    const aim = this.getAimBox();
    const cxC = aim.x + aim.side / 2, cyC = aim.y + aim.side / 2;
    let crop = Math.min(Math.round(aim.side * DETECT.cropExpand), this.canvas.width, this.canvas.height);
    let cx = Math.max(0, Math.min(Math.round(cxC - crop / 2), this.canvas.width - crop));
    let cy = Math.max(0, Math.min(Math.round(cyC - crop / 2), this.canvas.height - crop));

    const out = Math.max(DETECT.detectSize, crop);  // 絕不縮小,避免高解析度相機反而損失畫質
    this.work.width = this.work.height = out;
    this.wctx.drawImage(this.video, cx, cy, crop, crop, 0, 0, out, out);

    const res = this.detector.detectForVideo(this.work, this.nextTs());
    const scale = out / crop;
    const boxes = (res.detections || []).map(d => ({
      originX: cx + d.boundingBox.originX / scale,
      originY: cy + d.boundingBox.originY / scale,
      width: d.boundingBox.width / scale,
      height: d.boundingBox.height / scale
    }));

    const inAim = boxes.filter(b => {
      const fx = b.originX + b.width / 2, fy = b.originY + b.height / 2;
      return fx >= aim.x && fx <= aim.x + aim.side && fy >= aim.y && fy <= aim.y + aim.side;
    });
    inAim.sort((p, q) =>
      Math.hypot(p.originX + p.width / 2 - cxC, p.originY + p.height / 2 - cyC) -
      Math.hypot(q.originX + q.width / 2 - cxC, q.originY + q.height / 2 - cyC)
    );
    return { aim, inAim, ignored: boxes.length - inAim.length };
  }

  // 開一槍。回傳 {hit, title, detail}
  shoot(enemyTeam) {
    if (!this.detector) return { hit: false, title: '尚未就緒', detail: '偵測模型還在載入' };
    this.paused = true;
    // 先畫一張乾淨畫面(不含準星線),避免取樣時取到準星白線
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    const { inAim, ignored } = this.detectInAim();
    const ignoredNote = ignored > 0 ? `<br>準星外另有 ${ignored} 張臉,已忽略` : '';
    const lw = Math.max(2, Math.round(this.canvas.width * 0.004));

    if (!inAim.length) {
      this.drawReticle('#FF4757');
      return {
        hit: false, title: '未命中',
        detail: `準星範圍內沒有偵測到人臉${ignoredNote}<br>請把準星對準對方的臉`
      };
    }

    const box = inAim[0];
    this.ctx.strokeStyle = 'rgba(231,236,242,.85)';
    this.ctx.lineWidth = lw;
    this.ctx.strokeRect(box.originX, box.originY, box.width, box.height);

    const sample = this.sampleForehead(box);
    if (!sample) {
      this.drawReticle('#FF4757');
      return { hit: false, title: '未命中', detail: `偵測到臉,但額頭超出畫面無法取樣${ignoredNote}` };
    }

    const [h, s, v] = Detector.rgbToHsv(sample.r, sample.g, sample.b);
    const hit = Detector.matchesTeam(h, s, v, enemyTeam);
    const enemyLabel = DETECT.teamColors[enemyTeam]?.label ?? enemyTeam;

    this.ctx.strokeStyle = hit ? '#FFD447' : 'rgba(255,255,255,.6)';
    this.ctx.lineWidth = lw;
    this.ctx.strokeRect(sample.rect.sx, sample.rect.sy, sample.rect.sw, sample.rect.sh);
    this.drawReticle(hit ? '#FFD447' : '#FF4757');

    const rgb = `rgb(${Math.round(sample.r)},${Math.round(sample.g)},${Math.round(sample.b)})`;
    const facePct = ((box.width / this.canvas.width) * 100).toFixed(0);
    const diag =
      `臉寬約畫面 ${facePct}%${ignoredNote}<br>` +
      `<span class="swatch" style="background:${rgb}"></span>額頭取樣 ${rgb}<br>` +
      `色相 ${h.toFixed(0)}° · 飽和 ${s.toFixed(2)} · 亮度 ${v.toFixed(2)}`;

    return {
      hit,
      title: hit ? '命中!' : '未命中',
      detail: hit ? diag : `不是${enemyLabel}的頭巾顏色<br>${diag}`,
      diag
    };
  }

  release() {
    this.paused = false;
  }
}
