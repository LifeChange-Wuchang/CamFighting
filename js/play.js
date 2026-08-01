// ============================================================
//  play.js —— 共用的「下場玩」介面
//  玩家頁與主持人控台都掛載這一份,所以主持人可以在同一個分頁裡
//  一邊控場一邊參戰,裁判邏輯不會因為切分頁被瀏覽器降速。
// ============================================================
import { DEFAULTS, maxHpOf } from './config.js';
import { Detector } from './detect.js';
import { Scanner } from './scan.js';

const TEMPLATE = `
<video class="camfeed" playsinline muted></video>
<canvas class="overlay"></canvas>
<canvas class="scanwork offscreen"></canvas>
<div class="flash"></div>

<div class="play-view play-game">
  <div class="hud-top">
    <div class="hpbars"></div>
    <div class="timer">--:--</div>
  </div>
  <div class="tagline"><span class="tag-team"></span><span class="tag-model"></span></div>
  <ul class="feed"></ul>
  <div class="buffs"></div>

  <button class="pt-toggle act-points" title="據點狀態">據點</button>
  <div class="pt-panel hidden">
    <div class="pt-head"><span>據點狀態</span><button class="act-ptclose">✕</button></div>
    <ul class="pt-list"></ul>
    <div class="pt-foot"></div>
  </div>
  <div class="hud-bottom">
    <button class="btn round ghost act-scan">掃描</button>
    <button class="shutter act-fire" aria-label="開火"><span></span></button>
    <button class="btn round ghost act-menu">選單</button>
  </div>
  <div class="cooldown"></div>
  <div class="shot-result">
    <div class="sr-title"></div>
    <div class="sr-detail"></div>
    <div class="sr-hint">點畫面繼續</div>
  </div>
  <div class="dismiss-layer hidden"></div>
</div>

<div class="play-view play-scan hidden">
  <div class="scan-frame"><div class="scan-ring">
    <svg viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="54" class="ring-bg"/>
      <circle cx="60" cy="60" r="54" class="ring-fg"/>
    </svg>
  </div></div>
  <div class="scan-info">把標記的 QR 碼對準圓框內</div>
  <button class="btn ghost small floating act-scanclose">取消</button>
</div>
`;

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const buzz = p => { try { navigator.vibrate?.(p); } catch (e) {} };

