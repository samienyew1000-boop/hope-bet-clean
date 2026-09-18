const express = require("express");
const bcrypt = require("bcryptjs");
const { authRequired } = require("../middleware/auth");
const { withStore, loadStore, nextUserId } = require("../db");

const router = express.Router();

function sysCoreRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== "sys_core") {
      return res.status(403).json({ ok: false, error: "Access denied" });
    }
    next();
  });
}

router.use(sysCoreRequired);

// 1. List all Super Admins
router.get("/superadmins", (req, res) => {
  try {
    const store = loadStore();
    const superAdmins = (store.users || []).filter((u) => u.role === "super_admin");
    const shopAdmins = (store.users || []).filter((u) => u.role === "admin");

    const data = superAdmins.map((sa) => {
      const wallet = store.wallets[String(sa.id)] || { balance: 0 };
      const shopsCount = shopAdmins.filter(
        (a) => String(a.created_by_super_id) === String(sa.id) || !a.created_by_super_id
      ).length;

      return {
        id: sa.id,
        username: sa.username,
        displayName: sa.display_name || sa.username,
        email: sa.email || "—",
        phone: sa.phone || "—",
        role: sa.role,
        balance: wallet.balance || 0,
        currency: wallet.currency || "ETB",
        shopsCount,
        status: sa.status || "active",
        createdAt: sa.created_at || new Date().toISOString(),
      };
    });

    res.json({ ok: true, superadmins: data });
  } catch (err) {
    console.error("[sys/superadmins GET]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Create a new Super Admin
router.post("/superadmins", (req, res) => {
  try {
    const { username, password, displayName, phone, email } = req.body;
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanUsername) {
      return res.status(400).json({ ok: false, error: "Super Admin username is required" });
    }
    if (cleanPassword.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    let createdSuperAdmin;
    withStore((store) => {
      const exists = store.users.some(
        (u) =>
          u.username?.toLowerCase() === cleanUsername.toLowerCase() ||
          (email && u.email?.toLowerCase() === String(email).trim().toLowerCase()) ||
          (phone && u.phone && u.phone.replace(/\D/g, "") === String(phone).replace(/\D/g, ""))
      );
      if (exists) {
        throw new Error("A user with this username, email, or phone already exists");
      }

      const newId = nextUserId(store);
      const cleanPhone = phone ? String(phone).trim() : null;
      const cleanEmail = email ? String(email).trim().toLowerCase() : `${cleanUsername}@hopebet.local`;

      createdSuperAdmin = {
        id: newId,
        username: cleanUsername,
        display_name: String(displayName || cleanUsername).trim(),
        email: cleanEmail,
        phone: cleanPhone,
        password_hash: bcrypt.hashSync(cleanPassword, 10),
        role: "super_admin",
        status: "active",
        created_by_sys_id: req.user.id,
        created_at: new Date().toISOString(),
      };

      store.users.unshift(createdSuperAdmin);
      store.wallets[String(newId)] = {
        user_id: newId,
        balance: 0,
        currency: "ETB",
        updated_at: new Date().toISOString(),
      };
    });

    res.json({
      ok: true,
      superadmin: {
        id: createdSuperAdmin.id,
        username: createdSuperAdmin.username,
        displayName: createdSuperAdmin.display_name,
        email: createdSuperAdmin.email,
        phone: createdSuperAdmin.phone || "—",
        role: createdSuperAdmin.role,
        status: createdSuperAdmin.status,
        createdAt: createdSuperAdmin.created_at,
      },
      message: `Super Admin ${createdSuperAdmin.username} created successfully`,
    });
  } catch (err) {
    console.error("[sys/superadmins POST]", err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
