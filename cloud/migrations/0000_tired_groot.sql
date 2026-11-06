CREATE SCHEMA IF NOT EXISTS "ccagent";
--> statement-breakpoint
CREATE TABLE "ccagent"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit" bigint,
	"spent" bigint DEFAULT 0 NOT NULL,
	"frozen" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash"),
	CONSTRAINT "key_funds_valid" CHECK ("ccagent"."api_keys"."spent" >= 0 AND "ccagent"."api_keys"."frozen" >= 0 AND ("ccagent"."api_keys"."limit" IS NULL OR "ccagent"."api_keys"."limit" >= "ccagent"."api_keys"."spent" + "ccagent"."api_keys"."frozen"))
);
--> statement-breakpoint
CREATE TABLE "ccagent"."audit" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"object_id" text NOT NULL,
	"result" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pathname" text NOT NULL,
	"purpose" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "blobs_pathname_unique" UNIQUE("pathname")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"balance_delta" bigint NOT NULL,
	"frozen_delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"frozen_after" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount_fen" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trade_no" text,
	"channel" text DEFAULT 'alipay' NOT NULL,
	"merchant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credited_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	CONSTRAINT "orders_trade_no_unique" UNIQUE("trade_no"),
	CONSTRAINT "order_funds_valid" CHECK ("ccagent"."orders"."amount_fen" > 0)
);
--> statement-breakpoint
CREATE TABLE "ccagent"."payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"trade_no" text NOT NULL,
	"deduplication_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_events_deduplication_hash_unique" UNIQUE("deduplication_hash")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."prices" (
	"id" text PRIMARY KEY NOT NULL,
	"route_id" text NOT NULL,
	"version" integer NOT NULL,
	"currency" text NOT NULL,
	"components" jsonb NOT NULL,
	"fx" text,
	"markup" text DEFAULT '1.3' NOT NULL,
	"source_url" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"initiated_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key_id" text NOT NULL,
	"route_id" text NOT NULL,
	"task_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"authorized" bigint NOT NULL,
	"charged" bigint DEFAULT 0 NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"usage" jsonb,
	"result_blob_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconcile_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reservation_funds_valid" CHECK ("ccagent"."reservations"."authorized" > 0 AND "ccagent"."reservations"."charged" >= 0 AND "ccagent"."reservations"."charged" <= "ccagent"."reservations"."authorized"),
	CONSTRAINT "reservation_status_valid" CHECK ("ccagent"."reservations"."status" IN ('held','pending','settled','released'))
);
--> statement-breakpoint
CREATE TABLE "ccagent"."role_permissions" (
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."routes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"service" text NOT NULL,
	"protocol" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"upstream_model" text NOT NULL,
	"credential_env" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timeout_ms" integer DEFAULT 120000 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."user_roles" (
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "ccagent"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ccagent"."wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"frozen" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_funds_valid" CHECK ("ccagent"."wallets"."balance" >= 0 AND "ccagent"."wallets"."frozen" >= 0 AND "ccagent"."wallets"."frozen" <= "ccagent"."wallets"."balance")
);
--> statement-breakpoint
ALTER TABLE "ccagent"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."audit" ADD CONSTRAINT "audit_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."blobs" ADD CONSTRAINT "blobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."ledger" ADD CONSTRAINT "ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."orders" ADD CONSTRAINT "orders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ccagent"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."prices" ADD CONSTRAINT "prices_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "ccagent"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "ccagent"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."refunds" ADD CONSTRAINT "refunds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."refunds" ADD CONSTRAINT "refunds_initiated_by_user_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."reservations" ADD CONSTRAINT "reservations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."reservations" ADD CONSTRAINT "reservations_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "ccagent"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."reservations" ADD CONSTRAINT "reservations_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "ccagent"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "ccagent"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "ccagent"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."settings" ADD CONSTRAINT "settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."user_roles" ADD CONSTRAINT "user_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "ccagent"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ccagent"."wallets" ADD CONSTRAINT "wallets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "ccagent"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "ccagent"."account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_idx" ON "ccagent"."account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "api_key_user_idx" ON "ccagent"."api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_time_idx" ON "ccagent"."audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_user_time_idx" ON "ccagent"."ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "order_user_time_idx" ON "ccagent"."orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_route_version_idx" ON "ccagent"."prices" USING btree ("route_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_idempotency_idx" ON "ccagent"."reservations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reservation_user_time_idx" ON "ccagent"."reservations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "ccagent"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "ccagent"."verification" USING btree ("identifier");
