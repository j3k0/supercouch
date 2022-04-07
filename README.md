# SuperCouch

Write CouchDB views to Redis with Sorted Sets.

## Why? Who is this for?

Fast, stateful views.

SuperCouch is targeted toward CouchDB users that reach the limits of what can be done with CouchDB views while maintaining acceptable performance.

## Background

In our [company's product](https://billing.fovea.cc/), we use CouchDB as the source of truth in form of an events store. From events, we extract state information about a various types of entities. This is used to be done by a worker using the `_change` feed, but became a source of problems especially with unwanted rewinds happening regularly (when upgrading nodes, resharding, network issues, ...). Processing the whole DB isn't realistic as it would take months.

Plan B was to do the heavy lifting with complex CouchDB map/reduce views. The implementation was straightforward, map extract entities states, a custom reduce function reduces all historical states to the final one. CouchDB will handle rebuilding the view and this should scale horizontally (views are build in parallel in each shard, instead of sequentially on the whole DB with the `_change` feed).

Unfortunately, the result was slow at generating, slow to query in batch and wastes a ton of resource: the view contains every historical states of all entities, even if we really only need the final one (in most cases).

Our solution was SuperCouch, a CouchDB Query Server that let's you emit data to a stateful database.

## Design

The goal of SuperCouch is to feel like a CouchDB native extension to views:

* Adding data is done using `emit()` with specially formatted keys and values.
  * Handled by a custom query server.
* Accessing data is done using standard view requests on those keys, with constraints.
  * Either by overloading client libraries.
  * At some stage, by deploying a custom http proxy for instant compatibility with all clients libs without modification.


## Usage

**Server-side**, it's a custom query server: install it and point CouchDB to use it, either as your default javascript query server or as a custom additional "language". Section below will detail how to add SuperCouch to your server(s).

In your **CouchDB View**, you can now emit specially formatted documents that end up in the fast database. Set your view language to "supercouch" then, for example:
```js
function map(doc) {
  if (doc.user && doc.date) {
    const timestamp = +new Date(doc.date);
    // Store the last state of the user
    emit(["$SSET", "Users", doc.user.id], {
      score: timestamp,
      value: doc.user,
      keep: "LAST_VALUE",
    });

    // Index users by date (stores the last date for each user id)
    emit(["$SSET", "UsersIndex", "ByDate"], {
      score: timestamp,
      value: doc.user.id,
      keep: "ALL_VALUES", // this is by default
    });

    doc.user.friends.forEach(friendId => {
      emit(["$SSET", "UsersFriends", doc.user.id], {
        score: timestamp,
        value: friendId,
      });
    });
  }
}
```

In your **App**, you can retrieve the latest state for the user this way:
```js
// Retrieve the list of users that logged-in in the last hour
const userIds = await nano.view("design", "view", {
  // Key is 3 levels deep, 4th level is the min and max scores.
  start_key: ["$SSET", "UsersIndex", "ByDate", +new Date() - 3600000],
  end_key: ["$SSET", "UsersIndex", "ByDate", +new Date()],
});

// Retrieve the last state for each user.
const users = await nano.view("design", "view", {
  keys: ["$SSET","Users","bob33"], ["$SSET","USERS","alice202"],
}));
```

_See [lib/supercouch.nano](https://github.com/j3k0/supercouch/tree/master/lib/supercouch.nano) for details about the NodeJS interface._

Or the equivalent right from Redis:
 * `ZRANGE SSET:Users/myUserId -1 -1` &rArr; Array of JSON-encoded users.
 * `ZRANGE SSET:UsersIndex/ByDate 1649052410191 1649056002596 BYSCORE` &rArr; Array of JSON-encoded users.

## Installing on your Server

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

By default, supercouch will connect to redis running on localhost port 6389. Note that it is meant to work on a central redis server (or cluster), so all nodes of your CouchDB cluster should connect to the same database.

Use `/opt/supercouch/bin/supercouch --help` for a list of options.

## Usage from your app

* See [supercouch.nano](https://github.com/j3k0/supercouch/tree/master/lib/supercouch.nano) for the NodeJS client library.

## Emit Commands

### $SSET

Add an element to a Sorted Set, if its value is larger that the existing one for this element.

usage: `emit(["$SSET", database, id...], { keep: "LAST_VALUE" | "ALL_VALUES", score, value })`

 * `database` `[string]` - Group entries by database.
 * `id` `[string, ...]` - An array of strings.
 * `score` `[number]` - Sorting order for this element.
 * `value` `[any]` - Entity to store.
 * `keep` `["LAST_VALUE" | "ALL_VALUES"]` - Keep only 1 element in the whole set, or 1 element of each value.
   * `keep: "LAST_VALUE"` is useful for example for keeping the last known state of an entity, by using a timestamp for the score.
   * `keep: "ALL_VALUES"` is is useful for creating indices, sorted by date for example.

Example:
```js
emit(["$SSET", "001.Users", "SignUp", "ByDate"], {
  score: +new Date(doc.user.signUpDate),
  value: doc.user.id,
  keep: "ALL_VALUES",
})
```

## Benchmarks

The worst case was making thousands of parallel requests to get the final state of a bunch of entities.

Running on a MacBook M1 Pro, using a 250GB database with 100,000 entries.

With **CouchDB** alone, to retrieve the state for 4,000 entities:
```
listEntityX:                    2 queries in    894ms. body: 219Kb
getEntityClaims:             4000 queries in 11,110ms. body: 435Kb
lastestTransactionPerEntity: 3926 queries in 11,687ms. body: 2Mb
```
Total: **23,691 ms**

With **SuperCouch (Redis)** (refactored: 1 additional request is required):
```
listEntityX:                    2 queries in  2ms. body: 35Kb
getEntityClaims:             4000 queries in 41ms. body: 167Kb
lastestTransactionPerEntity: 3944 queries in 47ms. body: 300Kb
getTransactionState:         3944 queries in 23ms. body: 2Mb
```
Total: **113 ms** (_210x faster_)

## Considerations

* This query server is not sandboxed! Everything is possible from the view functions.
  * Production ready? Only if you trust the people writing map functions and that nobody can insert a design document in your DB. This is an open door for privilege escalation.
  * The same feature could be reworked as a patch to CouchDB's own implementation of the query server (or right into the core).
* The operations supported by `SSET` are a subset of sorted-set operations, running them in any order will give the same result.
* Emitting `SSET` operations also to the CouchDB view is possible by providing the `--emit-sset` flag to the supercouch query server.
  * This slows down view generation and uses disk resources, but can be useful for debugging.
* Deleted documents? They are not handled (the query server isn't notified about those, because it's not meant to do this).
  * For cleanups, make use the `database` field (or a prefix).
  * Update the view with a new prefix for this field. The view will be regenerated from scratch, i.e. without processing the content of deleted documents.
  * Update your app to access data using this prefix. Ideally, store the "live" prefix in Redis, so no app reload is needed.
  * Flush all data from "SSET:OldPrefix*".
* While supercouch only supports Redis, it's meant to be extensible.

## Ideas

* Make it possible to use a different redis server for different "database".
* Implement in CouchJS.
* Make it part of the Core.

## Limitation

SuperCouch does not support custom reduce functions.

## License

MIT

Copyright 2022, Jean-Christophe Hoelt <hoelt@fovea.cc>
