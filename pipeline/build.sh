#!/usr/bin/env bash
# Downloads each country from Geofabrik, keeps its streets, and builds the preloaded squares into out/.
set -euo pipefail
cd "$(dirname "$0")/.."
COUNTRIES_FILE="${COUNTRIES_FILE:-pipeline/countries.json}"
export COUNTRIES_FILE
mkdir -p work out
rm -rf out/data
for row in $(node -e "for (const c of require('./$COUNTRIES_FILE')) console.log(c.code + '=' + c.geofabrik)"); do
  code="${row%%=*}"; gf="${row#*=}"; pbf="work/$code.osm.pbf"
  if [ -n "${LOCAL_PBF_DIR:-}" ]; then cp "$LOCAL_PBF_DIR/$code.osm.pbf" "$pbf"
  else echo "Downloading $code from Geofabrik"; curl -sSfL --retry 3 -o "$pbf" "https://download.geofabrik.de/$gf-latest.osm.pbf"; fi
  osmium tags-filter "$pbf" w/highway -o "work/$code-hw.osm.pbf" --overwrite
  osmium export "work/$code-hw.osm.pbf" -f geojsonseq --geometry-types=linestring \
    --format-option print_record_separator=false -o "work/$code.geojsonseq" --overwrite
  rm -f "$pbf" "work/$code-hw.osm.pbf"
done
node pipeline/build.js work out
