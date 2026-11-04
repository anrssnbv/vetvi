import test from "node:test";
import assert from "node:assert/strict";
import { newRequestId } from "../src/request-id.js";

test("UI request IDs work without the HTTPS-only randomUUID API", () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    assert.equal(typeof crypto.randomUUID, "undefined");
    const first = newRequestId();
    const second = newRequestId();
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.match(second, /^[0-9a-f]{32}$/);
    assert.notEqual(first, second);
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});
