// ============================================================
//  scan.js —— QR Code 掃描(據點、寶箱、加入房間)
//  搶佔點需要「連續對準 N 秒」才算數,中途移開就重新計時
// ============================================================
import jsQR from 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';

export const QR_PREFIX = 'CBG';   // Camera Battle Game

export function encodePoint(code, pointId, type) {
  return `${QR_PREFIX}:${type}:${code}:${pointId}`;
}

export function parseQR(text) {
  const parts = String(text || '').split(':');
  if (parts[0] !== QR_PREFIX || parts.length < 4) return null;
  return { type: parts[1], code: parts[2], pointId: parts.slice(3).join(':') };
}

export class Scanner {
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    this.raf = null;
    this.running = false;
    this.holdMs = 0;
    this.currentCode = null;
    this.holdStart = 0;
    this.lastFrameAt = 0;
  }

  // onProgress(payload, ratio) 每幀回報進度;onComplete(payload) 達成後觸發一次
  start({ holdSeconds = 0, onProgress, onComplete, onError }) {
    this.holdMs = holdSeconds * 1000;
    this.running = true;
    this.currentCode = null;
    this.holdStart = 0;
    this.lastFrameAt = performance.now();

    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      if (this.video.readyState < 2) return;

      const now = performance.now();
      if (now - this.lastFrameAt < 80) return;   // 約 12fps,省電
      this.lastFrameAt = now;

      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      if (!vw || !vh) return;
      // 只掃畫面中央區域,速度快也比較不會誤掃到旁邊的碼
      const side = Math.round(Math.min(vw, vh) * 0.6);
      const sx = Math.round((vw - side) / 2), sy = Math.round((vh - side) / 2);
      const work = Math.min(400, side);
      this.canvas.width = work; this.canvas.height = work;
      this.ctx.drawImage(this.video, sx, sy, side, side, 0, 0, work, work);

      let img;
      try { img = this.ctx.getImageData(0, 0, work, work); }
      catch (e) { onError?.(e); return; }

      const found = jsQR(img.data, work, work, { inversionAttempts: 'dontInvert' });
      const text = found?.data || null;

      if (!text) {
        this.currentCode = null; this.holdStart = 0;
        onProgress?.(null, 0);
        return;
      }
      const payload = parseQR(text);
      if (!payload) { onProgress?.(null, 0); return; }

      if (this.currentCode !== text) {
        this.currentCode = text;
        this.holdStart = now;
      }
      const held = now - this.holdStart;
      const ratio = this.holdMs > 0 ? Math.min(1, held / this.holdMs) : 1;
      onProgress?.(payload, ratio);

      if (ratio >= 1) {
        this.stop();
        onComplete?.(payload);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}
