// ============================================================
//  game.js —— Firebase 連線與所有遊戲規則(支援多隊伍)
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getDatabase, ref, set, get, update, remove, push, onValue, off,
  runTransaction, onDisconnect, serverTimestamp, query, limitToLast
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

import {
  firebaseConfig, DEFAULTS, CHEST_REWARDS, TEAM_PRESETS, teamId, MAX_TEAMS, REGEN_TICK_MS,
  startHpOf, maxHpOf
} from './config.js';

const CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXY34679';

function makeCode(n = 4) {
  let s = '';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}

function pickReward() {
  const total = CHEST_REWARDS.reduce((a, r) => a + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of CHEST_REWARDS) { roll -= r.weight; if (roll <= 0) return r; }
  return CHEST_REWARDS[CHEST_REWARDS.length - 1];
}

export class GameClient {
  constructor() {
    this.app = null; this.db = null; this.auth = null;
    this.uid = null; this.code = null; this.me = null;
    this.isHost = false; this.room = null;
    this.clockOffset = 0;
    this.listeners = [];
    this.onConnection = null;
    this.lastFireAt = 0;
    this.doubleUntil = 0;
  }

  async init() {
    if (String(firebaseConfig.apiKey).startsWith('請填入')) {
      throw new Error('尚未設定 Firebase:請先編輯 js/config.js,填入你的專案設定');
    }
    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    this.db = getDatabase(this.app);
    await signInAnonymously(this.auth);
    this.uid = await new Promise(res => {
      const un = onAuthStateChanged(this.auth, u => { if (u) { un(); res(u.uid); } });
    });
    onValue(ref(this.db, '.info/serverTimeOffset'), s => { this.clockOffset = s.val() || 0; });
    onValue(ref(this.db, '.info/connected'), s => { this.onConnection?.(!!s.val()); });
    return this.uid;
  }

  now() { return Date.now() + this.clockOffset; }

  // ---------- 房間 ----------
  async createRoom(hostName) {
    let code = null;
    for (let i = 0; i < 6; i++) {
      const c = makeCode(4);
      if (!(await get(ref(this.db, `rooms/${c}/meta`))).exists()) { code = c; break; }
    }
    if (!code) throw new Error('房號產生失敗,請再試一次');

    const teams = {};
    const max0 = maxHpOf(DEFAULTS), start0 = startHpOf(DEFAULTS);
    TEAM_PRESETS.slice(0, 2).forEach((t, i) => {
      teams[teamId(i + 1)] = {
        label: t.label, accent: t.accent, color: { ...t.color }, order: i + 1,
        hp: start0, maxHp: max0, hits: 0, captures: 0
      };
    });

    await set(ref(this.db, `rooms/${code}`), {
      meta: { status: 'lobby', hostUid: this.uid, createdAt: serverTimestamp() },
      config: { ...DEFAULTS },
      teams
    });
    // 同時寫一筆索引到自己名下,之後才找得回這個房間
    await set(ref(this.db, `hostRooms/${this.uid}/${code}`), { createdAt: serverTimestamp() });
    this.isHost = true;
    await this.joinRoom(code, hostName, 'host');
    return code;
  }

  async joinRoom(code, name, team) {
    code = String(code || '').toUpperCase().trim();
    const metaSnap = await get(ref(this.db, `rooms/${code}/meta`));
    if (!metaSnap.exists()) throw new Error('找不到這個房號');
    const meta = metaSnap.val();

    this.code = code;
    this.isHost = meta.hostUid === this.uid;

    if (!team) {
      if (this.isHost) team = 'host';
      else {
        const teamsSnap = (await get(ref(this.db, `rooms/${code}/teams`))).val() || {};
        const ps = (await get(ref(this.db, `rooms/${code}/players`))).val() || {};
        const counts = {};
        Object.keys(teamsSnap).forEach(t => { counts[t] = 0; });
        Object.values(ps).forEach(p => { if (counts[p.team] !== undefined) counts[p.team]++; });
        team = Object.keys(counts).sort((a, b) => counts[a] - counts[b])[0] || 't1';
      }
    }

    const pRef = ref(this.db, `rooms/${code}/players/${this.uid}`);
    const existing = (await get(pRef)).val();
    await set(pRef, {
      name: String(name || '玩家').slice(0, 12),
      team,
      hits: existing?.hits || 0,
      captures: existing?.captures || 0,
      chests: existing?.chests || 0,
      isHost: this.isHost,
      online: true,
      joinedAt: existing?.joinedAt || serverTimestamp()
    });
    onDisconnect(ref(this.db, `rooms/${code}/players/${this.uid}/online`)).set(false);
    this.me = { name, team };
    return team;
  }

