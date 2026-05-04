import { NextResponse } from "next/server";
import type { ZodSchema } from "zod";
import { logger } from "./logger";
import { extractKaboomError } from "@playkaboom/sdk";

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiError(400, issues);
  }
  return parsed.data;
}

export class ApiError extends Error {
  status: number;
  meta?: Record<string, unknown>;
  constructor(status: number, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.meta = meta;
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function jsonError(err: unknown, fallback = "Server error") {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, ...(err.meta ?? {}) }, { status: err.status });
  }
  const programError = extractKaboomError(err);
  if (programError) {
    return NextResponse.json({ error: programError, kind: "program" }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : fallback;
  logger.error({ err }, "unhandled api error");
  return NextResponse.json({ error: message }, { status: 500 });
}
