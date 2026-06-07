import { monotonicFactory } from "ulid";

// Monotonic: IDs generated within the same millisecond still sort in creation
// order. The event-bus cursor and the durable event log both rely on this.
const ulid = monotonicFactory();

/** All Gin entity IDs are ULIDs: lexicographically sortable, timestamp-prefixed. */
export function newId(): string {
  return ulid();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string): boolean {
  return ULID_RE.test(value);
}

/** Extract the millisecond timestamp encoded in a ULID's first 10 chars. */
export function idTimestamp(id: string): number {
  if (!isId(id)) throw new Error(`Not a valid ULID: ${id}`);
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = 0;
  for (let i = 0; i < 10; i++) {
    ts = ts * 32 + ENCODING.indexOf(id[i]!);
  }
  return ts;
}
