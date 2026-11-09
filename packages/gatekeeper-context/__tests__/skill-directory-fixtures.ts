// Fixtures for the skills.sh directory tests: repository archives shaped like `git archive` output,
// and a fake fetch that records every request. Nothing here touches the network.

export const COMMIT = "6eb6c781aa9b6438e0c7307bd102788a75fe1a6d";
export const OTHER_COMMIT = "2c5958ecac7cee2b583967a2c4981d0f4a75c579";

export type ArchiveEntry =
  | { path: string; body: string | Uint8Array }
  | { path: string; type: "directory" }
  | { path: string; type: "symlink"; target: string };

const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  block.set(encoder.encode(value).subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  writeString(block, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

function header(name: string, size: number, flag: string, linkname = ""): Uint8Array {
  let block = new Uint8Array(512);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, flag === "5" ? 0o775 : 0o664);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 1_700_000_000);
  block.fill(0x20, 148, 156);
  writeString(block, 156, 1, flag);
  writeString(block, 157, 100, linkname);
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  let sum = block.reduce((total, byte) => total + byte, 0);
  writeString(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

function paxRecord(key: string, value: string): Uint8Array {
  let content = ` ${key}=${value}\n`;
  let length = encoder.encode(content).byteLength;
  let digits = String(length).length;
  while (String(length + digits).length !== digits) digits++;
  return encoder.encode(`${length + digits}${content}`);
}

function padded(body: Uint8Array): Uint8Array[] {
  let padding = (512 - (body.byteLength % 512)) % 512;
  return [body, new Uint8Array(padding)];
}

/** An uncompressed tar of `entries` below `root/`, with `commit` in a pax global header. */
export function tarArchive(entries: ArchiveEntry[], options: { commit?: string | null; root?: string } = {}): Uint8Array {
  let root = options.root ?? "skills-HEAD";
  let blocks: Uint8Array[] = [];
  let commit = options.commit === undefined ? COMMIT : options.commit;
  if (commit) {
    let record = paxRecord("comment", commit);
    blocks.push(header("pax_global_header", record.byteLength, "g"), ...padded(record));
  }
  blocks.push(header(`${root}/`, 0, "5"));
  for (let entry of entries) {
    let path = entry.path.startsWith("/") || entry.path.startsWith("..") ? entry.path : `${root}/${entry.path}`;
    let name = path;
    if (encoder.encode(path).byteLength > 99) {
      let record = paxRecord("path", path);
      blocks.push(header("pax-header", record.byteLength, "x"), ...padded(record));
      name = path.slice(0, 99);
    }
    if ("body" in entry) {
      let body = typeof entry.body === "string" ? encoder.encode(entry.body) : entry.body;
      blocks.push(header(name, body.byteLength, "0"), ...padded(body));
    } else if (entry.type === "directory") {
      blocks.push(header(`${name}/`, 0, "5"));
    } else {
      blocks.push(header(name, 0, "2", entry.target));
    }
  }
  blocks.push(new Uint8Array(1024));
  let total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  let result = new Uint8Array(total);
  let offset = 0;
  for (let block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  return result;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  let stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A gzipped repository archive, as codeload serves one. */
export function repositoryArchive(entries: ArchiveEntry[], options?: { commit?: string | null; root?: string }): Promise<Uint8Array> {
  return gzip(tarArchive(entries, options));
}

export function manifest(name: string, description = `Use ${name}.`, body = `# ${name}\n\nInstructions.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

export type RecordedRequest = { url: string; headers: Record<string, string>; redirect?: string };

/** A fetch answering from `routes` (by exact URL, or a function), recording every request. */
export function fakeFetch(routes: Record<string, () => Response | Promise<Response>> | ((url: string) => Response | Promise<Response> | undefined)) {
  let requests: RecordedRequest[] = [];
  let fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    let headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    requests.push({ url: input, headers, redirect: init?.redirect });
    let response = typeof routes === "function" ? await routes(input) : await routes[input]?.();
    return response ?? new Response("not found", { status: 404 });
  };
  return { fetch: fetcher, requests };
}

export const codeloadUrl = (source: string, ref = "HEAD") => `https://codeload.github.com/${source}/tar.gz/${ref}`;

export const archiveResponse = (bytes: Uint8Array) => () => new Response(bytes, {
  headers: { "content-type": "application/x-gzip" },
});
