import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply({ error: "Server configuration missing" }, 500);

  try {
    const body = await req.json();
    const name = String(body.customer_name ?? "").trim();
    const phone = String(body.customer_phone ?? "").trim();
    const address = String(body.shipping_address ?? "").trim();
    const notes = String(body.notes ?? "").trim();
    const proofPath = body.payment_proof_path ? String(body.payment_proof_path) : null;
    const items = body.items;

    if (!name || name.length > 120 || !phone || phone.length > 40 ||
        !address || address.length > 600 || notes.length > 1000) {
      return reply({ error: "Please check the required customer details." }, 400);
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
      return reply({ error: "Cart is empty or contains too many lines." }, 400);
    }
    if (proofPath && (!/^[a-zA-Z0-9._-]{1,240}$/.test(proofPath))) {
      return reply({ error: "Invalid payment proof reference." }, 400);
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const variantIds = [...new Set(items.map((x: any) => String(x.variant_id ?? "")))];
    if (variantIds.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) {
      return reply({ error: "Invalid cart item." }, 400);
    }

    const { data: dbVariants, error: variantError } = await supabase
      .from("sd_variants")
      .select("id,product_id,label,vial_water_price,complete_set_price,stock")
      .in("id", variantIds);
    if (variantError) throw variantError;
    if (!dbVariants || dbVariants.length !== variantIds.length) {
      return reply({ error: "One or more selected variants are no longer available." }, 409);
    }

    const productIds = [...new Set(dbVariants.map((v: any) => v.product_id))];
    const { data: dbProducts, error: productError } = await supabase
      .from("sd_products").select("id,name,active").in("id", productIds);
    if (productError) throw productError;

    const normalized: any[] = [];
    let total = 0;
    for (const item of items) {
      const v = dbVariants.find((x: any) => x.id === String(item.variant_id));
      const p = dbProducts?.find((x: any) => x.id === v?.product_id);
      const qty = Number(item.quantity);
      const option = String(item.option);
      if (!v || !p || !p.active) return reply({ error: "A selected product is unavailable." }, 409);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) return reply({ error: "Invalid quantity." }, 400);
      if (option !== "vial" && option !== "complete") return reply({ error: "Invalid order option." }, 400);
      if (Number(v.stock) < qty) return reply({ error: `Not enough stock for ${p.name} (${v.label}).` }, 409);
      const price = Number(option === "complete" ? v.complete_set_price : v.vial_water_price);
      if (!Number.isFinite(price) || price < 0) return reply({ error: "Invalid product price." }, 400);
      const lineTotal = Math.round(price * qty * 100) / 100;
      total += lineTotal;
      normalized.push({
        variant_id: v.id, product_id: p.id, product_name: p.name,
        variant_label: v.label, order_option: option === "complete" ? "Complete Set" : "Vial + Bac Water Only",
        quantity: qty, unit_price: price, line_total: lineTotal,
      });
    }
    total = Math.round(total * 100) / 100;

    const orderNumber = "SD-" + new Date().toISOString().slice(0, 10).replaceAll("-", "") +
      "-" + crypto.randomUUID().slice(0, 8).toUpperCase();

    // A transaction in the database is needed to guarantee stock cannot oversell under concurrent checkouts.
    // This function calls an atomic SQL RPC; the matching SQL migration is included in this package.
    const { data: orderResult, error: orderError } = await supabase.rpc("sd_create_order_atomic", {
      p_order_number: orderNumber,
      p_customer_name: name,
      p_customer_phone: phone,
      p_shipping_address: address,
      p_notes: notes || null,
      p_total: total,
      p_payment_proof_path: proofPath,
      p_items: normalized,
    });
    if (orderError) {
      console.error("sd_create_order_atomic failed", orderError);
      return reply({ error: "Could not place order. Please refresh stock and try again." }, 409);
    }
    return reply({ order_number: orderResult?.order_number || orderNumber });
  } catch (e) {
    console.error("create-order error", e);
    return reply({ error: "Unexpected checkout error. Please try again." }, 500);
  }
});
