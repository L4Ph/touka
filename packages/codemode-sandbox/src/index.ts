// The VM that runs model-written scripts. It is its own Worker so that a script that computes holds
// this isolate's thread, not the session's: see @earendil-works/pi-codemode, "Why a separate Worker".
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
