// ============================================================
//  ui.js —— 玩家端畫面與互動
// ============================================================
import { DEFAULTS } from './config.js';
import { Detector } from './detect.js';
import { GameClient } from './game.js';
import { Scanner } from './scan.js';

const $ = id => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), scanwork: $('scanwork'), flash: $('flash'),
  netBadge: $('netBadge'), toast: $('toast'), loading: $('loading'), loadingText: $('loadingText'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalBtns: $('modalBtns')
};
const screens = {
  home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game'),
  scan: $('screen-scan'), result: $('screen-result')
};

const game = new GameClient();
const detector = new Detector(el.video, el.overlay);
const scanner = new Scanner(el.video, el.scanwork);

let current = 'home';
let cameraReady = false;
let shotBusy = false;
let wakeLock = null;
let lastStatus = null;

// ---------- 小工具 ----------
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function show(name) {
  current = name;
  Object.entries(screens).forEach(([k, s]) => s.classList.toggle('hidden', k !== name));
  const camScreen = (name === 'game' || name === 'scan');
  el.video.style.opacity = camScreen ? '1' : '0';
  // 掃描時要看得到鏡頭原始畫面,所以整個畫布收起來
  el.overlay.classList.toggle('hide', name !== 'game');
  el.overlay.style.opacity = camScreen ? '1' : '0';
}
function toast(m, ms = 2200) {
  el.toast.textContent = m; el.toast.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}
function loading(on, t = '載入中…') { el.loadingText.textContent = t; el.loading.classList.toggle('hidden', !on); }
function modal(title, body, btns) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = body;
  el.modalBtns.innerHTML = '';
  (btns || [{ text: '關閉' }]).forEach(b => {
    const x = document.createElement('button');
    x.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
    x.textContent = b.text;
    x.onclick = () => { el.modal.classList.add('hidden'); b.onClick?.(); };
    el.modalBtns.appendChild(x);
  });
  el.modal.classList.remove('hidden');
}
function buzz(p) { try { navigator.vibrate?.(p); } catch (e) {} }
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game.room?.meta?.status === 'running') keepAwake(true);
});
function explain(e) {
  const m = String(e?.message || e);
  if (/permission[_ ]denied/i.test(m))
    return `${m}<br><br><b>常見原因:</b><br>1. Firebase 規則沒貼上或沒按發布<br>
            2. 資料庫還停在測試模式且已過期<br>3. Authentication 沒啟用「匿名」登入`;
  return m;
}

// ---------- 加入 ----------
$('btnJoin').onclick = async () => {
  const name = $('homeName').value.trim();
  const code = $('homeCode').value.trim().toUpperCase();
  if (!name) return toast('請先輸入你的名字');
  if (code.length < 4) return toast('請輸入 4 位房號');
  try {
    loading(true, '加入房間中…');
    await game.joinRoom(code, name, null);
    $('lobbyCode').textContent = code;
    game.watchRoom(render);
    game.watchFeed(renderFeed);
    show('lobby');
  } catch (e) { console.error(e); modal('加入失敗', explain(e)); }
  finally { loading(false); }
};

$('btnLeave').onclick = leaveRoom;
$('btnResultLeave').onclick = leaveRoom;
async function leaveRoom() {
  scanner.stop(); detector.stopCamera(); cameraReady = false; keepAwake(false);
  lastStatus = null;
  await game.leave();
  show('home');
}

