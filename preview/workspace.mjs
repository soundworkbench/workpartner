/** Personal-container preview relay; the workspace entry point owns process teardown. */
import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { createRelay } from './relay.mjs';
import { RELAY_PORT } from './policy.mjs';

const gateway = new URL(process.argv[2]).hostname;
const relay = createRelay({
  key: fs.readFileSync('/data/.zp-preview-relay-key', 'utf8').trim(),
  gatewayAddresses: async () => (await lookup(gateway, { all: true })).map(result => result.address),
});
relay.on('error', error => {
  console.error('Workspace preview relay failed; restart the workspace after checking its configuration and port.', error.code);
  process.exit(1);
});
relay.listen(RELAY_PORT, '0.0.0.0', () => console.log('Workspace preview relay ready'));