  watchRoom(cb) {
    const r = ref(this.db, `rooms/${this.code}`);
    const h = onValue(r, snap => {
      this.room = snap.val();
      const mine = this.room?.players?.[this.uid];
      if (mine) this.me = { name: mine.name, team: mine.team };
      cb(this.room);
    });
    this.listeners.push(() => off(r, 'value', h));
  }

  watchFeed(cb, n = 14) {
    const q = query(ref(this.db, `rooms/${this.code}/feed`), limitToLast(n));
    const h = onValue(q, snap => {
      const arr = []; snap.forEach(c => arr.push({ id: c.key, ...c.val() }));
      cb(arr.reverse());
    });
    this.listeners.push(() => off(q, 'value', h));
  }

  teams() { return this.room?.teams || {}; }
  teamIds() {
    return Object.keys(this.teams())
      .sort((a, b) => (this.teams()[a].order || 0) - (this.teams()[b].order || 0));
  }
  teamLabel(id) { return this.teams()[id]?.label || id; }
  myTeam() { return this.me?.team || this.room?.players?.[this.uid]?.team || null; }
  isSpectator() { return this.myTeam() === 'host'; }
  config() { return this.room?.config || DEFAULTS; }

  async setTeam(team, uid = this.uid) {
    await update(ref(this.db, `rooms/${this.code}/players/${uid}`), { team });
  }
  async kick(uid) { await remove(ref(this.db, `rooms/${this.code}/players/${uid}`)); }
  async updateConfig(patch) { await update(ref(this.db, `rooms/${this.code}/config`), patch); }

  // ---------- 隊伍管理(主持人)----------
  async addTeam() {
    const ids = this.teamIds();
    if (ids.length >= MAX_TEAMS) throw new Error(`最多 ${MAX_TEAMS} 隊`);
    let n = 1; while (ids.includes(teamId(n))) n++;
    const preset = TEAM_PRESETS[Math.min(n - 1, TEAM_PRESETS.length - 1)];
    const cfg = this.config();
    await set(ref(this.db, `rooms/${this.code}/teams/${teamId(n)}`), {
      label: preset.label, accent: preset.accent, color: { ...preset.color },
      order: ids.length + 1, hp: startHpOf(cfg), maxHp: maxHpOf(cfg), hits: 0, captures: 0
    });
    return teamId(n);
  }

  async removeTeam(id) {
    if (this.teamIds().length <= 2) throw new Error('至少要保留兩隊');
    const ps = this.room?.players || {};
    const fallback = this.teamIds().find(t => t !== id);
    for (const [uid, p] of Object.entries(ps)) {
      if (p.team === id) await this.setTeam(fallback, uid);
    }
    await remove(ref(this.db, `rooms/${this.code}/teams/${id}`));
  }

  async updateTeam(id, patch) {
    await update(ref(this.db, `rooms/${this.code}/teams/${id}`), patch);
  }

  // ---------- 標記點(固定編號,QR 碼可事先印好重複使用)----------
  async setMarker(mid, data) {
    await set(ref(this.db, `rooms/${this.code}/points/${mid}`), {
      label: String(data.label || mid).slice(0, 16),
      type: data.type === 'chest' ? 'chest' : 'capture',
      owner: null, lastAt: 0
    });
  }
  async clearMarker(mid) { await remove(ref(this.db, `rooms/${this.code}/points/${mid}`)); }

