const express = require("express");
const { loadStore, withStore, debitWallet, creditWallet, nextTicketId, nextCashierCode } = require("../db");
const { authRequired } = require("../middleware/auth");
const { fetchFixtureResults, findMatchResultForFixture } = require("./odds");

const router = express.Router();
const MIN_STAKE = Number(process.env.MIN_STAKE || 20);

function parseOdd(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? n : null;
}

router.post("/place", authRequired, (req, res) => {
  const stake = Number(req.body.stake);
  const mode = req.body.mode === "single" ? "single" : "multiple";
  const selections = Array.isArray(req.body.selections) ? req.body.selections : [];

  if (!Number.isFinite(stake) || stake < MIN_STAKE) {
    return res.status(400).json({ ok: false, error: `Minimum stake is ${MIN_STAKE}` });
  }
  if (!selections.length) {
    return res.status(400).json({ ok: false, error: "No selections in bet slip" });
  }

  const fixtureIds = new Set();
  const normalized = [];

  for (const sel of selections) {
    const fixtureId = Number(sel.fixtureId);
    const odd = parseOdd(sel.odd);
    if (!fixtureId || !odd) {
      return res.status(400).json({ ok: false, error: "Invalid selection data" });
    }
    if (fixtureIds.has(fixtureId)) {
      return res.status(400).json({ ok: false, error: "Only one selection per match allowed" });
    }

    // Pre-placement kickoff validation: reject if match has started / locked
    if (sel.kickoff) {
      const kickoffTime = new Date(sel.kickoff).getTime();
      if (!isNaN(kickoffTime) && kickoffTime <= Date.now()) {
        const matchName = sel.fixtureName || (sel.homeName && sel.awayName ? `${sel.homeName} vs ${sel.awayName}` : `Match #${fixtureId}`);
        return res.status(400).json({
          ok: false,
          code: "MATCH_ALREADY_STARTED",
          error: "Match has already started / Odd is locked. Please remove it to proceed.",
          matchName,
          fixtureId,
        });
      }
    }
    fixtureIds.add(fixtureId);
    normalized.push({
      fixtureId,
      marketKey: String(sel.marketKey || ""),
      marketName: String(sel.marketName || "Match Result"),
      selectionName: String(sel.selectionName || sel.selection || sel.value || ""),
      value: String(sel.value || sel.selection || sel.selectionName || ""),
      odd,
      homeName: String(sel.homeName || ""),
      awayName: String(sel.awayName || ""),
      fixtureName: String(sel.fixtureName || ""),
      kickoff: sel.kickoff || null,
      sport: String(sel.sport || "Football"),
      country: String(sel.country || ""),
      leagueName: String(sel.leagueName || ""),
    });
  }

  const totalOdds =
    mode === "single"
      ? normalized[normalized.length - 1].odd
      : normalized.reduce((acc, s) => acc * s.odd, 1);

  const potentialWin = Number((stake * totalOdds).toFixed(2));
  const ticketId = nextTicketId();
  const cashierCode = nextCashierCode();

  const isCashier = req.user.role === "admin" || req.user.role === "super_admin";
  const cashierId = isCashier ? req.user.id : null;
  const targetUserId =
    isCashier && req.body.playerId
      ? Number(req.body.playerId)
      : req.user.id;

  if (isCashier && req.body.playerId && req.user.role === "admin") {
    const currentStore = loadStore();
    const targetUser = (currentStore.users || []).find((u) => u.id === targetUserId);
    if (!targetUser || String(targetUser.created_by_admin_id) !== String(req.user.id)) {
      return res.status(403).json({ ok: false, error: "Access denied: Player does not belong to your shop" });
    }
  }

  try {
    debitWallet(targetUserId, stake, "bet_stake", ticketId, { mode, selections: normalized.length });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ ok: false, error: "Insufficient balance" });
    }
    throw err;
  }

  withStore((store) => {
    store.bets.unshift({
      user_id: targetUserId,
      cashier_id: cashierId,
      ticket_id: ticketId,
      cashier_code: cashierCode,
      stake,
      total_odds: Number(totalOdds.toFixed(4)),
      potential_win: potentialWin,
      status: "open",
      payout: 0,
      mode,
      selections: JSON.stringify(normalized),
      placed_at: new Date().toISOString(),
      settled_at: null,
    });
  });

  const wallet = withStore((store) => store.wallets[String(targetUserId)]);

  res.status(201).json({
    ok: true,
    ticket: {
      id: ticketId,
      cashierCode,
      stake,
      totalOdds: Number(totalOdds.toFixed(2)),
      potentialWin,
      status: "open",
      mode,
      bets: normalized,
      placedAt: new Date().toISOString(),
    },
    balance: wallet.balance,
    currency: wallet.currency,
  });
});

