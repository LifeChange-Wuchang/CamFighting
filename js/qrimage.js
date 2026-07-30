// ============================================================
//  qrimage.js —— 把 QR 碼輸出成可下載的圖片檔
//  自己把 QR 模組畫到 canvas 上,所以解析度可以任意放大,
//  不會像直接用函式庫的縮圖那樣印出來糊掉。
// ============================================================
import qrcode from 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm';

function build(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q;
}

// 檔名安全化:去掉作業系統不接受的字元
export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40);
}

// 產生 PNG 用的 canvas。label 為 null 時輸出純 QR 碼(方便你自己排版)
export function qrToCanvas(text, { size = 1200, margin = 4, label = null, sub = null } = {}) {
  const q = build(text);
  const n = q.getModuleCount();
  const total = n + margin * 2;
  const scale = Math.max(1, Math.floor(size / total));
  const qrPx = scale * total;
  const labelH = label ? Math.round(qrPx * 0.17) : 0;

  const cv = document.createElement('canvas');
  cv.width = qrPx;
  cv.height = qrPx + labelH;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }

  if (label) {
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(labelH * 0.44)}px "PingFang TC","Noto Sans TC",sans-serif`;
    ctx.fillText(label, qrPx / 2, qrPx + labelH * 0.46);
    if (sub) {
      ctx.fillStyle = '#555555';
      ctx.font = `${Math.round(labelH * 0.26)}px "PingFang TC","Noto Sans TC",sans-serif`;
      ctx.fillText(sub, qrPx / 2, qrPx + labelH * 0.82);
    }
  }
  return cv;
}

// 向量格式:放到多大印都不會糊,適合拿去排版軟體裡調整
export function qrToSVG(text, { margin = 4, px = 1200 } = {}) {
  const q = build(text);
  const n = q.getModuleCount();
  const total = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
         `width="${px}" height="${px}" shape-rendering="crispEdges">` +
         `<rect width="100%" height="100%" fill="#ffffff"/>` +
         `<path d="${path}" fill="#000000"/></svg>`;
}

export function canvasToBlob(cv) {
  return new Promise(res => cv.toBlob(res, 'image/png'));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// 打包成 ZIP:含名稱的 PNG 與純 QR 的 SVG 各放一個資料夾
export async function downloadAllAsZip(items, zipName = 'markers.zip', onProgress) {
  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
  const zip = new JSZip();
  const pngDir = zip.folder('含名稱_PNG');
  const svgDir = zip.folder('純QR碼_SVG');

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    onProgress?.(i + 1, items.length);
    const base = safeName(it.label ? `${it.id}_${it.label}` : it.id);
    const cv = qrToCanvas(it.text, { label: it.label || it.id, sub: it.sub || '' });
    const blob = await canvasToBlob(cv);
    pngDir.file(`${base}.png`, blob);
    svgDir.file(`${base}.svg`, qrToSVG(it.text));
  }

  const out = await zip.generateAsync({ type: 'blob' });
  downloadBlob(out, zipName);
}