  // ---------- 主持人控制 ----------
  async startGame() {
    const cfg = this.config();
    const startedAt = this.now();
    const patch = {
      'meta/status': 'running',
      'meta/startedAt': startedAt,
      'meta/endsAt': startedAt + cfg.durationMin * 60000,
      'meta/endReason': null,
      'meta/lastRegenAt': startedAt
    };
    const maxHp = maxHpOf(cfg), startHp = startHpOf(cfg);
    for (const id of this.teamIds()) {
      patch[`teams/${id}/maxHp`] = maxHp;
      patch[`teams/${id}/hp`] = startHp;
      patch[`teams/${id}/hits`] = 0;
      patch[`teams/${id}/captures`] = 0;
    }
    await update(ref(this.db, `rooms/${this.code}`), patch);
    await remove(ref(this.db, `rooms/${this.code}/feed`));
    for (const id of Object.keys(this.room?.points || {})) {
      await update(ref(this.db, `rooms/${this.code}/points/${id}`), { owner: null, lastAt: 0 });
    }
    for (const uid of Object.keys(this.room?.players || {})) {
      await update(ref(this.db, `rooms/${this.code}/players/${uid}`), { hits: 0, captures: 0, chests: 0 });
    }
    await this.pushFeed('system', '遊戲開始!');
  }

  async endGame(reason = '主持人結束遊戲') {
    await update(ref(this.db, `rooms/${this.code}/meta`), {
      status: 'ended', endedAt: this.now(), endReason: reason
    });
    await this.pushFeed('system', reason);
  }

  async backToLobby() {
    await update(ref(this.db, `rooms/${this.code}/meta`), {
      status: 'lobby', startedAt: null, endsAt: null, endReason: null
    });
  }

  async closeRoom(code = this.code) {
    await remove(ref(this.db, `rooms/${code}`));
    await remove(ref(this.db, `hostRooms/${this.uid}/${code}`));
  }

  // 忘記索引但不刪房間(房間還在,只是不再出現在我的清單裡)
  async forgetRoom(code) {
    await remove(ref(this.db, `hostRooms/${this.uid}/${code}`));
  }

  // 我建立過的房間清單。會一併確認房間是否還存在、目前狀態與人數。
  async myRooms(limit = 24) {
    const snap = await get(ref(this.db, `hostRooms/${this.uid}`));
    const idx = snap.val() || {};
    const codes = Object.keys(idx)
      .sort((a, b) => (idx[b].createdAt || 0) - (idx[a].createdAt || 0))
      .slice(0, limit);

    const out = [];
    for (const code of codes) {
      const metaSnap = await get(ref(this.db, `rooms/${code}/meta`));
      if (!metaSnap.exists()) {
        out.push({ code, createdAt: idx[code].createdAt || 0, missing: true });
        continue;
      }
      const meta = metaSnap.val();
      const ps = (await get(ref(this.db, `rooms/${code}/players`))).val() || {};
      out.push({
        code,
        createdAt: idx[code].createdAt || meta.createdAt || 0,
        status: meta.status || 'lobby',
        players: Object.values(ps).filter(p => p.team !== 'host').length,
        missing: false
      });
    }
    return out;
  }

  // 只有主持人跑裁判檢查(勝負判定 + 據點持續回血結算)
  async refereeTick() {
    if (!this.isHost || this.room?.meta?.status !== 'running') return;

    await this.regenTick();

    const t = this.teams();
    const alive = Object.entries(t).filter(([, v]) => (v.hp ?? 0) > 0);
    if (alive.length === 1) return this.endGame(`${alive[0][1].label}獲勝:其他隊伍血量歸零`);
    if (alive.length === 0) return this.endGame('所有隊伍同時歸零,平手');
    if (this.room.meta.endsAt && this.now() >= this.room.meta.endsAt) return this.endGame('時間到');
  }

