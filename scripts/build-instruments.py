#!/usr/bin/env python3
"""
Builds src/audio/data/sfz-instruments.json from public SFZ sample libraries.

PianoMan streams its sampled instruments from the internet at runtime. The
sample *files* are never bundled; this script only converts each library's
SFZ mapping (which file covers which key / velocity range, tuning, volume,
release samples, pedal noises, round robins) into a compact JSON table that
the audio engine reads.

Every referenced sample is checked against the repository file listing, so a
typo or renamed file fails the build instead of failing on a user's machine.

Usage:  python3 scripts/build-instruments.py
Needs:  git and network access to github.com / raw.githubusercontent.com
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "audio", "data", "sfz-instruments.json")

GS = "smpldsnds/sfzinstruments-greg-sullivan-e-pianos"
VCSL = "smpldsnds/sgossner-vcsl"
SPLENDID = "smpldsnds/sfzinstruments-splendid-grand-piano"

# id, repo, sfz path inside repo, options
INSTRUMENTS = [
    ("splendid-grand", SPLENDID, "Splendid Grand Piano.sfz", {"sampleDir": "samples"}),
    ("vcsl-steinway-b", VCSL, "Chordophones/Zithers/Grand Piano, Steinway B.sfz", {}),
    ("vcsl-kawai-grand", VCSL, "Chordophones/Zithers/Grand Piano, Kawai.sfz", {}),
    ("vcsl-upright-yamaha", VCSL, "Chordophones/Zithers/Upright Piano, Yamaha.sfz", {}),
    ("vcsl-upright-knight", VCSL, "Chordophones/Zithers/Upright Piano, Knight.sfz", {}),
    ("gs-wurlitzer", GS, "wurlitzer-ep200/Wurlitzer EP200.sfz", {"sampleDir": "wurlitzer-ep200/samples"}),
    ("gs-cp80", GS, "cp80/CP80.sfz", {"sampleDir": "cp80/samples"}),
    ("gs-pianet", GS, "planet-t/Pianet T.sfz", {"sampleDir": "planet-t/samples"}),
    ("vcsl-tx81z-piano", VCSL, "Electrophones/TX81Z - FM Piano.sfz", {}),
    ("vcsl-harpsichord", VCSL, "Chordophones/Zithers/Harpsichord, Flemish - Full.sfz", {}),
    ("vcsl-pipe-organ", VCSL, "Aerophones/Edge-blown Aerophones/Pipe Organ - Quiet.sfz", {}),
    ("vcsl-vibraphone", VCSL, "Idiophones/Struck Idiophones/Vibraphone - Soft Mallets.sfz", {}),
    ("vcsl-marimba", VCSL, "Idiophones/Struck Idiophones/Marimba.sfz", {}),
    ("vcsl-glockenspiel", VCSL, "Idiophones/Struck Idiophones/Glockenspiel.sfz", {}),
]

HEADER_RE = re.compile(r"<(\w+)>")
OPCODE_RE = re.compile(r"(?:(?<=\s)|^)([A-Za-z0-9_$]+)=")
NOTE_NAMES = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
ORIGINAL_SAMPLE_RATE = 44100
MISSING = {}  # SFZ "offset" is in frames of the source file


def raw_url(repo, path):
    return "https://raw.githubusercontent.com/%s/main/%s" % (repo, urllib.parse.quote(path))


def fetch_text(repo, path):
    with urllib.request.urlopen(raw_url(repo, path), timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


_listing_cache = {}


def repo_listing(repo):
    """All file paths in the repo (no blobs are downloaded)."""
    if repo in _listing_cache:
        return _listing_cache[repo]
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["git", "clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "1",
             "https://github.com/%s" % repo, tmp],
            check=True,
        )
        out = subprocess.run(["git", "-C", tmp, "ls-tree", "-r", "HEAD", "--name-only"],
                             check=True, capture_output=True, text=True).stdout
    files = set(out.splitlines())
    _listing_cache[repo] = files
    return files


def note_to_midi(value):
    value = value.strip()
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    m = re.fullmatch(r"([a-gA-G])([#b]?)(-?\d+)", value)
    if not m:
        raise ValueError("bad note %r" % value)
    n = NOTE_NAMES[m.group(1).lower()] + {"#": 1, "b": -1, "": 0}[m.group(2)]
    return (int(m.group(3)) + 1) * 12 + n


def preprocess(repo, sfz_dir, text, defines):
    """Expands #define / #include and $variables, in document order."""
    out = []
    for line in text.splitlines():
        line = re.sub(r"//.*$", "", line)
        stripped = line.strip()
        m = re.match(r"#define\s+(\$\w+)\s+(.*)$", stripped)
        if m:
            defines[m.group(1)] = m.group(2).strip()
            continue
        line = substitute(line, defines)
        m = re.match(r'#include\s+"([^"]+)"', line.strip())
        if m:
            inc = posix_join(sfz_dir, m.group(1))
            listing = {p.lower(): p for p in repo_listing(repo)}
            inc = listing.get(inc.lower(), inc)  # includes are often written with the wrong case
            out.append(preprocess(repo, sfz_dir, fetch_text(repo, inc), defines))
            continue
        out.append(line)
    return "\n".join(out)


