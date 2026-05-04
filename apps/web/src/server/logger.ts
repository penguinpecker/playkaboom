import pino from "pino";
import { logLevel } from "./env.js";

export const logger = pino({
  level: logLevel(),
  base: undefined,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.gameToken", "*.salt"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
