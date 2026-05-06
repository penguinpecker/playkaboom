import "server-only";
import { logger } from "./logger";

/**
 * Send an operational alert to the configured webhook. Used by:
 *   • vault-health cron (when health drops below threshold)
 *   • indexer (when N consecutive cron runs fail)
 *   • API routes (when a reverting tx pattern is detected)
 *
 * Env config:
 *   ALERT_WEBHOOK_URL — Slack / Discord / generic POST endpoint. If
 *     unset, alerts log to stdout only (still visible in Vercel logs).
 *   ALERT_WEBHOOK_FORMAT — "slack" | "discord" | "raw" (default: "raw")
 *
 * The webhook path is best-effort — never throws. We don't want a flaky
 * Slack to take down a cron route or an API path.
 */
export type AlertSeverity = "info" | "warn" | "critical";

export interface Alert {
  severity: AlertSeverity;
  title: string;
  description: string;
  fields?: Record<string, string | number | boolean>;
}

export async function sendAlert(alert: Alert): Promise<void> {
  // Always log first so the alert is captured even if the webhook fails.
  logger.warn(
    {
      severity: alert.severity,
      title: alert.title,
      ...alert.fields,
    },
    `ALERT: ${alert.title} — ${alert.description}`,
  );

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const format = (process.env.ALERT_WEBHOOK_FORMAT ?? "raw").toLowerCase();

  let body: string;
  let contentType = "application/json";
  if (format === "slack") {
    const color =
      alert.severity === "critical"
        ? "#dc2626"
        : alert.severity === "warn"
          ? "#f59e0b"
          : "#3b82f6";
    body = JSON.stringify({
      attachments: [
        {
          color,
          title: alert.title,
          text: alert.description,
          fields: Object.entries(alert.fields ?? {}).map(([title, value]) => ({
            title,
            value: String(value),
            short: true,
          })),
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    });
  } else if (format === "discord") {
    body = JSON.stringify({
      content: `[${alert.severity.toUpperCase()}] ${alert.title}: ${alert.description}`,
      embeds: alert.fields
        ? [
            {
              fields: Object.entries(alert.fields).map(([name, value]) => ({
                name,
                value: String(value),
                inline: true,
              })),
            },
          ]
        : undefined,
    });
  } else {
    body = JSON.stringify(alert);
  }

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      // 5s ceiling — webhooks shouldn't block a request handler longer.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "alert webhook delivery failed",
    );
  }
}
