import { describe, expect, it } from "vitest";
import { subscriptionToPayload } from "./push";

function fakeSubscription(endpoint: string, p256dh: string, auth: string): PushSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
  } as unknown as PushSubscription;
}

describe("subscriptionToPayload", () => {
  it("extracts endpoint and keys from a PushSubscription", () => {
    const payload = subscriptionToPayload(fakeSubscription("https://push.example/abc", "p256", "auth"));
    expect(payload).toEqual({ endpoint: "https://push.example/abc", p256dh_key: "p256", auth_key: "auth" });
  });

  it("defaults missing keys to empty strings rather than throwing", () => {
    const sub = { endpoint: "https://push.example/x", toJSON: () => ({ endpoint: "https://push.example/x" }) } as unknown as PushSubscription;
    expect(subscriptionToPayload(sub)).toEqual({ endpoint: "https://push.example/x", p256dh_key: "", auth_key: "" });
  });
});
