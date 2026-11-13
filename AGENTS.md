# Project verification

Install the Plannotator integration's dependencies in each checkout before checking or testing its changes:

```sh
npm ci --prefix integrations/plannotator
npm run check --prefix integrations/plannotator
npm test --prefix integrations/plannotator
```

Pi loads the integration into its own process. After changing it, reload Pi and verify the behavior in the running Herdr App. Check the installed app and the loaded integration, not only the files on disk.

A Linux `cargo build` or `cargo test` needs the Rust and Zig versions that README's "Build from source" names and the packages that the "Linux build dependencies" step of `.github/workflows/ci.yml` installs. When `zig` on PATH is another version, point the `ZIG` variable at Zig 0.16.0.

# CI

Only the Windows build matters: this fork ships for Windows alone. Before merging a pull request, wait for the Windows jobs only. Do not wait for, rerun or fix the macOS and Linux jobs.

# Pull requests

A new or changed command ships with its documentation in the same pull request: `the_guide_names_every_command` fails when `defaults/AGENTS.md` does not name a command, and `just docs-check` fails when `docs/commands.md` is out of date. Do not split them into a separate documentation PR.