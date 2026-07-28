// ============================================================
//  設定檔 —— 部署前請先填入你自己的 Firebase 專案設定
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyBX-fjAphNUsPHcrfnxtLYhoJEwpWIgpNM",
  authDomain: "camfighting.firebaseapp.com",
  databaseURL: "https://camfighting-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "camfighting",
  storageBucket: "camfighting.firebasestorage.app",
  messagingSenderId: "776759783679",
  appId: "1:776759783679:web:dd53d717d7f0e025ff5cca"
};

// ---- 遊戲預設參數(建立房間後可在主持人畫面上調整)----
//  血量請用主持人畫面的「依人數建議」按鈕產生,不要沿用固定值:
//  人數不同,合理血量差很多。
export const DEFAULTS = {
  startHp:          100,  // 每隊起始血量 —— 務必依實際人數調整
  hitDamage:          1,  // 每次擊中扣多少血(固定值,當作計量單位)
  captureHealPct:     2,  // 搶下一個據點,自己隊回復「最大血量的百分之幾」
  captureHoldSec:     5,  // 搶佔需要對準幾秒
  captureCooldownSec:120, // 同一據點多久內不能再被搶(防止兩邊互搶刷血)
  fireCooldownSec:    3,  // 兩次開火之間的冷卻
  durationMin:       20,  // 單場時間(分鐘)
  chestCooldownSec: 180,  // 同一個寶箱多久後才能再開
  chestEnabled:    true   // 是否啟用寶箱道具
};

// 依人數推估合理血量:人數 × 分鐘數 × 每人每分鐘預期命中數
// 1.5 是大場地混戰的保守估計(等於每 40 秒成功命中一次)
export const HP_PER_PLAYER_PER_MIN = 1.5;
export function suggestHp(playersPerTeam, durationMin) {
  const raw = Math.max(1, playersPerTeam) * Math.max(1, durationMin) * HP_PER_PLAYER_PER_MIN;
  return Math.max(30, Math.round(raw / 10) * 10);
}

// ---- 偵測參數 ----
export const DETECT = {
  aimFraction:   0.40,
  cropExpand:    1.9,
  detectSize:    640,
  minConfidence: 0.35,
  mpVersion:     "0.10.35",

  // ⚠️ 這組數值一定要用 calibrate.html 對「實際買到的頭巾」重新校正。
  //
  //  紅隊的飽和度門檻刻意設得高(0.45),原因很重要:
  //  取樣區塊就在額頭上,如果有人沒戴頭巾,取到的會是皮膚。
  //  皮膚的色相大約 10~30 度、飽和度 0.2~0.45,跟淡紅色高度重疊。
  //  門檻放太鬆的話,沒戴頭巾的人會被判定成紅隊。
  //
  //  藍色沒有這個問題,所以門檻可以放寬,連水藍色都收得進來。
  teamColors: {
    red:  { label: "紅隊", hueRanges: [[0, 12], [345, 360]], sat: 0.45, val: 0.25 },
    blue: { label: "藍隊", hueRanges: [[180, 258]],           sat: 0.20, val: 0.22 }
  }
};

// ---- 寶箱獎勵表 ----
//  回血/扣血都用「最大血量的百分比」,這樣換人數時不用重調。
//  兩隊都能開同一個寶箱,所以整體是中性的,重點在搶時機。
export const CHEST_REWARDS = [
  { id:"heal_big",   weight:20, label:"補給箱",   desc:"我方回復 3% 血量",         effect:{ type:"heal",   pct:3   } },
  { id:"heal_small", weight:30, label:"急救包",   desc:"我方回復 1.5% 血量",       effect:{ type:"heal",   pct:1.5 } },
  { id:"strike",     weight:20, label:"空襲指令", desc:"敵隊直接損失 2% 血量",     effect:{ type:"strike", pct:2   } },
  { id:"double",     weight:20, label:"火力全開", desc:"接下來 30 秒你的傷害加倍", effect:{ type:"double", seconds:30 } },
  { id:"empty",      weight:10, label:"空箱子",   desc:"什麼都沒有…下次再來",      effect:{ type:"none" } }
];

export const TEAM_LABEL = { red: "紅隊", blue: "藍隊", host: "主持人" };
