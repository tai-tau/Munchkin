/* ============================================================
   סופר מאנצ'קין־אסטרייכר — שרת מלא
   מכונת מצבים לפי המפרט. אכיפה מקלה, לא הרמטית.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, "cards.json"), "utf8"));

const shuffle = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
};

function buildDeck(which) {
  const out = []; let n = 0;
  for (const c of CARDS) {
    if (c.deck !== which) continue;
    for (let i = 0; i < (c.copies || 1); i++) out.push({ ...c, uid: `${which}${n++}` });
  }
  return shuffle(out);
}

const S = {
  players: [], door: buildDeck("door"), treasure: buildDeck("treasure"),
  doorDiscard: [], treasureDiscard: [],
  turn: 0, phase: "LOBBY", log: [], started: false, strict: true,
  combat: null, pending: null,
};

const PH = {
  LOBBY: "ממתינים לשחקנים",
  START: "תחילת תור — שחררו ציוד, ואז פתחו דלת",
  COMBAT: "קרב",
  AFTER: "חפשו צרות או בזזו את החדר",
  END: "סוף תור — גבול יד 5",
};

function log(m) { S.log.unshift({ t: Date.now(), m }); if (S.log.length > 80) S.log.pop(); }
const me = (id) => S.players.find((p) => p.id === id);
const cur = () => S.players[S.turn];

function draw(w) {
  const d = w === "door" ? S.door : S.treasure;
  const dis = w === "door" ? S.doorDiscard : S.treasureDiscard;
  if (!d.length) {
    if (!dis.length) return null;
    d.push(...shuffle(dis.splice(0)));
    log(`חפיסת ה${w === "door" ? "דלת" : "אוצר"} עורבבה מחדש`);
  }
  return d.pop();
}
const toss = (c) => (c.deck === "door" ? S.doorDiscard : S.treasureDiscard).push(c);

const SLOTCAP = { "כיסוי ראש": 1, "שריון": 1, "נעליים": 1 };

/* כמה משבצות ידיים תפוסות */
function handsUsed(p) {
  let n = 0;
  for (const c of p.table)
    if (c.equipped && c.type === "item") {
      if (c.slot === "שתי ידיים") n += 2;
      else if (c.slot === "יד אחת") n += 1;
    }
  return n;
}
function slotUsed(p, slot) {
  return p.table.filter((c) => c.equipped && c.type === "item" && c.slot === slot).length;
}
function bigCarried(p) {
  return p.table.filter((c) => c.size === "גדול").length;
}

/* האם מותר לצייד — מחזיר null אם כן, או סיבה */
function canEquip(p, c) {
  if (c.type !== "item") return null;
  if (c.slot === "שתי ידיים" && handsUsed(p) > 0) return "שתי הידיים תפוסות";
  if (c.slot === "יד אחת" && handsUsed(p) >= 2) return "אין יד פנויה";
  if (SLOTCAP[c.slot] && slotUsed(p, c.slot) >= SLOTCAP[c.slot]) return `יש לך כבר ${c.slot}`;
  return null;
}

function playerPower(p) {
  let v = p.level;
  for (const c of p.table) if (c.type === "item" && c.equipped) v += c.bonus || 0;
  return v;
}
/* קרב שנשאר בלי מפלצות ובלי קלפים — מתפוגג */
function tidyCombat() {
  if (!S.combat) return;
  const empty = !S.combat.monsters.length && !S.combat.mine.length && !S.combat.against.length;
  if (empty) { S.combat = null; if (S.phase === "COMBAT") S.phase = "START"; }
}

function combatPower() {
  if (!S.combat) return null;
  const p = cur();
  let mine = playerPower(p) + (S.combat.helperBonus || 0);
  for (const c of S.combat.mine) mine += c.bonus || 0;
  let mon = 0;
  for (const m of S.combat.monsters) mon += (m.level || 0) + (m.bonusApplied || 0);
  for (const c of S.combat.against) mon += c.bonus || 0;
  return { mine, mon };
}

