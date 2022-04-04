# supercouch.nano

Add SuperCouch power to nano (apache/couchdb-nano), the NodeJS CouchDB client.

## Install

    npm install --save supercouch.nano

## Usage

```js
const nano = require('nano')('http://localhost:5984')
const supercouch = require('supercouch').supercouch;
const db = supercouch(nano.use('foo'));
```

Then make some supercouch powered requests.

```js
// Retrieve the list of users that logged-in in the last hour
const userIds = await nano.view("design", "view", {
  start_key: ["$SSET", "UsersIndex", "ByDate", +new Date() - 3600000],
  end_key: ["$SSET", "UsersIndex", "ByDate", +new Date()],
});

// Retrieve the last state for each user.
const users = await nano.view("design", "view", {
  keys: ["$SSET","Users","bob33"], ["$SSET","USERS","alice202"],
}));
```

Check the https://github.com/j3k0/supercouch for more details.

