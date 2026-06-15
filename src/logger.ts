import pino from "pino";

/**
 * Structured logger. Bearer tokens and OAuth tokens are REDACTED everywhere so
 * the delegated Dataverse token we forward is never written to logs. Request
 * bodies are never logged (they carry task data and can be large).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "authorization",
      "bearer",
      "*.access_token",
      "*.refresh_token",
      "access_token",
      "refresh_token",
    ],
    censor: "[REDACTED]",
  },
});
