# Site data source

Files in `fixes/*.json` map a site pattern to a fix. `dark-sites.json` lists hosts that are already dark.
Run `npm run data:build` to check them and write the shards under `extension/data/`.
Each fix needs a `note` and a `verified` field (`date`, `browsers`, `test`).
