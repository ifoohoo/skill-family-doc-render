# skill-family-doc-render

Config-driven GitHub Pages knowledge-site renderer for skill-family projects (multi-repo capable).

Reads `public-release.json` from the current working directory, renders every repo carrying a
`site` field from its site source directory to its target directory (typically `docs/`), injects
nav / pager / footer, replaces version placeholders, copies assets, writes `.nojekyll` and a
tree baseline (`site-baseline.json`), and runs a content-level leak scan over every output file
(pages **and** assets) before any target change. Render, scan, baseline computation and the
`--assert-git` preflight all finish before the target is changed, so failures in those steps
leave the existing target untouched. The final directory commit uses Foundation's fixed-set
publication APIs. A failure before commit removes staging and leaves the existing target
untouched. After commit, or when publication is indeterminate, staging or displaced data may
remain for diagnosis; the renderer does not guess or roll back.

> **Development status:** this worktree is the unpublished `0.3.0` candidate. The latest npm
> release is `0.2.1`; it does not contain `site.coverage`, `site.versionSources`, `--status`, or
> `--refresh-coverage`.

## Install

Install the current published release with an exact version:

```sh
npm install --save-exact skill-family-doc-render@0.2.1
```

Requires Node.js `>=22.22.2 <23` (aligned with the skill-family foundation packages).

The unpublished 0.3.0 candidate consumes the three Foundation packages at the exact `0.18.0` pin:
`skill-family-contracts@0.18.0`, `skill-family-harness-node@0.18.0` and
`skill-family-engineering-kit@0.18.0` (the last one is used by the workspace profile check).
The 0.2.0 baseline format and exit-code changes are breaking changes; existing 0.1.x users
must re-render their baseline before using `--check`. See the changelog for the full migration
notes.

## CLI

The published 0.2.1 release supports rendering, drift checks, repository selection, and the Git
index assertion:

```sh
# render all repos with a site field (writes to disk)
npx skill-family-doc-render@0.2.1

# drift check only: compare in-memory render against committed site-baseline.json, write nothing
npx skill-family-doc-render@0.2.1 --check

# render / check a single repo by name
npx skill-family-doc-render@0.2.1 --repo <name>

# additionally assert every rendered file is tracked in the git index
npx skill-family-doc-render@0.2.1 --assert-git
```

Run the unpublished 0.3.0 coverage commands from a local package checkout. The current directory
must still be the workspace that owns `public-release.json`; adjust the script path when the
package is nested in a monorepo:

```sh
# inspect whether reviewed product inputs have changed; writes nothing
node bin/skill-family-doc-render.mjs --status --repo <name>

# refresh only the reviewed-input snapshot after semantic and style review
node bin/skill-family-doc-render.mjs --refresh-coverage --repo <name>
```

After 0.3.0 is published, consumers can install or invoke that exact release:

```sh
npm install --save-exact skill-family-doc-render@0.3.0
npx skill-family-doc-render@0.3.0 --status --repo <name>
```

Exit codes: `0` success; `1` drift class — `--check` drift, leak-scan hit, `--assert-git`
missing files, missing/corrupt render baseline, or missing/stale coverage snapshot; `2`
configuration/tool class — missing/invalid `public-release.json` or `pages.json`, JSON parse
failures, unreplaced `@TOKEN@` placeholders, invalid `--repo` usage, invalid coverage inputs, or
Git failure (the message includes the JSON field path). When several repos are
rendered in one run, each repo is isolated: a failure in one does not stop the others, and the
run ends with a summary of successes/failures plus a non-zero exit (2 if any failure was
configuration-class, otherwise 1).

## Configuration: `public-release.json`

The config file lives at the workspace root (resolved from `process.cwd()`). It is validated
against `schemas/public-release.schema.json` (JSON Schema 2020-12, strict policy) before
anything runs. `coverage` and `versionSources` in the example below belong to the unpublished
0.3.0 candidate.

