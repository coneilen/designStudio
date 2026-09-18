import type { DesignNode, OperationContext } from "@design-studio/contracts";
import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { expect, it } from "vitest";
import { prepareInputs } from "../src/resources.js";
import { encodeWire } from "../src/wire.js";
import { fixtureInputs, workerHarness } from "./support.js";

it.skipIf(process.env.F06_RENDER_SMOKE !== "1").each(["cancel", "deadline"])(
  "real Chromium %s retires the owned browser lease with observed cleanup",
  async (kind) => {
    const harness = await workerHarness();
    const opened = await harness.host.open(harness.context("open"));
    expect(opened.status).toBe("complete");
    if (opened.status !== "complete") {
      await harness.remove();
      return;
    }
    const lease = opened.value;
    try {
      const fixture = await fixtureInputs(),
        prepared = prepareInputs(
          fixture.request,
          fixture.accepted,
          () => true,
          DEFAULT_BUDGETS,
        );
      const payload = {
        version: 1,
        design: prepared.expanded,
        fonts: prepared.fonts,
        images: prepared.images,
        profile: fixture.request.profile,
        mode: "strict",
        budget: DEFAULT_BUDGETS,
      };
      const warm = await lease.exchange(
        encodeWire(payload),
        harness.context("warm"),
      );
      expect(warm.status).toBe("complete");
      if (warm.status === "complete")
        expect(JSON.parse(new TextDecoder().decode(warm.value)).ok).toBe(true);
      const first =
        "children" in payload.design.root
          ? payload.design.root.children[0]
          : undefined;
      if (first?.type !== "text") throw new Error("Missing text fixture");
      const nodes: DesignNode[] = Array.from({ length: 1500 }, (_, i) => ({
        ...first,
        id: `cancel_${i}`,
        content: String(i),
        styledRanges: [],
        layout: {
          width: 200,
          height: 24,
          position: "absolute",
          offset: { x: 0, y: 0 },
        },
      }));
      payload.design = {
        ...payload.design,
        root: {
          id: "root",
          type: "stack",
          layout: { width: 393, height: 852 },
          children: nodes,
        },
      };
      const bytes = encodeWire(payload);
      const controller = new AbortController();
      const context: OperationContext = {
        ...harness.context("pending"),
        signal: controller.signal,
      };
      if (kind === "deadline")
        context.deadline = new Date(context.clock.now() + 100).toISOString();
      const pending = lease.exchange(bytes, context);
      const timer =
        kind === "cancel"
          ? setTimeout(() => controller.abort(), 50)
          : undefined;
      const result = await pending;
      if (timer) clearTimeout(timer);
      expect(result).toMatchObject({
        status: kind === "cancel" ? "cancelled" : "failed",
        error: { code: kind === "cancel" ? "CANCELLED" : "DEADLINE_EXCEEDED" },
      });
      expect(await lease.close()).toMatchObject({
        status: "complete",
        value: {
          workerExitObserved: true,
          jobEmptyObserved: true,
          terminalFailure: {
            code: kind === "cancel" ? "CANCELLED" : "DEADLINE_EXCEEDED",
          },
        },
      });
      expect(
        (await lease.exchange(encodeWire(payload), harness.context("late")))
          .status,
      ).not.toBe("complete");
    } finally {
      expect(await lease.close()).toMatchObject({ status: "complete" });
      await harness.remove();
    }
  },
  40_000,
);
