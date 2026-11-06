CREATE FUNCTION "ccagent".authorize_usage(
  p_user text, p_key text, p_route text, p_task text, p_idempotency text, p_hash text, p_amount bigint, p_price jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE u "ccagent"."user"; k "ccagent".api_keys; w "ccagent".wallets; r "ccagent".reservations;
BEGIN
  IF p_amount <= 0 OR length(p_idempotency) NOT BETWEEN 1 AND 200 OR length(p_task) NOT BETWEEN 1 AND 200 OR p_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_AUTHORIZATION' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO u FROM "ccagent"."user" WHERE id = p_user FOR SHARE;
  IF NOT FOUND OR u.banned OR NOT u.email_verified THEN RAISE EXCEPTION 'KEY_DISABLED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO k FROM "ccagent".api_keys WHERE id = p_key AND user_id = p_user FOR UPDATE;
  IF NOT FOUND OR NOT k.enabled OR k.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'KEY_DISABLED' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO w FROM "ccagent".wallets WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO r FROM "ccagent".reservations WHERE user_id = p_user AND idempotency_key = p_idempotency;
  IF FOUND THEN
    IF r.key_id <> p_key OR r.route_id <> p_route OR r.task_id <> p_task OR r.request_hash <> p_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('reservation', to_jsonb(r) || jsonb_build_object('authorized', r.authorized::text, 'charged', r.charged::text), 'replay', true);
  END IF;
  IF w.balance - w.frozen < p_amount THEN RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING ERRCODE = '23514'; END IF;
  IF k."limit" IS NOT NULL AND k.spent + k.frozen + p_amount > k."limit" THEN RAISE EXCEPTION 'KEY_LIMIT_EXCEEDED' USING ERRCODE = '23514'; END IF;
  r.id := gen_random_uuid()::text;
  PERFORM "ccagent".post_ledger(p_user, 'usage:' || r.id || ':hold', 'authorization', 0, p_amount, jsonb_build_object('reservationId', r.id, 'taskId', p_task));
  UPDATE "ccagent".api_keys SET frozen = frozen + p_amount WHERE id = p_key;
  INSERT INTO "ccagent".reservations(id,user_id,key_id,route_id,task_id,idempotency_key,request_hash,authorized,price_snapshot,reconcile_at)
    VALUES (r.id,p_user,p_key,p_route,p_task,p_idempotency,p_hash,p_amount,p_price,now() + interval '24 hours') RETURNING * INTO r;
  RETURN jsonb_build_object('reservation', to_jsonb(r) || jsonb_build_object('authorized', r.authorized::text, 'charged', r.charged::text), 'replay', false);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ccagent".finish_usage(p_user text, p_reservation text, p_charged bigint, p_usage jsonb, p_release boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE r "ccagent".reservations;
BEGIN
  SELECT * INTO r FROM "ccagent".reservations WHERE id = p_reservation AND user_id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'CALL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM "ccagent".api_keys WHERE id = r.key_id FOR UPDATE;
  PERFORM 1 FROM "ccagent".wallets WHERE user_id = p_user FOR UPDATE;
  SELECT * INTO r FROM "ccagent".reservations WHERE id = p_reservation FOR UPDATE;
  IF r.status IN ('settled','released') THEN
    IF r.charged <> p_charged OR (r.status = 'released') <> p_release THEN RAISE EXCEPTION 'SETTLEMENT_CONFLICT' USING ERRCODE = '23505'; END IF;
    RETURN to_jsonb(r) || jsonb_build_object('authorized', r.authorized::text, 'charged', r.charged::text);
  END IF;
  IF p_charged < 0 OR p_charged > r.authorized OR (p_release AND p_charged <> 0) THEN RAISE EXCEPTION 'INVALID_SETTLEMENT' USING ERRCODE = '22023'; END IF;
  PERFORM "ccagent".post_ledger(p_user, 'usage:' || r.id || ':finish', CASE WHEN p_release THEN 'release' ELSE 'settlement' END,
    -p_charged, -r.authorized, jsonb_build_object('reservationId',r.id,'taskId',r.task_id));
  UPDATE "ccagent".api_keys SET frozen = frozen - r.authorized, spent = spent + p_charged WHERE id = r.key_id;
  UPDATE "ccagent".reservations SET status = CASE WHEN p_release THEN 'released' ELSE 'settled' END, charged = p_charged, usage = p_usage, updated_at = now()
    WHERE id = r.id RETURNING * INTO r;
  RETURN to_jsonb(r) || jsonb_build_object('authorized', r.authorized::text, 'charged', r.charged::text);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ccagent".authorize_usage(text,text,text,text,text,text,bigint,jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "ccagent".finish_usage(text,text,bigint,jsonb,boolean) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ccagent_runtime') THEN
    GRANT EXECUTE ON FUNCTION "ccagent".authorize_usage(text,text,text,text,text,text,bigint,jsonb) TO ccagent_runtime;
    GRANT EXECUTE ON FUNCTION "ccagent".finish_usage(text,text,bigint,jsonb,boolean) TO ccagent_runtime;
  END IF;
END;
$$;
