#!/usr/bin/env bash
# One command: record, then build.   tools/video/make.sh [--live] [--draft] [--values FILE] [--keep] [record.mjs options]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
rec=() bld=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --draft|--keep) bld+=("$1") ;;
    --values) bld+=("$1" "$2"); shift ;;
    *) rec+=("$1") ;;
  esac
  shift
done
# Check placeholders before spending minutes recording a final take.
if [[ ! " ${bld[*]:-} " =~ " --draft " ]]; then
  v=$here/values.json; [[ " ${bld[*]:-} " =~ " --values " ]] && v=""
  [[ -n $v && ! -f $v ]] && { echo "final build needs tools/video/values.json (copy values.example.json and fill it from the measured runs), or use --draft" >&2; exit 3; }
fi
node "$here/record.mjs" "${rec[@]}"
"$here/build.sh" "${bld[@]}"
