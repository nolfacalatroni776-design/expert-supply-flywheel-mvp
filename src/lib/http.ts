import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { publicErrorMessage, redactForAudit } from "@/lib/redaction";

export function apiError(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error: publicErrorMessage(message), details: redactForAudit(details) }, { status });
}

export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    return apiError("Invalid request payload.", 422, error.flatten());
  }
  if (error instanceof Error) {
    return apiError(error.message, 500);
  }
  return apiError("Unknown server error.", 500);
}

export function apiOk<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}