  // 據點持續回血:持有越多、持有越久,回得越多。
  // 用「距離上次結算經過多久」計算,所以就算控台分頁被瀏覽器降速,
  // 恢復時也會把中間漏掉的份量一次補上,不會少算。
  async regenTick() {
    const cfg = this.config();
    const pct = cfg.holdRegenPct || 0;
    if (pct <= 0) return;

    const now = this.now();
    const last = this.room.meta.lastRegenAt || now;
    const dt = now - last;
    if (dt < REGEN_TICK_MS) return;

    // 統計每隊目前持有幾個搶佔點
    const held = {};
    for (const p of Object.values(this.room.points || {})) {
      if (p.type === 'capture' && p.owner) held[p.owner] = (held[p.owner] || 0) + 1;
    }

    await update(ref(this.db, `rooms/${this.code}/meta`), { lastRegenAt: now });

    for (const [team, count] of Object.entries(held)) {
      const info = this.teams()[team];
      if (!info) continue;
      const max = info.maxHp || maxHpOf(cfg);
      const gain = max * (pct / 100) * count * (dt / 60000);
      if (gain <= 0) continue;
      await runTransaction(ref(this.db, `rooms/${this.code}/teams/${team}/hp`),
        cur => (cur === null ? cur : Math.min(max, cur + gain)));
    }
  }

  // ---------- 玩家動作 ----------
  fireCooldownLeft() {
    const cd = (this.config().fireCooldownSec || 0) * 1000;
    return Math.max(0, cd - (this.now() - this.lastFireAt));
  }
  isDoubleActive() { return this.now() < this.doubleUntil; }

  async registerHit(targetTeam) {
    if (this.room?.meta?.status !== 'running') return { ok: false, reason: '遊戲尚未開始' };
    if (this.isSpectator()) return { ok: false, reason: '你是控場者,不參與計分' };
    if (!targetTeam || !this.teams()[targetTeam]) return { ok: false, reason: '不是有效的隊伍' };
    if (targetTeam === this.myTeam()) return { ok: false, reason: '那是自己隊友' };
    if (this.fireCooldownLeft() > 0) return { ok: false, reason: '冷卻中' };

    this.lastFireAt = this.now();
    const dmg = (this.config().hitDamage || 1) * (this.isDoubleActive() ? 2 : 1);
    const res = await runTransaction(ref(this.db, `rooms/${this.code}/teams/${targetTeam}/hp`),
      cur => (cur === null ? cur : Math.max(0, cur - dmg)));

    await runTransaction(ref(this.db, `rooms/${this.code}/teams/${this.myTeam()}/hits`), c => (c || 0) + 1);
    await runTransaction(ref(this.db, `rooms/${this.code}/players/${this.uid}/hits`), c => (c || 0) + 1);
    await this.pushFeed('hit', `${this.me.name} 擊中${this.teamLabel(targetTeam)},-${dmg}`);
    return { ok: true, damage: dmg, hp: res.snapshot.val(), label: this.teamLabel(targetTeam) };
  }

  async capturePoint(mid) {
    if (this.room?.meta?.status !== 'running') return { ok: false, reason: '遊戲尚未開始' };
    if (this.isSpectator()) return { ok: false, reason: '控場者不參與搶佔' };
    const pRef = ref(this.db, `rooms/${this.code}/points/${mid}`);
    const snap = await get(pRef);
    if (!snap.exists()) return { ok: false, reason: '這個編號本場沒有啟用' };
    const pt = snap.val();
    if (pt.type !== 'capture') return { ok: false, reason: '這是寶箱,不是搶佔點' };

    const mine = this.myTeam();
    if (pt.owner === mine) return { ok: false, reason: '這個據點已經是你們的了' };

    const cd = (this.config().captureCooldownSec || 0) * 1000;
    if (pt.lastAt && Date.now() - pt.lastAt < cd) {
      return { ok: false, reason: `剛易主,還要 ${Math.ceil((cd - (Date.now() - pt.lastAt)) / 1000)} 秒` };
    }

    const tx = await runTransaction(pRef, cur => {
      if (!cur) return cur;
      if (cur.owner === mine) return;
      if (cur.lastAt && Date.now() - cur.lastAt < cd) return;
      cur.owner = mine; cur.lastAt = Date.now();
      return cur;
    });
    if (!tx.committed) return { ok: false, reason: '慢了一步,已被搶走' };

    const max = this.teams()[mine]?.maxHp || maxHpOf(this.config());
    const heal = Math.max(1, Math.round(max * (this.config().captureHealPct || 0) / 100));
    await runTransaction(ref(this.db, `rooms/${this.code}/teams/${mine}/hp`),
      cur => Math.min(max, (cur || 0) + heal));
    await runTransaction(ref(this.db, `rooms/${this.code}/teams/${mine}/captures`), c => (c || 0) + 1);
    await runTransaction(ref(this.db, `rooms/${this.code}/players/${this.uid}/captures`), c => (c || 0) + 1);
    await this.pushFeed('capture', `${this.me.name} 佔領「${pt.label}」,${this.teamLabel(mine)} +${heal}`);
    return { ok: true, heal, label: pt.label };
  }

