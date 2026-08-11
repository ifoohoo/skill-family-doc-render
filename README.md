# skill-family-doc-render

Config-driven GitHub Pages knowledge-site renderer for skill-family projects (multi-repo capable).

Reads `public-release.json` from the current working directory, renders every repo carrying a
`site` field from its site source directory to its target directory (typically `docs/`), injects
nav / pager / footer, replaces version placeholders, copies assets, writes `.nojekyll` and a
tree baseline (`site-baseline.json`), and runs a content-level leak scan before any write.

## Install

```sh
npm install skill-family-doc-render
```

Requires Node.js `>=22.22.2 <23` (aligned with the skill-family foundation packages).

## CLI

```sh
# render all repos with a site field (writes to disk)
npx skill-family-doc-render

# drift check only: compare in-memory render against committed site-baseline.json, write nothing
npx skill-family-doc-render --check

# render / check a single repo by name
npx skill-family-doc-render --repo <name>

# additionally assert every rendered file is tracked in the git index
npx skill-family-doc-render --assert-git
```

Exit codes: `0` success, `1` drift / check failure / leak-scan hit, `2` configuration or
schema validation error (the message includes the JSON field path).

## Configuration: `public-release.json`

The config file lives at the workspace root (resolved from `process.cwd()`). It is validated
against `schemas/public-release.schema.json` (JSON Schema 2020-12, strict policy) before
anything runs.

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
        "tokens": { "@CUSTOM_NOTE@": "any static placeholder" }
      }
    }
  ],
  "forbiddenPublicPaths": ["public-release.json"],
  "privateLiterals": []
}
```

- Only repos with a `site` field are rendered; `--repo <name>` selects one by `name`.
- `site.pages` points to a pages manifest: `{ "pages": [{ "id", "title", "order", "inPager" }] }`.
  Pages are sorted by `order`; `inPager: false` excludes a page from the prev/next pager.
- `forbiddenPublicPaths` / `privateLiterals` append project-specific literals to the leak scan.

## Placeholders

Source pages use three HTML-comment injection points, replaced at render time:

- `<!--NAV-->` — table-of-contents nav (active page gets `class="active"`)
- `<!--PAGER-->` — circular prev/next pager
- `<!--FOOTER-->` — site footer (owner + license)

Version tokens are derived automatically from the repo's `package.json` version and `name`
(uppercased, non-alphanumeric runs collapsed to `_`):

- `@{NAME}_TAG@` — e.g. `my-project` → `@MY_PROJECT_TAG@` = `tagPrefix` + version
- `@{NAME}_VERSION@` — the bare version

`site.tokens` adds arbitrary static placeholder replacements on top.

## Leak scan

Every rendered page is scanned **before** any write (`scripts/lib/leak-scan.mjs`). The scanner
decodes HTML entities and JS escape sequences first, then matches the decoded text against
built-in private literals (absolute home paths) and secret regexes (private keys, GitHub /
Slack / AWS / OpenAI tokens), plus the configured `forbiddenPublicPaths` / `privateLiterals`.
Any hit fails the run fast — encoding tricks do not slip through.

## Tree baseline

After writing, the renderer records `site-baseline.json` in the target directory:

```json
{ "sha256": "<closure digest>", "files": ["<sorted relative paths, excluding the baseline itself>"] }
```

`--check` recomputes the digest from the in-memory render and fails on any drift. The digest is
a deterministic set-level sha256 over the contained resources.

## Foundation dependencies

This package is a thin domain layer over the skill-family foundation and adds no other runtime
dependencies:

- [`skill-family-harness-node`](https://github.com/ifoohoo/skill-family-harness-node) — all file
  reads go through `resolveContained` / `readFileContained` (path traversal, symlink and realpath
  escapes rejected), all writes through `writeFileAtomic` (containment + atomic rename), and the
  tree baseline is computed with `computeResourceClosure`.
- [`skill-family-contracts`](https://github.com/ifoohoo/skill-family-contracts) —
  `validateDocument` (JSON Schema 2020-12, strict policy) validates `public-release.json` and
  `site-baseline.json`; validation failure aborts with exit code 2.

## License

Apache-2.0

<!-- release-skill:capability:safe-first-command -->
> **Start here:** `npx skill-family-doc-render --check` — the drift check is read-only:
> it renders in memory, compares against the committed `site-baseline.json`, writes
> nothing, and touches no network, git, or credentials.

<!-- release-skill:capability:external-write-boundary -->
> **External write boundary:** this CLI writes only inside the site target directories
> declared by the project's own `public-release.json` (via contained, atomic writes).
> It performs no git operations, no network calls, and no writes outside those
> directories. The pre-write leak scan fails closed on private literals.

## Minimal example

```sh
npx skill-family-doc-render --help     # show usage
npx skill-family-doc-render --check    # read-only drift check — the safe first command
```
