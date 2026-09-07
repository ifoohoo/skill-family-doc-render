# skill-family-doc-render

Config-driven GitHub Pages knowledge-site renderer for skill-family projects (multi-repo capable).

Reads `public-release.json` from the current working directory and renders every repo carrying a
`site` field from its site source directory to its target directory (typically `docs/`). New
sites explicitly select `format: "markdown-v1"` and `template: "editorial"`; the renderer parses
restricted Markdown and supplies the complete page structure, navigation, theme, interactions,
and search data. Sites without `format` keep the legacy complete-HTML injection path for
compatibility. Both paths replace version placeholders, write `.nojekyll` and a
tree baseline (`site-baseline.json`), and run a content-level leak scan over every output file
(pages **and** assets) before any target change. Render, scan, baseline computation and the
`--assert-git` preflight all finish before the target is changed, so failures in those steps
leave the existing target untouched. The final directory commit uses Foundation's fixed-set
publication APIs. A failure before commit removes staging and leaves the existing target
untouched. After commit, or when publication is indeterminate, staging or displaced data may
remain for diagnosis; the renderer does not guess or roll back.

> **Version boundary:** this source tree is version `0.4.0`. Verify that exact version in the
> official npm registry before treating it as installable. Version 0.4.0 adds `markdown-v1`, the
> `editorial` template, and `--check-project` on top of the 0.3.0 coverage workflow.

## Install

After confirming availability, install this release with an exact version:

```sh
npm install --save-exact skill-family-doc-render@0.4.0
```

Requires Node.js `>=22.22.2 <23` (aligned with the skill-family foundation packages).

Version 0.4.0 has exact runtime dependencies on `marked@18.0.11`,
`skill-family-contracts@0.18.0`, and `skill-family-harness-node@0.18.0`. `marked` supplies the
Markdown lexer; the renderer applies its own restricted-format validation before passing semantic
content to the template. The workspace profile check separately uses
`skill-family-engineering-kit@0.18.0`.
The 0.2.0 baseline format and exit-code changes are breaking changes; existing 0.1.x users
must re-render their baseline before using `--check`. See the changelog for the full migration
notes.

## CLI

Use the exact 0.4.0 CLI for rendering, checks, coverage maintenance, and the Git index assertion:

```sh
# render all repos with a site field (writes to disk)
npx skill-family-doc-render@0.4.0

# drift check only: compare in-memory render against committed site-baseline.json, write nothing
npx skill-family-doc-render@0.4.0 --check

# render / check a single repo by name
npx skill-family-doc-render@0.4.0 --repo <name>

# additionally assert every rendered file is tracked in the git index
npx skill-family-doc-render@0.4.0 --assert-git

# inspect or refresh the reviewed product-input snapshot
npx skill-family-doc-render@0.4.0 --status --repo <name>
npx skill-family-doc-render@0.4.0 --refresh-coverage --repo <name>
npx skill-family-doc-render@0.4.0 --check-project --repo <name>
```

The current directory must be the workspace that owns `public-release.json`. From this package's
source checkout, `node bin/skill-family-doc-render.mjs` is the equivalent local CLI entry.

`--check-project` requires exactly one `--repo <name>`. It cannot be combined with `--check`,
`--status`, `--refresh-coverage`, `--assert-git`, or `--help`. It checks input and public-content
safety, the mechanical Markdown contract, coverage freshness, the in-memory render and baseline,
then internal links and resources. It writes nothing. A failure identifies the repo,
`public-release.json`, the reason, and a copyable `skill-family-docs-render-site` recovery prompt.

Exit codes: `0` success; `1` drift/status class — `--check` drift, leak-scan hit, `--assert-git`
missing files, missing/corrupt render baseline, or missing/stale coverage snapshot; `2`
configuration/tool class — missing/invalid `public-release.json` or `pages.json`, JSON parse
failures, unreplaced `@TOKEN@` placeholders, invalid `--repo` usage, invalid coverage inputs, or
Git failure (the message includes the JSON field path). `--check-project` uses the same classes:
public-safety, coverage, render, link, or resource findings return `1`; invalid input,
configuration, or tool errors return `2`.
When several repos are
rendered in one run, each repo is isolated: a failure in one does not stop the others, and the
run ends with a summary of successes/failures plus a non-zero exit (2 if any failure was
configuration-class, otherwise 1).

## Configuration: `public-release.json`

