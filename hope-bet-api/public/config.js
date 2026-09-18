(function () {
  const meta = document.querySelector('meta[name="hope-bet-api"]');
  const fromMeta = (meta && meta.getAttribute("content") || "").trim();
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const metaIsLocal = Boolean(fromMeta && (fromMeta.includes("127.0.0.1") || fromMeta.includes("localhost")));

  let storageApi = "";
  try {
    storageApi = (localStorage.getItem("hope_bet_api_url") || "").trim();
  } catch (_) {}

  let apiUrl = "";
  if (storageApi) {
    apiUrl = storageApi;
  } else if (window.location.protocol === "file:") {
    apiUrl = "";
  } else if (fromMeta && !metaIsLocal) {
    // Explicit remote backend endpoint specified in meta tag
    apiUrl = fromMeta;
  } else if (isLocal) {
    apiUrl = fromMeta || "http://127.0.0.1:8787";
  } else {
    // Deployed web server: default to current origin so /api is reached directly
    apiUrl = window.location.origin;
  }

  window.HOPE_BET_CONFIG = {
    API_URL: String(apiUrl || "").replace(/\/+$/, ""),
    CURRENCY: "ETB",
    TOKEN_KEY: "hope-bet-token",
    USER_KEY: "hope-bet-user",
    CASHOUT_LOCKED: false,
  };
})();
