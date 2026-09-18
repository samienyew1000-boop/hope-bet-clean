const express = require("express");
const { superAdminRequired } = require("../middleware/auth");
const { withStore, loadStore, creditWallet, debitWallet, nextUserId } = require("../db");
const bcrypt = require("bcryptjs");

const router = express.Router();
router.use(superAdminRequired);

// ==========================================
// 1. ADMINS (SHOPS) MANAGEMENT
// ==========================================

// List all Shop Admins
router.get("/admins", (req, res) => {
  try {
    const store = loadStore();
    const admins = (store.users || []).filter((u) => u.role === "admin");
    const allPlayers = (store.users || []).filter((u) => u.role === "player" || !u.role);

    const data = admins.map((a) => {
      const wallet = store.wallets[String(a.id)] || { balance: 0 };
      const playersCreated = allPlayers.filter((p) => String(p.created_by_admin_id) === String(a.id)).length;
      return {
        id: a.id,
        username: a.username,
        email: a.email,
        phone: a.phone || "—",
        displayName: a.display_name || a.username,
        role: a.role,
        balance: wallet.balance || 0,
        currency: wallet.currency || "ETB",
        playersCreated,
        createdAt: a.created_at || new Date().toISOString(),
        status: a.status || "active",
      };
    });

    res.json({ ok: true, admins: data });
  } catch (err) {
    console.error("[super/admins]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a new Shop Admin
router.post("/admins", (req, res) => {
  try {
    const { username, password, displayName, phone, email, initialCredit } = req.body;
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanUsername) {
      return res.status(400).json({ ok: false, error: "Admin username is required" });
    }
    if (cleanPassword.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    let createdAdmin;
    withStore((store) => {
      if (store.users.some((u) => u.username && u.username.toLowerCase() === cleanUsername.toLowerCase())) {
        throw new Error("An account with this username already exists");
      }

      const newId = nextUserId(store);
      const cleanEmail = email ? String(email).trim().toLowerCase() : `${cleanUsername}@hope.bet.local`;
      const name = displayName ? String(displayName).trim() : `Shop ${cleanUsername}`;

      createdAdmin = {
        id: newId,
        username: cleanUsername,
        display_name: name,
        email: cleanEmail,
        phone: phone ? String(phone).trim() : null,
        password_hash: bcrypt.hashSync(cleanPassword, 10),
        role: "admin",
        status: "active",
        created_at: new Date().toISOString(),
      };

      store.users.unshift(createdAdmin);

      store.wallets[String(newId)] = {
        user_id: newId,
        balance: 0,
        currency: "ETB",
        updated_at: new Date().toISOString(),
      };

      // Auto-create default player for this shop admin:
      // For example, if admin's name is "test", the player will be "test player"
      const playerUsername = `${cleanUsername} player`;
      const playerId = nextUserId(store);
      const createdPlayer = {
        id: playerId,
        username: playerUsername,
        display_name: `${cleanUsername} player`,
        email: `${cleanUsername}_player@hopebet.local`,
        phone: null,
        password_hash: bcrypt.hashSync(cleanPassword, 10),
        role: "player",
        status: "active",
        created_by_admin_id: createdAdmin.id,
        created_by_admin_name: createdAdmin.display_name || createdAdmin.username,
        created_at: new Date().toISOString(),
      };

      store.users.unshift(createdPlayer);

      store.wallets[String(playerId)] = {
        user_id: playerId,
        balance: 0,
        currency: "ETB",
        updated_at: new Date().toISOString(),
      };
    });

    const initAmount = Number(initialCredit || 0);
    if (initAmount > 0) {
      creditWallet(createdAdmin.id, initAmount, "super_grant", "SUPER_GRANT", { note: "Initial balance granted by Super Admin" });
      const store = loadStore();
      createdAdmin.balance = (store.wallets[String(createdAdmin.id)] || {}).balance || initAmount;
    } else {
      createdAdmin.balance = 0;
    }

    res.json({
      ok: true,
      admin: {
        id: createdAdmin.id,
        username: createdAdmin.username,
        displayName: createdAdmin.display_name,
        balance: createdAdmin.balance,
        createdAt: createdAdmin.created_at,
      },
      message: `Shop Admin '${createdAdmin.username}' and player '${cleanUsername} player' created successfully`,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Transfer funds (Deposit or Withdraw) for a Shop Admin
router.post("/admins/:id/transfer", (req, res) => {
  try {
    const adminId = Number(req.params.id);
    const amount = Number(req.body.amount || 0);
    const operation = String(req.body.operation || "deposit").toLowerCase();
    const reason = String(req.body.reason || "").trim() || (operation === "withdraw" ? "Withdrawal by Super Admin" : "Deposit by Super Admin");

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Valid amount greater than 0 is required" });
    }

    const store = loadStore();
    const adminUser = store.users.find((u) => u.id === adminId && u.role === "admin");
    if (!adminUser) {
      return res.status(404).json({ ok: false, error: "Shop Admin not found" });
    }

    let newBalance;
    if (operation === "withdraw") {
      newBalance = debitWallet(adminId, amount, "super_withdraw", "SUPER_WITHDRAW", { note: reason });
    } else {
      newBalance = creditWallet(adminId, amount, "super_deposit", "SUPER_DEPOSIT", { note: reason });
    }

    res.json({
      ok: true,
      adminId,
      amount,
      operation,
      newBalance,
      message: `${operation === "withdraw" ? "Withdrawal" : "Deposit"} of ${amount} ETB completed for Admin ${adminUser.username}`,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ ok: false, error: "Admin has insufficient balance for withdrawal" });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Top up Shop Admin Float directly
router.post("/admins/:id/topup", (req, res) => {
  try {
    const adminId = Number(req.params.id);
    const amount = Number(req.body.amount || 0);
    const reason = String(req.body.reason || "Super Admin Float Top-up").trim();

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Valid amount greater than 0 is required" });
    }

    const store = loadStore();
    const adminUser = store.users.find((u) => u.id === adminId && u.role === "admin");
    if (!adminUser) {
      return res.status(404).json({ ok: false, error: "Shop Admin not found" });
    }

    const newBalance = creditWallet(adminId, amount, "super_deposit", "SUPER_FLOAT_TOPUP", { note: reason });

    res.json({
      ok: true,
      adminId,
      amount,
      newBalance,
      message: `Shop float top-up of ${amount} ETB completed for Admin ${adminUser.username}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Change Shop Admin Password
router.post("/admins/:id/password", (req, res) => {
  try {
    const adminId = Number(req.params.id);
    const password = String(req.body.password || "").trim();

    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    let adminUsername = "";
    withStore((store) => {
      const admin = store.users.find((u) => u.id === adminId && u.role === "admin");
      if (!admin) {
        throw new Error("Shop Admin not found");
      }
      admin.password_hash = bcrypt.hashSync(password, 10);
      adminUsername = admin.username;
    });

    res.json({
      ok: true,
      adminId,
      message: `Password for Shop Admin '${adminUsername}' updated successfully`,
    });
  } catch (err) {
    res.status(err.message === "Shop Admin not found" ? 404 : 400).json({ ok: false, error: err.message });
  }
});

// Change Shop Admin Status (Block / Unblock)
router.post("/admins/:id/status", (req, res) => {
  try {
    const adminId = Number(req.params.id);
    let newStatus = req.body.status ? String(req.body.status).toLowerCase().trim() : null;

    let updatedAdmin = null;
    withStore((store) => {
      const admin = store.users.find((u) => u.id === adminId && u.role === "admin");
      if (!admin) {
        throw new Error("Shop Admin not found");
      }
      if (!newStatus) {
        newStatus = admin.status === "blocked" ? "active" : "blocked";
      }
      if (newStatus !== "active" && newStatus !== "blocked" && newStatus !== "suspended") {
        throw new Error("Invalid status. Allowed values: active, blocked");
      }
      admin.status = newStatus;
      updatedAdmin = {
        id: admin.id,
        username: admin.username,
        status: admin.status,
      };
    });

    res.json({
      ok: true,
      admin: updatedAdmin,
      message: `Shop Admin '${updatedAdmin.username}' is now ${updatedAdmin.status.toUpperCase()}`,
    });
  } catch (err) {
    res.status(err.message === "Shop Admin not found" ? 404 : 400).json({ ok: false, error: err.message });
  }
});

// Delete Shop Admin Account
router.delete("/admins/:id", (req, res) => {
  try {
    const adminId = Number(req.params.id);

    let deletedUsername = "";
    withStore((store) => {
      const adminIndex = store.users.findIndex((u) => u.id === adminId && u.role === "admin");
      if (adminIndex === -1) {
        throw new Error("Shop Admin not found");
      }
      const admin = store.users[adminIndex];
      deletedUsername = admin.username;

      // Remove admin from users
      store.users.splice(adminIndex, 1);

      // Clean up wallet
      if (store.wallets && store.wallets[String(adminId)]) {
        delete store.wallets[String(adminId)];
      }

      // Detach players created by this admin
      (store.users || []).forEach((u) => {
        if (String(u.created_by_admin_id) === String(adminId)) {
          u.created_by_admin_id = null;
          u.created_by_admin_name = `${deletedUsername} (Deleted Shop)`;
        }
      });
    });

    res.json({
      ok: true,
      adminId,
      message: `Shop Admin '${deletedUsername}' deleted successfully`,
    });
  } catch (err) {
    res.status(err.message === "Shop Admin not found" ? 404 : 400).json({ ok: false, error: err.message });
  }
});

// Change Super Admin's own password
router.post("/change-password", (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const cleanNewPassword = String(newPassword || "").trim();

    if (!cleanNewPassword || cleanNewPassword.length < 6) {
      return res.status(400).json({ ok: false, error: "New password must be at least 6 characters" });
    }

    const store = loadStore();
    const superId = req.user ? req.user.id : null;
    let superUser = null;
    if (superId) {
      superUser = (store.users || []).find((u) => u.id === superId);
    }
    if (!superUser) {
      superUser = (store.users || []).find((u) => u.username === "super") || (store.users || []).find((u) => u.role === "super_admin");
    }

    if (!superUser) {
      return res.status(404).json({ ok: false, error: "Super Admin account not found" });
    }

    // Verify current password if provided and password_hash exists
    if (superUser.password_hash && currentPassword) {
      const isValid = bcrypt.compareSync(String(currentPassword), superUser.password_hash);
      if (!isValid) {
        return res.status(400).json({ ok: false, error: "Incorrect current password" });
      }
    }

    withStore((s) => {
      const target = (s.users || []).find((u) => u.id === superUser.id);
      if (target) {
        target.password_hash = bcrypt.hashSync(cleanNewPassword, 10);
      }
    });

    res.json({
      ok: true,
      message: "Super Admin password updated successfully",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// General user / admin top-up endpoint for Super Admin (used by api-client.js superAdminTopUp)
router.post("/users/:id/topup", (req, res) => {
  try {
    const userId = Number(req.params.id);
    const amount = Number(req.body.amount || 0);
    const reason = String(req.body.reason || "Super Admin Top-up").trim();

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Valid amount greater than 0 is required" });
    }

    const store = loadStore();
    const user = (store.users || []).find((u) => u.id === userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const newBalance = creditWallet(userId, amount, "super_deposit", "SUPER_TOPUP", { note: reason });

    res.json({
      ok: true,
      userId,
      amount,
      newBalance,
      message: `Top-up of ${amount} ETB completed for ${user.role === "admin" ? "Admin" : "Player"} ${user.username || user.display_name}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ==========================================
// 2. GLOBAL PLAYERS MANAGEMENT
// ==========================================

// List all players across all shops
router.get("/players", (req, res) => {
  try {
    const store = loadStore();
    const search = String(req.query.search || "").trim().toLowerCase();
    const adminFilter = req.query.adminId ? Number(req.query.adminId) : null;

    let players = (store.users || []).filter((u) => u.role === "player" || !u.role);

    if (adminFilter) {
      players = players.filter((u) => String(u.created_by_admin_id) === String(adminFilter));
    }

    if (search) {
      players = players.filter((u) =>
        String(u.id).includes(search) ||
        (u.username && u.username.toLowerCase().includes(search)) ||
        (u.display_name && u.display_name.toLowerCase().includes(search)) ||
        (u.phone && u.phone.toLowerCase().includes(search)) ||
        (u.email && u.email.toLowerCase().includes(search)) ||
        (u.created_by_admin_name && u.created_by_admin_name.toLowerCase().includes(search))
      );
    }

    const adminsMap = {};
    (store.users || []).filter((u) => u.role === "admin").forEach((a) => {
      adminsMap[a.id] = a.display_name || a.username;
    });

    const data = players.map((u) => {
      const wallet = store.wallets[String(u.id)] || { balance: 0 };
      const betsCount = (store.bets || []).filter((b) => String(b.user_id) === String(u.id)).length;
      const creatorName = u.created_by_admin_id
        ? (adminsMap[u.created_by_admin_id] || u.created_by_admin_name || `Shop #${u.created_by_admin_id}`)
        : "Direct Registration";

      return {
        id: u.id,
        username: u.username || u.phone || u.email,
        name: u.display_name || u.first_name || "—",
        phone: u.phone || "—",
        email: u.email || "—",
        balance: wallet.balance || 0,
        currency: wallet.currency || "ETB",
        betsCount,
        createdByAdminId: u.created_by_admin_id || null,
        createdByAdminName: creatorName,
        createdAt: u.created_at || new Date().toISOString(),
        status: u.status || "active",
      };
    });

    res.json({ ok: true, players: data });
  } catch (err) {
    console.error("[super/players]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Transfer funds (Deposit or Withdraw) for any player
router.post("/players/:id/transfer", (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const amount = Number(req.body.amount || 0);
    const operation = String(req.body.operation || "deposit").toLowerCase();
    const reason = String(req.body.reason || "").trim() || (operation === "withdraw" ? "Super Admin Withdrawal" : "Super Admin Deposit");

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Valid amount greater than 0 is required" });
    }

    const store = loadStore();
    const player = store.users.find((u) => u.id === playerId);
    if (!player) {
      return res.status(404).json({ ok: false, error: "Player not found" });
    }

    let newBalance;
    if (operation === "withdraw") {
      newBalance = debitWallet(playerId, amount, "super_withdraw", "SUPER_PLAYER_WITHDRAW", { note: reason });
    } else {
      newBalance = creditWallet(playerId, amount, "super_deposit", "SUPER_PLAYER_DEPOSIT", { note: reason });
    }

    res.json({
      ok: true,
      playerId,
      amount,
      operation,
      newBalance,
      message: `${operation === "withdraw" ? "Withdrawal" : "Deposit"} of ${amount} ETB completed for Player ${player.username || player.phone}`,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ ok: false, error: "Player has insufficient balance for withdrawal" });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 3. SETTINGS (RECEIVER PHONE & LIMITS)
// ==========================================

// Get current platform deposit receiver settings
router.get("/settings", (_req, res) => {
  try {
    const store = loadStore();
    res.json({
      ok: true,
      settings: store.settings || {
        telebirr_receiver: "0937383800",
        cbe_receiver: "1000123456789",
        min_deposit: 100,
        max_deposit: 75000,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Update deposit receiver & bonus settings
router.post("/settings", (req, res) => {
  try {
    const { telebirr_receiver, cbe_receiver, min_deposit, max_deposit, bonus_enabled, bonus_min_odd_per_leg, bonus_rules } = req.body;

    const updated = withStore((store) => {
      if (!store.settings) store.settings = {};

      if (telebirr_receiver !== undefined) {
        store.settings.telebirr_receiver = String(telebirr_receiver).trim();
      }
      if (cbe_receiver !== undefined) {
        store.settings.cbe_receiver = String(cbe_receiver).trim();
      }
      if (min_deposit !== undefined) {
        store.settings.min_deposit = Number(min_deposit) || 100;
      }
      if (max_deposit !== undefined) {
        store.settings.max_deposit = Number(max_deposit) || 75000;
      }
      if (bonus_enabled !== undefined) {
        store.settings.bonus_enabled = Boolean(bonus_enabled);
      }
      if (bonus_min_odd_per_leg !== undefined) {
        store.settings.bonus_min_odd_per_leg = Number(bonus_min_odd_per_leg) || 1.15;
      }
      if (Array.isArray(bonus_rules)) {
        store.settings.bonus_rules = bonus_rules;
      }

      return store.settings;
    });

    res.json({
      ok: true,
      settings: updated,
      message: "Platform settings updated successfully",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 4. NEAR-MISS CONSOLATION BONUS SYSTEM
// ==========================================

// Get bonus rules and global status
router.get("/bonus-rules", (_req, res) => {
  try {
    const store = loadStore();
    const s = store.settings || {};
    res.json({
      ok: true,
      bonus_enabled: s.bonus_enabled !== false,
      bonus_min_odd_per_leg: s.bonus_min_odd_per_leg || 1.15,
      bonus_rules: Array.isArray(s.bonus_rules) ? s.bonus_rules : [],
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Save all or add new bonus rule
router.post("/bonus-rules", (req, res) => {
  try {
    const { rules, bonus_enabled, bonus_min_odd_per_leg } = req.body;
    const rawRule = req.body.rule || (req.body.name || req.body.minTeams ? req.body : null);

    let savedRule = null;
    const updated = withStore((store) => {
      if (!store.settings) store.settings = {};
      if (bonus_enabled !== undefined) store.settings.bonus_enabled = Boolean(bonus_enabled);
      if (bonus_min_odd_per_leg !== undefined) store.settings.bonus_min_odd_per_leg = Number(bonus_min_odd_per_leg) || 1.15;

      if (!Array.isArray(store.settings.bonus_rules)) store.settings.bonus_rules = [];

      if (Array.isArray(rules)) {
        store.settings.bonus_rules = rules;
      } else if (rawRule && typeof rawRule === "object") {
        const id = rawRule.id || `rule_${Date.now()}`;
        const newRule = {
          id,
          name: String(rawRule.name || `${rawRule.minTeams}+ Teams (Cut ${rawRule.failedCount})`),
          failedCount: Number(rawRule.failedCount) || 1,
          minTeams: Number(rawRule.minTeams) || 5,
          maxTeams: rawRule.maxTeams != null && rawRule.maxTeams !== "" ? Number(rawRule.maxTeams) : null,
          multiplier: Number(rawRule.multiplier) || 2.0,
          minOddPerLeg: Number(rawRule.minOddPerLeg) || store.settings.bonus_min_odd_per_leg || 1.15,
          enabled: rawRule.enabled !== false,
        };
        savedRule = newRule;
        const existingIdx = store.settings.bonus_rules.findIndex((r) => r.id === id);
        if (existingIdx >= 0) {
          store.settings.bonus_rules[existingIdx] = newRule;
        } else {
          store.settings.bonus_rules.push(newRule);
        }
      }

      return store.settings;
    });

    res.json({
      ok: true,
      rule: savedRule,
      rules: updated.bonus_rules,
      bonus_rules: updated.bonus_rules,
      settings: updated,
      message: "Bonus rules updated successfully",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Update specific bonus rule
router.put("/bonus-rules/:id", (req, res) => {
  try {
    const ruleId = String(req.params.id);
    const updates = req.body;

    let allRules = [];
    const updated = withStore((store) => {
      if (!store.settings || !Array.isArray(store.settings.bonus_rules)) {
        throw new Error("No bonus rules configured");
      }
      const idx = store.settings.bonus_rules.findIndex((r) => String(r.id) === ruleId);
      if (idx < 0) {
        throw new Error("Bonus rule not found");
      }
      const existing = store.settings.bonus_rules[idx];
      store.settings.bonus_rules[idx] = {
        ...existing,
        ...updates,
        failedCount: updates.failedCount !== undefined ? Number(updates.failedCount) : existing.failedCount,
        minTeams: updates.minTeams !== undefined ? Number(updates.minTeams) : existing.minTeams,
        maxTeams: updates.maxTeams !== undefined ? (updates.maxTeams === null || updates.maxTeams === "" ? null : Number(updates.maxTeams)) : existing.maxTeams,
        multiplier: updates.multiplier !== undefined ? Number(updates.multiplier) : existing.multiplier,
        minOddPerLeg: updates.minOddPerLeg !== undefined ? Number(updates.minOddPerLeg) : existing.minOddPerLeg,
        enabled: updates.enabled !== undefined ? Boolean(updates.enabled) : existing.enabled,
      };
      allRules = store.settings.bonus_rules;
      return store.settings.bonus_rules[idx];
    });

    res.json({ ok: true, rule: updated, rules: allRules, bonus_rules: allRules, message: "Bonus rule updated successfully" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Delete specific bonus rule
router.delete("/bonus-rules/:id", (req, res) => {
  try {
    const ruleId = String(req.params.id);
    let remaining = [];

    withStore((store) => {
      if (!store.settings || !Array.isArray(store.settings.bonus_rules)) return;
      store.settings.bonus_rules = store.settings.bonus_rules.filter((r) => String(r.id) !== ruleId);
      remaining = store.settings.bonus_rules;
    });

    res.json({ ok: true, rules: remaining, bonus_rules: remaining, message: "Bonus rule deleted successfully" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Toggle global bonus system status
router.post("/bonus-rules/toggle", (req, res) => {
  try {
    const { enabled } = req.body;
    const updated = withStore((store) => {
      if (!store.settings) store.settings = {};
      store.settings.bonus_enabled = enabled !== undefined ? Boolean(enabled) : !store.settings.bonus_enabled;
      return store.settings.bonus_enabled;
    });

    res.json({ ok: true, bonus_enabled: updated, message: `Bonus system ${updated ? "enabled" : "disabled"}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// 4. LEGACY COMPATIBILITY ENDPOINTS
// ==========================================

router.get("/users", (req, res) => {
  const store = loadStore();
  const data = (store.users || []).map((u) => ({
    id: u.id,
    username: u.username || u.email,
    email: u.email,
    phone: u.phone,
    displayName: u.display_name,
    role: u.role || "player",
    createdAt: u.created_at,
    balance: (store.wallets[String(u.id)] || {}).balance || 0,
  }));
  res.json({ ok: true, users: data });
});

router.post("/users/:id/topup", (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const userId = Number(req.params.id);
    if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const newBalance = creditWallet(userId, amount, "admin_topup", "ADMIN", { note: "Super Admin top up" });
    res.json({ ok: true, amount, newBalance });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
