"""Quanti titoli i canali tagliano davvero, e quanti no e perche'.

Rifa' fuori dal server la stessa decisione che prende
Api/NetflixFinCreditsController.cs - segmento, capitolo come ripiego, travaso fra
copie identiche, e poi tutte le condizioni che devono dire di si' - leggendo il
database di Jellyfin in sola lettura. Serve a vedere l'effetto di una rianalisi
senza dover interrogare il server, che chiede un login.

    python tools/credits-report.py
    python tools/credits-report.py --elenco     stampa anche i titoli tagliati
"""
import os
import re
import sqlite3
import statistics
import sys
from collections import defaultdict

DB = os.environ.get(
    "JELLYFIN_DB",
    r"C:/ProgramData/Jellyfin/Server/data/jellyfin.db")

S = 10000000           # tick in un secondo
MOVIE = "MediaBrowser.Controller.Entities.Movies.Movie"
EPISODE = "MediaBrowser.Controller.Entities.TV.Episode"

# Le tre parole che TMDb usa per dire che c'e' una scena nei titoli.
STINGERS = {"aftercreditsstinger", "duringcreditsstinger", "beforecreditsstinger"}

# Solo "fine" accanto a "titoli". Mai 'Credits' nudo, mai 'Main Titles', mai
# 'Opening Credits': in questa libreria stanno a zero secondi.
END_CREDITS = re.compile(
    r"(?:\b(?:end|closing|final)\b[\s\-_,:]*(?:credits?|titles?)\b)"
    r"|\bend[-_]credits?\b|\bsigla\s+finale\b|\btitoli\s+di\s+coda\b", re.I)

# "Sunset and End Credits" comincia dalla scena, non dai titoli.
SCENE_AND_CREDITS = re.compile(
    r"[,&]\s*end\s+(?:credits?|titles?)|\band\s+end\s+(?:credits?|titles?)", re.I)


def load():
    db = sqlite3.connect("file:" + DB.replace("\\", "/") + "?mode=ro", uri=True)
    db.execute("create temp table seg as "
               "select ItemId, StartTicks, EndTicks from MediaSegments where Type = 4")
    db.execute("create index temp.i on seg(ItemId)")

    chapters = defaultdict(list)
    for item, idx, start, name in db.execute(
            "select ItemId, ChapterIndex, StartPositionTicks, Name from Chapters"):
        chapters[item].append((idx, start, name or ""))

    items, groups = {}, defaultdict(list)
    for row in db.execute("""
            select b.Id, b.Type, b.Name, b.Path, b.RunTimeTicks, b.Tags, b.Studios,
                   s.StartTicks, s.EndTicks
            from BaseItems b left join seg s on s.ItemId = b.Id
            where b.Type in (?, ?) and b.RunTimeTicks > 0""", (MOVIE, EPISODE)):
        _id, kind, name, path, runtime, tags, studios, start, end = row
        base = os.path.basename((path or "").replace("/", os.sep)).lower()
        key = (base, runtime) if base else ("id", _id)
        items[_id] = dict(kind=kind, name=name, runtime=runtime, tags=tags,
                          studios=studios, start=start, end=end, twin=key)
        groups[key].append(_id)

    total = db.execute("select count(*) from MediaSegments where Type = 4").fetchone()[0]
    return items, groups, chapters, total


def from_segment(it):
    """Il punto che dice il file, o zero. Niente deve seguire i titoli."""
    if not it["start"] or it["start"] <= 0:
        return 0
    return it["start"] if it["end"] >= it["runtime"] - 2 * S else 0


def from_chapter(it, marks):
    """Il punto che dice l'ultimo capitolo, se e' lui a nominare i titoli."""
    if not marks:
        return 0
    last = sorted(marks, key=lambda c: c[0])[-1]
    if not END_CREDITS.search(last[2]) or SCENE_AND_CREDITS.search(last[2]):
        return 0
    return last[1] if last[1] >= it["runtime"] * 0.85 else 0


