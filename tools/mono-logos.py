"""Derives the on-air version of each channel lockup.

A broadcaster's bug is not the channel's logo in colour - it is the same shape in
white, with the name knocked out of it so the picture shows through the letters.
That is what this makes: for every lockup in Web/tv/logos, a sibling ending in
.mono.svg with the F painted flat white and the tag masked by its own lettering.

The twelve are all built the same way - one path for the F, one rounded rect for
the tag, one path for the word inside a group - so the parsing can be this
literal. If a new lockup arrives shaped differently, this will say so rather than
guess.
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOGOS = os.path.join(HERE, "..", "Jellyfin.Plugin.NetflixFin", "Web", "tv", "logos")

HEAD = re.compile(r"<svg\b([^>]*)>", re.S)
FIRST_PATH = re.compile(r'<path\b[^>]*\bd="([^"]+)"[^>]*/>', re.S)
RECT = re.compile(r"<rect\b([^>]*)/>", re.S)
GROUP = re.compile(r"<g\b[^>]*>(.*?)</g>", re.S)
ATTR = re.compile(r'(\w[\w-]*)="([^"]*)"')


def attrs(text):
    return dict(ATTR.findall(text))


def mono(source):
    svg = io.open(source, encoding="utf-8").read()
    body = svg.split("<defs")[0]

    head = attrs(HEAD.search(svg).group(1))
    letter = FIRST_PATH.search(GROUP.search(body).group(1))
    mark = FIRST_PATH.search(body)
    box = attrs(RECT.search(body).group(1))

    if not (letter and mark and box):
        raise ValueError("unfamiliar lockup: " + source)

    def num(name, fallback="0"):
        return box.get(name, fallback)

    return (
        '<svg width="{w}" height="{h}" viewBox="{vb}" fill="none" '
        'xmlns="http://www.w3.org/2000/svg">\n'
        '  <mask id="knock" maskUnits="userSpaceOnUse" x="{x}" y="{y}" '
        'width="{bw}" height="{bh}">\n'
        '    <rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="{r}" fill="#fff"/>\n'
        '    <path d="{word}" fill="#000"/>\n'
        '  </mask>\n'
        '  <path d="{mark}" fill="#fff"/>\n'
        '  <rect x="{x}" y="{y}" width="{bw}" height="{bh}" rx="{r}" fill="#fff" '
        'mask="url(#knock)"/>\n'
        '</svg>\n'
    ).format(
        w=head.get("width", ""),
        h=head.get("height", ""),
        vb=head.get("viewBox", ""),
        x=num("x"),
        y=num("y"),
        bw=num("width"),
        bh=num("height"),
        r=num("rx", "0"),
        word=letter.group(1),
        mark=mark.group(1),
    )


if __name__ == "__main__":
    made = 0
    for name in sorted(os.listdir(LOGOS)):
        if not name.endswith(".svg") or name.endswith(".mono.svg"):
            continue
        source = os.path.join(LOGOS, name)
        out = os.path.join(LOGOS, name[:-4] + ".mono.svg")
        try:
            io.open(out, "w", encoding="utf-8").write(mono(source))
        except ValueError as err:
            print(err)
            sys.exit(1)
        made += 1
        print("%-16s -> %s" % (name, os.path.basename(out)))
    print(made, "on-air marks")
