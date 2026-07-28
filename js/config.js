// ============================================================
//  設定檔 —— 只有 Firebase 設定需要改這裡
//  遊戲參數、隊伍顏色都改到主持人控台(host.html)線上設定
// ============================================================
export const firebaseConfig = {
  apiKey:            "AIzaSyBX-fjAphNUsPHcrfnxtLYhoJEwpWIgpNM",
  authDomain:        "camfighting.firebaseapp.com",
  databaseURL:       "https://camfighting-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "camfighting",
  storageBucket:     "camfighting.firebasestorage.app",
  messagingSenderId: "776759783679",
  appId:             "1:776759783679:web:dd53d717d7f0e025ff5cca"
};

// ---- 固定的實體標記數量 ----
//  QR 碼內容是 CBG:M:01 ~ CBG:M:20,不含房號,所以印一次可以永遠重複使用。
//  每場遊戲由主持人在控台指定哪幾號啟用、是搶佔點還是寶箱、叫什麼名字。
export const MARKER_COUNT = 20;
export const markerId = n => 'M' + String(n).padStart(2, '0');

// ---- 遊戲預設參數 ----
export const DEFAULTS = {
  startHp:          100,  // 每隊起始血量 —— 務必用控台的「依人數建議」重算
  hitDamage:          1,  // 每次擊中扣多少血
  captureHealPct:     1,  // 搶下據點的當下,立刻回復「最大血量的百分之幾」
  holdRegenPct:       1,  // ★ 每持有一個據點,每分鐘持續回復最大血量的百分之幾
  captureHoldSec:     5,  // 搶佔需要對準幾秒
  captureCooldownSec: 0,  // 據點易主後的冷卻(預設 0 = 隨時可以互搶)
  fireCooldownSec:    3,  // 兩次開火之間的冷卻
  durationMin:       20,  // 單場時間(分鐘)
  chestCooldownSec: 180,  // 同一個寶箱多久後才能再開
  chestEnabled:    true   // 是否啟用寶箱道具
};

// 據點持續回血的結算間隔(毫秒)。由主持人控台負責結算。
export const REGEN_TICK_MS = 5000;

export const HP_PER_PLAYER_PER_MIN = 1.5;
export function suggestHp(playersPerTeam, durationMin) {
  const raw = Math.max(1, playersPerTeam) * Math.max(1, durationMin) * HP_PER_PLAYER_PER_MIN;
  return Math.max(30, Math.round(raw / 10) * 10);
}

// ---- 隊伍範本 ----
//  hue 用文字寫成「起-迄」,可以用逗號分隔多段(紅色會跨過 0 度所以需要兩段)。
//  ⚠️ 紅色的 sat 門檻刻意偏高:取樣點在額頭,沒戴頭巾時取到的是皮膚,
//     而皮膚色相約 10~30 度、飽和度 0.2~0.45,和淡紅高度重疊。
export const TEAM_PRESETS = [
  { label: '紅隊', accent: '#FF4757', color: { hue: '0-12,345-360', sat: 0.45, val: 0.25 } },
  { label: '藍隊', accent: '#3D8BFF', color: { hue: '180-258',      sat: 0.20, val: 0.22 } },
  { label: '綠隊', accent: '#3BD16F', color: { hue: '95-160',       sat: 0.30, val: 0.22 } },
  { label: '黃隊', accent: '#FFD447', color: { hue: '45-68',        sat: 0.45, val: 0.40 } }
];
export const MAX_TEAMS = 4;
export const teamId = n => 't' + n;

// ---- 偵測參數 ----
export const DETECT = {
  aimFraction:   0.40,
  cropExpand:    1.9,
  detectSize:    640,
  minConfidence: 0.35,
  mpVersion:     "0.10.35"
};

// ---- 寶箱獎勵表(都用最大血量的百分比,換人數不用重調)----
export const CHEST_REWARDS = [
  { id:"heal_big",   weight:20, label:"補給箱",   desc:"我方回復 3% 血量",         effect:{ type:"heal",   pct:3   } },
  { id:"heal_small", weight:30, label:"急救包",   desc:"我方回復 1.5% 血量",       effect:{ type:"heal",   pct:1.5 } },
  { id:"strike",     weight:20, label:"空襲指令", desc:"敵隊各損失 2% 血量",       effect:{ type:"strike", pct:2   } },
  { id:"double",     weight:20, label:"火力全開", desc:"接下來 30 秒你的傷害加倍", effect:{ type:"double", seconds:30 } },
  { id:"empty",      weight:10, label:"空箱子",   desc:"什麼都沒有…下次再來",      effect:{ type:"none" } }
];

// ---- 色相字串解析:"0-12,345-360" → [[0,12],[345,360]] ----
export function parseHueRanges(text) {
  return String(text || '')
    .split(',')
    .map(seg => seg.split('-').map(n => Number(n.trim())))
    .filter(p => p.length === 2 && p.every(Number.isFinite))
    .map(([a, b]) => [Math.max(0, a), Math.min(360, b)]);
}
export function hueRangesToText(ranges) {
  return ranges.map(([a, b]) => `${Math.round(a)}-${Math.round(b)}`).join(',');
}
