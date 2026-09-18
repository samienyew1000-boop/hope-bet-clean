(function () {
  "use strict";

  const cfg = () => window.HOPE_BET_CONFIG || {};
  const apiUrl = () => String(cfg().API_URL || "").replace(/\/$/, "");

  function getToken() {
    return localStorage.getItem(cfg().TOKEN_KEY || "hope-bet-token");
  }

  function setSession(token, user) {
    localStorage.setItem(cfg().TOKEN_KEY || "hope-bet-token", token);
    localStorage.setItem(cfg().USER_KEY || "hope-bet-user", JSON.stringify(user || {}));
  }

  function clearSession() {
    localStorage.removeItem(cfg().TOKEN_KEY || "hope-bet-token");
    localStorage.removeItem(cfg().USER_KEY || "hope-bet-user");
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(cfg().USER_KEY || "hope-bet-user") || "null");
    } catch {
      return null;
    }
  }

  function isEnabled() {
    return Boolean(apiUrl());
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`${apiUrl()}${path}`, { ...options, headers });
    } catch {
      const err = new Error("Cannot reach Hope Bet server. Wait 30 seconds and try again (free server may be waking up).");
      err.status = 0;
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: "Invalid server response" };
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function register(payload) {
    const data = await request("/api/auth/register", { method: "POST", body: JSON.stringify(payload) });
    setSession(data.token, data.user);
    return data;
  }

  async function login(payload) {
    const data = await request("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
    setSession(data.token, data.user);
    return data;
  }

  async function fetchBalance() {
    return request("/api/wallet/balance");
  }

  async function placeBet(payload) {
    return request("/api/bets/place", { method: "POST", body: JSON.stringify(payload) });
  }

  async function fetchHistory() {
    return request("/api/bets/history");
  }

  async function devSettle(ticketId, won) {
    return request(`/api/bets/dev/settle/${encodeURIComponent(ticketId)}`, {
      method: "POST",
      body: JSON.stringify({ won }),
    });
  }

  async function settleTicket(ticketId) {
    return request(`/api/bets/settle/${encodeURIComponent(ticketId)}`, {
      method: "POST",
    });
  }

  async function fetchTicket(ticketId) {
    return request(`/api/bets/ticket/${encodeURIComponent(ticketId)}`);
  }

  async function fetchDailyResults(date, sport = "football") {
    const qDate = date || new Date().toISOString().slice(0, 10);
    return request(`/api/odds/results?date=${encodeURIComponent(qDate)}&sport=${encodeURIComponent(sport)}`);
  }

  async function fetchStandings(league = 39, season = 2026) {
    return request(`/api/odds/standings?league=${encodeURIComponent(league)}&season=${encodeURIComponent(season)}`);
  }

  async function fetchTeamFixtures(teamId, last = 10) {
    return request(`/api/odds/fixtures/team?team=${encodeURIComponent(teamId)}&last=${encodeURIComponent(last)}`);
  }

  async function fetchH2H(h2h, last = 10) {
    return request(`/api/odds/fixtures/h2h?h2h=${encodeURIComponent(h2h)}&last=${encodeURIComponent(last)}`);
  }

  async function fetchDepositMethods() {
    return request("/api/deposits/methods");
  }

  async function requestDeposit(payload) {
    return request("/api/deposits/request", { method: "POST", body: JSON.stringify(payload) });
  }

  async function fetchDepositHistory() {
    return request("/api/deposits/history");
  }

  async function superAdminGetUsers() {
    return request("/api/super/users");
  }

  async function superAdminCreateUser(payload) {
    return request("/api/super/users", { method: "POST", body: JSON.stringify(payload) });
  }

  async function superAdminTopUp(userId, amount) {
    return request(`/api/super/users/${encodeURIComponent(userId)}/topup`, { method: "POST", body: JSON.stringify({ amount }) });
  }

  async function superAdminGetAdmins() {
    return request("/api/super/admins");
  }

  async function superAdminCreateAdmin(payload) {
    return request("/api/super/admins", { method: "POST", body: JSON.stringify(payload) });
  }

  async function superAdminTransferAdmin(adminId, payload) {
    return request(`/api/super/admins/${encodeURIComponent(adminId)}/transfer`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function superAdminChangeAdminPassword(adminId, password) {
    return request(`/api/super/admins/${encodeURIComponent(adminId)}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async function superAdminSetAdminStatus(adminId, status) {
    return request(`/api/super/admins/${encodeURIComponent(adminId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }

  async function superAdminDeleteAdmin(adminId) {
    return request(`/api/super/admins/${encodeURIComponent(adminId)}`, {
      method: "DELETE",
    });
  }

  async function superAdminChangePassword(currentPassword, newPassword) {
    return request("/api/super/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async function superAdminGetPlayers(params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        qs.append(k, String(v).trim());
      }
    });
    const query = qs.toString();
    return request(`/api/super/players${query ? `?${query}` : ""}`);
  }

  async function superAdminTransferPlayer(playerId, payload) {
    return request(`/api/super/players/${encodeURIComponent(playerId)}/transfer`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function superAdminGetSettings() {
    return request("/api/super/settings");
  }

  async function superAdminSaveSettings(settings) {
    return request("/api/super/settings", {
      method: "POST",
      body: JSON.stringify(settings),
    });
  }

  async function superAdminGetBonusRules() {
    return request("/api/super/bonus-rules");
  }

  async function superAdminSaveBonusRule(payload) {
    return request("/api/super/bonus-rules", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function superAdminUpdateBonusRule(id, updates) {
    return request(`/api/super/bonus-rules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
  }

  async function superAdminDeleteBonusRule(id) {
    return request(`/api/super/bonus-rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async function superAdminToggleBonus(enabled) {
    return request("/api/super/bonus-rules/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  }

  async function sysGetSuperAdmins() {
    return request("/api/sys/superadmins");
  }

  async function sysCreateSuperAdmin(payload) {
    return request("/api/sys/superadmins", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function fetchFixtureScores(ids) {
    const q = Array.isArray(ids) ? ids.join("-") : ids;
    return request(`/api/odds/fixtures/scores?ids=${encodeURIComponent(q)}`);
  }

  async function fetchAdminDashboard() {
    return request("/api/admin/dashboard");
  }

  async function fetchAdminPlayers(params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        qs.append(k, String(v).trim());
      }
    });
    const query = qs.toString();
    return request(`/api/admin/players${query ? `?${query}` : ""}`);
  }

  async function createAdminPlayer(payload) {
    return request("/api/admin/players", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function topUpPlayer(userId, amount) {
    return request(`/api/admin/players/${encodeURIComponent(userId)}/topup`, {
      method: "POST",
      body: JSON.stringify({ amount }),
    });
  }

  async function fetchAdminCoupons(params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        qs.append(k, String(v).trim());
      }
    });
    const query = qs.toString();
    return request(`/api/admin/coupons${query ? `?${query}` : ""}`);
  }

  async function adminTransferFunds(userId, payload) {
    return request(`/api/admin/players/${encodeURIComponent(userId)}/transfer`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function fetchAdminTransactions(params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        qs.append(k, String(v).trim());
      }
    });
    const query = qs.toString();
    return request(`/api/admin/transactions${query ? `?${query}` : ""}`);
  }

  async function adminVoucherTransaction(payload) {
    return request("/api/admin/transactions/voucher", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  window.HopeBetAPI = {
    isEnabled,
    getToken,
    getUser,
    clearSession,
    register,
    login,
    fetchBalance,
    placeBet,
    fetchHistory,
    fetchFixtureScores,
    fetchDailyResults,
    fetchStandings,
    fetchTeamFixtures,
    fetchH2H,
    devSettle,
    settleTicket,
    fetchTicket,
    fetchDepositMethods,
    requestDeposit,
    fetchDepositHistory,
    superAdminGetUsers,
    superAdminCreateUser,
    superAdminTopUp,
    superAdminGetAdmins,
    superAdminCreateAdmin,
    superAdminTransferAdmin,
    superAdminChangeAdminPassword,
    superAdminSetAdminStatus,
    superAdminDeleteAdmin,
    superAdminChangePassword,
    superAdminGetPlayers,
    superAdminTransferPlayer,
    superAdminGetSettings,
    superAdminSaveSettings,
    superAdminGetBonusRules,
    superAdminSaveBonusRule,
    superAdminUpdateBonusRule,
    superAdminDeleteBonusRule,
    superAdminToggleBonus,
    sysGetSuperAdmins,
    sysCreateSuperAdmin,
    fetchAdminDashboard,
    fetchAdminPlayers,
    createAdminPlayer,
    topUpPlayer,
    adminTransferFunds,
    fetchAdminCoupons,
    fetchAdminTransactions,
    adminVoucherTransaction,
    apiUrl,
  };
})();