function evaluateSelection(sel, fixtureData) {
  const status = fixtureData.fixture?.status?.short;
  if (!["FT", "AET", "PEN", "FINISHED", "ENDED"].includes(String(status).toUpperCase())) {
    return { finished: false, status };
  }

  const homeGoals = Number(fixtureData.goals?.home ?? fixtureData.score?.fulltime?.home ?? 0);
  const awayGoals = Number(fixtureData.goals?.away ?? fixtureData.score?.fulltime?.away ?? 0);
  const htHome = fixtureData.score?.halftime?.home != null ? Number(fixtureData.score.halftime.home) : (homeGoals === 0 ? 0 : Math.floor(homeGoals / 2));
  const htAway = fixtureData.score?.halftime?.away != null ? Number(fixtureData.score.halftime.away) : (awayGoals === 0 ? 0 : Math.floor(awayGoals / 2));
  let outcome1x2 = "draw";
  if (homeGoals > awayGoals) outcome1x2 = "home";
  else if (awayGoals > homeGoals) outcome1x2 = "away";

  const s = String(sel.value || sel.selectionName || sel.selection || "").trim().toLowerCase();
  const m = String(sel.marketKey || sel.marketName || "").trim().toLowerCase();
  const h = String(sel.homeName || "").trim().toLowerCase();
  const a = String(sel.awayName || "").trim().toLowerCase();

  let won = false;

  // 1. Match Result / 1X2 / Winner
  if (m.includes("1x2") || m.includes("match") || m.includes("winner") || m.includes("result") || !m) {
    if (outcome1x2 === "home" && (s === "home" || s === "1" || s === "w1" || (h && s === h) || (h && h.includes(s)))) won = true;
    if (outcome1x2 === "draw" && (s === "draw" || s === "x")) won = true;
    if (outcome1x2 === "away" && (s === "away" || s === "2" || s === "w2" || (a && s === a) || (a && a.includes(s)))) won = true;
  }
  // 2. Double Chance
  else if (m.includes("dc") || m.includes("double")) {
    if ((s.includes("1x") || s.includes("1/x")) && (outcome1x2 === "home" || outcome1x2 === "draw")) won = true;
    if ((s.includes("12") || s.includes("1/2")) && (outcome1x2 === "home" || outcome1x2 === "away")) won = true;
    if ((s.includes("x2") || s.includes("x/2")) && (outcome1x2 === "draw" || outcome1x2 === "away")) won = true;
  }
  // 3. Over / Under
  else if (m.includes("total") || m.includes("over") || m.includes("under")) {
    const totalGoals = homeGoals + awayGoals;
    const numMatch = s.match(/(\d+(?:\.\d+)?)/) || m.match(/(\d+(?:\.\d+)?)/);
    const line = numMatch ? parseFloat(numMatch[1]) : 2.5;
    if ((s.includes("over") || s.startsWith("o")) && totalGoals > line) won = true;
    if ((s.includes("under") || s.startsWith("u")) && totalGoals < line) won = true;
  }
  // 4. Both Teams to Score (BTTS)
  else if (m.includes("btts") || m.includes("both") || m.includes("gg")) {
    const btts = homeGoals > 0 && awayGoals > 0;
    if ((s === "yes" || s === "gg") && btts) won = true;
    if ((s === "no" || s === "ng") && !btts) won = true;
  }
  // 5. Half Time 1X2
  else if (m.includes("half") || m.includes("ht")) {
    let htOutcome = "draw";
    if (htHome > htAway) htOutcome = "home";
    else if (htAway > htHome) htOutcome = "away";
    if (htOutcome === "home" && (s === "home" || s === "1" || s === "w1")) won = true;
    if (htOutcome === "draw" && (s === "draw" || s === "x")) won = true;
    if (htOutcome === "away" && (s === "away" || s === "2" || s === "w2")) won = true;
  }
  // 6. Draw No Bet (DNB)
  else if (m.includes("dnb") || m.includes("draw no bet")) {
    if (homeGoals > awayGoals && (s === "home" || s === "1" || s === "w1")) won = true;
    if (awayGoals > homeGoals && (s === "away" || s === "2" || s === "w2")) won = true;
    if (homeGoals === awayGoals) won = true; // push
  }

  return {
    finished: true,
    won,
    score: `${homeGoals}-${awayGoals}`,
    htScore: `${htHome}:${htAway}`,
    ftScore: `${homeGoals}:${awayGoals}`,
    status,
  };
}

