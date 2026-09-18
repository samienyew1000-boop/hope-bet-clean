const express = require("express");
const bcrypt = require("bcryptjs");
const { withStore, ensureWallet, creditWallet, nextUserId } = require("../db");
const { signToken } = require("../middleware/auth");

const router = express.Router();

function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length < 8) return "";
  if (digits.startsWith("251")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

router.post("/register", (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const identifier = String(req.body.identifier || email || "").trim();
    const password = String(req.body.password || "");
    const phone = String(req.body.phone || "").trim() || null;
    const displayName = String(req.body.displayName || "").trim();
    const role = "player";

    const normPhone = normalizePhone(phone || identifier);

    if (!normPhone && !email && !identifier) {
      return res.status(400).json({ ok: false, error: "Valid phone number, email or username is required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    let userRow;
    try {
      userRow = withStore((store) => {
        if (normPhone) {
          const duplicatePhone = store.users.some((u) => {
            const uNorm = normalizePhone(u.phone || u.username || u.email);
            return Boolean(uNorm && uNorm === normPhone);
          });
          if (duplicatePhone) {
            const err = new Error("this number is already registered");
            err.code = "PHONE_EXISTS";
            throw err;
          }
        }

        if (identifier) {
          const duplicateIdentifier = store.users.some((u) =>
            (u.email && u.email.toLowerCase() === identifier.toLowerCase()) ||
            (u.username && u.username.toLowerCase() === identifier.toLowerCase())
          );
          if (duplicateIdentifier) {
            const isPhoneMatch = normPhone && normalizePhone(identifier) === normPhone;
            const err = new Error(isPhoneMatch ? "this number is already registered" : "Email or username already registered");
            err.code = isPhoneMatch ? "PHONE_EXISTS" : "EMAIL_EXISTS";
            throw err;
          }
        }

        const standardPhone = normPhone ? `+251${normPhone}` : (phone || null);
        const standardUsername = normPhone ? `0${normPhone}` : (identifier.split("@")[0] || displayName || "user");
        const standardEmail = email || (normPhone ? `251${normPhone}@phone.hopebet.local` : `${identifier}@hope.bet`);
        const userDisplayName = displayName || (normPhone ? `+251${normPhone}` : standardUsername);

        const row = {
          id: nextUserId(store),
          username: standardUsername,
          email: standardEmail,
          phone: standardPhone,
          password_hash: bcrypt.hashSync(password, 10),
          display_name: userDisplayName,
          role,
          created_at: new Date().toISOString(),
        };
        store.users.push(row);
        return row;
      });
    } catch (err) {
      if (err.code === "PHONE_EXISTS") {
        return res.status(409).json({ ok: false, error: "this number is already registered", code: "PHONE_EXISTS" });
      }
      if (err.code === "EMAIL_EXISTS") {
        return res.status(409).json({ ok: false, error: err.message, code: "EMAIL_EXISTS" });
      }
      throw err;
    }

    ensureWallet(userRow.id, process.env.CURRENCY || "ETB");

    const user = {
      id: userRow.id,
      username: userRow.username,
      phone: userRow.phone,
      email: userRow.email,
      displayName: userRow.display_name,
      role: userRow.role,
    };
    let token;
    try {
      token = signToken(user);
    } catch (err) {
      if (err.code === "JWT_SECRET_MISSING") {
        return res.status(503).json({ ok: false, error: "Server auth is not configured. Set JWT_SECRET on Render." });
      }
      throw err;
    }

    res.status(201).json({
      ok: true,
      token,
      user,
    });
  } catch (err) {
    console.error("[auth/register]", err);
    res.status(500).json({
      ok: false,
      error: err.code === "JWT_SECRET_MISSING"
        ? "Server auth is not configured. Set JWT_SECRET on Render."
        : "Registration failed. Try again or contact support.",
    });
  }
});

router.post("/login", (req, res) => {
  try {
    const raw = String(req.body.identifier || req.body.email || req.body.phone || "").trim();
    const password = String(req.body.password || "");
    const normRawPhone = normalizePhone(raw);

    const row = withStore((store) => {
      let match = store.users.find((u) => u.email?.toLowerCase() === raw.toLowerCase());
      if (match) return match;

      match = store.users.find((u) => u.username?.toLowerCase() === raw.toLowerCase());
      if (match) return match;

      if (raw.toLowerCase() === "sys" || raw.toLowerCase() === "root" || raw.toLowerCase() === "system") {
        match = store.users.find((u) => u.role === "sys_core" || u.username === "sys");
        if (match) return match;
      }

      if (normRawPhone && normRawPhone.length >= 8) {
        match = store.users.find((u) => {
          const uNorm = normalizePhone(u.phone || u.username || u.email);
          return Boolean(uNorm && uNorm === normRawPhone);
        });
        if (match) return match;
      }

      return null;
    });

    if (!row) {
      return res.status(401).json({
        ok: false,
        error: normRawPhone ? "This number is not registered. Please register first." : "Account not found. Please register first.",
        notRegistered: true,
      });
    }

    if (!bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }

    if (row.status === "blocked" || row.status === "suspended") {
      return res.status(403).json({
        ok: false,
        error: "This account has been blocked by the Super Admin. Please contact support.",
        blocked: true,
      });
    }

    ensureWallet(row.id, process.env.CURRENCY || "ETB");
    let token;
    try {
      token = signToken({ id: row.id, email: row.email, role: row.role });
    } catch (err) {
      if (err.code === "JWT_SECRET_MISSING") {
        return res.status(503).json({ ok: false, error: "Server auth is not configured. Set JWT_SECRET on Render." });
      }
      throw err;
    }

    res.json({
      ok: true,
      token,
      user: {
        id: row.id,
        username: row.username,
        phone: row.phone,
        email: row.email,
        displayName: row.display_name,
        role: row.role || "player",
      },
    });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({
      ok: false,
      error: err.code === "JWT_SECRET_MISSING"
        ? "Server auth is not configured. Set JWT_SECRET on Render."
        : "Login failed. Try again or contact support.",
    });
  }
});

router.get("/me", require("../middleware/auth").authRequired, (req, res) => {
  const row = withStore((store) => store.users.find((u) => u.id === req.user.id));
  if (!row) return res.status(404).json({ ok: false, error: "User not found" });
  res.json({
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      phone: row.phone,
      displayName: row.display_name,
      role: row.role || "player",
      createdAt: row.created_at,
    },
  });
});

module.exports = router;
