import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const allowedOrigins = new Set([
  "https://dropmmssgg.uk",
  "https://www.dropmmssgg.uk",
]);

type RequestBody = {
  mode?: unknown;
  message?: unknown;
  clientId?: unknown;
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json(request, { ok: false, message: "Service is not configured." }, 500);
  }

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, message: "Invalid request." }, 400);
  }

  const mode = readText(body.mode, 32);
  const clientId = readText(body.clientId, 64);
  if (!isUuid(clientId)) {
    return json(request, { ok: false, message: "Invalid client." }, 400);
  }

  const remoteIp = getClientIp(request);
  const forwardedHeaders: Record<string, string> = {};
  if (remoteIp) {
    forwardedHeaders["cf-connecting-ip"] = remoteIp;
    forwardedHeaders["x-forwarded-for"] = remoteIp;
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: { headers: forwardedHeaders },
  });

  if (mode === "visit") {
    const path = readText(body.path, 256);
    const safePath = path.startsWith("/") ? path : "/";
    const { error } = await supabase.rpc("record_visit", {
      p_client_id: clientId,
      p_path: safePath,
      p_user_agent: readText(body.userAgent, 1000),
      p_timezone: readText(body.timezone, 100),
      p_screen_size: readText(body.screenSize, 64),
      p_platform: readText(body.platform, 120),
      p_referrer: readText(body.referrer, 2048),
    });
    if (error) {
      console.error("record_visit failed", error);
      return json(request, { ok: false, message: "Visit could not be recorded." }, 500);
    }

    return json(request, { ok: true });
  }

  if (mode === "submit") {
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
  }

  return json(request, { ok: false, message: "Invalid request mode." }, 400);
});
