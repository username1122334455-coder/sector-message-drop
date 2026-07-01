import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });

const getClientIp = (request: Request) => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return (
    request.headers.get("cf-connecting-ip") ||
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    ""
  );
};

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ ok: false, message: "Method not allowed." }, 405);
  }

  const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!turnstileSecret || !supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, message: "Verification service is not configured." }, 500);
  }

  let body: {
    message?: unknown;
    clientId?: unknown;
    turnstileToken?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid request." }, 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  const ipAddress = getClientIp(request);

  if (!message || !clientId || !turnstileToken) {
    return json({ ok: false, message: "Verification required." }, 400);
  }

  const verificationBody = new FormData();
  verificationBody.append("secret", turnstileSecret);
  verificationBody.append("response", turnstileToken);
  if (ipAddress) {
    verificationBody.append("remoteip", ipAddress);
  }

  const verificationResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: verificationBody,
  });
  const verificationResult = await verificationResponse.json();

  if (!verificationResult.success) {
    return json(
      {
        ok: false,
        message: "Verification failed.",
        codes: verificationResult["error-codes"] || [],
      },
      403,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        "cf-connecting-ip": ipAddress,
        "x-forwarded-for": ipAddress,
      },
    },
  });

  const { data, error } = await supabase.rpc("submit_drop", {
    p_message: message,
    p_client_id: clientId,
  });

  if (error) {
    console.error("submit_drop failed", error);
    return json({ ok: false, message: "Capture failed." }, 500);
  }

  return json(data || { ok: true });
});
