# Releasing supercouch.kv and supercouch.kv.redis

## Already done (do not repeat)

The following steps from the initial release were already executed:

- `supercouch.kv@0.1.0` and `supercouch.kv.redis@0.1.0` are on npm.
- `supercouch.nano@1.4.0` (depending on `"supercouch.kv": "^0.1.0"` /
  `"supercouch.kv.redis": "^0.1.0"`) is on npm.
- Both `file:` deps were switched to `"^0.1.0"` in `lib/supercouch.nano/package.json`
  and the top-level `package.json`, with lockfiles refreshed.

## Remaining steps

1. Publish `supercouch.kv@0.1.1` to npm (review fix: floor fractional
   `expiresAt` instead of throwing — see the design spec):
   ```
   cd lib/supercouch.kv && npm publish --access public
   ```

2. Publish `supercouch.kv.redis@0.1.1` to npm:
   ```
   cd lib/supercouch.kv.redis && npm publish --access public
   ```

   No `supercouch.nano` republish is needed: its `^0.1.0` ranges resolve to
   0.1.1 automatically.

3. Tag the top-level repo and push:
   ```
   git tag v1.1.0 && git push --tags
   ```

4. Deploy with the Ansible playbook `iapster/couchdb/supercouch.yml`:
   ```
   serial: 1  # one CouchDB node at a time
   ```
   After each node restarts, verify `/opt/supercouch/package.json` shows
   version 1.1.0. Only after ALL nodes run 1.1.0+ may any dDoc emit $KV.

Note: the deployed binary must get `supercouch.kv@>=0.1.1` (verify with
`npm ls supercouch.kv` on a node) — 0.1.0 rejects fractional `expiresAt`,
while 0.1.1 floors it. See the spec at
`docs/specs/2026-04-17-supercouch-kv-emit-type-design.md` (Deployment section)
for why the binary-first-then-dDoc order is mandatory.