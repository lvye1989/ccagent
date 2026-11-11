import assert from "node:assert/strict";
import { withTestAccount } from "./helpers/accountFixture.js";
import { requirePlatformScope, withVerifiedPlatformRequest } from "../platform/account.js";

const previous = process.env.CCAGENT_WEB_WORKER_TOKEN;
try {
  await withTestAccount(async fixture => {
    process.env.CCAGENT_WEB_WORKER_TOKEN = "fixture-private-worker";
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const proof = await fixture.nativeClient.verifiedSession();
    assert.ok(!JSON.stringify(proof).includes("session_token"), "No cloud credential travels in the assertion");
    let before = fixture.counters().sessionChecks;
    await withVerifiedPlatformRequest(encode(proof), async () => {
      const values = await Promise.all([requirePlatformScope(0), requirePlatformScope(0), requirePlatformScope()]);
      assert.ok(values.every(value => value.user.id === fixture.users[0]!.id));
      values[0]!.user.name = "Caller mutation";
      assert.notEqual(values[1]!.user.name, "Caller mutation");
    });
    assert.equal(fixture.counters().sessionChecks, before, "Nested guards reuse exactly the parent's fresh check");
    assert.ok(await fixture.nativeClient.currentAssetCheck(proof));
    assert.equal(await fixture.nativeClient.currentAssetCheck({ ...proof, checkedAt: Date.now() - 2000 }), undefined);

    for (const invalid of [
      { ...proof, checkedAt: Date.now() - 2000 },
      { ...proof, checkedAt: Date.now() + 10000 },
      { ...proof, origin: "https://wrong.example.invalid" },
      { ...proof, revision: "replaced" },
      { ...proof, sessionFile: proof.sessionFile + ".other" },
      { ...proof, session: { ...proof.session, user: fixture.users[1]! } },
      { ...proof, session: { ...proof.session, expiresAt: new Date(0).toISOString() } },
    ]) {
      before = fixture.counters().sessionChecks;
      await withVerifiedPlatformRequest(encode(invalid), () => requirePlatformScope(0));
      assert.equal(fixture.counters().sessionChecks, before + 1, "Invalid assertion requires fresh online verification");
    }
    delete process.env.CCAGENT_WEB_WORKER_TOKEN;
    before = fixture.counters().sessionChecks;
    await withVerifiedPlatformRequest(encode(proof), () => requirePlatformScope(0));
    assert.equal(fixture.counters().sessionChecks, before + 1, "CLI cannot adopt a worker assertion");
    process.env.CCAGENT_WEB_WORKER_TOKEN = "fixture-private-worker";

    let release!: () => void, detached!: Promise<unknown>;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const current = await fixture.nativeClient.verifiedSession();
    await withVerifiedPlatformRequest(encode(current), async () => { detached = ready.then(() => requirePlatformScope(0)); });
    before = fixture.counters().sessionChecks; release(); await detached;
    assert.equal(fixture.counters().sessionChecks, before + 1, "Detached task cannot retain a completed request's proof");
    await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
    assert.equal(await fixture.nativeClient.currentAssetCheck(current), undefined, "Credential replacement invalidates asset lease immediately");
    fixture.disable(fixture.users[0]!.id);
    await assert.rejects(withVerifiedPlatformRequest(encode(current), () => requirePlatformScope(0)));
    console.log("PASS request authentication: one live check, bounded asset burst, account/origin/file/revision binding, expiry, CLI isolation, detached tasks and revocation");
  });
} finally {
  if (previous === undefined) delete process.env.CCAGENT_WEB_WORKER_TOKEN;
  else process.env.CCAGENT_WEB_WORKER_TOKEN = previous;
}
