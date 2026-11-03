# Static export and deploy guide

The shared release model is maintained in AgentController:
`standards/guidelines/export.md` and `standards/guidelines/repository-commands.md`.
See [deploy.md](deploy.md) for this repository?s commands, packaging, destination and smoke tests.

Run Local serves source. Deploy Local packages `Export/Local` as `0.0.C`.
Deploy Prod (humans only) claims N on GitHub, packages `Export/VersionN` as `0.N.C`,
uploads assets before HTML and verifies the live asset version. Both deploys require
committed changes; production also requires HEAD on upstream before claiming N.

Each package has a `build.json` with source information and non-HTML file hashes.
Production compares those hashes with a local package from the same source commit.
Only HTML carries the version; packaged local scripts and stylesheets use versioned URLs.
Release folders are never overwritten. Existing legacy Export folders are preserved.
