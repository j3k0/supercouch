# supercouch.nano

Add SuperCouch power to nano (apache/couchdb-nano), the NodeJS CouchDB client.

## Install

    npm install --save supercouch.nano

## Example

```js
const nano = require('nano')('http://localhost:5984')
const {supercouch} = require('supercouch');
const db = supercouch(nano.use('foo'));
```

Then make some supercouch powered requests.

```js
// Retrieve the list of users that logged-in in the last hour
const userIds = await db.view<string>("design", "view", {
  start_key: ["$SSET", "UsersIndex", "ByDate", +new Date() - 3600000],
  end_key:   ["$SSET", "UsersIndex", "ByDate", +new Date()],
  include_scores: false, // because we don't need the login date
});

// Retrieve the last state for each of those users.
const users = await db.view<UserModel>("design", "view", {
  keys: usersIds.rows.map(userId => ["$SSET", "Users", userId.value]),
}));
```

Check the https://github.com/j3k0/supercouch for more details.

## API

### supercouch.DocumentViewParams

Extends `nano.DocumentViewParams` with 2 additional parameters:

* `include_scores`: `boolean` (default: `true`)
  * Include the score for each element alongside the value (see supercouch.DocumentViewResponse).
  * It's enabled by default and has a minimal impact on performance, set to `false` if you don't need the scores.
* `include_total_rows`: `boolean` (default: `true`)
  * Include `total_rows` in the response.
  * When `limit` or `offset` are set, this requires an extra request. Set to `false` when you don't need the total.

### supercouch.DocumentViewResponse<D>

Extends `nano.DocumentViewResponse` with an additional field:

* `rows[].score`: `number`
  * Include the score of the element in the sorted set.

### supercouch.DocumentScore<D>

Extends `nano.DocumentStore` with the definition of the `view` method that accepts `supercouch.DocumentViewParams` and returns a `supercouch.DocumentViewResponse`.

### supercouch.supercouch<D>(db)

  - `db`: `nano.DocumentScope<D>`

Add SuperCouch powers to a nano db object.

## License

MIT

Copyright (c) 2022, Jean-Christophe Hoelt <hoelt@fovea.cc>
