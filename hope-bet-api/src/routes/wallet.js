const express = require("express");
const { ensureWallet } = require("../db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

router.get("/balance", authRequired, (req, res) => {
  const wallet = ensureWallet(req.user.id, process.env.CURRENCY || "ETB");
  res.json({
    ok: true,
    balance: wallet.balance,
    currency: wallet.currency || process.env.CURRENCY || "ETB",
  });
});

module.exports = router;
