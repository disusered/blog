# Publish an approved Red blog edition

The private Cats repository owns drafts, source lineage, selected assets, and
publication approval. This repository receives only a public post envelope.
Never copy a Red edition's complete frontmatter or its private source snapshots
into the blog.

Prepare the envelope with Cats' `polychromectl red publish prepare` using
`--channel blog` and an explicit `--prepared-at` timestamp. Preparation requires
an immutable approval that still matches the edition and image bytes.

From this checkout:

```sh
pnpm publish:blog /private/path/envelope.json
pnpm publish:blog /private/path/envelope.json --apply
```

The first command lists the public files and their hashes without writing.
The second stages only those files. Existing matching files are unchanged;
conflicting files are refused. Review the diff and run the blog checks before
committing or deploying through the existing site workflow.

After deployment, verify the canonical page and RSS:

```sh
pnpm publish:blog /private/path/envelope.json --verify DEPLOYMENT_COMMIT
```

`DEPLOYMENT_COMMIT` is the full 40-character commit id. The verifier requires
matching publication hashes in both the page and its RSS item. Preserve its JSON
receipt privately, then use Cats' `red publish record` with the same envelope
and receipt. Only this final operation marks Red Published.

`previewFiles` also accepts a checksummed, unapproved Red publication preview
for a separate local preview checkout. A preview is not an approval or a
deployment receipt. It must not be used to bypass the approval step above.
