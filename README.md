# SuperCouch

Extends CouchDB with a fast in-memory Sorted Set datatype.

Only Redis at the moment, but it's meant to be extensible.

## Why? Who is this for?

In our use company, we are using CouchDB as the source of truth, in form of an event store. From events, we extract state information about a various types of entities. This is done in a view.

Extracting the latest state of an entity with CouchDB is easy, it's just a custom reduce function that reduces all states to the one.

Unfortunately, it's both slow at generating, slow to query in batch and wastes a ton of resource (because the view contains every historical states of an entity, even if we only need the latest one).

Here comes SuperCouch, and CouchDB Query Server that let's you emit data to a stateful database.

It's targeted toward CouchDB users that reach the limits of certain aspects of CouchDB.

## Usage

**Server-side**, it's a custom query server: install it and point CouchDB to use it, either as your default javascript query server or as a custom additional "language". Section below will detail how to add SuperCouch to your server(s).

In your **CouchDB View**, you can now emit specially formatted documents that end up in the fast database. For example:
```js
function map(doc) {
  // Store the last state of the user
  if (doc.user && doc.date)
    emit(["$SSET", "USERS", "KEEP_LAST", user.id, +new Date(doc.date)], doc.user);
}
```

In your **App**, you can retrieve the latest state for the user this way:
```js
const user = await sset.last("USERS", userId);
```

Or right from Redis: `ZRANGE SSet:USERS/myUserId -1 -1` &rArr; Array of JSON-encoded users.

## Installing

Clone the repo and install dependencies:

```bash
  git clone https://github.com/j3k0/supercouch.git /opt/supercouch
  cd /opt/supercouch
  npm install
```

Setup the environment variable so CouchDB finds the new query server.
```
COUCHDB_QUERY_SERVER_SUPERCOUCH="/opt/supercouch/bin/supercouch --redis-url redis://redis.example.com:6379"
```

This depends on your system, for a quick and dirty solution you can edit `/opt/couchdb/bin/couchdb` and add the environment variable next to others already in this file.

By default, supercouch will connect to redis running on localhost port 6389

Use `/opt/supercouch/bin/supercouch --help` for a list of options.

## Emit Commands

### KEEP_LAST

Add the element only if its score is the largest in the whole set. Keep only 1 element in the set.

usage: `emit(["$SSET", database, "KEEP_LAST", id..., score], doc)`

 * `database` `[string]` - Group entries by database.
 * `id` `[string, ...]` - An array of strings.
 * `score` `[number]` - Sorting order for this element.
 * `doc` `[any]` - Entity to store.

This is useful for example for keeping the last known state of an entity, by using a timestamp for the score.

### ADD

Add an element to the set.

If an document with the exact same value exists, the score is updated from the largest one.

This will keep 1 entry for each document.

usage: `emit(["$SSET", database, "ADD", id..., score], doc)`

 * `database` `[string]` - Group entries by database.
 * `id` `[string, ...]` - An array of strings.
 * `score` `[number]` - Sorting order for this element.
 * `doc` `[any]` - Entity to store.

This is useful for creating an index, sorted by date for example:

Example:
```js
emit(emit(["$SSET", "BY_DATE", "ADD", "SignUp", +new Date(doc.user.lastLogin), doc.user.id)`
```

Creates an index of users ordered by Sign Up date.

### KEEP_FIRST, INSERT

Same as `KEEP_LAST` and `ADD`, but reversed (keeping the first value and the lowest score).

## Benchmarks

The worst case was making thousands of parallel requests to get the final state of a bunch of entities.

Running on MacBook M1 Pro, in a 250GB database.

With **CouchDB** alone, to retrieve the state for 4,000 entities:
```
listCustomers:                    2 queries in    894ms. body: 219Kb
getCustomerClaims:             4000 queries in 11,110ms. body: 435Kb
lastestTransactionPerPurchase: 3926 queries in 11,687ms. body: 2Mb
```
Total: **23,691 ms**

With **SuperCouch (Redis)** (refactored: 1 additional request is required):
```
listCustomers:                    2 queries in  2ms. body: 35Kb
getCustomerClaims:             4000 queries in 41ms. body: 167Kb
lastestTransactionPerPurchase: 3944 queries in 47ms. body: 300Kb
getTransactionState:           3944 queries in 23ms. body: 2Mb
```
Total: **113 ms** (210x faster)

## Considerations

* This query server is not sandboxed! Everything is possible from the view functions. Production ready? Only if you trust the people writing map functions and that nobody can insert a design document in your DB. That is an open door for privilege escalation.
* The operations supported by the SSET are a subset of sorted-set operations, running them in any order give the same result.
* Emitting `SSET` operations is possible by using the `--emit-sset` flag when starting the supercouch query server. However this slows down view generation and uses resources. It might be used for debugging.
* Deleted documents? They are not handled.
  * For cleanup, you can use a prefix in the `database` field.
  * Update the view to use a new prefix (it will be regenerated from scratch, omitting deleted documents).
  * Update your app to access data from this prefix (better, store the "live" prefix in Redis, no app reload is needed).
  * Flush all data from "SSet:OldPrefix*".

## License

MIT

Copyright 2022, Jean-Christophe Hoelt
