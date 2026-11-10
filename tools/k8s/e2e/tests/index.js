// Allow node --test tools/k8s/e2e/tests/ on versions that resolve a directory entry point.
void import('./ci-adapters.test.mjs');
void import('./listener-ready.test.mjs');
void import('./policy-ready.test.mjs');
void import('./diagnostics.test.mjs');
