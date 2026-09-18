(function () {
  const meta = document.querySelector('meta[name="hope-bet-api"]');
  const fromMeta = meta && meta.getAttribute("content");
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";

  const metaIsLocal = Boolean(fromMeta && (fromMeta.includes("127.0.0.1") || fromMeta.includes("localhost")));
  const remoteApi = fromMeta && !metaIsLocal ? fromMeta : "";

  window.HOPE_BET_CONFIG = {
    API_URL:
      window.location.protocol === "file:"
        ? ""
        : isLocal
        ? (fromMeta || "http://127.0.0.1:8787")
        : remoteApi,
    CURRENCY: "ETB",
    TOKEN_KEY: "hope-bet-token",
    USER_KEY: "hope-bet-user",
    CASHOUT_LOCKED: false,
  };
})();