// ---------- 渲染 ----------
function render(room) {
  if (!room) { toast('房間已被關閉'); return leaveRoom(); }
  const cfg = room.config || DEFAULTS;
  const status = room.meta?.status;
  const ids = game.teamIds();
  const myTeam = game.myTeam();

  // --- 大廳隊伍欄 ---
  const counts = {};
  ids.forEach(i => counts[i] = 0);
  Object.values(room.players || {}).forEach(p => { if (counts[p.team] !== undefined) counts[p.team]++; });

  const cols = $('teamCols');
  cols.style.gridTemplateColumns = `repeat(${Math.min(ids.length, 2)},1fr)`;
  cols.innerHTML = ids.map(id => {
    const t = room.teams[id];
    const members = Object.values(room.players || {}).filter(p => p.team === id);
    return `<div class="team-col" style="border-color:${t.accent}66">
      <div class="team-title" style="color:${t.accent}">${esc(t.label)} ${counts[id]}</div>
      <ul class="plist">${members.map(p =>
        `<li class="${p.online ? '' : 'off'}"><span>${esc(p.name)}</span></li>`).join('')}</ul>
      <button class="btn tiny" data-team="${id}" ${id === myTeam ? 'disabled' : ''}>
        ${id === myTeam ? '你在這隊' : '加入' + esc(t.label)}</button>
    </div>`;
  }).join('');
  cols.querySelectorAll('button[data-team]').forEach(b => {
    b.onclick = () => game.setTeam(b.dataset.team);
  });

  $('lobbyStatus').textContent = { lobby: '等待開始', running: '進行中', ended: '已結束' }[status] || '';

  // --- 遊戲 HUD 血條 ---
  $('hpBars').innerHTML = ids.map(id => {
    const t = room.teams[id];
    const max = t.maxHp || cfg.startHp || 1;
    const pct = Math.max(0, Math.min(1, (t.hp ?? 0) / max));
    return `<div class="hpbar"><i style="background:${t.accent};transform:scaleX(${pct})"></i>
      <span>${esc(t.label)} ${Math.round(t.hp ?? 0)} / ${max}</span></div>`;
  }).join('');

  if (myTeam && myTeam !== 'host') {
    const others = ids.filter(i => i !== myTeam).map(i => esc(room.teams[i].label)).join('、');
    $('tagTeam').textContent = `你是${esc(room.teams[myTeam]?.label || '')} · 目標:${others}`;
  }

  // --- 狀態切換 ---
  if (status !== lastStatus) {
    lastStatus = status;
    if (status === 'running') enterGame();
    else if (status === 'ended') { scanner.stop(); detector.stopCamera(); cameraReady = false; keepAwake(false); show('result'); }
    else { scanner.stop(); detector.stopCamera(); cameraReady = false; keepAwake(false); show('lobby'); }
  }
  if (status === 'ended') fillResult(room);
}

function renderFeed(items) {
  $('feed').innerHTML = items.slice(0, 6).map(f =>
    `<li class="${f.type === 'hit' ? 'hit' : (f.type === 'system' ? 'system' : '')}">${esc(f.msg)}</li>`).join('');
}

function fillResult(room) {
  const ids = game.teamIds();
  const cfg = room.config || DEFAULTS;
  const ranked = ids.map(id => ({ id, ...room.teams[id] })).sort((a, b) => (b.hp ?? 0) - (a.hp ?? 0));
  const top = ranked[0];
  const tie = ranked.length > 1 && Math.round(ranked[1].hp ?? 0) === Math.round(top.hp ?? 0);
  $('winnerText').textContent = tie ? '平手!' : `${top.label}獲勝`;
  $('endReason').textContent = room.meta?.endReason || '';

  $('resultScores').innerHTML = `<div class="score-row" style="grid-template-columns:repeat(${Math.min(ids.length,2)},1fr)">` +
    ranked.map(t => `<div class="score" style="border-color:${t.accent}88">
      <b style="color:${t.accent}">${Math.round(t.hp ?? 0)}</b><span>${esc(t.label)}剩餘</span></div>`).join('') + '</div>';

  $('leaderboard').innerHTML = Object.values(room.players || {})
    .filter(p => p.team !== 'host')
    .sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.captures || 0) - (a.captures || 0))
    .map((p, i) => {
      const t = room.teams[p.team];
      return `<li><span class="rank">${i + 1}</span>
        <span class="dot" style="background:${t ? t.accent : '#888'}"></span>
        <span>${esc(p.name)}</span>
        <span class="stat">${p.hits || 0} 命中 · ${p.captures || 0} 佔領</span></li>`;
    }).join('');
}

async function enterGame() {
  show('game');
  keepAwake(true);
  if (!cameraReady) {
    try {
      loading(true, '啟動相機…');
      await detector.startCamera();
      const model = await detector.initModel(t => loading(true, t));
      $('tagModel').textContent = `模型:${model}`;
      cameraReady = true;
    } catch (e) {
      loading(false);
      return modal('相機啟動失敗', explain(e), [{ text: '重試', primary: true, onClick: enterGame }]);
    } finally { loading(false); }
  }
  detector.paused = false;
  detector.startPreview();
}

