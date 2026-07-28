// ============================================================
//  ui.js —— 畫面切換與所有互動
// ============================================================
import qrcode from 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm';
import { DEFAULTS, TEAM_LABEL, CHEST_REWARDS, suggestHp } from './config.js';
import { Detector } from './detect.js';
import { GameClient } from './game.js';
import { Scanner, encodePoint } from './scan.js';

const $ = id => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), scanwork: $('scanwork'), flash: $('flash'),
  netBadge: $('netBadge'), toast: $('toast'), loading: $('loading'), loadingText: $('loadingText'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalBtns: $('modalBtns')
};
const screens = {
  home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game'),
  scan: $('screen-scan'), result: $('screen-result'), dash: $('screen-dash')
};

const game = new GameClient();
const detector = new Detector(el.video, el.overlay);
const scanner = new Scanner(el.video, el.scanwork);

let current = 'home';
let cameraReady = false;
let shotBusy = false;
let wakeLock = null;
let tickTimer = null;
let lastStatus = null;

// ---------------- 小工具 ----------------
function show(name) {
  current = name;
  Object.entries(screens).forEach(([k, s]) => s.classList.toggle('hidden', k !== name));
  // 只有遊戲和掃描畫面需要看到鏡頭
  const camScreen = (name === 'game' || name === 'scan');
  el.video.style.opacity = camScreen ? '1' : '0';
  el.overlay.style.opacity = camScreen ? '1' : '0';
}
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}
function loading(on, text = '載入中…') {
  el.loadingText.textContent = text;
  el.loading.classList.toggle('hidden', !on);
}
function modal(title, bodyHTML, buttons) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = bodyHTML;
  el.modalBtns.innerHTML = '';
  (buttons || [{ text: '關閉' }]).forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
    btn.textContent = b.text;
    btn.onclick = () => { el.modal.classList.add('hidden'); b.onClick?.(); };
    el.modalBtns.appendChild(btn);
  });
  el.modal.classList.remove('hidden');
}
function buzz(pattern) { try { navigator.vibrate?.(pattern); } catch (e) {} }
function qrDataURL(text, cell = 5) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createDataURL(cell, 3);
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch (e) { /* 不支援就算了,不影響遊戲 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && game.room?.meta?.status === 'running') keepAwake(true);
});

// ---------------- 首頁 ----------------
function explainError(e) {
  const msg = String(e?.message || e);
  if (/permission[_ ]denied/i.test(msg)) {
    return `${msg}<br><br><b>常見原因:</b><br>
      1. Firebase 的「規則」分頁還沒貼上 database.rules.json 的內容(或貼了沒按發布)<br>
      2. 資料庫還停在測試模式,而測試模式已經過期<br>
      3. Authentication 沒有啟用「匿名」登入方式`;
  }
  if (/network|offline|unavailable/i.test(msg)) {
    return `${msg}<br><br>看起來是網路問題,請確認手機有連上網路。`;
  }
  return msg;
}

$('btnCreate').onclick = async () => {
  const name = $('homeName').value.trim();
  if (!name) return toast('請先輸入你的名字');
  try {
    loading(true, '建立房間中…');
    const code = await game.createRoom({}, name);
    afterJoin(code);
  } catch (e) { console.error(e); modal('建立失敗', explainError(e)); }
  finally { loading(false); }
};

$('btnJoin').onclick = async () => {
  const name = $('homeName').value.trim();
  const code = $('homeCode').value.trim().toUpperCase();
  if (!name) return toast('請先輸入你的名字');
  if (code.length < 4) return toast('請輸入 4 位房號');
  try {
    loading(true, '加入房間中…');
    await game.joinRoom(code, name, null);
    afterJoin(code);
  } catch (e) { console.error(e); modal('加入失敗', explainError(e)); }
  finally { loading(false); }
};

function afterJoin(code) {
  $('lobbyCode').textContent = code;
  game.watchRoom(render);
  game.watchFeed(renderFeed);
  show('lobby');
  if (game.isHost && !tickTimer) {
    tickTimer = setInterval(() => game.refereeTick(), 1000);
  }
}

document.querySelectorAll('[data-join-team]').forEach(b => {
  b.onclick = () => game.setTeam(b.dataset.joinTeam);
});

$('btnShowJoinQR').onclick = () => {
  const url = `${location.origin}${location.pathname}?room=${game.code}`;
  modal('讓大家掃這個加入',
    `<div class="qr-holder"><img src="${qrDataURL(url, 6)}" alt="加入QR">
     <div class="qr-caption">${url}<br>房號 <b>${game.code}</b></div></div>`);
};

$('btnLeave').onclick = () => leaveRoom();
$('btnResultLeave').onclick = () => leaveRoom();
async function leaveRoom() {
  clearInterval(tickTimer); tickTimer = null;
  scanner.stop();
  detector.stopCamera(); cameraReady = false;
  keepAwake(false);
  await game.leave();
  show('home');
}

// ---------------- 主持人設定 ----------------
const cfgFields = {
  startHp: $('cfgHp'), durationMin: $('cfgDur'), hitDamage: $('cfgDmg'),
  fireCooldownSec: $('cfgCd'), captureHealPct: $('cfgHealPct'),
  captureHoldSec: $('cfgHold'), captureCooldownSec: $('cfgCapCd'),
  chestCooldownSec: $('cfgChestCd')
};
Object.entries(cfgFields).forEach(([key, input]) => {
  input.onchange = () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    game.updateConfig({ [key]: v });
  };
});
$('cfgChest').onchange = e => game.updateConfig({ chestEnabled: e.target.checked });

$('cfgHostPlays').onchange = async e => {
  if (e.target.checked) {
    const ps = Object.values(game.room?.players || {});
    const r = ps.filter(p => p.team === 'red').length;
    const b = ps.filter(p => p.team === 'blue').length;
    await game.setTeam(r <= b ? 'red' : 'blue');
  } else {
    await game.setTeam('host');
  }
};

$('btnSuggestHp').onclick = () => {
  const ps = Object.values(game.room?.players || {});
  const r = ps.filter(p => p.team === 'red').length;
  const b = ps.filter(p => p.team === 'blue').length;
  const per = Math.max(r, b, 1);
  const dur = Number($('cfgDur').value) || DEFAULTS.durationMin;
  const hp = suggestHp(per, dur);
  $('cfgHp').value = hp;
  game.updateConfig({ startHp: hp });
  $('hpAdvice').innerHTML =
    `以每隊 ${per} 人 × ${dur} 分鐘推算,建議血量 <b>${hp}</b>。<br>
     估算方式是每人每分鐘平均命中 1.5 次。如果你們場地小、人擠人,命中會更頻繁,可以再往上加;
     場地大、人分散就往下調。第一次辦建議先跑一場 5 分鐘的測試場感覺一下節奏。`;
};

$('btnAddPoint').onclick = async () => {
  const label = $('ptLabel').value.trim();
  if (!label) return toast('請輸入據點名稱');
  await game.addPoint(label, $('ptType').value);
  $('ptLabel').value = '';
};

$('btnStart').onclick = async () => {
  const players = Object.values(game.room?.players || {});
  const r = players.filter(p => p.team === 'red').length;
  const b = players.filter(p => p.team === 'blue').length;
  if (r === 0 || b === 0) return toast('兩隊都至少要有一個人');
  const pts = Object.keys(game.room?.points || {}).length;
  const warn = pts === 0 ? '<p class="hint">目前沒有任何據點,將只能靠拍照擊中得分。</p>' : '';
  modal('開始遊戲?', `紅隊 ${r} 人 · 藍隊 ${b} 人${warn}`, [
    { text: '再等等' },
    { text: '開始', primary: true, onClick: () => game.startGame() }
  ]);
};

$('btnPrintPoints').onclick = () => {
  const pts = game.room?.points || {};
  const ids = Object.keys(pts);
  if (!ids.length) return toast('還沒有任何據點');
  const cards = ids.map(id => {
    const p = pts[id];
    const payload = encodePoint(game.code, id, p.type);
    return `<div class="card">
      <img src="${qrDataURL(payload, 8)}">
      <div class="nm">${p.label}</div>
      <div class="ty">${p.type === 'capture' ? '搶佔點' : '寶箱'} · 房號 ${game.code}</div>
    </div>`;
  }).join('');
  const w = window.open('', '_blank');
  if (!w) return toast('瀏覽器擋掉了新視窗,請允許彈出視窗');
  w.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
    <title>據點QR碼 - 房號 ${game.code}</title><style>
    body{font-family:sans-serif;margin:0;padding:16px;display:grid;
      grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;}
    .card{border:2px dashed #999;border-radius:10px;padding:14px;text-align:center;page-break-inside:avoid;}
    .card img{width:100%;max-width:190px;}
    .nm{font-size:19px;font-weight:700;margin-top:8px;}
    .ty{font-size:12px;color:#666;margin-top:3px;}
    @media print{.card{border-style:solid;}}
    </style></head><body>${cards}</body></html>`);
  w.document.close();
};

// ---------------- 畫面渲染 ----------------
function render(room) {
  if (!room) { toast('房間已被關閉'); return leaveRoom(); }
  const status = room.meta?.status;
  const cfg = room.config || DEFAULTS;

  // --- 大廳 ---
  $('lobbyCode').textContent = game.code;
  $('hostPanel').classList.toggle('hidden', !game.isHost);
  $('lobbyHint').textContent = game.isHost ? '設定好之後按「開始遊戲」' : '等待主持人開始…';

  if (game.isHost && document.activeElement?.tagName !== 'INPUT') {
    Object.entries(cfgFields).forEach(([k, input]) => { input.value = cfg[k] ?? DEFAULTS[k]; });
    $('cfgChest').checked = cfg.chestEnabled !== false;
  }

  const players = room.players || {};

  // 主持人單獨一列,不算在任何一隊
  const hostEntry = Object.entries(players).find(([, p]) => p.isHost);
  $('hostRow').innerHTML = hostEntry
    ? `<span class="crown">主持</span><span>${escapeHTML(hostEntry[1].name)}</span>
       <span style="margin-left:auto">${hostEntry[1].team === 'host' ? '控場中(不下場)' : '也有下場玩'}</span>`
    : '';
  if (game.isHost && document.activeElement !== $('cfgHostPlays')) {
    $('cfgHostPlays').checked = game.myTeam() !== 'host';
  }

  ['red', 'blue'].forEach(team => {
    const list = $(team + 'List');
    const entries = Object.entries(players).filter(([, p]) => p.team === team);
    $(team + 'Count').textContent = entries.length;
    list.innerHTML = '';
    entries.forEach(([uid, p]) => {
      const li = document.createElement('li');
      if (!p.online) li.className = 'off';
      li.innerHTML = `<span>${escapeHTML(p.name)}</span>${p.isHost ? '<span class="crown">主持</span>' : ''}`;
      if (game.isHost && uid !== game.uid) {
        const k = document.createElement('button');
        k.className = 'kick'; k.textContent = '移除';
        k.onclick = () => game.kick(uid);
        li.appendChild(k);
      }
      list.appendChild(li);
    });
  });

  // 據點清單
  const plist = $('pointList');
  plist.innerHTML = '';
  Object.entries(room.points || {}).forEach(([id, p]) => {
    const li = document.createElement('li');
    const own = p.owner ? `<span class="own-${p.owner}">${TEAM_LABEL[p.owner]}</span>` : '<span>無人</span>';
    li.innerHTML = `<span class="tag">${p.type === 'capture' ? '搶佔' : '寶箱'}</span>
                    <span>${escapeHTML(p.label)}</span>${p.type === 'capture' ? own : ''}`;
    const qrBtn = document.createElement('button');
    qrBtn.textContent = 'QR';
    qrBtn.onclick = () => modal(p.label,
      `<div class="qr-holder"><img src="${qrDataURL(encodePoint(game.code, id, p.type), 7)}">
       <div class="qr-caption">${p.type === 'capture' ? '搶佔點' : '寶箱'} · 列印後貼在現場</div></div>`);
    const del = document.createElement('button');
    del.textContent = '刪除';
    del.onclick = () => game.removePoint(id);
    li.appendChild(qrBtn); li.appendChild(del);
    plist.appendChild(li);
  });

  // --- 遊戲 HUD ---
  const t = room.teams || {};
  ['red', 'blue'].forEach(team => {
    const hp = t[team]?.hp ?? 0, max = t[team]?.maxHp || cfg.startHp || 1;
    $('hp' + cap(team) + 'Fill').style.transform = `scaleX(${Math.max(0, Math.min(1, hp / max))})`;
    $('hp' + cap(team) + 'Text').textContent = `${TEAM_LABEL[team]} ${hp} / ${max}`;
  });
  const myTeam = game.myTeam();
  if (myTeam && myTeam !== 'host') {
    $('tagTeam').textContent = `你是${TEAM_LABEL[myTeam]} · 拍${TEAM_LABEL[game.enemyTeam()]}頭巾`;
  }

  if (game.isSpectator()) renderDash(room);

  // --- 狀態切換 ---
  if (status !== lastStatus) {
    lastStatus = status;
    if (status === 'running') {
      if (game.isSpectator()) { keepAwake(true); show('dash'); }
      else enterGame();
    }
    else if (status === 'ended') enterResult(room);
    else { // lobby
      scanner.stop(); detector.stopCamera(); cameraReady = false; keepAwake(false);
      show('lobby');
    }
  }
  if (status === 'ended' && current === 'result') fillResult(room);
}

function renderDash(room) {
  const cfg = room.config || DEFAULTS;
  const t = room.teams || {};
  $('dashCode').textContent = game.code;

  ['red', 'blue'].forEach(team => {
    const hp = t[team]?.hp ?? 0, max = t[team]?.maxHp || cfg.startHp || 1;
    $('dash' + cap(team) + 'Fill').style.transform = `scaleX(${Math.max(0, Math.min(1, hp / max))})`;
    $('dash' + cap(team) + 'Text').textContent = `${TEAM_LABEL[team]} ${hp} / ${max}`;
  });

  const players = Object.values(room.players || {});
  const alive = players.filter(p => p.online).length;
  $('dashStats').innerHTML = `
    <div><b>${t.red?.hits ?? 0}</b>紅隊命中</div>
    <div><b>${t.blue?.hits ?? 0}</b>藍隊命中</div>
    <div><b>${alive}/${players.length}</b>在線人數</div>`;

  // 據點:顯示目前歸屬與冷卻倒數
  const now = Date.now();
  const pts = Object.entries(room.points || {});
  $('dashPoints').innerHTML = pts.length ? '' : '<li style="color:var(--neutral)">尚未設定任何據點</li>';
  pts.forEach(([id, p]) => {
    const isChest = p.type === 'chest';
    const cd = (isChest ? cfg.chestCooldownSec : cfg.captureCooldownSec) * 1000;
    const left = p.lastAt ? Math.max(0, cd - (now - p.lastAt)) : 0;
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot-own ${p.owner || ''}"></span>
      <span class="tag">${isChest ? '寶箱' : '搶佔'}</span>
      <span>${escapeHTML(p.label)}</span>
      <span class="cd ${left ? '' : 'ready'}">${
        left ? `冷卻 ${Math.ceil(left / 1000)}s`
             : (isChest ? '可開啟' : (p.owner ? TEAM_LABEL[p.owner] + '持有' : '無人佔領'))}</span>`;
    $('dashPoints').appendChild(li);
  });

  // 玩家清單依命中數排序
  $('dashPlayers').innerHTML = '';
  Object.values(room.players || {})
    .filter(p => p.team !== 'host')
    .sort((a, b) => (b.hits || 0) - (a.hits || 0))
    .forEach(p => {
      const li = document.createElement('li');
      if (!p.online) li.className = 'off';
      li.innerHTML = `<span class="dot-own ${p.team}"></span><span>${escapeHTML(p.name)}</span>
        <span class="stat">${p.hits || 0} 命中 · ${p.captures || 0} 佔領 · ${p.chests || 0} 寶箱</span>`;
      $('dashPlayers').appendChild(li);
    });
}

$('btnDashEnd').onclick = () => modal('確定要結束本場?', '所有人會直接進入結算畫面。', [
  { text: '取消' },
  { text: '確定結束', primary: true, onClick: () => game.endGame('主持人結束遊戲') }
]);

function renderFeed(items) {
  const ul = $('feed');
  ul.innerHTML = '';
  items.slice(0, 6).forEach(f => {
    const li = document.createElement('li');
    li.className = f.type === 'hit' ? 'hit' : (f.type === 'system' ? 'system' : '');
    li.textContent = f.msg;
    ul.appendChild(li);
  });

  const dul = $('dashFeed');
  dul.innerHTML = '';
  items.forEach(f => {
    const li = document.createElement('li');
    if (f.type === 'hit') li.className = 'hit';
    li.textContent = f.msg;
    dul.appendChild(li);
  });
}

async function enterGame() {
  show('game');
  keepAwake(true);
  if (!cameraReady) {
    try {
      loading(true, '啟動相機…');
      await detector.startCamera();
      const model = await detector.initModel(txt => loading(true, txt));
      $('tagModel').textContent = `模型:${model}`;
      cameraReady = true;
    } catch (e) {
      loading(false);
      return modal('相機啟動失敗', String(e.message || e), [{ text: '重試', primary: true, onClick: enterGame }]);
    } finally { loading(false); }
  }
  detector.paused = false;
  detector.startPreview();
}

function enterResult(room) {
  scanner.stop(); detector.stopCamera(); cameraReady = false; keepAwake(false);
  fillResult(room);
  show('result');
}

function fillResult(room) {
  const t = room.teams || {};
  const r = t.red?.hp ?? 0, b = t.blue?.hp ?? 0;
  $('resRedHp').textContent = r;
  $('resBlueHp').textContent = b;
  $('winnerText').textContent = r === b ? '平手!' : (r > b ? '紅隊獲勝' : '藍隊獲勝');
  $('endReason').textContent = room.meta?.endReason || '';
  $('hostResultBtns').classList.toggle('hidden', !game.isHost);

  const lb = $('leaderboard');
  lb.innerHTML = '';
  Object.values(room.players || {})
    .sort((x, y) => (y.hits || 0) - (x.hits || 0) || (y.captures || 0) - (x.captures || 0))
    .forEach((p, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank">${i + 1}</span><span class="dot ${p.team}"></span>
        <span>${escapeHTML(p.name)}</span>
        <span class="stat">${p.hits || 0} 擊中 · ${p.captures || 0} 佔領</span>`;
      lb.appendChild(li);
    });
}
$('btnAgain').onclick = () => game.backToLobby();

// ---------------- 開火 ----------------
$('btnFire').onclick = async () => {
  if (shotBusy || !cameraReady) return;
  if (game.isSpectator()) return toast('你是控場者,不參與計分');
  const left = game.fireCooldownLeft();
  if (left > 0) { buzz(40); return toast(`冷卻中,還要 ${(left / 1000).toFixed(1)} 秒`); }

  shotBusy = true;
  $('btnFire').disabled = true;
  el.flash.classList.remove('on'); void el.flash.offsetWidth; el.flash.classList.add('on');

  let res;
  try { res = detector.shoot(game.enemyTeam()); }
  catch (e) {
    console.error(e);
    res = { hit: false, title: '偵測失敗', detail: String(e.message || e) };
  }

  if (res.hit) {
    buzz([30, 40, 60]);
    const out = await game.registerHit();
    if (!out.ok) res.detail += `<br><b>未計分:${out.reason}</b>`;
    else res.detail += `<br>對方 -${out.damage},剩餘 ${out.enemyHp}`;
  } else {
    buzz(25);
    game.lastFireAt = game.now();   // 沒中也要冷卻,避免無限連拍
  }
  showShot(res);
};

function showShot(res) {
  $('srTitle').textContent = res.title;
  $('srDetail').innerHTML = res.detail || '';
  const box = $('shotResult');
  box.className = 'shot-result show ' + (res.hit ? 'hit' : 'miss');
  $('dismissLayer').classList.remove('hidden');
}
$('dismissLayer').onclick = () => {
  $('shotResult').classList.remove('show');
  $('dismissLayer').classList.add('hidden');
  detector.release();
  shotBusy = false;
  $('btnFire').disabled = false;
};

// ---------------- 掃描據點 ----------------
$('btnScan').onclick = () => {
  if (!cameraReady) return;
  detector.stopPreview();
  detector.ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  show('scan');
  setRing(0);
  $('scanInfo').textContent = '把據點的 QR 碼對準框內';

  scanner.start({
    holdSeconds: game.config().captureHoldSec || 5,
    onProgress: (payload, ratio) => {
      if (!payload) { setRing(0); $('scanInfo').textContent = '把據點的 QR 碼對準框內'; return; }
      if (payload.code !== game.code) {
        setRing(0);
        $('scanInfo').textContent = '這個 QR 碼屬於別場遊戲';
        return;
      }
      if (payload.type === 'chest') {   // 寶箱不用等待,掃到就開
        scanner.stop();
        handleScan(payload);
        return;
      }
      setRing(ratio);
      $('scanInfo').textContent = `佔領中… ${(ratio * 100).toFixed(0)}%  請持續對準`;
    },
    onComplete: handleScan,
    onError: e => console.warn(e)
  });
};
function setRing(ratio) {
  const C = 339.3;
  $('scanRing').style.strokeDashoffset = String(C * (1 - ratio));
}
async function handleScan(payload) {
  const out = payload.type === 'chest'
    ? await game.openChest(payload.pointId)
    : await game.capturePoint(payload.pointId);

  closeScan();
  if (!out.ok) { buzz(30); return toast(out.reason); }
  buzz([40, 50, 80]);
  if (payload.type === 'chest') {
    modal(`開出「${out.reward.label}」`, `<p class="sub">${out.reward.desc}</p>`);
  } else {
    toast(`成功佔領「${out.label}」,我方 +${out.heal}`);
  }
}
function closeScan() {
  scanner.stop();
  show('game');
  detector.paused = false;
  detector.startPreview();
}
$('btnScanClose').onclick = closeScan;

// ---------------- 遊戲中選單 ----------------
$('btnMenu').onclick = () => {
  const btns = [{ text: '返回遊戲' }];
  if (game.isHost) btns.push({
    text: '結束本場', primary: true,
    onClick: () => modal('確定要結束?', '所有人都會直接進入結算畫面。', [
      { text: '取消' }, { text: '確定結束', primary: true, onClick: () => game.endGame('主持人結束遊戲') }
    ])
  });
  else btns.push({ text: '離開房間', onClick: () => leaveRoom() });
  const t = game.room?.teams || {};
  modal('選單',
    `<p class="sub">房號 <b>${game.code}</b><br>
     紅隊 ${t.red?.hp ?? 0} · 藍隊 ${t.blue?.hp ?? 0}<br>
     ${game.isHost ? '你是主持人' : ''}</p>`, btns);
};

// ---------------- 每秒更新:計時、冷卻、增益 ----------------
setInterval(() => {
  const room = game.room;
  if (!room || room.meta?.status !== 'running') return;

  const left = Math.max(0, (room.meta.endsAt || 0) - game.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  const txt = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  [$('timer'), $('dashTimer')].forEach(tEl => {
    tEl.textContent = txt;
    tEl.classList.toggle('low', left < 60000);
  });

  // 控場者畫面每秒重畫,冷卻倒數才會跳動
  if (game.isSpectator()) { renderDash(room); return; }

  const cd = game.fireCooldownLeft();
  $('cooldownText').textContent = cd > 0 ? `冷卻 ${(cd / 1000).toFixed(1)}s` : '';
  $('btnFire').disabled = shotBusy;

  const buffs = $('buffs');
  buffs.innerHTML = '';
  if (game.isDoubleActive()) {
    const d = document.createElement('div');
    d.className = 'buff';
    d.textContent = `傷害加倍 ${Math.ceil((game.doubleUntil - game.now()) / 1000)}s`;
    buffs.appendChild(d);
  }
}, 250);

// ---------------- 其他 ----------------
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.addEventListener('beforeunload', e => {
  if (game.room?.meta?.status === 'running') { e.preventDefault(); e.returnValue = ''; }
});

// ---------------- 啟動 ----------------
(async () => {
  try {
    loading(true, '連線中…');
    game.onConnection = ok => el.netBadge.classList.toggle('hidden', ok);
    await game.init();
    const room = new URLSearchParams(location.search).get('room');
    if (room) $('homeCode').value = room.toUpperCase();
    show('home');
  } catch (e) {
    modal('無法啟動', String(e.message || e));
  } finally { loading(false); }
})();
