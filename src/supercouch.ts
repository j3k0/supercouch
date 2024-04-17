import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { SSetDB, SSetKeepOption, SSetOp } from 'supercouch.sset';
import { SSetRedis } from 'supercouch.sset.redis';
import * as redis from 'redis';

import * as syslog from 'syslog';
interface syslog { createClient: (port: number, host: string, options: any) => SyslogClient; }
interface SyslogClient { log: (message: string, level?: number) => void; }

import { createRedisClientOrCluster  } from 'redis-cluster-url';
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
let syslogClient: SyslogClient | undefined = undefined;

function usage() {
  console.error('Usage: node supercouch.js --redis-url redis://localhost:6379 [options...]');
  console.error();
  console.error('Options:');
  console.error(' --redis-url [URL] ... Set the URL to connect to Redis.');
  console.error(' --emit-sset ......... Emit the $SSET entries to the view. Serves as a backup to rebuild the redis database.');
  console.error(' --log-file [PATH] ... Set the path to supercouch log files.');
  console.error(' --syslog-url [URL] .. Set the URL to syslog server (example: tcp://localhost:514) to enable syslog logging.');
  console.error(' --verbose ........... Write more information to the logs.');
  console.error(' --debug.. ........... Write a crazy amount of debug information to the logs.');
  console.error();
  process.exit(1);
}

type Configuration = {
  emitSSet: boolean;
  redisURL: string;
  logFile: string;
  syslogURL: string;
  verbose: boolean;
  debug: boolean;
};
const defaultConfig = {
  emitSSet: false,
  redisURL: '',
  logFile: '',
  syslogURL: '',
  verbose: false,
  debug: false,
}

let config: Configuration = Object.assign({}, defaultConfig);

function parseArguments(argv: string[]): Configuration {
  const ret = Object.assign({}, defaultConfig);
  for (let i = 2; i < argv.length; ++i) {
    if (argv[i] === '--redis-url') {
      ret.redisURL = argv[i + 1];
      ++i;
    }
    else if (argv[i] === '--syslog-url') {
      ret.syslogURL = argv[i + 1];
      ++i;
    }
    else if (argv[i] === '--log-file') {
      ret.logFile = argv[i + 1];
      ++i;
    }
    else if (argv[i] === '--emit-sset') {
      ret.emitSSet = true;
    }
    else if (argv[i] === '--debug') {
      ret.debug = true;
    }
    else if (argv[i] === '--verbose') {
      ret.verbose = true;
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

function respond(outputObj: any) {
  // ensure it's valid JSON
  let output: string | undefined;
  try {
    output = JSON.stringify(outputObj);
    if (config.debug) {
      superLog(LogLevel.DEBUG, 'output: ' + output);
    }
    console.log(output);
  }
  catch (err) {
    superLog(LogLevel.ERROR, 'Provided output is incorrect');
    superLog(LogLevel.ERROR, 'output: ' + (output || '<<< undefined >>>'));
    console.log(JSON.stringify(["error", "output_error", (output || '<<< undefined >>>')]));
  }
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
  if (config.syslogURL) {
    syslogClient = createSyslogClient(config.syslogURL);
  }

  const pipe = readline.createInterface({ input: stdin, output: stdout });
  pipe.on("line", async function lineReceived(input: string): Promise<void> {
    if (config.debug) {
      superLog(LogLevel.DEBUG, 'line: ' + input);
    }
    if (/^[ \t\n]*$/.test(input)) return;
    let dataLine: string[] = [];
    try {
      const data = JSON.parse(`{"line":${input}}`);
      if (data.line?.length) dataLine = data.line;
    }
    catch (err) {
      if (err instanceof Error) {
        superLog(LogLevel.ERROR, 'parse error: ' + err.message + " input: \"" + input + "\"")
        respond(["error", "parse_error", err.message + " input: \"" + input + "\""]);
      }
      else {
        superLog(LogLevel.ERROR, "unknown error...");
        respond(["error", "unknown_error", "an error occurred"]);
      }
      return;
    }

    if (dataLine.length > 0) {
      respond(await processQuery(dataLine));
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
        const ret: any[] = [];
        for (let fn of mapFunctions) {
          ret.push(await mapDoc(fn.map, obj));
        }
        return ret;

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
        superLog(LogLevel.ERROR, "command '" + line[0] + "' is not supported by this query server");
        return ["error", "unsupported_command", "command '" + line[0] + "' is not supported by this query server"];
    }
  }
  catch (uErr) {
    const err = uErr as unknown as Error;
    if (err.message) superLog(LogLevel.ERROR, err.message);
    if (err.stack) superLog(LogLevel.ERROR, err.stack);
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

enum LogLevel {
  DEBUG = 'D',
  INFO = 'I',
  WARN = 'W',
  ERROR = 'E',
}

const SYSLOG_LEVEL = {
  'D': syslog.LOG_DEBUG,
  'E': syslog.LOG_ERROR,
  'W': syslog.LOG_WARNING,
  'I': syslog.LOG_INFO,
}

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

function superLog(level: LogLevel, str: string) {
  if (syslogClient) {
    syslogClient.log(str, SYSLOG_LEVEL[level]);
  }
  if (config.logFile) {
    appendFileSync(config.logFile, '[supercouch] ' + level + '/ ' + new Date().toISOString() + ' ' + str + '\n');
  }
  if (!syslogClient && !config.logFile) {
    console.error('[supercouch] ' + level + '/ ' + new Date().toISOString() + ' ' + str);
  }
}

function debugLog(str: string) {
  superLog(LogLevel.DEBUG, str);
}

global.log = function (str) {
  debugLog(str);
  // console.log(JSON.stringify(["log", str]));
}

function createSyslogClient(syslogURL: string) {
  const url = new URL(syslogURL);
  if (url.protocol.slice(0,3) !== 'tcp') {
    superLog(LogLevel.WARN, 'Only syslog over tcp is supported, set syslogURL to tcp://xxx');
    superLog(LogLevel.INFO, 'Falling back to the file logger');
    // process.exit(1) ??
    return undefined;
  }
  const port = parseInt(url.port || '514');
  const hostname = url.hostname || 'localhost';
  const options = {
    name: 'supercouch',
  };
  return syslog.createClient(port, hostname, options);
}

async function mapDoc(map: Function, doc: object): Promise<any[]> {

  if (config.debug) superLog(LogLevel.INFO, '' + doc['_id'] + ' ' + (doc['type'] || ''));
  map(doc);

  if (config.verbose) superLog(LogLevel.INFO, '' + doc['_id'] + ' ' + (doc['type'] || '') + ' => ' + emits.length + ' emits');
  const ret: any[] = [];
  const ops: SSetOp<any>[] = [];

  // Extract and process $SSET emits.
  //
  // They are formatted this way:
  // [["$SSET", <db>, <id>...],{keep, score, value}]
  emits.forEach(kv => {
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
  });

  emits = [];
  if (ops.length > 0)
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

export async function prepareRedisClient(url: string): Promise<redis.RedisClientType | redis.RedisClusterType> {
  const client = createRedisClientOrCluster(url);
  await client.connect();
  return client;
}

main(process.argv);
