// ============================================================
//  設定檔 —— 部署前請先填入你自己的 Firebase 專案設定
// ============================================================
//  取得方式:Firebase Console → 專案設定 → 一般 → 你的應用程式 → 設定程式碼片段
//  注意:這些值本來就會公開在前端,不是機密。真正的防護來自
//        database.rules.json 的安全性規則。
export const firebaseConfig = {
  apiKey: "AIzaSyBX-fjAphNUsPHcrfnxtLYhoJEwpWIgpNM",
  authDomain: "camfighting.firebaseapp.com",
  databaseURL: "https://camfighting-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "camfighting",
  storageBucket: "camfighting.firebasestorage.app",
  messagingSenderId: "776759783679",
  appId: "1:776759783679:web:dd53d717d7f0e025ff5cca"
};

// ---- 遊戲預設參數(建立房間時可在畫面上調整)----
export const DEFAULTS = {
  startHp: 100,   // 每隊起始血量
  hitDamage: 1,   // 每次擊中扣多少血
  captureHeal: 5,   // 搶佔一個點,自己隊伍回多少血
  captureHoldSec: 5,   // 搶佔點需要對準幾秒
  fireCooldownSec: 3,   // 兩次開火之間的冷卻(防止連拍洗分)
  durationMin: 20,   // 單場時間(分鐘)
  chestCooldownSec: 120,   // 同一個寶箱多久後才能再開
  chestEnabled: true    // 是否啟用寶箱道具
};

// ---- 偵測參數 ----
// 活動前務必用實際頭巾、在現場燈光下重新測試 teamColors 的數值
export const DETECT = {
  aimFraction: 0.40,   // 準星框佔畫面短邊的比例
  cropExpand: 1.9,    // 送去偵測的裁切範圍相對準星的倍數
  detectSize: 640,    // 裁切後放大到的最小尺寸
  minConfidence: 0.35,   // 人臉偵測信心門檻(越低越寬鬆)
  mpVersion: "0.10.35",
  teamColors: {
    red: { label: "紅隊", hueRanges: [[0, 18], [342, 360]], sat: 0.35, val: 0.28 },
    blue: { label: "藍隊", hueRanges: [[195, 255]], sat: 0.30, val: 0.28 }
  }
};

// ---- 寶箱獎勵表(機率會自動normalize,不用剛好加起來100)----
export const CHEST_REWARDS = [
  { id: "heal_big", weight: 20, label: "補給箱", desc: "我方回復 8 點血量", effect: { type: "heal", amount: 8 } },
  { id: "heal_small", weight: 30, label: "急救包", desc: "我方回復 4 點血量", effect: { type: "heal", amount: 4 } },
  { id: "strike", weight: 20, label: "空襲指令", desc: "敵隊直接損失 5 點血量", effect: { type: "strike", amount: 5 } },
  { id: "double", weight: 20, label: "火力全開", desc: "接下來 30 秒你的傷害加倍", effect: { type: "double", seconds: 30 } },
  { id: "empty", weight: 10, label: "空箱子", desc: "什麼都沒有…下次再來", effect: { type: "none" } }
];

export const TEAM_LABEL = { red: "紅隊", blue: "藍隊" };
