"""Builds one station ident per channel.

Eight seconds of the channel's own colour, the channel's own lockup in the
middle of it, a rule that draws itself underneath, and a struck chord that rings
out. The lockups are the drawn ones that ship with the plugin, rendered to
transparent PNG beforehand - so an ident and a channel badge are the same mark,
which is the point of having one. Nothing is downloaded and nothing is licensed.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = r"C:\Program Files\Jellyfin\Server\ffmpeg.exe"
LOGOS = os.path.join(HERE, "logos")

CHANNELS = [
    ("uno", "Uno", "1d3f8f"),
    ("action", "Action", "a4161a"),
    ("comedy", "Comedy", "e09f3e"),
    ("family", "Family", "2a9d8f"),
    ("scifi", "Sci-Fi", "5a189a"),
    ("suspense", "Suspense", "3d0e12"),
    ("drama", "Drama", "264653"),
    ("saghe", "Saghe", "6a4c93"),
    ("classici", "Classici", "7f5539"),
    ("serie", "Serie", "14213d"),
    ("sitcom", "Sitcom", "bc6c25"),
    ("nonstop", "24", "495057"),
]

# A struck chord - C5, E5, G5 over a low C3 - each voice decaying at its own rate
# so it rings rather than stops. No commas: inside a lavfi source they would be
# read as filter separators.
CHORD = (
    "0.22*sin(2*PI*523.25*t)*exp(-2.6*t)"
    "+0.17*sin(2*PI*659.25*t)*exp(-2.2*t)"
    "+0.19*sin(2*PI*783.99*t)*exp(-1.7*t)"
    "+0.06*sin(2*PI*130.81*t)*exp(-0.5*t)"
)


def build(slug, name, tone, out):
    logo = os.path.join(LOGOS, slug + ".png")
    if not os.path.exists(logo):
        print("no lockup for", slug)
        return False

    graph = (
        # the channel's colour, taken well down so the lockup sits on it
        # rather than in it - the ocra of Comedy and the amber of its own
        # mark were the same value, and the mark vanished
        "[0:v]vignette=PI/3.4,eq=brightness=-0.3:saturation=1.15[bg];"
        # the channel's own lockup, sized to sit in the middle of the frame
        "[1:v]scale=-1:150,format=rgba,"
        "fade=t=in:st=0.25:d=0.65:alpha=1,fade=t=out:st=7.1:d=0.7:alpha=1[mark];"
        "[bg][mark]overlay=(W-w)/2:(H-h)/2-24[v1];"
        # a rule that draws itself under it
        "[v1]drawbox=x=(iw-560)/2:y=(ih/2)+96:w='min(560\\,max(0\\,(t-1.1)*900))':h=3:"
        "color=white@0.85:t=fill[v2];"
        "[v2]fade=t=in:st=0:d=0.4,fade=t=out:st=7.4:d=0.6[vout]"
    )

    cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=" + tone + ":s=1280x720:r=25:d=8",
        "-loop", "1", "-i", logo,
        "-f", "lavfi", "-i", "aevalsrc=" + CHORD + ":d=8:s=48000",
        "-filter_complex", graph,
        "-map", "[vout]", "-map", "2:a",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-crf", "30", "-preset", "slow", "-r", "25",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",
        # The looped still is an infinite input: without this ffmpeg keeps
        # encoding long past the eight seconds anything else lasts.
        "-t", "8",
        "-movflags", "+faststart",
        out,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("FAILED", slug)
        print(res.stderr[-1500:])
        return False
    return True


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    outdir = os.path.join(HERE, "out")
    os.makedirs(outdir, exist_ok=True)
    for slug, name, tone in CHANNELS:
        if only and slug != only:
            continue
        out = os.path.join(outdir, slug + ".mp4")
        if build(slug, name, tone, out):
            print("%-10s %6.0f KB" % (slug, os.path.getsize(out) / 1024))