function calculateNearMissBonus(stake, selections) {
  try {
    const { loadStore } = require("../db");
    const store = loadStore();
    const settings = store.settings || {};
    if (settings.bonus_enabled === false) return null;
    const rules = settings.bonus_rules;
    if (!Array.isArray(rules) || !rules.length) return null;

    const totalTeams = selections.length;
    const lostCount = selections.filter((s) => s.status === "lost").length;
    if (lostCount < 1 || lostCount > 4) return null;

    const minOdd = Number(settings.bonus_min_odd_per_leg) || 0;
    if (minOdd > 1) {
      const validOdds = selections.every((s) => !s.odd || Number(s.odd) >= minOdd);
      if (!validOdds) return null;
    }

    const eligibleRules = rules.filter((r) => {
      if (!r.enabled) return false;
      if (Number(r.failedCount) !== lostCount) return false;
      if (totalTeams < Number(r.minTeams)) return false;
      if (r.maxTeams != null && r.maxTeams !== "" && totalTeams > Number(r.maxTeams)) return false;
      return true;
    });

    if (!eligibleRules.length) return null;
    eligibleRules.sort((a, b) => Number(b.multiplier) - Number(a.multiplier));
    const matchedRule = eligibleRules[0];
    const multiplier = Number(matchedRule.multiplier) || 1;
    const amount = Number((stake * multiplier).toFixed(2));

    return {
      rule: matchedRule,
      multiplier,
      amount,
      failedCount: lostCount,
      totalTeams,
    };
  } catch (_) {
    return null;
  }
}

