import { applyPatch } from './applyPatch';
import { toKeys } from './utils';
import { isArrayPath } from './utils';
import { JSONPatchOp } from './types';
import { JSONPatch } from './jsonPatch';
import { inc } from 'alphacounter';

export type Subscriber<T> = (value: T, meta: SyncableMetadata, hasUnsentChanges: boolean) => void;
export type PatchSubscriber = (value: JSONPatchOp[], rev: string) => void;
export type Unsubscriber = () => void;
export type Sender<T = Record<string, any>> = (changes: JSONPatchOp[]) => Promise<T>;
export type DocRev<T = Record<string, any>> = [T, string];
export type PatchRev = [JSONPatchOp[], string];
export type PatchRevPatch = [JSONPatchOp[], string, JSONPatchOp[]];

export interface SyncableClient<T = Record<string, any>> {
  subscribe: (run: Subscriber<T>) => Unsubscriber;
  change: (patch: JSONPatch | JSONPatchOp[]) => T;
  receive: (patch: JSONPatch | JSONPatchOp[], rev: string, overwriteChanges?: boolean) => T;
  send<T>(sender: Sender<T>): Promise<T | void>;
  get(): T;
  getAll(): [T, SyncableMetadata];
  getMeta(): SyncableMetadata;
  getRev(): string;
  set(value: T, meta: SyncableMetadata): void;
}

export interface SyncableServer<T = Record<string, any>> {
  onPatch: (run: PatchSubscriber) => Unsubscriber;
  getPendingPatch: () => Promise<{ patch: JSONPatchOp[], rev: string }>;
  subscribe: (run: Subscriber<T>) => Unsubscriber;
  change: (patch: JSONPatch | JSONPatchOp[]) => PatchRev;
  receive: (patch: JSONPatch | JSONPatchOp[], rev?: string, ignoreBlackLists?: boolean) => PatchRevPatch;
  changesSince: (rev?: string) => PatchRev;
  get(): T;
  getAll(): [T, SyncableMetadata];
  getMeta(): SyncableMetadata;
  getRev(): string;
  set(value: T, meta: SyncableMetadata): void;
}

export type Changes = Record<string, number>;

export interface SyncableMetadata {
  rev: string;
  changed?: Changes;
  paths?: {
    [key: string]: string;
  }
}

export type SyncableOptions = {
  whitelist?: Set<string>;
  blacklist?: Set<string>;
  revPad?: number;
}

export interface SyncableServerOptions extends SyncableOptions {
  server: true;
}