def refusal(it, start, marks):
    """Perche' questo titolo non si taglia li', o None se si puo'."""
    runtime = it["runtime"]
    cut = runtime - start

    if it["kind"] == MOVIE:
        if start < runtime / 2:
            return "i titoli comincerebbero prima di meta' film"
        if cut < 45 * S:
            return "taglio sotto i 45 secondi"
        if cut > 20 * 60 * S:
            return "taglio sopra i 20 minuti"
        tags = set((it["tags"] or "").lower().replace("|", " ").split())
        if not (it["tags"] or "").strip():
            return "nessuna parola chiave TMDb, quindi il silenzio non prova niente"
        if tags & STINGERS:
            return "scena nei titoli o dopo"
        if "marvel" in (it["studios"] or "").lower():
            return "marvel"
    else:
        if start < runtime * 0.85:
            return "i titoli comincerebbero prima dell'85%"
        if cut < 20 * S:
            return "taglio sotto i 20 secondi"
        if cut > 5 * 60 * S:
            return "taglio sopra i 5 minuti"

    if any(c[1] > start + 30 * S for c in marks):
        return "c'e' un capitolo marcato dopo l'inizio dei titoli"
    return None


def decide(items, groups, chapters):
    """La mappa che il server manderebbe, piu' il motivo di ogni rifiuto."""
    own, why, source = {}, {}, {}

    for _id, it in items.items():
        marks = chapters.get(_id, [])

        mark = from_segment(it)
        if mark and not refusal(it, mark, marks):
            own[_id], source[_id] = mark, "segmento"
            continue

        chapter = from_chapter(it, marks)
        if chapter and not refusal(it, chapter, marks):
            own[_id], source[_id] = chapter, "capitolo"
            continue

        own[_id] = 0
        if mark:
            why[_id] = refusal(it, mark, marks)
        elif chapter:
            why[_id] = refusal(it, chapter, marks)
        else:
            why[_id] = "il file non dice dove sono i titoli"

    shared = {}
    for key, ids in groups.items():
        got = [own[i] for i in ids if own[i] > 0]
        if got:
            shared[key] = max(got)

    cuts = {}
    for _id, it in items.items():
        start = own[_id] or shared.get(it["twin"], 0)
        if start and not refusal(it, start, chapters.get(_id, [])):
            cuts[_id] = it["runtime"] - start
            source.setdefault(_id, "copia gemella")
    return cuts, why, source


def main():
    items, groups, chapters, segments = load()
    cuts, why, source = decide(items, groups, chapters)

    films = {items[i]["twin"] for i in items if items[i]["kind"] == MOVIE}
    episodes = {items[i]["twin"] for i in items if items[i]["kind"] == EPISODE}
    cutFilms = {items[i]["twin"] for i in cuts if items[i]["kind"] == MOVIE}
    cutEpisodes = {items[i]["twin"] for i in cuts if items[i]["kind"] == EPISODE}

    print("segmenti di titoli di coda nel database: %d" % segments)
    print("film    tagliati %4d su %4d" % (len(cutFilms), len(films)))
    print("episodi tagliati %4d su %4d" % (len(cutEpisodes), len(episodes)))
    print("tempo risparmiato: %.1f ore" % (sum(cuts.values()) / S / 3600))

    lengths = sorted(cuts[i] / S / 60 for i in cuts if items[i]["kind"] == MOVIE)
    if lengths:
        print("taglio sui film: minimo %.1f  mediana %.1f  massimo %.1f minuti"
              % (lengths[0], statistics.median(lengths), lengths[-1]))

    how = defaultdict(set)
    for _id in cuts:
        how[source.get(_id, "?")].add(items[_id]["twin"])
    print("\nda dove viene il punto:")
    for k, v in sorted(how.items(), key=lambda x: -len(x[1])):
        print("   %-14s %d" % (k, len(v)))

    refused = defaultdict(set)
    for _id, reason in why.items():
        if items[_id]["twin"] not in cutFilms and items[_id]["twin"] not in cutEpisodes:
            refused[reason].add(items[_id]["twin"])
    print("\nperche' gli altri no:")
    for k, v in sorted(refused.items(), key=lambda x: -len(x[1])):
        print("   %-58s %d" % (k, len(v)))

    if "--elenco" in sys.argv:
        print("\nfilm tagliati:")
        seen = set()
        for _id in sorted(cuts, key=lambda i: items[i]["name"] or ""):
            it = items[_id]
            if it["kind"] != MOVIE or it["twin"] in seen:
                continue
            seen.add(it["twin"])
            print("   %-52s %5.1f min  (%s)"
                  % (str(it["name"])[:52], cuts[_id] / S / 60, source.get(_id, "?")))


if __name__ == "__main__":
    main()
