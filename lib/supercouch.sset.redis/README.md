# supercouch.sset.redis

> Redis implementation of a Sorted Set database

See [supercouch.sset](https://github.com/j3k0/supercouch/tree/master/lib/supercouch.sset) for the generic interface.

## Why?

Because I want a simple interface to a sorted set that I can interface with different database engines.

This is the Redis implementation of Sorted Set database.

It's used as a storage backend for [SuperCouch](https://github.com/j3k0/supercouch).

## Usage

Install:

`npm install --save supercouch.sset.redis`

Instanciate:

```js
const sSetDB = new SSetRedis(redisClient);
```

Check `supercouch.sset` for the documentation of the public interface.

## Copyright

(c) 2022, Jean-Christophe Hoelt

## License

MIT
