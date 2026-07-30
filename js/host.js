// ============================================================
//  host.js —— 主持人控台
// ============================================================
import qrcode from 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/+esm';
import {
  DEFAULTS, MARKER_COUNT, markerId, suggestMaxHp, parseHueRanges, MAX_TEAMS,
  startHpOf, maxHpOf
} from './config.js';
import { GameClient } from './game.js';
import { encodeMarker } from './scan.js';
import {
  qrToCanvas, qrToSVG, canvasToBlob, downloadBlob, downloadAllAsZip, safeName
} from './qrimage.js';

const $ = id => document.getElementById(id);
const game = new GameClient();
let tickTimer = null;
let started = false;

// ---------- 小工具 ----------
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(m, ms = 2400) {
  $('toast').textContent = m; $('toast').classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => $('toast').classList.add('hidden'), ms);
}
function loading(on, t = '載入中…') { $('loadingText').textContent = t; $('loading').classList.toggle('hidden', !on); }
function modal(title, body, btns) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalBtns').innerHTML = '';
  (btns || [{ text: '關閉' }]).forEach(b => {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
    el.textContent = b.text;
    el.onclick = () => { $('modal').classList.add('hidden'); b.onClick?.(); };
    $('modalBtns').appendChild(el);
  });
  $('modal').classList.remove('hidden');
}
function qrURL(text, cell = 6) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createDataURL(cell, 3);
}
function explain(e) {
  const m = String(e?.message || e);
  if (/permission[_ ]denied/i.test(m))
    return `${m}<br><br><b>常見原因:</b><br>1. Firebase 規則沒貼上或沒按發布<br>
            2. 資料庫還停在測試模式且已過期<br>3. Authentication 沒啟用「匿名」登入`;
  return m;
}

// ---------- 進入 ----------
$('btnCreate').onclick = async () => {
  const name = $('hostName').value.trim();
  if (!name) return toast('請先輸入你的名字');
  try {
    loading(true, '建立房間中…');
    const code = await game.createRoom(name);
    enterConsole(code);
  } catch (e) { $('enterErr').innerHTML = explain(e); }
  finally { loading(false); }
};

$('btnResume').onclick = () => {
  const code = $('resumeCode').value.trim().toUpperCase();
  if (!$('hostName').value.trim()) return toast('請先輸入你的名字');
  if (code.length < 4) return toast('請輸入 4 位房號');
  resumeRoom(code);
};

function enterConsole(code) {
  try { localStorage.setItem('cb_lastRoom', code); } catch (e) {}
  $('screen-enter').classList.add('hidden');
  $('console').classList.remove('hidden');
  $('codeChip').textContent = code;
  buildMarkerGrid();
  game.watchRoom(render);
  game.watchFeed(renderFeed);
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
}

// ---------- 我建立過的房間 ----------
const STATUS_TXT = { lobby: '大廳', running: '進行中', ended: '已結束' };

