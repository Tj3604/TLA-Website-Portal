// Supabase Edge Function: admin-payments
//
// Lets Tina see families' Stripe payments inside the portal.
// - Only a logged-in, approved ADMIN can call it (checked against the database).
// - It reads payments from Stripe with a READ-ONLY restricted key that lives
//   only on Supabase's servers (never in the website files).
//
// Setup (see SETUP.md, Step 9):
//   1. In Stripe, create a restricted key with READ access to "Charges" and "Customers" only.
//   2. In Supabase: Edge Functions > Secrets > add STRIPE_RESTRICTED_KEY = that key.
//   3. Deploy this file as a function named exactly: admin-payments

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // 1) Who is calling? Use THEIR login token so the database's own rules decide.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Please log in." }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: isAdmin, error: adminErr } = await supabase.rpc("is_admin");
  if (adminErr || isAdmin !== true) return json({ error: "Only the center's admin can see payments." }, 403);

  // 2) Read payments from Stripe.
  const key = Deno.env.get("STRIPE_RESTRICTED_KEY");
  if (!key) return json({ error: "Payments aren't connected yet. Add STRIPE_RESTRICTED_KEY in Supabase." }, 500);

  let startingAfter = "";
  try {
    const body = await req.json();
    if (typeof body?.startingAfter === "string" && /^(ch|py)_[A-Za-z0-9]+$/.test(body.startingAfter)) {
      startingAfter = body.startingAfter;
    }
  } catch (_) { /* no body is fine */ }

  const params = new URLSearchParams({ limit: "100" });
  params.append("expand[]", "data.customer");
  if (startingAfter) params.set("starting_after", startingAfter);

  const res = await fetch("https://api.stripe.com/v1/charges?" + params.toString(), {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error", data?.error?.message);
    return json({ error: "Couldn't load payments from Stripe. Check the key in Supabase." }, 502);
  }

  // 3) Send back only what the dashboard shows. No card numbers exist here;
  //    Stripe never shares them, only the last 4 digits / bank name.
  // deno-lint-ignore no-explicit-any
  const payments = (data.data ?? []).map((c: any) => {
    const cust = c.customer && typeof c.customer === "object" && !c.customer.deleted ? c.customer : null;
    const pm = c.payment_method_details ?? {};
    let method = pm.type ?? "";
    if (pm.type === "card" && pm.card) method = `${pm.card.brand ?? "card"} •••• ${pm.card.last4 ?? ""}`.trim();
    if (pm.type === "us_bank_account" && pm.us_bank_account) {
      method = `Bank •••• ${pm.us_bank_account.last4 ?? ""}`.trim();
    }
    return {
      id: c.id,
      created: c.created,
      amount: c.amount,
      amountRefunded: c.amount_refunded ?? 0,
      currency: c.currency,
      status: c.refunded ? "refunded" : (c.status ?? "unknown"),
      email: (cust?.email ?? c.billing_details?.email ?? c.receipt_email ?? "").toLowerCase(),
      name: cust?.name ?? c.billing_details?.name ?? "",
      description: c.description ?? "",
      method,
      receiptUrl: typeof c.receipt_url === "string" && c.receipt_url.startsWith("https://") ? c.receipt_url : null,
    };
  });

  return json({ payments, hasMore: !!data.has_more });
});
