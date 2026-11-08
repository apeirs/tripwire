#!/usr/bin/env bash
# ffmpeg: work/raw.webm + work/scenes.json + captions.json -> out/tripwire-demo.mp4 (H.264, yuv420p, 1920x1080, <= 3:00).
#   tools/video/build.sh [--draft] [--values FILE] [--work DIR] [--out FILE] [--keep]
# Captions may contain {{PLACEHOLDERS}}. Values come from --values (JSON {"LAT_P50": "1.9", ...}, default
# tools/video/values.json when present). A FINAL build refuses to run while any {{...}} is left; --draft builds anyway
# (placeholders are printed as-is) and stamps DRAFT on the frame. Intermediate files are deleted unless --keep.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
DRAFT=0 KEEP=0 WORK="$here/work" OUT="$here/out/tripwire-demo.mp4" VALUES=""
[[ -f $here/values.json ]] && VALUES="$here/values.json"
while [[ $# -gt 0 ]]; do
  case $1 in
    --draft) DRAFT=1 ;;
    --keep) KEEP=1 ;;
    --values) VALUES=$2; shift ;;
    --work) WORK=$2; shift ;;
    --out) OUT=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
FONT=/usr/share/fonts/liberation/LiberationSans-Bold.ttf
FONT_R=/usr/share/fonts/liberation/LiberationSans-Regular.ttf
[[ -f $FONT && -f $FONT_R ]] || { echo "font missing: $FONT" >&2; exit 1; }
[[ -f $WORK/raw.webm && -f $WORK/scenes.json ]] || { echo "no recording in $WORK (run record.mjs first)" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")" "$WORK/txt"

# 1. Resolve captions into text files and a plan (python only does text, no network).
python3 -I - "$here" "$WORK" "${VALUES:-}" "$DRAFT" <<'PY'
import json, re, sys, os
here, work, values, draft = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
cap = json.load(open(f"{here}/captions.json"))
sc = json.load(open(f"{work}/scenes.json"))
vals = json.load(open(values)) if values and os.path.exists(values) else {}
left = set()
def sub(s):
    def r(m):
        k = m.group(1)
        if k in vals and str(vals[k]).strip() != "": return str(vals[k])
        left.add(k); return m.group(0)
    return re.sub(r"\{\{(\w+)\}\}", r, s)
plan = {"scenes": [], "draft": draft, "mode": sc["mode"]}
t0 = sc["scenes"][0]["start"]; t1 = sc["scenes"][-1]["end"]
plan["trim"] = [t0, t1]
for s in sc["scenes"]:
    text = sub(cap["scenes"].get(s["id"], ""))
    if not text: continue
    f = f"{work}/txt/scene-{s['id']}.txt"
    open(f, "w").write(text)
    plan["scenes"].append({"file": f, "a": round(s["start"] - t0 + 0.4, 2), "b": round(s["end"] - t0 - 0.2, 2)})
for k in ("title", "end"):
    for i in (1, 2, 3):
        f = f"{work}/txt/{k}{i}.txt"; open(f, "w").write(sub(cap[k][f"line{i}"]))
    plan[k + "_s"] = cap[k]["seconds"]
plan["left"] = sorted(left)
json.dump(plan, open(f"{work}/plan.json", "w"))
if left and not draft:
    print("REFUSING to build a FINAL video: unfilled placeholders: " + ", ".join("{{%s}}" % k for k in sorted(left)), file=sys.stderr)
    print("Fill them in tools/video/values.json (see values.example.json) or pass --draft.", file=sys.stderr)
    sys.exit(3)
if left: print("draft: placeholders left as-is: " + ", ".join(sorted(left)))
PY

# 2. Filter graph. Needs the plan values; read them back with python to keep quoting simple.
read -r T0 T1 TS ES MODE < <(python3 -I -c "
import json,sys;p=json.load(open('$WORK/plan.json'));print(p['trim'][0],p['trim'][1],p['title_s'],p['end_s'],p['mode'])")
dur_main=$(python3 -c "print(round($T1-$T0,2))")
cap_filters=$(python3 -I - "$WORK" "$FONT_R" <<'PY'
import json, sys
work, font = sys.argv[1:3]
p = json.load(open(f"{work}/plan.json"))
out = []
for s in p["scenes"]:
    out.append(f"drawtext=fontfile={font}:textfile={s['file']}:fontsize=38:fontcolor=white:line_spacing=10:"
               f"x=(w-text_w)/2:y=940+(140-text_h)/2:enable='between(t,{s['a']},{s['b']})'")
print(",".join(out))
PY
)
draft_mark=""
if [[ $DRAFT == 1 ]]; then
  label="DRAFT"; [[ $MODE == mock ]] && label="DRAFT - simulated replay, not for submission"
  draft_mark=",drawtext=fontfile=$FONT:text='$label':fontsize=24:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-text_w)/2:y=14"
fi
card() { # card <prefix> <seconds>
  echo "color=c=0x0c1016:s=1920x1080:r=30:d=$2,format=yuv420p,\
drawtext=fontfile=$FONT:textfile=$WORK/txt/${1}1.txt:fontsize=110:fontcolor=white:x=(w-text_w)/2:y=330,\
drawtext=fontfile=$FONT_R:textfile=$WORK/txt/${1}2.txt:fontsize=48:fontcolor=0xe6edf3:x=(w-text_w)/2:y=500,\
drawtext=fontfile=$FONT_R:textfile=$WORK/txt/${1}3.txt:fontsize=34:fontcolor=0x8a97a6:x=(w-text_w)/2:y=600${draft_mark}[$1]"
}
filter="$(card title "$TS");$(card end "$ES");\
[0:v]trim=start=$T0:duration=$dur_main,setpts=PTS-STARTPTS,fps=30,scale=1670:940,pad=1920:1080:(ow-iw)/2:0:color=0x0c1016,setsar=1,format=yuv420p,drawbox=x=0:y=938:w=1920:h=2:color=0x273140:t=fill,${cap_filters}${draft_mark}[main];\
[title][main][end]concat=n=3:v=1:a=0[v]"

tmpout="$OUT.part.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$WORK/raw.webm" -filter_complex "$filter" -map "[v]" \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart -r 30 "$tmpout"
mv "$tmpout" "$OUT"

secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
if python3 -c "import sys; sys.exit(0 if float('$secs') <= 180 else 1)"; then :; else
  echo "WARNING: video is ${secs}s, over the 3:00 limit" >&2; rm -f "$OUT"; exit 4
fi
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt,width,height,r_frame_rate -of csv=p=0 "$OUT"
echo "$OUT: ${secs}s, $(du -h "$OUT" | cut -f1)"
if [[ $KEEP == 0 ]]; then rm -rf "$WORK/raw.webm" "$WORK/txt" "$WORK/plan.json"; fi
