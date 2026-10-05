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

3. Refresh the top-level lockfile so 0.1.1 is recorded.

   Until now the lockfile records `supercouch.kv@0.1.0` / `supercouch.kv.redis@0.1.0`
   — 0.1.1 could not be recorded before being published. If the deployment
   uses `npm ci` (lockfile-strict), it would install 0.1.0 and undo the
   fractional-`expiresAt` fix. So, once both 0.1.1 packages are on npm:
   ```
   npm update supercouch.kv supercouch.kv.redis --lockfile-version 2
   # (plain `npm install` keeps 0.1.0 since it already satisfies ^0.1.0)
   git add package-lock.json
   git commit -m "(dev) Lockfile: bump supercouch.kv(.redis) to 0.1.1"
   ```

4. Bump the top-level `package.json` to 1.1.1, tag and push.

   `v1.1.0` already exists (Jun 1, PR #2 merge, shipping `supercouch.kv@0.1.0`)
   and must not be moved — the review fixes ship as the 1.1.1 patch release:
   ```
   git tag -a v1.1.1 -m "supercouch.qs 1.1.1" && git push origin master v1.1.1
   ```

5. Deploy with the Ansible playbook `iapster/couchdb/supercouch.yml`:
   ```
   serial: 1  # one CouchDB node at a time
   ```
   After each node restarts, verify `/opt/supercouch/package.json` shows
   version 1.1.1. Only after ALL nodes run 1.1.1+ may any dDoc emit $KV
   (nodes already on 1.1.0 must be upgraded too: 1.1.0 ships the throwing
   `supercouch.kv@0.1.0`).

Note: the deployed binary must get `supercouch.kv@>=0.1.1` (verify with
`npm ls supercouch.kv` on a node) — 0.1.0 rejects fractional `expiresAt`,
while 0.1.1 floors it. See the spec at
`docs/specs/2026-04-17-supercouch-kv-emit-type-design.md` (Deployment section)
for why the binary-first-then-dDoc order is mandatory.