export function syncable<T>(object: T, meta?: SyncableMetadata, options?: SyncableOptions): SyncableClient<T>;
export function syncable<T>(object: T, meta: SyncableMetadata | undefined, options: SyncableServerOptions): SyncableServer<T>;
export function syncable<T>(object: T, meta: SyncableMetadata = { rev: '' }, options: SyncableOptions = {}): SyncableClient<T> & SyncableServer<T> {
  let rev = meta.rev || inc('', options.revPad);
  let paths = meta.paths || {};
  let changed = { ...meta.changed };
  let sending: Set<string> | null = null;
  let pendingPatchPromise = Promise.resolve({ patch: [] as JSONPatchOp[], rev: '' });
  meta = getMeta();

  const subscribers: Set<Subscriber<T>> = new Set();
  const patchSubscribers: Set<PatchSubscriber> = new Set();
  const { whitelist, blacklist, server } = options as SyncableServerOptions;

  function change(patch: JSONPatch | JSONPatchOp[]) {
    if ('ops' in patch) patch = patch.ops;
    // If server is true, this is an admin operation on the server which will bypass the blacklists/whitelists
    if (!server) {
      patch.forEach(patch => {
        if (whitelist?.size && !pathExistsIn(patch.path, whitelist)) {
          throw new TypeError(`${patch.path} is not a whitelisted property for this Syncable Object`);
        }
        if (blacklist?.size && pathExistsIn(patch.path, blacklist)) {
          throw new TypeError(`${patch.path} is a blacklisted property for this Syncable Object`);
        }
        const [ target ] = getTargetAndKey(patch.path);
        if (isArrayPath(patch.path) && Array.isArray(target)) {
          throw new TypeError('Last-write-wins cannot be used with array entries');
        }
      });
    }
    const result = applyPatch(object, patch, { strict: true, createMissingObjects: true });
    if (result === object) return result; // no changes made
    object = result;
    if (server) setRev(patch, rev = inc(rev, options.revPad))
    else patch.forEach(op => addChange(op));
    return dispatchChanges(patch);
  }

  // This method is necessary to track in-flight sent properties to avoid property flickering described here:
  // https://www.figma.com/blog/how-figmas-multiplayer-technology-works/#syncing-object-properties.
  async function send<T>(sender: Sender<T>): Promise<T | void> {
    if (!Object.keys(changed).length || sending) return;
    sending = new Set(Object.keys(changed));
    const oldChanged = changed;
    changed = {};
    const changes = Array.from(sending).map(path => getPatchOp(path, oldChanged[path]));
    let result: any;
    try {
      result = await sender(changes);
      sending = null;
    } finally {
      if (sending) {
        // Reset state on error to allow for another send
        changed = Object.keys({ ...oldChanged, ...changed }).reduce((obj, key) => {
          obj[key] = (oldChanged[key] || 0) + (changed[key] || 0);
          return obj;
        }, {} as Changes);
        sending = null;
      }
    }
    return result;
  }

  function receive(patch: JSONPatch | JSONPatchOp[], rev?: string, ignoreLists?: boolean): PatchRevPatch;
  function receive(patch: JSONPatch | JSONPatchOp[], rev: string, overwriteChanges?: boolean): T;
  function receive(patch: JSONPatch | JSONPatchOp[], rev_?: string, overwriteChanges?: boolean) {
    const ignoreLists = overwriteChanges;
    if ('ops' in patch) patch = patch.ops;
    const clientUpdates: JSONPatchOp[] = server && rev_ && rev_ < rev ? changesSince(rev_)[0] : [];

    // If no rev, this is a server commit from a client and will autoincrement the rev.
    if (server) {
      rev = inc(rev, options.revPad);
      setRev(patch, rev);
    } else if (!rev_) {
      throw new Error('Received a patch without a rev');
    } else if (typeof rev_ === 'string' && inc.is(rev).gt(rev_)) {
      // Already have the latest revision
      return object;
    } else {
      rev = rev_;
    }

    patch = patch.filter(patch => {
      // Filter out any patches that are in-flight being sent to the server as they will overwrite this change (to avoid flicker)
      if (sending && isSending(patch.path)) return false;
      // Remove from changed if it's about to be overwritten (usually you should be sending changes immediately)
      if (overwriteChanges && patch.path in changed) delete changed[patch.path];
      else if (changed[patch.path] && patch.op !== '@inc' && typeof patch.value === 'number') {
        patch.value += changed[patch.path]; // Adjust the value by our outstanding increment changes
      }
      return true;
    });

    if (server && !ignoreLists && (whitelist || blacklist)) {
      patch = patch.filter(patch => {
        if (whitelist?.size && !pathExistsIn(patch.path, whitelist) || blacklist?.size && pathExistsIn(patch.path, blacklist)) {
          // Revert data back that shouldn't change
          clientUpdates.push(getPatchOp(patch.path));
          return false;
        }
        return patch;
      });
    }

    const updateObj = applyPatch(object, patch, { strict: true, createMissingObjects: true });
    if (updateObj === object) return server ? [[], rev, clientUpdates] : updateObj; // no changes made
    object = updateObj;
    patch.forEach(patch => patch.op.startsWith('@') && clientUpdates.push(getPatchOp(patch.path)));
    const result = dispatchChanges(patch);
    return server ? [ ...result, clientUpdates ] : result;
  }

  function changesSince(rev_?: string): PatchRev {
    const patch: JSONPatchOp[] = [];
    if (!rev_) {
      patch.push({ op: 'replace', path: '', value: object });
    } else {
      for (const [ path, r ] of Object.entries(paths)) {
        if (inc.is(r).gt(rev_)) patch.push(getPatchOp(path));
      }
    }
    return [ patch, rev ];
  }

  function subscribe(run: Subscriber<T>): Unsubscriber {
    subscribers.add(run);
    run(object, meta, Object.keys(changed).length > 0);
    return () => subscribers.delete(run);
  }

  function onPatch(run: PatchSubscriber): Unsubscriber {
    patchSubscribers.add(run);
    return () => patchSubscribers.delete(run);
  }

  // this just helps with testing and is not needed for use
  function getPendingPatch() {
    return pendingPatchPromise;
  }

  function get(): T {
    return object;
  }

  function getAll(): [T, SyncableMetadata] {
    return [ object, getMeta() ];
  }

  function getMeta(): SyncableMetadata {
    const meta: SyncableMetadata = { rev };
    if (Object.keys(changed).length) meta.changed = { ...changed };
    if (Object.keys(paths).length) meta.paths = paths;
    return meta;
  }

  function getRev(): string {
    return rev;
  }

  function set(value: T, meta: SyncableMetadata): void {
    object = value;
    rev = meta.rev;
    paths = meta.paths || {};
    changed = meta.changed || {};
    sending = null;
  }

  function setRev(patch: JSONPatch | JSONPatchOp[], rev: string) {
    if ('ops' in patch) patch = patch.ops;
    patch.map(op => op.path).sort((a, b) => b.length - a.length).forEach(path => {
      const prefix = `${path}/`;
      for (const key of Object.keys(paths)) {
        if (path && key.startsWith(prefix)) {
          delete paths[key];
        }
      }
      paths[path] = rev;
    });
    return rev;
  }

  function dispatchChanges(patch: JSONPatch | JSONPatchOp[]): PatchRev;
  function dispatchChanges(patch: JSONPatch | JSONPatchOp[]): T;
  function dispatchChanges(patch: JSONPatch | JSONPatchOp[]) {
    if ('ops' in patch) patch = patch.ops;
    const thisRev = rev;
    meta = getMeta();
    const hasUnsentChanges = Object.keys(changed).length > 0;
    subscribers.forEach(subscriber => subscriber(object, meta, !server && hasUnsentChanges));
    if (server) {
      patch = patch.map(patch => patch.op.startsWith('@') ? getPatchOp(patch.path) : patch);
      pendingPatchPromise = Promise.resolve().then(() => {
        patchSubscribers.forEach(onPatch => onPatch(patch as JSONPatchOp[], thisRev));
        return { patch: patch as JSONPatchOp[], rev: thisRev };
      });
      return [ patch, thisRev ];
    }
    return object;
  }

  function addChange(op: JSONPatchOp) {
    // Filter out redundant paths such as removing /foo/bar/baz when /foo exists
    if (changed[''] && op.op !== '@inc') return;
    if (op.path === '') {
      changed = { '': 0 };
    } else {
      const prefix = `${op.path}/`;
      const keys = Object.keys(changed);
      for (let i = 0; i < keys.length; i++) {
        const path = keys[i];
        if (path.startsWith(prefix)) {
          delete changed[path];
        } else if (op.path.startsWith(`${path}/`)) {
          return;
        }
      }
      if (op.op === '@inc') {
        const value = op.value + (changed[op.path] || 0);
        // a 0 increment is nothing, so delete it, we're using 0 to indicated other fields that have been changed
        if (!value) delete changed[op.path];
        else changed[op.path] = value;
      } else if (op.op !== 'test') {
        if (op.op === 'move') changed[op.from as string] = 0;
        changed[op.path] = 0;
      }
    }
  }

  function isSending(path: string): boolean {
    return !!(sending && pathExistsIn(path, sending));
  }

  function pathExistsIn(path: string, prefixes: Changes | Set<string>): boolean {
    // Support wildcard such as '/docs/*/title'
    const expr = getPathExpr(prefixes);
    return expr.test(path);
  }

  function getPatchOp(path: string, value?: number): JSONPatchOp {
    if (path === '') return { op: 'replace', path, value: object };
    const [ target, key ] = getTargetAndKey(path);
    if (value) {
      return { op: '@inc', path, value };
    } else if (target && key in target) {
      return { op: 'replace', path, value: target[key] };
    } else {
      return { op: 'remove', path };
    }
  }

  function getTargetAndKey(path: string): [any, string] {
    const keys = toKeys(path);
    let target = object as any;
    for (let i = 1, imax = keys.length - 1; i < imax; i++) {
      const key = keys[i];
      if (!target[key]) {
        target = null;
        break;
      }
      target = target[key];
    }
    return [ target, keys[keys.length - 1] ];
  }

  const exprCache: {[path:string]: RegExp} = {};
  function getPathExpr(paths: Changes | Set<string>) {
    const isSet = paths instanceof Set;
    const pathsStrings = isSet ? Array.from(paths) : Object.keys(paths);
    let expr = exprCache[pathsStrings.toString()];
    if (expr) return expr;
    expr = new RegExp(pathsStrings.map(prop => `^${prop.replace(/\*/g, '[^\\/]*')}(/.*)?$`).join('|'));
    if (isSet) exprCache[pathsStrings.toString()] = expr;
    return expr;
  }

  return { subscribe, onPatch, getPendingPatch, change, send, receive, changesSince, get, getAll, getMeta, getRev, set };
}