async function autoSettleOpenTickets(userId) {
  try {
    const openRows = withStore((store) =>
      store.bets.filter((b) => {
        if (b.status !== "open") return false;
        if (!userId) return true;
        return String(b.user_id) === String(userId) || String(b.cashier_id) === String(userId);
      })
    );

    if (!openRows.length) return;

    const fixtureIdSet = new Set();
    const parsedMap = new Map();

    for (const row of openRows) {
      try {
        const selections = JSON.parse(row.selections);
        parsedMap.set(row.ticket_id, selections);
        for (const sel of selections) {
          if (sel.fixtureId) fixtureIdSet.add(Number(sel.fixtureId));
        }
      } catch (_) {}
    }

    const fixMap = new Map();
    if (fixtureIdSet.size) {
      try {
        const fixturesFromApi = await fetchFixtureResults(Array.from(fixtureIdSet));
        for (const f of fixturesFromApi) {
          const fid = f.fixture?.id || f.id || f.fixtureId;
          if (fid) fixMap.set(Number(fid), f);
        }
      } catch (_) {}
    }

    for (const row of openRows) {
      const selections = parsedMap.get(row.ticket_id);
      if (!selections || !selections.length) continue;

      let allFinished = true;
      let anyLost = false;

      for (const sel of selections) {
        if (sel.status === "won" || sel.status === "lost") {
          if (sel.status === "lost") anyLost = true;
          continue;
        }

        // Future kickoff: match has not started yet, cannot be finished!
        const kickTime = sel.kickoff ? new Date(sel.kickoff).getTime() : 0;
        if (kickTime && kickTime > Date.now() + 60000) {
          allFinished = false;
          continue;
        }

        const fid = Number(sel.fixtureId);
        let matchData = fixMap.get(fid);
        if (matchData) {
          const apiHome = String(matchData.teams?.home?.name || matchData.home?.name || "").toLowerCase();
          const apiAway = String(matchData.teams?.away?.name || matchData.away?.name || "").toLowerCase();
          const selHome = String(sel.homeName || "").toLowerCase();
          const selAway = String(sel.awayName || "").toLowerCase();
          if (selHome && selAway && apiHome && apiAway) {
            const hMatch = apiHome.includes(selHome) || selHome.includes(apiHome);
            const aMatch = apiAway.includes(selAway) || selAway.includes(apiAway);
            if (!hMatch || !aMatch) {
              matchData = null;
            }
          }
        }

        const matchStatus = String(matchData?.fixture?.status?.short || "").toUpperCase();
        if (!matchData || !["FT", "AET", "PEN", "FINISHED", "ENDED"].includes(matchStatus)) {
          const fallbackRes = findMatchResultForFixture(fid, sel.homeName, sel.awayName, sel.kickoff);
          if (fallbackRes) matchData = fallbackRes;
        }

        if (matchData) {
          const evalRes = evaluateSelection(sel, matchData);
          if (evalRes.finished) {
            sel.status = evalRes.won ? "won" : "lost";
            if (evalRes.score) sel.score = evalRes.score;
            if (evalRes.htScore) sel.htScore = evalRes.htScore;
            if (evalRes.ftScore) sel.ftScore = evalRes.ftScore;
            if (!evalRes.won) anyLost = true;
          } else {
            allFinished = false;
          }
        } else {
          allFinished = false;
        }
      }

      if (anyLost) {
        let bonusInfo = null;
        let bonusPayout = 0;
        if (allFinished) {
          bonusInfo = calculateNearMissBonus(row.stake, selections);
          bonusPayout = bonusInfo ? bonusInfo.amount : 0;
        }

        withStore((store) => {
          const bet = store.bets.find((b) => b.ticket_id === row.ticket_id);
          if (bet && bet.status === "open") {
            bet.status = "lost";
            bet.payout = bonusPayout;
            bet.settled_at = new Date().toISOString();
            bet.selections = JSON.stringify(selections);
            if (bonusInfo && bonusPayout > 0) {
              bet.bonus_awarded = true;
              bet.bonus_amount = bonusInfo.amount;
              bet.bonus_multiplier = bonusInfo.multiplier;
              bet.bonus_rule_name = bonusInfo.rule.name;
              bet.bonus_failed_count = bonusInfo.failedCount;
              bet.bonus_total_teams = bonusInfo.totalTeams;
            }
          }
        });

        if (bonusPayout > 0) {
          creditWallet(row.user_id, bonusPayout, "bonus_cut", row.ticket_id, {
            ticketId: row.ticket_id,
            multiplier: bonusInfo.multiplier,
            failedCount: bonusInfo.failedCount,
            totalTeams: bonusInfo.totalTeams,
          });
        }
      } else if (allFinished) {
        const payout = Number(row.potential_win || 0);
        withStore((store) => {
          const bet = store.bets.find((b) => b.ticket_id === row.ticket_id);
          if (bet && bet.status === "open") {
            bet.status = "won";
            bet.payout = payout;
            bet.settled_at = new Date().toISOString();
            bet.selections = JSON.stringify(selections);
          }
        });
        if (payout > 0) {
          creditWallet(row.user_id, payout, "bet_win", row.ticket_id, { ticketId: row.ticket_id });
        }
      }
    }
  } catch (err) {
    console.error("[autoSettleOpenTickets] Error:", err.message);
  }
}

