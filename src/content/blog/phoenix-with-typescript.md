---
title: "Using TypeScript in Phoenix 1.7"
description: "My experience using TypeScript in Phoenix 1.7 using esbuild"
pubDate: "Sept 27 2023"
tags:
  [
    "phoenix",
    "elixir",
    "development",
    "javascript",
    "typescript",
    "esbuild",
    "alpinejs",
    "docker",
  ]
heroImage: "./phoenix-with-typescript.jpg"
heroImageAlt: "The logos for the Phoenix Framework, TypeScript, and esbuild"
---

I've been working with Phoenix 1.7 for a few months now using the default JavaScript setup, but as the complexity of the front-end has grown, I've been looking for ways to improve the developer experience. I've been using TypeScript for a few years now, and I've been very happy with it, so I decided to try to use TypeScript in my Phoenix project.

Most of the information I found online was for older versions of Phoenix, so I decided to document my experience here. I will be using esbuild to transpile the TypeScript code to JavaScript, I don't want to radically change the build process, I only want add the developer ergonomics I am used to from years of front-end development. For this blog post, I will be starting with a fresh Phoenix 1.7 project.

I also want to go beyond the typical "Hello World" example and show how to use TypeScript with Phoenix LiveView. I will be using the [Phoenix LiveView Hooks](https://hexdocs.pm/phoenix_live_view/js-interop.html#phoenix_live_view_hooks) to add some interactivity to the page, as well as Alpine.js which is commonly used with Phoenix for client-side interactivity.

## Create a Phoenix 1.7 project

To get started, let's create a new Phoenix project by following Phoenix's [documentation for getting up and running](https://hexdocs.pm/phoenix/up_and_running.html). I will not cover installing Elixir, Node.js or the database, this assumes you have a fully capable environment.

```bash
# Upgrade Hex to latest version
mix local.hex

# Install the Phoenix application generator
mix archive.install hex phx_new

# Bootstrap Phoenix
mix phx.new phoenix_typescript
```

After accepting the defaults, we need to configure the database in `config/dev.exs` and initialize the database. I will be using PostgreSQL, but you can use any database you want. I will be using Docker Compose to run PostgreSQL, but you can use any method you want. The following example will use the default values scaffolded by Phoenix, but you may want to change these values to match our environment.

```sh
# Go to the Phoenix directory
cd phoenix_typescript

# Create a docker-compose file
touch docker-compose.yaml
```

We can copy the following code into our `docker-compose.yaml` file.

```yaml
version: "3.9"
services:
  db:
    image: postgres:15.2
    restart: always
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=phoenix_typescript_dev
    ports:
      - "5432:5432"
    volumes:
      - db:/var/lib/postgresql/data
volumes:
  db:
    driver: local
```

Now we can start the database and run the creation and migration tasks.

```sh
# Start the database
docker-compose up

# Create the db and run the migrations
mix ecto.create

# Start the Phoenix server
mix phx.server
```

We now have a working Phoenix application! You can visit [`localhost:4000`](http://localhost:4000) from our browser to see the default Phoenix welcome page.

![A screenshot of a new Phoenix project](./phoenix-with-typescript-new-project.png)

## Set up TypeScript

Now let's take a look at the existing JavaScript setup. Phoenix uses [esbuild](https://esbuild.github.io/) to transpile and bundle the JavaScript code. The configuration is stored in `config/config.exs`:

```elixir
# Configure esbuild (the version is required)
config :esbuild,
  version: "0.17.11",
  default: [
    args:
      ~w(js/app.js --bundle --target=es2017 --outdir=../priv/static/assets --external:/fonts/* --external:/images/*),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]
```

We can see that the bundler has certain options set, such as the target and output directory. All modern JavaScript syntax is supported by esbuild, but newer syntax might not be supported by certain browsers. By setting `--target=es2017`, we tell esbuild to convert newer syntax to older syntax [as appropriate](https://esbuild.github.io/content-types/#javascript). We can also see that the input file will be `app.js`, when we migrate to TypeScript we will have to change this to `app.ts`.

esbuild supports TypeScript out of the box, so we don't need to install any additional dependencies. We can rename `app.js` to `app.ts` and update the configuration to use `app.ts` as the input file.

```bash
# Rename app.js to app.ts
mv assets/js/app.{js,ts}
```

```diff
diff --git a/config/config.exs b/config/config.exs
index 4eae6f7..aeffbb0 100644
--- a/config/config.exs
+++ b/config/config.exs
@@ -34,7 +34,7 @@ config :esbuild,
   version: "0.17.11",
   default: [
     args:
-      ~w(js/app.js --bundle --target=es2017 --outdir=../priv/static/assets --external:/fonts/* --external:/images/*),
+      ~w(js/app.ts --bundle --target=es2017 --outdir=../priv/static/assets --external:/fonts/* --external:/images/*),
     cd: Path.expand("../assets", __DIR__),
     env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
   ]
```

Afterwards we can start the server and visit [`localhost:4000`](http://localhost:4000) to see the same welcome page as before. We can also see that the JavaScript code is still working as expected. This is because esbuild does handle TypeScript but [does not handle any type checking itself](https://esbuild.github.io/content-types/#typescript), we still need to run `tsc --noEmit` to handle type checking.

In order to run `tsc`, we need the TypesScript compiler. We can install it with `npm` into our `assets` directory. Before that, we want to initialize a `package.json`. Then we want to save it as a development dependency `package.json`. We can do this by running the following command:

```bash
# Install TypeScript into our assets directory and save it as a dev dependency
npm --prefix assets install typescript --save-dev
```

A `package.json` and `package-lock.json`file are created automatically, and we can see that `tsc` is listed as a dev dependency.

```bash
On branch main
Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        new file:   assets/package-lock.json
        new file:   assets/package.json
```

The content of the `package.json` is very minimal, only listing our dev dependency.

```json
{
  "devDependencies": {
    "typescript": "^5.2.2"
  }
}
```

Finally we need to create a minimal TypeScript configuration file. esbuild does not require a `tsconfig.json` file, but the TypeScript compiler does. We can create a minimal config file by running `npx --prefix assets tsc --init` in our `assets` directory.

```bash
# npx does not support the --prefix flag, so we need to cd into the assets directory
cd assets

# Initialize a tsconfig.json file
npx tsc --init

# Return to the root directory
cd ..
```

We can leave all the values to their defaults except for the `target` option. We want to set the `target` to `es2017` to match the target used by esbuild.

```diff
diff --git a/assets/tsconfig.json b/assets/tsconfig.json
index e075f97..91776fc 100644
--- a/assets/tsconfig.json
+++ b/assets/tsconfig.json
@@ -11,7 +11,7 @@
     // "disableReferencedProjectLoad": true,             /* Reduce the number of projects loaded automatically by TypeScript. */

     /* Language and Environment */
-    "target": "es2016",                                  /* Set the JavaScript language version for emitted JavaScript and include compatible library declarations. */
+    "target": "es2017",                                  /* Set the JavaScript language version for emitted JavaScript and include compatible library declarations. */
     // "lib": [],                                        /* Specify a set of bundled library declaration files that describe the target runtime environment. */
     // "jsx": "preserve",                                /* Specify what JSX code is generated. */
     // "experimentalDecorators": true,                   /* Enable experimental support for legacy experimental decorators. */
```

In Node.js, the `scripts` section of the `package.json` is [used to define scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts) that can be run with `npm run <script>`. We can add a `typecheck` script to run the TypeScript compiler.

```diff
diff --git a/assets/package.json b/assets/package.json
index 04263dc..564a3fd 100644
--- a/assets/package.json
+++ b/assets/package.json
@@ -1,4 +1,7 @@
 {
+  "scripts": {
+    "typecheck": "tsc --noEmit --pretty"
+  },
   "devDependencies": {
     "typescript": "^5.2.2"
   }
```

Now we can run our `typecheck` script to see the errors in our `app.ts`. Remember to change the directory to the root Phoenix directory to run the following command, otherwise if we are in the `assets` directory we can omit the `--prefix assets` flag.

```bash
# Run the typecheck script
npm --prefix assets run typecheck
```

## Automatic type checking with watchers

We can add an alias to our Mix tasks to run the `typecheck` script. This will allow us to run `mix assets.typecheck` from our project root. We can add the following to our `mix.exs` file under the `aliases` function.

```diff
diff --git a/mix.exs b/mix.exs
index e7e6b2c..470decd 100644
--- a/mix.exs
+++ b/mix.exs
@@ -65,6 +65,7 @@ defmodule PhoenixTypescript.MixProject do
       "ecto.setup": ["ecto.create", "ecto.migrate", "run priv/repo/seeds.exs"],
       "ecto.reset": ["ecto.drop", "ecto.setup"],
       test: ["ecto.create --quiet", "ecto.migrate --quiet", "test"],
+      "assets.typecheck": ["cmd npm --prefix assets run typecheck"],
       "assets.setup": ["tailwind.install --if-missing", "esbuild.install --if-missing"],
       "assets.build": ["tailwind default", "esbuild default"],
       "assets.deploy": ["tailwind default --minify", "esbuild default --minify", "phx.digest"]
```

This helps us run the type check manually, but we want to run the type check automatically when files are changed in the project. The only change we make to our `typecheck` command is to pass the `--watch` flag to `tsc`. This will watch our files for changes and run the type check automatically. When passing arguments to a `package.json` script, we need to prefix it with `--` to separate the arguments for `npm` and the arguments for the script.

```bash
# An example of running the typecheck script with the --watch flag
npm --prefix assets run typecheck -- --watch
```

While that works, we want to run the type check automatically when we run `mix phx.server`. We can do that by adding our typecheck watcher command to our `config/dev.exs` file.

```diff
diff --git a/config/dev.exs b/config/dev.exs
index e702834..591530f 100644
--- a/config/dev.exs
+++ b/config/dev.exs
@@ -26,7 +26,8 @@ config :phoenix_typescript, PhoenixTypescriptWeb.Endpoint,
   secret_key_base: "4s+TpGoGfPgA4CEogO+83S26CXea4zHcpcQCKY7mwytLB4W2OXidoDYSQeUUPEcD",
   watchers: [
     esbuild: {Esbuild, :install_and_run, [:default, ~w(--sourcemap=inline --watch)]},
-    tailwind: {Tailwind, :install_and_run, [:default, ~w(--watch)]}
+    tailwind: {Tailwind, :install_and_run, [:default, ~w(--watch)]},
+    npm: ["--prefix", "assets", "run", "typecheck", "--", "--watch"]
   ]

 # ## SSL Support
```

Now if we run `mix phx.server` we can see that the type check is running in the background. If we make a change to `app.ts` and save it, we can see that the type check runs automatically and the errors are displayed in the console. If we open the page in the browser, we can see that the JavaScript code is still working as expected. esbuild is not blocked by the type check, it will still bundle the JavaScript code and reload the page as expected.

## Fixing TypeScript errors

The first two errors we see in `app.ts` are related to the type declarations for Phoenix and Phoenix Live View.

```bash
js/app.ts:21:22 - error TS2307: Cannot find module 'phoenix' or its corresponding type declarations.

21 import {Socket} from "phoenix"

js/app.ts:22:26 - error TS2307: Cannot find module 'phoenix_live_view' or its corresponding type declarations.

22 import {LiveSocket} from "phoenix_live_view"
```

Since these libraries don't ship their own type declarations, we need to look for them elsewhere. Fortunately, the [DefinitelyTyped](https://definitelytyped.github.io/) project has declarations for both of these libraries. We can install them with `npm` as dev dependencies.

```bash
# Install type declarations to dev dependencies
npm --prefix assets install @types/phoenix @types/phoenix_live_view --save-dev
```

With this, the errors are gone. We can also see that our `package.json` and `package-lock.json` have been updated with these dependencies. We can move on the the next error. We can see it is related to the `topbar` library used to display a progress bar on the top of the screen.

```bash
js/app.ts:23:20 - error TS7016: Could not find a declaration file for module '../vendor/topbar'. '/Users/carlos/Development/phoenix_typescript/assets/vendor/topbar.js' implicitly has an 'any' type.

23 import topbar from "../vendor/topbar"
```

This library is loaded from the `assets/vendor/` directory, and is part of the default Phoenix installation. Let's remove this hard-coded library and fetch the latest version from NPM:

```bash
# Remove the existing library file
rm assets/vendor/topbar.js

# Install topbar from NPM
npm --prefix assets install topbar --save
```

We also need to update the reference to the library in `app.ts`:

```diff
diff --git a/assets/js/app.ts b/assets/js/app.ts
index df0cdd9..70c1398 100644
--- a/assets/js/app.ts
+++ b/assets/js/app.ts
@@ -20,7 +20,7 @@ import "phoenix_html"
 // Establish Phoenix Socket and LiveView configuration.
 import {Socket} from "phoenix"
 import {LiveSocket} from "phoenix_live_view"
-import topbar from "../vendor/topbar"
+import topbar from "topbar"

 let csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")
 let liveSocket = new LiveSocket("/live", Socket, {params: {_csrf_token: csrfToken}})
```

We can see that the error no longer appears in our type check. But why? It turns out the newer version of the library is already typed, so we don't need to install any additional type declarations. We are now down to 2 errors, the next one being a null check:

```bash
js/app.ts:25:17 - error TS2531: Object is possibly 'null'.

25 let csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")
```

Our script does not know if the `querySelector` will return a value or not, so we need to check for `null` before calling `getAttribute`. We can fix this by adding a null check to the code. We'll use the [optional chaining operator](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining) to do this. This is an ES2020 feature, but thanks to esbuild with the `--target=es2017` flag, we can use it without any additional configuration.

```diff
diff --git a/assets/js/app.ts b/assets/js/app.ts
index 70c1398..653efb4 100644
--- a/assets/js/app.ts
+++ b/assets/js/app.ts
@@ -22,7 +22,7 @@ import {Socket} from "phoenix"
 import {LiveSocket} from "phoenix_live_view"
 import topbar from "topbar"

-let csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")
+let csrfToken = document.querySelector("meta[name='csrf-token']")?.getAttribute("content")
 let liveSocket = new LiveSocket("/live", Socket, {params: {_csrf_token: csrfToken}})

 // Show progress bar on live navigation and form submits
```

We are down to the last error about the `liveSocket` variable not existing in the global browser scope:

```bash
js/app.ts:40:8 - error TS2339: Property 'liveSocket' does not exist on type 'Window & typeof globalThis'.

40 window.liveSocket = liveSocket
```

To fix this, we will need to add a type declaration for the `liveSocket` variable. We can do this by adding a `global.d.ts` file to our `assets` directory. This file will be automatically loaded by the TypeScript compiler, and we can add our type declaration to it.

```bash
# Create a global.d.ts file
touch assets/global.d.ts
```

We now need to add the type declaration for the `liveSocket` variable. We can do this by adding the following code to our `global.d.ts` file:

```typescript
import { LiveSocket } from "phoenix_live_view";

declare global {
  interface Window {
    liveSocket: LiveSocket;
  }
}
```

We can see that the error is gone, and we have a working TypeScript setup!
