require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const { seedSuperAdmin } = require("./db");
seedSuperAdmin();
const walletRoutes = require("./routes/wallet");
const betsRoutes = require("./routes/bets");
const { router: oddsRoutes } = require("./routes/odds");
const superAdminRoutes = require("./routes/superadmin");
const systemRoutes = require("./routes/system");
const adminRoutes = require("./routes/admin");
const { router: depositRoutes, adminRouter: depositAdminRoutes } = require("./routes/deposits");

const app = express();
const PORT = Number(process.env.PORT || 8787);

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-this-to-a-long-random-string") {
  console.error("[hope-bet-api] FATAL: Set a strong JWT_SECRET in Render environment variables");
}

const origins = String(process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || origins.includes("*") || origins.includes(origin)) return cb(null, true);
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "hope-bet-api",
    version: "1.0.0",
    currency: process.env.CURRENCY || "ETB",
    authReady: Boolean(process.env.JWT_SECRET),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/super", superAdminRoutes);
app.use("/api/superadmin", superAdminRoutes);
app.use("/api/sys", systemRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/bets", betsRoutes);
app.use("/api/odds", oddsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/deposits", depositRoutes);
app.use("/api/admin/deposits", depositAdminRoutes);

// Serve static frontend files if present (for unified single-service deployments)
const frontendDirs = [
  path.join(__dirname, "..", "..", "frontend"),
  path.join(__dirname, "..", "..", "public"),
  path.join(__dirname, "..", "public"),
  path.join(__dirname, "..", "frontend"),
];
for (const dir of frontendDirs) {
  if (fs.existsSync(dir)) {
    app.use("/frontend", express.static(dir));
    app.use(express.static(dir));
  }
}

app.get(["/check/:code", "/v/:code"], (req, res) => {
  const code = encodeURIComponent(req.params.code || "");
  res.redirect(`/frontend/?check=${code}`);
});

app.get("/", (_req, res, next) => {
  for (const dir of frontendDirs) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return res.redirect("/frontend/");
    }
  }
  next();
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Hope Bet API running on http://127.0.0.1:${PORT}`);
});
