/* ============================================================
   סופר מאנצ'קין־אסטרייכר — שרת המשחק
   ------------------------------------------------------------
   מנהל חפיסות, ידיים פרטיות, שולחן ותורות.
   אינו אוכף חוקים — השחקנים אוכפים בעצמם, כמו עם קלפים אמיתיים.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, "cards.json"), "utf8"));

/* ---------- בניית החפיסות ---------- */

function buildDeck(which) {
  const out = [];
  let uid = 0;
  for (const c of CARDS) {
    if (c.deck !== which) continue;
    for (let i = 0; i < (c.copies || 1); i++) out.push({ ...c, uid: `${which}-${uid++}` });
  }
  return shuffle(out);
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

/* ---------- מצב המשחק ---------- */

const S = {
  players: [],       // {id, name, sex, level, aura, hand[], table[], connected}
  door: [],
  treasure: [],
  doorDiscard: [],
  treasureDiscard: [],
  inPlay: [],        // קלפים על השולחן המשותף — מפלצות, מחזקים
  turn: 0,           // אינדקס השחקן שתורו
  log: [],
  started: false,
};

function reset() {
  S.door = buildDeck("door");
  S.treasure = buildDeck("treasure");
  S.doorDiscard = [];
  S.treasureDiscard = [];
  S.inPlay = [];
  S.turn = 0;
  S.log = [];
  S.started = false;
  for (const p of S.players) {
    p.level = 1;
    p.aura = 0;
    p.hand = [];
    p.table = [];
  }
}

function log(msg) {
  S.log.unshift({ t: Date.now(), msg });
  if (S.log.length > 60) S.log.pop();
}

function draw(which) {
  const deck = which === "door" ? S.door : S.treasure;
  const discard = which === "door" ? S.doorDiscard : S.treasureDiscard;
  if (!deck.length) {
    if (!discard.length) return null;
    const re = shuffle(discard.splice(0));
    deck.push(...re);
    log(`חפיסת ה${which === "door" ? "דלת" : "אוצר"} נגמרה — הזרוקים עורבבו`);
  }
  return deck.pop();
}

/* ---------- מה כל שחקן רואה ---------- */

function viewFor(pid) {
  const me = S.players.find((p) => p.id === pid);
  return {
    you: me
      ? { id: me.id, name: me.name, sex: me.sex, level: me.level, aura: me.aura, hand: me.hand, table: me.table }
      : null,
    players: S.players.map((p) => ({
      id: p.id, name: p.name, sex: p.sex, level: p.level, aura: p.aura,
      handCount: p.hand.length, table: p.table, connected: p.connected,
    })),
    inPlay: S.inPlay,
    turn: S.turn,
    turnName: S.players[S.turn]?.name || "",
    deckCounts: {
      door: S.door.length, treasure: S.treasure.length,
      doorDiscard: S.doorDiscard.length, treasureDiscard: S.treasureDiscard.length,
    },
    topDiscard: {
      door: S.doorDiscard[S.doorDiscard.length - 1] || null,
      treasure: S.treasureDiscard[S.treasureDiscard.length - 1] || null,
    },
    log: S.log,
    started: S.started,
  };
}

/* ---------- פעולות ---------- */

const actions = {
  join({ name, sex }) {
    let p = S.players.find((x) => x.name === name);
    if (p) { p.connected = true; return { id: p.id }; }
    p = {
      id: Math.random().toString(36).slice(2, 10),
      name, sex: sex || "גבר", level: 1, aura: 0,
      hand: [], table: [], connected: true,
    };
    S.players.push(p);
    log(`${name} הצטרף`);
    return { id: p.id };
  },

  start() {
    reset();
    S.started = true;
    for (const p of S.players) {
      for (let i = 0; i < 4; i++) { const d = draw("door"); if (d) p.hand.push(d); }
      for (let i = 0; i < 4; i++) { const t = draw("treasure"); if (t) p.hand.push(t); }
    }
    log("המשחק התחיל. לכל שחקן 4 דלת ו-4 אוצר.");
  },

  drawCard({ pid, which, faceUp }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    const c = draw(which); if (!c) return;
    if (faceUp) {
      S.inPlay.push({ ...c, owner: p.name });
      log(`${p.name} פתח דלת: ${c.name}`);
    } else {
      p.hand.push(c);
      log(`${p.name} שלף קלף ${which === "door" ? "דלת" : "אוצר"}`);
    }
  },

  playToTable({ pid, uid }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    const i = p.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = p.hand.splice(i, 1);
    p.table.push(c);
    log(`${p.name} שיחק: ${c.name}`);
  },

  playToCombat({ pid, uid }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    const i = p.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = p.hand.splice(i, 1);
    S.inPlay.push({ ...c, owner: p.name });
    log(`${p.name} הניח על השולחן: ${c.name}`);
  },

  discard({ pid, uid, from }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    const src = from === "table" ? p.table : p.hand;
    const i = src.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = src.splice(i, 1);
    (c.deck === "door" ? S.doorDiscard : S.treasureDiscard).push(c);
    log(`${p.name} זרק: ${c.name}`);
  },

  clearInPlay({ pid }) {
    const p = S.players.find((x) => x.id === pid);
    for (const c of S.inPlay) (c.deck === "door" ? S.doorDiscard : S.treasureDiscard).push(c);
    const n = S.inPlay.length;
    S.inPlay = [];
    if (n) log(`${p?.name || "מישהו"} פינה את השולחן (${n} קלפים)`);
  },

  giveCard({ pid, uid, toId }) {
    const from = S.players.find((x) => x.id === pid);
    const to = S.players.find((x) => x.id === toId);
    if (!from || !to) return;
    const i = from.hand.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = from.hand.splice(i, 1);
    to.hand.push(c);
    log(`${from.name} העביר קלף ל${to.name}`);
  },

  takeFromTable({ pid, targetId, uid }) {
    const me = S.players.find((x) => x.id === pid);
    const t = S.players.find((x) => x.id === targetId);
    if (!me || !t) return;
    const i = t.table.findIndex((c) => c.uid === uid); if (i < 0) return;
    const [c] = t.table.splice(i, 1);
    me.table.push(c);
    log(`${me.name} לקח מ${t.name}: ${c.name}`);
  },

  setLevel({ pid, delta }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    p.level = Math.max(1, p.level + delta);
    log(`${p.name} → דרגה ${p.level}`);
  },

  setAura({ pid, delta }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    p.aura = Math.max(-3, Math.min(5, p.aura + delta));
    log(`${p.name} → אאורה ${p.aura}`);
  },

  setSex({ pid }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    p.sex = p.sex === "גבר" ? "אישה" : "גבר";
    log(`${p.name} שינה מין → ${p.sex}. ‎-5 בקרב הבא.`);
  },

  roll({ pid, sides }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    const r = 1 + Math.floor(Math.random() * (sides || 6));
    log(`🎲 ${p.name} הטיל ${r}`);
    return { roll: r };
  },

  nextTurn() {
    if (!S.players.length) return;
    S.turn = (S.turn + 1) % S.players.length;
    log(`— תורו של ${S.players[S.turn].name} —`);
  },

  say({ pid, text }) {
    const p = S.players.find((x) => x.id === pid); if (!p) return;
    log(`${p.name}: ${text}`);
  },

  removePlayer({ targetId }) {
    const i = S.players.findIndex((x) => x.id === targetId);
    if (i < 0) return;
    const [p] = S.players.splice(i, 1);
    for (const c of [...p.hand, ...p.table])
      (c.deck === "door" ? S.doorDiscard : S.treasureDiscard).push(c);
    if (S.turn >= S.players.length) S.turn = 0;
    log(`${p.name} עזב`);
  },
};

/* ---------- שרת ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }

  if (url.pathname === "/state") {
    const pid = url.searchParams.get("pid") || "";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(viewFor(pid)));
  }

  if (url.pathname === "/do" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let out = {};
      try {
        const { action, ...args } = JSON.parse(body || "{}");
        if (actions[action]) out = actions[action](args) || {};
      } catch (e) {
        out = { error: String(e.message) };
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  סופר מאנצ'קין־אסטרייכר`);
  console.log(`  השרת רץ. פתחו בדפדפן:\n`);
  console.log(`    http://localhost:${PORT}\n`);
  console.log(`  ${CARDS.length} קלפים ייחודיים נטענו.\n`);
});