```json
{
  "owner": "your-org",
  "defaultBranch": "main",
  "license": "Apache-2.0",
  "repos": [
    {
      "name": "my-project",
      "source": "packages/my-project",
      "tagPrefix": "my-project-v",
      "site": {
        "dir": "site-src",
        "target": "docs",
        "pages": "pages.json",
        "coverage": {
          "lock": "site-coverage-lock.json",
          "inputs": ["package.json", "src/**", "schemas/**"]
        },
        "versionSources": {
          "@COMPONENT_VERSION@": {
            "source": "package.json",
            "pointer": "/version"
          },
          "@COMPONENT_TAG@": {
            "source": "package.json",
            "pointer": "/version",
            "prefix": "component-v"
          }
        },
        "tokens": { "@CUSTOM_NOTE@": "any static placeholder" }
      }
    }
  ],
  "forbiddenPublicPaths": ["public-release.json"],
  "privateLiterals": []
}
```

- Only repos with a `site` field are rendered; `--repo <name>` selects one by `name`
  (`--repo` without a valid value is an error, never a silent "render all").
- `site.pages` points to a pages manifest: `{ "pages": [{ "id", "title", "order", "inPager" }] }`,
  validated against `schemas/pages.schema.json`. Pages are sorted by `order`;
  `inPager: false` excludes a page from the prev/next pager. Page `id` is restricted to
  `[A-Za-z0-9][A-Za-z0-9_-]*`.
- `forbiddenPublicPaths` / `privateLiterals` append project-specific literals to the leak scan.
- `site.coverage` declares reviewed product inputs relative to `repo.source`. Each input accepts
  `*` and `**` glob syntax and must match at least one file after the coverage lock itself is
  excluded.
- `site.versionSources` maps a token to an existing JSON file and an
  [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901). `prefix` and `suffix` format
  the scalar value without copying the version into configuration. Every referenced JSON file
  automatically joins the coverage inputs.

## Placeholders

Source pages use three HTML-comment injection points, replaced at render time:

- `<!--NAV-->` — table-of-contents nav (active page gets `class="active"`)
- `<!--PAGER-->` — circular prev/next pager
- `<!--FOOTER-->` — site footer (owner + license)

Version tokens are derived automatically from the repo's `package.json` version and `name`
(uppercased, non-alphanumeric runs collapsed to `_`):

- `@{NAME}_TAG@` — e.g. `my-project` → `@MY_PROJECT_TAG@` = `tagPrefix` + version
- `@{NAME}_VERSION@` — the bare version

`site.tokens` adds non-version static placeholder replacements. A token also declared in
`site.versionSources` always takes its value from the JSON source. If a rendered page still
contains an unreplaced `@TOKEN@` (`@[A-Z0-9_]+@`), the run fails fast (exit 2) naming the
tokens and the file — placeholder typos never slip into the published site silently.

If a repo has no `package.json` (or no valid `version`), the version falls back to `0.0.0`
with a loud `WARNING` on stderr, because that fallback is baked into the output and the
baseline; a malformed `package.json` fails fast (exit 2).

## Coverage status

`--refresh-coverage --repo <name>` expands `site.coverage.inputs`, adds every configured version
source, computes the file digests and closure digest, then atomically writes the declared coverage
lock. It does not render the site or modify Git. The lock contains only:

- `sha256`: the Foundation resource-closure digest;
- `inputs`: sorted relative file paths and their byte digests;
- `artifactGraphVersionLockSha256`: the current `artifacts/traceability-version-lock.json`
  digest when the repository contains `artifact-graph.config.yaml`.

`--status --repo <name>` recomputes the same facts without writing. It prints the last commit that
changed the coverage lock, the current and recorded closure digests, changed covered files,
current values from `site.versionSources`, and suggested `git diff` commands. A matching snapshot
returns `0`; a missing or stale snapshot returns `1`. A site without `coverage`, a path escape, an
empty glob, an invalid JSON pointer, a symlink escape, or a Git failure returns `2`.

Coverage paths are relative to `repo.source`. Absolute paths, lexical traversal, realpath escape,
and symlink escape are rejected through Foundation path containment. The coverage lock is always
excluded from its own inputs, avoiding a digest cycle. `--status` requires a Git repository with a
resolvable `HEAD`, because its report includes committed, staged, unstaged, and covered untracked
changes.

## Leak scan