async function loadMyRooms() {
  let rooms = [];
  try { rooms = await game.myRooms(); }
  catch (e) { console.warn('讀取房間清單失敗:', e); return; }

  const wrap = $('myRoomsWrap'), ul = $('myRooms');
  if (!rooms.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  ul.innerHTML = '';

  rooms.forEach(r => {
    const li = document.createElement('li');
    if (r.missing) li.className = 'gone';
    const when = r.createdAt ? new Date(r.createdAt).toLocaleString('zh-TW',
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    li.innerHTML = `<div><div class="rc">${r.code}</div>
      <div class="meta">${r.missing ? '房間已不存在'
        : `${STATUS_TXT[r.status] || r.status} · ${r.players} 人`}${when ? '<br>' + when : ''}</div></div>`;

    const acts = document.createElement('div');
    acts.className = 'acts';
    if (!r.missing) {
      const back = document.createElement('button');
      back.textContent = '接手';
      back.onclick = () => resumeRoom(r.code);
      acts.appendChild(back);
    }
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = r.missing ? '移除紀錄' : '刪除';
    del.onclick = () => {
      if (r.missing) return game.forgetRoom(r.code).then(loadMyRooms);
      modal(`刪除房間 ${r.code}?`, '房間資料與紀錄會永久消失,無法復原。', [
        { text: '取消' },
        { text: '刪除', primary: true, onClick: async () => {
            await game.closeRoom(r.code); loadMyRooms(); toast(`已刪除 ${r.code}`);
          } }
      ]);
    };
    acts.appendChild(del);
    li.appendChild(acts);
    ul.appendChild(li);
  });
}

$('btnPurge').onclick = () => modal('清除舊房間?',
  '會刪除所有<b>已結束</b>的房間,以及清掉<b>已不存在</b>房間的紀錄。<br>大廳中與進行中的房間不會被動到。',
  [{ text: '取消' }, { text: '確定清除', primary: true, onClick: async () => {
      try {
        loading(true, '清除中…');
        const rooms = await game.myRooms(99);
        let n = 0;
        for (const r of rooms) {
          if (r.missing) { await game.forgetRoom(r.code); n++; }
          else if (r.status === 'ended') { await game.closeRoom(r.code); n++; }
        }
        await loadMyRooms();
        toast(n ? `已清除 ${n} 筆` : '沒有需要清除的房間');
      } catch (e) { modal('清除失敗', explain(e)); }
      finally { loading(false); }
    } }]);

async function resumeRoom(code) {
  const name = $('hostName').value.trim() || '主持人';
  try {
    loading(true, '連線中…');
    await game.joinRoom(code, name, 'host');
    if (!game.isHost) { await game.leave(); throw new Error('你不是這個房間的主持人'); }
    enterConsole(code);
  } catch (e) { $('enterErr').innerHTML = explain(e); }
  finally { loading(false); }
}

// ---------- 隊伍 ----------
function renderTeams(room) {
  const wrap = $('teamList');
  const ids = game.teamIds();
  const counts = {};
  ids.forEach(i => counts[i] = 0);
  Object.values(room.players || {}).forEach(p => { if (counts[p.team] !== undefined) counts[p.team]++; });

  // 只在結構改變時重建,避免使用者打字打到一半被洗掉
  const sig = ids.join(',');
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.innerHTML = ids.map(id => `
      <div class="teamcard" data-team="${id}">
        <div class="top">
          <span class="swatch-lg" data-role="sw"></span>
          <input class="nm field" data-f="label" maxlength="8"
                 style="background:transparent;border:none;padding:4px 0;font-size:15px;font-weight:700">
          <span class="cnt" data-role="cnt"></span>
          <button class="del" data-role="del">移除</button>
        </div>
        <div class="grid2">
          <label class="fieldset">色相範圍<input type="text" data-f="hue" placeholder="180-258"></label>
          <label class="fieldset">飽和度下限<input type="number" data-f="sat" min="0" max="1" step="0.01"></label>
          <label class="fieldset">亮度下限<input type="number" data-f="val" min="0" max="1" step="0.01"></label>
          <label class="fieldset">介面顏色<input type="color" data-f="accent"></label>
        </div>
        <div class="huepreview" data-role="hp"></div>
      </div>`).join('');

    wrap.querySelectorAll('.teamcard').forEach(card => {
      const id = card.dataset.team;
      card.querySelector('[data-role=del]').onclick = () =>
        modal('移除隊伍?', '該隊玩家會被移到其他隊。', [
          { text: '取消' },
          { text: '移除', primary: true, onClick: () => game.removeTeam(id).catch(e => toast(e.message)) }
        ]);
      card.querySelectorAll('[data-f]').forEach(inp => {
        inp.onchange = () => {
          const f = inp.dataset.f;
          if (f === 'label') game.updateTeam(id, { label: inp.value.slice(0, 8) || '隊伍' });
          else if (f === 'accent') game.updateTeam(id, { accent: inp.value });
          else game.updateTeam(id, { [`color/${f}`]: f === 'hue' ? inp.value : Number(inp.value) });
        };
      });
    });
  }

  ids.forEach(id => {
    const t = room.teams[id];
    const card = wrap.querySelector(`.teamcard[data-team="${id}"]`);
    if (!card) return;
    card.querySelector('[data-role=sw]').style.background = t.accent || '#888';
    card.querySelector('[data-role=cnt]').textContent = `${counts[id]} 人`;
    card.querySelector('[data-role=del]').style.display = ids.length > 2 ? '' : 'none';
    const set = (f, v) => {
      const inp = card.querySelector(`[data-f="${f}"]`);
      if (inp && document.activeElement !== inp) inp.value = v;
    };
    set('label', t.label || '');
    set('hue', t.color?.hue || '');
    set('sat', t.color?.sat ?? 0.3);
    set('val', t.color?.val ?? 0.25);
    set('accent', t.accent || '#888888');
    // 色相範圍在光譜條上的位置預覽
    const hp = card.querySelector('[data-role=hp]');
    hp.innerHTML = parseHueRanges(t.color?.hue).map(([lo, hi]) =>
      `<i style="left:${(lo / 360 * 100).toFixed(1)}%;width:${Math.max(1.2, (hi - lo) / 360 * 100).toFixed(1)}%"></i>`
    ).join('');
  });

  $('btnAddTeam').disabled = ids.length >= MAX_TEAMS;
}

$('btnAddTeam').onclick = () => game.addTeam().catch(e => toast(e.message));

// ---------- 參數 ----------
const cfgMap = {
  maxHp: 'cfgHp', startHpPct: 'cfgStartPct', durationMin: 'cfgDur', hitDamage: 'cfgDmg', fireCooldownSec: 'cfgCd',
  captureHealPct: 'cfgHealPct', holdRegenPct: 'cfgRegenPct', captureHoldSec: 'cfgHold',
  captureCooldownSec: 'cfgCapCd', chestCooldownSec: 'cfgChestCd'
};
Object.entries(cfgMap).forEach(([key, id]) => {
  $(id).onchange = () => {
    const v = Number($(id).value);
    if (Number.isFinite(v)) game.updateConfig({ [key]: v });
  };
});
$('cfgChest').onchange = e => game.updateConfig({ chestEnabled: e.target.checked });

$('btnSuggestHp').onclick = () => {
  const counts = {};
  game.teamIds().forEach(i => counts[i] = 0);
  Object.values(game.room?.players || {}).forEach(p => { if (counts[p.team] !== undefined) counts[p.team]++; });
  const per = Math.max(1, ...Object.values(counts));
  const dur = Number($('cfgDur').value) || DEFAULTS.durationMin;
  const pct = Number($('cfgStartPct').value) || DEFAULTS.startHpPct;
  const max = suggestMaxHp(per, dur, pct);
  $('cfgHp').value = max;
  game.updateConfig({ maxHp: max });
  const start = startHpOf({ maxHp: max, startHpPct: pct });
  $('hpAdvice').innerHTML =
    `以最多的一隊 <b>${per}</b> 人 × <b>${dur}</b> 分鐘推算,開場血量需要約 <b>${start}</b>,
     因此上限設為 <b>${max}</b>(開場 ${pct}%)。<br>
     估算基準是每人每分鐘平均命中 1.5 次。場地小、人擠人會更高,場地大就更低。
     <b>第一次辦強烈建議先跑一場 5 分鐘測試場</b>,看血量掉多快再回頭調。`;
};

// 上限與開場血量的即時換算顯示
function updateHpReadout(cfg) {
  const max = maxHpOf(cfg), start = startHpOf(cfg);
  $('hpReadout').textContent = `開場 ${start} / 上限 ${max} · 回血空間 ${max - start}`;
}

// ---------- 標記點 ----------
function buildMarkerGrid() {
  const grid = $('markerGrid');
  grid.innerHTML = '';
  for (let i = 1; i <= MARKER_COUNT; i++) {
    const mid = markerId(i);
    const d = document.createElement('div');
    d.className = 'marker off';
    d.dataset.mid = mid;
    d.innerHTML = `
      <div class="mhead"><span class="mid">${mid}</span>
        <button class="imgbtn" data-role="img" title="下載這一張的圖片">圖</button>
        <label><input type="checkbox" data-role="on"> 啟用</label></div>
      <select data-role="type">
        <option value="capture">搶佔點</option>
        <option value="chest">寶箱</option>
      </select>
      <input type="text" data-role="label" maxlength="16" placeholder="名稱,例如:司令台">`;
    const on = d.querySelector('[data-role=on]');
    const type = d.querySelector('[data-role=type]');
    const label = d.querySelector('[data-role=label]');
    const save = () => on.checked
      ? game.setMarker(mid, { type: type.value, label: label.value.trim() || mid })
      : game.clearMarker(mid);
    on.onchange = save; type.onchange = save; label.onchange = save;
    d.querySelector('[data-role=img]').onclick = () => showMarkerImage(mid);
    grid.appendChild(d);
  }
}

function renderMarkers(room) {
  const pts = room.points || {};
  $('markerGrid').querySelectorAll('.marker').forEach(d => {
    const p = pts[d.dataset.mid];
    const on = d.querySelector('[data-role=on]');
    const type = d.querySelector('[data-role=type]');
    const label = d.querySelector('[data-role=label]');
    d.classList.toggle('on', !!p);
    d.classList.toggle('off', !p);
    if (document.activeElement !== on) on.checked = !!p;
    if (p) {
      if (document.activeElement !== type) type.value = p.type;
      if (document.activeElement !== label) label.value = p.label || '';
    }
  });
}

// ---------- QR 圖片下載 ----------
function markerMeta(mid) {
  const p = game.room?.points?.[mid];
  return {
    id: mid,
    text: encodeMarker(mid),
    label: p ? p.label : '',
    sub: p ? (p.type === 'capture' ? '搶佔點' : '寶箱') : '通用標記'
  };
}

function showMarkerImage(mid) {
  const m = markerMeta(mid);
  const preview = qrToCanvas(m.text, { size: 480, label: m.label || m.id, sub: m.sub });
  modal(`${mid} 的 QR 圖片`,
    `<div class="qr-holder">
       <img src="${preview.toDataURL('image/png')}" style="width:210px;height:auto">
       <div class="qr-caption">${m.label ? esc(m.label) + ' · ' : ''}${m.sub}</div>
     </div>
     <p class="note">PNG 是高解析點陣圖(含名稱),直接印就很清楚。<br>
        SVG 是向量圖,放到多大都不會糊,適合丟進排版軟體自己調。</p>`,
    [
      { text: '下載 PNG', primary: true, onClick: async () => {
          const cv = qrToCanvas(m.text, { label: m.label || m.id, sub: m.sub });
          downloadBlob(await canvasToBlob(cv), safeName(m.label ? `${mid}_${m.label}` : mid) + '.png');
        } },
      { text: '下載純QR的SVG', onClick: () => {
          const svg = qrToSVG(m.text);
          downloadBlob(new Blob([svg], { type: 'image/svg+xml' }),
                       safeName(m.label ? `${mid}_${m.label}` : mid) + '.svg');
        } },
      { text: '關閉' }
    ]);
}

$('btnDownload').onclick = () => {
  const pts = game.room?.points || {};
  const enabled = Object.keys(pts).sort();
  const useAll = enabled.length === 0;
  const ids = useAll ? Array.from({ length: MARKER_COUNT }, (_, i) => markerId(i + 1)) : enabled;

  modal('下載標記圖片',
    (useAll
      ? '<p class="note">目前沒有啟用任何編號,將打包全部 20 組<b>通用標記</b>(只有編號、沒有名稱)。</p>'
      : `<p class="note">將打包本場啟用的 <b>${ids.length}</b> 組標記。</p>`) +
    `<p class="note">ZIP 內含兩個資料夾:<br>
       <b>含名稱_PNG</b> — 高解析點陣圖,附編號與名稱,可直接印<br>
       <b>純QR碼_SVG</b> — 向量圖,沒有文字,方便你自己排版</p>
     <p class="note" id="zipProgress"></p>`,
    [
      { text: '取消' },
      { text: '開始打包', primary: true, onClick: async () => {
          try {
            loading(true, '產生圖片中…');
            await downloadAllAsZip(
              ids.map(markerMeta),
              `標記QR碼_${game.code}.zip`,
              (i, n) => loading(true, `產生圖片中… ${i}/${n}`)
            );
            toast('已開始下載 ZIP');
          } catch (e) {
            console.error(e);
            modal('打包失敗', String(e.message || e));
          } finally { loading(false); }
        } }
    ]);
};

$('btnPrint').onclick = () => {
  const pts = game.room?.points || {};
  const cards = [];
  for (let i = 1; i <= MARKER_COUNT; i++) {
    const mid = markerId(i);
    const p = pts[mid];
    cards.push(`<div class="card">
      <img src="${qrURL(encodeMarker(mid), 8)}">
      <div class="mid">${mid}</div>
      <div class="nm">${p ? esc(p.label) : '(本場未啟用)'}</div>
      <div class="ty">${p ? (p.type === 'capture' ? '搶佔點' : '寶箱') : '通用標記'}</div>
    </div>`);
  }
  const w = window.open('', '_blank');
  if (!w) return toast('瀏覽器擋掉了新視窗,請允許彈出視窗');
  w.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
    <title>標記QR碼</title><style>
    body{font-family:sans-serif;margin:0;padding:14px;display:grid;
      grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px;}
    .card{border:2px dashed #999;border-radius:10px;padding:12px;text-align:center;page-break-inside:avoid;}
    .card img{width:100%;max-width:175px;}
    .mid{font-family:monospace;font-size:27px;font-weight:700;margin-top:6px;letter-spacing:.06em;}
    .nm{font-size:16px;margin-top:3px;}
    .ty{font-size:12px;color:#666;margin-top:2px;}
    @media print{.card{border-style:solid;}}
    </style></head><body>${cards.join('')}</body></html>`);
  w.document.close();
};

$('btnJoinQR').onclick = () => {
  const url = `${location.origin}${location.pathname.replace(/host\.html$/, '')}index.html?room=${game.code}`;
  modal('讓玩家掃這個加入',
    `<div class="qr-holder"><img src="${qrURL(url, 6)}">
     <div class="qr-caption">${esc(url)}<br>房號 <b>${game.code}</b></div></div>`);
};

// ---------- 控制 ----------
$('btnStart').onclick = () => {
  const counts = {};
  game.teamIds().forEach(i => counts[i] = 0);
  Object.values(game.room?.players || {}).forEach(p => { if (counts[p.team] !== undefined) counts[p.team]++; });
  const empty = game.teamIds().filter(i => counts[i] === 0).map(i => game.teamLabel(i));
  if (empty.length) return toast(`${empty.join('、')}還沒有人`);
  const pts = Object.keys(game.room?.points || {}).length;
  modal('開始遊戲?',
    game.teamIds().map(i => `${esc(game.teamLabel(i))} ${counts[i]} 人`).join(' · ') +
    (pts === 0 ? '<p class="note">目前沒有啟用任何標記點,將只能靠拍照得分。</p>' : `<p class="note">啟用 ${pts} 個標記點</p>`),
    [{ text: '再等等' }, { text: '開始', primary: true, onClick: () => game.startGame() }]);
};
$('btnEnd').onclick = () => modal('結束本場?', '所有人會進入結算畫面。',
  [{ text: '取消' }, { text: '確定結束', primary: true, onClick: () => game.endGame() }]);
$('btnLobby').onclick = () => game.backToLobby();
$('btnClose').onclick = () => modal('永久刪除房間?', '此動作無法復原。',
  [{ text: '取消' }, { text: '刪除', primary: true, onClick: async () => {
      try { localStorage.removeItem('cb_lastRoom'); } catch (e) {}
      await game.closeRoom(); location.reload();
    } }]);

// ---------- 渲染 ----------
function render(room) {
  if (!room) { toast('房間已不存在'); return; }
  const cfg = room.config || DEFAULTS;
  const status = room.meta?.status || 'lobby';

  const badge = $('statusBadge');
  badge.textContent = { lobby: '大廳', running: '進行中', ended: '已結束' }[status];
  badge.className = 'badge ' + (status === 'running' ? 'live' : status === 'ended' ? 'ended' : '');
  $('btnStart').textContent = status === 'ended' ? '重新開始' : '開始遊戲';
  $('ctrlHint').textContent = status === 'running'
    ? '遊戲進行中。玩家設定的變更要下一場才會生效。'
    : '設定好隊伍顏色、參數與標記點後就可以開始。';

  Object.entries(cfgMap).forEach(([key, id]) => {
    if (document.activeElement !== $(id)) $(id).value = cfg[key] ?? DEFAULTS[key];
  });
  if (document.activeElement !== $('cfgChest')) $('cfgChest').checked = cfg.chestEnabled !== false;
  updateHpReadout(cfg);

  renderTeams(room);
  renderMarkers(room);

  // 戰況
  $('hpBlocks').innerHTML = game.teamIds().map(id => {
    const t = room.teams[id];
    const max = t.maxHp || maxHpOf(cfg) || 1;
    const pct = Math.max(0, Math.min(1, (t.hp ?? 0) / max));
    return `<div class="hpblock">
      <div class="lbl"><span>${esc(t.label)}</span><b>${Math.round(t.hp ?? 0)} / ${max}</b></div>
      <div class="hpwrap"><i style="background:${t.accent};transform:scaleX(${pct})"></i></div>
    </div>`;
  }).join('');

  const players = Object.values(room.players || {}).filter(p => p.team !== 'host');
  const online = players.filter(p => p.online).length;
  $('dashStats').innerHTML = game.teamIds().map(id =>
    `<div><b>${room.teams[id].hits ?? 0}</b>${esc(room.teams[id].label)}命中</div>`).join('') +
    `<div><b>${online}/${players.length}</b>在線</div>`;

  renderPoints(room);
  renderPlayers(room);
}

function renderPoints(room) {
  const cfg = room.config || DEFAULTS;
  const pts = Object.entries(room.points || {}).sort(([a], [b]) => a.localeCompare(b));
  const ul = $('pointStatus');
  if (!pts.length) { ul.innerHTML = '<li style="color:var(--neutral)">尚未啟用任何標記點</li>'; return; }
  const now = Date.now();
  ul.innerHTML = pts.map(([mid, p]) => {
    const isChest = p.type === 'chest';
    const cd = (isChest ? cfg.chestCooldownSec : cfg.captureCooldownSec) * 1000;
    const left = p.lastAt ? Math.max(0, cd - (now - p.lastAt)) : 0;
    const owner = p.owner && room.teams[p.owner];
    return `<li>
      <span class="dot-own" style="background:${owner ? owner.accent : 'rgba(255,255,255,.25)'}"></span>
      <span class="tag">${mid}</span>
      <span class="tag">${isChest ? '寶箱' : '搶佔'}</span>
      <span>${esc(p.label)}</span>
      <span class="cd ${left ? '' : 'ready'}">${left ? `冷卻 ${Math.ceil(left / 1000)}s`
        : (isChest ? '可開啟' : (owner ? esc(owner.label) + '持有' : '無人佔領'))}</span></li>`;
  }).join('');
}

function renderPlayers(room) {
  const entries = Object.entries(room.players || {}).filter(([, p]) => p.team !== 'host');
  $('pCount').textContent = `${entries.length} 人`;
  const ul = $('playerList');
  ul.innerHTML = '';
  entries.sort((a, b) => (b[1].hits || 0) - (a[1].hits || 0)).forEach(([uid, p]) => {
    const t = room.teams[p.team];
    const li = document.createElement('li');
    if (!p.online) li.className = 'off';
    li.innerHTML = `<span class="dot-own" style="background:${t ? t.accent : '#888'}"></span>
      <span>${esc(p.name)}</span>
      <span class="stat" style="margin-left:8px">${p.hits || 0}命中 ${p.captures || 0}佔 ${p.chests || 0}箱</span>`;
    const sel = document.createElement('select');
    game.teamIds().forEach(id => {
      const o = document.createElement('option');
      o.value = id; o.textContent = room.teams[id].label;
      if (id === p.team) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => game.setTeam(sel.value, uid);
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '踢除';
    del.onclick = () => game.kick(uid);
    li.appendChild(sel); li.appendChild(del);
    ul.appendChild(li);
  });
}

function renderFeed(items) {
  $('feed').innerHTML = items.map(f =>
    `<li class="${f.type === 'hit' ? 'hit' : ''}">${esc(f.msg)}</li>`).join('');
}

function tick() {
  const room = game.room;
  if (!room) return;
  if (room.meta?.status === 'running') {
    const left = Math.max(0, (room.meta.endsAt || 0) - game.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $('hostTimer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $('hostTimer').classList.toggle('low', left < 60000);
    renderPoints(room);   // 冷卻倒數每秒更新
    game.refereeTick();
  } else {
    $('hostTimer').textContent = '--:--';
  }
}

// ---------- 啟動 ----------
(async () => {
  try {
    loading(true, '連線中…');
    await game.init();
    const r = new URLSearchParams(location.search).get('room');
    let last = null;
    try { last = localStorage.getItem('cb_lastRoom'); } catch (e) {}
    if (r) $('resumeCode').value = r.toUpperCase();
    else if (last) $('resumeCode').value = last;
    await loadMyRooms();
  } catch (e) { $('enterErr').innerHTML = explain(e); }
  finally { loading(false); }
})();
