export function productionContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-src 'none'",
    "img-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self'"
  ].join("; ");
}

export function developmentContentSecurityPolicy(): string {
  return productionContentSecurityPolicy()
    .replace("connect-src 'self'", "connect-src 'self' ws: wss:")
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
}

export function injectContentSecurityPolicy(html: string, policy: string): string {
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
    throw new Error("HTML already contains a Content Security Policy.");
  }
  if (/["<>]/.test(policy) || !policy.trim()) {
    throw new Error("Content Security Policy cannot be encoded safely in a meta tag.");
  }
  const charset = /<meta\s+charset=["'][^"']+["']\s*\/>/i;
  if (!charset.test(html)) throw new Error("HTML is missing the required charset meta tag.");
  return html.replace(
    charset,
    (match) => `${match}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
  );
}
