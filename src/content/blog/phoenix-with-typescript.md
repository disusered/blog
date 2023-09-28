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

To get started, let's create a new Phoenix project by following Phoenix's [documentation for getting up and running](https://hexdocs.pm/phoenix/up_and_running.html). I will not cover installing Elixir, Node.js or the database, this assumes you have a fully capable environment.

```bash
# Upgrade Hex to latest version
mix local.hex

# Install the Phoenix application generator
mix archive.install hex phx_new

# Bootstrap Phoenix
mix phx.new phoenix_typescript
```

After accepting the defaults, we need to configure the database in `config/dev.exs` and initialize the database. I will be using PostgreSQL, but you can use any database you want. I will be using Docker Compose to run PostgreSQL, but you can use any method you want. The following example will use the default values scaffolded by Phoenix, but you may want to change these values to match your environment.

```sh
# Go to the Phoenix directory
cd phoenix_typescript

# Create a docker-compose file
touch docker-compose.yaml
```

You can copy the following code into your `docker-compose.yaml` file.

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

We now have a working Phoenix application! You can visit [`localhost:4000`](http://localhost:4000) from your browser to see the default Phoenix welcome page.

![A screenshot of a new Phoenix project](./phoenix-with-typescript-new-project.png)