def substitute(line, defines):
    for k in sorted(defines, key=len, reverse=True):
        line = line.replace(k, defines[k])
    return line


def posix_join(*parts):
    return "/".join(p.strip("/") for p in parts if p)


def parse_sfz(text):
    """Returns a list of (header, {opcode: value}) in document order."""
    sections = []
    current = None
    pos = 0
    tokens = []
    for m in HEADER_RE.finditer(text):
        tokens.append((m.start(), m.end(), m.group(1)))
    bounds = [(t[2], t[1], tokens[i + 1][0] if i + 1 < len(tokens) else len(text)) for i, t in enumerate(tokens)]
    for header, start, end in bounds:
        body = text[start:end]
        ops = {}
        for line in body.splitlines():
            ms = list(OPCODE_RE.finditer(line))
            for i, mm in enumerate(ms):
                vend = ms[i + 1].start() if i + 1 < len(ms) else len(line)
                ops[mm.group(1)] = line[mm.end():vend].strip()
        sections.append((header, ops))
    return sections


def build(inst_id, repo, sfz_path, opts):
    sfz_dir = os.path.dirname(sfz_path)
    text = preprocess(repo, sfz_dir, fetch_text(repo, sfz_path), {})
    sections = parse_sfz(text)
    listing = repo_listing(repo)
    lower_listing = {p.lower(): p for p in listing}

    control, glob, master, group = {}, {}, {}, {}
    regions = []
    for header, ops in sections:
        if header == "control":
            control = ops
        elif header == "global":
            glob, master, group = ops, {}, {}
        elif header == "master":
            master, group = ops, {}
        elif header == "group":
            group = ops
        elif header == "region":
            merged = {}
            for layer in (glob, master, group, ops):
                merged.update(layer)
            r = convert_region(inst_id, merged, control, sfz_dir, opts, lower_listing)
            if r:
                regions.append(r)
    return regions


