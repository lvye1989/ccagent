INSERT INTO "ccagent"."roles" (id, name) VALUES ('user', '普通用户'), ('admin', '管理员');
--> statement-breakpoint
INSERT INTO "ccagent"."permissions" (id, name) VALUES
('admin.read','查看管理后台'), ('users.write','管理用户状态'), ('roles.write','管理角色权限'),
('keys.write','管理平台密钥'), ('wallets.write','调整账户余额'), ('orders.read','查看充值订单'),
('refunds.write','审核原路退款'), ('usage.read','查看调用用量'), ('data.read','查看后端数据'),
('data.export','导出管理数据'), ('routes.write','管理服务网关'), ('settings.write','保存系统设置');
--> statement-breakpoint
INSERT INTO "ccagent"."role_permissions" (role_id, permission_id) SELECT 'admin', id FROM "ccagent"."permissions";
--> statement-breakpoint
CREATE FUNCTION "ccagent".initialize_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO "ccagent"."wallets" (user_id) VALUES (NEW.id);
  INSERT INTO "ccagent"."user_roles" (user_id, role_id) VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER initialize_user AFTER INSERT ON "ccagent"."user" FOR EACH ROW EXECUTE FUNCTION "ccagent".initialize_user();
--> statement-breakpoint
CREATE FUNCTION "ccagent".reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD' USING ERRCODE = '23000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ccagent"."ledger"
FOR EACH STATEMENT EXECUTE FUNCTION "ccagent".reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ccagent"."audit"
FOR EACH STATEMENT EXECUTE FUNCTION "ccagent".reject_mutation();
--> statement-breakpoint
CREATE TRIGGER prices_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ccagent"."prices"
FOR EACH STATEMENT EXECUTE FUNCTION "ccagent".reject_mutation();
--> statement-breakpoint
CREATE FUNCTION "ccagent".post_ledger(
  p_user text, p_reference text, p_kind text, p_balance bigint, p_frozen bigint, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS "ccagent"."ledger"
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE w "ccagent"."wallets"; existing "ccagent"."ledger"; result "ccagent"."ledger";
BEGIN
  IF length(p_reference) NOT BETWEEN 1 AND 200 OR p_kind NOT IN ('recharge','authorization','settlement','release','refund_hold','refund','refund_release','adjustment') THEN
    RAISE EXCEPTION 'INVALID_LEDGER_ENTRY' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO w FROM "ccagent"."wallets" WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO existing FROM "ccagent"."ledger" WHERE reference = p_reference;
  IF FOUND THEN
    IF existing.user_id <> p_user OR existing.kind <> p_kind OR existing.balance_delta <> p_balance OR existing.frozen_delta <> p_frozen OR existing.metadata <> p_metadata THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN existing;
  END IF;
  IF (p_kind IN ('authorization','refund_hold') AND (p_balance <> 0 OR p_frozen <= 0))
    OR (p_kind IN ('release','refund_release') AND (p_balance <> 0 OR p_frozen >= 0))
    OR (p_kind = 'recharge' AND (p_balance <= 0 OR p_frozen <> 0))
    OR (p_kind IN ('settlement','refund') AND (p_balance > 0 OR p_frozen >= 0 OR p_balance < p_frozen))
    OR (p_kind = 'adjustment' AND (p_balance = 0 OR p_frozen <> 0)) THEN
    RAISE EXCEPTION 'INVALID_LEDGER_ENTRY' USING ERRCODE = '22023';
  END IF;
  IF w.balance + p_balance < 0 OR w.frozen + p_frozen < 0 OR w.balance + p_balance < w.frozen + p_frozen THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING ERRCODE = '23514';
  END IF;
  UPDATE "ccagent"."wallets" SET balance = balance + p_balance, frozen = frozen + p_frozen, updated_at = now() WHERE user_id = p_user;
  INSERT INTO "ccagent"."ledger" (id, user_id, reference, kind, balance_delta, frozen_delta, balance_after, frozen_after, metadata)
    VALUES (gen_random_uuid()::text, p_user, p_reference, p_kind, p_balance, p_frozen, w.balance + p_balance, w.frozen + p_frozen, p_metadata)
    RETURNING * INTO result;
  RETURN result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "ccagent" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "ccagent" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ccagent" FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE t record; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA "ccagent" FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA "ccagent" FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ccagent" FROM %I', r);
    END IF;
  END LOOP;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'ccagent' LOOP
    EXECUTE format('ALTER TABLE "ccagent".%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('CREATE POLICY runtime_access ON "ccagent".%I FOR ALL USING (current_user = ''ccagent_runtime'') WITH CHECK (current_user = ''ccagent_runtime'')', t.tablename);
  END LOOP;
END;
$$;
