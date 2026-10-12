# Publish Red writing

Brain Portal's **Write** and **Publications** views own everyday composition,
identity selection, review, account connections, delivery status, and corrections.
This repository supplies the public renderer and publisher process. Each identity
has a separate HTTPS home, Netlify site, and authenticated AT DID. Carlos's home
keeps its existing pages; other identities receive only their own writing and
navigation. Short notes and links appear in full in the stream; essays have
permalinks. RSS contains the complete rendered writing.

Portal sends an immutable `polychrome.publication-envelope.v2` plus the selected
identity's public snapshot to `scripts/publication-worker.ts`. Only approved public
fields and selected image bytes enter a disposable Astro build. The worker verifies
the page and RSS in a draft Netlify deployment before promoting that exact deploy,
then verifies the canonical URLs. Private on-disk state preserves deploy IDs and
receipts across retries. Portal serializes deliveries for each identity.

The worker also constructs locally validated `site.standard.publication`,
`site.standard.document`, and `app.bsky.feed.post` records from pinned lexicons.
Standard documents carry the complete plain text. Bluesky carries the exact reviewed
short text and a link card; it never silently truncates text. Images currently appear
on the website and RSS, not as native Bluesky attachments. Portal owns authenticated
AT writes and persists their receipts. A correction updates the same document and
permalink; an explicitly selected Bluesky delivery gets a new post.

## Provisioning before the first publication

1. Install this checkout's locked dependencies and run its checks. Portal needs
   Node with TypeScript stripping (the deployed Portal uses Node 24) and this
   checkout's `node_modules`, including build dependencies.
2. Provision one Netlify site and HTTPS domain per identity. Stop its Git-triggered
   builds before Portal takes over delivery; the publisher checks this so a later
   Git build cannot erase runtime writing. Set `NETLIFY_AUTH_TOKEN` privately in
   the Portal worker's environment.
3. Configure `BLOG_PUBLICATION_STATE_DIR` as a private directory, default deployment
   location `~/.local/share/herding-cats/brain-portal/publication`. The systemd worker
   must be able to write there and to Cats' private `red/` store.
4. Configure Portal's `PUBLICATION_OAUTH_KEY_FILE` (private ES256 JWK),
   `PUBLICATION_OAUTH_CLIENT_ID` (for example
   `https://disusered.com/oauth-client-metadata.json`), and
   `PUBLICATION_OAUTH_CALLBACK_URL` (the Portal OAuth callback). Portal persists
   OAuth sessions and state in PostgreSQL. Never copy the private JWK into this
   repository or a public build.
5. Export Portal's generated public client metadata. Before connecting the first
   account, publish it on its configured public host with the explicit
   `bootstrap-metadata` operation below. This operation deploys the host's complete
   initial template. It refuses a site that already has runtime publication
   receipts; subsequent publications carry metadata in their full snapshots.
6. Configure each profile in Portal, connect its verified account, and review a
   first post. The worker script defaults to this sibling checkout; set
   `PUBLICATION_WORKER_SCRIPT` if it lives elsewhere. Public publication happens
   only when the author uses the review-and-publish action.

The JSON worker protocol uses stdin and returns one JSON value on stdout:

```sh
node scripts/publication-worker.ts < /private/path/request.json
```

Supported requests:

- `{"action":"preflight","siteId":"…","profile":{"id":"disusered","name":"Carlos","url":"https://disusered.com"}}`
  checks the site and competing build configuration without deploying.
- `{"action":"bootstrap-metadata","siteId":"…","profile":{"id":"disusered","name":"Carlos","url":"https://disusered.com"},"metadata":{…}}`
  is the explicit initial public metadata deployment.
- `{"action":"build-records","envelope":{…}}` performs no network writes.
- `{"action":"website","siteId":"…","envelope":{…},"snapshot":{…},"metadata":{…}}`
  deploys and returns a website receipt. Portal supplies this request.

Publication state and exported request files are private operational data. Back up
the state directory with Portal's database and Red approvals. A successful local
test or build is not a live delivery receipt.

Checks: `npm run lint`, `npm run check`, `npm run build`, and
`node --test tests/*.test.ts`. The publication tests build an isolated identity and
exercise mocked provider retries without publishing anything.

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
