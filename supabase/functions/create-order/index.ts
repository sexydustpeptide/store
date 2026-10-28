
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return reply({ error: "Server configuration missing" }, 500);
  }

  try {
    const body = await req.json();

    const isPromoCheck = body.action === "validate_promo";
    const name = isPromoCheck ? "Promo Check" : String(body.customer_name ?? "").trim();
    const phone = isPromoCheck ? "Promo Check" : String(body.customer_phone ?? "").trim();
    const address = isPromoCheck ? "Promo Check" : String(body.shipping_address ?? "").trim();
    const notes = String(body.notes ?? "").trim();
    const proofPath = body.payment_proof_path
      ? String(body.payment_proof_path)
      : null;
    const promoCode = String(body.promo_code ?? "").trim().toUpperCase().slice(0, 60) || null;
    const items = body.items;

    if (
      !name ||
      name.length > 120 ||
      !phone ||
      phone.length > 40 ||
      !address ||
      address.length > 600 ||
      notes.length > 1000
    ) {
      return reply(
        { error: "Please check the required customer details." },
        400,
      );
    }

    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 30
    ) {
      return reply(
        { error: "Cart is empty or contains too many items." },
        400,
      );
    }

    if (
      proofPath &&
      !/^[a-zA-Z0-9._-]{1,240}$/.test(proofPath)
    ) {
      return reply({ error: "Invalid payment proof reference." }, 400);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    if (body.action === "validate_promo") {
      const code = String(body.code ?? "").trim().toUpperCase().slice(0, 60);
      const subtotal = Number(body.subtotal);
      if (!code) return reply({ error: "Enter a promo code." }, 400);
      if (!Number.isFinite(subtotal) || subtotal < 0) return reply({ error: "Invalid order subtotal." }, 400);
      const { data: promo, error: promoError } = await supabase
        .from("sd_promo_codes")
        .select("code,discount_type,discount_value,active,starts_at,ends_at,usage_limit,usage_count")
        .eq("code", code)
        .maybeSingle();
      if (promoError) throw promoError;
      const now = Date.now();
      if (!promo || !promo.active) return reply({ error: "That promo code is invalid or inactive." }, 400);
      if (promo.starts_at && now < Date.parse(promo.starts_at)) return reply({ error: "That promo code is not active yet." }, 400);
      if (promo.ends_at && now > Date.parse(promo.ends_at)) return reply({ error: "That promo code has expired." }, 400);
      if (promo.usage_limit !== null && Number(promo.usage_count) >= Number(promo.usage_limit)) return reply({ error: "That promo code has reached its usage limit." }, 400);
      const discount = Math.min(subtotal, promo.discount_type === "percent"
        ? Math.round(subtotal * Number(promo.discount_value)) / 100
        : Number(promo.discount_value));
      const roundedDiscount = Math.round(discount * 100) / 100;
      return reply({ code: promo.code, discount_amount: roundedDiscount, total: Math.max(0, Math.round((subtotal - roundedDiscount) * 100) / 100), discount_type: promo.discount_type, discount_value: Number(promo.discount_value) });
    }

    const variantIds = [
      ...new Set(items.map((item: any) => String(item.variant_id ?? ""))),
    ];

    if (variantIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
      return reply({ error: "Invalid cart item." }, 400);
    }

    const { data: variants, error: variantError } = await supabase
      .from("sd_variants")
      .select(
        "id,product_id,label,vial_water_price,complete_set_price,stock",
      )
      .in("id", variantIds);

    if (variantError) throw variantError;

    if (!variants || variants.length !== variantIds.length) {
      return reply(
        { error: "A selected variant is no longer available." },
        409,
      );
    }

    const productIds = [
      ...new Set(variants.map((variant: any) => variant.product_id)),
    ];

    const { data: products, error: productError } = await supabase
      .from("sd_products")
      .select("id,name,active")
      .in("id", productIds);

    if (productError) throw productError;

    const normalizedItems = [];
    let total = 0;

    for (const item of items) {
      const variant = variants.find(
        (v: any) => v.id === String(item.variant_id),
      );

      const product = products?.find(
        (p: any) => p.id === variant?.product_id,
      );

      const quantity = Number(item.quantity);
      const option = String(item.option);

      if (!variant || !product || !product.active) {
        return reply({ error: "A selected product is unavailable." }, 409);
      }

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return reply({ error: "Invalid quantity." }, 400);
      }

      if (option !== "vial" && option !== "complete") {
        return reply({ error: "Invalid order option." }, 400);
      }

      if (Number(variant.stock) < quantity) {
        return reply(
          { error: `Not enough stock for ${product.name} (${variant.label}).` },
          409,
        );
      }

      const price = Number(
        option === "complete"
          ? variant.complete_set_price
          : variant.vial_water_price,
      );

      if (!Number.isFinite(price) || price < 0) {
        return reply({ error: "Invalid product price." }, 400);
      }

      const lineTotal = Math.round(price * quantity * 100) / 100;
      total += lineTotal;

      normalizedItems.push({
        variant_id: variant.id,
        product_id: product.id,
        product_name: product.name,
        variant_label: variant.label,
        order_option:
          option === "complete"
            ? "Complete Set"
            : "Vial + Bac Water Only",
        quantity,
        unit_price: price,
        line_total: lineTotal,
      });
    }

    total = Math.round(total * 100) / 100;

    const orderNumber =
      "SD-" +
      new Date().toISOString().slice(0, 10).replaceAll("-", "") +
      "-" +
      crypto.randomUUID().slice(0, 8).toUpperCase();

    const { data, error } = await supabase.rpc("sd_create_order_atomic", {
      p_order_number: orderNumber,
      p_customer_name: name,
      p_customer_phone: phone,
      p_shipping_address: address,
      p_notes: notes || null,
      p_total: total,
      p_payment_proof_path: proofPath,
      p_items: normalizedItems,
      p_promo_code: promoCode,
    });

    if (error) {
      console.error("Order creation failed:", error.message);

      return reply(
        {
          error:
            (error.message && /promo|total mismatch|stock|variant|product|quantity|option/i.test(error.message) ? error.message : "Could not place the order. Please refresh and try again."),
        },
        409,
      );
    }

    return reply({
      order_number: data?.order_number || orderNumber,
      subtotal: data?.subtotal,
      discount_amount: data?.discount_amount ?? 0,
      total: data?.total,
      promo_code_used: data?.promo_code_used ?? null,
    });
  } catch (error) {
    console.error("Checkout error:", error);

    return reply(
      { error: "Unexpected checkout error. Please try again." },
      500,
    );
  }
});