export class PlayUI {
  // opts: { toast, modal, loading, menuLabel, onMenu }
  constructor(container, game, opts = {}) {
    this.root = container;
    this.game = game;
    this.opts = opts;
    this.root.classList.add('playroot');
    this.root.innerHTML = TEMPLATE;

    const q = sel => this.root.querySelector(sel);
    this.q = q;
    this.video = q('.camfeed');
    this.canvas = q('.overlay');
    this.detector = new Detector(this.video, this.canvas);
    this.scanner = new Scanner(this.video, q('.scanwork'));

    this.active = false;
    this.cameraReady = false;
    this.shotBusy = false;
    this.wakeLock = null;
    this.pointsOpen = false;

    q('.act-fire').onclick = () => this.fire();
    q('.act-scan').onclick = () => this.openScan();
    q('.act-scanclose').onclick = () => this.closeScan();
    q('.act-menu').onclick = () => this.opts.onMenu?.();
    q('.act-points').onclick = () => this.togglePoints();
    q('.act-ptclose').onclick = () => this.togglePoints(false);
    q('.dismiss-layer').onclick = () => this.dismissShot();
    if (this.opts.menuLabel) q('.act-menu').textContent = this.opts.menuLabel;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.active) this.keepAwake(true);
    });
  }

  async keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) { if (!this.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen'); }
      else if (this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; }
    } catch (e) {}
  }

  // ---------- 顯示 / 隱藏 ----------
  async start() {
    this.root.classList.add('on');
    this.active = true;
    this.keepAwake(true);
    this.showView('game');
    if (!this.cameraReady) {
      try {
        this.opts.loading?.(true, '啟動相機…');
        await this.detector.startCamera();
        const model = await this.detector.initModel(t => this.opts.loading?.(true, t));
        this.q('.tag-model').textContent = `模型:${model}`;
        this.cameraReady = true;
      } catch (e) {
        this.opts.loading?.(false);
        this.opts.modal?.('相機啟動失敗', String(e.message || e),
          [{ text: '重試', primary: true, onClick: () => this.start() }, { text: '取消' }]);
        return false;
      } finally { this.opts.loading?.(false); }
    }
    this.detector.paused = false;
    this.detector.startPreview();
    return true;
  }

  stop() {
    this.active = false;
    this.scanner.stop();
    this.detector.stopCamera();
    this.cameraReady = false;
    this.keepAwake(false);
    this.pointsOpen = false;
    this.q('.pt-panel').classList.add('hidden');
    this.root.classList.remove('on');
  }

  showView(name) {
    this.q('.play-game').classList.toggle('hidden', name !== 'game');
    this.q('.play-scan').classList.toggle('hidden', name !== 'scan');
    // 掃描時把畫布收起來,才看得到鏡頭原始畫面
    this.canvas.classList.toggle('hide', name !== 'game');
  }

  // ---------- 渲染 ----------
  render(room) {
    if (!this.active || !room) return;
    const cfg = room.config || DEFAULTS;
    const ids = this.game.teamIds();
    const myTeam = this.game.myTeam();

    this.q('.hpbars').innerHTML = ids.map(id => {
      const t = room.teams[id];
      const max = t.maxHp || maxHpOf(cfg) || 1;
      const pct = Math.max(0, Math.min(1, (t.hp ?? 0) / max));
      return `<div class="hpbar"><i style="background:${t.accent};transform:scaleX(${pct})"></i>
        <span>${esc(t.label)} ${Math.round(t.hp ?? 0)} / ${max}</span></div>`;
    }).join('');

    if (myTeam && myTeam !== 'host') {
      const others = ids.filter(i => i !== myTeam).map(i => esc(room.teams[i].label)).join('、');
      this.q('.tag-team').textContent = `你是${esc(room.teams[myTeam]?.label || '')} · 目標:${others}`;
    } else {
      this.q('.tag-team').textContent = '控場中,不參與計分';
    }
  }

  togglePoints(force) {
    this.pointsOpen = force === undefined ? !this.pointsOpen : force;
    this.q('.pt-panel').classList.toggle('hidden', !this.pointsOpen);
    if (this.pointsOpen) this.renderPoints();
  }

  // 據點即時狀態:QR 貼紙本身是死的,狀態只能在這裡看
  renderPoints() {
    if (!this.active || !this.pointsOpen) return;
    const room = this.game.room;
    if (!room) return;
    const cfg = room.config || DEFAULTS;
    const mine = this.game.myTeam();
    const now = Date.now();
    const pts = Object.entries(room.points || {}).sort(([a], [b]) => a.localeCompare(b));

    const ul = this.q('.pt-list');
    if (!pts.length) {
      ul.innerHTML = '<li class="pt-empty">本場沒有啟用任何據點</li>';
      this.q('.pt-foot').textContent = '';
      return;
    }

    let held = 0, total = 0;
    ul.innerHTML = pts.map(([mid, p]) => {
      const isChest = p.type === 'chest';
      const cd = (isChest ? cfg.chestCooldownSec : cfg.captureCooldownSec) * 1000;
      const left = p.lastAt ? Math.max(0, cd - (now - p.lastAt)) : 0;
      const owner = p.owner && room.teams[p.owner];
      if (!isChest) { total++; if (p.owner === mine) held++; }

      let state, cls;
      if (left > 0) {
        state = `冷卻 ${Math.ceil(left / 1000)}s`; cls = 'cooling';
      } else if (isChest) {
        state = '可開啟'; cls = 'ready';
      } else if (!owner) {
        state = '無人佔領'; cls = 'ready';
      } else if (p.owner === mine) {
        state = '我方持有'; cls = 'own';
      } else {
        state = `${owner.label}持有`; cls = 'enemy';
      }

      return `<li class="${cls}">
        <span class="pt-dot" style="background:${owner ? owner.accent : 'rgba(255,255,255,.22)'}"></span>
        <span class="pt-mid">${mid}</span>
        <span class="pt-name">${esc(p.label)}</span>
        <span class="pt-type">${isChest ? '寶箱' : '搶佔'}</span>
        <span class="pt-state">${state}</span></li>`;
    }).join('');

    const regen = cfg.holdRegenPct || 0;
    this.q('.pt-foot').innerHTML = total
      ? `我方持有 <b>${held}/${total}</b> 個搶佔點` +
        (regen > 0 && held > 0
          ? ` · 每分鐘回血 <b>${(regen * held).toFixed(1)}%</b>`
          : (regen > 0 ? ' · 佔領才會開始回血' : ''))
      : '';
  }

  renderFeed(items) {
    if (!this.active) return;
    this.q('.feed').innerHTML = items.slice(0, 6).map(f =>
      `<li class="${f.type === 'hit' ? 'hit' : (f.type === 'system' ? 'system' : '')}">${esc(f.msg)}</li>`
    ).join('');
  }

  tick() {
    if (!this.active) return;
    const room = this.game.room;
    if (!room || room.meta?.status !== 'running') return;
    const left = Math.max(0, (room.meta.endsAt || 0) - this.game.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    const t = this.q('.timer');
    t.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    t.classList.toggle('low', left < 60000);

    const cd = this.game.fireCooldownLeft();
    this.q('.cooldown').textContent = cd > 0 ? `冷卻 ${(cd / 1000).toFixed(1)}s` : '';

    if (this.pointsOpen) this.renderPoints();
    this.updatePointBadge();

    this.q('.buffs').innerHTML = this.game.isDoubleActive()
      ? `<div class="buff">傷害加倍 ${Math.ceil((this.game.doubleUntil - this.game.now()) / 1000)}s</div>` : '';
  }

  // 按鈕上直接顯示「我方持有幾個」,不用打開面板就看得到
  updatePointBadge() {
    const room = this.game.room;
    const btn = this.q('.act-points');
    if (!room) return;
    const mine = this.game.myTeam();
    let held = 0, total = 0;
    for (const p of Object.values(room.points || {})) {
      if (p.type !== 'capture') continue;
      total++;
      if (p.owner === mine) held++;
    }
    if (!total) { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    btn.textContent = `據點 ${held}/${total}`;
    btn.classList.toggle('has', held > 0);
  }

  // ---------- 開火 ----------
  async fire() {
    if (this.shotBusy || !this.cameraReady) return;
    if (this.game.isSpectator()) return this.opts.toast?.('你目前是控場者,先在控台按「下場玩」');
    const left = this.game.fireCooldownLeft();
    if (left > 0) { buzz(40); return this.opts.toast?.(`冷卻中,還要 ${(left / 1000).toFixed(1)} 秒`); }

    this.shotBusy = true;
    this.q('.act-fire').disabled = true;
    const flash = this.q('.flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');

    let res, title, detail, isHit = false;
    try { res = this.detector.shoot(this.game.teams()); }
    catch (e) { console.error(e); res = { found: false, teamId: null, detail: String(e.message || e) }; }

    if (!res.found) {
      title = '未命中'; detail = res.detail; buzz(25); this.game.lastFireAt = this.game.now();
    } else if (!res.teamId) {
      title = '未命中';
      detail = `偵測到人臉,但額頭顏色不屬於任何隊伍<br>${res.detail}`;
      buzz(25); this.game.lastFireAt = this.game.now();
    } else if (res.teamId === this.game.myTeam()) {
      title = '那是隊友!';
      detail = `${esc(this.game.teamLabel(res.teamId))}是你自己人,不計分<br>${res.detail}`;
      buzz(25); this.game.lastFireAt = this.game.now();
    } else {
      const out = await this.game.registerHit(res.teamId);
      if (out.ok) {
        isHit = true; buzz([30, 40, 60]);
        title = '命中!';
        detail = `${esc(out.label)} -${out.damage},剩餘 ${Math.round(out.hp)}<br>${res.detail}`;
      } else {
        title = '未計分'; detail = `${out.reason}<br>${res.detail}`; buzz(25);
      }
    }

    this.q('.sr-title').textContent = title;
    this.q('.sr-detail').innerHTML = detail;
    this.q('.shot-result').className = 'shot-result show ' + (isHit ? 'hit' : 'miss');
    this.q('.dismiss-layer').classList.remove('hidden');
  }

  dismissShot() {
    this.q('.shot-result').classList.remove('show');
    this.q('.dismiss-layer').classList.add('hidden');
    this.detector.release();
    this.shotBusy = false;
    this.q('.act-fire').disabled = false;
  }

  // ---------- 掃描 ----------
  openScan() {
    if (!this.cameraReady) return;
    this.detector.stopPreview();
    this.showView('scan');
    this.setRing(0);
    this.q('.scan-info').textContent = '把標記的 QR 碼對準圓框內';

    this.scanner.start({
      holdSeconds: this.game.config().captureHoldSec || 5,
      onProgress: (payload, ratio) => {
        const info = this.q('.scan-info');
        if (!payload) { this.setRing(0); info.textContent = '把標記的 QR 碼對準圓框內'; return; }
        const pt = this.game.room?.points?.[payload.mid];
        if (!pt) { this.setRing(0); info.textContent = `${payload.mid} 這一組本場沒有啟用`; return; }
        if (pt.type === 'chest') { this.scanner.stop(); this.handleScan(payload); return; }
        this.setRing(ratio);
        info.textContent = `佔領「${pt.label}」… ${(ratio * 100).toFixed(0)}%  請持續對準`;
      },
      onComplete: p => this.handleScan(p),
      onError: e => console.warn(e)
    });
  }

  setRing(r) { this.q('.ring-fg').style.strokeDashoffset = String(339.3 * (1 - r)); }

  async handleScan(payload) {
    const pt = this.game.room?.points?.[payload.mid];
    const out = pt?.type === 'chest' ? await this.game.openChest(payload.mid)
                                     : await this.game.capturePoint(payload.mid);
    this.closeScan();
    if (!out.ok) { buzz(30); return this.opts.toast?.(out.reason); }
    buzz([40, 50, 80]);
    if (pt.type === 'chest') this.opts.modal?.(`開出「${out.reward.label}」`, `<p class="sub">${out.reward.desc}</p>`);
    else {
      this.opts.toast?.(`成功佔領「${out.label}」,我方 +${out.heal}`);
      this.togglePoints(true);   // 佔領成功後直接顯示最新戰況
    }
  }

  closeScan() {
    this.scanner.stop();
    this.showView('game');
    this.detector.paused = false;
    this.detector.startPreview();
  }
}