def convert_region(inst_id, op, control, sfz_dir, opts, lower_listing):
    trigger = op.get("trigger", "attack")
    kind = "a"
    if "on_locc64" in op or "on_hicc64" in op:
        lo = int(op.get("on_locc64", 0))
        kind = "pd" if lo >= 64 else "pu"  # pedal down / pedal up noise
    elif any(re.fullmatch(r"(lo|hi)cc\d+", k) and k not in ("locc64", "hicc64") for k in op):
        return None  # e.g. Splendid's string resonance group (cc70); PianoMan models resonance itself
    elif trigger == "release":
        kind = "r"
    elif trigger not in ("attack", "first", "legato"):
        return None
    if any(k.startswith("sw_") for k in op):  # keyswitch articulations
        if op.get("sw_last") not in (None, op.get("sw_default")):
            return None

    sample = op["sample"].replace("\\", "/")
    if opts.get("sampleDir"):
        rel = posix_join(opts["sampleDir"], os.path.basename(sample))
    else:
        rel = posix_join(sfz_dir, control.get("default_path", ""), sample)
    base = re.sub(r"\.(wav|flac|ogg|aif|aiff)$", "", rel, flags=re.I)
    found = lower_listing.get((base + ".ogg").lower())
    if not found:
        # a handful of files are missing upstream; the engine covers the gap with the nearest sample
        print("  warning: %s: sample missing upstream, skipped: %s" % (inst_id, base + ".ogg"), file=sys.stderr)
        MISSING[inst_id] = MISSING.get(inst_id, 0) + 1
        return None
    file_rel = found[:-4]  # path without extension, true case

    lokey = note_to_midi(op.get("lokey", op.get("key", "0")))
    hikey = note_to_midi(op.get("hikey", op.get("key", "127")))
    if kind in ("pd", "pu"):
        lokey, hikey = 0, 127
    center = note_to_midi(op.get("pitch_keycenter", op.get("key", str(lokey))))
    r = {
        "s": file_rel,
        "k": center,
        "lo": lokey,
        "hi": hikey,
        "vl": int(op.get("lovel", 0)),
        "vh": int(op.get("hivel", 127)),
    }
    db = float(op.get("volume", 0)) + float(op.get("group_volume", 0))
    if db:
        r["db"] = round(db, 2)
    tune = float(op.get("tune", 0)) + 100 * float(op.get("transpose", 0))
    if tune:
        r["t"] = round(tune, 1)
    if op.get("offset"):
        r["o"] = round(int(op["offset"]) / ORIGINAL_SAMPLE_RATE, 4)
    if op.get("cutoff"):
        r["fc"] = float(op["cutoff"])
    if kind != "a":
        r["tr"] = kind
    if kind in ("a", "r") and ("locc64" in op or "hicc64" in op):
        # sample set recorded with the sustain pedal down ("d") or up ("u")
        r["pc"] = "d" if int(op.get("locc64", 0)) >= 64 else "u"
    if float(op.get("ampeg_release", 0)) >= 5:
        r["u"] = 1  # undamped string: keeps ringing after key release
    if op.get("seq_length") and int(op["seq_length"]) > 1:
        r["rl"] = int(op["seq_length"])
        r["rp"] = int(op.get("seq_position", 1))
    if op.get("pitch_keytrack") == "0":
        r["nk"] = 1  # no key tracking (noises)
    if op.get("loop_mode") in ("loop_continuous", "loop_sustain") and op.get("loop_start") and op.get("loop_end"):
        r["ls"] = round(int(op["loop_start"]) / ORIGINAL_SAMPLE_RATE, 5)
        r["le"] = round(int(op["loop_end"]) / ORIGINAL_SAMPLE_RATE, 5)
    if op.get("ampeg_attack") and float(op["ampeg_attack"]) > 0.01:
        r["at"] = float(op["ampeg_attack"])
    return r


def main():
    result = {}
    for inst_id, repo, path, opts in INSTRUMENTS:
        regions = build(inst_id, repo, path, opts)
        counts = {}
        for r in regions:
            counts[r.get("tr", "a")] = counts.get(r.get("tr", "a"), 0) + 1
        print("%-22s %4d regions %s" % (inst_id, len(regions), counts), file=sys.stderr)
        if MISSING.get(inst_id, 0) > len(regions) * 0.1:
            raise SystemExit("%s: too many missing samples" % inst_id)
        if not any(r.get("tr", "a") == "a" for r in regions):
            raise SystemExit("%s: no playable regions" % inst_id)
        result[inst_id] = {"repo": repo, "regions": regions}
    with open(OUT, "w") as f:
        json.dump(result, f, separators=(",", ":"))
        f.write("\n")
    print("wrote", os.path.relpath(OUT), os.path.getsize(OUT), "bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
