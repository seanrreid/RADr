"""radr toolchain image: download, VERIFY, then extract pinned tool artifacts (M3 W0, AC1).

Runs inside the image build (stdlib only). Every artifact's sha256 is checked against the pin
from toolchain/manifest.yml BEFORE extraction; any mismatch fails the build. Layout mirrors the
host install: <dest>/<tool>/<version>/<bin>.

usage: python fetch.py tools.json <amd64|arm64> <dest>
"""

import hashlib
import io
import json
import os
import stat
import sys
import tarfile
import urllib.request
import zipfile

PLATFORM = {"amd64": "linux-x64", "arm64": "linux-arm64"}


def safe_members(names, root):
    for name in names:
        target = os.path.realpath(os.path.join(root, name))
        if not target.startswith(os.path.realpath(root) + os.sep) and target != os.path.realpath(root):
            raise SystemExit(f"refusing archive member outside destination: {name}")


def install(tool, dest):
    with urllib.request.urlopen(tool["url"], timeout=600) as r:
        data = r.read()
    got = hashlib.sha256(data).hexdigest()
    if got != tool["sha256"]:
        raise SystemExit(f"{tool['tool']}: checksum mismatch for {tool['url']}: expected {tool['sha256']}, got {got}")
    out = os.path.join(dest, tool["tool"], tool["version"])
    os.makedirs(out, exist_ok=True)
    kind = tool["archive"]
    if kind == "binary":
        with open(os.path.join(out, tool["bin"]), "wb") as f:
            f.write(data)
    elif kind in ("tar.gz", "tar.xz"):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as t:
            safe_members(t.getnames(), out)
            # Python >= 3.12 adds the "data" filter (blocks links/devices/absolute paths); older
            # interpreters rely on safe_members above, which always runs.
            if hasattr(tarfile, "data_filter"):
                t.extractall(out, filter="data")
            else:
                t.extractall(out)
    elif kind == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            safe_members(z.namelist(), out)
            z.extractall(out)
    else:
        raise SystemExit(f"unknown archive kind {kind}")
    binary = os.path.join(out, tool["bin"])
    if not os.path.isfile(binary):
        raise SystemExit(f"{tool['tool']}: archive did not contain {tool['bin']}")
    os.chmod(binary, os.stat(binary).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"verified {tool['tool']} {tool['version']} sha256:{got[:16]}…")


def main():
    spec_file, arch, dest = sys.argv[1:4]
    platform = PLATFORM.get(arch)
    if platform is None:
        raise SystemExit(f"unsupported architecture {arch}")
    with open(spec_file) as f:
        tools = json.load(f)[platform]
    for tool in tools:
        install(tool, dest)


if __name__ == "__main__":
    main()