  async openChest(mid) {
    if (this.room?.meta?.status !== 'running') return { ok: false, reason: '遊戲尚未開始' };
    if (this.isSpectator()) return { ok: false, reason: '控場者不能開寶箱' };
    if (!this.config().chestEnabled) return { ok: false, reason: '本場未啟用寶箱' };
    const pRef = ref(this.db, `rooms/${this.code}/points/${mid}`);
    const snap = await get(pRef);
    if (!snap.exists()) return { ok: false, reason: '這個編號本場沒有啟用' };
    const pt = snap.val();
    if (pt.type !== 'chest') return { ok: false, reason: '這是搶佔點,不是寶箱' };

    const cd = (this.config().chestCooldownSec || 0) * 1000;
    const tx = await runTransaction(pRef, cur => {
      if (!cur) return cur;
      if (cur.lastAt && Date.now() - cur.lastAt < cd) return;
      cur.lastAt = Date.now(); cur.owner = this.myTeam();
      return cur;
    });
    if (!tx.committed) {
      return { ok: false, reason: `冷卻中,還要 ${Math.ceil((cd - (Date.now() - (pt.lastAt || 0))) / 1000)} 秒` };
    }

    const reward = pickReward();
    const mine = this.myTeam(), e = reward.effect;
    const myMax = this.teams()[mine]?.maxHp || maxHpOf(this.config());
    let amount = 0;

    if (e.type === 'heal') {
      amount = Math.max(1, Math.round(myMax * e.pct / 100));
      await runTransaction(ref(this.db, `rooms/${this.code}/teams/${mine}/hp`),
        cur => Math.min(myMax, (cur || 0) + amount));
    } else if (e.type === 'strike') {
      // 多隊伍時,對「所有其他隊伍」各造成傷害
      for (const id of this.teamIds()) {
        if (id === mine) continue;
        const max = this.teams()[id]?.maxHp || maxHpOf(this.config());
        const dmg = Math.max(1, Math.round(max * e.pct / 100));
        amount = dmg;
        await runTransaction(ref(this.db, `rooms/${this.code}/teams/${id}/hp`),
          cur => Math.max(0, (cur || 0) - dmg));
      }
    } else if (e.type === 'double') {
      this.doubleUntil = this.now() + e.seconds * 1000;
    }

    await runTransaction(ref(this.db, `rooms/${this.code}/players/${this.uid}/chests`), c => (c || 0) + 1);
    await this.pushFeed('chest', `${this.me.name} 開出「${reward.label}」`);
    return { ok: true, reward, amount };
  }

  async pushFeed(type, msg) {
    await push(ref(this.db, `rooms/${this.code}/feed`), {
      type, msg, at: serverTimestamp(), team: this.myTeam() || null
    });
  }

  async leave() {
    if (this.code && this.uid) {
      try { await update(ref(this.db, `rooms/${this.code}/players/${this.uid}`), { online: false }); } catch (e) {}
    }
    this.listeners.forEach(fn => { try { fn(); } catch (e) {} });
    this.listeners = [];
    this.code = null; this.room = null; this.me = null; this.isHost = false;
  }
}

export { makeCode };