// Background poller to auto-settle any finished matches every 2 minutes
setInterval(() => {
  autoSettleOpenTickets().catch(() => {});
}, 120000);

router.get("/history", authRequired, async (req, res) => {
  await autoSettleOpenTickets(req.user.id);

  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const isCashierOrAdmin = req.user.role === "admin" || req.user.role === "super_admin";
  const rows = withStore((store) =>
    store.bets.filter((b) => {
      if (isCashierOrAdmin) {
        return String(b.cashier_id) === String(req.user.id) || String(b.user_id) === String(req.user.id);
      }
      return String(b.user_id) === String(req.user.id);
    }).slice(0, limit)
  );

  const tickets = rows.map((row) => {
    let bets = [];
    try {
      bets = JSON.parse(row.selections);
    } catch (_) {}

    // Keep genuine selection statuses as stored in the database

    bets.forEach((b) => {
      if (b.score && typeof b.score === "string") {
        const parts = b.score.replace(":", "-").split("-");
        if (parts.length === 2) {
          b.ftScore = b.ftScore || `${parts[0]}:${parts[1]}`;
          if (parts[0] === "0" && parts[1] === "0") {
            b.htScore = b.htScore || "0:0";
          }
        }
      }
    });

    return {
      id: row.ticket_id,
      cashierCode: row.cashier_code || (function() {
        const m = String(row.ticket_id || "").match(/\d+/);
        return m ? String(1000 + (parseInt(m[0], 10) - 1)) : "1000";
      })(),
      stake: row.stake,
      totalOdds: row.total_odds,
      potentialWin: row.potential_win,
      status: row.status,
      payout: row.payout,
      mode: row.mode,
      bonusAwarded: Boolean(row.bonus_awarded || (row.bonus_amount && row.bonus_amount > 0)),
      bonusAmount: row.bonus_amount || 0,
      bonusMultiplier: row.bonus_multiplier || null,
      bonusRuleName: row.bonus_rule_name || null,
      bonusFailedCount: row.bonus_failed_count || null,
      bonusTotalTeams: row.bonus_total_teams || null,
      bets,
      placedAt: row.placed_at,
      settledAt: row.settled_at,
    };
  });

  res.json({ ok: true, tickets });
});

