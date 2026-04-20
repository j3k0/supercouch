# Releasing supercouch.kv and supercouch.kv.redis

This is the first release. Follow the steps in this order:

1. Publish `supercouch.kv@0.1.0` to npm:
   ```
   cd lib/supercouch.kv && npm publish --access public
   ```

2. Publish `supercouch.kv.redis@0.1.0` to npm:
   ```
   cd lib/supercouch.kv.redis && npm publish --access public
   ```

3. In `lib/supercouch.nano/package.json`, switch the two KV deps from
   `"file:../supercouch.kv"` → `"^0.1.0"` and `"file:../supercouch.kv.redis"`
   → `"^0.1.0"`. Run `npm install` to refresh lockfile. Commit.

4. In the top-level `package.json`, switch the same two `file:` deps to
   `"^0.1.0"`. Run `npm install`. Commit.

5. Publish `supercouch.nano@1.4.0`:
   ```
   cd lib/supercouch.nano && npm publish --access public
   ```

6. Tag the top-level repo and push:
   ```
   git tag v1.1.0 && git push --tags
   ```

7. Deploy with the Ansible playbook `iapster/couchdb/supercouch.yml`:
   ```
   serial: 1  # one CouchDB node at a time
   ```
   After each node restarts, verify `/opt/supercouch/package.json` shows
   version 1.1.0. Only after ALL nodes run 1.1.0+ may any dDoc emit $KV.

See the spec at `docs/specs/2026-04-17-supercouch-kv-emit-type-design.md`
(Deployment section) for why the binary-first-then-dDoc order is mandatory.