The config file lives at the workspace root (resolved from `process.cwd()`). It is validated
against `schemas/public-release.schema.json` (JSON Schema 2020-12, strict policy) before
anything runs. The paired `format` and `template` fields in the example below require version
0.4.0 or later.

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
        "format": "markdown-v1",
        "template": "editorial",
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
- `site.format` and `site.template` are paired. New sites use only `markdown-v1` and `editorial`.
  Omitting both selects the legacy HTML compatibility path.
- `site.pages` points to a manifest validated against `schemas/pages.schema.json`. A
  `markdown-v1` manifest declares site metadata, navigation groups, and each page's `id`, title,
  reader role, layout kind, group, unique order, and `inPager` state. The page `id` is restricted
  to `[A-Za-z0-9][A-Za-z0-9_-]*`.
- `forbiddenPublicPaths` / `privateLiterals` append project-specific literals to the leak scan.
- `site.coverage` declares reviewed product inputs relative to `repo.source`. Each input accepts
  `*` and `**` glob syntax and must match at least one file after the coverage lock itself is
  excluded.
- `site.versionSources` maps a token to an existing JSON file and an
  [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901). `prefix` and `suffix` format
  the scalar value without copying the version into configuration. Every referenced JSON file
  automatically joins the coverage inputs.

## Input formats

### Restricted Markdown and the editorial template

Each `markdown-v1` page is `site.dir/<id>.md`, with an exact one-to-one match to the manifest.
The format supports paragraphs, level 2–4 headings, ordered and unordered lists, tables, inline
links and emphasis, fenced code with a language, `NOTE` / `TIP` / `WARNING` callouts, and local
SVG images. The manifest supplies the only H1. A heading may end with `{#stable-id}`; otherwise a
deterministic slug is generated. Raw HTML, MDX, task or nested lists, indented or unlabelled code,
ordinary blockquotes, and arbitrary attributes are rejected before output replacement.

The editorial template owns HTML, CSS, JavaScript, icons, navigation, search, and the non-circular
tutorial pager. Projects using `markdown-v1` do not supply theme CSS or JavaScript. Project images
are limited to contained SVG files. Before rendering, SVG safety checks reject scripts, event
attributes, `foreignObject`, DTD/entity declarations, and external or data resources; SVG remains
an external image and is never inlined.

### Legacy HTML compatibility

When `format` and `template` are omitted, source pages remain complete HTML and use three comment
injection points:

- `<!--NAV-->` — table-of-contents nav (active page gets `class="active"`)
- `<!--PAGER-->` — legacy circular prev/next pager
- `<!--FOOTER-->` — site footer (owner + license)

Legacy HTML remains available for existing consumers, but it does not receive the editorial
theme. New sites should not start on this compatibility path.

## Version placeholders

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

Every output file — rendered pages **and** copied or template assets (`.html`/`.css`/`.js`/`.svg`) — is
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

This package is a thin domain layer over the skill-family foundation. In addition to the two
Foundation packages below, it uses exact `marked@18.0.11` for Markdown tokenization:

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
> **Start here:** run `npx skill-family-doc-render@0.4.0 --check-project --repo <name>` after
> confirming that exact release in the official registry. From a local checkout, use
> `node bin/skill-family-doc-render.mjs --check-project --repo <name>`. The check is read-only:
> it renders in memory, compares against the committed `site-baseline.json`, writes
> nothing and touches no network or credentials. The CLI performs no Git writes; only an
> explicit `--assert-git` performs a read-only query of the Git index.

<!-- release-skill:capability:external-write-boundary -->
> **External write boundary:** rendering writes the declared target and a controlled sibling
> staging directory, both within the target's canonical parent, with contained path checks. An
> explicit `--refresh-coverage` writes only the declared coverage lock through an atomic file
> replacement. `--status`, `--check`, and `--check-project` write nothing.
> Render, scan, baseline and `--assert-git` preflight failures happen before target changes.
> Staging is removed after success or a clearly pre-commit failure; post-commit or
> indeterminate failures may retain it to preserve diagnosable state.
> It performs no Git writes, no network calls, and no writes outside that parent scope.
> Only an explicit `--assert-git` performs a read-only query of the Git index. The pre-write
> leak scan fails closed on private literals.

## Minimal example

Display help and run a read-only project check:

```sh
npx skill-family-doc-render@0.4.0 --help
npx skill-family-doc-render@0.4.0 --check-project --repo <name>
```