router.post("/dev/settle/:ticketId", authRequired, (req, res) => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_SETTLE !== "true") {
    return res.status(403).json({ ok: false, error: "Not available in production" });
  }

  const ticketId = req.params.ticketId;
  const won = Boolean(req.body.won);

  const row = withStore((store) =>
    store.bets.find((b) => b.ticket_id === ticketId && b.user_id === req.user.id && b.status === "open")
  );

  if (!row) return res.status(404).json({ ok: false, error: "Open ticket not found" });

  let payout = won ? row.potential_win : 0;
  let bonusInfo = null;

  withStore((store) => {
    const bet = store.bets.find((b) => b.ticket_id === ticketId);
    if (!bet) return;
    bet.status = won ? "won" : "lost";
    bet.settled_at = new Date().toISOString();

    try {
      const selections = JSON.parse(bet.selections || "[]");
      if (won) {
        selections.forEach((s) => {
          s.status = "won";
        });
      } else {
        const failCount = req.body.failCount !== undefined ? Number(req.body.failCount) : (req.body.failIndex !== undefined ? 1 : 1);
        const failIdx = req.body.failIndex !== undefined ? Number(req.body.failIndex) : -1;
        selections.forEach((s, idx) => {
          if (failIdx >= 0 ? idx === failIdx : idx < failCount) {
            s.status = "lost";
          } else {
            s.status = "won";
          }
        });

        bonusInfo = calculateNearMissBonus(bet.stake, selections);
        if (bonusInfo && bonusInfo.amount > 0) {
          payout = bonusInfo.amount;
          bet.bonus_awarded = true;
          bet.bonus_amount = bonusInfo.amount;
          bet.bonus_multiplier = bonusInfo.multiplier;
          bet.bonus_rule_name = bonusInfo.rule.name;
          bet.bonus_failed_count = bonusInfo.failedCount;
          bet.bonus_total_teams = bonusInfo.totalTeams;
        }
      }
      bet.payout = payout;
      bet.selections = JSON.stringify(selections);
    } catch (_) {}
  });

  if (payout > 0) {
    creditWallet(req.user.id, payout, won ? "bet_win" : "bonus_cut", ticketId, {
      ticketId,
      ...(bonusInfo ? { multiplier: bonusInfo.multiplier, failedCount: bonusInfo.failedCount, totalTeams: bonusInfo.totalTeams } : {})
    });
  }

  const wallet = withStore((store) => store.wallets[String(req.user.id)]);

  res.json({
    ok: true,
    ticketId,
    status: won ? "won" : "lost",
    payout,
    bonusAwarded: Boolean(bonusInfo && bonusInfo.amount > 0),
    bonusAmount: bonusInfo ? bonusInfo.amount : 0,
    bonusMultiplier: bonusInfo ? bonusInfo.multiplier : null,
    balance: wallet.balance,
  });
});

