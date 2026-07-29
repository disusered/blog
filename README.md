# My Blog

[![Netlify Status](https://api.netlify.com/api/v1/badges/8ac29931-7045-4eb0-8b9b-84d10a3382b6/deploy-status)](https://app.netlify.com/sites/disusered/deploys)

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run lint`            | Lint your code                                   |
| `npm run format`          | Format your code                                 |
| `npm run test:publisher`  | Test the AT Protocol publication boundary        |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 🚀 Project Structure

```text
├── public/
├── src/
│   ├── components/
│   ├── content/
│   ├── layouts/
│   └── pages/
├── astro.config.mjs
├── README.md
├── package.json
└── tsconfig.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

The `src/content/` directory contains "collections" of related Markdown and MDX documents. Use `getCollection()` to retrieve posts from `src/content/blog/`, and type-check your frontmatter using an optional schema. See [Astro's Content Collections docs](https://docs.astro.build/en/guides/content-collections/) to learn more.

Any static assets, like images, can be placed in the `public/` directory.

## Approval-gated AT Protocol output

The publisher is an experimental public-output adapter for an exact,
already-approved Red Edition revision. It creates a
`com.linkedclaims.claim` record in the hosted PDS associated with the supplied
AT Protocol handle. It does not run a PDS, Relay, AppView, or ActivityPub
server, and it never reads Black, Marginalia, or the private Corpus.

The LinkedClaims Lexicon is pinned in `lexicons.json` and `lexicons/`; generated
types live in `src/lexicons/`. Dry-run is the default:

```sh
npm run publish:atproto -- /path/to/envelope.json
```

Dry-run validates the revision-bound hashes and public/private boundary, then
prints the exact proposed record without starting OAuth or attempting a write.
Live publication requires all three explicit arguments:

```sh
npm run publish:atproto -- /path/to/envelope.json \
  --publish \
  --handle your-handle.example \
  --receipt /path/to/receipt.json
```

Live mode starts a temporary loopback OAuth callback, requests only
`repo:com.linkedclaims.claim?action=create`, and keeps OAuth state and session
material in memory. The deterministic record key makes an indeterminate retry
safe: matching existing content is reused, while different content at that key
is rejected. The receipt is created with mode `0600` and is never overwritten.

Record the successful receipt against the same Red Edition with
`polychromectl red publish record`. AT Protocol repositories are public; never
put private source text, private identifiers, credentials, or unpublished
evidence in an envelope.

## Credit

Built with [Astro](https://astro.build). This theme is based off of [Bear Blog](https://github.com/HermanMartinus/bearblog/).
