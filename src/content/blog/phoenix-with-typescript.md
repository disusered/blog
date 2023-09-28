---
title: "Using TypeScript in Phoenix 1.7"
description: "My experience using TypeScript in Phoenix 1.7 using ESBuild"
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
heroImageAlt: "The logos for the Phoenix Framework, TypeScript, and ESBuild"
---

I've been working with Phoenix 1.7 for a few months now using the default JavaScript setup, but as the complexity of the front-end has grown, I've been looking for ways to improve the developer experience. I've been using TypeScript for a few years now, and I've been very happy with it, so I decided to try to use TypeScript in my Phoenix project.

Most of the information I found online was for older versions of Phoenix, so I decided to document my experience here. I will be using ESBuild to transpile the TypeScript code to JavaScript, I don't want to radically change the build process, I only want add the developer ergonomics I am used to from years of front-end development. For this blog post, I will be starting with a fresh Phoenix 1.7 project.

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

## Set up Node.js and TypeScript

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

ESBuild supports TypeScript out of the box, so we don't need to install any additional dependencies. We can rename `app.js` to `app.ts` and update the configuration to use `app.ts` as the input file.

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

Afterwards we can start the server and visit [`localhost:4000`](http://localhost:4000) to see the same welcome page as before. We can also see that the JavaScript code is still working as expected. This is because ESBuild does handle TypeScript but [does not handle any type checking itself](https://esbuild.github.io/content-types/#typescript), we still need to run `tsc --noEmit` to handle type checking.

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

Finally we need to create a minimal TypeScript configuration file. ESBuild does not require a `tsconfig.json` file, but the TypeScript compiler does. We can create a minimal config file by running `npx --prefix assets tsc --init` in our `assets` directory.

```bash
# npx does not support the --prefix flag, so we need to cd into the assets directory
cd assets

# Initialize a tsconfig.json file
npx tsc --init

# Return to the root directory
cd ..
```

We can leave all the values to their defaults except for the `target` option. We want to set the `target` to `es2017` to match the target used by ESBuild.

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
