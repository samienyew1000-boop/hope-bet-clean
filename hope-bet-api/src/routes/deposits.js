const express = require("express");
const { withStore, loadStore, creditWallet, debitWallet } = require("../db");
const { authRequired } = require("../middleware/auth");
const { adminRequired } = require("../middleware/admin");

const router = express.Router();
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 100);

function depositMethods() {
  const store = loadStore();
  const settings = store.settings || {};
  const telebirr = String(settings.telebirr_receiver || process.env.DEPOSIT_TELEBIRR_NUMBER || "0937383800").trim();
  const cbe = String(settings.cbe_receiver || process.env.DEPOSIT_CBE_ACCOUNT || "1000123456789").trim();

  const methods = [];
  methods.push({
    id: "telebirr",
    name: "Telebirr",
    logo: "./assets/telebirr.png",
    account: telebirr,
    fee: "Free",
    processTime: "Instant",
    instructions: `Send ETB to Telebirr ${telebirr}, then enter your transaction reference ID below.`,
  });

  methods.push({
    id: "cbe",
    name: "CBE Birr",
    logo: "./assets/cbebirr.png",
    account: cbe,
    fee: "Free",
    processTime: "Instant",
    instructions: `Transfer ETB to CBE Birr account ${cbe}, then enter your transfer reference below.`,
  });

  methods.push({
    id: "voucher",
    name: "Voucher",
    logo: "./assets/voucher.png",
    account: "Voucher Code",
    fee: "Free",
    processTime: "Instant",
    instructions: "Enter your 12-digit or 16-digit voucher pin below to credit your account immediately.",
  });

  return methods;
}

function findMethod(id) {
  return depositMethods().find((m) => m.id === id) || null;
}

router.get("/methods", (_req, res) => {
  const store = loadStore();
  const settings = store.settings || {};
  const minDeposit = Number(settings.min_deposit || process.env.MIN_DEPOSIT || 100);
  const maxDeposit = Number(settings.max_deposit || 75000);

  res.json({
    ok: true,
    minDeposit,
    maxDeposit,
    currency: process.env.CURRENCY || "ETB",
    methods: depositMethods(),
  });
});

router.post("/request", authRequired, (req, res) => {
  const amount = Number(req.body.amount);
  const method = String(req.body.method || "").trim();
  const reference = String(req.body.reference || "").trim();

  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) {
    return res.status(400).json({ ok: false, error: `Minimum deposit is ${MIN_DEPOSIT} ETB` });
  }
  if (!findMethod(method)) {
    return res.status(400).json({ ok: false, error: "Invalid deposit method" });
  }
  if (reference.length < 4) {
    return res.status(400).json({ ok: false, error: "Transaction reference is required" });
  }

  const pending = withStore((store) =>
    store.deposits.filter((d) => d.user_id === req.user.id && d.status === "pending")
  );
  if (pending.length >= 3) {
    return res.status(400).json({ ok: false, error: "You already have pending deposit requests" });
  }

  const duplicate = withStore((store) =>
    store.deposits.find((d) => d.reference === reference && d.method === method)
  );
  if (duplicate) {
    return res.status(409).json({ ok: false, error: "This transaction reference was already submitted" });
  }

  const row = withStore((store) => {
    store.counters.deposit = (store.counters.deposit || 0) + 1;
    const deposit = {
      id: `DEP-${String(store.counters.deposit).padStart(6, "0")}`,
      user_id: req.user.id,
      amount: Number(amount.toFixed(2)),
      method,
      reference,
      status: "pending",
      created_at: new Date().toISOString(),
      reviewed_at: null,
      note: null,
    };
    store.deposits.unshift(deposit);
    return deposit;
  });

  res.status(201).json({ ok: true, deposit: row });
});

router.get("/history", authRequired, (req, res) => {
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));
  const rows = withStore((store) =>
    store.deposits.filter((d) => d.user_id === req.user.id).slice(0, limit)
  );
  res.json({ ok: true, deposits: rows });
});

const adminRouter = express.Router();
adminRouter.use(adminRequired);

adminRouter.get("/pending", (_req, res) => {
  const rows = withStore((store) => store.deposits.filter((d) => d.status === "pending").slice(0, 50));
  res.json({ ok: true, deposits: rows });
});

adminRouter.post("/:id/approve", (req, res) => {
  const id = req.params.id;
  const row = withStore((store) => store.deposits.find((d) => d.id === id && d.status === "pending"));
  if (!row) return res.status(404).json({ ok: false, error: "Pending deposit not found" });

  const store = loadStore();
  const targetUser = (store.users || []).find((u) => u.id === row.user_id);
  if (targetUser && (targetUser.role === "admin" || targetUser.role === "super_admin")) {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({
        ok: false,
        error: "Admins cannot approve deposits for admin accounts. Admin balances can only be topped up by the Super Admin.",
      });
    }
  }

  if (req.user.role === "admin") {
    const adminWallet = (store.wallets && store.wallets[String(req.user.id)]) || { balance: 0 };
    const adminBalance = Number(adminWallet.balance || 0);
    if (adminBalance <= 0 || adminBalance < row.amount) {
      return res.status(400).json({
        ok: false,
        code: "INSUFFICIENT_ADMIN_BALANCE",
        error: `Insufficient admin balance (${adminBalance} ETB available). You cannot approve player deposits when you have no balance. Your balance can only be topped up by the Super Admin.`,
        adminBalance,
      });
    }
    debitWallet(req.user.id, row.amount, "admin_deposit_approval", id, {
      note: `Approved deposit for player ${targetUser ? (targetUser.username || targetUser.display_name) : row.user_id}`,
      targetUserId: row.user_id,
    });
  }

  withStore((store) => {
    const deposit = store.deposits.find((d) => d.id === id);
    if (!deposit) return;
    deposit.status = "approved";
    deposit.reviewed_at = new Date().toISOString();
    deposit.note = String(req.body.note || "").trim() || null;
  });

  creditWallet(row.user_id, row.amount, "deposit", id, { method: row.method, reference: row.reference });

  const freshStore = loadStore();
  const freshAdminWallet = (req.user && freshStore.wallets && freshStore.wallets[String(req.user.id)]) || { balance: 0 };

  res.json({
    ok: true,
    depositId: id,
    status: "approved",
    amount: row.amount,
    adminBalance: freshAdminWallet.balance || 0,
  });
});

adminRouter.post("/:id/reject", (req, res) => {
  const id = req.params.id;
  const updated = withStore((store) => {
    const deposit = store.deposits.find((d) => d.id === id && d.status === "pending");
    if (!deposit) return null;
    deposit.status = "rejected";
    deposit.reviewed_at = new Date().toISOString();
    deposit.note = String(req.body.note || "").trim() || "Rejected by admin";
    return deposit;
  });

  if (!updated) return res.status(404).json({ ok: false, error: "Pending deposit not found" });
  res.json({ ok: true, depositId: id, status: "rejected" });
});

module.exports = { router, adminRouter };
