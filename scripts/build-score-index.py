#!/usr/bin/env python3
"""
Builds src/search/data/score-index.json: a searchable catalog of freely
available scores hosted on GitHub, so the in-app search works instantly and
offline (only the chosen score is downloaded when you open it).

Collections:
  asap     - ASAP dataset: ~230 classical piano works engraved as MusicXML
             (github.com/fosfrancesco/asap-dataset, CC BY-NC-SA 4.0)
  music21  - music21 corpus MusicXML/MXL files (github.com/cuthbertLab/music21)

Usage:  python3 scripts/build-score-index.py
"""
import csv
import io
import json
import os
import re
import subprocess
import tempfile
import urllib.request

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "search", "data", "score-index.json")

NICKNAMES = {
    ("Beethoven", "8"): "Pathétique",
    ("Beethoven", "14"): "Moonlight",
    ("Beethoven", "17"): "Tempest",
    ("Beethoven", "21"): "Waldstein",
    ("Beethoven", "23"): "Appassionata",
    ("Beethoven", "26"): "Les Adieux",
    ("Beethoven", "29"): "Hammerklavier",
    ("Mozart", "11"): "Alla Turca",
    ("Chopin", "op_10_3"): "Tristesse",
    ("Chopin", "op_10_5"): "Black Key",
    ("Chopin", "op_10_12"): "Revolutionary",
    ("Chopin", "op_25_1"): "Aeolian Harp",
    ("Chopin", "op_25_9"): "Butterfly",
    ("Chopin", "op_25_11"): "Winter Wind",
    ("Chopin", "53"): "Heroic",
    ("Chopin", "sonata2"): "Funeral March",
}

MOVEMENT = {"1": "I", "2": "II", "3": "III", "4": "IV", "3_4": "III–IV"}


def listing(repo, branch):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "1",
                        "-b", branch, "https://github.com/%s" % repo, tmp], check=True)
        out = subprocess.run(["git", "-C", tmp, "ls-tree", "-r", "HEAD", "--name-only"],
                             check=True, capture_output=True, text=True).stdout
    return out.splitlines()


def pretty(s):
    s = s.replace("_", " ").replace("lEau", "l'Eau").strip()
    s = re.sub(r"\bop\b\.?", "Op.", s)
    s = re.sub(r"\bbwv\b", "BWV", s, flags=re.I)
    s = re.sub(r"\bno\b", "No.", s)
    return re.sub(r"\s+", " ", s)


def asap_title(composer, folder):
    parts = folder.split("/")[1:]
    variant = ""
    last = parts[-1]
    m = re.match(r"(.*?)(_no_.*|_repeat)$", last)
    if m and m.group(1):
        variant = " (" + m.group(2).strip("_").replace("_", " ") + ")"
        parts[-1] = m.group(1)
    nick = ""
    if parts[0] in ("Piano_Sonatas", "Keyboard_Sonatas") and len(parts) == 2:
        num, _, mv = parts[1].partition("-")
        kind = "Keyboard Sonata" if parts[0].startswith("Keyboard") else "Piano Sonata"
        label = "D. %s" % num if composer == "Schubert" else "No. %s" % num
        n = NICKNAMES.get((composer, num))
        nick = ' "%s"' % n if n else ""
        title = "%s %s%s – %s mvt." % (kind, label, nick, MOVEMENT.get(mv, mv))
    elif parts[0] in ("Fugue", "Prelude"):
        title = "%s in the Well-Tempered Clavier, %s" % (parts[0], pretty(parts[1]))
    elif parts[0].startswith("Etudes_op_"):
        op = parts[0].replace("Etudes_", "")
        n = NICKNAMES.get((composer, "%s_%s" % (op, parts[1])))
        title = "Étude %s No. %s%s" % (pretty(op), parts[1], ' "%s"' % n if n else "")
    elif composer == "Chopin" and parts[0] == "Sonata_2":
        title = "Piano Sonata No. 2 – %s mvt." % parts[1].replace("st", "").replace("nd", "").replace("rd", "").replace("th", "")
        if parts[1].startswith("3"):
            title += ' "Funeral March"'
    elif composer == "Chopin" and parts[0] == "Sonata_3":
        title = "Piano Sonata No. 3 – %s mvt." % re.sub(r"\D", "", parts[1])
    elif composer == "Chopin" and parts[0] == "Polonaises":
        title = 'Polonaise Op. %s "Heroic"' % parts[1]
    elif composer == "Chopin" and parts[0] == "Scherzos":
        title = "Scherzo Op. %s" % parts[1]
    elif composer == "Chopin" and parts[0] == "Ballades":
        title = "Ballade No. %s" % parts[1]
    else:
        title = " – ".join(pretty(p) for p in parts)
    return title + variant


def build_asap():
    repo, branch = "fosfrancesco/asap-dataset", "master"
    files = set(listing(repo, branch))
    meta = urllib.request.urlopen("https://raw.githubusercontent.com/%s/%s/metadata.csv" % (repo, branch), timeout=60).read().decode()
    seen = set()
    out = []
    for row in csv.DictReader(io.StringIO(meta)):
        path = row["xml_score"]
        if path in seen or path not in files:
            continue
        seen.add(path)
        out.append({
            "t": asap_title(row["composer"], row["folder"]),
            "c": row["composer"],
            "p": path,
            "m": row["midi_score"] if row["midi_score"] in files else None,
        })
    out.sort(key=lambda e: (e["c"], e["t"]))
    return {"repo": repo, "branch": branch, "items": out}


COMPOSERS = {
    "bach": "J. S. Bach", "beethoven": "Beethoven", "mozart": "Mozart", "haydn": "Haydn",
    "schumann_robert": "Robert Schumann", "schumann_clara": "Clara Schumann", "joplin": "Scott Joplin",
    "handel": "Handel", "cpebach": "C. P. E. Bach", "corelli": "Corelli", "schubert": "Schubert",
    "schoenberg": "Schoenberg", "webern": "Webern", "weber": "Weber", "verdi": "Verdi",
    "monteverdi": "Monteverdi", "trecento": "Trecento (various)", "liliuokalani": "Liliʻuokalani",
    "johnson_j_r": "J. Rosamond Johnson", "luca": "Luca", "ciconia": "Ciconia", "lusitano": "Lusitano",
    "demos": "Demo", "leadSheet": "Lead sheet", "theoryExercises": "Exercise",
}


def build_music21():
    repo, branch = "cuthbertLab/music21", "master"
    out = []
    for path in listing(repo, branch):
        if not path.startswith("music21/corpus/") or not re.search(r"\.(mxl|xml|musicxml)$", path):
            continue
        rel = path[len("music21/corpus/"):]
        parts = rel.split("/")
        comp = COMPOSERS.get(parts[0], parts[0].replace("_", " ").title())
        name = re.sub(r"\.(mxl|xml|musicxml)$", "", parts[-1])
        middle = [p for p in parts[1:-1]]
        if parts[0] == "bach" and re.match(r"bwv\d", name):
            title = "Chorale " + name.upper().replace("BWV", "BWV ").replace(".", " no. ", 1)
        else:
            title = " – ".join(pretty(p).title() for p in middle + [name])
        out.append({"t": title, "c": comp, "p": path})
    out.sort(key=lambda e: (e["c"], e["t"]))
    return {"repo": repo, "branch": branch, "items": out}


def main():
    index = {"asap": build_asap(), "music21": build_music21()}
    with open(OUT, "w") as f:
        json.dump(index, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    for k, v in index.items():
        print(k, len(v["items"]))
    print("wrote", os.path.relpath(OUT), os.path.getsize(OUT))


if __name__ == "__main__":
    main()