const A = {
  setStrict({ pid, on }) {
    S.strict = !!on;
    log(`${me(pid)?.name || "מישהו"} ${on ? "הפעיל" : "כיבה"} אכיפת חוקים`);
  },

  join({ name, sex }) {
    let p = S.players.find((x) => x.name === name);
    if (p) { p.on = true; return { id: p.id }; }
    p = { id: Math.random().toString(36).slice(2, 9), name, sex: sex || "גבר",
          level: 1, aura: 0, hand: [], table: [], on: true };
    S.players.push(p); log(`${name} הצטרף`);
    return { id: p.id };
  },

  start() {
    S.door = buildDeck("door"); S.treasure = buildDeck("treasure");
    S.doorDiscard = []; S.treasureDiscard = []; S.combat = null; S.pending = null;
    S.turn = 0; S.started = true; S.phase = "START"; S.log = [];
    for (const p of S.players) {
      p.level = 1; p.aura = 0; p.hand = []; p.table = [];
      for (let i = 0; i < 4; i++) { const c = draw("door"); if (c) p.hand.push(c); }
      for (let i = 0; i < 4; i++) { const c = draw("treasure"); if (c) p.hand.push(c); }
    }
    log(`המשחק התחיל. תורו של ${cur().name}.`);
  },

  kickDoor({ pid }) {
    if (S.strict && S.phase !== "START") return { err: "אפשר לפתוח דלת רק בתחילת התור" };
    const p = me(pid); if (!p) return; if (S.strict && p.id !== cur().id) return { err: "לא תורך" };
    const c = draw("door"); if (!c) return { err: "החפיסה ריקה" };
    log(`${p.name} פתח דלת: ${c.name}`);
    if (c.type === "monster") {
      S.combat = { monsters: [c], mine: [], against: [], helper: null, helperBonus: 0 };
      S.phase = "COMBAT"; return { drew: c, combat: true };
    }
    if (c.type === "curse" || c.type === "trap") {
      p.table.push({ ...c, equipped: false }); S.phase = "AFTER";
      return { drew: c, curse: true };
    }
    p.hand.push(c); S.phase = "AFTER"; return { drew: c };
  },

  playInCombat({ pid, uid, side }) {
    const p = me(pid); if (!p || !S.combat) return;
    const i = p.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = p.hand.splice(i, 1);
    if (c.type === "monster") { S.combat.monsters.push(c); log(`${p.name} צירף: ${c.name}`); return; }
    if (c.type === "enhancer") {
      const t = S.combat.monsters[0]; if (t) t.bonusApplied = (t.bonusApplied || 0) + 5;
      S.combat.against.push({ ...c, bonus: 0 }); log(`${p.name} חיזק את המפלצת`); return;
    }
    if (c.type === "weakener") {
      const t = S.combat.monsters[0]; if (t) t.bonusApplied = (t.bonusApplied || 0) - 5;
      S.combat.mine.push({ ...c, bonus: 0 }); log(`${p.name} החליש את המפלצת`); return;
    }
    (side === "monster" ? S.combat.against : S.combat.mine).push(c);
    log(`${p.name} שיחק ${c.name}`);
  },

  help({ helperId }) {
    if (!S.combat) return;
    const h = me(helperId); if (!h) return;
    S.combat.helper = h.id; S.combat.helperBonus = playerPower(h);
    log(`${h.name} עוזר (‎+${S.combat.helperBonus})`);
  },

  resolve() {
    if (!S.combat) return;
    const p = cur(); const { mine, mon } = combatPower();
    if (mine >= mon) {
      let tr = 0, lv = 0;
      for (const m of S.combat.monsters) { tr += m.treasures || 0; lv += m.levels || 0; }
      p.level += lv;
      S.pending = { count: tr };
      log(`⚔ ${p.name} ניצח ${mine} מול ${mon}! ‎+${lv} דרגה · ${tr} אוצרות`);
      for (const c of [...S.combat.monsters, ...S.combat.mine, ...S.combat.against]) toss(c);
      S.combat = null; S.phase = "AFTER";
      return { won: true, treasures: tr, levels: lv };
    }
    log(`⚔ ${p.name} מפסיד ${mine} מול ${mon} — חייב לברוח`);
    S.combat.mustFlee = true;
    return { won: false };
  },

  flee() {
    if (!S.combat) return;
    const p = cur(); const r = 1 + Math.floor(Math.random() * 6); const ok = r >= 5;
    const bad = S.combat.monsters.map((m) => m.badStuff).filter(Boolean).join(" · ");
    log(`🎲 ${p.name} הטיל ${r} — ${ok ? "נמלט" : "נתפס"}`);
    if (!ok && bad) log(`דבר רע: ${bad}`);
    for (const c of [...S.combat.monsters, ...S.combat.mine, ...S.combat.against]) toss(c);
    S.combat = null; S.phase = "AFTER";
    return { roll: r, escaped: ok, badStuff: ok ? null : bad };
  },

  takeTreasures() {
    const p = cur(); if (!S.pending) return;
    for (let i = 0; i < S.pending.count; i++) { const c = draw("treasure"); if (c) p.hand.push(c); }
    log(`${p.name} לקח ${S.pending.count} אוצרות`);
    S.pending = null;
  },

  lootRoom({ pid }) {
    if (S.strict && S.phase !== "AFTER") return { err: "לא בשלב הנכון" };
    const p = cur(); const c = draw("door");
    if (c) { p.hand.push(c); log(`${p.name} בזז את החדר`); }
    S.phase = "END";
  },

  lookForTrouble({ uid }) {
    if (S.strict && S.phase !== "AFTER") return { err: "לא בשלב הנכון" };
    const p = cur();
    const i = p.hand.findIndex((c) => c.uid === uid && c.type === "monster");
    if (i < 0) return { err: "בחרו מפלצת מהיד" };
    const [c] = p.hand.splice(i, 1);
    S.combat = { monsters: [c], mine: [], against: [], helper: null, helperBonus: 0 };
    S.phase = "COMBAT"; log(`${p.name} חיפש צרות: ${c.name}`);
  },

  equip({ pid, uid, carried }) {
    const p = me(pid); if (!p) return;
    if (S.strict && S.combat) return { err: "אי אפשר לשחק ציוד באמצע קרב" };
    const i = p.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const c = p.hand[i];
    if (S.strict && c.size === "גדול" && bigCarried(p) >= 1) return { err: "אפשר להחזיק פריט גדול אחד בלבד" };
    let eq = !carried;
    if (eq) {
      const why = S.strict ? canEquip(p, c) : null;
      if (why) return { err: why + ". אפשר לשים אותו כנשוא." };
    }
    p.hand.splice(i, 1);
    p.table.push({ ...c, equipped: eq });
    log(`${p.name} ${eq ? "צייד" : "נושא"}: ${c.name}`);
  },

  /* נשוא ← מצויד בלבד. מצויד ← נשוא אסור, לפי החוקים */
  toggleEquip({ pid, uid }) {
    if (S.strict && S.combat) return { err: "אי אפשר לשנות ציוד באמצע קרב" };
    const p = me(pid); const c = p?.table.find((x) => x.uid === uid); if (!c) return;
    if (S.strict && c.equipped) return { err: "מה שצוייד נשאר מצויד. אפשר רק לזרוק, למכור או להחליף." };
    if (!S.strict && c.equipped) { c.equipped = false; return; }
    const why = S.strict ? canEquip(p, c) : null;
    if (why) return { err: why };
    c.equipped = true;
    log(`${p.name} צייד: ${c.name}`);
  },

  /* שמירת מיקום קלף אחרי גרירה */
  movePos({ pid, uid, x, y }) {
    for (const p of S.players) {
      const c = p.table.find((z) => z.uid === uid);
      if (c) { c.x = x; c.y = y; return; }
    }
    if (S.combat) for (const arr of [S.combat.monsters, S.combat.mine, S.combat.against]) {
      const c = arr.find((z) => z.uid === uid);
      if (c) { c.x = x; c.y = y; return; }
    }
  },

  /* גרירה: העברת קלף לכל יעד */
  moveCard({ pid, uid, dest, toId }) {
    const f = me(pid); if (!f) return;
    let c = null;
    const fromHand = f.hand.findIndex((z) => z.uid === uid);
    if (fromHand >= 0) c = f.hand.splice(fromHand, 1)[0];
    else for (const p of S.players) {
      const i = p.table.findIndex((z) => z.uid === uid);
      if (i >= 0) { c = p.table.splice(i, 1)[0]; break; }
    }
    if (!c && S.combat) for (const arr of [S.combat.monsters, S.combat.mine, S.combat.against]) {
      const i = arr.findIndex((z) => z.uid === uid);
      if (i >= 0) { c = arr.splice(i, 1)[0]; break; }
    }
    if (!c) return { err: "לא נמצא" };

    if (dest === "hand") { (me(toId) || f).hand.push(c); log(`${f.name} → יד`); return; }
    if (dest === "table") { (me(toId) || f).table.push({ ...c, equipped: false }); log(`${f.name} שיחק ${c.name}`); return; }
    if (dest === "discard") { toss(c); log(`${f.name} זרק ${c.name}`); return; }
    if (dest === "combatMine" || dest === "combatMon") {
      if (!S.combat) S.combat = { monsters: [], mine: [], against: [], helper: null, helperBonus: 0 };
      if (c.type === "monster") S.combat.monsters.push(c);
      else (dest === "combatMon" ? S.combat.against : S.combat.mine).push(c);
      if (S.phase !== "COMBAT") S.phase = "COMBAT";
      log(`${f.name} → זירה: ${c.name}`);
      return;
    }
    f.hand.push(c);
  },

  /* --- פעולות חופשיות: המשחק לא חוסם, רק מסייע --- */

  /* שים קלף כלשהו לפני שחקן כלשהו — קללה, מלכודת, מה שתרצו */
  putOn({ pid, uid, toId }) {
    const f = me(pid), t = me(toId || pid);
    if (!f || !t) return { err: "לא נמצא" };
    const i = f.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = f.hand.splice(i, 1);
    t.table.push({ ...c, equipped: false });
    log(`${f.name} שיחק "${c.name}" על ${t.name}`);
  },

  /* צירוף מפלצת לקרב פעיל של מישהו אחר — מפלצת משוטטת */
  addToCombat({ pid, uid }) {
    const p = me(pid); if (!p) return { err: "לא נמצא" };
    if (!S.combat) return { err: "אין קרב פעיל" };
    const i = p.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = p.hand.splice(i, 1);
    if (c.type === "monster") { S.combat.monsters.push(c); log(`${p.name} צירף לקרב: ${c.name}`); }
    else { S.combat.against.push(c); log(`${p.name} הוסיף לצד המפלצת: ${c.name}`); }
  },

  /* פתיחת קרב ידנית — לכל מצב שהמשחק לא צפה */
  forceCombat({ pid, uid }) {
    const p = me(pid); if (!p) return;
    const i = p.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = p.hand.splice(i, 1);
    S.combat = { monsters: [c], mine: [], against: [], helper: null, helperBonus: 0 };
    S.phase = "COMBAT";
    log(`${p.name} פתח קרב: ${c.name}`);
  },

  /* מעבר שלב ידני — כשהמשחק תקוע או כשעשיתם משהו בעצמכם */
  setPhase({ pid, phase }) {
    S.phase = phase;
    log(`${me(pid)?.name} העביר לשלב: ${PH[phase] || phase}`);
  },

  /* ביטול קרב בלי הכרעה */
  cancelCombat({ pid }) {
    if (!S.combat) return;
    for (const c of [...S.combat.monsters, ...S.combat.mine, ...S.combat.against]) toss(c);
    S.combat = null; S.phase = "AFTER";
    log(`${me(pid)?.name} סגר את הקרב ידנית`);
  },

  /* שחרור ממלכודת — הטלה בתחילת התור */
  tryEscapeTrap({ pid, uid }) {
    const p = me(pid); const c = p?.table.find((x) => x.uid === uid);
    if (!c || c.type !== "trap") return { err: "לא מלכודת" };
    const r = 1 + Math.floor(Math.random() * 6);
    const ok = r >= 5;
    log(`🎲 ${p.name} מנסה להשתחרר מ${c.name}: ${r} — ${ok ? "השתחרר!" : "עדיין תקוע"}`);
    if (ok) { p.table = p.table.filter((x) => x.uid !== uid); toss(c); }
    return { roll: r, freed: ok };
  },

  /* העברת מלכודת לשחקן אחר */
  passTrap({ pid, uid, toId }) {
    const p = me(pid), t = me(toId);
    const i = p?.table.findIndex((x) => x.uid === uid && x.type === "trap");
    if (i == null || i < 0 || !t) return { err: "לא נמצא" };
    const [c] = p.table.splice(i, 1);
    t.table.push(c);
    log(`${p.name} העביר את "${c.name}" ל${t.name}`);
  },

  /* מכירת ציוד לדרגה */
  sell({ pid, uids }) {
    const p = me(pid); if (!p) return;
    if (S.strict && S.combat) return { err: "אי אפשר למכור באמצע קרב" };
    if (S.strict && p.id !== cur().id) return { err: "אפשר למכור רק בתורך" };
    let gold = 0; const keep = [];
    for (const c of p.table) {
      if (uids.includes(c.uid)) { gold += c.gold || 0; toss(c); } else keep.push(c);
    }
    if (S.strict && gold < 1000) return { err: `${gold} זהב בלבד. צריך 1000 לדרגה.` };
    p.table = keep;
    const lv = Math.floor(gold / 1000);
    p.level += lv;
    log(`${p.name} מכר ${gold} זהב → ‎+${lv} דרגה`);
    return { gold, levels: lv };
  },
  discard({ pid, uid, from }) {
    const p = me(pid); if (!p) return;
    const src = from === "table" ? p.table : p.hand;
    const i = src.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = src.splice(i, 1); toss(c); log(`${p.name} זרק: ${c.name}`);
  },
  give({ pid, uid, toId }) {
    const f = me(pid), t = me(toId); if (!f || !t) return;
    const i = f.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    t.hand.push(...f.hand.splice(i, 1)); log(`${f.name} → ${t.name}`);
  },
  steal({ pid, targetId, uid }) {
    const m = me(pid), t = me(targetId); if (!m || !t) return;
    const i = t.table.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = t.table.splice(i, 1); m.table.push(c);
    log(`${m.name} לקח מ${t.name}: ${c.name}`);
  },

  lvl({ pid, d }) { const p = me(pid); if (p) { p.level = Math.max(1, p.level + d); log(`${p.name} → דרגה ${p.level}`); } },
  aura({ pid, d }) { const p = me(pid); if (p) { p.aura = Math.max(-3, Math.min(5, p.aura + d)); log(`${p.name} → אאורה ${p.aura}`); } },
  sex({ pid }) { const p = me(pid); if (p) { p.sex = p.sex === "גבר" ? "אישה" : "גבר"; log(`${p.name} → ${p.sex}`); } },
  roll({ pid }) { const r = 1 + Math.floor(Math.random() * 6); log(`🎲 ${me(pid)?.name} הטיל ${r}`); return { roll: r }; },

  endTurn() {
    const p = cur();
    if (S.strict && p.hand.length > 5) return { err: `${p.hand.length} קלפים ביד. זרוק עד 5.` };
    S.turn = (S.turn + 1) % S.players.length;
    S.phase = "START"; S.combat = null; S.pending = null;
    log(`— תורו של ${cur().name} —`);
  },
};

function view(pid) {
  tidyCombat();
  const p = me(pid);
  return {
    you: p && { ...p, power: playerPower(p) },
    players: S.players.map((x) => ({
      id: x.id, name: x.name, sex: x.sex, level: x.level, aura: x.aura,
      hand: x.hand.length, table: x.table, on: x.on, power: playerPower(x),
    })),
    turn: S.turn, turnId: cur()?.id, turnName: cur()?.name || "",
    phase: S.phase, phaseText: PH[S.phase], strict: S.strict,
    combat: S.combat && { ...S.combat, power: combatPower() },
    pending: S.pending,
    decks: { door: S.door.length, treasure: S.treasure.length, dd: S.doorDiscard.length, td: S.treasureDiscard.length },
    log: S.log, started: S.started,
  };
}

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }
  if (u.pathname === "/state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(view(u.searchParams.get("pid") || "")));
  }
  if (u.pathname === "/do" && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      let out = {};
      try { const { action, ...args } = JSON.parse(b || "{}"); if (A[action]) out = A[action](args) || {}; }
      catch (e) { out = { err: e.message }; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`\n  המשחק רץ:  http://localhost:${PORT}\n  ${CARDS.length} קלפים\n`));