function matchTicket(b, query) {
  if (!b || !query) return false;
  let q = String(query).trim().toLowerCase();
  if (q.includes("check=")) {
    const m = q.match(/check=([^&]+)/);
    if (m) q = decodeURIComponent(m[1]).toLowerCase();
  } else if (q.includes("/v/")) {
    const m = q.match(/\/v\/([^/?#]+)/);
    if (m) q = decodeURIComponent(m[1]).toLowerCase();
  } else if (q.includes("ticket=")) {
    const m = q.match(/ticket=([^&]+)/);
    if (m) q = decodeURIComponent(m[1]).toLowerCase();
  }
  const tid = String(b.ticket_id || "").trim().toLowerCase();
  if (tid === q) return true;
  if (String(b.cashier_code || "").trim().toLowerCase() === q) return true;

  const m = tid.match(/\d+/);
  if (m) {
    const num = parseInt(m[0], 10);
    if (!isNaN(num) && num > 0) {
      const derivedCode = String(1000 + (num - 1));
      if (derivedCode === q) return true;
      const qDigits = q.replace(/\D/g, "");
      if (qDigits && (parseInt(qDigits, 10) === num || parseInt(qDigits, 10) === (1000 + num - 1))) {
        return true;
      }
    }
  }
  return false;
}

router.post("/settle/:ticketId", authRequired, async (req, res) => {
  const ticketId = req.params.ticketId;
  const isCashierOrAdmin = req.user.role === "admin" || req.user.role === "super_admin";

  const row = withStore((store) =>
    store.bets.find((b) => {
      if (!matchTicket(b, ticketId)) return false;
      if (isCashierOrAdmin) return true;
      return String(b.user_id) === String(req.user.id);
    })
  );

  if (!row) return res.status(404).json({ ok: false, error: "Ticket not found" });

  if (row.status === "open") {
    await autoSettleOpenTickets(row.user_id);
  }

  const updatedRow = withStore((store) => store.bets.find((b) => b.ticket_id === row.ticket_id));
  let bets = [];
  try { bets = JSON.parse(updatedRow.selections); } catch (_) {}

  bets.forEach((b) => {
    if (b.score && typeof b.score === "string") {
      const parts = b.score.replace(":", "-").split("-");
      if (parts.length === 2) {
        b.ftScore = b.ftScore || `${parts[0]}:${parts[1]}`;
        if (parts[0] === "0" && parts[1] === "0") {
          b.htScore = b.htScore || "0:0";
        }
      }
    }
  });

  const wallet = withStore((store) => store.wallets[String(req.user.id)] || {});

  res.json({
    ok: true,
    ticket: {
      id: updatedRow.ticket_id,
      cashierCode: updatedRow.cashier_code || (function() {
        const m = String(updatedRow.ticket_id || "").match(/\d+/);
        return m ? String(1000 + (parseInt(m[0], 10) - 1)) : "1000";
      })(),
      status: updatedRow.status,
      payout: updatedRow.payout,
      stake: updatedRow.stake,
      totalOdds: updatedRow.total_odds,
      potentialWin: updatedRow.potential_win,
      bonusAwarded: Boolean(updatedRow.bonus_awarded || (updatedRow.bonus_amount && updatedRow.bonus_amount > 0)),
      bonusAmount: updatedRow.bonus_amount || 0,
      bonusMultiplier: updatedRow.bonus_multiplier || null,
      bonusRuleName: updatedRow.bonus_rule_name || null,
      bonusFailedCount: updatedRow.bonus_failed_count || null,
      bonusTotalTeams: updatedRow.bonus_total_teams || null,
      bets,
      placedAt: updatedRow.placed_at,
      settledAt: updatedRow.settled_at,
    },
    balance: wallet.balance,
  });
});

router.get("/ticket/:ticketId", async (req, res) => {
  const ticketId = req.params.ticketId;
  const row = withStore((store) => store.bets.find((b) => matchTicket(b, ticketId)));
  if (!row) return res.status(404).json({ ok: false, error: "Ticket not found" });

  if (row.status === "open") {
    await autoSettleOpenTickets(row.user_id);
  }

  const updatedRow = withStore((store) => store.bets.find((b) => b.ticket_id === row.ticket_id));
  let bets = [];
  try { bets = JSON.parse(updatedRow.selections); } catch (_) {}

  bets.forEach((b) => {
    if (b.score && typeof b.score === "string") {
      const parts = b.score.replace(":", "-").split("-");
      if (parts.length === 2) {
        b.ftScore = b.ftScore || `${parts[0]}:${parts[1]}`;
        if (parts[0] === "0" && parts[1] === "0") {
          b.htScore = b.htScore || "0:0";
        }
      }
    }
  });

  res.json({
    ok: true,
    ticket: {
      id: updatedRow.ticket_id,
      cashierCode: updatedRow.cashier_code || (function() {
        const m = String(updatedRow.ticket_id || "").match(/\d+/);
        return m ? String(1000 + (parseInt(m[0], 10) - 1)) : "1000";
      })(),
      status: updatedRow.status,
      payout: updatedRow.payout,
      stake: updatedRow.stake,
      totalOdds: updatedRow.total_odds,
      potentialWin: updatedRow.potential_win,
      mode: updatedRow.mode,
      bonusAwarded: Boolean(updatedRow.bonus_awarded || (updatedRow.bonus_amount && updatedRow.bonus_amount > 0)),
      bonusAmount: updatedRow.bonus_amount || 0,
      bonusMultiplier: updatedRow.bonus_multiplier || null,
      bonusRuleName: updatedRow.bonus_rule_name || null,
      bonusFailedCount: updatedRow.bonus_failed_count || null,
      bonusTotalTeams: updatedRow.bonus_total_teams || null,
      bets,
      placedAt: updatedRow.placed_at,
      settledAt: updatedRow.settled_at,
    },
  });
});

module.exports = router;
