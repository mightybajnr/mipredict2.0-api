import helmet from "helmet";

const isProd = process.env.NODE_ENV === "production";

// Helmet for the JSON API. CSP is disabled because this origin only ever
// serves JSON (the SPA is served from a separate origin with its own CSP),
// and CORP is relaxed so mipredict.com can consume the API cross-origin.
export const securityHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: "deny" },
  hsts: isProd ? { maxAge: 63072000, includeSubDomains: true } : false,
});
