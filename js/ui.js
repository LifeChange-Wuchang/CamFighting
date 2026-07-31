// ============================================================
//  ui.js —— 玩家端:加入房間、大廳、結算。遊戲畫面由 play.js 提供
// ============================================================
import { DEFAULTS, maxHpOf } from './config.js';
import { GameClient } from './game.js';
import { PlayUI } from './play.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const screens = { home: $('screen-home'), lobby: $('screen-lobby'), result: $('screen-result') };
const game = new GameClient();
let lastStatus = null;

function show(name) {
  Object.entries(screens).forEach(([k, s]) => s.classList.toggle('hidden', k !== name));
}
function toast(m, ms = 2200) {
  $('toast').textContent = m; $('toast').classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => $('toast').classList.add('hidden'), ms);
}
function loading(on, t = '載入中…') { $('loadingText').textContent = t; $('loading').classList.toggle('hidden', !on); }
function modal(title, body, btns) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalBtns').innerHTML = '';
  (btns || [{ text: '關閉' }]).forEach(b => {
    const x = document.createElement('button');
    x.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
    x.textContent = b.text;
    x.onclick = () => { $('modal').classList.add('hidden'); b.onClick?.(); };
    $('modalBtns').appendChild(x);
  });
  $('modal').classList.remove('hidden');
}
function explain(e) {
  const m = String(e?.message || e);
  if (/permission[_ ]denied/i.test(m))
    return `${m}<br><br><b>常見原因:</b><br>1. Firebase 規則沒貼上或沒按發布<br>
            2. 資料庫還停在測試模式且已過期<br>3. Authentication 沒啟用「匿名」登入`;
  return m;
}

const play = new PlayUI($('playRoot'), game, {
  toast, modal, loading,
  menuLabel: '選單',
  onMenu: () => {
    const t = game.teams();
    modal('選單',
      `<p class="sub">房號 <b>${game.code}</b><br>` +
      game.teamIds().map(i => `${esc(t[i].label)} ${Math.round(t[i].hp ?? 0)}`).join(' · ') + '</p>',
      [{ text: '返回遊戲' }, { text: '離開房間', onClick: leaveRoom }]);
  }
});

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
    game.watchFeed(items => play.renderFeed(items));
    show('lobby');
  } catch (e) { console.error(e); modal('加入失敗', explain(e)); }
  finally { loading(false); }
};

$('btnLeave').onclick = leaveRoom;
$('btnResultLeave').onclick = leaveRoom;
async function leaveRoom() {
  play.stop();
  lastStatus = null;
  await game.leave();
  show('home');
}

// ---------- 渲染 ----------
function render(room) {
  if (!room) { toast('房間已被關閉'); return leaveRoom(); }
  const status = room.meta?.status;
  const ids = game.teamIds();
  const myTeam = game.myTeam();

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

  play.render(room);

  if (status !== lastStatus) {
    lastStatus = status;
    if (status === 'running') { show('none'); play.start(); }
    else { play.stop(); show(status === 'ended' ? 'result' : 'lobby'); }
  }
  if (status === 'ended') fillResult(room);
}

function fillResult(room) {
  const ids = game.teamIds();
  const ranked = ids.map(id => ({ id, ...room.teams[id] })).sort((a, b) => (b.hp ?? 0) - (a.hp ?? 0));
  const top = ranked[0];
  const tie = ranked.length > 1 && Math.round(ranked[1].hp ?? 0) === Math.round(top.hp ?? 0);
  $('winnerText').textContent = tie ? '平手!' : `${top.label}獲勝`;
  $('endReason').textContent = room.meta?.endReason || '';

  $('resultScores').innerHTML =
    `<div class="score-row" style="grid-template-columns:repeat(${Math.min(ids.length, 2)},1fr)">` +
    ranked.map(t => `<div class="score" style="border-color:${t.accent}88">
      <b style="color:${t.accent}">${Math.round(t.hp ?? 0)}</b><span>${esc(t.label)}剩餘</span></div>`).join('') +
    '</div>';

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

// ---------- 每秒 ----------
setInterval(() => {
  play.tick();
  game.watchdogTick().catch(() => {});   // 控台若掛掉,由玩家端代為收尾
}, 250);

window.addEventListener('beforeunload', e => {
  if (game.room?.meta?.status === 'running') { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 啟動 ----------
(async () => {
  try {
    loading(true, '連線中…');
    game.onConnection = ok => $('netBadge').classList.toggle('hidden', ok);
    await game.init();
    const r = new URLSearchParams(location.search).get('room');
    if (r) $('homeCode').value = r.toUpperCase();
    show('home');
  } catch (e) { modal('無法啟動', explain(e)); }
  finally { loading(false); }
})();