// ---------- 開火 ----------
$('btnFire').onclick = async () => {
  if (shotBusy || !cameraReady) return;
  if (game.isSpectator()) return toast('你是控場者,不參與計分');
  const left = game.fireCooldownLeft();
  if (left > 0) { buzz(40); return toast(`冷卻中,還要 ${(left / 1000).toFixed(1)} 秒`); }

  shotBusy = true;
  $('btnFire').disabled = true;
  el.flash.classList.remove('on'); void el.flash.offsetWidth; el.flash.classList.add('on');

  let res, title, detail, isHit = false;
  try { res = detector.shoot(game.teams()); }
  catch (e) {
    console.error(e);
    res = { found: false, teamId: null, detail: String(e.message || e) };
  }

  if (!res.found) {
    title = '未命中'; detail = res.detail; buzz(25);
    game.lastFireAt = game.now();
  } else if (!res.teamId) {
    title = '未命中';
    detail = `偵測到人臉,但額頭顏色不屬於任何隊伍<br>${res.detail}`;
    buzz(25); game.lastFireAt = game.now();
  } else if (res.teamId === game.myTeam()) {
    title = '那是隊友!';
    detail = `${esc(game.teamLabel(res.teamId))}是你自己人,不計分<br>${res.detail}`;
    buzz(25); game.lastFireAt = game.now();
  } else {
    const out = await game.registerHit(res.teamId);
    if (out.ok) {
      isHit = true; buzz([30, 40, 60]);
      title = '命中!';
      detail = `${esc(out.label)} -${out.damage},剩餘 ${Math.round(out.hp)}<br>${res.detail}`;
    } else {
      title = '未計分'; detail = `${out.reason}<br>${res.detail}`; buzz(25);
    }
  }

  $('srTitle').textContent = title;
  $('srDetail').innerHTML = detail;
  $('shotResult').className = 'shot-result show ' + (isHit ? 'hit' : 'miss');
  $('dismissLayer').classList.remove('hidden');
};

$('dismissLayer').onclick = () => {
  $('shotResult').classList.remove('show');
  $('dismissLayer').classList.add('hidden');
  detector.release();
  shotBusy = false;
  $('btnFire').disabled = false;
};

// ---------- 掃描 ----------
$('btnScan').onclick = () => {
  if (!cameraReady) return;
  detector.stopPreview();
  show('scan');            // 畫布收起,直接看得到鏡頭畫面
  setRing(0);
  $('scanInfo').textContent = '把標記的 QR 碼對準圓框內';

  scanner.start({
    holdSeconds: game.config().captureHoldSec || 5,
    onProgress: (payload, ratio) => {
      if (!payload) { setRing(0); $('scanInfo').textContent = '把標記的 QR 碼對準圓框內'; return; }
      const pt = game.room?.points?.[payload.mid];
      if (!pt) {
        setRing(0);
        $('scanInfo').textContent = `${payload.mid} 這一組本場沒有啟用`;
        return;
      }
      if (pt.type === 'chest') { scanner.stop(); handleScan(payload); return; }
      setRing(ratio);
      $('scanInfo').textContent = `佔領「${pt.label}」… ${(ratio * 100).toFixed(0)}%  請持續對準`;
    },
    onComplete: handleScan,
    onError: e => console.warn(e)
  });
};
function setRing(r) { $('scanRing').style.strokeDashoffset = String(339.3 * (1 - r)); }

async function handleScan(payload) {
  const pt = game.room?.points?.[payload.mid];
  const out = pt?.type === 'chest' ? await game.openChest(payload.mid)
                                   : await game.capturePoint(payload.mid);
  closeScan();
  if (!out.ok) { buzz(30); return toast(out.reason); }
  buzz([40, 50, 80]);
  if (pt.type === 'chest') modal(`開出「${out.reward.label}」`, `<p class="sub">${out.reward.desc}</p>`);
  else toast(`成功佔領「${out.label}」,我方 +${out.heal}`);
}
function closeScan() {
  scanner.stop();
  show('game');
  detector.paused = false;
  detector.startPreview();
}
$('btnScanClose').onclick = closeScan;

// ---------- 選單 ----------
$('btnMenu').onclick = () => {
  const t = game.teams();
  modal('選單',
    `<p class="sub">房號 <b>${game.code}</b><br>` +
    game.teamIds().map(i => `${esc(t[i].label)} ${Math.round(t[i].hp ?? 0)}`).join(' · ') + '</p>',
    [{ text: '返回遊戲' }, { text: '離開房間', onClick: leaveRoom }]);
};

// ---------- 每秒更新 ----------
setInterval(() => {
  const room = game.room;
  if (!room || room.meta?.status !== 'running') return;
  const left = Math.max(0, (room.meta.endsAt || 0) - game.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  const t = $('timer');
  t.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  t.classList.toggle('low', left < 60000);

  const cd = game.fireCooldownLeft();
  $('cooldownText').textContent = cd > 0 ? `冷卻 ${(cd / 1000).toFixed(1)}s` : '';

  $('buffs').innerHTML = game.isDoubleActive()
    ? `<div class="buff">傷害加倍 ${Math.ceil((game.doubleUntil - game.now()) / 1000)}s</div>` : '';
}, 250);

window.addEventListener('beforeunload', e => {
  if (game.room?.meta?.status === 'running') { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 啟動 ----------
(async () => {
  try {
    loading(true, '連線中…');
    game.onConnection = ok => el.netBadge.classList.toggle('hidden', ok);
    await game.init();
    const r = new URLSearchParams(location.search).get('room');
    if (r) $('homeCode').value = r.toUpperCase();
    show('home');
  } catch (e) { modal('無法啟動', explain(e)); }
  finally { loading(false); }
})();
