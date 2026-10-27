import type { Provider } from "@earendil-works/pi-ai/models";

// Operator-owned SDK registration seam. Use createProvider() for other APIs/auth policies.
// These providers explicitly replace matching built-in/configured IDs; no runtime fallback.
export const operatorProviders: readonly Provider[] = [];
