# Heliotropic Streets

Streets that frame the low sun at sunrise or sunset, on any day. Tap any street for its sun calendar.

## What is in this repository

| Folder | What it is |
|---|---|
| `app/index.html` | The whole app, one file. Its core (sun, straight stretches, hills) is also used by the build. |
| `pipeline/` | Builds the preloaded squares from OpenStreetMap and elevation data. |
| `.github/workflows/site.yml` | Builds and publishes the site. |

## How the site is built

GitHub Pages serves the **`site` branch**, which the workflow writes. Never edit that branch by hand.

- **Once a month (on the 1st), the first time, and whenever you start it by hand**: the workflow downloads Switzerland, Croatia and Slovenia from Geofabrik, keeps the streets (no paths, tracks, footways or tunnels), turns them into straight stretches of 50 m or more, measures the hills in both directions of each one, leaves out stretches that can never frame the low sun, and writes one small file per 3.3 km map square under `data/v1/`.
- **On every push to `main`** (for example when you upload a new `app/index.html`): the app is republished together with the squares already online. Nothing is rebuilt, so this takes about a minute.

Streets change slowly and hills not at all, so once a month is plenty. The elevation tiles are kept between builds, so monthly builds are quicker than the first. If GitHub ever pauses the monthly run (it does that to schedules in public repositories without activity for 60 days), the Actions tab shows a button to switch it back on.

The `site` branch stays a single commit, and squares that didn't change are not uploaded again. A build that fails publishes nothing, so the old site stays online. After each build, the run page shows a summary per country.

Inside the preloaded countries, streets and hills appear immediately. Everywhere else the app loads streets live from Overpass and measures the hills on the phone, with the same code, so the results match.

## Checks after a street build

After a street build, before anything goes live, the workflow opens the site in a real browser (Chromium) and runs the app's self-test, the same 11 checks you get with `?test`, on the newly built streets. Publishing is skipped, and the old site stays online, if the app doesn't start, the map doesn't appear, no streets load, or any calculation check fails. The two checks that depend on outside services (the time-zone script and the elevation tiles) only produce warnings. The results appear on the run's page.

Uploading a new `app/index.html` skips this and publishes within a minute or two. To check the live app yourself, open the site with `?test` at the end of the address.

## One-time setup (in your existing repository)

1. **Allow the workflow to publish.** Settings, then Actions, then General. Under "Workflow permissions", choose **Read and write permissions** and save.
2. **Upload the app and the build.** Add file, then Upload files. Drag in the `app` and `pipeline` folders and `README.md`, then Commit changes.
3. **Create the workflow file.** Folders starting with a dot are easy to miss when uploading, so create this one by hand: Add file, then **Create new file**. Type the name `.github/workflows/site.yml` (the slashes create the folders), paste the contents of `site.yml`, and Commit changes.
4. **Watch the first build.** This commit starts it: open the Actions tab and the run called "Site". The first one downloads three countries and every elevation tile they need, so expect roughly half an hour. Later builds reuse the elevation tiles.
5. **Point GitHub Pages at the new branch.** Settings, then Pages. Under "Source", choose **Deploy from a branch**, pick **`site`** and **`/ (root)`**, and save. The `site` branch appears after the first run finishes.
6. **Tidy up.** The old `index.html` at the top of the repository is no longer served; you can delete it.

The address stays the same, so your saved settings and saved streets carry over.

## Changing things

- **The app:** upload a new `app/index.html`. The push republishes it within a minute or two.
- **Another country:** add a line to `pipeline/countries.json` with its Geofabrik path (for example `europe/austria`), then run the workflow by hand.
- **A fresh build now:** Actions, then Site, then Run workflow.
