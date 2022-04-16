import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { appendFile, createWriteStream, writeFileSync, WriteStream } from 'node:fs';
import { SSetDB, SSetKeepOption, SSetOp } from 'supercouch.sset';
import { prepareRedisClient, SSetRedis } from 'supercouch.sset.redis';
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
  console.error('Usage: node supercouch.js --redis-url redis://localhost:6379 [--emit-sset]');
  console.error();
  console.error(' --emit-sset ......... Emit the $SSET entries to the view. Serves as a backup to rebuild the redis database.');
  console.error(' --redis-url [URL] ... Set the URL to connect to Redis.');
  console.error(' --log-file [PATH] ... Set the path to supercouch log files.');
  console.error();
  process.exit(1);
}

type Configuration = {
  emitSSet: boolean;
  redisURL: string;
  logFile: string;
};
let config: Configuration;

function parseArguments(argv: string[]): Configuration {
  const ret: Configuration = {
    emitSSet: false,
    redisURL: '',
    logFile: '',
  }
  for (let i = 2; i < argv.length; ++i) {
    if (argv[i] === '--redis-url') {
      ret.redisURL = argv[i + 1];
      ++i;
    }
    else if (argv[i] === '--log-file') {
      ret.logFile = argv[i + 1];
      ++i;
    }
    else if (argv[i] === '--emit-sset') {
      ret.emitSSet = true;
    }
    else if (argv[i] === '--help') {
      console.error('HELP');
      usage();
    }
    else {
      console.error('ERROR: Unrecognized argument: ' + argv[i]);
      usage();
    }
  }
  return ret;
}

/** Entry point */
async function main(argv: string[]) {

  config = parseArguments(argv);
  if (config.redisURL) {
    sSetDB = new SSetRedis(await prepareRedisClient(config.redisURL));
  }
  else {
    usage();
  }

  const pipe = readline.createInterface({ input: stdin, output: stdout });
  pipe.on("line", async function lineReceived(input: string): Promise<void> {
    if (/^[ \t\n]*$/.test(input)) return;
    let dataLine: string[] = [];
    try {
      const data = JSON.parse(`{"line":${input}}`);
      if (data.line?.length) dataLine = data.line;
    }
    catch (err) {
      if (err instanceof Error) {
        superLog('error', 'parse error: ' + err.message + " input: \"" + input + "\"")
        console.log(JSON.stringify(["error", "parse_error", err.message + " input: \"" + input + "\""]));
      }
      else {
        superLog('error', "unknown error...");
        console.log(JSON.stringify(["error", "unknown_error", "an error occurred"]));
      }
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
        const obj: object = line[1];
        // const promises = mapFunctions.map(fn => mapDoc(fn.map, obj));
        // return await Promise.all(promises);
        const ret: any[] = [];
        for (let fn of mapFunctions) {
          ret.push(await mapDoc(fn.map, obj));
        }
        return ret; //[await mapDoc(mapFunctions[0].map, obj)];

      case 'reduce': {
        const functions: string[] = line[1];
        const docs: EmitDoc[] = line[2];
        return [true, functions.map(fn => reduceDocs(fn, docs))];
      }

      case 'rereduce': {
        const functions: string[] = line[1];
        const docs: any[] = line[2];
        return [true, functions.map(fn => reReduceDocs(fn, docs))];
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
        mapFunctions.push(registerFunction(line[1]));
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
        superLog('error', "command '" + line[0] + "' is not supported by this query server");
        return ["error", "unsupported_command", "command '" + line[0] + "' is not supported by this query server"];
    }
  }
  catch (uErr) {
    const err = uErr as unknown as Error;
    if (err.message) superLog('error', err.message);
    if (err.stack) superLog('error', err.stack);
    return ["error", "processing_failed", 'message' in err ? err.message : 'unknown message'];
  }
}

const functions: { [hash: string]: { filename: string; map: Function } } = {}

function registerFunction(str: string) {
  const hash = md5(str);
  if (functions[hash]) return functions[hash];
  const code = str.replace(/^[ \t\n]*function[ \t\n]+map[ \t\n]*\(/, 'module.exports.map = function map(');
  const filename = '/tmp/qs_' + process.pid + '_' + hash + '.js';
  writeFileSync(filename, code);
  return functions[hash] = {
    filename,
    map: require(filename).map,
  };
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

function superLog(level: string, str: string) {
  const line = '[SuperCouch:' + level + '@' + new Date().toISOString() + '] ' + str;
  if (config.logFile) {
    appendFile(config.logFile, line + '\n', () => {});
  }
  else {
    console.error(line);
  }
}

function debugLog(str: string) {
  superLog('debug', str);
}

global.log = function (str) {
  debugLog(str);
  console.log(JSON.stringify(["log", str]));
}

async function mapDoc(map: Function, doc: object) {

  superLog('info', '' + doc['_id'] + ' processing');
  map(doc);
  superLog('info', '' + doc['_id'] + ' done. ' + emits.length + ' emits');
  const ret: any[] = [];
  const ops: SSetOp<any>[] = [];

  // Extract and process $SSET emits.
  //
  // They are formatted this way:
  // [["$SSET", <db>, <id>...],{keep, score, value}]
  for (const kv of emits) {
    let shouldEmit = true;
    if (kv?.[0]?.length >= 3 && typeof kv[0][0] === 'string') {
      const [marker, db, ...id] = kv[0] as string[];
      if (marker === SSET_KEY && typeof kv[1] === 'object') {
        const { value, score, keep } = kv[1];
        if (keep && db && id && typeof score === 'number') {
          ops.push({ keep: keep as unknown as SSetKeepOption, db, id, score, value });
          shouldEmit = config.emitSSet;
        }
      }
    }
    if (shouldEmit)
      ret.push(kv);
  }

  emits = [];
  await sSetDB.process(ops);
  return ret;
}

function reduceDocs(fn: string, docs: EmitDoc[]): any {
  // TODO: this is unsupported
  return null;
}

function reReduceDocs(fn: string, docs: any[]): any {
  // TODO: this is unsupported
  return null;
}

main(process.argv);
