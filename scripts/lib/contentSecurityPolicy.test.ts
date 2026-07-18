import { describe, expect, it } from "vitest";

import {
  developmentContentSecurityPolicy,
  injectContentSecurityPolicy,
  productionContentSecurityPolicy
} from "./contentSecurityPolicy";

describe("renderer Content Security Policy", () => {
  it("keeps the production renderer closed to inline code, evaluation, and remote connections", () => {
    const policy = productionContentSecurityPolicy();

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toMatch(/https?:|wss?:|\*/);
  });

  it("limits relaxed sources to the local development policy", () => {
    const development = developmentContentSecurityPolicy();
    const production = productionContentSecurityPolicy();

    expect(development).toContain("connect-src 'self' ws: wss:");
    expect(development).toContain("script-src 'self' 'unsafe-inline'");
    expect(production).not.toContain("ws:");
    expect(production).not.toContain("unsafe-inline");
  });

  it("injects exactly one safely encoded policy after the charset declaration", () => {
    const source = "<head><meta charset=\"UTF-8\" /><title>Lekh</title></head>";
    const output = injectContentSecurityPolicy(source, productionContentSecurityPolicy());

    expect(output.indexOf("charset")).toBeLessThan(output.indexOf("Content-Security-Policy"));
    expect(output.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(() => injectContentSecurityPolicy(output, productionContentSecurityPolicy()))
      .toThrow(/already contains/);
    expect(() => injectContentSecurityPolicy(source, "script-src \"unsafe-inline\""))
      .toThrow(/encoded safely/);
  });
});
