import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

setupAccessControlTestHarness();
let checkInboundAccessControl: typeof import("./access-control.js").checkInboundAccessControl;

beforeAll(async () => {
  vi.resetModules();
  ({ checkInboundAccessControl } = await import("./access-control.js"));
});

async function checkDm(params?: { from?: string }) {
  const from = params?.from ?? "+15550001111";
  return checkInboundAccessControl({
    accountId: "default",
    from,
    selfE164: "+15550009999",
    senderE164: from,
    group: false,
    pushName: "Contact",
    isFromMe: false,
    sock: { sendMessage: sendMessageMock },
    remoteJid: `${from.replace("+", "")}@s.whatsapp.net`,
  });
}

function expectBlockedWithoutAnyOutboundWrite(result: { allowed: boolean }) {
  expect(result.allowed).toBe(false);
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}

// SB639/W4 — replyPolicy is the reply posture, independent of capture, enforced in ONE
// place inside the fork. The prior arrangement needed FOUR external config writers to agree
// on dmPolicy=disabled; one of them force-flipping it re-opened auto-reply (2026-07-04: the
// agent answered every inbound as the user, and pairing challenges were messaged to the
// user's contacts). Under replyPolicy:"never" those surfaces are structurally unreachable.
describe("SB639 replyPolicy", () => {
  it('"never" blocks a DM even when dmPolicy says pairing — no challenge is emitted', async () => {
    setAccessControlTestConfig({
      channels: { whatsapp: { dmPolicy: "pairing", replyPolicy: "never", allowFrom: [] } },
    });
    expectBlockedWithoutAnyOutboundWrite(await checkDm());
  });

  it('"never" blocks an ALLOWLISTED contact — captured upstream, never answered', async () => {
    // The Captain's exact scenario: the contact is fully authorized for delivery, and the
    // reply pipeline still never speaks. Capture happens above this gate (the SB638 tap).
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          replyPolicy: "never",
          allowFrom: ["+15550001111"],
        },
      },
    });
    expectBlockedWithoutAnyOutboundWrite(await checkDm());
  });

  it('"never" cannot be undone by another writer flipping dmPolicy to open', async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: { dmPolicy: "open", replyPolicy: "never", allowFrom: ["*"] },
      },
    });
    expectBlockedWithoutAnyOutboundWrite(await checkDm());
  });

  it('"never" blocks group messages too', async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "open",
          replyPolicy: "never",
          allowFrom: ["*"],
          groupPolicy: "open",
        },
      },
    });
    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "123@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      pushName: "Contact",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "123@g.us",
    });
    expectBlockedWithoutAnyOutboundWrite(result);
  });

  it('"allowlist" overrides dmPolicy and admits only listed senders', async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "disabled",
          replyPolicy: "allowlist",
          allowFrom: ["+15550001111"],
        },
      },
    });
    const listed = await checkDm();
    expect(listed.allowed).toBe(true);
    const unlisted = await checkDm({ from: "+15550002222" });
    expect(unlisted.allowed).toBe(false);
  });

  it("unset replyPolicy leaves dmPolicy behavior untouched", async () => {
    setAccessControlTestConfig({
      channels: { whatsapp: { dmPolicy: "disabled", allowFrom: [] } },
    });
    expectBlockedWithoutAnyOutboundWrite(await checkDm());
  });
});