Every output file — rendered pages **and** copied assets (`.html`/`.css`/`.js`/`.svg`) — is
scanned **before** any write (`scripts/lib/leak-scan.mjs`). The scanner decodes HTML entities
(two passes, defeating double encoding), JS escape sequences and URL percent-encoding first,
then matches case-insensitively against built-in private literals (absolute home paths) and
secret regexes (private keys, GitHub / Slack / AWS / OpenAI tokens), plus the configured
`forbiddenPublicPaths` / `privateLiterals`. Any hit fails the run fast (exit 1) — encoding
tricks do not slip through.

## Tree baseline

After staging, the renderer records `site-baseline.json` in the target directory:

```json
{
  "sha256": "<closure digest over the staged tree>",
  "files": ["<sorted relative paths, excluding the baseline itself>"],
  "digests": { "<path>": "<per-file sha256 of the rendered bytes>" }
}
```

`--check` is read-only and fails on any of three drift classes:

1. **Stale render / renderer regression** — per-file sha256 of the in-memory render vs
   `digests` (catches "source changed but never re-rendered" and "renderer output changed");
2. **Hand-added or deleted files** — the actual on-disk file listing of the target vs the
   `files` set;
3. **Hand-modified output** — the on-disk tree closure digest vs `sha256`.

The digest is a deterministic set-level sha256 over the contained resources.

## Foundation dependencies

This package is a thin domain layer over the skill-family foundation and adds no other runtime
dependencies:

- [`skill-family-harness-node`](https://github.com/ifoohoo/skill-family-harness-node) — all file
  reads go through `resolveContained` / `readFileContained` (path traversal, symlink and realpath
  escapes rejected), per-file digests use `digestBytes`, the tree baseline is computed with
  `computeResourceClosure`, and coverage locks use `writeFileAtomic`. Output is staged in a
  sibling directory under the target's canonical parent, with contained writes through
  `writeFileAtomic`. A new target uses
  `createFixedSetPublicationManifest` followed by `publishFixedSet`; an existing target uses
  `replaceFixedSetAtomic`. Staging is removed after success or a clearly pre-commit failure;
  post-commit or indeterminate failures may retain it for diagnosis. These APIs do not add a
  broader atomicity guarantee than Foundation provides.
- [`skill-family-contracts`](https://github.com/ifoohoo/skill-family-contracts) —
  `validateDocument` (JSON Schema 2020-12, strict policy) validates `public-release.json`,
  `pages.json`, `site-baseline.json`, and `site-coverage-lock.json`; validation failure aborts
  with exit code 2.

## License

Apache-2.0

<!-- release-skill:capability:safe-first-command -->
> **Start here:** for the unpublished 0.3.0 candidate, run
> `node bin/skill-family-doc-render.mjs --check` from its local checkout. Published 0.2.1 users
> can run `./node_modules/.bin/skill-family-doc-render --check`. The drift check is read-only:
> it renders in memory, compares against the committed `site-baseline.json`, writes
> nothing and touches no network or credentials. The CLI performs no Git writes; only an
> explicit `--assert-git` performs a read-only query of the Git index.

<!-- release-skill:capability:external-write-boundary -->
> **External write boundary:** rendering writes the declared target and a controlled sibling
> staging directory, both within the target's canonical parent, with contained path checks. An
> explicit `--refresh-coverage` writes only the declared coverage lock through an atomic file
> replacement. `--status` and `--check` write nothing.
> Render, scan, baseline and `--assert-git` preflight failures happen before target changes.
> Staging is removed after success or a clearly pre-commit failure; post-commit or
> indeterminate failures may retain it to preserve diagnosable state.
> It performs no Git writes, no network calls, and no writes outside that parent scope.
> Only an explicit `--assert-git` performs a read-only query of the Git index. The pre-write
> leak scan fails closed on private literals.

## Minimal example

Use the local checkout while 0.3.0 remains unpublished:

```sh
node bin/skill-family-doc-render.mjs --help
node bin/skill-family-doc-render.mjs --check
```

Replace `node bin/skill-family-doc-render.mjs` with `npx skill-family-doc-render@0.3.0` only after
the registry publishes 0.3.0.
