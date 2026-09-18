const express = require("express");
const bcrypt = require("bcryptjs");
const { authRequired } = require("../middleware/auth");
const { loadStore, withStore, creditWallet, debitWallet, nextUserId } = require("../db");

const router = express.Router();

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== "admin" && req.user.role !== "super_admin") {
      return res.status(403).json({ ok: false, error: "Admin privileges required" });
    }
    const store = loadStore();
    const userRow = (store.users || []).find((u) => u.id === req.user.id);
    if (userRow && (userRow.status === "blocked" || userRow.status === "suspended")) {
      return res.status(403).json({ ok: false, error: "Your shop admin account has been blocked by the Super Admin." });
    }
    next();
  });
}

// 1. Dashboard statistics
router.get("/dashboard", adminRequired, (req, res) => {
  try {
    const store = loadStore();
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Filter players in our system (scoped to this shop admin if not super_admin)
    let players = (store.users || []).filter((u) => u.role === "player" || !u.role);
    if (req.user.role === "admin") {
      players = players.filter((u) => String(u.created_by_admin_id) === String(req.user.id));
    }
    const totalPlayers = players.length;

    const players24h = players.filter((u) => {
      if (!u.created_at) return false;
      return new Date(u.created_at) >= oneDayAgo;
    }).length;

    const players7d = players.filter((u) => {
      if (!u.created_at) return false;
      return new Date(u.created_at) >= sevenDaysAgo;
    }).length;

    // Daily registrations for last 7 days
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      const count = players.filter((u) => u.created_at && u.created_at.slice(0, 10) === dateStr).length;
      days.push({ date: dateStr, label, count });
    }

    // Bets in last 7 days (scoped to this shop's players)
    const shopPlayerIds = new Set(players.map((p) => String(p.id)));
    let bets = (store.bets || []);
    if (req.user.role === "admin") {
      bets = bets.filter((b) => shopPlayerIds.has(String(b.user_id)));
    }
    const last7dBets = bets.filter((b) => {
      const placed = b.placed_at || b.created_at;
      if (!placed) return true;
      return new Date(placed) >= sevenDaysAgo;
    });

    const sportBet = last7dBets.reduce((sum, b) => sum + (Number(b.stake) || 0), 0);
    const sportWin = last7dBets
      .filter((b) => b.status === "won")
      .reduce((sum, b) => sum + (Number(b.potential_win || b.payout) || 0), 0);
    const sportProfit = Math.round((sportBet - sportWin) * 100) / 100;
    const sportWinPct = sportBet > 0 ? Math.round((sportWin / sportBet) * 100) : 0;

    // Sport daily stats for last 7 days
    const sportDaily = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      const dayBets = bets.filter((b) => (b.placed_at || b.created_at || "").slice(0, 10) === dateStr);
      const dayStake = dayBets.reduce((sum, b) => sum + (Number(b.stake) || 0), 0);
      const dayWin = dayBets.filter((b) => b.status === "won").reduce((sum, b) => sum + (Number(b.potential_win || b.payout) || 0), 0);
      sportDaily.push({ date: dateStr, label, bet: dayStake, win: dayWin });
    }

    // Admin's own wallet
    const adminWallet = (store.wallets && store.wallets[String(req.user.id)]) || { balance: 0 };

    res.json({
      ok: true,
      stats: {
        balance: adminWallet.balance || 0,
        credits: 0,
        availability: adminWallet.balance || 0,
        players: totalPlayers,
        players24h,
        players7d,
        promoterCode: "HB7611994",
        affiliationLink: "https://hopebet.et/signup/?promoter_code=HB7611994",
        registrationStats: {
          total: totalPlayers,
          daily: days,
        },
        sportStats: {
          bet: Math.round(sportBet),
          win: Math.round(sportWin),
          profit: Math.round(sportProfit),
          pct: `${sportWinPct}%`,
          daily: sportDaily,
        },
        casinoStats: {
          bet: 0,
          win: 0,
          profit: 0,
          pct: "0%",
        },
      },
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. List / Search players
router.get("/players", adminRequired, (req, res) => {
  try {
    const store = loadStore();
    const { id, name, lastname, email, phone, username, dateFrom, dateTo, search, q } = req.query;

    let players = (store.users || []).filter((u) => u.role === "player" || !u.role);

    // Shop Admins strictly only see players created by their shop
    if (req.user.role === "admin") {
      players = players.filter((u) => String(u.created_by_admin_id) === String(req.user.id));
      if (players.length === 0 && !searchQuery && !id && !username && !name) {
        const defaultUname = `${req.user.username} player`;
        let p;
        withStore((s) => {
          const pId = nextUserId(s);
          p = {
            id: pId,
            username: defaultUname,
            display_name: `${req.user.display_name || req.user.username} Player`,
            email: `${req.user.username}_player@hopebet.local`,
            phone: null,
            password_hash: req.user.password_hash || "",
            role: "player",
            status: "active",
            created_by_admin_id: req.user.id,
            created_by_admin_name: req.user.display_name || req.user.username,
            created_at: new Date().toISOString(),
          };
          s.users.unshift(p);
          s.wallets[String(pId)] = {
            user_id: pId,
            balance: 0,
            currency: "ETB",
            updated_at: new Date().toISOString(),
          };
        });
        players = [p];
      }
    }

    const searchQuery = (search || q || "").trim().toLowerCase();
    if (searchQuery) {
      players = players.filter((u) => {
        const uid = String(u.id);
        const uname = (u.username || "").toLowerCase();
        const dname = (u.display_name || u.first_name || "").toLowerCase();
        const lname = (u.last_name || "").toLowerCase();
        const uemail = (u.email || "").toLowerCase();
        const uphone = (u.phone || "").toLowerCase();
        return uid.includes(searchQuery) || uname.includes(searchQuery) || dname.includes(searchQuery) || lname.includes(searchQuery) || uemail.includes(searchQuery) || uphone.includes(searchQuery);
      });
    }

    if (id) {
      players = players.filter((u) => String(u.id).includes(String(id).trim()));
    }
    if (username) {
      const q = String(username).trim().toLowerCase();
      players = players.filter((u) => (u.username || "").toLowerCase().includes(q));
    }
    if (name) {
      const q = String(name).trim().toLowerCase();
      players = players.filter((u) => (u.display_name || u.first_name || "").toLowerCase().includes(q));
    }
    if (lastname) {
      const q = String(lastname).trim().toLowerCase();
      players = players.filter((u) => (u.last_name || "").toLowerCase().includes(q));
    }
    if (email) {
      const q = String(email).trim().toLowerCase();
      players = players.filter((u) => (u.email || "").toLowerCase().includes(q));
    }
    if (phone) {
      const q = String(phone).replace(/\D/g, "");
      players = players.filter((u) => (u.phone || "").replace(/\D/g, "").includes(q));
    }
    if (dateFrom) {
      const fromTs = new Date(dateFrom).getTime();
      if (!isNaN(fromTs)) players = players.filter((u) => new Date(u.created_at).getTime() >= fromTs);
    }
    if (dateTo) {
      const toTs = new Date(dateTo).getTime();
      if (!isNaN(toTs)) players = players.filter((u) => new Date(u.created_at).getTime() <= toTs + 86400000);
    }

    const data = players.map((u) => {
      const wallet = store.wallets[String(u.id)] || { balance: 0 };
      const betsCount = (store.bets || []).filter((b) => String(b.user_id) === String(u.id)).length;
      return {
        id: u.id,
        username: u.username || u.phone || u.email,
        name: u.display_name || u.first_name || "—",
        lastname: u.last_name || "",
        email: u.email || "—",
        phone: u.phone || "—",
        balance: wallet.balance || 0,
        currency: wallet.currency || "ETB",
        betsCount,
        createdAt: u.created_at || new Date().toISOString(),
        status: u.status || "active",
      };
    });

    if (req.user.role === "admin") {
      const adminUname = (req.user.username || "").toLowerCase();
      data.sort((a, b) => {
        const aU = (a.username || "").toLowerCase();
        const bU = (b.username || "").toLowerCase();
        const aIsDef = aU === `${adminUname} player`;
        const bIsDef = bU === `${adminUname} player`;
        if (aIsDef && !bIsDef) return -1;
        if (!aIsDef && bIsDef) return 1;
        return 0;
      });
    }

    res.json({ ok: true, players: data });
  } catch (err) {
    console.error("Admin players error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. Create new player
router.post("/players", adminRequired, (req, res) => {
  try {
    const { username, phone, email, password, name, lastname, initialBalance } = req.body;
    const identifier = String(phone || username || email || "").trim();
    if (!identifier) {
      return res.status(400).json({ ok: false, error: "Username or Phone number is required" });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    let createdUser;
    withStore((store) => {
      if (store.users.some((u) =>
        (u.username && u.username.toLowerCase() === identifier.toLowerCase()) ||
        (u.phone && u.phone.replace(/\D/g, "") === identifier.replace(/\D/g, "")) ||
        (u.email && u.email.toLowerCase() === identifier.toLowerCase())
      )) {
        throw new Error("A player with this identifier already exists");
      }

      const newId = nextUserId(store);
      const cleanPhone = phone ? String(phone).trim() : (/^\+?\d{8,15}$/.test(identifier) ? identifier : null);
      const cleanEmail = email ? String(email).trim().toLowerCase() : `${identifier.replace(/\D/g, "") || identifier}@hopebet.local`;
      const displayName = String(name || "").trim() ? (lastname ? `${name} ${lastname}`.trim() : name.trim()) : identifier;

      createdUser = {
        id: newId,
        username: username || identifier,
        phone: cleanPhone,
        email: cleanEmail,
        first_name: name || "",
        last_name: lastname || "",
        display_name: displayName,
        password_hash: bcrypt.hashSync(password, 10),
        role: "player",
        status: "active",
        created_by_admin_id: req.user.id,
        created_by_admin_name: req.user.display_name || req.user.username,
        created_at: new Date().toISOString(),
      };
      store.users.unshift(createdUser);

      store.wallets[String(newId)] = {
        user_id: newId,
        balance: 0,
        currency: "ETB",
        updated_at: new Date().toISOString(),
      };
    });

    // Handle initial balance if provided
    const initBal = Number(initialBalance);
    if (initBal && initBal > 0) {
      if (req.user.role === "admin") {
        const storeBefore = loadStore();
        const adminWallet = (storeBefore.wallets && storeBefore.wallets[String(req.user.id)]) || { balance: 0 };
        const adminBal = Number(adminWallet.balance || 0);
        if (adminBal <= 0 || adminBal < initBal) {
          return res.status(400).json({
            ok: false,
            code: "INSUFFICIENT_ADMIN_BALANCE",
            error: `Insufficient admin balance (${adminBal} ETB available). You cannot provide initial balance to cashiers when you have no balance. Your balance can only be topped up by the Super Admin.`,
          });
        }
        debitWallet(req.user.id, initBal, "admin_transfer_out", "CASHIER_INITIAL_FLOAT", {
          note: `Initial float for cashier ${createdUser.username}`,
          targetUserId: createdUser.id,
        });
      }
      creditWallet(createdUser.id, initBal, "admin_grant", "ADMIN_NEW_PLAYER", { note: "Initial balance by Admin" });
      const store = loadStore();
      createdUser.balance = (store.wallets[String(createdUser.id)] || {}).balance || initBal;
    } else {
      createdUser.balance = 0;
    }

    res.json({
      ok: true,
      player: {
        id: createdUser.id,
        username: createdUser.username,
        name: createdUser.display_name,
        phone: createdUser.phone || "—",
        email: createdUser.email || "—",
        balance: createdUser.balance,
        createdByAdminId: createdUser.created_by_admin_id,
        createdByAdminName: createdUser.created_by_admin_name,
        createdAt: createdUser.created_at,
        status: createdUser.status,
      },
      message: `Player ${createdUser.username} created successfully`,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// 4. Top-up player/cashier balance
router.post("/players/:id/topup", adminRequired, (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const userId = Number(req.params.id);
    if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const store = loadStore();
    const targetPlayer = (store.users || []).find((u) => u.id === userId);
    if (!targetPlayer) return res.status(404).json({ ok: false, error: "Player not found" });

    // Rule: Admins cannot fund other admin accounts. Admin balances can only be topped up by Super Admin.
    if (targetPlayer.role === "admin" || targetPlayer.role === "super_admin") {
      return res.status(403).json({
        ok: false,
        error: "Admins cannot fund admin accounts. Admin balances can only be topped up by the Super Admin.",
      });
    }

    if (req.user.role === "admin" && String(targetPlayer.created_by_admin_id) !== String(req.user.id)) {
      return res.status(403).json({ ok: false, error: "Access denied: You can only deposit/withdraw for players created by your shop." });
    }

    // Rule: If the admin has no balance (or insufficient balance), they cannot fund or top up the cashier!
    if (req.user.role === "admin") {
      const adminWallet = (store.wallets && store.wallets[String(req.user.id)]) || { balance: 0 };
      const adminBalance = Number(adminWallet.balance || 0);
      if (adminBalance <= 0 || adminBalance < amount) {
        return res.status(400).json({
          ok: false,
          code: "INSUFFICIENT_ADMIN_BALANCE",
          error: `Insufficient admin balance (${adminBalance} ETB available). You cannot fund or top up cashiers when you have no balance. Your balance can only be topped up by the Super Admin.`,
        });
      }

      // Debit the admin's float wallet
      debitWallet(req.user.id, amount, "admin_transfer_out", "CASHIER_FUNDING", {
        note: `Funded cashier ${targetPlayer.username || targetPlayer.display_name}`,
        targetUserId: userId,
      });
    }

    // Credit the cashier's wallet
    const newBalance = creditWallet(userId, amount, "admin_topup", "ADMIN_TOPUP", {
      note: "Balance top-up by Admin",
      adminId: req.user.id,
    });

    // Fresh admin balance
    const freshStore = loadStore();
    const freshAdminWallet = (freshStore.wallets && freshStore.wallets[String(req.user.id)]) || { balance: 0 };

    res.json({
      ok: true,
      amount,
      newBalance,
      adminBalance: freshAdminWallet.balance || 0,
      message: `Successfully credited ${amount} ETB to ${targetPlayer.username || targetPlayer.display_name}`,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        ok: false,
        code: "INSUFFICIENT_ADMIN_BALANCE",
        error: "Insufficient admin balance. You cannot fund or top up cashiers when you have no balance. Your balance can only be topped up by the Super Admin.",
      });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4b. Transfer funds (Deposit or Withdraw) with operation and reason
router.post("/players/:id/transfer", adminRequired, (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const operation = (req.body.operation || "deposit").toLowerCase();
    const reason = String(req.body.reason || "").trim() || (operation === "withdraw" ? "Withdrawal by Admin" : "Deposit by Admin");
    const userId = Number(req.params.id);

    if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const store = loadStore();
    const targetPlayer = (store.users || []).find((u) => u.id === userId);
    if (!targetPlayer) return res.status(404).json({ ok: false, error: "Player not found" });

    // Rule: Admins cannot fund other admin accounts. Admin balances can only be topped up by Super Admin.
    if (targetPlayer.role === "admin" || targetPlayer.role === "super_admin") {
      return res.status(403).json({
        ok: false,
        error: "Admins cannot transfer funds to admin accounts. Admin balances can only be topped up by the Super Admin.",
      });
    }

    if (req.user.role === "admin" && String(targetPlayer.created_by_admin_id) !== String(req.user.id)) {
      return res.status(403).json({ ok: false, error: "Access denied: You can only deposit/withdraw for players created by your shop." });
    }

    let newBalance;
    if (operation === "withdraw") {
      // Debit player
      newBalance = debitWallet(userId, amount, "admin_withdraw", "ADMIN_WITHDRAW", { note: reason, adminId: req.user.id });
      // Credit admin's float back
      if (req.user.role === "admin") {
        creditWallet(req.user.id, amount, "admin_transfer_in", "CASHIER_RETURN", {
          note: `Withdrawn from cashier ${targetPlayer.username || targetPlayer.display_name}`,
          fromUserId: userId,
        });
      }
    } else {
      // Operation is "deposit": Admin funds the cashier
      if (req.user.role === "admin") {
        const adminWallet = (store.wallets && store.wallets[String(req.user.id)]) || { balance: 0 };
        const adminBalance = Number(adminWallet.balance || 0);
        if (adminBalance <= 0 || adminBalance < amount) {
          return res.status(400).json({
            ok: false,
            code: "INSUFFICIENT_ADMIN_BALANCE",
            error: `Insufficient admin balance (${adminBalance} ETB available). You cannot fund or top up cashiers when you have no balance. Your balance can only be topped up by the Super Admin.`,
          });
        }

        // Debit the admin's float wallet
        debitWallet(req.user.id, amount, "admin_transfer_out", "CASHIER_FUNDING", {
          note: `Funded cashier ${targetPlayer.username || targetPlayer.display_name}`,
          targetUserId: userId,
        });
      }

      newBalance = creditWallet(userId, amount, "admin_deposit", "ADMIN_DEPOSIT", { note: reason, adminId: req.user.id });
    }

    const freshStore = loadStore();
    const freshAdminWallet = (freshStore.wallets && freshStore.wallets[String(req.user.id)]) || { balance: 0 };

    res.json({
      ok: true,
      amount,
      operation,
      newBalance,
      adminBalance: freshAdminWallet.balance || 0,
      message: `${operation === "withdraw" ? "Withdrawal" : "Deposit"} of ${amount} ETB completed`,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        ok: false,
        error: operation === "withdraw"
          ? "Player has insufficient balance for withdrawal"
          : "Insufficient admin balance. You cannot fund or top up cashiers when you have no balance. Your balance can only be topped up by the Super Admin.",
      });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. Admin Transactions Log
router.get("/transactions", adminRequired, (req, res) => {
  try {
    const store = loadStore();
    const { type } = req.query;
    const search = String(req.query.search || "").trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit || 50), 100);

    const usersMap = {};
    (store.users || []).forEach((u) => {
      usersMap[u.id] = u;
    });

    let txs = store.transactions || [];

    if (req.user.role === "admin") {
      const allowedUserIds = new Set(
        (store.users || [])
          .filter((u) => String(u.id) === String(req.user.id) || String(u.created_by_admin_id) === String(req.user.id))
          .map((u) => u.id)
      );
      txs = txs.filter((t) => allowedUserIds.has(t.user_id));
    }

    if (type && type !== "all") {
      txs = txs.filter((t) => {
        const tType = String(t.type || "").toLowerCase();
        if (type === "withdraw") {
          return tType.includes("withdraw") || t.amount < 0;
        }
        if (type === "deposit") {
          return tType.includes("deposit") || t.amount > 0;
        }
        if (type === "voucher") {
          return tType.includes("voucher");
        }
        return tType === type;
      });
    }

    if (search) {
      txs = txs.filter((t) => {
        const u = usersMap[t.user_id];
        const uname = (u?.username || u?.phone || "").toLowerCase();
        const ref = String(t.reference || "").toLowerCase();
        const idStr = String(t.id || "");
        return uname.includes(search) || ref.includes(search) || idStr.includes(search);
      });
    }

    const items = txs.slice(0, limit).map((t) => {
      const user = usersMap[t.user_id];
      return {
        id: t.id,
        userId: t.user_id,
        username: user?.username || user?.phone || (t.user_id ? `#${t.user_id}` : "Cashier Walk-in"),
        type: t.type,
        amount: Math.abs(t.amount),
        isDebit: t.amount < 0 || String(t.type).includes("withdraw"),
        balanceAfter: t.balance_after,
        reference: t.reference,
        meta: t.meta,
        createdAt: t.created_at,
      };
    });

    res.json({
      ok: true,
      total: txs.length,
      transactions: items,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4d. Process Voucher Transaction (Withdraw or Deposit)
router.post("/transactions/voucher", adminRequired, (req, res) => {
  try {
    const operation = (req.body.operation || "withdraw").toLowerCase();
    const amount = Number(req.body.amount || 0);
    const userId = req.body.userId ? Number(req.body.userId) : null;
    let voucherCode = String(req.body.voucherCode || "").trim();
    const reason = String(req.body.reason || "").trim() || `Voucher ${operation === "withdraw" ? "Payout" : "Deposit"}`;

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount" });
    }

    if (!voucherCode) {
      // Auto-generate voucher code: VCH-XXXX-XXXX
      const rnd1 = Math.random().toString(36).substring(2, 6).toUpperCase();
      const rnd2 = Math.random().toString(36).substring(2, 6).toUpperCase();
      voucherCode = `VCH-${rnd1}-${rnd2}`;
    }

    let newBalance = null;
    if (userId) {
      const store = loadStore();
      const targetPlayer = (store.users || []).find((u) => u.id === userId);
      if (targetPlayer && (targetPlayer.role === "admin" || targetPlayer.role === "super_admin")) {
        return res.status(403).json({
          ok: false,
          error: "Admins cannot fund admin accounts. Admin balances can only be topped up by the Super Admin.",
        });
      }

      if (operation === "withdraw") {
        newBalance = debitWallet(userId, amount, "voucher_withdraw", voucherCode, { voucherCode, note: reason });
        if (req.user && req.user.role === "admin") {
          creditWallet(req.user.id, amount, "admin_voucher_recovery", voucherCode, {
            note: `Voucher payout recovery for player ${userId}`,
            fromUserId: userId,
          });
        }
      } else {
        if (req.user && req.user.role === "admin") {
          const adminWallet = (store.wallets && store.wallets[String(req.user.id)]) || { balance: 0 };
          const adminBalance = Number(adminWallet.balance || 0);
          if (adminBalance <= 0 || adminBalance < amount) {
            return res.status(400).json({
              ok: false,
              code: "INSUFFICIENT_ADMIN_BALANCE",
              error: `Insufficient admin balance (${adminBalance} ETB available). You cannot fund or top up cashiers when you have no balance. Your balance can only be topped up by the Super Admin.`,
              adminBalance,
            });
          }
          debitWallet(req.user.id, amount, "admin_voucher_payout", voucherCode, {
            note: `Voucher deposit to player ${userId}`,
            targetUserId: userId,
          });
        }
        newBalance = creditWallet(userId, amount, "voucher_deposit", voucherCode, { voucherCode, note: reason });
      }
    } else {
      // Direct voucher payout logged without a specific user
      if (operation === "deposit" && req.user && req.user.role === "admin") {
        const store = loadStore();
        const adminWallet = (store.wallets && store.wallets[String(req.user.id)]) || { balance: 0 };
        const adminBalance = Number(adminWallet.balance || 0);
        if (adminBalance <= 0 || adminBalance < amount) {
          return res.status(400).json({
            ok: false,
            code: "INSUFFICIENT_ADMIN_BALANCE",
            error: `Insufficient admin balance (${adminBalance} ETB available). You cannot fund or issue vouchers when you have no balance. Your balance can only be topped up by the Super Admin.`,
            adminBalance,
          });
        }
        debitWallet(req.user.id, amount, "admin_voucher_issue", voucherCode, { note: reason });
      }
      withStore((store) => {
        if (!store.counters) store.counters = { user: 0, bet: 0, tx: 0, deposit: 0 };
        store.counters.tx = Number(store.counters.tx || 0) + 1;
        if (!Array.isArray(store.transactions)) store.transactions = [];
        store.transactions.unshift({
          id: store.counters.tx,
          user_id: null,
          type: operation === "withdraw" ? "voucher_withdraw" : "voucher_deposit",
          amount: operation === "withdraw" ? -amount : amount,
          balance_after: 0,
          reference: voucherCode,
          meta: { voucherCode, note: reason, cashier: req.user.username },
          created_at: new Date().toISOString(),
        });
      });
    }

    const freshStore = loadStore();
    const freshAdminWallet = (req.user && freshStore.wallets && freshStore.wallets[String(req.user.id)]) || { balance: 0 };

    res.json({
      ok: true,
      operation,
      amount,
      voucherCode,
      newBalance,
      adminBalance: freshAdminWallet.balance || 0,
      message: `Voucher ${operation === "withdraw" ? "withdrawal" : "deposit"} of ${amount} ETB processed successfully`,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ ok: false, error: "Player has insufficient balance for voucher withdrawal" });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. List / Search sport coupons (tickets)
router.get("/coupons", adminRequired, (req, res) => {
  try {
    const store = loadStore();
    const {
      from,
      to,
      status,
      betType,
      user,
      betId,
      betCode,
      minWin,
      maxWin,
      sport,
      orderBy,
    } = req.query;

    let tickets = store.bets || [];

    if (req.user.role === "admin") {
      const myPlayerIds = new Set(
        (store.users || [])
          .filter((u) => String(u.created_by_admin_id) === String(req.user.id))
          .map((u) => String(u.id))
      );
      tickets = tickets.filter(
        (t) =>
          myPlayerIds.has(String(t.user_id)) ||
          String(t.cashier_id) === String(req.user.id) ||
          String(t.user_id) === String(req.user.id)
      );
    }

    // Map users by id for quick lookup
    const userMap = {};
    (store.users || []).forEach((u) => {
      userMap[String(u.id)] = u;
    });

    tickets = tickets.map((t) => {
      let parsedSelections = [];
      try {
        parsedSelections = typeof t.selections === "string" ? JSON.parse(t.selections) : (t.selections || []);
      } catch (e) {
        parsedSelections = [];
      }
      const u = userMap[String(t.user_id)];
      return {
        id: t.ticket_id,
        ticketId: t.ticket_id,
        cashierCode: t.cashier_code || (function() {
          const m = String(t.ticket_id || "").match(/\d+/);
          return m ? String(1000 + (parseInt(m[0], 10) - 1)) : "1000";
        })(),
        userId: t.user_id,
        username: u ? (u.username || u.display_name || `User ${u.id}`) : `User ${t.user_id}`,
        userPhone: u ? (u.phone || "—") : "—",
        userDisplayName: u ? (u.display_name || u.username) : `User ${t.user_id}`,
        stake: Number(t.stake) || 0,
        totalOdds: Number(t.total_odds) || 1,
        potentialWin: Number(t.potential_win) || 0,
        payout: Number(t.payout) || 0,
        status: (t.status || "open").toLowerCase(),
        mode: t.mode || "multiple",
        placedAt: t.placed_at || t.created_at || new Date().toISOString(),
        selections: parsedSelections,
        selectionCount: parsedSelections.length,
      };
    });

    // Filter by status
    if (status && status.toLowerCase() !== "all") {
      tickets = tickets.filter((t) => t.status === status.toLowerCase());
    }

    // Filter by betType (e.g. "Won", "Lost", "Issued", "All")
    if (betType && betType.toLowerCase() !== "all") {
      const bt = betType.toLowerCase();
      if (bt === "won") tickets = tickets.filter((t) => t.status === "won");
      else if (bt === "lost") tickets = tickets.filter((t) => t.status === "lost");
      else if (bt === "issued" || bt === "open") tickets = tickets.filter((t) => t.status === "open");
    }

    // Filter by date range (from / to)
    if (from) {
      const fromTime = new Date(from).getTime();
      if (!isNaN(fromTime)) {
        tickets = tickets.filter((t) => new Date(t.placedAt).getTime() >= fromTime);
      }
    }
    if (to) {
      const toTime = new Date(to).getTime();
      if (!isNaN(toTime)) {
        tickets = tickets.filter((t) => new Date(t.placedAt).getTime() <= toTime);
      }
    }

    // Filter by ticket ID / betCode
    const codeSearch = (betCode || betId || "").trim().toLowerCase();
    if (codeSearch) {
      tickets = tickets.filter((t) => (t.ticketId || "").toLowerCase().includes(codeSearch));
    }

    // Filter by user / parent
    if (user && user.trim()) {
      const uSearch = user.trim().toLowerCase();
      tickets = tickets.filter(
        (t) =>
          String(t.userId).includes(uSearch) ||
          t.username.toLowerCase().includes(uSearch) ||
          t.userPhone.toLowerCase().includes(uSearch)
      );
    }

    // Filter by minWin / maxWin
    if (minWin) {
      const minVal = Number(minWin);
      if (!isNaN(minVal)) tickets = tickets.filter((t) => t.potentialWin >= minVal);
    }
    if (maxWin) {
      const maxVal = Number(maxWin);
      if (!isNaN(maxVal)) tickets = tickets.filter((t) => t.potentialWin <= maxVal);
    }

    // Filter by sport if selections contain sport
    if (sport && sport.toLowerCase() !== "all") {
      const sp = sport.toLowerCase();
      tickets = tickets.filter((t) =>
        t.selections.some((s) => (s.sport || "football").toLowerCase() === sp)
      );
    }

    // Order by placedAt
    if (orderBy === "asc") {
      tickets.sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime());
    } else {
      tickets.sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime());
    }

    res.json({
      ok: true,
      total: tickets.length,
      coupons: tickets,
    });
  } catch (err) {
    console.error("Admin coupons error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
