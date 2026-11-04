export const SANDBOX_RUNTIME = "coding-2";

/** Snapshot restores keep the original image and files; only fresh workspaces use the new image. */
export function startupOptions(
  snapshot: ContainerSnapshot | undefined,
  image: string | undefined,
): ContainerStartupOptions {
  if (!snapshot && !image) throw new Error("sandbox_image_unconfigured");
  return {
    ...(snapshot ? { containerSnapshot: snapshot } : { image: image! }),
    instance: { vcpu: 1, memoryMib: 4096, diskMb: 16000 },
    labels: { "touka.runtime": SANDBOX_RUNTIME },
    entrypoint: ["sleep", "infinity"],
    enableInternet: true,
    env: {},
  };
}

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
  // PATH is added by the platform; HOME keeps package-manager caches under /tmp.
  HOME: "/tmp",
  CI: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_HTTP_LOW_SPEED_LIMIT: "1024",
  GIT_HTTP_LOW_SPEED_TIME: "60",
} as const;

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  test("fresh coding workspaces use the prepared image and explicit resources", () => {
    const options = startupOptions(undefined, "registry.example/tools@sha256:abc");
    expect(options.image).toBe("registry.example/tools@sha256:abc");
    expect(options.instance).toEqual({ vcpu: 1, memoryMib: 4096, diskMb: 16000 });
    expect(() => startupOptions(undefined, undefined)).toThrow("sandbox_image_unconfigured");
  });
  test("upgrading resources restores a legacy snapshot instead of discarding its workspace", () => {
    const snapshot = { id: "old-image-workspace", size: 123 };
    const options = startupOptions(snapshot, "registry.example/new-image");
    expect(options.containerSnapshot).toEqual(snapshot);
    expect(options).not.toHaveProperty("image");
    expect(options.labels).toEqual({ "touka.runtime": "coding-2" });
  });
}
