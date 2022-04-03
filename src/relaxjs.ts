import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { writeFileSync } from 'node:fs';
import { prepareRedisClient, SSetDB, SSetOps, SSetOpType, SSetRedis } from 'relax.sset';
import { md5 } from './md5';

const SSET_KEY = '$SSET';

/*
 * Types
 */

type EmitDoc = [doc: [key: string, id: string], value: number];

type QueryServerState = {
  reduce_limit?: boolean;
  timeout?: number;
}

let mapFunctions: {
  filename: string,
  map: Function,
}[] = [];

/*
 * Globals
 */

let state: QueryServerState = {}; state;
let sSetDB: SSetDB;

function usage() {
  console.error('Usage: node query-server.js --redis-url redis://localhost:6379');
  process.exit(1);
}

/** Entry point */
async function main(argv: string[]) {

  let redisURL = '';
  for (let i = 2; i < argv.length; ++i) {
    if (argv[i] === '--redis-url') {
      redisURL = argv[i + 1];
      ++i;
    }
    else if (argv[i] === '--help') {
      usage();
    }
    else {
      console.error('ERROR: Unrecognized argument: ' + argv[i]);
      usage();
    }
  }

  if (!redisURL) usage();
  sSetDB = new SSetRedis(await prepareRedisClient(redisURL));

  const pipe = readline.createInterface({ input: stdin, output: stdout });
  pipe.on("line", async function lineReceived(input: string): Promise<void> {
    if (/^[ \t\n]*$/.test(input)) return;
    let dataLine: string[] = [];
    try {
      const data = JSON.parse(`{"line":${input}}`);
      if (data.line?.length) dataLine = data.line;
    }
    catch (err) {
      if (err instanceof Error)
        console.log(JSON.stringify(["error", "parse_error", err.message + " input: \"" + input + "\""]));
      return;
    }

    if (dataLine.length > 0) {
      const output = JSON.stringify(await processQuery(dataLine));
      console.log(output);
    }
  });
}

/**
 * Process a query from CouchDB, return the response.
 *
 * @param line - parsed line received from CouchDB
 * @returns the response to send to CouchDB
 *
 * @see https://docs.couchdb.org/en/stable/query-server/protocol.html
 */
async function processQuery(line: any[]): Promise<any> {

  try {
    switch (line[0]) {

      case 'map_doc':
        if (!mapFunctions) return [];
        const obj:object = line[1];
        // const promises = mapFunctions.map(fn => mapDoc(fn.map, obj));
        // return await Promise.all(promises);
        const ret: any[] = [];
        for (let fn of mapFunctions) {
          ret.push(await mapDoc(fn.map, obj));
        }
        return ret; //[await mapDoc(mapFunctions[0].map, obj)];

      case 'reduce': {
        const funs: string[] = line[1];
        const docs: EmitDoc[] = line[2];
        return [true, funs.map(fn => reduceDocs(fn, docs))];
      }

      case 'rereduce': {
        const funs: string[] = line[1];
        const docs: any[] = line[2];
        return [true, funs.map(fn => reReduceDocs(fn, docs))];
      }

      case 'reset':
        if (line[1] && typeof line[1] === 'object')
          state = line[1];
        else
          state = {};
        mapFunctions = [];
        return true;

      case 'add_lib':
        return true;

      case 'add_fun':
        // in principle, there could be multiple map functions. we just support one here.
        // if (!mapFunctions) mapFunctions = [];
        const code = line[1].replace(/^[ \t\n]*function[ \t\n]+map[ \t\n]*\(/, 'module.exports.map = function map(');
        const filename = '/tmp/qs_' + process.pid + '_' + md5(code) + '.js';
        writeFileSync(filename, code);
        mapFunctions.push({
          filename,
          map: require(filename).map,
        });
        return true;

      case 'ddoc': return true; // not caching anything!

      // case 'shows': return true; unsupported
      // case 'lists': return true; unsupported
      // case 'updates': return true; unsupported
      // case 'filters': return true; unsupported
      // case 'views': return true; unsupported
      // case 'validate_doc_update': return true; unsupported
      // case 'rewrites': return true; unsupported

      default:
        return ["error", "unsupported_command", "command '" + line[0] + "' is not supported by this query server"];
    }
  }
  catch (uErr) {
    const err = uErr as any;
    return ["error", "processing_failed", 'message' in err ? err.message : 'unknown message'];
  }
}

let emits: any[] = [];

global.emit = function (key, value) {
  // dlog("emit: " + JSON.stringify({key, value}));
  if (key === null || key === undefined)
    emits.push([null, value]);
  else if (typeof key === 'string')
    emits.push([[key], value]);
  else if (typeof key === 'number')
    emits.push([['' + key], value]);
  else if (key?.length) // array, hopefully
    emits.push([key, value]);
}

function dlog(str: string) {
  console.error('[relaxjs@' + new Date().toISOString() + '] ' + str);
}

global.log = function (str) {
  dlog(str);
  console.log(JSON.stringify(["log", str]));
}

async function mapDoc(map: Function, doc: object) {

  map(doc);
  const ret = emits;
  emits = [];

  const ops: SSetOps = new SSetOps();

  // Extract and process $SSET emits.
  //
  // They are formatted this way:
  // [["$SSET", <db>, <id>..., score],value]
  for (const kv of ret) {
    if (kv?.[0]?.length >= 4 && typeof kv[0][0] === 'string') {
      const [marker, db, type, ...idScore] = kv[0] as string[];
      if (marker === SSET_KEY) {
        const value = kv[1];
        const id = idScore.slice(0, idScore.length - 1);
        const score = idScore[idScore.length - 1];
        ops.push({ type: type as unknown as SSetOpType, db, id, score: parseFloat(score), value });
      }
    }
    // NOTE: we could filter out the $SSET documents? But they serve as a nice backup for redis.
  }
  await ops.process(sSetDB);
  return ret;
}

function reduceDocs(fn: string, docs: EmitDoc[]): any {
  return null;
}

function reReduceDocs(fn: string, docs: any[]): any {
  return null;
}

main(process.argv);

