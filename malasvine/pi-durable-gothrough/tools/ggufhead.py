#!/usr/bin/env python3
"""Read the metadata a GGUF file carries about itself, from its header only (no weights downloaded).

  python3 tools/ggufhead.py <url-or-path> [key-regex]

Useful keys:
  general.architecture.context_length   what the model was trained to hold (llama.cpp: n_ctx_train)
  tokenizer.chat_template               absent => no chat format => no native tool calls either
  <arch>.rope_type / <arch>.attention.*  knobs that decide whether extending past that is sane
"""
import re
import struct
import sys
import urllib.request

U8, I8, U16, I16, U32, I32, F32, BOOL, STR, ARR, U64, I64, F64 = range(13)
SCALAR = {U8: "<B", I8: "<b", U16: "<H", I16: "<h", U32: "<I", I32: "<i", F32: "<f", U64: "<Q", I64: "<q", F64: "<d"}


def fetch(src, upto):
    if src.startswith("http"):
        req = urllib.request.Request(src, headers={"Range": f"bytes=0-{upto}", "User-Agent": "ggufhead"})
        return urllib.request.urlopen(req, timeout=180).read()
    with open(src, "rb") as fh:
        return fh.read(upto)


class Reader:
    def __init__(self, buf):
        self.buf, self.at = buf, 0

    def take(self, fmt):
        self.at += struct.calcsize(fmt)
        if self.at > len(self.buf):
            raise EOFError
        return struct.unpack_from(fmt, self.buf, self.at - struct.calcsize(fmt))[0]

    def string(self):
        n = self.take("<Q")
        self.at += n
        if self.at > len(self.buf):
            raise EOFError
        return self.buf[self.at - n : self.at].decode("utf-8", "replace")


def one(r, t):
    if t == STR:
        return r.string()
    if t == BOOL:
        return bool(r.take("<B"))
    if t == ARR:
        item, count = r.take("<I"), r.take("<Q")
        head = []
        for i in range(count):
            v = one(r, item)
            if i < 6:
                head.append(v)
        return head if count <= 6 else head + [f"… {count} items total"]
    return r.take(SCALAR[t])


def main():
    src = sys.argv[1]
    want = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
    for upto in (4 << 20, 48 << 20, 160 << 20):
        blob = fetch(src, upto)
        if blob[:4] != b"GGUF":
            sys.exit("not a GGUF file")
        r = Reader(blob)
        r.at = 4
        version = r.take("<I")
        n_tensors = r.take("<Q")
        n_kv = r.take("<Q")
        meta, complete = {}, False
        try:
            for _ in range(n_kv):
                key = r.string()
                meta[key] = one(r, r.take("<I"))
            complete = True
        except (EOFError, KeyError, struct.error):
            pass  # ran out of the range we fetched; retry wider
        if complete or upto == (160 << 20):
            print(f"# {src}")
            print(f"# gguf v{version}  tensors {n_tensors}  keys {len(meta)}/{n_kv}  read {len(blob) >> 20} MB{' (complete)' if complete else ' (TRUNCATED)'}")
            arch = next((v for k, v in meta.items() if k == "general.architecture"), "")
            for k, v in sorted(meta.items()):
                if k.startswith("tokenizer.ggml.tokens") and not complete:
                    continue
                if want and not want.search(k):
                    continue
                text = v if isinstance(v, str) else v
                if isinstance(text, str) and len(text) > 300:
                    text = text[:300] + f" … ({len(v)} chars)"
                print(f"{k} = {text}")
            if arch:
                ctx = meta.get(f"{arch}.context_length")
                print(f"\n→ context_length {ctx}  ({arch})  — set contextWindow to this, maxTokens to what you want back")
            return


if __name__ == "__main__":
    main()
