import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const SOURCE = "window.__baoyuNativeDownloads=true;";
const SCRIPT = Buffer.from(`<script>${SOURCE}</script>`);
const SCRIPT_HASH = `'sha256-${createHash("sha256").update(SOURCE).digest("base64")}'`;
const DECODERS = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };

/** Authorize only our exact script in each enforced policy, preserving inline-only policies. */
function nativeDownloadCsp(value) {
  if (Array.isArray(value)) return value.map(nativeDownloadCsp);
  return value.split(",").map((policy) => {
    const directives = policy.split(";");
    let at = -1;
    for (const name of ["script-src-elem", "script-src", "default-src"]) {
      at = directives.findIndex((part) => part.trim().split(/\s+/)[0].toLowerCase() === name);
      if (at !== -1) break;
    }
    if (at === -1) return policy; // No restriction on scripts.
    const sources = directives[at].trim().split(/\s+/).slice(1);
    // A hash disables unsafe-inline. Add one only if inline scripts are already restricted.
    if (sources.includes(SCRIPT_HASH) || (sources.includes("'unsafe-inline'")
      && !sources.some((source) => /^'(?:sha256-|sha384-|sha512-|nonce-)/i.test(source)))) return policy;
    directives[at] += ` ${SCRIPT_HASH}`;
    return directives.join(";");
  }).join(",");
}

/** Inject only after an explicit head; otherwise stream the buffered bytes unchanged. */
export function nativeDownloadHtml() {
  let prefix = Buffer.alloc(0), streaming = false;
  const emit = (stream, end = false) => {
    const head = /<head\b[^>]*>/i.exec(prefix.toString("latin1"));
    if (!head && !end && prefix.length < 65536) return;
    if (head) {
      const at = head.index + head[0].length;
      stream.push(prefix.subarray(0, at)); stream.push(SCRIPT); stream.push(prefix.subarray(at));
    } else stream.push(prefix);
    prefix = null; streaming = true;
  };
  return new Transform({
    transform(chunk, encoding, done) {
      if (streaming) this.push(chunk);
      else { prefix = Buffer.concat([prefix, chunk]); emit(this); }
      done();
    },
    flush(done) { if (!streaming) emit(this, true); done(); },
  });
}

/** Only the authenticated web-preview gateway rewrites HTML; relay and desktop stay untouched. */
export function previewDownloadBody(reply, headers) {
  if (reply.statusCode !== 200 || !/^text\/html(?:\s*;|$)/i.test(headers["content-type"] || "")
    || headers["content-disposition"] || /charset\s*=\s*["']?(?!utf-8\b|utf8\b)[\w-]+/i.test(headers["content-type"])) return reply;
  const encoding = String(headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity" && !Object.hasOwn(DECODERS, encoding)) return reply;
  if (headers["content-security-policy"]) headers["content-security-policy"] = nativeDownloadCsp(headers["content-security-policy"]);
  for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) delete headers[name];
  const output = nativeDownloadHtml();
  let input = reply;
  if (encoding !== "identity") {
    input = DECODERS[encoding]();
    input.on("error", (error) => output.destroy(error));
    reply.pipe(input);
  }
  output.on("close", () => { if (input !== reply) input.destroy(); });
  return input.pipe(output);
}
