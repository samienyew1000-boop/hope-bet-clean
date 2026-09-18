function adminRequired(req, res, next) {
  const secret = req.headers["x-admin-secret"] || req.query.secret;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: "Admin access denied" });
  }
  next();
}

module.exports = { adminRequired };
