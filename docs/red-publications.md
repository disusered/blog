# Publish Red writing

Brain Portal owns composition, identity selection, review, account connections,
delivery status, and corrections. This repository is the public record of
disusered.com: its template, its hand-written posts, and every approved Red post.
Netlify's Git build is the only way the site is deployed, so a template or theme
change reaches production with an ordinary push. Other identities get their own
repository and Netlify site so that no public repository links them.

Portal sends an immutable `polychrome.publication-envelope.v2` plus the identity's
approved snapshot to `scripts/publication-worker.ts`. The worker:

1. Reads the site's linked repository and branch from Netlify and refuses a site
   whose Git builds are stopped.
2. Resets its own clone to the remote branch, writes the approved posts and
   images (`src/content/blog/<slug>.md`, `public/assets/<slug>/`), the public
   OAuth client metadata, and `.well-known/site.standard.publication`.
3. Commits with its own SSH signing key and pushes. Unchanged files make no
   commit. A hand-written post with the same slug (no `publicationHash`) is
   replaced in that commit: its `.md`/`.mdx` and the co-located images only it
   references are removed, and the commit message lists them. Nothing else is
   ever deleted.
4. Waits for Netlify to build that commit, verifies the canonical page and RSS
   carry the approved hash, and returns the website receipt with the deploy and
   commit.

Private on-disk state records the pushed commit and the receipt, so a retry
resumes without a second commit. Portal serializes deliveries for each identity.

A paragraph holding only a bare URL on the site's own origin or a host in
`EMBED_HOSTS` (`src/consts.ts`) renders as a sandboxed iframe with a fallback
link, on the page and in RSS; AT `textContent` and Bluesky keep the URL. Demos
live under `/demos/`, for example `https://disusered.com/demos/phaser/hello-world/`.
A payload `cover` (`{ name, alt }`, naming one of its images) becomes the
post's `heroImage` and the Standard document's cover proposal.

A post with `draft: true` stays in the repository without a page, RSS item, tag,
or sitemap entry. Unpublished writing now lives as a Red draft instead; the
`fastai` draft moved there.

The worker also builds locally validated `site.standard.publication`,
`site.standard.document`, and `app.bsky.feed.post` records from pinned lexicons.
Standard documents carry the complete plain text. Bluesky carries the exact reviewed
short text and a link card; it never silently truncates text. Images appear on the
website and RSS, not as native Bluesky attachments. Portal owns authenticated AT
writes and persists their receipts. A correction updates the same document and
permalink; an explicitly selected Bluesky delivery gets a new post.

## Provisioning

1. Link one Netlify site per identity to that identity's GitHub repository with
   Git builds enabled. Set `NETLIFY_AUTH_TOKEN` privately in the Portal worker's
   environment.
2. Create an ed25519 key without a passphrase for the worker. Add its public key
   to the repository as a deploy key with write access. Set `PUBLICATION_GIT_KEY`
   to the private key's path (mode 0600). The same key signs the worker's commits.
3. Configure `BLOG_PUBLICATION_STATE_DIR` as a private directory, by default
   `~/.local/share/herding-cats/brain-portal/publication`. The worker keeps its
   clones under `repositories/`.
4. Configure Portal's `PUBLICATION_OAUTH_KEY_FILE` (private ES256 JWK),
   `PUBLICATION_OAUTH_CLIENT_ID` (for example
   `https://disusered.com/oauth-client-metadata.json`), and
   `PUBLICATION_OAUTH_CALLBACK_URL`. Never copy the private JWK into a repository.
5. Run `bootstrap-metadata` once to commit the public client metadata before
   connecting an account. Later publications keep it current.
6. Nothing to install for the worker itself. Before every run, Portal updates
   its own checkout of this repository from the site's published branch and
   runs `scripts/publication-worker.ts` from it, so whatever is on `main`
   publishes next. Keep unfinished work off `main`.

The JSON worker protocol uses stdin and returns one JSON value on stdout:

```sh
node scripts/publication-worker.ts < /private/path/request.json
```

- `{"action":"preflight","siteId":"…","profile":{…}}` checks the site and returns
  the repository to push without writing.
- `{"action":"bootstrap-metadata","siteId":"…","profile":{…},"metadata":{…}}`
  commits the public OAuth client metadata.
- `{"action":"build-records","envelope":{…}}` performs no network writes.
- `{"action":"website","siteId":"…","envelope":{…},"snapshot":{…},"metadata":{…}}`
  commits, waits for the deploy, and returns a website receipt.

Checks: `npm run lint`, `npx astro check`, `npm run build`, and
`node --test tests/*.test.ts`. The publication tests push to a local bare
repository with a throwaway signing key; they never publish anything.

## Legacy v1 staging

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
