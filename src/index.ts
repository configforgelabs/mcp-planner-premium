import { buildApp, state } from "./app.js";
import { getEnv, getAllowedHosts } from "./config.js";
import { logger } from "./logger.js";

// Fail fast: validate the whole environment once, at boot. A bad/missing value
// crashes here (loud, restartable) rather than per-request later.
const env = getEnv();

const app = buildApp();

const allowedHosts = getAllowedHosts();
const httpServer = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      authMode: env.AUTH_MODE,
      // Shows the auto-derived ACA host; dnsRebindingProtection is on when set.
      allowedHosts: allowedHosts ?? null,
      dnsRebindingProtection: Boolean(allowedHosts),
    },
    "mcp-planner-premium listening",
  );
});
// Slow-client / slowloris protection.
httpServer.requestTimeout = 60_000;
httpServer.headersTimeout = 65_000;

// Graceful shutdown: drain in-flight requests on SIGTERM/SIGINT (Azure Container
// Apps sends SIGTERM before SIGKILL on scale-in / rolling deploys), with a hard
// exit safety net inside the grace window.
function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  logger.info({ signal }, "shutdown_initiated");
  httpServer.close(() => {
    logger.info("shutdown_complete");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("shutdown_forced");
    process.exit(1);
  }, 8_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
