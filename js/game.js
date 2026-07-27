// ============================================================
//  game.js —— Firebase 連線與所有遊戲規則
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getDatabase, ref, set, get, update, remove, push, onValue, off,
  runTransaction, onDisconnect, serverTimestamp, query, limitToLast
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

import { firebaseConfig, DEFAULTS, CHEST_REWARDS, TEAM_LABEL } from './config.js';

const CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXY34679';  // 去掉容易看錯的 0/O/1/I/L/S/5/B/8/2/Z
const enemyOf = t => (t === 'red' ? 'blue' : 'red');

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
    this.uid = null;
    this.code = null;
    this.me = null;          // { name, team }
    this.isHost = false;
    this.room = null;        // 最新的房間快照
    this.clockOffset = 0;    // 伺服器時間 - 本機時間
    this.listeners = [];
    this.onRoom = null;
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

    // 伺服器時鐘校正:各裝置的手機時間可能有偏差,計時要以伺服器為準
    onValue(ref(this.db, '.info/serverTimeOffset'), s => {
      this.clockOffset = s.val() || 0;
    });
    onValue(ref(this.db, '.info/connected'), s => {
      this.onConnection?.(!!s.val());
    });
    return this.uid;
  }

  now() { return Date.now() + this.clockOffset; }

  // ---------- 房間 ----------
  async createRoom(config, hostName) {
    const cfg = { ...DEFAULTS, ...config };
    // 極少數情況房號會撞號,重試幾次
    let code = null;
    for (let i = 0; i < 6; i++) {
      const c = makeCode(4);
      const snap = await get(ref(this.db, `rooms/${c}/meta`));
      if (!snap.exists()) { code = c; break; }
    }
    if (!code) throw new Error('房號產生失敗,請再試一次');

    await set(ref(this.db, `rooms/${code}`), {
      meta: {
        status: 'lobby',
        hostUid: this.uid,
        createdAt: serverTimestamp(),
        startedAt: null,
        endsAt: null
      },
      config: cfg,
      teams: {
        red:  { hp: cfg.startHp, maxHp: cfg.startHp, hits: 0, captures: 0 },
        blue: { hp: cfg.startHp, maxHp: cfg.startHp, hits: 0, captures: 0 }
      }
    });
    this.isHost = true;
    await this.joinRoom(code, hostName, null);
    return code;
  }

  async joinRoom(code, name, team) {
    code = String(code || '').toUpperCase().trim();
    const metaSnap = await get(ref(this.db, `rooms/${code}/meta`));
    if (!metaSnap.exists()) throw new Error('找不到這個房號');
    const meta = metaSnap.val();
    if (meta.status === 'ended') throw new Error('這場遊戲已經結束了');

    this.code = code;
    this.isHost = meta.hostUid === this.uid;

    // 沒指定隊伍就自動分配到人少的一邊
    if (!team) {
      const ps = (await get(ref(this.db, `rooms/${code}/players`))).val() || {};
      let r = 0, b = 0;
      Object.values(ps).forEach(p => { if (p.team === 'red') r++; else if (p.team === 'blue') b++; });
      team = r <= b ? 'red' : 'blue';
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
    // 斷線時自動標記離線,主持人才看得出誰掉線了
    onDisconnect(ref(this.db, `rooms/${code}/players/${this.uid}/online`)).set(false);

    this.me = { name, team };
    return team;
  }

  watchRoom(cb) {
    this.onRoom = cb;
    const r = ref(this.db, `rooms/${this.code}`);
    const h = onValue(r, snap => {
      this.room = snap.val();
      if (this.room?.players?.[this.uid]) {
        this.me = {
          name: this.room.players[this.uid].name,
          team: this.room.players[this.uid].team
        };
      }
      cb(this.room);
    });
    this.listeners.push(() => off(r, 'value', h));
  }

  watchFeed(cb, n = 12) {
    const q = query(ref(this.db, `rooms/${this.code}/feed`), limitToLast(n));
    const h = onValue(q, snap => {
      const arr = [];
      snap.forEach(c => { arr.push({ id: c.key, ...c.val() }); });
      cb(arr.reverse());
    });
    this.listeners.push(() => off(q, 'value', h));
  }

  myTeam() { return this.me?.team || this.room?.players?.[this.uid]?.team || null; }
  enemyTeam() { return enemyOf(this.myTeam()); }
  config() { return this.room?.config || DEFAULTS; }

  async setTeam(team, uid = this.uid) {
    await update(ref(this.db, `rooms/${this.code}/players/${uid}`), { team });
  }

  async kick(uid) {
    await remove(ref(this.db, `rooms/${this.code}/players/${uid}`));
  }

  // ---------- 主持人控制 ----------
  async startGame() {
    const cfg = this.config();
    const startedAt = this.now();
    await update(ref(this.db, `rooms/${this.code}`), {
      'meta/status': 'running',
      'meta/startedAt': startedAt,
      'meta/endsAt': startedAt + cfg.durationMin * 60000,
      'teams/red/hp': cfg.startHp,
      'teams/red/maxHp': cfg.startHp,
      'teams/red/hits': 0,
      'teams/red/captures': 0,
      'teams/blue/hp': cfg.startHp,
      'teams/blue/maxHp': cfg.startHp,
      'teams/blue/hits': 0,
      'teams/blue/captures': 0
    });
    // 清掉上一場殘留
    await remove(ref(this.db, `rooms/${this.code}/feed`));
    const pts = this.room?.points || {};
    for (const id of Object.keys(pts)) {
      await update(ref(this.db, `rooms/${this.code}/points/${id}`), { owner: null, lastAt: 0 });
    }
    const ps = this.room?.players || {};
    for (const uid of Object.keys(ps)) {
      await update(ref(this.db, `rooms/${this.code}/players/${uid}`), { hits: 0, captures: 0, chests: 0 });
    }
    await this.pushFeed('system', '遊戲開始!');
  }

  async endGame(reason = '主持人結束遊戲') {
    await update(ref(this.db, `rooms/${this.code}/meta`), {
      status: 'ended',
      endedAt: this.now(),
      endReason: reason
    });
    await this.pushFeed('system', reason);
  }

  async backToLobby() {
    await update(ref(this.db, `rooms/${this.code}/meta`), {
      status: 'lobby', startedAt: null, endsAt: null, endReason: null
    });
  }

  async updateConfig(patch) {
    await update(ref(this.db, `rooms/${this.code}/config`), patch);
  }

  // 只有主持人跑「裁判」檢查,避免所有人搶著寫同一筆資料
  async refereeTick() {
    if (!this.isHost || this.room?.meta?.status !== 'running') return;
    const t = this.room.teams || {};
    if ((t.red?.hp ?? 1) <= 0) return this.endGame(`${TEAM_LABEL.blue}獲勝:${TEAM_LABEL.red}血量歸零`);
    if ((t.blue?.hp ?? 1) <= 0) return this.endGame(`${TEAM_LABEL.red}獲勝:${TEAM_LABEL.blue}血量歸零`);
    if (this.room.meta.endsAt && this.now() >= this.room.meta.endsAt) return this.endGame('時間到');
  }

  // ---------- 遊戲動作 ----------
  fireCooldownLeft() {
    const cd = (this.config().fireCooldownSec || 0) * 1000;
    return Math.max(0, cd - (this.now() - this.lastFireAt));
  }

  isDoubleActive() { return this.now() < this.doubleUntil; }

  async registerHit() {
    if (this.room?.meta?.status !== 'running') return { ok: false, reason: '遊戲尚未開始' };
    if (this.fireCooldownLeft() > 0) return { ok: false, reason: '冷卻中' };

    this.lastFireAt = this.now();
    const enemy = this.enemyTeam();
    const dmg = (this.config().hitDamage || 1) * (this.isDoubleActive() ? 2 : 1);

    const res = await runTransaction(ref(this.db, `rooms/${this.code}/teams/${enemy}/hp`), cur => {
      if (cur === null) return cur;
      return Math.max(0, cur - dmg);
    });

    await runTransaction(ref(this.db, `rooms/${this.code}/teams/${this.myTeam()}/hits`), c => (c || 0) + 1);
    await runTransaction(ref(this.db, `rooms/${this.code}/players/${this.uid}/hits`), c => (c || 0) + 1);
    await this.pushFeed('hit', `${this.me.name} 擊中對手,${TEAM_LABEL[enemy]} -${dmg}`);

    return { ok: true, damage: dmg, enemyHp: res.snapshot.val() };
  }

  // 搶佔點:同一隊已擁有就不重複計分
  async capturePoint(pointId) {
    if (this.room?.meta?.status !== 'running') return { ok: false, reason: '遊戲尚未開始' };
    const pRef = ref(this.db, `rooms/${this.code}/points/${pointId}`);
    const snap = await get(pRef);
    if (!snap.exists()) return { ok: false, reason: '這個據點不屬於本場遊戲' };
    const pt = snap.val();
    if (pt.type !== 'capture') return { ok: false, reason: '這不是搶佔點' };

    const mine = this.myTeam();
    if (pt.owner === mine) return { ok: false, reason: '這個據點已經是你們的了' };

    const tx = await runTransaction(pRef, cur => {
      if (!cur) return cur;
      if (cur.owner === mine) return;           // 已被同隊搶下,放棄這次交易
      cur.owner = mine;
      cur.lastAt = Date.now();
      return cur;
    });
    if (!tx.committed) return { ok: false, reason: '慢了一步,已被搶走' };

    const heal = this.config().captureHeal || 0;
    await runTransaction(ref(this.db, `rooms/${this.code}/teams/${mine}/hp`), cur => {
      const max = this.room.teams[mine].maxHp || this.config().startHp;
      return Math.min(max, (cur || 0) + heal);
    });
    await runTransaction(ref(this.db, `rooms/${this.code}/teams/${mine}/captures`), c => (c || 0) + 1);
    await runTransaction(ref(this.db, `rooms/${this.code}/players/${this.uid}/captures`), c => (c || 0) + 1);
    await this.pushFeed('capture', `${this.me.name} 佔領了「${pt.label}」,${TEAM_LABEL[mine]} +${heal}`);
    return { ok: true, heal, label: pt.label };
  }

  // 寶箱:每個箱子有冷卻,避免一直重複開
  async openChest(pointId) {
    if (this.room?.meta?.status !== 'running') return { ok: false, reason: '遊戲尚未開始' };
    if (!this.config().chestEnabled) return { ok: false, reason: '本場未啟用寶箱' };
    const pRef = ref(this.db, `rooms/${this.code}/points/${pointId}`);
    const snap = await get(pRef);
    if (!snap.exists()) return { ok: false, reason: '這個寶箱不屬於本場遊戲' };
    const pt = snap.val();
    if (pt.type !== 'chest') return { ok: false, reason: '這不是寶箱' };

    const cd = (this.config().chestCooldownSec || 0) * 1000;
    const tx = await runTransaction(pRef, cur => {
      if (!cur) return cur;
      if (cur.lastAt && Date.now() - cur.lastAt < cd) return;   // 冷卻中,放棄交易
      cur.lastAt = Date.now();
      cur.owner = this.myTeam();
      return cur;
    });
    if (!tx.committed) {
      const left = Math.ceil((cd - (Date.now() - (pt.lastAt || 0))) / 1000);
      return { ok: false, reason: `這個寶箱冷卻中,還要 ${Math.max(0, left)} 秒` };
    }

    const reward = pickReward();
    const mine = this.myTeam(), enemy = enemyOf(mine);
    const e = reward.effect;

    if (e.type === 'heal') {
      await runTransaction(ref(this.db, `rooms/${this.code}/teams/${mine}/hp`), cur => {
        const max = this.room.teams[mine].maxHp || this.config().startHp;
        return Math.min(max, (cur || 0) + e.amount);
      });
    } else if (e.type === 'strike') {
      await runTransaction(ref(this.db, `rooms/${this.code}/teams/${enemy}/hp`), cur =>
        Math.max(0, (cur || 0) - e.amount));
    } else if (e.type === 'double') {
      this.doubleUntil = this.now() + e.seconds * 1000;
    }

    await runTransaction(ref(this.db, `rooms/${this.code}/players/${this.uid}/chests`), c => (c || 0) + 1);
    await this.pushFeed('chest', `${this.me.name} 開出「${reward.label}」`);
    return { ok: true, reward };
  }

  // ---------- 據點管理(主持人)----------
  async addPoint(label, type) {
    const r = push(ref(this.db, `rooms/${this.code}/points`));
    await set(r, { label: label.slice(0, 16), type, owner: null, lastAt: 0 });
    return r.key;
  }
  async removePoint(id) {
    await remove(ref(this.db, `rooms/${this.code}/points/${id}`));
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

export { enemyOf, makeCode };
