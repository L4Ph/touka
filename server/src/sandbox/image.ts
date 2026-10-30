/** Cloudflare-managed image (Node.js on Debian Trixie). Snapshots only restore onto the image they came from. */
export const SANDBOX_IMAGE = "cloudflare/debian-trixie";

/** The CA the platform injects once HTTPS interception is on; every client has to trust it. */
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/**
 * Why replace rather than extend the trust store: every HTTPS request is intercepted (see `start`),
 * so the platform's CA is the only one that can validate any of them.
 */
export const TRUST_ENV = {
  SSL_CERT_FILE: CA,
  CURL_CA_BUNDLE: CA,
  GIT_SSL_CAINFO: CA,
  NODE_EXTRA_CA_CERTS: CA,
  REQUESTS_CA_BUNDLE: CA,
  // PATH is added by the platform; HOME keeps package managers out of the read-only root.
  HOME: "/tmp",
  CI: "1",
} as const;
