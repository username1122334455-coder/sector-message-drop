import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const expectedAction = "turnstile-spin-v2";
const allowedHostnames = new Set(["dropmmssgg.uk", "www.dropmmssgg.uk"]);
const allowedOrigins = new Set([
  "https://dropmmssgg.uk",
  "https://www.dropmmssgg.uk",
]);
const sessionLifetimeMs = 15 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RequestBody = {
  mode?: unknown;
  message?: unknown;
  clientId?: unknown;
  turnstileToken?: unknown;
  verificationProof?: unknown;
  verificationAttemptId?: unknown;
  path?: unknown;
  userAgent?: unknown;
  timezone?: unknown;
  screenSize?: unknown;
  platform?: unknown;
  referrer?: unknown;
};

const responseHeaders = (request: Request) => {
  const origin = request.headers.get("origin");
  const allowedOrigin = origin && allowedOrigins.has(origin)
    ? origin
    : "https://dropmmssgg.uk";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
};

const json = (
  request: Request,
  body: Record<string, unknown>,
  status = 200,
) => new Response(JSON.stringify(body), {
  status,
  headers: responseHeaders(request),
});

const isAllowedOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  return !origin || allowedOrigins.has(origin);
};

const getClientIp = (request: Request) => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return (
    request.headers.get("cf-connecting-ip") ||
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    ""
  );
};

const readText = (value: unknown, maxLength: number) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
};

const fromBase64Url = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const getSessionKey = (turnstileSecret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(`dropmmssgg-turnstile-session-v1\0${turnstileSecret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const createVerificationProof = async (
  clientId: string,
  turnstileSecret: string,
) => {
  const expiresAt = Date.now() + sessionLifetimeMs;
  const payload = toBase64Url(encoder.encode(JSON.stringify({
    version: 1,
    clientId,
    expiresAt,
    nonce: crypto.randomUUID(),
  })));
  const key = await getSessionKey(turnstileSecret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return {
    proof: `${payload}.${toBase64Url(new Uint8Array(signature))}`,
    expiresAt,
  };
};

const verifyVerificationProof = async (
  proof: string,
  clientId: string,
  turnstileSecret: string,
) => {
  if (!proof || proof.length > 4096) return false;
  const [payload, encodedSignature, extra] = proof.split(".");
  if (!payload || !encodedSignature || extra) return false;

  try {
    const key = await getSessionKey(turnstileSecret);
    const signatureIsValid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(encodedSignature),
      encoder.encode(payload),
    );
    if (!signatureIsValid) return false;

    const data = JSON.parse(decoder.decode(fromBase64Url(payload)));
    return data?.version === 1 &&
      data?.clientId === clientId &&
      Number.isFinite(data?.expiresAt) &&
      data.expiresAt > Date.now();
  } catch {
    return false;
  }
};

const validateTurnstile = async (
  token: string,
  remoteIp: string,
  attemptId: string,
  turnstileSecret: string,
) => {
  if (!token || token.length > 2048) {
    return { ok: false, message: "Verification required.", codes: [] };
  }

  const verificationBody = new URLSearchParams({
    secret: turnstileSecret,
    response: token,
  });
  if (remoteIp) verificationBody.set("remoteip", remoteIp);
  if (isUuid(attemptId)) verificationBody.set("idempotency_key", attemptId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: verificationBody,
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`siteverify returned ${response.status}`);

    const result: Record<string, unknown> = await response.json();
    if (!result.success) {
      return {
        ok: false,
        message: "Verification failed.",
        codes: result["error-codes"] || [],
      };
    }
    if (result.action !== expectedAction || !allowedHostnames.has(String(result.hostname || ""))) {
      console.error("siteverify context mismatch", {
        action: result.action,
        hostname: result.hostname,
      });
      return { ok: false, message: "Verification failed.", codes: ["context-mismatch"] };
    }

    return { ok: true, message: "Verified.", codes: [] };
  } catch (error) {
    console.error("siteverify failed", error);
    return { ok: false, message: "Verification unavailable.", codes: ["internal-error"] };
  } finally {
    clearTimeout(timeout);
  }
};

serve(async (request) => {
  if (request.method === "OPTIONS") {
    if (!isAllowedOrigin(request)) return json(request, { ok: false }, 403);
    return new Response("ok", { headers: responseHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(request, { ok: false, message: "Method not allowed." }, 405);
  }
  if (!isAllowedOrigin(request)) {
    return json(request, { ok: false, message: "Origin not allowed." }, 403);
  }

  const turnstileSecret =
    Deno.env.get("TURNSTILE_SECRET") || Deno.env.get("TURNSTILE_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!turnstileSecret || !supabaseUrl || !serviceRoleKey) {
    return json(request, { ok: false, message: "Verification service is not configured." }, 500);
  }

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, message: "Invalid request." }, 400);
  }

  const mode = readText(body.mode, 32) || "legacy-submit";
  const clientId = readText(body.clientId, 64);
  const turnstileToken = readText(body.turnstileToken, 2049);
  const verificationProof = readText(body.verificationProof, 4097);
  const verificationAttemptId = readText(body.verificationAttemptId, 64);
  const remoteIp = getClientIp(request);
  if (!isUuid(clientId)) {
    return json(request, { ok: false, message: "Invalid client." }, 400);
  }

  const forwardedHeaders: Record<string, string> = {};
  if (remoteIp) {
    forwardedHeaders["cf-connecting-ip"] = remoteIp;
    forwardedHeaders["x-forwarded-for"] = remoteIp;
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: { headers: forwardedHeaders },
  });

  if (mode === "verify") {
    const verification = await validateTurnstile(
      turnstileToken,
      remoteIp,
      verificationAttemptId,
      turnstileSecret,
    );
    if (!verification.ok) {
      return json(request, {
        ok: false,
        message: verification.message,
        codes: verification.codes,
      }, 403);
    }

    const path = readText(body.path, 256);
    const safePath = path.startsWith("/") ? path : "/";
    const { error: visitError } = await supabase.rpc("record_visit", {
      p_client_id: clientId,
      p_path: safePath,
      p_user_agent: readText(body.userAgent, 1000),
      p_timezone: readText(body.timezone, 100),
      p_screen_size: readText(body.screenSize, 64),
      p_platform: readText(body.platform, 120),
      p_referrer: readText(body.referrer, 2048),
    });
    if (visitError) {
      console.error("record_visit failed", visitError);
      return json(request, { ok: false, message: "Access could not be started." }, 500);
    }

    const session = await createVerificationProof(clientId, turnstileSecret);
    return json(request, {
      ok: true,
      verificationProof: session.proof,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  let proofIsValid = false;
  if (mode === "submit") {
    proofIsValid = await verifyVerificationProof(
      verificationProof,
      clientId,
      turnstileSecret,
    );
  } else if (mode === "legacy-submit") {
    const verification = await validateTurnstile(
      turnstileToken,
      remoteIp,
      verificationAttemptId,
      turnstileSecret,
    );
    proofIsValid = verification.ok;
  } else {
    return json(request, { ok: false, message: "Invalid request mode." }, 400);
  }
  if (!proofIsValid) {
    return json(request, { ok: false, message: "Verification expired." }, 403);
  }

  const message = readText(body.message, 501);
  if (!message || message.length > 500) {
    return json(request, { ok: false, message: "Reply must be 1-500 characters." }, 400);
  }

  const { data, error } = await supabase.rpc("submit_drop", {
    p_message: message,
    p_client_id: clientId,
  });
  if (error) {
    console.error("submit_drop failed", error);
    return json(request, { ok: false, message: "Capture failed." }, 500);
  }

  return json(request, data || { ok: true });
});
