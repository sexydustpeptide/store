-- SEXY DUST PEPTIDE: checkout RPC and safe stock decrement
-- Run in Supabase SQL Editor for project ijqrfbnkdaskttefwkdh.
-- The Edge Function uses the service role key server-side only.

create or replace function public.sd_create_order_atomic(
  p_order_number text,
  p_customer_name text,
  p_customer_phone text,
  p_shipping_address text,
  p_notes text,
  p_total numeric,
  p_payment_proof_path text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  v_id uuid;
  v_qty integer;
  v_variant public.sd_variants%rowtype;
  v_product public.sd_products%rowtype;
  v_price numeric;
  v_calc_total numeric := 0;
  v_order_id uuid;
  v_line_total numeric;
  v_option text;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then
    raise exception 'Invalid cart';
  end if;

  -- Lock variants in deterministic order to prevent concurrent overselling.
  for v_id in
    select distinct (x->>'variant_id')::uuid
    from jsonb_array_elements(p_items) x
    order by 1
  loop
    select * into v_variant from public.sd_variants where id = v_id for update;
    if not found then raise exception 'Variant unavailable'; end if;
    select * into v_product from public.sd_products where id = v_variant.product_id;
    if not found or not v_product.active then raise exception 'Product unavailable'; end if;
  end loop;

  -- Validate stock and recompute total from database prices, not browser-provided totals.
  for item in select * from jsonb_array_elements(p_items)
  loop
    v_id := (item->>'variant_id')::uuid;
    v_qty := (item->>'quantity')::integer;
    v_option := item->>'order_option';
    select * into v_variant from public.sd_variants where id = v_id;
    if v_qty < 1 or v_qty > 99 then raise exception 'Invalid quantity'; end if;
    if v_option not in ('Vial + Bac Water Only','Complete Set') then raise exception 'Invalid option'; end if;
    if v_variant.stock < v_qty then raise exception 'Insufficient stock'; end if;
    if v_option = 'Complete Set' then v_price := v_variant.complete_set_price;
    else v_price := v_variant.vial_water_price; end if;
    v_calc_total := v_calc_total + (v_price * v_qty);
  end loop;
  v_calc_total := round(v_calc_total, 2);
  if v_calc_total <> round(p_total, 2) then
    -- Total passed by the function must match its own recomputation; any mismatch fails closed.
    raise exception 'Total mismatch';
  end if;

  insert into public.sd_orders (
    order_number, customer_name, customer_phone, shipping_address, notes, total,
    payment_status, order_status, payment_proof_path
  ) values (
    p_order_number, left(trim(p_customer_name),120), left(trim(p_customer_phone),40),
    left(trim(p_shipping_address),600), nullif(left(trim(coalesce(p_notes,'')),1000),''),
    v_calc_total, 'Pending Payment', 'New Order', p_payment_proof_path
  ) returning id into v_order_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    v_id := (item->>'variant_id')::uuid;
    v_qty := (item->>'quantity')::integer;
    v_option := item->>'order_option';
    select * into v_variant from public.sd_variants where id = v_id;
    select * into v_product from public.sd_products where id = v_variant.product_id;
    if v_option = 'Complete Set' then v_price := v_variant.complete_set_price;
    else v_price := v_variant.vial_water_price; end if;
    v_line_total := round(v_price * v_qty, 2);

    insert into public.sd_order_items (
      order_id, product_name, variant_label, order_option, quantity, unit_price, line_total
    ) values (
      v_order_id, v_product.name, v_variant.label, v_option, v_qty, v_price, v_line_total
    );

    update public.sd_variants set stock = stock - v_qty where id = v_id;
  end loop;

  return jsonb_build_object('order_number', p_order_number, 'order_id', v_order_id);
end;
$$;

revoke all on function public.sd_create_order_atomic(text,text,text,text,text,numeric,text,jsonb) from public, anon, authenticated;
grant execute on function public.sd_create_order_atomic(text,text,text,text,text,numeric,text,jsonb) to service_role;
